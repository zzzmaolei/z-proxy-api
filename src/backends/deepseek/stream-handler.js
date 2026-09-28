/**
 * DeepSeek 流式响应处理器
 *
 * 从 src/controllers/dpsk-chat.js 提取，独立为可复用的流式处理模块。
 *
 * ctx 对象必须包含以下字段：
 *   res, token, account, chatSessionId, prompt, model, chatOptions,
 *   startTime, hasTools, toolChoice, tools, clientProfile,
 *   cachedSession, sessionKey
 */

const dpskClient = require('./dpsk-client');
const { logger } = require('../../utils/logger');
const config = require('../../config');
const claudeCodeProfile = require('../../agents/claude-code-profile');
const {
    createToolCallStreamParser,
    parseLooseToolCallsFromText,
    resolveToolName,
    createPreambleDropper,
    canonicalizeToolCalls,
} = require('../../utils/tool-prompt');
const { attributeChatUsage } = require('../../utils/usage-tracker');
const { countTokens } = require('../../utils/precise-tokenizer');
const {
    requiresToolCall,
    buildRequiredRetryHint,
    buildEmptyResponseRetryHint,
    buildGenericNoToolCallHint,
} = require('../../shared/tool-injection');
const {
    createHeartbeat,
    writeContentDelta: writeContentDeltaBase,
    writeToolCallsDelta: writeToolCallsDeltaBase,
    generateRequestId,
} = require('../stream-utils');
const {
    createDeepSeekAttemptCoordinator,
    createFreshRetryGenerator,
    isRetryBudgetError,
    isRetryableTransportError,
} = require('./retry-context');
const {
    shouldRetrySemantic,
    hasRequiredToolCall,
    createToolCallRequiredError,
} = require('./tool-retry-policy');
const { buildRetryPrompt, createPromptTooLargeError } = require('./prompt-budget');
const { SafeSseWriter } = require('../../utils/safe-sse-writer');
const { commitSessionTurn, invalidateSession } = require('./anthropic-utils');
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

const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Detect a response that is trying to call a tool but used a function-like
 * text form instead of the bridge XML. This is intentionally narrow: a short
 * normal answer must never trigger a tool-call retry.
 */
const looksLikeDirectToolIntent = (text, tools) => {
    if (!text || !Array.isArray(tools) || tools.length === 0) return false;
    const value = String(text).slice(0, 8000);
    if (/<tool_(?:call|invoke|use)\b/i.test(value)) return true;
    return tools.some((tool) => {
        const name = tool?.name || tool?.function?.name;
        if (!name) return false;
        const pattern = new RegExp(`(?:^|[\\s\\n(])${escapeRegExp(name)}\\s*\\(`, 'i');
        return pattern.test(value);
    });
};

/**
 * 处理流式响应
 */
async function handleStreamResponse(ctx) {
    const {
        req, res, token, chatSessionId, prompt, model, chatOptions, startTime,
        hasTools, toolChoice, tools, clientProfile, cachedSession, sessionKey,
        promptBytes: ctxPromptBytes, promptBudget: ctxPromptBudget,
        promptBudgetOptions: ctxPromptBudgetOptions,
        skipEmptyRetry: ctxSkipEmptyRetry,
    } = ctx;
    const sessionContinuity = ctx.sessionContinuity === true;
    const sessionMessages = ctx.sessionMessages;
    const sessionContextFingerprint = ctx.sessionContextFingerprint || '';
    const promptBytes = Number(ctxPromptBytes) > 0
        ? Number(ctxPromptBytes)
        : Buffer.byteLength(String(prompt || ''), 'utf8');
    // 接近/超过 Web 上下文墙时：禁止 empty/transport 重试（重试同体积 prompt 只会再空一次）
    const skipEmptyRetry = ctxSkipEmptyRetry === true
        || ctxPromptBudget?.status === 'soft_limit'
        || ctxPromptBudget?.status === 'hard_limit'
        || (!ctxPromptBudget && promptBytes >= 180000);
    const promptBudgetOptions = ctxPromptBudgetOptions || {};
    const retryCoordinator = createDeepSeekAttemptCoordinator();
    const clientAbort = new AbortController();
    const requestSignal = ctx.requestSignal || req?._dpskAbortSignal || null;
    const onRequestAbort = () => clientAbort.abort();
    if (requestSignal) {
        requestSignal.addEventListener('abort', onRequestAbort, { once: true });
        if (requestSignal.aborted) clientAbort.abort();
    }
    const baseChatOptions = { ...chatOptions, parentMessageId: null, signal: clientAbort.signal };
    const initialChatOptions = { ...chatOptions, signal: clientAbort.signal };

    // 先写 SSE headers + 启动心跳，确保客户端有保活信号
    // /v1/responses may have already flushed lifecycle headers before this
    // provider controller runs. Preserve those headers and avoid throwing
    // ERR_HTTP_HEADERS_SENT on an otherwise valid stream.
    if (!res.headersSent) {
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        try { res.flushHeaders?.(); } catch (_) { /* ignore */ }
    }

    const requestId = generateRequestId('dpsk');
    const responseCreated = Math.floor(Date.now() / 1000);
    const streamWriter = new SafeSseWriter(res);
    const protocolRes = { write: frame => streamWriter.write(frame) };
    const includeUsage = req?.body?.stream_options?.include_usage === true;
    const latency = ctx.latency || req?.chatLatency || null;
    setLatencyFields(latency, { requestId });
    baseChatOptions.onFirstByte = (chunk) => markFirstUpstreamByte(latency, logger, {
        firstUpstreamChunkBytes: Buffer.byteLength(chunk || ''),
    });
    let totalTextLength = 0;
    let fullResponseText = ''; // 累积完整响应文本（用于 tool_call 补救 reparse）
    let fullReasoningText = '';

    // 心跳 — 避免 Thinking 期间因无 text delta 导致 SDK 端超时断连
    // 间隔 12s，与 shared/anthropic-base.js 的 HEARTBEAT_MS 一致
    const heartbeat = createHeartbeat(res, 12000);

    // 客户端断开 → abort 上游 + 清除 session 缓存 + 清理心跳
    let clientDisconnected = false;
    let activeGen = null; // 当前正在被 consumeGenerator 消费的 generator
    const onClientClose = () => {
        clientDisconnected = true;
        clientAbort.abort();
        streamWriter.abort();
        try { heartbeat.stop(); } catch (_) { /* ignore */ }
        try { activeGen?.return?.(); } catch (_) { /* ignore */ }
        if (sessionKey) {
            // 仅记录账号亲和性 key，不记录 Prompt 或 token。
            logger.info(`[DPSK] 客户端断开，session ${sessionKey.slice(0, 24)}...`, 'DPSK');
        }
    };
    res.once('close', onClientClose);

    streamWriter.write(`data: ${JSON.stringify({
        id: requestId,
        object: 'chat.completion.chunk',
        created: responseCreated,
        model,
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    })}\n\n`);
    markFirstDownstreamWrite(latency, logger, { downstreamKind: 'role' });
    markFirstProtocolWrite(latency, logger, { downstreamKind: 'role' });

    // 直接创建上游生成器，不做预检 — 错误由 consumeGenerator 内部 catch 处理
    const upstreamGen = dpskClient.sendChatMessage(token, chatSessionId, prompt, initialChatOptions);

    const writeContentDelta = (text) => {
        if (!text) return;
        if (clientDisconnected || res.destroyed || res.writableEnded) return;
        fullResponseText += text;
        emittedAnswerDelta = true;
        markFirstDownstreamWrite(latency, logger, { downstreamKind: 'content' });
        markFirstSemanticWrite(latency, logger, 'content');
        writeContentDeltaBase(protocolRes, requestId, model, text, responseCreated);
    };

    // thinking chunk 走 OpenAI 标准 reasoning_content 字段
    const writeReasoningDelta = (text) => {
        if (!text) return;
        if (clientDisconnected || res.destroyed || res.writableEnded) return;
        markFirstDownstreamWrite(latency, logger, { downstreamKind: 'reasoning' });
        markFirstSemanticWrite(latency, logger, 'reasoning');
        const delta = {
            id: requestId,
            object: 'chat.completion.chunk',
            created: responseCreated,
            model,
            choices: [{
                index: 0,
                delta: { reasoning_content: text },
                finish_reason: null,
            }],
        };
        streamWriter.write(`data: ${JSON.stringify(delta)}\n\n`);
    };

    let globalEmittedCallCount = 0;
    const writeToolCallsDelta = (calls) => {
        if (!calls || calls.length === 0) return;
        if (clientDisconnected || res.destroyed || res.writableEnded) return;
        emittedAnswerDelta = true;
        const indexedCalls = calls.map(c => {
            const idx = (typeof c.index === 'number') ? c.index : globalEmittedCallCount++;
            if (typeof c.index === 'number' && c.index >= globalEmittedCallCount) {
                globalEmittedCallCount = c.index + 1;
            }
            return { ...c, index: idx };
        });
        for (const call of indexedCalls) {
            const name = call?.function?.name || call?.name;
            if (name) emittedToolNames.add(name);
        }
        markFirstDownstreamWrite(latency, logger, { downstreamKind: 'tool_calls' });
        markFirstSemanticWrite(latency, logger, 'tool_calls');
        writeToolCallsDeltaBase(protocolRes, requestId, model, indexedCalls, 32, responseCreated);
    };

    let emittedAnyToolCall = false;
    let emittedAnyClientDelta = false;
    // Reasoning is not a deliverable answer. Keep it separate so a THINK-only
    // upstream completion cannot be reported as a successful turn.
    let emittedAnswerDelta = false;
    let detectedMessageId = null;
    let lastStreamError = null;
    let retryBudgetBlocked = null;
    let requiredToolError = null;
    const emittedToolNames = new Set();
    let upstreamEvents = 0;

    // CC profile + hasTools 时用于过滤未知工具名
    const ccToolNameSet = (hasTools && Array.isArray(tools))
        ? new Set(tools.map(t => (t && (t.name || t.function?.name)) || '').filter(Boolean))
        : new Set();

    /**
     * 消费一个上游生成器
     * 返回 true 表示流正常结束，false 表示流中途出错
     */
    const consumeGenerator = async (gen, toolParser) => {
        try {
            for await (const chunk of gen) {
                if (clientDisconnected || res.destroyed) {
                    try { gen?.return?.(); } catch (_) { /* ignore */ }
                    return false;
                }
                upstreamEvents += 1;
                markFirstParsedEvent(latency, logger, { upstreamEventType: chunk?.type || 'unknown' });
                if (chunk.type === 'message_id') {
                    if (chunk.content) detectedMessageId = chunk.content;
                    continue;
                }
                if (chunk.type === 'text') {
                    markFirstMeaningfulUpstreamDelta(latency, logger, { upstreamEventType: 'text' });
                    totalTextLength += chunk.content.length;
                    if (toolParser) {
                        const parsed = toolParser.push(chunk.content);
                        if (parsed.textDelta && parsed.textDelta.trim()) {
                            writeContentDelta(parsed.textDelta);
                            emittedAnyClientDelta = true;
                        }
                        if (parsed.completedCalls.length > 0) {
                            let callsToEmit = parsed.completedCalls;
                            if (clientProfile && clientProfile.name === 'claude-code' && ccToolNameSet.size > 0) {
                                callsToEmit = parsed.completedCalls.filter(c => resolveToolName(c?.function?.name, ccToolNameSet));
                                if (callsToEmit.length === 0) {
                                    logger.info(`[DPSK] 跳过未知工具名 (streaming): ${parsed.completedCalls.map(c => c?.function?.name).join(', ')}`, 'DPSK');
                                }
                            }
                            if (callsToEmit.length > 0) {
                                // Hermes: tool_call 命中后，如果前面发了文本 delta，撤销它
                                // （实际无法撤销, 但标记让下游处理）
                                writeToolCallsDelta(callsToEmit);
                                emittedAnyToolCall = true;
                                emittedAnyClientDelta = true;
                            }
                        }
                    } else {
                        writeContentDelta(chunk.content);
                        emittedAnyClientDelta = true;
                    }
                } else if (chunk.type === 'thinking') {
                    markFirstMeaningfulUpstreamDelta(latency, logger, { upstreamEventType: 'thinking' });
                    fullReasoningText += chunk.content || '';
                    if (config.outThink === false) continue;
                    writeReasoningDelta(chunk.content);
                    emittedAnyClientDelta = true;
                }
            }
        } catch (streamErr) {
            lastStreamError = streamErr;
            if (!clientDisconnected) {
                logger.warning?.('[DPSK] 上游流中断，不发送正常结束事件', 'DPSK', '', streamErr?.message);
            }
            return false;
        }
        return true;
    };

    const consumeRetry = async (promptToUse, toolParser, retryReason, retryKind = 'semantic') => {
        const retry = await createFreshRetryGenerator({
            token, account: ctx.account, chatOptions: baseChatOptions, prompt: promptToUse,
            retryReason, retryKind, coordinator: retryCoordinator,
            isDisconnected: () => clientDisconnected || res.destroyed || res.writableEnded,
        });
        if (sessionContinuity && cachedSession && retry.chatSessionId) {
            // A retry starts a clean Web session. If it succeeds, the next
            // client turn must continue from that replacement session.
            cachedSession.chatSessionId = retry.chatSessionId;
            cachedSession.lastMessageId = null;
        }
        const gen = retry.generator;
        activeGen = gen;
        try {
            return await consumeGenerator(gen, toolParser);
        } finally {
            activeGen = null;
        }
    };

    try {
        // 检测 Hermes Agent / Pi Agent / Claude Code / Codex 特定行为
        const isHermesAgent = clientProfile && clientProfile.name === 'hermes-agent';
        const isPiAgent = clientProfile && clientProfile.name === 'pi-agent';
        const isCodexAgent = clientProfile && clientProfile.name === 'codex';
        // Claude Code / Pi Agent / Codex / Hermes 均属于 coding agent harness，共享 tool preamble 丢弃与通用纠偏重试
        const isCodingHarness = clientProfile && [
            'claude-code',
            'pi-agent',
            'hermes-agent',
            'codex'
        ].includes(clientProfile.name);
        const isClaudeCodeProfile = isCodingHarness;
        const createParser = () => {
            // 传入 tools：流式解析时把 file_path → filePath 等参数键对齐到 OpenCode schema
            const baseParser = hasTools
                ? createToolCallStreamParser({ tools: Array.isArray(tools) ? tools : [] })
                : null;
            return baseParser
                ? (isClaudeCodeProfile
                    ? createPreambleDropper(baseParser, claudeCodeProfile.looksLikeIntendsToCallTool)
                    : isHermesAgent
                      ? createPreambleDropper(baseParser, () => true)
                      : baseParser)
                : null;
        };
        let toolParser = createParser();

        activeGen = upstreamGen;
        let initialOk = await consumeGenerator(upstreamGen, toolParser);
        activeGen = null;

        // 空流判定：上游 yields=0 或完全没有客户端可见输出
        const isEmptyStream = !emittedAnyClientDelta && !emittedAnyToolCall && upstreamEvents === 0;
        if (isEmptyStream) {
            logger.warn(
                `[DPSK] 上游空流 promptBytes=${promptBytes} skipRetry=${skipEmptyRetry} ` +
                `err=${lastStreamError?.code || lastStreamError?.message || 'none'}`,
                'DPSK',
            );
        }

        // 传输层异常重试（换账号/重试生成器）：
        // 关键防护：只要尚未向客户端发出正式回答（!emittedAnswerDelta）和工具调用（!emittedAnyToolCall），
        // 即使已输出部分 reasoning_content，发生上游流中断（如 UPSTREAM_STREAM_INCOMPLETE / stream ended without [DONE]）
        // 也可以安全触发 transport 重试（新账号重新输出完整流），彻底杜绝网络偶发抖动直接导致任务崩溃！
        if (!initialOk && !emittedAnswerDelta && !emittedAnyToolCall && !clientDisconnected
            && isRetryableTransportError(lastStreamError)) {
            if (skipEmptyRetry) {
                logger.warn(
                    `[DPSK] 跳过 transport 重试：prompt 过大或已标记 skipEmptyRetry (${promptBytes}B)`,
                    'DPSK',
                );
            } else {
                try {
                    toolParser = createParser();
                    initialOk = await consumeRetry(prompt, toolParser, 'transport', 'transport');
                } catch (retryError) {
                    if (!isRetryBudgetError(retryError)) logger.error('[DPSK] transport retry failed', 'DPSK', '', retryError);
                }
            }
        }

        // tool_choice=required 渐进式重试
        const MAX_REQUIRED_RETRIES = 1;
        if (initialOk && hasTools && toolParser && !emittedAnyToolCall && !toolParser.hasEmittedAnyCall() && requiresToolCall(toolChoice)
            && !skipEmptyRetry
            && shouldRetrySemantic({ toolChoice, hasTools, reason: 'required' })) {
            for (let retryIdx = 0; retryIdx < MAX_REQUIRED_RETRIES; retryIdx++) {
                if (clientDisconnected) break;
                const retryHint = buildRequiredRetryHint(toolChoice, retryIdx, { provider: 'deepseek', tools });
                logger.warning?.(`[DPSK] tool_choice=required 第 ${retryIdx + 1} 次重试`, 'DPSK');
                const retryPlan = buildRetryPrompt(prompt, retryHint, {
                    toolCount: Array.isArray(tools) ? tools.length : 0,
                }, promptBudgetOptions);
                if (!retryPlan.allowed) {
                    retryBudgetBlocked = createPromptTooLargeError(retryPlan.budget);
                    lastStreamError = retryBudgetBlocked;
                    logger.warning?.(`[DPSK] required retry skipped: prompt=${retryPlan.budget.bytes}B hard=${retryPlan.budget.hardLimit}B`, 'DPSK');
                    break;
                }
                const retryPrompt = retryPlan.prompt;
                toolParser = createParser();
                try {
                    await consumeRetry(retryPrompt, toolParser, 'required');
                    if (toolParser.hasEmittedAnyCall()) {
                        emittedAnyToolCall = true;
                        emittedAnyClientDelta = true;
                        break;
                    }
                } catch (retryErr) {
                    if (isRetryBudgetError(retryErr)) break;
                    logger.error(`[DPSK] required 模式第 ${retryIdx + 1} 次重试失败`, 'DPSK', '', retryErr);
                }
            }
        }

        // Claude Code final report detection
        const looksLikeFinal = isClaudeCodeProfile && fullResponseText && claudeCodeProfile.looksLikeFinalReport(fullResponseText);
        if (looksLikeFinal) {
            logger.info('[DPSK] 检测到最终报告，跳过空响应重试', 'DPSK');
        }

        // 仅在模型明确表现出“想调用工具但用了普通文字”时纠偏。
        // tool_choice=auto 下的普通短答是合法结果，不能因为少于 800 字就
        // 追加一个强制 tool_call 提示，否则会把“你是什么模型”之类的问题
        // 误变成工具调用，并把协议讨论带进下一轮 thinking。
        const MAX_NO_TOOL_RETRIES = 1;
        const bufferedPreamble = (toolParser && typeof toolParser.getPreambleBufferedText === 'function')
            ? toolParser.getPreambleBufferedText()
            : '';
        const candidateToolText = fullResponseText || bufferedPreamble || '';
        const directToolIntent = looksLikeDirectToolIntent(candidateToolText, tools);
        const profileToolIntent = isClaudeCodeProfile && candidateToolText
            && claudeCodeProfile.looksLikeIntendsToCallTool(candidateToolText);
        const reasoningOnly = !emittedAnswerDelta && !emittedAnyToolCall && fullReasoningText.trim().length > 0;
        const needToolNudge = hasTools && !emittedAnyToolCall && toolChoice !== 'none' && !looksLikeFinal
            && !clientDisconnected && !skipEmptyRetry
            && initialOk && (directToolIntent || profileToolIntent || reasoningOnly);
        if (needToolNudge) {
            for (let retryIdx = 0; retryIdx < MAX_NO_TOOL_RETRIES; retryIdx++) {
                if (clientDisconnected) break;
                const shortHint = reasoningOnly
                    ? buildEmptyResponseRetryHint(retryIdx, { provider: 'deepseek', tools })
                    : retryIdx === 0
                    ? buildGenericNoToolCallHint({ provider: 'deepseek', tools })
                    : buildEmptyResponseRetryHint(retryIdx, { provider: 'deepseek', tools });
                logger.warning?.(
                    `[DPSK] 检测到工具意图但未产出 tool_call（chars=${candidateToolText.length}），短纠偏 ${retryIdx + 1}/${MAX_NO_TOOL_RETRIES}`,
                    'DPSK',
                );
                // 纠偏用「原 prompt 尾部切片 + hint」，避免再叠加超长全文
                // Retry the exact prompt. Silent slicing here can remove a
                // file/tool result and make later turns appear truncated.
                const retryPlan = buildRetryPrompt(prompt, shortHint, {
                    toolCount: Array.isArray(tools) ? tools.length : 0,
                }, promptBudgetOptions);
                if (!retryPlan.allowed) {
                    retryBudgetBlocked = createPromptTooLargeError(retryPlan.budget);
                    lastStreamError = retryBudgetBlocked;
                    logger.warning?.(`[DPSK] correction retry skipped: prompt=${retryPlan.budget.bytes}B hard=${retryPlan.budget.hardLimit}B`, 'DPSK');
                    break;
                }
                const retryPrompt = retryPlan.prompt;
                toolParser = createParser();
                fullResponseText = '';
                try {
                    await consumeRetry(retryPrompt, toolParser, retryIdx === 0 ? 'no-tool-nudge' : 'empty');
                    if (emittedAnyToolCall) break;
                } catch (retryErr) {
                    if (isRetryBudgetError(retryErr)) break;
                    logger.error(`[DPSK] no-tool 纠偏第 ${retryIdx + 1} 次失败`, 'DPSK', '', retryErr);
                }
            }
        } else if (skipEmptyRetry && !emittedAnyClientDelta && !emittedAnyToolCall) {
            logger.warn(`[DPSK] 跳过空响应重试：promptBytes=${promptBytes}`, 'DPSK');
        }

        // flush 工具解析器尾部
        if (toolParser) {
            const tail = toolParser.flush();
            if (tail.textDelta) {
                // Hermes 有 preamble dropper 包装时，还能穿透的文本就是最终报告
                if (isHermesAgent && emittedAnyToolCall) {
                    // Hermes preferToolCallsOnly: 已有 tool_call 时丢弃尾部文本
                } else {
                    writeContentDelta(tail.textDelta);
                    emittedAnyClientDelta = true;
                }
            }
            if (tail.completedCalls.length > 0) {
                writeToolCallsDelta(tail.completedCalls);
                emittedAnyToolCall = true;
                emittedAnyClientDelta = true;
            }
        }

        // tool_call 补救 reparse
        if (hasTools && !emittedAnyToolCall && fullResponseText) {
            const reparseTools = Array.isArray(tools) ? tools : [];
            const reparse = parseLooseToolCallsFromText(fullResponseText, reparseTools);
            if (reparse.toolCalls.length > 0) {
                writeToolCallsDelta(canonicalizeToolCalls(reparse.toolCalls, Array.isArray(tools) ? tools : []));
                emittedAnyToolCall = true;
                emittedAnyClientDelta = true;
                logger.info('[DPSK] tool_call 补救 reparse 成功: 解析到 ' + reparse.toolCalls.length + ' 个工具调用', 'DPSK');
            } else if (requiresToolCall(toolChoice)) {
                // 补救仍失败：打印原文片段便于排查（preamble / 格式不对 / 半截 JSON）
                logger.warn(`[DPSK-PROBLEM] tool_call 解析失败：有 tools 但 fullText 中未识别到 <tool_call>/fence/裸JSON 块 (responseChars=${fullResponseText.length})`, 'DPSK');
            }
        }

        // Claude Code 通用纠偏重试（intent-only narration）
        if (isClaudeCodeProfile && hasTools && !emittedAnyToolCall && !emittedAnswerDelta
                && !looksLikeFinal && toolChoice !== 'none' && !requiresToolCall(toolChoice) && initialOk) {
            const explicitToolIntent = claudeCodeProfile.looksLikeIntendsToCallTool(fullResponseText);
            if (!shouldRetrySemantic({
                toolChoice,
                hasTools,
                reason: 'generic',
                responseText: fullResponseText,
                explicitToolIntent,
            })) {
                // A silent/ordinary Claude Code response is not evidence that
                // the model intended a tool call. Leave it to the normal
                // empty/error classification below.
            } else {
            const genericHint = buildGenericNoToolCallHint({ provider: 'deepseek', tools });
            logger.warning?.('[DPSK] Claude Code 通用纠偏重试 (intent-only narration)', 'DPSK');
            const retryPlan = buildRetryPrompt(prompt, genericHint, {
                toolCount: Array.isArray(tools) ? tools.length : 0,
            }, promptBudgetOptions);
            if (!retryPlan.allowed) {
                retryBudgetBlocked = createPromptTooLargeError(retryPlan.budget);
                lastStreamError = retryBudgetBlocked;
                logger.warning?.(`[DPSK] generic retry skipped: prompt=${retryPlan.budget.bytes}B hard=${retryPlan.budget.hardLimit}B`, 'DPSK');
            } else {
            const retryPrompt = retryPlan.prompt;
            const newParser = createParser();
            try {
                await consumeRetry(retryPrompt, newParser, 'generic');
                if (emittedAnyToolCall) {
                    logger.info('[DPSK] Claude Code 通用纠偏重试成功: 解析到工具调用', 'DPSK');
                }
            } catch (retryErr) {
                if (isRetryBudgetError(retryErr)) {
                    logger.info('[DPSK] Claude Code 通用纠偏重试预算已用尽', 'DPSK');
                }
                logger.error('[DPSK] Claude Code 通用纠偏重试失败', 'DPSK', '', retryErr);
            }
            }
            }
        }

        // Claude Code 的完全空响应只允许一次普通空响应纠偏，不能再
        // 走第二套“强制 required”循环；否则会让 auto 请求被污染。
        if (isClaudeCodeProfile && initialOk && hasTools && !emittedAnyToolCall
                && !emittedAnswerDelta && !clientDisconnected
                && shouldRetrySemantic({
                    toolChoice,
                    hasTools,
                    reason: 'empty',
                    responseText: fullResponseText,
                })) {
            const emptyHint = buildEmptyResponseRetryHint(0, { provider: 'deepseek', tools });
            const retryPlan = buildRetryPrompt(prompt, emptyHint, {
                toolCount: Array.isArray(tools) ? tools.length : 0,
            }, promptBudgetOptions);
            if (!retryPlan.allowed) {
                retryBudgetBlocked = createPromptTooLargeError(retryPlan.budget);
                lastStreamError = retryBudgetBlocked;
                logger.warning?.(`[DPSK] empty retry skipped: prompt=${retryPlan.budget.bytes}B hard=${retryPlan.budget.hardLimit}B`, 'DPSK');
            } else {
            const retryPrompt = retryPlan.prompt;
            const newParser = createParser();
            try {
                await consumeRetry(retryPrompt, newParser, 'empty');
                const tail = newParser.flush();
                if (tail.completedCalls.length > 0) {
                    writeToolCallsDelta(tail.completedCalls);
                    emittedAnyToolCall = true;
                    emittedAnyClientDelta = true;
                }
                if (tail.textDelta) {
                    writeContentDelta(tail.textDelta);
                    emittedAnyClientDelta = true;
                }
            } catch (retryErr) {
                if (!isRetryBudgetError(retryErr)) logger.error('[DPSK] Claude Code 空响应纠偏失败', 'DPSK', '', retryErr);
            }
            }
        }

        if (requiresToolCall(toolChoice)
            && !hasRequiredToolCall(
                Array.from(emittedToolNames, name => ({ function: { name } })),
                toolChoice,
            )) {
            requiredToolError = retryBudgetBlocked || createToolCallRequiredError(toolChoice);
            lastStreamError = requiredToolError;
            initialOk = false;
        }

        // A generator that throws after writing content is still incomplete;
        // do not turn that partial response into a successful lease outcome.
        if (!emittedAnswerDelta && !emittedAnyToolCall) initialOk = false;

        if (!initialOk) {
            // Reasoning may already have been sent downstream, but without a
            // final answer/tool event the turn is still incomplete.
            const partial = emittedAnswerDelta || emittedAnyToolCall;
            if (!partial && fullReasoningText.trim()) {
                const reasoningOnlyError = new Error(
                    'DeepSeek upstream emitted reasoning without a final answer or tool call',
                );
                reasoningOnlyError.code = 'dpsk_reasoning_only';
                lastStreamError = reasoningOnlyError;
            }
            const abortedByClient = clientDisconnected;
            // 完全无输出时：写 error event，而不是普通 assistant 文本 + stop。
            // 后者会被 Responses translator 当成 response.completed，掩盖真实空流。
            if ((!partial || requiredToolError) && !clientDisconnected && !res.destroyed && !res.writableEnded) {
                try {
                    const errMsg = requiredToolError
                        ? requiredToolError.message
                        : skipEmptyRetry
                        ? `DeepSeek Web 空响应：上下文约 ${promptBytes}B，已接近/超过 Web 限制。请新开会话或缩短历史后再试。`
                        : (lastStreamError?.message || 'DeepSeek upstream stream incomplete');
                    const errorCode = requiredToolError
                        ? requiredToolError.code
                        : skipEmptyRetry
                        ? 'dpsk_prompt_too_large'
                        : (lastStreamError?.code || 'dpsk_upstream_stream_incomplete');
                    streamWriter.write(`data: ${JSON.stringify({
                        id: requestId,
                        object: 'chat.completion.chunk',
                        created: responseCreated,
                        model,
                        error: {
                            type: 'api_error',
                            code: errorCode,
                            message: errMsg,
                        },
                    })}\n\n`);
                    streamWriter.write('data: [DONE]\n\n');
                    await streamWriter.end();
                } catch (_) {
                    try { streamWriter.abort(); res.destroy(); } catch (__) { /* ignore */ }
                }
            } else if (!clientDisconnected && !res.destroyed) {
                streamWriter.abort();
                res.destroy();
            }
            logger.warning(
                `[DPSK] 上游流不完整，已优雅闭合下游 transport` +
                ` (partial=${partial}, promptBytes=${promptBytes}, code=${lastStreamError?.code || 'unknown'}, ${Date.now() - startTime}ms)`,
                'DPSK',
            );
            if (sessionContinuity) {
                invalidateSession(sessionKey, 'incomplete upstream stream', cachedSession);
            }
            return abortedByClient
                ? 'client_aborted'
                : (partial ? 'incomplete' : (lastStreamError ? 'upstream_error' : 'failure'));
        }

        // 发送结束标记
        // 中途出错但有部分输出时用 stop（而非 error），让 harness 正常消耗已输出内容
        // 并可在 tool_call 已发出时用 tool_calls —— 仅在完全无输出时才用 error
        const streamInterrupted = false;
        const finishReason = emittedAnyToolCall ? 'tool_calls' : 'stop';
        const inputTokens = countTokens(prompt || '', model);
        const answerTokens = countTokens(fullResponseText || '', model);
        const reasoningTokens = countTokens(fullReasoningText || '', model);
        const outputTokens = answerTokens + reasoningTokens;
        const finishDelta = {
            id: requestId,
            object: 'chat.completion.chunk',
            created: responseCreated,
            model,
            choices: [{
                index: 0,
                delta: {},
                finish_reason: finishReason,
            }],
        };
        // 客户端已断开时跳过最终事件写入，避免 ERR_STREAM_WRITE_AFTER_END
        // 后续的 usage 统计 / session 更新仍需继续执行
        if (!res.writableEnded && !res.destroyed) {
            streamWriter.write(`data: ${JSON.stringify(finishDelta)}\n\n`);
            if (includeUsage) {
                streamWriter.write(`data: ${JSON.stringify({
                    id: requestId,
                    object: 'chat.completion.chunk',
                    created: responseCreated,
                    model,
                    choices: [],
                    usage: {
                        prompt_tokens: inputTokens,
                        completion_tokens: outputTokens,
                        total_tokens: inputTokens + outputTokens,
                        completion_tokens_details: {
                            reasoning_tokens: reasoningTokens,
                        },
                    },
                })}\n\n`);
            }
            streamWriter.write('data: [DONE]\n\n');
            await streamWriter.end();
            finalizeLatency(logger, latency, {
                finalUpstreamEventCount: upstreamEvents,
                finalParseErrorCount: 0,
                writerDrainWaitMs: streamWriter.drainWaitMs,
                completionChars: fullResponseText.length,
                emittedToolCalls: emittedAnyToolCall ? 1 : 0,
            });
        }

        // 统计 token 使用量
        if (ctx.account && ctx.account.email && (emittedAnswerDelta || emittedAnyToolCall)) {
            attributeChatUsage(ctx.account, {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
                completion_tokens_details: {
                    reasoning_tokens: reasoningTokens,
                },
                estimated: true,
            }, {
                usageSource: 'estimated',
                provider: 'dpsk',
                model: model || '',
            });
        }

        // 跟踪连续工具调用（loop killer）
        if (cachedSession) {
            if (emittedAnyToolCall) {
                cachedSession.consecutiveToolCalls = (cachedSession.consecutiveToolCalls || 0) + 1;
            } else {
                cachedSession.consecutiveToolCalls = 0;
            }
        }

        if (sessionContinuity && cachedSession) {
            const committed = commitSessionTurn(sessionKey, cachedSession, sessionMessages, {
                messageId: detectedMessageId,
                toolCalls: Array.from(emittedToolNames).map(name => ({ name })),
                contextFingerprint: sessionContextFingerprint,
                continuityEnabled: true,
            });
            if (!committed) {
                logger.warn('[DPSK] 完整响应缺少上游 message_id，下一轮将重新建立 session', 'DPSK');
            }
        }

        logger.info(`[DPSK] 流式响应完成 (${Date.now() - startTime}ms, answerChars=${fullResponseText.length}, reasoningChars=${fullReasoningText.length}, tool_calls=${emittedAnyToolCall}, interrupted=${streamInterrupted})`, 'DPSK');
        return clientDisconnected ? 'client_aborted' : 'success';
    } catch (err) {
        const abortedByClient = clientDisconnected;
        if (sessionContinuity) invalidateSession(sessionKey, 'stream handler exception', cachedSession);
        logger.error('[DPSK] 流式响应失败', 'DPSK', '', err);
        if (!res.writableEnded && !res.destroyed) {
            streamWriter.abort();
            res.destroy();
        }
        return abortedByClient
            ? 'client_aborted'
            : (emittedAnswerDelta || emittedAnyToolCall ? 'incomplete' : 'failure');
    } finally {
        if (!clientDisconnected) {
            heartbeat.stop();
        }
        if (requestSignal) {
            requestSignal.removeEventListener('abort', onRequestAbort);
        }
        try { res.removeListener('close', onClientClose); } catch (_) { /* ignore */ }
    }
}

module.exports = { handleStreamResponse, looksLikeDirectToolIntent };
