/**
 * DeepSeek Anthropic 协议流式处理器
 *
 * 处理 Anthropic /v1/messages 流式响应（stream !== false），消费 DeepSeek 上游
 * generator 并输出标准 Anthropic SSE 事件序列。
 *
 * # 处理流程（25 步）
 *   1.  Client profile 检测
 *   2.  Normalize tools & messages
 *   3.  Flatten Anthropic messages → OpenAI 格式 + foldToolMessages
 *   4.  Build tool system prompt
 *   5.  Resolve model type & thinking
 *   6.  Get or create session（缓存复用）
 *   7.  Context compression + buildPrompt
 *   8.  Setup chat options
 *   9.  Set up SSE response headers + heartbeat + writer（先于 peek，确保保活）
 *   10. Stream state（clientDisconnected / activeGenerator / toolParser）
 *   11. Pre-check upstream（peek 第一个 chunk，期间客户端有 heartbeat 保活）
 *   12. Consume upstream generator
 *   13. Unified parse for buffered hasTools path
 *   14. Retry: tool_choice=required
 *   15. Claude Code final report detection
 *   16. Retry: empty response
 *   17. Tool parser tail flush
 *   18. Tool call remedial reparse
 *   19. Claude Code generic correction retry
 *   20. Stream-interrupted handling
 *   20b. Empty-response readonly fallback tool_use
 *   21. Close open blocks
 *   22. Determine stop reason
 *   23. Finalize（usage / stop_reason）
 *   24. Update session cache
 *   25. Usage attribution
 *
 * # 入参
 *   ctx: { res, req, model, messages, system, tools, tool_choice, max_tokens,
 *          thinking, account, startTime }
 */

const { logger } = require('../../utils/logger');
const { SafeSseWriter } = require('../../utils/safe-sse-writer');
const {
    setLatencyFields,
    markFirstUpstreamByte,
    markFirstParsedEvent,
    markFirstMeaningfulUpstreamDelta,
    markFirstProtocolWrite,
    markFirstDownstreamWrite,
    markFirstSemanticWrite,
    finalizeLatency,
} = require('../../utils/chat-latency-monitor');
const dpskClient = require('./dpsk-client');
const config = require('../../config');
const claudeCodeProfile = require('../../agents/claude-code-profile');
const { generateUUID } = require('../../utils/tools');
const {
    buildToolSystemPrompt,
    buildDeepSeekToolSignature,
    foldToolMessages,
    parseLooseToolCallsFromText,
    stripInternalToolBlocks,
} = require('../../utils/tool-prompt');
const { countTokens } = require('../../utils/precise-tokenizer');
const {
    requiresToolCall,
    buildRequiredRetryHint,
    buildEmptyResponseRetryHint,
    buildGenericNoToolCallHint,
    injectToolPromptToLastUser,
} = require('../../shared/tool-injection');
const { detectProfileSafe } = require('../../shared/client-detection');
const { resolveProxyUrl } = require('../../utils/proxy-helper');
const dpskFingerprint = require('./dpsk-fingerprint');
const {
    createAnthropicSSEState,
    createAnthropicStreamWriter,
    STOP_REASONS,
    finalizeAnthropicStream,
    emitAnthropicErrorAndFinalize,
} = require('../../utils/anthropic-sse-state');
const {
    flattenAnthropicMessages,
    extractSystemFromMessages,
    normalizeAnthropicTools,
    normalizeAnthropicToolChoice,
    hasAnthropicRequestImage,
    shouldRequireStopReasonToolUse,
    getAnthropicProfile,
} = require('../../shared/anthropic-helpers');
const {
    startHeartbeat,
    buildToolParser,
    flushToolParser,
    consumeRetryAnswer,
    attributeAnthropicUsage,
} = require('../../shared/anthropic-base');
const {
    REQUEST_ID_PREFIX,
    buildSessionKey,
    shouldUseDeepSeekSession,
    getCachedSession,
    prepareIncrementalMessages,
    commitSessionTurn,
    invalidateSession,
    createRequestSession,
    detectImagesAndDescribe,
    buildPrompt,
} = require('./anthropic-utils.js');
const {
    createDeepSeekAttemptCoordinator,
    createFreshRetryGenerator,
    isRetryBudgetError,
    isRetryableTransportError,
} = require('./retry-context');

function buildCompactDeepSeekToolPrompt(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return '';
    return [
        'ZPROXY_DEEPSEEK_TOOLS_CONTINUE_V1',
        ...tools.map(buildDeepSeekToolSignature),
        'Use <tool_call>{"name":"TOOL","arguments":{...}}</tool_call> with exact names and keys when a tool is needed.',
        'If no tool is needed, answer normally.',
    ].join('\n');
}
const {
    shouldRetrySemantic,
    hasRequiredToolCall,
    createToolCallRequiredError,
} = require('./tool-retry-policy');
const {
    measurePromptBudget,
    buildRetryPrompt,
    createPromptTooLargeError,
} = require('./prompt-budget');

// ===========================================================================
// 流式处理器
// ===========================================================================

/**
 * DeepSeek Anthropic 流式处理器入口
 *
 * @param {Object} ctx - 上下文对象
 * @param {Object} ctx.res - Express 响应对象
 * @param {Object} ctx.req - Express 请求对象
 * @param {string} ctx.model - 模型名
 * @param {Array} ctx.messages - Anthropic 原始消息列表
 * @param {string|Array} ctx.system - system 字段
 * @param {Array} ctx.tools - 工具定义
 * @param {Object} ctx.tool_choice - 工具选择策略
 * @param {number} ctx.max_tokens - 最大 token 数
 * @param {Object} ctx.thinking - thinking 配置
 * @param {Object} ctx.account - 账号对象
 * @param {number} ctx.startTime - 请求开始时间戳
 */
async function handleAnthropicStream(ctx) {
    const {
        res, req, model, messages, system, tools, tool_choice, max_tokens,
        thinking, account, startTime,
    } = ctx;

    const requestId = `${REQUEST_ID_PREFIX}_${generateUUID().replace(/-/g, '').slice(0, 16)}`;
    const messageId = `msg_${generateUUID().replace(/-/g, '').slice(0, 24)}`;
    const clientAbort = new AbortController();
    const requestSignal = ctx.requestSignal || req?._dpskAbortSignal || null;
    const isRequestAborted = () => !!(
        requestSignal?.aborted || req?.aborted || res.destroyed
    );
    const outcomeForError = (error) => (
        error?.code === 'CLIENT_ABORTED'
        || error?.classification === 'client_aborted'
        || error?.code === 'client_disconnected'
        || isRequestAborted()
            ? 'client_aborted'
            : 'failure'
    );
    const onRequestAbort = () => clientAbort.abort();
    if (requestSignal) {
        requestSignal.addEventListener('abort', onRequestAbort, { once: true });
        if (requestSignal.aborted) clientAbort.abort();
    }
    const cleanupRequestAbort = () => {
        if (requestSignal) requestSignal.removeEventListener('abort', onRequestAbort);
    };
    const latency = ctx.latency || req?.chatLatency || null;
    setLatencyFields(latency, { requestId });

    // 预计算工具名列表（后续多处 reparse/重试复用，避免重复构造）
    const reparseTools = Array.isArray(tools) ? tools : [];
    const toolNames = new Set(reparseTools.map(t => t.name));

    // ---- 1. Client profile detection ----
    const clientProfile = req.clientProfile || detectProfileSafe(req);
    const isClaudeCode = clientProfile && clientProfile.name === 'claude-code';
    const activeProfile = getAnthropicProfile(req);

    // ---- 2. Normalize tools & messages ----
    const normalizedTools = normalizeAnthropicTools(tools);
    const hasTools = normalizedTools.length > 0 && tool_choice !== 'none';
    const toolChoice = normalizeAnthropicToolChoice(tool_choice) || 'auto';
    const hasUserImage = hasAnthropicRequestImage(messages);

    // ---- 3. Flatten Anthropic messages to OpenAI format ----
    // Claude Code 某些版本会把 system 消息放到 messages 数组里，这里先提取出来
    // 合并到顶级 system 字段（在 step 7 的 prefixParts 里使用）。
    const { messages: pureMessages, systemText: extractedSystem } = extractSystemFromMessages(messages);
    let flatMessages = flattenAnthropicMessages(pureMessages);
    // 用 XML 版折叠（与 buildToolSystemPrompt 教的 XML 标签格式一致）。
    // prose 版 foldToolMessagesForChatBackend 会产出 "Previous tool result for X (id):"
    // 自然语言描述，与 prompt 承诺的 XML 格式不一致，模型识别不出工具结果，
    // 导致后续轮次返回空内容。OpenAI 路由(dpsk-chat)已用 XML 版稳定运行。
    flatMessages = foldToolMessages(flatMessages);

    // ---- 4. Build tool system prompt ----
    let toolSystemPrompt = '';
    if (hasTools) {
        toolSystemPrompt = buildToolSystemPrompt(normalizedTools, {
            tool_choice: toolChoice,
            hasUserImage,
            claudeCodeProfile: isClaudeCode,
            provider: 'deepseek',
        });
    }

    // ---- 5. Resolve model type & thinking ----
    const modelOptions = dpskClient.resolveModelOptions(model, {
        thinking: thinking || undefined,
    });
    const promptBudgetOptions = {
        modelCapabilities: modelOptions.capabilities,
    };
    const modelType = modelOptions.modelType;
    const thinkingEnabled = modelOptions.capabilities?.thinking_supported === false
        ? false
        : modelOptions.thinkingEnabled;
    const requestedMaxTokens = (typeof max_tokens === 'number' && max_tokens > 0) ? max_tokens : null;
    const declaredMaxOutputTokens = Number(modelOptions.capabilities?.max_output_tokens);
    const maxOutputCap = Number.isFinite(declaredMaxOutputTokens) && declaredMaxOutputTokens > 0
        ? declaredMaxOutputTokens
        : null;
    const appliedMaxTokens = Math.min(requestedMaxTokens || 65536, maxOutputCap || Number.MAX_SAFE_INTEGER);
    res.set?.('x-dpsk-capability-source', String(modelOptions.capabilitySource || 'heuristic'));
    const thinkingSupport = modelOptions.capabilities?.thinking_supported;
    res.set?.('x-dpsk-model-type', String(modelType));
    res.set?.('x-dpsk-thinking-enabled', String(thinkingEnabled));
    res.set?.('x-dpsk-thinking-supported', thinkingSupport == null ? 'unknown' : String(thinkingSupport));
    if (modelOptions.capabilities?.context_window) {
        res.set?.('x-dpsk-context-window', String(modelOptions.capabilities.context_window));
    }
    if (modelOptions.capabilities?.max_output_tokens) {
        res.set?.('x-dpsk-max-output-tokens', String(modelOptions.capabilities.max_output_tokens));
    }
    if (modelOptions.capabilities?.input_character_limit) {
        res.set?.('x-dpsk-input-character-limit', String(modelOptions.capabilities.input_character_limit));
    }
    res.set?.('x-dpsk-requested-max-tokens', requestedMaxTokens == null ? 'unset' : String(requestedMaxTokens));
    res.set?.('x-dpsk-applied-max-tokens', String(appliedMaxTokens));
    const outThinkEnabled = config.outThink !== false;

    // ---- 5.5 Vision→Pro 图片代理：检测图片并调 vision 模型描述注入 ----
    // 与 OpenAI 路线 dpsk-chat.js:287-377 一致：非 vision 模型收到图片时，
    // 借独立 vision 账号描述图片，把描述拼到 user 文本末尾。
    const proxyUrl = resolveProxyUrl(account);
    const fingerprint = dpskFingerprint.getFingerprint(account?.email || '');
    try {
        flatMessages = await detectImagesAndDescribe(flatMessages, {
            account, modelType, proxyUrl, fingerprint, requestId,
            signal: requestSignal,
        });
    } catch (visionErr) {
        logger.warn(`[DPSK-Anth] Vision→Pro 代理失败: ${visionErr.message}`, 'DPSK');
        emitAnthropicErrorAndFinalize(
            res,
            `Image processing failed: ${visionErr.message}`,
            createAnthropicSSEState({ logger, strictThrow: false }),
            'invalid_request_error',
        );
        try { res.end(); } catch (_) { /* ignore */ }
        cleanupRequestAbort();
        return outcomeForError(visionErr);
    }

    // ---- 6. Prompt/session selection ----
    // 首轮建立完整 Web session；后续只发送客户端历史中新增的 tool result
    // 与 user 消息，避免把同一段历史再次累加到上游 session。
    const sessionKey = buildSessionKey(req, messages, account?.email);
    const continuityEnabled = shouldUseDeepSeekSession(req, { clientProfile });
    let cachedSession = continuityEnabled
        ? getCachedSession(sessionKey, {
            accountEmail: account?.email,
            modelType,
            continuityEnabled,
        })
        : null;
    const fullSystem = [system || '', extractedSystem].filter(Boolean).join('\n\n');
    let selection = continuityEnabled
        ? prepareIncrementalMessages(flatMessages, cachedSession, fullSystem)
        : { messages: flatMessages, isFull: true, reset: false, reason: 'continuity-disabled' };
    if (selection.reset && cachedSession) {
        invalidateSession(sessionKey, `history reset (${selection.reason})`, cachedSession);
        cachedSession = null;
        selection = { messages: flatMessages, isFull: true, reset: false, reason: 'reset-to-full' };
    }

    let prompt;
    {
        const promptMessages = selection.messages.map(message => ({
            ...message,
            content: Array.isArray(message?.content)
                ? message.content.map(block => ({ ...block }))
                : message?.content,
            tool_calls: Array.isArray(message?.tool_calls)
                ? message.tool_calls.map(call => ({ ...call, function: call?.function ? { ...call.function } : call?.function }))
                : message?.tool_calls,
        }));
        const effectiveToolPrompt = selection.isFull
            ? toolSystemPrompt
            : buildCompactDeepSeekToolPrompt(normalizedTools);
        const prefixParts = selection.isFull
            ? [effectiveToolPrompt, fullSystem].filter(Boolean)
            : [effectiveToolPrompt].filter(Boolean);
        if (prefixParts.length > 0) {
            injectToolPromptToLastUser(promptMessages, prefixParts.join('\n\n---\n\n'));
        }
        prompt = buildPrompt(promptMessages, { canonicalEnvelope: hasTools });
    }

    if (!prompt || !prompt.trim()) {
        emitAnthropicErrorAndFinalize(
            res, 'Empty prompt after message conversion',
            createAnthropicSSEState({ logger, strictThrow: false }),
            'invalid_request_error',
        );
        try { res.end(); } catch (_) { /* ignore */ }
        cleanupRequestAbort();
        return outcomeForError(null);
    }

    const promptBudget = measurePromptBudget(prompt, {
        messageCount: selection.messages.length,
        toolCount: hasTools ? normalizedTools.length : 0,
        hasToolHistory: flatMessages.some((message) => message?.role === 'tool' || message?.tool_calls?.length),
    }, promptBudgetOptions);
    if (promptBudget.status === 'hard_limit') {
        const error = new Error(
            `DeepSeek Web context too large (${promptBudget.bytes} bytes >= ${promptBudget.hardLimit} bytes)`,
        );
        error.code = 'dpsk_prompt_too_large';
        emitAnthropicErrorAndFinalize(
            res,
            error.message,
            createAnthropicSSEState({ logger, strictThrow: false }),
            'invalid_request_error',
            error.code,
        );
        try { res.end(); } catch (_) { /* ignore */ }
        cleanupRequestAbort();
        return outcomeForError(error);
    }

    // ---- 7. Get or create session ----
    try {
        cachedSession = await createRequestSession(
            sessionKey, account?.token, flatMessages, modelType, account?.email,
            proxyUrl, fingerprint, requestSignal,
            { continuityEnabled },
        );
    } catch (sessionErr) {
        logger.error('[DPSK-Anth] 创建/复用 session 失败', 'DPSK', '', sessionErr);
        emitAnthropicErrorAndFinalize(
            res,
            `Session creation failed: ${sessionErr.message}`,
            createAnthropicSSEState({ logger, strictThrow: false }),
            'api_error',
        );
        try { res.end(); } catch (_) { /* ignore */ }
        cleanupRequestAbort();
        return outcomeForError(sessionErr);
    }
    const chatSessionId = cachedSession.chatSessionId;

    // ---- 8. Setup chat options ----
    const chatOptions = {
        modelType,
        thinkingEnabled,
        maxTokens: appliedMaxTokens,
        proxyUrl,
        fingerprint,
        searchEnabled: false,  // 禁用 Web 端自带联网搜索，由 harness 工具接管
        parentMessageId: continuityEnabled && !selection.isFull
            ? cachedSession.lastMessageId
            : null,
        signal: clientAbort.signal,
        onFirstByte: (chunk) => markFirstUpstreamByte(latency, logger, {
            firstUpstreamChunkBytes: Buffer.byteLength(chunk || ''),
        }),
    };
    const retryCoordinator = createDeepSeekAttemptCoordinator();
    const freshRetryGenerator = async (retryPrompt, retryReason, retryKind = 'semantic') => {
        const retry = await createFreshRetryGenerator({
            token: account?.token, account, chatOptions, prompt: retryPrompt, retryReason, retryKind,
            coordinator: retryCoordinator,
            isDisconnected: () => requestSignal?.aborted || clientDisconnected || res.destroyed || res.writableEnded,
        });
        if (continuityEnabled && cachedSession && retry.chatSessionId) {
            cachedSession.chatSessionId = retry.chatSessionId;
            cachedSession.lastMessageId = null;
        }
        return retry;
    };

    // ---- 9. Set up SSE response (先写 headers + heartbeat，确保 peek 期间客户端有保活信号) ----
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    try { res.flushHeaders?.(); } catch (_) { /* ignore */ }

    const stopHeartbeat = startHeartbeat(res);
    const sseState = createAnthropicSSEState({ logger, strictThrow: false });
    const streamWriter = new SafeSseWriter(res);
    const protocolRes = { write: frame => streamWriter.write(frame) };
    const writer = createAnthropicStreamWriter(protocolRes, sseState, { messageId, model });
    const emittedToolNames = new Set();
    const writeToolCalls = (calls) => {
        for (const call of calls || []) {
            const name = call?.function?.name || call?.name;
            if (name) emittedToolNames.add(name);
        }
        writer.writeToolCalls(calls);
    };
    writer.ensureMessageStart();
    markFirstDownstreamWrite(latency, logger, { downstreamKind: 'message_start' });
    markFirstProtocolWrite(latency, logger, { downstreamKind: 'message_start' });

    // ---- 10. Stream state ----
    let clientDisconnected = false;
    let activeGenerator = null;
    let fullResponseText = '';
    let detectedMessageId = null;
    let upstreamEvents = 0;
    let lastStreamError = null;
    let retryBudgetBlocked = null;
    const onClose = () => {
        clientDisconnected = true;
        clientAbort.abort();
        streamWriter.abort();
        try { stopHeartbeat(); } catch (_) { /* ignore */ }
        try { activeGenerator?.return?.(); } catch (_) { /* ignore */ }
        writer.close();
    };
    res.once('close', onClose);

    // ---- 11. 直接创建上游生成器，不做预检 ----
    const upstreamGen = dpskClient.sendChatMessage(
        account?.token, chatSessionId, prompt, chatOptions,
    );

    const isClaudeCodeProfile = isClaudeCode;
    // 构建流式 tool_call 解析器（CC profile 自动包装 preambleDropper 丢弃过程话术）
    let toolParser = buildToolParser({
        hasTools,
        isClaudeCode: isClaudeCodeProfile,
        toolNames,
        tools: normalizedTools,
    });

    // ---- 12. Consume upstream generator ----
    const consumeGenerator = async (gen, tParser) => {
        try {
            for await (const chunk of gen) {
                if (clientDisconnected) {
                    try { gen?.return?.(); } catch (_) { /* ignore */ }
                    return false;
                }
                if (!chunk) continue;
                upstreamEvents += 1;
                markFirstParsedEvent(latency, logger, { upstreamEventType: chunk.type || 'unknown' });
                if (chunk.type === 'message_id') {
                    if (chunk.content) detectedMessageId = chunk.content;
                    continue;
                }
                if (chunk.type === 'thinking') {
                    markFirstMeaningfulUpstreamDelta(latency, logger, { upstreamEventType: 'thinking' });
                    markFirstSemanticWrite(latency, logger, 'reasoning');
                    writer.emitThinkingDelta(chunk.content, outThinkEnabled);
                    continue;
                }
                if (chunk.type === 'text') {
                    markFirstMeaningfulUpstreamDelta(latency, logger, { upstreamEventType: 'text' });
                    fullResponseText += chunk.content;
                    if (tParser) {
                        const parsed = tParser.push(chunk.content);
                        if (parsed.textDelta && parsed.textDelta.trim()) {
                            markFirstSemanticWrite(latency, logger, 'content');
                            writer.closeThinkingBlock();
                            writer.emitTextDelta(parsed.textDelta);
                        }
                        if (parsed.completedCalls.length > 0) {
                            markFirstSemanticWrite(latency, logger, 'tool');
                            writeToolCalls(parsed.completedCalls);
                        }
                    } else {
                        markFirstSemanticWrite(latency, logger, 'content');
                        writer.closeThinkingBlock();
                        writer.emitTextDelta(chunk.content);
                    }
                }
            }
        } catch (streamErr) {
            lastStreamError = streamErr;
            logger.warning?.('[DPSK-Anth] 流式中途出错', 'DPSK', '', streamErr?.message);
            return false;
        }
        return true;
    };

    // 注：原 consumeUpstream 闭包从未被调用，已识别为死代码并删除

    let initialOk = false;
    try {
        activeGenerator = upstreamGen;
        initialOk = await consumeGenerator(upstreamGen, toolParser);
        activeGenerator = null;
    } catch (genErr) {
        logger.error('[DPSK-Anth] 上游消费异常', 'DPSK', '', genErr);
    }

    if (!initialOk && !writer.hasVisibleOutput && !writer.emittedAnyToolCall && !clientDisconnected
        && isRetryableTransportError(lastStreamError)) {
        try {
            toolParser = buildToolParser({
                hasTools,
                isClaudeCode: isClaudeCodeProfile,
                toolNames,
                tools: normalizedTools,
            });
            const retry = await freshRetryGenerator(prompt, 'transport', 'transport');
            activeGenerator = retry.generator;
            initialOk = await consumeGenerator(retry.generator, toolParser);
            activeGenerator = null;
        } catch (retryError) {
            activeGenerator = null;
            if (!isRetryBudgetError(retryError)) logger.error('[DPSK-Anth] transport retry failed', 'DPSK', '', retryError);
        }
    }

    // ---- 13. Unified parse for hasTools path (tool calls only, text already streamed by tParser) ----
    if (initialOk && hasTools && !writer.emittedAnyToolCall && fullResponseText) {
        let parsed = parseLooseToolCallsFromText(fullResponseText, reparseTools);
        if (parsed.toolCalls.length > 0) {
            writeToolCalls(parsed.toolCalls);
            logger.info(`[DPSK-Anth] 统一解析 XML tool_call 成功: ${parsed.toolCalls.length} 个`, 'DPSK');
        } else {
            const looseParsed = parseLooseToolCallsFromText(fullResponseText, reparseTools);
            if (looseParsed.toolCalls.length > 0) {
                writeToolCalls(looseParsed.toolCalls);
                logger.info(`[DPSK-Anth] 统一解析 loose tool_call 成功: ${looseParsed.toolCalls.length} 个`, 'DPSK');
            } else if (requiresToolCall(toolChoice)) {
                logger.warn(`[DPSK-PROBLEM] Anthropic 路线 tool_call 解析失败：有 tools 但 fullText 未识别到 tool_call 块 (responseChars=${String(fullResponseText).length})`, 'DPSK');
            }
        }
    }

    // ---- 14. Retry: tool_choice=required ----
    const MAX_REQUIRED_RETRIES = 1;
    if (initialOk && hasTools && !writer.hasVisibleOutput && !writer.emittedAnyToolCall && requiresToolCall(toolChoice)
        && shouldRetrySemantic({ toolChoice, hasTools, reason: 'required' })) {
        for (let retryIdx = 0; retryIdx < MAX_REQUIRED_RETRIES; retryIdx++) {
            if (clientDisconnected) break;
            const retryHint = buildRequiredRetryHint(toolChoice, retryIdx, { provider: 'deepseek', tools: normalizedTools });
            logger.warning?.(`[DPSK-Anth] tool_choice=required 第 ${retryIdx + 1} 次重试`, 'DPSK');
            const retryPlan = buildRetryPrompt(prompt, retryHint, {
                toolCount: Array.isArray(normalizedTools) ? normalizedTools.length : 0,
            }, promptBudgetOptions);
            if (!retryPlan.allowed) {
                retryBudgetBlocked = createPromptTooLargeError(retryPlan.budget);
                lastStreamError = retryBudgetBlocked;
                logger.warning?.(`[DPSK-Anth] required retry skipped: prompt=${retryPlan.budget.bytes}B hard=${retryPlan.budget.hardLimit}B`, 'DPSK');
                break;
            }
            const retryPrompt = retryPlan.prompt;
            try {
                const retry = await freshRetryGenerator(retryPrompt, 'required');
                const retryText = await consumeRetryAnswer(retry.generator, { isDisconnected: () => clientDisconnected });
                let parsedRetry = parseLooseToolCallsFromText(retryText, reparseTools);
                if (parsedRetry.toolCalls.length === 0) {
                    parsedRetry = parseLooseToolCallsFromText(retryText, reparseTools);
                }
                if (parsedRetry.toolCalls.length > 0) {
                    fullResponseText = retryText;
                    writeToolCalls(parsedRetry.toolCalls);
                    logger.info(`[DPSK-Anth] required 重试解析 tool_call 成功: ${parsedRetry.toolCalls.length} 个`, 'DPSK');
                    break;
                }
            } catch (retryErr) {
                if (isRetryBudgetError(retryErr)) break;
                logger.error(`[DPSK-Anth] required 第 ${retryIdx + 1} 次重试失败`, 'DPSK', '', retryErr);
            }
        }
    }

    // ---- 15. Claude Code final report detection ----
    const looksLikeFinal = isClaudeCodeProfile && fullResponseText
        && claudeCodeProfile.looksLikeFinalReport(fullResponseText);
    if (looksLikeFinal) {
        logger.info('[DPSK-Anth] 检测到最终报告，跳过空响应重试', 'DPSK');
    }

    // ---- 16. Retry: empty response ----
    // prompt 过大（>200KB ≈ 50K tokens）时上游必然返回空响应，重试只会让 prompt 更大，跳过
    const MAX_EMPTY_RETRIES = 1;
    if (!looksLikeFinal && initialOk && hasTools && !writer.hasVisibleOutput
        && !writer.emittedAnyToolCall && toolChoice !== 'none'
        && shouldRetrySemantic({
            toolChoice,
            hasTools,
            reason: 'empty',
            responseText: fullResponseText,
        })) {
        if (promptBudget.status !== 'ok') {
            logger.warning?.(`[DPSK-Anth] prompt 过大 (${promptBudget.bytes}B ≈ ${promptBudget.tokenEstimate} tokens) 跳过空响应重试`, 'DPSK');
        } else {
            for (let retryIdx = 0; retryIdx < MAX_EMPTY_RETRIES; retryIdx++) {
                if (clientDisconnected) break;
                logger.warning?.(`[DPSK-Anth] 空响应第 ${retryIdx + 1} 次重试`, 'DPSK');
                const emptyRetryHint = buildEmptyResponseRetryHint(retryIdx, { provider: 'deepseek', tools: normalizedTools });
                const retryPlan = buildRetryPrompt(prompt, emptyRetryHint, {
                    toolCount: Array.isArray(normalizedTools) ? normalizedTools.length : 0,
                }, promptBudgetOptions);
                if (!retryPlan.allowed) {
                    retryBudgetBlocked = createPromptTooLargeError(retryPlan.budget);
                    lastStreamError = retryBudgetBlocked;
                    logger.warning?.(`[DPSK-Anth] empty retry skipped: prompt=${retryPlan.budget.bytes}B hard=${retryPlan.budget.hardLimit}B`, 'DPSK');
                } else {
                const retryPrompt = retryPlan.prompt;
                try {
                    const retry = await freshRetryGenerator(retryPrompt, 'empty');
                    const retryText = await consumeRetryAnswer(retry.generator, { isDisconnected: () => clientDisconnected });
                    let parsedRetry = parseLooseToolCallsFromText(retryText, reparseTools);
                    if (parsedRetry.toolCalls.length === 0) {
                        parsedRetry = parseLooseToolCallsFromText(retryText, reparseTools);
                    }
                    if (parsedRetry.toolCalls.length > 0) {
                        fullResponseText = retryText;
                        writeToolCalls(parsedRetry.toolCalls);
                        logger.info(`[DPSK-Anth] 空响应重试解析 tool_call 成功: ${parsedRetry.toolCalls.length} 个`, 'DPSK');
                        break;
                    }
                } catch (retryErr) {
                    if (isRetryBudgetError(retryErr)) break;
                    logger.error(`[DPSK-Anth] 空响应第 ${retryIdx + 1} 次重试失败`, 'DPSK', '', retryErr);
                }
                }
            }
        }
    }

    // ---- 17. Tool parser tail ----
    flushToolParser(toolParser, writer);

    // ---- 18. Tool call remedial reparse ----
    if (hasTools && !writer.emittedAnyToolCall && fullResponseText) {
        const reparse = parseLooseToolCallsFromText(fullResponseText, reparseTools);
        if (reparse.toolCalls.length > 0) {
            writeToolCalls(reparse.toolCalls);
            logger.info('[DPSK-Anth] tool_call 补救 reparse 成功: ' + reparse.toolCalls.length + ' 个', 'DPSK');
        }
    }

    // ---- 19. Claude Code generic correction retry ----
    if (isClaudeCodeProfile && hasTools && !writer.emittedAnyToolCall && !writer.hasVisibleOutput
        && !looksLikeFinal && toolChoice !== 'none' && !requiresToolCall(toolChoice) && initialOk
        && claudeCodeProfile.looksLikeIntendsToCallTool(fullResponseText)
        && shouldRetrySemantic({
            toolChoice,
            hasTools,
            reason: 'generic',
            responseText: fullResponseText,
            explicitToolIntent: true,
        })) {
        const genericHint = buildGenericNoToolCallHint({ provider: 'deepseek', tools: normalizedTools });
        logger.warning?.('[DPSK-Anth] Claude Code 通用纠偏重试', 'DPSK');
        const retryPlan = buildRetryPrompt(prompt, genericHint, {
            toolCount: Array.isArray(normalizedTools) ? normalizedTools.length : 0,
        }, promptBudgetOptions);
        if (!retryPlan.allowed) {
            retryBudgetBlocked = createPromptTooLargeError(retryPlan.budget);
            lastStreamError = retryBudgetBlocked;
            logger.warning?.(`[DPSK-Anth] generic retry skipped: prompt=${retryPlan.budget.bytes}B hard=${retryPlan.budget.hardLimit}B`, 'DPSK');
        } else {
        const retryPrompt = retryPlan.prompt;
        try {
            const retry = await freshRetryGenerator(retryPrompt, 'generic');
            const retryText = await consumeRetryAnswer(retry.generator, { isDisconnected: () => clientDisconnected });
            let parsedRetry = parseLooseToolCallsFromText(retryText, reparseTools);
            if (parsedRetry.toolCalls.length === 0) {
                parsedRetry = parseLooseToolCallsFromText(retryText, reparseTools);
            }
            if (parsedRetry.toolCalls.length > 0) {
                fullResponseText = retryText;
                writeToolCalls(parsedRetry.toolCalls);
                logger.info('[DPSK-Anth] 通用纠偏重试成功', 'DPSK');
            }
        } catch (retryErr) {
            if (!isRetryBudgetError(retryErr)) logger.error('[DPSK-Anth] 通用纠偏重试失败', 'DPSK', '', retryErr);
        }
        }
    }

    let requiredToolError = null;
    if (requiresToolCall(toolChoice)
        && !hasRequiredToolCall(
            Array.from(emittedToolNames, name => ({ function: { name } })),
            toolChoice,
        )) {
        requiredToolError = retryBudgetBlocked || createToolCallRequiredError(toolChoice);
        lastStreamError = requiredToolError;
        initialOk = false;
    }

    if (!writer.hasVisibleOutput && !writer.emittedAnyToolCall) initialOk = false;

    // ---- 20. Flip stream-interrupted handling ----
    if (!initialOk) {
        if (!clientDisconnected) {
            if (!writer.messageStarted) writer.ensureMessageStart();
            emitAnthropicErrorAndFinalize(
                protocolRes,
                requiredToolError?.message || 'DeepSeek upstream stream error',
                sseState,
                requiredToolError ? 'invalid_request_error' : 'api_error',
                requiredToolError?.code || lastStreamError?.code || null,
            );
        }
        stopHeartbeat();
        try { res.removeListener('close', onClose); } catch (_) { /* ignore */ }
        await streamWriter.end();
        if (continuityEnabled) invalidateSession(sessionKey, 'incomplete Anthropic stream', cachedSession);
        logger.warning(`[DPSK-Anth] 流式空响应错误结束 (${Date.now() - startTime}ms)`, 'DPSK');
        cleanupRequestAbort();
        return clientDisconnected
            ? 'client_aborted'
            : (writer.hasVisibleOutput || writer.emittedAnyToolCall
                ? 'incomplete'
                : (lastStreamError ? 'upstream_error' : 'failure'));
    }

    // ---- 20b. (removed) Empty-response readonly fallback tool_use ----
    // 反代层不构造 fallback 工具调用。模型没输出工具调用就如实返回，由 harness 决定下一步。

    // ---- 21. Close open blocks ----
    writer.closeAllBlocks();

    // ---- 22. Determine stop reason ----
    const stopReason = writer.emittedAnyToolCall
        ? (shouldRequireStopReasonToolUse(activeProfile) ? STOP_REASONS.TOOL_USE : STOP_REASONS.END_TURN)
        : STOP_REASONS.END_TURN;

    // ---- 23. Finalize ----
    // countTokens 在 finalize 与 usage attribution 两处均需使用，预计算一次复用
    const inputTokens = countTokens(prompt || '', model);
    const outputTokens = countTokens(fullResponseText || '', model);
    if (!clientDisconnected) {
        writer.ensureMessageStart();
        finalizeAnthropicStream(protocolRes, sseState, {
            stopReason,
            inputTokens,
            outputTokens,
        });
    }

    stopHeartbeat();
    try { res.removeListener('close', onClose); } catch (_) { /* ignore */ }
    cleanupRequestAbort();
    await streamWriter.end();
    finalizeLatency(logger, latency, {
        finalUpstreamEventCount: upstreamEvents,
        finalParseErrorCount: 0,
        writerDrainWaitMs: streamWriter.drainWaitMs,
        completionChars: fullResponseText.length,
        emittedToolCalls: writer.emittedAnyToolCall ? 1 : 0,
    });

    // ---- 25. Usage attribution ----
    attributeAnthropicUsage({
        account, inputTokens, outputTokens, provider: 'deepseek', model, writer,
    });

    if (continuityEnabled && cachedSession) {
        const committed = commitSessionTurn(sessionKey, cachedSession, flatMessages, {
            messageId: detectedMessageId,
            toolCalls: Array.from(emittedToolNames).map(name => ({ name })),
            contextFingerprint: fullSystem,
            continuityEnabled: true,
        });
        if (!committed) logger.warn('[DPSK-Anth] 完整响应缺少上游 message_id，下一轮将重新建立 session', 'DPSK');
    }

    logger.info(
        `[DPSK-Anth] 流式完成 (${Date.now() - startTime}ms, chars=${fullResponseText.length}, ` +
        `tool_calls=${writer.emittedAnyToolCall}, model=${model}, messageId=${messageId.slice(0, 20)})`,
        'DPSK',
    );
    return clientDisconnected ? 'client_aborted' : 'success';
}

module.exports = { handleAnthropicStream };
