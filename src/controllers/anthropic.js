/**
 * Anthropic /v1/messages 主控制器（Qwen 路线，编排层）。
 *
 * 重构后职责单一：
 *  - 协议入口：解析 Anthropic 风格请求 → 构造内部 Qwen 上游请求体
 *  - 兼容性日志节流（shouldLogCompatNotice）
 *  - 账号粘滞预选 + sendChatRequest 调用
 *  - 分发到 backends/qwen/anthropic-stream-handler.js 或 anthropic-sync-handler.js
 *  - 错误兜底（Anthropic error envelope）
 *
 * 流式/同步响应处理逻辑已下沉到：
 *   - backends/qwen/anthropic-stream-handler.js（handleAnthropicStream）
 *   - backends/qwen/anthropic-sync-handler.js（handleAnthropicSync）
 *   - backends/qwen/anthropic-utils.js（共享辅助：profile 判定 / strict mode / tool 解析 / 上游消费）
 *
 * 维护重点（同原文件）：
 *  - /v1/messages 会被转换为 Qwen Web chat 请求，再把 Qwen SSE 转成 Anthropic 事件序列。
 *  - Claude Code 对 tool_use 顺序非常敏感：message_start、content_block_start/delta/stop、message_stop 不能乱。
 *  - 有 tools 时先缓冲 answer，统一解析 XML/JSON 工具调用，避免把 raw tool JSON 当文本发给客户端。
 *  - 纠偏 retry 必须使用独立 answer buffer；只有解析出有效 tool_use 才替换首轮结果。
 */
const { generateUUID } = require('../utils/tools.js');
const { sendChatRequest, pickAccountWithSticky } = require('../backends/qwen/request.js');
const accountManager = require('../utils/account.js');
const { isChatType, isThinkingEnabled, parserMessages } = require('../backends/qwen/message-enricher.js');
const { resolveQwenModel } = require('../backends/qwen/model-resolver.js');
const {
    buildToolSystemPrompt,
    buildToolFormatReminder,
    foldToolMessagesForChatBackend,
    buildQwenFirstMessageWarning
} = require('../utils/tool-prompt.js');
const { logger } = require('../utils/logger');
const {
    createChatLatencyTracker,
    markLatency,
    setLatencyFields,
    messageStats
} = require('../utils/chat-latency-monitor.js');
const claudeCodeProfile = require('../agents/claude-code-profile.js');
const {
    analyzeAnthropicCompatibility,
    buildAnthropicCompatibilityHeaders
} = require('../utils/anthropic-compatibility.js');

// 共享的 Anthropic 协议纯函数（被 DeepSeek 路线复用）
// 详见 src/shared/anthropic-helpers.js 模块说明
const {
    getAnthropicProfile,
    normalizeAnthropicSystem,
    normalizeAnthropicTools,
    normalizeAnthropicToolChoice,
    flattenAnthropicMessages,
    extractSystemFromMessages,
    hasAnthropicRequestImage
} = require('../shared/anthropic-helpers.js');

// Qwen Anthropic 处理器（流式 / 同步）
const { handleAnthropicStream } = require('../backends/qwen/anthropic-stream-handler.js');
const { handleAnthropicSync } = require('../backends/qwen/anthropic-sync-handler.js');

// 统一错误响应（sendAnthropicError 内部使用 sanitizeErrorMessage 脱敏）
const { normalizeError, sendAnthropicError } = require('../utils/provider-errors');

// QwenScheduler — Phase C3：接入并发调度器（lease acquire/release）
const scheduler = require('../backends/qwen/scheduler-singleton');

// Lifecycle recorder：跟踪 12 个生命周期事件（controller 负责 6 个，stream handler 负责 6 个）
const { createLifecycleRecorder } = require('../backends/qwen/lifecycle.js');

// ===========================================================================
// 编排层辅助
// ===========================================================================

// Compatibility notices are useful, but noisy. Log each unique summary at most
// once per profile throttle window.
const _compatNoticeLastLog = new Map();
const shouldLogCompatNotice = (summary) => {
    const ttl = Number(claudeCodeProfile.profile.compatibilityNoticeThrottleMs) || 0;
    if (ttl <= 0) return true;
    const now = Date.now();
    const last = _compatNoticeLastLog.get(summary) || 0;
    if (now - last < ttl) return false;
    _compatNoticeLastLog.set(summary, now);
    return true;
};

/**
 * 从原始 Anthropic 请求体中提取可用工具名集合
 * @param {Object} anthropicReq - 原始 Anthropic 请求
 * @returns {Set<string>} 工具名集合
 */
const extractToolNames = (anthropicReq) => {
    const out = new Set()
    const tools = anthropicReq?.tools
    if (Array.isArray(tools)) {
        for (const t of tools) {
            if (t && typeof t.name === 'string' && t.name.length > 0) out.add(t.name)
        }
    }
    return out
}

/**
 * 构造内部 Qwen 上游请求体
 * @param {Object} anthropicReq - Anthropic 风格请求体
 * @param {Object} [req] - Express 请求（用于会话粘滞和账号预选）
 * @returns {Promise<{body: Object, hasTools: boolean, toolChoice: any, enable_thinking: boolean, model: string, preSelectedAccount: Object|null}>} 转换结果
 */
const buildInternalRequest = async (anthropicReq, req) => {
    const { model, messages, system, tools, tool_choice, stream, thinking } = anthropicReq;

    const normalizedTools = normalizeAnthropicTools(tools);
    const internalToolChoice = normalizeAnthropicToolChoice(tool_choice);

    // Convert Anthropic messages before parserMessages handles Qwen-specific
    // upload/thinking fields.
    // Claude Code 某些版本会把 system 消息放到 messages 数组里，这里先提取出来
    // 合并到顶级 system 字段，避免 system 被当作 user 消息传给下游。
    const { messages: pureMessages, systemText: extractedSystem } = extractSystemFromMessages(messages);
    let flat = flattenAnthropicMessages(pureMessages);
    const systemText = [normalizeAnthropicSystem(system), extractedSystem].filter(Boolean).join('\n\n');

    // Keep system/tool instructions as a prefix on the final user message. A
    // standalone system role would be flattened into literal text by parserMessages.
    const hasTools = normalizedTools.length > 0;
    const hasUserImage = hasAnthropicRequestImage(messages);
    // Claude Code gets stricter workflow wording; generic Anthropic keeps the
    // original looser tool prompt.
    const activeProfileForPrompt = getAnthropicProfile(req);
    const isClaudeCodeProfile = activeProfileForPrompt && activeProfileForPrompt.profile && activeProfileForPrompt.profile.name === 'claude-code';
    const toolPrompt = hasTools
        ? buildToolSystemPrompt(normalizedTools, {
            tool_choice: internalToolChoice,
            hasUserImage,
            claudeCodeProfile: isClaudeCodeProfile,
            provider: 'qwen',
        })
        : '';

    if (hasTools) {
        flat = foldToolMessagesForChatBackend(flat);
        // Preserve the client-provided history verbatim after tool folding. The
        // Qwen Web backend does not keep a native API conversation for us, so
        // continuity depends on replaying the full OpenAI/Anthropic history each
        // request. Aggressive summarization made Claude Code/Hermes lose task state.
    }

    // Pick the sticky account before image upload so uploaded OSS resources and
    // the final chat request use the same Qwen account.
    let preSelectedAccount = null
    try {
        preSelectedAccount = await pickAccountWithSticky(accountManager, req)
    } catch (e) {
        // 预选失败不阻塞主流程，回退到 sendChatRequest 内部选择
        preSelectedAccount = null
    }
    markLatency(req?.chatLatency, 'accountSelected', {
        account: preSelectedAccount?.email
    })

    // Reuse existing Qwen message parsing, including image upload and thinking config.
    const enable_thinking = !!(thinking && thinking.type === 'enabled');

    // 通过 resolveQwenModel 统一解析模型名 → 上游真实模型 ID + 完整元数据。
    // 必须在 isThinkingEnabled / isChatType 之前调用：它们的 effectiveThinkingEnabled /
    // suffix 字段从 req.modelResolution 复用，避免并行 splitModelSuffix 调用。
    // req.modelResolution 供下游 handler 读取 baseModel / aliasMode / effectiveThinkingEnabled 等。
    // parsedModel 是发送给 Qwen 上游的真实模型 ID（不带 -thinking 等后缀）。
    // 注意 Anthropic 协议的 thinking.budget_tokens 优先级最高，透传给 resolver。
    const modelResolution = await resolveQwenModel(model, {
        reasoningEffort: anthropicReq?.reasoning_effort,
        thinkingBudget: thinking?.budget_tokens,
        enableThinking: enable_thinking,
    });
    if (req) req.modelResolution = modelResolution;
    const parsedModel = modelResolution.upstreamModel;
    if (req?.lifecycleRecorder) {
        req.lifecycleRecorder.record('model_resolved', { baseModel: modelResolution?.baseModel });
    }

    // === Phase C3: QwenScheduler 接入 ===
    // 在 resolveQwenModel 之后调用 scheduler.acquire()，把并发控制/账号选择交给 scheduler。
    //   - 成功：用 lease.account 覆盖 preSelectedAccount，保证 parserMessages 图片上传与
    //     sendChatRequest 使用同一账号（lease.account 是 AccountRuntime，token/email 通过 getter 暴露）
    //   - scheduler 未就绪（status=503 "not initialized"）：降级到旧的 pickAccountWithSticky 路径
    //   - scheduler 拒绝（队列满/超时/关闭/客户端断开，status=429/503/499）：抛出带 status 的错误，
    //     由上层 handleAnthropicMessages 映射为 429/503 + Retry-After
    let lease = null;
    try {
        if (req?.lifecycleRecorder) {
            req.lifecycleRecorder.record('scheduler_enqueued');
        }
        lease = await scheduler.acquire({
            requestedModel: modelResolution.requestedModel,
            baseModel: modelResolution.baseModel,
            aliasMode: modelResolution.aliasMode,
            estimatedPromptBytes: Buffer.byteLength(JSON.stringify(anthropicReq || {}), 'utf8'),
            mediaBytes: 0,
            sessionKey: req?.headers?.['x-session-key'] || null,
            signal: null,
            deadline: Date.now() + 120000
        });
        if (req) req.lease = lease;
        // lease.account 是 AccountRuntime 实例（含 token/email getter），覆盖 preSelectedAccount
        if (lease && lease.account) {
            preSelectedAccount = lease.account;
        }
        if (req?.lifecycleRecorder) {
            req.lifecycleRecorder.record('scheduler_admitted');
            req.lifecycleRecorder.record('account_leased', { accountId: lease?.account?.accountId });
        }
    } catch (schedErr) {
        const schedStatus = schedErr && schedErr.status;
        const notReady = !schedStatus
            || (schedStatus === 503 && /not initialized/i.test(schedErr.message || ''));
        if (notReady) {
            // scheduler 不可用（未初始化/意外错误）— 降级到旧行为，preSelectedAccount 保持 pickAccountWithSticky 结果
            logger.warn(`QwenScheduler acquire fallback: ${schedErr?.message || schedErr}`, 'SCHEDULER');
        } else {
            // 队列满/超时/关闭/客户端断开 — 透传 status/Retry-After 给上层
            const err = new Error(schedErr?.message || 'Scheduler rejected');
            err.status = schedStatus;
            err.retryAfter = (schedErr?.headers && schedErr.headers['Retry-After']) || '30';
            err.schedulerError = true;
            throw err;
        }
    }

    // 从 modelResolution 复用 effectiveThinkingEnabled / effectiveThinkingBudget / suffix，
    // 不再调用 model.includes('-thinking') 或 splitModelSuffix(model)。
    const thinkingCfg = isThinkingEnabled(model, enable_thinking, thinking?.budget_tokens, modelResolution);
    const chatType = isChatType(model, undefined, modelResolution);
    const abortController = new AbortController()
    req.on('close', () => abortController.abort())
    let parsedMessages;
    try {
        parsedMessages = await parserMessages(flat, thinkingCfg, chatType, {
            uploadAccount: preSelectedAccount,
            canonicalEnvelope: hasTools,
            signal: abortController.signal,
            lease
        });
    } catch (parseErr) {
        // parserMessages 失败（图片上传错误等）— 释放 lease 为 'failure'，避免并发槽泄漏
        if (lease) {
            try { lease.release('failure'); } catch (_) { /* idempotent */ }
            if (req) req.lease = null;
        }
        throw parseErr;
    }

    // 在 parsedMessages 最前面插入 Qwen 路由第一条警告消息
    if (parsedMessages && parsedMessages.length > 0) {
        parsedMessages.unshift({ role: 'user', content: buildQwenFirstMessageWarning() });
    }

    // Inject tool instructions (toolPrompt + systemText) at the BEGINNING
    // of the first user message. Qwen Web API does NOT support role: 'system',
    // so we prepend to the first user message instead.
    // The format reminder stays at the END (last user message) as a proximity cue.
    const prefixParts = [toolPrompt, systemText].filter(Boolean);
    if (prefixParts.length > 0 && Array.isArray(parsedMessages) && parsedMessages.length > 0) {
        const prefix = prefixParts.join('\n\n---\n\n');
        // Prepend tool instructions to the FIRST user message (not system message — Qwen doesn't support role:system)
        const firstUser = parsedMessages.find(m => m && m.role === 'user');
        if (firstUser) {
            if (typeof firstUser.content === 'string') {
                firstUser.content = `${prefix}\n\n${firstUser.content}`;
            } else if (Array.isArray(firstUser.content)) {
                const textIdx = firstUser.content.findIndex(c => c && c.type === 'text');
                if (textIdx >= 0) {
                    firstUser.content[textIdx].text = `${prefix}\n\n${firstUser.content[textIdx].text || ''}`;
                } else {
                    firstUser.content.unshift({ type: 'text', text: prefix });
                }
            }
        }
        // Format reminder stays at the end (last user message) as a proximity cue
        const reminder = hasTools ? buildToolFormatReminder(normalizedTools, { provider: 'qwen' }) : '';
        if (reminder) {
            const last = parsedMessages[parsedMessages.length - 1];
            if (typeof last.content === 'string') {
                last.content = `${last.content}\n\n${reminder}`;
            } else if (Array.isArray(last.content)) {
                const textIdx = last.content.findIndex(c => c && c.type === 'text');
                if (textIdx >= 0) {
                    last.content[textIdx].text = `${last.content[textIdx].text || ''}\n\n${reminder}`;
                } else {
                    last.content.push({ type: 'text', text: reminder });
                }
            }
        }
    }

    const body = {
        stream: !!stream,
        version: "2.1",
        incremental_output: true,
        chat_type: chatType,
        sub_chat_type: chatType,
        chat_mode: 'normal',
        model: parsedModel,
        messages: parsedMessages,
        session_id: generateUUID(),
        id: generateUUID(),
        timestamp: Math.floor(Date.now() / 1000),
        // 尝试协议层禁用 Qwen Studio 原生工具拦截（speculative，上游不支持则忽略）
        disable_tools: true,
        tool_choice: 'none'
    };
    setLatencyFields(req?.chatLatency, {
        model: parsedModel,
        stream: !!stream,
        hasTools,
        toolChoice: internalToolChoice,
        ...messageStats(parsedMessages)
    });
    markLatency(req?.chatLatency, 'bodyNormalized');

    return {
        body,
        hasTools,
        toolChoice: internalToolChoice,
        enable_thinking: thinkingCfg.thinking_enabled,
        model: parsedModel,
        preSelectedAccount,
        rawTools: Array.isArray(tools) ? tools : [],
        rawMessages: Array.isArray(messages) ? messages : []
    };
};

// ===========================================================================
// 主入口
// ===========================================================================

/**
 * Anthropic /v1/messages 主入口
 * @param {object} req - Express 请求
 * @param {object} res - Express 响应
 */
const handleAnthropicMessages = async (req, res) => {
    try {
        // 路由快照：仅保存路由所需字段，避免完整 body 深拷贝（500K 上下文下 ~1.5MB 额外分配）
        const messages = req.body?.messages
        req.routeSnapshot = {
            model: req.body?.model,
            stream: req.body?.stream !== false,
            hasTools: !!(req.body?.tools && req.body.tools.length > 0),
            toolChoice: req.body?.tool_choice || null,
            messageCount: Array.isArray(messages) ? messages.length : 0,
            estimatedBytes: typeof req.body === 'object' ? Buffer.byteLength(JSON.stringify(req.body)) : 0
        }

        const compatibility = analyzeAnthropicCompatibility(req.body || {});
        const compatibilityHeaders = buildAnthropicCompatibilityHeaders(compatibility);
        if (Object.keys(compatibilityHeaders).length > 0) {
            res.set(compatibilityHeaders)
            // Compatibility notices are diagnostic only; throttle them to avoid log spam.
            if (shouldLogCompatNotice(compatibility.summary)) {
                logger.debug(
                    `Anthropic compatibility notice: ${compatibility.summary}`,
                    'ANTHROPIC'
                )
            }
        }

        const requestId = `anth_${generateUUID().replace(/-/g, '').slice(0, 16)}`;
        if (req) req.id = requestId;
        req.chatLatency = req.chatLatency || createChatLatencyTracker({
            requestId,
            protocol: 'anthropic',
            route: '/v1/messages',
            profile: req.clientProfile?.name,
            stream: !!req.body?.stream
        });
        // Lifecycle recorder：跟踪 12 个生命周期事件（controller 负责 6 个，stream handler 负责 6 个）
        if (!req.lifecycleRecorder) {
            req.lifecycleRecorder = createLifecycleRecorder(requestId, {
                model: req.body?.model,
                stream: req.body?.stream,
                messageCount: Array.isArray(req.body?.messages) ? req.body.messages.length : 0
            });
            req.lifecycleRecorder.record('request_accepted');
            req.lifecycleRecorder.record('body_parsed');
        }

        let built;
        try {
            built = await buildInternalRequest(req.body || {}, req);
        } catch (buildErr) {
            // scheduler 拒绝（队列满/超时/关闭/客户端断开）— 返回 429/503 + Retry-After
            if (buildErr && buildErr.schedulerError) {
                const httpStatus = buildErr.status || 503;
                const retryAfter = buildErr.retryAfter || '30';
                if (!res.headersSent) {
                    res.set('Retry-After', retryAfter);
                    const normalized = normalizeError(buildErr, { provider: 'qwen' });
                    normalized.statusCode = httpStatus;
                    return sendAnthropicError(res, normalized, { code: 'SCHEDULER_REJECTED' });
                }
            }
            throw buildErr;
        }
        const { body, hasTools, toolChoice, model, preSelectedAccount, rawTools, rawMessages } = built;
        // requestedModel 用于日志/统计/错误输出：保留客户端原始请求的模型名（含后缀别名）。
        // model 变量本身是 upstreamModel（发送给 Qwen 的真实模型 ID），仍用于 ctx.model / body.model。
        const requestedModel = req.modelResolution?.requestedModel || model;
        setLatencyFields(req.chatLatency, {
            requestId,
            protocol: 'anthropic',
            route: '/v1/messages',
            profile: req.clientProfile?.name,
            model: requestedModel,
            hasTools,
            stream: !!req.body?.stream
        });

        // Preserve the account chosen before image upload so OSS resources and the
        // final Qwen request stay on the same account.
        const upstreamResp = await sendChatRequest(body, req, { account: preSelectedAccount, latency: req.chatLatency });
        if (!upstreamResp.status || !upstreamResp.response) {
            // 上游请求失败 — 释放 lease 为 'upstream_error'（流式路径不会执行到这里）
            if (req.lease) {
                try { req.lease.release('upstream_error'); } catch (_) { /* idempotent */ }
                req.lease = null;
            }
            const errMsg = upstreamResp && upstreamResp.error
                ? String(upstreamResp.error)
                : 'Request failed';
            // 复用统一错误响应：sendAnthropicError 内部 sanitizeErrorMessage 脱敏，
            // extra 字段（code/punish_url/upstream_status）保持与原内联实现一致。
            const extra = {};
            if (upstreamResp?.errorKind) extra.code = upstreamResp.errorKind;
            if (upstreamResp?.punishUrl) extra.punish_url = upstreamResp.punishUrl;
            if (upstreamResp?.upstreamStatus) extra.upstream_status = upstreamResp.upstreamStatus;
            return sendAnthropicError(
                res,
                normalizeError(new Error(errMsg), { provider: 'qwen', model: requestedModel }),
                extra
            );
        }

        const message_id = `msg_${generateUUID().replace(/-/g, '').slice(0, 24)}`;
        // Profile selection controls strict tool behavior for this request.
        const activeProfile = getAnthropicProfile(req);
        const ctx = {
            res,
            upstream: upstreamResp.response,
            message_id,
            model,
            hasTools,
            toolChoice,
            requestBody: body,
            currentAccount: upstreamResp.currentAccount,
            toolNames: extractToolNames(req.body || {}),
            rawTools,
            rawMessages,
            requestId,
            // Generic retry budget for non-strict profiles.
            retryCount: 0,
            clientProfile: activeProfile,
            latency: req.chatLatency,
            chat_id: upstreamResp.chat_id,
            req
        };

        // One compact profile log line is enough for request-path debugging.
        if (shouldLogCompatNotice(`profile:${activeProfile.profile.name}:${requestedModel}:${hasTools}`)) {
            logger.debug(
                `[anthropic] requestId=${requestId} protocol=anthropic profile=${activeProfile.profile.name} model=${requestedModel} hasTools=${hasTools} stream=${!!req.body?.stream}`,
                'PROFILE'
            )
        }

        if (req.body?.stream) {
            // 流式路径：lease.release 由 stream-handler 负责（Phase C4 接入），此处不释放
            await handleAnthropicStream(ctx);
        } else {
            // 同步路径：在此处释放 lease（success/failure）
            try {
                await handleAnthropicSync(ctx);
                if (req.lease) {
                    try { req.lease.release('success'); } catch (_) { /* idempotent */ }
                    req.lease = null;
                }
            } catch (syncErr) {
                if (req.lease) {
                    try { req.lease.release('failure'); } catch (_) { /* idempotent */ }
                    req.lease = null;
                }
                throw syncErr;
            }
        }
    } catch (error) {
        // 兜底释放 lease：stream-handler 可能未捕获到异常（如 finalizeAnthropicStream 抛异常）
        if (req.lease) {
            try { req.lease.release('failure'); } catch (_) { /* idempotent */ }
            req.lease = null;
        }
        logger.error('Anthropic Messages 处理错误', 'ANTHROPIC', '', error);
        if (!res.headersSent) {
            // 保持原 "Service error" 文案，避免泄露内部异常细节；
            // 走统一 sendAnthropicError 确保响应格式与脱敏逻辑一致。
            sendAnthropicError(
                res,
                normalizeError(new Error('Service error'), { provider: 'qwen' })
            );
        } else {
            try { res.end(); } catch (_) { /* ignore */ }
        }
    }
};

module.exports = {
    handleAnthropicMessages,
};
