/**
 * Qwen 路线 Anthropic 协议流式响应处理器
 *
 * 从 src/controllers/anthropic.js 提取，独立为可复用的流式处理模块。
 *
 * # 职责
 *
 * 消费 Qwen Web 上游 SSE → 解析 tool 调用 → 按 Anthropic /v1/messages 事件序列写出
 * （message_start / content_block_start/delta/stop / message_delta / message_stop）。
 *
 * # 流式策略
 *
 *  - phase=think: 直接 emit 思维块（与工具解析无关）
 *  - phase=answer:
 *    - hasTools=false: 直接 emit 文本
 *    - hasTools=true : 先缓冲到 toolCandidateBuffer，到流结束（或纠偏重试）后
 *      用 XML + loose JSON 解析，识别为 tool_use 则不再把 raw JSON 当文本发出
 *  - claude-code profile: dropToolPreamble 决定"解析到 tool_use 时丢弃 cleanedText"；
 *    requireStopReasonToolUse 决定"tool_use 时 stop_reason 必须是 tool_use"
 *  - generic-anthropic profile: 不应用上述严苛规则，保留原始文本 + end_turn 行为
 *
 * # 入参 ctx
 *
 * handleAnthropicStream(ctx) 中 ctx 必须包含：
 *   res, upstream, message_id, model, hasTools, toolChoice, requestBody, toolNames,
 *   rawTools, rawMessages, requestId, currentAccount, clientProfile, retryCount,
 *   latency, req
 */
const { sendChatRequest } = require('./request.js');
const accountManager = require('../../utils/account.js');
const { createUsageObject } = require('../../utils/precise-tokenizer.js');
const { logger } = require('../../utils/logger');
const { SafeSseWriter } = require('../../utils/safe-sse-writer');
const { buildGenericNoToolCallHint } = require('../../shared/tool-injection');
const { attributeChatUsage } = require('../../utils/usage-tracker.js');
const { logInterruption, logAnomaly } = require('../../utils/chat-interruption-monitor.js');
const {
    markFirstUpstreamEvent,
    markFirstDownstreamWrite,
    markFirstUpstreamByte,
    markFirstParsedEvent,
    markFirstMeaningfulUpstreamDelta,
    markFirstProtocolWrite,
    markFirstSemanticWrite,
    createLatencyHoldObserver,
    finalizeLatency,
    setLatencyFields
} = require('../../utils/chat-latency-monitor.js');
const strictToolMode = require('../../utils/strict-tool-mode.js');
const {
    createAnthropicSSEState,
    BLOCK_TYPES,
    finalizeAnthropicStream,
    emitAnthropicErrorAndFinalize
} = require('../../utils/anthropic-sse-state.js');
const claudeCodeProfile = require('../../agents/claude-code-profile.js');
const { shouldRequireStopReasonToolUse } = require('../../shared/anthropic-helpers.js');
const {
    shouldDropToolPreamble,
    isStrictToolUse,
    isStrictToolModeActive,
    resolveToolCallsWithStrictMode,
    appendRetryHint,
    requiresToolCall,
    buildRequiredRetryHint,
    buildUnknownToolCallHint,
    looksLikeToolCallAttempt,
    looksLikeIntendsToCallTool,
    looksLikeFinalReport,
    isTextEssentiallyEmpty,
    extractToolCallsFromBuffer,
    consumeUpstream
} = require('./anthropic-utils.js');
const {
    isThinkingPhase,
    extractThinkingSummaryDelta
} = require('./stream-utils');
const { startHeartbeat } = require('../../shared/anthropic-base');
const { createToolCallStreamParser, createPreambleDropper, sanitizeQwenErrorStrings } = require('../../utils/tool-prompt');

// ===========================================================================
// 流式专用辅助
// ===========================================================================

// startHeartbeat 复用自 shared/anthropic-base.js（支持可选 intervalMs 参数）

/**
 * 把工具调用的 arguments JSON 字符串切成 input_json_delta 切片
 * @param {string} argsJson - 完整 JSON 字符串
 * @param {number} [chunkSize=32] - 单片大小
 * @returns {Array<string>} 切片列表
 */
const sliceArgsJson = (argsJson, chunkSize = 32) => {
    const out = []
    for (let i = 0; i < argsJson.length; i += chunkSize) {
        out.push(argsJson.slice(i, i + chunkSize))
    }
    return out
}

/**
 * 写入一个 Anthropic SSE 事件
 * @param {object} res - Express 响应
 * @param {string} event - 事件名
 * @param {Object} data - 事件 payload
 */
const writeAnthropicEvent = (res, event, data) => {
    try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    } catch (_) { /* client disconnected */ }
}

// ===========================================================================
// 主流程
// ===========================================================================

/**
 * 将 SSE stream 的最终 phase 映射为调度器 outcome
 * @param {string} phase - 释放前的 streamState.phase
 * @param {boolean} terminalSent - 是否已发送 terminal 事件
 * @param {boolean} emittedAnyClientDelta - 是否已向客户端输出任何 delta
 * @returns {string} outcome for lease.release()
 */
const mapStreamPhaseToOutcome = (phase, terminalSent, emittedAnyClientDelta) => {
    if (phase === 'terminal' || terminalSent) return 'success'
    if (phase === 'aborted') return 'client_aborted'
    if (phase === 'incomplete' || emittedAnyClientDelta) return 'incomplete'
    if (phase === 'failed') return 'failure'
    return 'incomplete'  // 默认：未正常终止
}

/**
 * 处理流式 Anthropic 响应
 * @param {Object} ctx - 处理上下文（单参 ctx，与 DeepSeek backends 对齐）
 * @param {object} ctx.res - Express 响应
 * @param {object} ctx.upstream - 上游 axios 响应
 * @returns {Promise<void>} 完成 Promise
 */
const handleAnthropicStream = async (ctx) => {
    const streamState = {
        phase: 'preparing',           // preparing | connecting | streaming | terminal | incomplete | aborted | failed | released
        terminalSent: false,          // has terminal event been sent to client?
        emittedAnyClientDelta: false, // has any content delta been sent to client?
        correlationId: null,          // metrics correlation ID (set externally)
        accountId: null,              // account ID (set externally)
        startedAt: Date.now(),
        contentBytesSent: 0,
        contentChunksSent: 0,
        toolCallsParsed: 0,
        reasoningChunksSent: 0
    }
    // 释放调度器租约（幂等）。在各出口点调用，确保 inFlight 计数器递减。
    const releaseLease = () => {
        try {
            if (ctx && ctx.req && ctx.req.lease && typeof ctx.req.lease.release === 'function') {
                const outcome = mapStreamPhaseToOutcome(streamState.phase, streamState.terminalSent, streamState.emittedAnyClientDelta)
                ctx.req.lease.release(outcome)
            }
        } catch (_e) { /* 幂等，忽略 */ }
    }
    const { res, upstream } = ctx;
    const { message_id, model, hasTools, toolChoice, requestBody, toolNames, rawTools, rawMessages, requestId } = ctx
    const latency = ctx.latency || ctx.req?.chatLatency || null
    setLatencyFields(latency, { requestId })
    const parserHold = createLatencyHoldObserver(latency, 'parser')
    const preambleHold = createLatencyHoldObserver(latency, 'preamble')
    const activeProfile = ctx.clientProfile || claudeCodeProfile
    const dropPreamble = shouldDropToolPreamble(activeProfile)
    const requireToolUseStopReason = shouldRequireStopReasonToolUse(activeProfile)
    const strictToolUse = isStrictToolUse(activeProfile)
    const strictModeEnabled = isStrictToolModeActive(hasTools, toolChoice, activeProfile)
    const profileMaxRetry = Number((activeProfile && activeProfile.profile && activeProfile.profile.maxCorrectionRetry) || 0)
    const sseState = createAnthropicSSEState({ logger, strictThrow: false })
    const stopHeartbeat = startHeartbeat(res)
    // 保存首次请求的 chat_id，bootstrap retry 时复用，避免重复生成（池取/网络生成）
    let savedChatId = ctx.chat_id || null

    let clientClosed = false
    let streamWriter = null
    const clientAbort = new AbortController()
    const onClientClose = () => {
        streamState.phase = 'aborted'
        clientClosed = true
        clientAbort.abort()
        streamWriter?.abort()
    }
    // 用 once 避免多次触发；命名 handler 以便清理时 removeListener
    const onClose = () => {
        stopHeartbeat()
        onClientClose()
    }
    res.once('close', onClose)

    res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    })
    if (typeof res.flushHeaders === 'function') {
        try { res.flushHeaders() } catch (_) {}
    }
    streamWriter = new SafeSseWriter(res)
    const protocolRes = { write: frame => streamWriter.write(frame) }

    let messageStarted = false
    const ensureMessageStart = () => {
        if (messageStarted) return
        markFirstDownstreamWrite(latency, logger, {
            downstreamKind: 'message_start'
        })
        markFirstProtocolWrite(latency, logger, { downstreamKind: 'message_start' })
        writeAnthropicEvent(protocolRes, 'message_start', {
            type: 'message_start',
            message: {
                id: message_id,
                type: 'message',
                role: 'assistant',
                model,
                content: [],
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 }
            }
        })
        sseState.markMessageStart()
        messageStarted = true
    }
    ensureMessageStart()
    streamState.phase = 'connecting'

    let blockIndex = -1
    let textBlockOpen = false
    let thinkingBlockOpen = false
    let promptTokens = 0
    let completionTokens = 0
    // hasTools 时把 answer 内容缓冲到这里，流结束后统一解析兜底工具调用
    let toolCandidateBuffer = ''
    let hasVisibleStreamOutput = false
    let emittedToolCallCount = 0
    // 流式工具调用解析器：hasTools 时实时输出文本（非工具部分），工具调用 hold 住
    let tParser = null
    if (hasTools) {
        tParser = createToolCallStreamParser()
        if (toolNames) {
            tParser.setToolNames(toolNames)
        }
        if (dropPreamble) {
            tParser = createPreambleDropper(tParser, claudeCodeProfile.looksLikeIntendsToCallTool)
        }
    }

    const closeTextBlockIfOpen = () => {
        if (textBlockOpen) {
            sseState.requireBlockStop(blockIndex)
            writeAnthropicEvent(protocolRes, 'content_block_stop', { type: 'content_block_stop', index: blockIndex })
            textBlockOpen = false
        }
    }

    const closeThinkingBlockIfOpen = () => {
        if (thinkingBlockOpen) {
            sseState.requireBlockStop(blockIndex)
            writeAnthropicEvent(protocolRes, 'content_block_stop', { type: 'content_block_stop', index: blockIndex })
            thinkingBlockOpen = false
        }
    }

    /**
     * 输出一段思维增量；按需打开新思维块
     * @param {string} thinking - 思维增量
     */
    const emitThinkingDelta = (thinking) => {
        void thinking
        // 上游没有 Anthropic 可验证 signature；不伪造 thinking block。
        return false
    }

    /**
     * 输出一段文本增量；按需打开新文本块
     * @param {string} text - 文本增量
     */
    const emitTextDelta = (text) => {
        if (!text || clientClosed) return
        text = sanitizeQwenErrorStrings(text);
        if (!text) return;  // 全部是 Qwen 错误字符串，跳过
        hasVisibleStreamOutput = true
        streamState.emittedAnyClientDelta = true
        streamState.contentBytesSent += text.length
        streamState.contentChunksSent++
        markFirstSemanticWrite(latency, logger, 'content')
        ensureMessageStart()
        if (!textBlockOpen) {
            closeThinkingBlockIfOpen()
            blockIndex += 1
            sseState.requireBlockStart(blockIndex, BLOCK_TYPES.TEXT)
            writeAnthropicEvent(protocolRes, 'content_block_start', {
                type: 'content_block_start',
                index: blockIndex,
                content_block: { type: 'text', text: '' }
            })
            textBlockOpen = true
        }
        sseState.requireDelta(blockIndex)
        writeAnthropicEvent(protocolRes, 'content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text }
        })
    }

    /**
     * 输出一个完整的 tool_use 块（按 input_json_delta 切片）
     * @param {Object} call - 工具调用
     */
    const emitToolUse = (call) => {
        // Anthropic tool_use 必须是完整 block：start → input_json_delta* → stop。
        // 不要在同一个 block 里混 text，也不要省略 stop；Claude Code 会按该序列驱动工具执行。
        if (clientClosed) return
        streamState.emittedAnyClientDelta = true
        streamState.toolCallsParsed++
        markFirstSemanticWrite(latency, logger, 'tool')
        ensureMessageStart()
        closeThinkingBlockIfOpen()
        closeTextBlockIfOpen()
        blockIndex += 1
        sseState.requireBlockStart(blockIndex, BLOCK_TYPES.TOOL_USE)
        writeAnthropicEvent(protocolRes, 'content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'tool_use', id: call.id, name: call.function.name, input: {} }
        })
        const args = call.function.arguments || '{}'
        for (const piece of sliceArgsJson(args)) {
            sseState.requireDelta(blockIndex)
            writeAnthropicEvent(protocolRes, 'content_block_delta', {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'input_json_delta', partial_json: piece }
            })
        }
        sseState.requireBlockStop(blockIndex)
        writeAnthropicEvent(protocolRes, 'content_block_stop', { type: 'content_block_stop', index: blockIndex })
    }

    let webSearchInfo = null
    let thinkingStarted = false
    let heldThinkingContent = ''
    // thinking_summary 阶段:Qwen 上游发送累积数组,取 last element 作为本次内容。
    // 但同一内容可能在连续多个事件中重复出现,需要追踪上次发出的内容以跳过重复,
    // 避免 Claude Code 收到混乱的 thinking_delta 导致思考内容不显示。
    let lastThinkingSummaryContent = ''
    let usageSource = 'upstream'
    let strictRetryPromptTokens = 0
    let strictRetryCompletionTokens = 0
    let strictBlocked = false
    let strictRetryUsed = false
    let strictFallbackUsed = false
    let strictDecisionKind = ''
    let upstreamEvents = 0
    let upstreamParseErrors = 0
    let answerChars = 0
    let thinkingChars = 0

    /**
     * 处理一个上游 delta JSON
     * @param {Object} json - 上游 SSE delta
     */
    const onUpstreamDelta = async (json) => {
        if (clientClosed) return
        if (!json.choices || json.choices.length === 0) return
        if (json.usage) {
            promptTokens = json.usage.prompt_tokens || promptTokens
            completionTokens = json.usage.completion_tokens || completionTokens
        }
        const delta = json.choices[0].delta
        // thinking_summary 事件：从 extra.summary_thought.content 提取 thinking 增量
        // （content 字段为空，真实文本在累积数组里，只取最后一个元素作为本次增量）
        extractThinkingSummaryDelta(delta)
        if (delta && delta.name === 'web_search') {
            webSearchInfo = delta.extra?.web_search_info
        }
        if (!delta || !delta.content || (!isThinkingPhase(delta.phase) && delta.phase !== 'answer')) return

        const content = delta.content
        markFirstMeaningfulUpstreamDelta(latency, logger, { upstreamPhase: delta.phase || 'unknown' })
        if (delta.phase === 'answer') answerChars += content.length
        if (isThinkingPhase(delta.phase)) thinkingChars += content.length

        if (isThinkingPhase(delta.phase)) {
            if (strictModeEnabled) {
                heldThinkingContent += content
                return
            }
            // thinking_summary 阶段去重:Qwen 上游的 summary_thought.content 数组是累积的,
            // extractThinkingSummaryDelta 取 last element 作为本次内容。但连续事件可能
            // 携带相同的 last element,导致重复输出。跳过与上次相同的内容。
            if (delta.phase === 'thinking_summary') {
                if (content === lastThinkingSummaryContent) return
                lastThinkingSummaryContent = content
            }
            if (!thinkingStarted) {
                thinkingStarted = true
                if (webSearchInfo) {
                    const config = require('../../config/index.js')
                    try {
                        const searchTable = await accountManager.generateMarkdownTable(webSearchInfo, config.searchInfoMode)
                        emitThinkingDelta(searchTable + '\n\n')
                    } catch (_) {}
                }
            }
            emitThinkingDelta(content)
        } else if (delta.phase === 'answer') {
            if (hasTools && tParser) {
                toolCandidateBuffer += content
                const parsed = tParser.push(content)
                parserHold.sample(tParser.getBufferedSize?.() || 0)
                preambleHold.sample(tParser.getPreambleBufferedSize?.() || 0)
                if (parsed.textDelta && parsed.textDelta.trim()) {
                    emitTextDelta(parsed.textDelta)
                }
                if (parsed.completedCalls.length > 0) {
                    for (const call of parsed.completedCalls) emitToolUse(call)
                    emittedToolCallCount += parsed.completedCalls.length
                }
            } else {
                emitTextDelta(content)
            }
        }
    }

    const consumeRetryAnswer = async (retryUpstream) => {
        // retry 只读 answer phase 到独立 buffer，不直接写 res。
        // 这样 retry 失败或未解析出 tool_use 时，不会污染已经准备好的首轮文本。
        let retryAnswer = ''
        let retryPromptTokens = 0
        let retryCompletionTokens = 0
        await consumeUpstream(retryUpstream, async (json) => {
            if (json?.usage) {
                retryPromptTokens = json.usage.prompt_tokens || retryPromptTokens
                retryCompletionTokens = json.usage.completion_tokens || retryCompletionTokens
            }
            if (!json?.choices || json.choices.length === 0) return
            const delta = json.choices[0].delta
            if (!delta || !delta.content || delta.phase !== 'answer') return
            retryAnswer += delta.content
        }, null, {
            signal: clientAbort.signal,
            onFirstByte: (chunk) => {
                ctx?.req?.lifecycleRecorder?.record('first_upstream_byte')
                markFirstUpstreamByte(latency, logger, {
                    firstUpstreamChunkBytes: Buffer.byteLength(chunk || '')
                })
            },
        })
        return {
            answer: retryAnswer,
            promptTokens: retryPromptTokens,
            completionTokens: retryCompletionTokens
        }
    }

    let activeUpstream = upstream
    let bootstrapRetriesLeft = Math.max(0, Number(require('../../config/index.js').qwenStreamBootstrapRetries) || 0)
    while (true) {
        try {
            await consumeUpstream(activeUpstream, async (json) => {
                upstreamEvents += 1
                if (streamState.phase === 'connecting') {
                    streamState.phase = 'streaming'
                    ctx?.req?.lifecycleRecorder?.record('upstream_started')
                }
                markFirstUpstreamEvent(latency, logger, {
                    upstreamEvents
                })
                markFirstParsedEvent(latency, logger, { upstreamEvents })
                await onUpstreamDelta(json)
            }, (rawEvent) => {
                upstreamParseErrors += 1
                logAnomaly(logger, {
                    tag: 'ANTHROPIC',
                    protocol: 'anthropic',
                    route: '/v1/messages',
                    requestId,
                    profile: activeProfile?.profile?.name,
                    model,
                    stream: true,
                    stage: 'anthropic_stream_sse_parse',
                    classification: 'parser_error',
                    reason: 'upstream_sse_json_parse_error',
                    account: ctx.currentAccount?.email,
                    hasTools,
                    toolChoice,
                    messageStarted,
                    clientClosed,
                    upstreamEvents,
                    upstreamParseErrors,
                    answerChars,
                    thinkingChars,
                    errorMessage: rawEvent?.error?.message || rawEvent?.data,
                    rawDataPreview: typeof rawEvent?.raw === 'string' ? rawEvent.raw.slice(0, 500) : undefined
                })
            }, {
                signal: clientAbort.signal,
                isEndOfStreamTerminal: () => !tParser || !tParser.hasPendingCall(),
                onFirstByte: (chunk) => markFirstUpstreamByte(latency, logger, {
                    firstUpstreamChunkBytes: Buffer.byteLength(chunk || '')
                })
            })
            break
        } catch (upstreamErr) {
            logInterruption(logger, {
                tag: 'ANTHROPIC',
                protocol: 'anthropic',
                route: '/v1/messages',
                requestId,
                profile: activeProfile?.profile?.name,
                model,
                stream: true,
                stage: 'anthropic_stream_upstream',
                account: ctx.currentAccount?.email,
                hasTools,
                toolChoice,
                emittedClientDelta: hasVisibleStreamOutput,
                messageStarted,
                clientClosed,
                upstreamEvents,
                upstreamParseErrors,
                answerChars,
                thinkingChars,
                completionChars: toolCandidateBuffer.length,
                bootstrapRetriesLeft,
                canBootstrapRetry: !clientClosed && !hasVisibleStreamOutput && bootstrapRetriesLeft > 0,
                writableEnded: res.writableEnded,
                destroyed: res.destroyed
            }, upstreamErr)
            logger.error('上游流读取错误', 'ANTHROPIC', '', upstreamErr)
            if (streamState.emittedAnyClientDelta) {
                logger.warn('[SSE] Cannot retry: content already emitted to client', 'SSE')
                streamState.phase = 'incomplete'
            }
            if (!clientClosed && !hasVisibleStreamOutput && bootstrapRetriesLeft > 0) {
                // 只允许在尚未输出 text/thinking/tool 语义内容时 bootstrap retry。
                // message_start 可保留且不重复，重试上游不会拼接两段语义输出。
                bootstrapRetriesLeft -= 1
                try {
                    logger.warning?.(`Anthropic 流式首个协议事件前上游断开，bootstrap 重试一次 (remaining=${bootstrapRetriesLeft})`, 'ANTHROPIC')
                    const retryResp = await sendChatRequest(requestBody, ctx.req || null, { account: ctx.currentAccount, reuseChatId: savedChatId })
                    if (retryResp.status && retryResp.response) {
                        activeUpstream = retryResp.response
                        ctx.currentAccount = retryResp.currentAccount || ctx.currentAccount
                        if (retryResp.chat_id) savedChatId = retryResp.chat_id
                        toolCandidateBuffer = ''
                        hasVisibleStreamOutput = false
                        emittedToolCallCount = 0
                        promptTokens = 0
                        completionTokens = 0
                        webSearchInfo = null
                        thinkingStarted = false
                        heldThinkingContent = ''
                        lastThinkingSummaryContent = ''
                        continue
                    }
                } catch (retryErr) {
                    logger.error('Anthropic 流式 bootstrap 重试失败', 'ANTHROPIC', '', retryErr)
                }
            }
            streamState.phase = 'failed'
            if (!clientClosed) {
                try {
                    streamState.terminalSent = true
                    ensureMessageStart()
                    emitAnthropicErrorAndFinalize(
                        protocolRes,
                        upstreamErr.message || 'Upstream stream error',
                        sseState,
                        'api_error'
                    )
                } catch (_) {}
            }
            stopHeartbeat()
            await streamWriter.end()
            logger.debug(`[SSE] Stream complete: phase=${streamState.phase} bytes=${streamState.contentBytesSent} chunks=${streamState.contentChunksSent} reasoning=${streamState.reasoningChunksSent} toolCalls=${streamState.toolCallsParsed}`, 'SSE')
            releaseLease()
            return
        }
    }

    if (clientClosed) {
        stopHeartbeat()
        logger.debug(`[SSE] Stream complete: phase=${streamState.phase} bytes=${streamState.contentBytesSent} chunks=${streamState.contentChunksSent} reasoning=${streamState.reasoningChunksSent} toolCalls=${streamState.toolCallsParsed}`, 'SSE')
        releaseLease()
        return
    }

    // Flush tParser：输出流式期间 hold 住的剩余文本和工具调用
    if (tParser) {
        const flushed = tParser.flush()
        parserHold.sample(tParser.getBufferedSize?.() || 0)
        preambleHold.sample(tParser.getPreambleBufferedSize?.() || 0)
        if (flushed.textDelta && flushed.textDelta.trim()) {
            emitTextDelta(flushed.textDelta)
        }
        if (flushed.completedCalls.length > 0) {
            for (const call of flushed.completedCalls) emitToolUse(call)
            emittedToolCallCount += flushed.completedCalls.length
        }
    }

    let parsedToolCandidate = hasTools
        ? extractToolCallsFromBuffer(toolCandidateBuffer, toolNames, { strictToolUse })
        : { toolCalls: [], cleanedText: toolCandidateBuffer }
    let toolCallsFromRetry = false

    if (strictModeEnabled && emittedToolCallCount === 0) {
        const strictResult = await resolveToolCallsWithStrictMode({
            rawAnswer: toolCandidateBuffer,
            requestBody,
            toolNames,
            rawTools,
            rawMessages,
            currentAccount: ctx.currentAccount,
            consumeRetryAnswer,
            maxRetries: profileMaxRetry,
            requestId
        })
        ctx.currentAccount = strictResult.currentAccount || ctx.currentAccount
        parsedToolCandidate = strictResult.parsed
        toolCandidateBuffer = strictResult.rawAnswer || toolCandidateBuffer
        toolCallsFromRetry = !!(strictResult.retryUsed || strictResult.fallbackUsed)
        strictRetryUsed = !!strictResult.retryUsed
        strictFallbackUsed = !!strictResult.fallbackUsed
        strictBlocked = !!strictResult.blocked
        strictDecisionKind = strictResult.decision?.kind || ''
        strictRetryPromptTokens = Number(strictResult.retryPromptTokens) || 0
        strictRetryCompletionTokens = Number(strictResult.retryCompletionTokens) || 0
        promptTokens += strictRetryPromptTokens
        completionTokens += strictRetryCompletionTokens
    } else {

        // 1) required 重试: 显式 tool_choice=any / 指定 tool_name 但模型未触发。
        // 必须等首轮 toolCandidateBuffer 解析完成后再判断；首轮已有有效 tool_use 时不 retry。
        // retry 只在尚未向客户端输出可见文本时进行，避免不可回滚的流式混合输出。
        // Required tool_choice gets one forced retry independent of the generic
        // correction budget because the client explicitly demanded a tool call.
        if (hasTools && parsedToolCandidate.toolCalls.length === 0 && toolChoice !== 'none' && requiresToolCall(toolChoice) && !hasVisibleStreamOutput) {
            const retryBody = appendRetryHint(requestBody, buildRequiredRetryHint(toolChoice, 0, { provider: 'qwen', tools: rawTools }))
            logger.warning?.('Anthropic 流式: tool_choice=required 首次未触发，重试一次', 'ANTHROPIC')
            try {
                const retryResp = await sendChatRequest(retryBody, null, { account: ctx.currentAccount })
                if (retryResp.status && retryResp.response) {
                    const retryResult = await consumeRetryAnswer(retryResp.response)
                    const parsedRetry = extractToolCallsFromBuffer(retryResult.answer, toolNames, { strictToolUse })
                    if (parsedRetry.toolCalls.length > 0) {
                        toolCandidateBuffer = retryResult.answer
                        parsedToolCandidate = parsedRetry
                        toolCallsFromRetry = true
                        promptTokens = retryResult.promptTokens || promptTokens
                        completionTokens = retryResult.completionTokens || completionTokens
                    }
                }
            } catch (e) {
                logger.error('Anthropic 流式重试失败', 'ANTHROPIC', '', e)
            }
        }

        // Generic profile retry: only retry intent-like, empty, or unavailable-tool
        // outputs. Clearly final reports are allowed to end normally.
        const firstAnswerForIntent = toolCandidateBuffer
        const looksLikeIntent = looksLikeIntendsToCallTool(firstAnswerForIntent)
        const emptyAnswer = isTextEssentiallyEmpty(firstAnswerForIntent)
        const looksLikeUnknownTool = looksLikeToolCallAttempt(firstAnswerForIntent)
        const looksLikeFinal = looksLikeFinalReport(firstAnswerForIntent)
        const canRetry = ctx.retryCount < profileMaxRetry
        // Final reports skip retry and go straight to flush.
        const shouldGenericRetry = hasTools
            && parsedToolCandidate.toolCalls.length === 0
            && toolChoice !== 'none'
            && !requiresToolCall(toolChoice)
            && canRetry
            && !hasVisibleStreamOutput
            && !looksLikeFinal
            && (looksLikeIntent || emptyAnswer || looksLikeUnknownTool)
        if (shouldGenericRetry) {
            ctx.retryCount = (ctx.retryCount || 0) + 1
            // Choose the correction hint based on the observed failure mode.
            const hint = looksLikeUnknownTool
                ? buildUnknownToolCallHint(firstAnswerForIntent, toolNames)
                : buildGenericNoToolCallHint({ provider: 'qwen', tools: rawTools })
            logger.warning?.(`Anthropic 流式: 通用纠偏重试一次 (${looksLikeUnknownTool ? 'unknown-tool' : 'intent-only'})`, 'ANTHROPIC')
            const retryBody = appendRetryHint(requestBody, hint)
            try {
                const retryResp = await sendChatRequest(retryBody, null, { account: ctx.currentAccount })
                if (retryResp.status && retryResp.response) {
                    const retryResult = await consumeRetryAnswer(retryResp.response)
                    const parsedRetry = extractToolCallsFromBuffer(retryResult.answer, toolNames, { strictToolUse })
                    if (parsedRetry.toolCalls.length > 0) {
                        toolCandidateBuffer = retryResult.answer
                        parsedToolCandidate = parsedRetry
                        toolCallsFromRetry = true
                        promptTokens = retryResult.promptTokens || promptTokens
                        completionTokens = retryResult.completionTokens || completionTokens
                    }
                }
            } catch (e) {
                logger.error('Anthropic 流式通用纠偏重试失败', 'ANTHROPIC', '', e)
            }
        }
    }

    // Flush: 统一解析兜底工具调用（tParser 已实时输出文本，此处只处理工具调用）
    if (hasTools && emittedToolCallCount === 0) {
        const { toolCalls } = parsedToolCandidate
        if (toolCalls.length > 0) {
            for (const call of toolCalls) emitToolUse(call)
            emittedToolCallCount = toolCalls.length
        }
        // 模型没输出工具调用就如实返回，反代层不构造 fallback
    }

    closeThinkingBlockIfOpen()
    closeTextBlockIfOpen()

    // Claude Code expects stop_reason=tool_use whenever a tool block is emitted.
    const stopReason = emittedToolCallCount > 0
        ? (requireToolUseStopReason ? 'tool_use' : 'end_turn')
        : 'end_turn'

    if (upstreamEvents === 0 || (hasTools && emittedToolCallCount === 0 && isTextEssentiallyEmpty(parsedToolCandidate.cleanedText || ''))) {
        logAnomaly(logger, {
            tag: 'ANTHROPIC',
            protocol: 'anthropic',
            route: '/v1/messages',
            requestId,
            profile: activeProfile?.profile?.name,
            model,
            stream: true,
            stage: 'anthropic_stream_finish',
            reason: upstreamEvents === 0 ? 'upstream_finished_without_events' : 'tool_workflow_finished_without_tool_or_text',
            account: ctx.currentAccount?.email,
            hasTools,
            toolChoice,
            emittedClientDelta: hasVisibleStreamOutput,
            messageStarted,
            clientClosed,
            upstreamEvents,
            upstreamParseErrors,
            answerChars,
            thinkingChars,
            completionChars: toolCandidateBuffer.length,
            toolCalls: emittedToolCallCount,
            retryUsed: strictRetryUsed,
            fallbackUsed: strictFallbackUsed,
            stopReason,
            usageSource
        })
    }

    if (promptTokens === 0 && completionTokens === 0) {
        const usage = createUsageObject(requestBody?.messages || '', toolCandidateBuffer, null)
        promptTokens = usage.prompt_tokens || 0
        completionTokens = usage.completion_tokens || 0
        usageSource = 'estimated'
    }

    // Attribute the request to the final account selected for this upstream call.
    attributeChatUsage(ctx.currentAccount, promptTokens, completionTokens, {
        usageSource,
        requests: 1,
        blocked: strictBlocked,
        retryPromptTokens: strictRetryPromptTokens,
        retryCompletionTokens: strictRetryCompletionTokens,
        provider: 'qwen',
        model: model || ''
    })

    if (strictModeEnabled) {
        logger.debug(
            `[anthropic strict] requestId=${requestId || '-'} profile=${activeProfile?.profile?.name || '-'} ` +
            `hasTools=${hasTools} classification=${strictDecisionKind || '-'} retryUsed=${strictRetryUsed} ` +
            `fallbackUsed=${strictFallbackUsed} blocked=${strictBlocked} stopReason=${stopReason} ` +
            `account=${ctx.currentAccount?.email || '-'} upstreamCloseKind=completed usageSource=${usageSource}`,
            'ANTHROPIC'
        )
    }

    ensureMessageStart()
    if (!streamState.terminalSent) {
        streamState.terminalSent = true
        streamState.phase = 'terminal'
        finalizeAnthropicStream(protocolRes, sseState, {
            stopReason,
            inputTokens: promptTokens,
            outputTokens: completionTokens
        })
    }
    stopHeartbeat()
    res.off('close', onClose)
    await streamWriter.end()
    parserHold.flush()
    preambleHold.flush()
    finalizeLatency(logger, latency, {
        finalUpstreamEventCount: upstreamEvents,
        finalParseErrorCount: upstreamParseErrors,
        writerDrainWaitMs: streamWriter.drainWaitMs,
        answerChars,
        thinkingChars,
        emittedToolCalls: emittedToolCallCount
    })
    releaseLease()
    streamState.phase = 'released'
    logger.debug(`[SSE] Stream complete: phase=${streamState.phase} bytes=${streamState.contentBytesSent} chunks=${streamState.contentChunksSent} reasoning=${streamState.reasoningChunksSent} toolCalls=${streamState.toolCallsParsed}`, 'SSE')
}

module.exports = {
    handleAnthropicStream,
}
