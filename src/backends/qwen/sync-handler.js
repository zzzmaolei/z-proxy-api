/**
 * Qwen OpenAI 协议同步响应处理器
 *
 * 从 src/controllers/chat.js 提取，独立为可复用的同步处理模块。
 *
 * 与流式处理器（stream-handler.js）的差异：
 *   - 上游 SSE 全量缓冲为 fullContent + thinkingContent，再一次性写 JSON payload
 *   - 工具调用走 parseToolCallsFromText（离线解析），非 createToolCallStreamParser（流式）
 *   - 无心跳，用 startNonStreamKeepalive 保活（可选）
 *
 * @param {object} ctx - 处理上下文（单参 ctx，与 DeepSeek backends 对齐）
 * @param {object} ctx.res - Express 响应对象
 * @param {object} ctx.response - 上游 axios stream 响应
 * @param {boolean} ctx.enable_thinking - 是否启用思考模式
 * @param {boolean} ctx.enable_web_search - 是否启用网络搜索
 * @param {string} ctx.model - 模型名称
 * @param {object} ctx.requestBody - 原始请求体
 * @param {boolean} [ctx.has_tools]
 * @param {string|Object} [ctx.tool_choice]
 * @param {object} [ctx.currentAccount]
 * @param {object} [ctx.req]
 * @param {object} [ctx.clientProfile]
 * @param {string} [ctx.requestId]
 * @param {object} [ctx.latency]
 */
const { generateUUID } = require('../../utils/tools.js');
const { createUsageObject } = require('../../utils/precise-tokenizer.js');
const { sendChatRequest } = require('./request.js');
const {
    parseLooseToolCallsFromText,
    stripInternalToolBlocks,
    appendHintToLastMessage
} = require('../../utils/tool-prompt.js');
const accountManager = require('../../utils/account.js');
const config = require('../../config/index.js');
const { logger } = require('../../utils/logger');
const SSEFrameParser = require('../../utils/sse-frame-parser');
const { attributeChatUsage } = require('../../utils/usage-tracker.js');
const { consumeUpstreamStream, isQwenTerminalEvent } = require('./upstream-consumer.js');
const { formatOpenAIError } = require('../../utils/openai-response.js');
const { logInterruption, logAnomaly } = require('../../utils/chat-interruption-monitor.js');
const {
    markFirstUpstreamEvent,
    setLatencyFields
} = require('../../utils/chat-latency-monitor.js');
const {
    startNonStreamKeepalive,
    writeJsonPayload,
    getImageMarkdownListFromDelta,
    isThinkingPhase,
    extractThinkingSummaryDelta,
    requiresToolCall,
    buildRequiredRetryHint,
} = require('./stream-utils');

/**
 * 处理非流式响应（从流式数据累积完整响应）
 */
const handleSyncResponse = async (ctx) => {
    const { res, response, enable_thinking, enable_web_search, model, requestBody = null } = ctx;
    const options = ctx; // 兼容内部 options.xxx 引用，与 DeepSeek 单参 ctx 形态对齐
    const stopNonStreamKeepalive = startNonStreamKeepalive(res)
    let syncOutcome = 'incomplete'
    try {
        let fullContent = ''
        let thinkingContent = ''
        let web_search_info = null
        let thinking_start = false
        let thinking_end = false
        let appendedImageMarkdownSet = new Set()
        let pendingImageMarkdownList = []

        const hasTools = !!options.has_tools
        const toolChoice = options.tool_choice
        // 注意：中间件 processRequestBody 会用 Qwen 内部 body 替换 req.body，
        // 内部 body 不含 tools 字段（避免激活上游原生 function_call）。
        // 因此从 req.originalBody 取原始 OpenAI tools 供 loose parse 使用。
        const rawToolsSource = options.req?.originalBody?.tools || requestBody?.tools || []
        const reparseTools = rawToolsSource
            .map(t => ({ name: (t && (t.name || t.function?.name)) || '' }))
            .filter(t => t.name)
        let upstreamEvents = 0
        let upstreamParseErrors = 0
        let answerChars = 0
        const requestId = options.requestId || generateUUID()
        const latency = options.latency || options.req?.chatLatency || null
        setLatencyFields(latency, { requestId })

        // Token消耗量统计
        let totalTokens = {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0
        }

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
         * 处理一个上游 SSE delta JSON（已由 consumeUpstreamStream 解析过）
         */
        const processChunk = async (decodeJson) => {
            if (!decodeJson.choices || decodeJson.choices.length === 0) {
                if (decodeJson.usage) {
                    totalTokens = {
                        prompt_tokens: decodeJson.usage.prompt_tokens || totalTokens.prompt_tokens,
                        completion_tokens: decodeJson.usage.completion_tokens || totalTokens.completion_tokens,
                        total_tokens: decodeJson.usage.total_tokens || totalTokens.total_tokens
                    }
                }
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
                const newImageMarkdownList = imageMarkdownList.filter(it => !appendedImageMarkdownSet.has(it))

                if (thinking_start && !thinking_end) {
                    const pendingSet = new Set(pendingImageMarkdownList)
                    for (const url of newImageMarkdownList) {
                        if (!pendingSet.has(url)) {
                            pendingImageMarkdownList.push(url)
                            pendingSet.add(url)
                        }
                    }
                } else if (newImageMarkdownList.length > 0) {
                    fullContent += `${newImageMarkdownList.join('\n\n')}\n\n`
                    newImageMarkdownList.forEach(it => appendedImageMarkdownSet.add(it))
                }
            }

            if (!delta || !delta.content) {
                return
            }

            let content = delta.content

            if (delta.phase === 'answer') {
                answerChars += content.length
            }

            if (isThinkingPhase(delta.phase)) {
                thinking_start = true
                if (web_search_info) {
                    const webSearchTable = await accountManager.generateMarkdownTable(web_search_info, config.searchInfoMode)
                    thinkingContent += `thinking

${webSearchTable}

${content}`
                } else {
                    thinkingContent += content
                }
                return
            }
            if (delta.phase === 'answer' && !thinking_end && thinking_start) {
                thinking_end = true
                if (pendingImageMarkdownList.length > 0) {
                    content = `${pendingImageMarkdownList.join('\n\n')}\n\n${content}`
                    pendingImageMarkdownList.forEach(it => appendedImageMarkdownSet.add(it))
                    pendingImageMarkdownList = []
                }
                // thinking 内容已通过 reasoning_content 单独输出，不再向 content 注入 </think> 闭合标签
            }

            fullContent += content
        }

        /**
         * Consume one upstream response and append answer content to fullContent.
         */
        const accumulateUpstream = (upstreamResponse) => consumeUpstreamStream({
            upstream: upstreamResponse,
            parser: new SSEFrameParser(),
            logger,
            isTerminalEvent: isQwenTerminalEvent,
            isEndOfStreamTerminal: () => upstreamEvents > 0,
            onEvent: async (decodeJson) => {
                upstreamEvents += 1
                if (upstreamEvents === 1) {
                    ctx?.req?.lifecycleRecorder?.record('upstream_started')
                    ctx?.req?.lifecycleRecorder?.record('first_upstream_byte')
                }
                markFirstUpstreamEvent(latency, logger, {
                    upstreamEvents
                })
                try {
                    await processChunk(decodeJson)
                } catch (error) {
                    logger.error('非流式数据处理错误', 'CHAT', '', error)
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
                    model,
                    stream: false,
                    stage: 'openai_nonstream_sse_parse',
                    classification: 'parser_error',
                    reason: 'upstream_sse_json_parse_error',
                    account: options.currentAccount?.email,
                    hasTools,
                    toolChoice,
                    upstreamEvents,
                    upstreamParseErrors,
                    answerChars,
                    completionChars: fullContent.length,
                    errorMessage: rawEvent?.error?.message || rawEvent?.data
                })
            }
        })

        const resetAccumulatedState = () => {
            fullContent = ''
            thinkingContent = ''
            web_search_info = null
            thinking_start = false
            thinking_end = false
            appendedImageMarkdownSet = new Set()
            pendingImageMarkdownList = []
            totalTokens = {
                prompt_tokens: 0,
                completion_tokens: 0,
                total_tokens: 0
            }
        }

        let activeResponse = response
        let bootstrapRetriesLeft = Math.max(0, Number(config.qwenStreamBootstrapRetries) || 0)
        while (true) {
            try {
                await accumulateUpstream(activeResponse)
                break
            } catch (streamError) {
                logInterruption(logger, {
                    tag: 'CHAT',
                    protocol: 'openai',
                    route: '/v1/chat/completions',
                    requestId,
                    profile: options.clientProfile?.profile?.name,
                    model,
                    stream: false,
                    stage: 'openai_nonstream_upstream',
                    account: options.currentAccount?.email,
                    hasTools,
                    toolChoice,
                    upstreamEvents,
                    upstreamParseErrors,
                    answerChars,
                    completionChars: fullContent.length,
                    bootstrapRetriesLeft,
                    canBootstrapRetry: !res.writableEnded && !res.destroyed && bootstrapRetriesLeft > 0,
                    writableEnded: res.writableEnded,
                    destroyed: res.destroyed
                }, streamError)
                if (!res.writableEnded && !res.destroyed && bootstrapRetriesLeft > 0) {
                    bootstrapRetriesLeft -= 1
                    logger.warning?.(`OpenAI non-stream 上游完成前断开，丢弃未完成响应并重试一次 (remaining=${bootstrapRetriesLeft})`, 'CHAT')
                    try {
                        const retryResp = await sendChatRequest(requestBody, options.req || null, { account: options.currentAccount })
                        if (retryResp.status && retryResp.response) {
                            options.currentAccount = retryResp.currentAccount || options.currentAccount
                            activeResponse = retryResp.response
                            resetAccumulatedState()
                            continue
                        }
                    } catch (retryError) {
                        logger.error('OpenAI non-stream bootstrap 重试失败', 'CHAT', '', retryError)
                    }
                }
                throw streamError
            }
        }

        // 工具调用解析：宽松解析（XML/fence/裸JSON/toolName{ args }）
        let assistantContent = fullContent
        let toolCalls = []
        if (hasTools) {
            const parsed = parseLooseToolCallsFromText(fullContent, reparseTools)
            assistantContent = stripInternalToolBlocks(parsed.cleanedText)
            toolCalls = parsed.toolCalls
        }

        // tool_choice="required" 强校验：未触发则重试一次。
        // 非流式可以等上游读完后再决定，所以 retry 使用独立状态读取；
        // 只有 retry 真的解析出工具调用时，才用 retry 的 tool_calls/cleanedText 替换首轮结果。
        // retry 没工具调用时直接丢弃 retry 文本，防止最终 answer 变成“首轮文本 + retry 文本”。
        if (hasTools && toolCalls.length === 0 && requiresToolCall(toolChoice)) {
            const retryHint = buildRequiredRetryHint(toolChoice, 0, { provider: 'qwen', tools: rawToolsSource })
            const retryBody = appendHintToLastMessage(requestBody, retryHint)
            logger.warning?.('tool_choice=required 首次未触发工具调用，进行一次重试', 'CHAT')
            let retryFirstPassState = null
            try {
                const retryResp = await sendChatRequest(retryBody, options.req || null, { account: options.currentAccount })
                if (retryResp.status && retryResp.response) {
                    retryFirstPassState = {
                        fullContent,
                        thinkingContent,
                        web_search_info,
                        thinking_start,
                        thinking_end,
                        appendedImageMarkdownSet: new Set(appendedImageMarkdownSet),
                        pendingImageMarkdownList: [...pendingImageMarkdownList],
                        totalTokens: { ...totalTokens }
                    }
                    fullContent = ''
                    web_search_info = null
                    thinking_start = false
                    thinking_end = false
                    appendedImageMarkdownSet = new Set()
                    pendingImageMarkdownList = []
                    totalTokens = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

                    await accumulateUpstream(retryResp.response)
                    const retriedText = fullContent
                    const parsedRetry = parseLooseToolCallsFromText(retriedText, reparseTools)
                    if (parsedRetry.toolCalls.length > 0) {
                        toolCalls = parsedRetry.toolCalls
                        assistantContent = stripInternalToolBlocks(parsedRetry.cleanedText)
                    } else {
                        fullContent = retryFirstPassState.fullContent
                        thinkingContent = retryFirstPassState.thinkingContent || ''
                        web_search_info = retryFirstPassState.web_search_info
                        thinking_start = retryFirstPassState.thinking_start
                        thinking_end = retryFirstPassState.thinking_end
                        appendedImageMarkdownSet = retryFirstPassState.appendedImageMarkdownSet
                        pendingImageMarkdownList = retryFirstPassState.pendingImageMarkdownList
                        totalTokens = retryFirstPassState.totalTokens
                    }
                }
            } catch (e) {
                if (retryFirstPassState) {
                    fullContent = retryFirstPassState.fullContent
                    web_search_info = retryFirstPassState.web_search_info
                    thinking_start = retryFirstPassState.thinking_start
                    thinking_end = retryFirstPassState.thinking_end
                    appendedImageMarkdownSet = retryFirstPassState.appendedImageMarkdownSet
                    pendingImageMarkdownList = retryFirstPassState.pendingImageMarkdownList
                    totalTokens = retryFirstPassState.totalTokens
                }
                logger.error('required 模式重试失败', 'CHAT', '', e)
            }
        }

        // 处理最终的搜索信息
        if ((config.outThink === false || !enable_thinking) && web_search_info && config.searchInfoMode === "text") {
            const webSearchTable = await accountManager.generateMarkdownTable(web_search_info, "text")
            assistantContent += `\n\n---\n${webSearchTable}`
        }

        // 计算最终的token使用量
        if (totalTokens.prompt_tokens === 0 && totalTokens.completion_tokens === 0) {
            totalTokens = createUsageObject(requestBody?.messages || promptText, fullContent, null)
            logger.debug(`非流式使用tiktoken计算 - Prompt: ${totalTokens.prompt_tokens}, Completion: ${totalTokens.completion_tokens}, Total: ${totalTokens.total_tokens}`, 'CHAT')
        } else {
            logger.debug(`非流式使用上游真实Token - Prompt: ${totalTokens.prompt_tokens}, Completion: ${totalTokens.completion_tokens}, Total: ${totalTokens.total_tokens}`, 'CHAT')
        }

        totalTokens.prompt_tokens = Math.max(0, totalTokens.prompt_tokens || 0)
        totalTokens.completion_tokens = Math.max(0, totalTokens.completion_tokens || 0)
        totalTokens.total_tokens = totalTokens.prompt_tokens + totalTokens.completion_tokens

        // Daily stats 累计——一次性归属到主请求账户（同 stream 分支注释）
        attributeChatUsage(options.currentAccount, totalTokens, undefined, {
            provider: 'qwen',
            model: options.model || requestBody?.model || ''
        })

        const assistantMessage = { role: 'assistant', content: assistantContent || null }
        if (thinkingContent) {
            assistantMessage.reasoning_content = thinkingContent
        }
        if (toolCalls.length > 0) {
            assistantMessage.tool_calls = toolCalls
        }
        if (upstreamEvents === 0 || (!fullContent && toolCalls.length === 0)) {
            logAnomaly(logger, {
                tag: 'CHAT',
                protocol: 'openai',
                route: '/v1/chat/completions',
                requestId,
                profile: options.clientProfile?.profile?.name,
                model,
                stream: false,
                stage: 'openai_nonstream_finish',
                reason: upstreamEvents === 0 ? 'upstream_finished_without_events' : 'upstream_finished_without_answer_content',
                account: options.currentAccount?.email,
                hasTools,
                toolChoice,
                upstreamEvents,
                upstreamParseErrors,
                answerChars,
                completionChars: fullContent.length,
                toolCalls: toolCalls.length,
                stopReason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
            })
        }
        if (hasTools && requiresToolCall(toolChoice) && toolCalls.length === 0) {
            logAnomaly(logger, {
                tag: 'CHAT',
                protocol: 'openai',
                route: '/v1/chat/completions',
                requestId,
                profile: options.clientProfile?.profile?.name,
                model,
                stream: false,
                stage: 'openai_nonstream_finish',
                reason: 'required_tool_call_missing_after_retries',
                requiredToolMissing: true,
                account: options.currentAccount?.email,
                hasTools,
                toolChoice,
                upstreamEvents,
                upstreamParseErrors,
                answerChars,
                completionChars: fullContent.length,
                toolCalls: toolCalls.length,
                stopReason: 'stop'
            })
        }

        const bodyTemplate = {
            "id": `chatcmpl-${generateUUID()}`,
            "object": "chat.completion",
            "created": Math.round(new Date().getTime() / 1000),
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "message": assistantMessage,
                    "finish_reason": toolCalls.length > 0 ? "tool_calls" : "stop"
                }
            ],
            "usage": totalTokens
        }
        stopNonStreamKeepalive()
        writeJsonPayload(res, bodyTemplate)
        ctx?.req?.lifecycleRecorder?.record('stream_terminal')
        syncOutcome = 'success'
    } catch (error) {
        const isClientAbort = error?.code === 'CLIENT_ABORTED' || error?.classification === 'client_aborted'
        syncOutcome = isClientAbort ? 'client_aborted' : 'failure'
        stopNonStreamKeepalive()
        logInterruption(logger, {
            tag: 'CHAT',
            protocol: 'openai',
            route: '/v1/chat/completions',
            requestId: options.requestId,
            profile: options.clientProfile?.profile?.name,
            model,
            stream: false,
            stage: 'openai_nonstream_handler',
            account: options.currentAccount?.email,
            hasTools: !!options.has_tools,
            toolChoice: options.tool_choice,
            writableEnded: res.writableEnded,
            destroyed: res.destroyed
        }, error)
        logger.error('非流式聊天处理错误', 'CHAT', '', error)
        try {
            const payload = formatOpenAIError(error, {
                type: 'api_error',
                code: 'chat_non_stream_error'
            })
            if (!res.headersSent) {
                res.status(500).json(payload)
            } else if (!res.writableEnded) {
                writeJsonPayload(res, payload)
            }
        } catch (_) { /* response already started */ }
    } finally {
        try {
            if (ctx && ctx.req && ctx.req.lease && typeof ctx.req.lease.release === 'function') {
                ctx.req.lease.release(syncOutcome)
                ctx.req.lifecycleRecorder?.record('lease_released')
            }
        } catch (_e) { /* 幂等，忽略 */ }
        ctx?.req?.lifecycleRecorder?.record('request_finished')
    }
}

module.exports = { handleSyncResponse };
