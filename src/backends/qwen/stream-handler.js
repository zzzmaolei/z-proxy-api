/**
 * Qwen OpenAI 协议流式响应处理器
 *
 * 从 src/controllers/chat.js 提取，独立为可复用的流式处理模块。
 *
 * 与 DeepSeek 的 backends/<provider>/stream-handler.js 对齐：
 *   - 处理器职责：消费上游 SSE → 解析工具调用 → 按 OpenAI chat.completion.chunk 写出
 *   - 编排层（controllers/chat.js）只负责参数解析、账号轮换、分发
 *
 * 与 DeepSeek stream-handler 的差异：
 *   - 上游是 Qwen Web SSE（phase=think/answer + extra.image_list），非 DeepSeek fragment 流
 *   - 工具解析走 createToolCallStreamParser（与 DeepSeek 共用 utils/tool-prompt）
 *   - 心跳/错误信封走 backends/qwen/stream-utils.js（OpenAI 风格），非 backends/stream-utils.js
 *
 * @param {object} ctx - 处理上下文（单参 ctx，与 DeepSeek backends 对齐）
 * @param {object} ctx.res - Express 响应对象
 * @param {object} ctx.response - 上游 axios stream 响应
 * @param {boolean} ctx.enable_thinking - 是否启用思考模式
 * @param {boolean} ctx.enable_web_search - 是否启用网络搜索
 * @param {object} ctx.requestBody - 原始请求体，用于提取 prompt 信息与重试
 * @param {boolean} [ctx.has_tools] - 是否启用工具调用解析
 * @param {string|Object} [ctx.tool_choice] - OpenAI tool_choice
 * @param {object} [ctx.currentAccount] - 当前账号（用于统计 + 重试复用）
 * @param {object} [ctx.req] - Express 请求（用于 sendChatRequest 重试）
 * @param {object} [ctx.clientProfile] - 客户端 profile
 * @param {string} [ctx.requestId] - 请求 ID
 * @param {object} [ctx.latency] - 延迟追踪对象
 */
const { generateUUID } = require('../../utils/tools.js');
const { createUsageObject } = require('../../utils/precise-tokenizer.js');
const { sendChatRequest } = require('./request.js');
const {
    createToolCallStreamParser,
    parseLooseToolCallsFromText,
    appendHintToLastMessage,
    resolveToolName,
    sanitizeQwenErrorStrings
} = require('../../utils/tool-prompt.js');
const accountManager = require('../../utils/account.js');
const config = require('../../config/index.js');
const { logger } = require('../../utils/logger');
const SSEFrameParser = require('../../utils/sse-frame-parser');
const { attributeChatUsage } = require('../../utils/usage-tracker.js');
const { consumeUpstreamStream, isQwenTerminalEvent } = require('./upstream-consumer.js');
const { SafeSseWriter } = require('../../utils/safe-sse-writer.js');
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
const {
    startOpenAIHeartbeat,
    writeOpenAIStreamErrorAndDone,
    getImageMarkdownListFromDelta,
    isThinkingPhase,
    extractThinkingSummaryDelta,
    requiresToolCall,
    buildRequiredRetryHint,
} = require('./stream-utils');

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
 * 处理流式响应
 */
const handleStreamResponse = async (ctx) => {
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
    const { res, response, enable_thinking, enable_web_search, requestBody = null } = ctx;
    const options = ctx; // 兼容内部 options.xxx 引用，与 DeepSeek 单参 ctx 形态对齐
    // 保存首次请求的 chat_id，bootstrap retry 时复用，避免重复生成（池取/网络生成）
    let savedChatId = ctx.chat_id || null
    const stopHeartbeat = startOpenAIHeartbeat(res)
    const message_id = generateUUID()
    const responseMeta = {
        id: `chatcmpl-${message_id}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: options.model || requestBody?.model || ''
    }
    const streamWriter = new SafeSseWriter(res)
    const clientAbort = new AbortController()
    const onClientClose = () => {
        streamState.phase = 'aborted'
        clientAbort.abort()
        streamWriter.abort()
    }
    res.once('close', onClientClose)
    // 注意：emittedAnyClientDelta 必须在 try 块外声明，因为 finally 块也需要访问
    let emittedAnyClientDelta = false
    try {
        streamWriter.write(`data: ${JSON.stringify({
            ...responseMeta,
            choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
        })}\n\n`)
        streamState.phase = 'connecting'
        let web_search_info = null
        let thinking_start = false
        let thinking_end = false
        let emittedImageMarkdownSet = new Set()
        let pendingImageMarkdownList = []

        const hasTools = !!options.has_tools
        const toolChoice = options.tool_choice
        const rawToolsSource = options.req?.originalBody?.tools || requestBody?.tools || []
        const toolNames = new Set(rawToolsSource
            .map(t => (t && (t.name || t.function?.name)) || '')
            .filter(Boolean))
        const createBoundToolParser = () => hasTools
            ? createToolCallStreamParser({ toolNames })
            : null
        let toolParser = createBoundToolParser()
        let emittedAnyToolCall = false
        let upstreamEvents = 0
        let upstreamParseErrors = 0
        let answerChars = 0
        const requestId = options.requestId || message_id
        const latency = options.latency || options.req?.chatLatency || null
        setLatencyFields(latency, { requestId })
        markFirstDownstreamWrite(latency, logger, { downstreamKind: 'role' })
        markFirstProtocolWrite(latency, logger, { downstreamKind: 'role' })
        const parserHold = createLatencyHoldObserver(latency, 'parser')

        // Token消耗量统计
        let totalTokens = {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0
        }
        let completionContent = '' // 收集完整的回复内容用于token估算

        // 提取prompt文本用于token估算
        let promptText = ''
        if (requestBody && requestBody.messages) {
            promptText = requestBody.messages.map(msg => {
                if (typeof msg.content === 'string') {
                    return msg.content
                } else if (Array.isArray(msg.content)) {
                    return msg.content.map(item => item.text || '').join('')
                }
                return ''
            }).join('\n')
        }

        /**
         * 写一个标准 OpenAI 文本增量
         */
        const writeContentDelta = (text) => {
            if (!text) return
            text = sanitizeQwenErrorStrings(text);
            if (!text) return;  // 全部是 Qwen 错误字符串，跳过
            if (!emittedAnyClientDelta) ctx?.req?.lifecycleRecorder?.record('first_downstream_delta')
            markFirstDownstreamWrite(latency, logger, {
                downstreamKind: 'content'
            })
            markFirstSemanticWrite(latency, logger, 'content')
            emittedAnyClientDelta = true
            streamState.emittedAnyClientDelta = true
            streamState.contentBytesSent += text.length
            streamState.contentChunksSent++
            streamWriter.write(`data: ${JSON.stringify({
                ...responseMeta,
                "choices": [
                    {
                        "index": 0,
                        "delta": { "content": text },
                        "finish_reason": null
                    }
                ]
            })}\n\n`)
        }

        /**
         * 写一个 reasoning_content 增量（OpenAI 标准思考字段）
         */
        const writeReasoningDelta = (text) => {
            if (!text) return
            if (!emittedAnyClientDelta) ctx?.req?.lifecycleRecorder?.record('first_downstream_delta')
            markFirstDownstreamWrite(latency, logger, {
                downstreamKind: 'reasoning'
            })
            markFirstSemanticWrite(latency, logger, 'reasoning')
            emittedAnyClientDelta = true
            streamState.emittedAnyClientDelta = true
            streamState.reasoningChunksSent++
            streamWriter.write(`data: ${JSON.stringify({
                ...responseMeta,
                "choices": [
                    {
                        "index": 0,
                        "delta": { "reasoning_content": text },
                        "finish_reason": null
                    }
                ]
            })}\n\n`)
        }

        /**
         * 写一个工具调用增量，按 OpenAI 规范分片：
         *   1) 头块：包含 index/id/type 与 function.name + 空 arguments
         *   2) 多个参数块：function.arguments 切片
         */
        const writeToolCallsDelta = (calls) => {
            if (!calls || calls.length === 0) return
            const normalizedCalls = toolNames.size > 0
                ? calls.map(call => {
                    const resolved = resolveToolName(call?.function?.name, toolNames)
                    if (!resolved) return null
                    return { ...call, function: { ...call.function, name: resolved } }
                }).filter(Boolean)
                : []
            if (normalizedCalls.length === 0) {
                logger.warning?.(
                    `忽略未在 harness tools 中注册的工具调用: ${calls.map(call => call?.function?.name || '?').join(', ')}`,
                    'TOOL'
                )
                return
            }
            markFirstDownstreamWrite(latency, logger, {
                downstreamKind: 'tool_calls'
            })
            markFirstSemanticWrite(latency, logger, 'tool_calls')
            if (!emittedAnyClientDelta) ctx?.req?.lifecycleRecorder?.record('first_downstream_delta')
            emittedAnyToolCall = true
            emittedAnyClientDelta = true
            streamState.emittedAnyClientDelta = true
            streamState.toolCallsParsed += normalizedCalls.length
            const ARG_CHUNK_SIZE = 32

            for (const call of normalizedCalls) {
                const headerDelta = {
                    ...responseMeta,
                    "choices": [
                        {
                            "index": 0,
                            "delta": {
                                "tool_calls": [
                                    {
                                        "index": call.index,
                                        "id": call.id,
                                        "type": "function",
                                        "function": {
                                            "name": call.function.name,
                                            "arguments": ""
                                        }
                                    }
                                ]
                            },
                            "finish_reason": null
                        }
                    ]
                }
                streamWriter.write(`data: ${JSON.stringify(headerDelta)}\n\n`)

                const argsString = call.function.arguments || ''
                for (let offset = 0; offset < argsString.length; offset += ARG_CHUNK_SIZE) {
                    const piece = argsString.slice(offset, offset + ARG_CHUNK_SIZE)
                    const argDelta = {
                        ...responseMeta,
                        "choices": [
                            {
                                "index": 0,
                                "delta": {
                                    "tool_calls": [
                                        {
                                            "index": call.index,
                                            "function": { "arguments": piece }
                                        }
                                    ]
                                },
                                "finish_reason": null
                            }
                        ]
                    }
                    streamWriter.write(`data: ${JSON.stringify(argDelta)}\n\n`)
                }
            }
        }

        /**
         * 处理一个上游 SSE delta JSON（已由 consumeUpstreamStream 解析过）
         */
        const processSSEPayload = async (decodeJson, activeToolParser = toolParser) => {
            // 处理上游错误事件（新 Responses API 格式）
            if (decodeJson && decodeJson.error) {
                const errMsg = decodeJson.error.details || decodeJson.error.message || decodeJson.error.code || 'unknown'
                logger.error(`[UPSTREAM-ERROR] Qwen 上游返回错误: code=${decodeJson.error.code} details=${errMsg} raw=${JSON.stringify(decodeJson.error).slice(0, 500)}`, 'CHAT')
                // 将错误写入客户端流
                try {
                    writeOpenAIStreamErrorAndDone(res, new Error(`Upstream error: ${errMsg}`), {
                        code: 'upstream_error',
                        message: errMsg,
                        upstreamCode: decodeJson.error.code,
                    })
                } catch (_) { /* ignore */ }
                return
            }

            // 处理 response.created 事件（新 Responses API 格式）
            if (decodeJson && decodeJson['response.created']) {
                // 这是新格式的响应开始事件，与旧格式的 choices[0].delta.role 等价
                // 发送一个空的 role chunk 作为 stream 开始标记
                if (!streamState.emittedAnyClientDelta) {
                    streamWriter.write(`data: ${JSON.stringify({
                        ...responseMeta,
                        choices: [{
                            index: 0,
                            delta: { role: 'assistant', content: '' },
                            finish_reason: null
                        }]
                    })}\n\n`)
                    streamState.emittedAnyClientDelta = true
                    emittedAnyClientDelta = true
                    ctx?.req?.lifecycleRecorder?.record('first_downstream_delta')
                }
                return
            }

            // 处理 response.completed 事件（新 Responses API 终端事件）
            if (decodeJson && decodeJson['response.completed']) {
                const completed = decodeJson['response.completed']
                // 提取 usage 信息（可能嵌套在 response 对象中）
                if (completed?.response?.usage) {
                    const u = completed.response.usage
                    totalTokens = {
                        prompt_tokens: u.input_tokens || totalTokens.prompt_tokens,
                        completion_tokens: u.output_tokens || totalTokens.completion_tokens,
                        total_tokens: u.total_tokens || totalTokens.total_tokens
                    }
                } else if (completed?.usage) {
                    const u = completed.usage
                    totalTokens = {
                        prompt_tokens: u.input_tokens || totalTokens.prompt_tokens,
                        completion_tokens: u.output_tokens || totalTokens.completion_tokens,
                        total_tokens: u.total_tokens || totalTokens.total_tokens
                    }
                }
                return
            }

            if (decodeJson === null || !decodeJson.choices || decodeJson.choices.length === 0) {
                return
            }

            if (decodeJson.usage) {
                totalTokens = {
                    prompt_tokens: decodeJson.usage.prompt_tokens || totalTokens.prompt_tokens,
                    completion_tokens: decodeJson.usage.completion_tokens || totalTokens.completion_tokens,
                    total_tokens: decodeJson.usage.total_tokens || totalTokens.total_tokens
                }
            }

            const delta = decodeJson.choices[0].delta

            // thinking_summary 事件：从 extra.summary_thought.content 提取 thinking 增量
            // （content 字段为空，真实文本在累积数组里，只取最后一个元素作为本次增量）
            extractThinkingSummaryDelta(delta)

            if (delta && delta.name === 'web_search') {
                web_search_info = delta.extra?.web_search_info
            }

            const imageMarkdownList = getImageMarkdownListFromDelta(delta)
            if (imageMarkdownList.length > 0) {
                const newImageMarkdownList = imageMarkdownList.filter(item => !emittedImageMarkdownSet.has(item))

                if (thinking_start && !thinking_end) {
                    const pendingSet = new Set(pendingImageMarkdownList)
                    for (const url of newImageMarkdownList) {
                        if (!pendingSet.has(url)) {
                            pendingImageMarkdownList.push(url)
                            pendingSet.add(url)
                        }
                    }
                } else if (newImageMarkdownList.length > 0) {
                    const imageContent = `${newImageMarkdownList.join('\n\n')}\n\n`
                    completionContent += imageContent
                    newImageMarkdownList.forEach(item => emittedImageMarkdownSet.add(item))
                    writeContentDelta(imageContent)
                }
            }

            if (!delta || !delta.content) {
                return
            }

            let content = delta.content
            markFirstMeaningfulUpstreamDelta(latency, logger, { upstreamPhase: delta.phase || 'unknown' })
            completionContent += content
            if (delta.phase === 'answer') {
                answerChars += content.length
            }

            if (isThinkingPhase(delta.phase)) {
                thinking_start = true
                if (web_search_info) {
                    const table = await accountManager.generateMarkdownTable(web_search_info, config.searchInfoMode)
                    writeReasoningDelta(`${table}

${content}`)
                } else {
                    writeReasoningDelta(content)
                }
                // 注意：completionContent 已在上方无条件累加，此处不可重复累加
                return
            }
            if (delta.phase === 'answer' && !thinking_end && thinking_start) {
                thinking_end = true
                if (pendingImageMarkdownList.length > 0) {
                    const pendingImageContent = `${pendingImageMarkdownList.join('\n\n')}\n\n`
                    content = `${pendingImageContent}${content}`
                    completionContent += pendingImageContent
                    pendingImageMarkdownList.forEach(item => emittedImageMarkdownSet.add(item))
                    pendingImageMarkdownList = []
                }
                // thinking 内容已通过 reasoning_content 单独输出，不再向 content 注入 </think> 闭合标签
            }

            if (activeToolParser && delta.phase === 'answer') {
                const parsed = activeToolParser.push(content)
                parserHold.sample(activeToolParser.getBufferedSize?.() || 0)
                if (parsed.textDelta) writeContentDelta(parsed.textDelta)
                if (parsed.completedCalls.length > 0) writeToolCallsDelta(parsed.completedCalls)
            } else {
                writeContentDelta(content)
            }
        }

        /**
         * Pipe one upstream response through the shared SSE consumer.
         */
        const pipeUpstream = (upstreamResponse, activeToolParser = toolParser) => consumeUpstreamStream({
            upstream: upstreamResponse,
            parser: new SSEFrameParser(),
            logger,
            signal: clientAbort.signal,
            isTerminalEvent: isQwenTerminalEvent,
            isEndOfStreamTerminal: () => upstreamEvents > 0
                && (!activeToolParser || !activeToolParser.hasPendingCall()),
            onFirstByte: (chunk) => {
                // upstream_started 必须在 first_upstream_byte 之前记录，
                // 否则 deriveMetrics 中的 upstream_ttfb_ms 会计算出负值
                if (streamState.phase === 'connecting') {
                    streamState.phase = 'streaming'
                    ctx?.req?.lifecycleRecorder?.record('upstream_started')
                }
                ctx?.req?.lifecycleRecorder?.record('first_upstream_byte')
                markFirstUpstreamByte(latency, logger, {
                    firstUpstreamChunkBytes: Buffer.byteLength(chunk || '')
                })
            },
            onEvent: async (decodeJson) => {
                upstreamEvents += 1
                markFirstUpstreamEvent(latency, logger, {
                    upstreamEvents
                })
                markFirstParsedEvent(latency, logger, { upstreamEvents })
                try {
                    await processSSEPayload(decodeJson, activeToolParser)
                } catch (error) {
                    logger.error('流式数据处理错误', 'CHAT', '', error)
                }
            },
            onError: (rawEvent) => {
                upstreamParseErrors += 1
                logAnomaly(logger, {
                    tag: 'CHAT',
                    protocol: 'openai',
                    route: '/v1/chat/completions',
                    requestId,
                    profile: options.clientProfile?.profile?.name,
                    model: requestBody?.model,
                    stream: true,
                    stage: 'openai_stream_sse_parse',
                    classification: 'parser_error',
                    reason: 'upstream_sse_json_parse_error',
                    account: options.currentAccount?.email,
                    hasTools,
                    toolChoice,
                    emittedClientDelta: emittedAnyClientDelta,
                    upstreamEvents,
                    upstreamParseErrors,
                    answerChars,
                    errorMessage: rawEvent?.error?.message || rawEvent?.data,
                    rawDataPreview: typeof rawEvent?.raw === 'string' ? rawEvent.raw.slice(0, 500) : undefined
                })
            }
        })

        const flushToolParser = (activeToolParser) => {
            if (!activeToolParser) return
            const tail = activeToolParser.flush()
            parserHold.sample(activeToolParser.getBufferedSize?.() || 0)
            if (tail.textDelta) writeContentDelta(tail.textDelta)
            if (tail.completedCalls.length > 0) writeToolCallsDelta(tail.completedCalls)
        }

        const resetBootstrapState = () => {
            web_search_info = null
            thinking_start = false
            thinking_end = false
            emittedImageMarkdownSet = new Set()
            pendingImageMarkdownList = []
            emittedAnyToolCall = false
            emittedAnyClientDelta = false
            streamState.emittedAnyClientDelta = false
            streamState.contentBytesSent = 0
            streamState.contentChunksSent = 0
            streamState.toolCallsParsed = 0
            streamState.reasoningChunksSent = 0
            totalTokens = {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0
            }
            completionContent = ''
            toolParser = createBoundToolParser()
        }

        let activeResponse = response
        let bootstrapRetriesLeft = Math.max(0, Number(config.qwenStreamBootstrapRetries) || 0)
        while (true) {
            try {
                await pipeUpstream(activeResponse, toolParser)
                break
            } catch (streamError) {
                logInterruption(logger, {
                    tag: 'CHAT',
                    protocol: 'openai',
                    route: '/v1/chat/completions',
                    requestId,
                    profile: options.clientProfile?.profile?.name,
                    model: requestBody?.model,
                    stream: true,
                    stage: 'openai_stream_upstream',
                    account: options.currentAccount?.email,
                    hasTools,
                    toolChoice,
                    emittedClientDelta: emittedAnyClientDelta,
                    upstreamEvents,
                    upstreamParseErrors,
                    answerChars,
                    completionChars: completionContent.length,
                    emittedToolCalls: emittedAnyToolCall ? 1 : 0,
                    bootstrapRetriesLeft,
                    canBootstrapRetry: !emittedAnyClientDelta && !res.writableEnded && !res.destroyed && bootstrapRetriesLeft > 0,
                    writableEnded: res.writableEnded,
                    destroyed: res.destroyed
                }, streamError)
                if (streamState.emittedAnyClientDelta) {
                    logger.warn('[SSE] Cannot retry: content already emitted to client', 'SSE')
                    streamState.phase = 'incomplete'
                    throw streamError
                }
                if (!emittedAnyClientDelta && !res.writableEnded && !res.destroyed && bootstrapRetriesLeft > 0) {
                    bootstrapRetriesLeft -= 1
                    logger.warning?.(`OpenAI stream 上游在首个输出前断开，bootstrap 重试一次 (remaining=${bootstrapRetriesLeft})`, 'CHAT')
                    try {
                        const retryResp = await sendChatRequest(requestBody, options.req || null, { account: options.currentAccount, reuseChatId: savedChatId })
                        if (retryResp.status && retryResp.response) {
                            options.currentAccount = retryResp.currentAccount || options.currentAccount
                            if (retryResp.chat_id) savedChatId = retryResp.chat_id
                            activeResponse = retryResp.response
                            resetBootstrapState()
                            continue
                        }
                    } catch (retryError) {
                        logger.error('OpenAI stream bootstrap 重试失败', 'CHAT', '', retryError)
                    }
                }
                throw streamError
            }
        }

        // Match the known-good OpenAI bridge: run required-tool correction
        // before flushing the parser tail. If Qwen only produced narration,
        // flushing first turns that narration into client-visible content and
        // makes tool clients fail before they ever receive a tool_calls delta.
        if (hasTools && toolParser && !emittedAnyToolCall && requiresToolCall(toolChoice)) {
            const retryHint = buildRequiredRetryHint(toolChoice, 0, { provider: 'qwen', tools: options.req?.originalBody?.tools || [] })
            const retryBody = appendHintToLastMessage(requestBody, retryHint)
            logger.warning?.('tool_choice=required 首次未触发工具调用，进行一次重试', 'CHAT')
            try {
                const retryResp = await sendChatRequest(retryBody, options.req || null, { account: options.currentAccount })
                if (retryResp.status && retryResp.response) {
                    options.currentAccount = retryResp.currentAccount || options.currentAccount
                    // 重试前重建 toolParser，避免复用上一轮未重置的解析状态（已发出的 tool_call、未闭合标签等）
                    toolParser = createBoundToolParser()
                    await pipeUpstream(retryResp.response, toolParser)
                }
            } catch (e) {
                logger.error('required 模式重试失败', 'CHAT', '', e)
            }
        }
        flushToolParser(toolParser)

        // tool_call 补救 reparse：流式解析器未识别到工具调用时，用宽松解析器再试一次
        if (hasTools && !emittedAnyToolCall && completionContent) {
            // 中间件替换了 req.body（内部 Qwen body 不含 tools），从 originalBody 取原始 tools
            const reparseTools = rawToolsSource
                .map(t => ({ name: (t && (t.name || t.function?.name)) || '' }))
                .filter(t => t.name)
            const reparse = parseLooseToolCallsFromText(completionContent, reparseTools)
            if (reparse.toolCalls.length > 0) {
                writeToolCallsDelta(reparse.toolCalls)
                emittedAnyToolCall = true
                emittedAnyClientDelta = true
            }
        }

        // 处理最终的搜索信息
        if ((config.outThink === false || !enable_thinking) && web_search_info && config.searchInfoMode === "text") {
            const webSearchTable = await accountManager.generateMarkdownTable(web_search_info, "text")
            writeContentDelta(`\n\n---\n${webSearchTable}`)
        }

        // 计算最终的token使用量
        if (totalTokens.prompt_tokens === 0 && totalTokens.completion_tokens === 0) {
            totalTokens = createUsageObject(requestBody?.messages || promptText, completionContent, null)
            logger.debug(`流式使用tiktoken计算 - Prompt: ${totalTokens.prompt_tokens}, Completion: ${totalTokens.completion_tokens}, Total: ${totalTokens.total_tokens}`, 'CHAT')
        } else {
            logger.debug(`流式使用上游真实Token - Prompt: ${totalTokens.prompt_tokens}, Completion: ${totalTokens.completion_tokens}, Total: ${totalTokens.total_tokens}`, 'CHAT')
        }

        totalTokens.prompt_tokens = Math.max(0, totalTokens.prompt_tokens || 0)
        totalTokens.completion_tokens = Math.max(0, totalTokens.completion_tokens || 0)
        totalTokens.total_tokens = totalTokens.prompt_tokens + totalTokens.completion_tokens

        // Daily stats 累计——一次性归属到主请求账户。
        attributeChatUsage(options.currentAccount, totalTokens, undefined, {
            provider: 'qwen',
            model: options.model || requestBody?.model || ''
        })

        const finishReason = emittedAnyToolCall ? 'tool_calls' : 'stop'
        if (upstreamEvents === 0 || (!completionContent && !emittedAnyToolCall)) {
            logAnomaly(logger, {
                tag: 'CHAT',
                protocol: 'openai',
                route: '/v1/chat/completions',
                requestId,
                profile: options.clientProfile?.profile?.name,
                model: requestBody?.model,
                stream: true,
                stage: 'openai_stream_finish',
                reason: upstreamEvents === 0 ? 'upstream_finished_without_events' : 'upstream_finished_without_answer_content',
                account: options.currentAccount?.email,
                hasTools,
                toolChoice,
                emittedClientDelta: emittedAnyClientDelta,
                upstreamEvents,
                upstreamParseErrors,
                answerChars,
                completionChars: completionContent.length,
                emittedToolCalls: emittedAnyToolCall ? 1 : 0,
                stopReason: finishReason
            })
        }
        if (hasTools && requiresToolCall(toolChoice) && !emittedAnyToolCall) {
            logAnomaly(logger, {
                tag: 'CHAT',
                protocol: 'openai',
                route: '/v1/chat/completions',
                requestId,
                profile: options.clientProfile?.profile?.name,
                model: requestBody?.model,
                stream: true,
                stage: 'openai_stream_finish',
                reason: 'required_tool_call_missing_after_retries',
                requiredToolMissing: true,
                account: options.currentAccount?.email,
                hasTools,
                toolChoice,
                emittedClientDelta: emittedAnyClientDelta,
                upstreamEvents,
                upstreamParseErrors,
                answerChars,
                completionChars: completionContent.length,
                emittedToolCalls: emittedAnyToolCall ? 1 : 0,
                stopReason: finishReason
            })
        }
        if (streamState.terminalSent) {
            return
        }
        streamState.terminalSent = true
        streamState.phase = 'terminal'
        ctx?.req?.lifecycleRecorder?.record('stream_terminal')
        streamWriter.write(`data: ${JSON.stringify({
            ...responseMeta,
            "choices": [
                {
                    "index": 0,
                    "delta": {},
                    "finish_reason": finishReason
                }
            ]
        })}\n\n`)

        if (options.req?.originalBody?.stream_options?.include_usage === true) {
            streamWriter.write(`data: ${JSON.stringify({
                ...responseMeta,
                "choices": [],
                "usage": totalTokens
            })}\n\n`)
        }

        streamWriter.write(`data: [DONE]\n\n`)
        logger.warn(`[SSE-DONE] 流式传输完成: upstreamEvents=${upstreamEvents} contentChars=${completionContent.length} reasoningChunks=${streamState.reasoningChunksSent} toolCalls=${streamState.toolCallsParsed} finishReason=${finishReason}`, 'SSE')
        await streamWriter.end()
        parserHold.flush()
        finalizeLatency(logger, latency, {
            finalUpstreamEventCount: upstreamEvents,
            finalParseErrorCount: upstreamParseErrors,
            writerDrainWaitMs: streamWriter.drainWaitMs,
            completionChars: completionContent.length,
            emittedToolCalls: emittedAnyToolCall ? 1 : 0
        })
    } catch (error) {
        streamState.phase = 'failed'
        logInterruption(logger, {
            tag: 'CHAT',
            protocol: 'openai',
            route: '/v1/chat/completions',
            requestId: options.requestId || message_id,
            profile: options.clientProfile?.profile?.name,
            model: requestBody?.model,
            stream: true,
            stage: 'openai_stream_handler',
            account: options.currentAccount?.email,
            hasTools: !!options.has_tools,
            toolChoice: options.tool_choice,
            writableEnded: res.writableEnded,
            destroyed: res.destroyed
        }, error)
        const isClientAbort = error?.code === 'CLIENT_ABORTED' || error?.classification === 'client_aborted'
        if (!isClientAbort) {
            logger.error('聊天处理错误', 'CHAT', '', error)
        }
        if (!res.writableEnded) {
            writeOpenAIStreamErrorAndDone(res, error, {
                code: 'chat_handler_error',
                messageId: message_id
            })
        }
    } finally {
        // 捕获释放前的最终状态，用于决定 outcome
        const finalPhase = streamState.phase
        streamState.phase = 'released'
        try {
            if (ctx && ctx.req && ctx.req.lease && typeof ctx.req.lease.release === 'function') {
                const outcome = mapStreamPhaseToOutcome(finalPhase, streamState.terminalSent, streamState.emittedAnyClientDelta)
                ctx.req.lease.release(outcome)
                ctx.req.lifecycleRecorder?.record('lease_released')
            }
        } catch (_e) { /* 幂等，忽略 */ }
        // 将 emittedAnyClientDelta 写回 req，供 request.js 的重试/错误判断使用
        if (ctx?.req) ctx.req.emittedAnyClientDelta = emittedAnyClientDelta

        ctx?.req?.lifecycleRecorder?.record('request_finished')
        // 输出生命周期快照，用于全链路延迟分析
        if (ctx?.req?.lifecycleRecorder) {
            const snap = ctx.req.lifecycleRecorder.snapshot()
            const d = snap.derived
            logger.warn(`[LIFECYCLE] requestId=${snap.requestId} total=${d.total_request_ms}ms queue=${d.scheduler_queue_wait_ms}ms connect=${d.upstream_connect_ms}ms upstreamTTFB=${d.upstream_ttfb_ms}ms downstreamTTFB=${d.downstream_ttfb_ms}ms stream=${d.stream_duration_ms}ms model=${snap.fields?.model} baseModel=${snap.fields?.baseModel}`, 'LIFECYCLE')
        }
        logger.debug(`[SSE] Stream complete: phase=${streamState.phase} bytes=${streamState.contentBytesSent} chunks=${streamState.contentChunksSent} reasoning=${streamState.reasoningChunksSent} toolCalls=${streamState.toolCallsParsed}`, 'SSE')
        res.removeListener('close', onClientClose)
        stopHeartbeat()
    }
}

module.exports = { handleStreamResponse };
