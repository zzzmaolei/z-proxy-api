/**
 * upstream-consumer.js
 *
 * 上游 SSE 流消费高层 API
 *
 * 背景：
 *  - chat.js 与 anthropic.js 各自实现了一份 consumeUpstream（含 SSEFrameParser 串行队列）
 *  - 两份实现结构完全一致：sseParser.feed → process chunk → end flush
 *  - 关键不变量：end 前必须等待所有 in-flight 事件处理完成
 *
 * 目标：
 *  - 抽出一个高层 API：consumeUpstreamStream({ upstream, parser?, onEvent, onError?, onEnd? })
 *  - 复用现有 SSEFrameParser（不重写解析）
 *  - async onEvent 串行执行；end 之前 await 完所有
 *  - 不改变 chat.js / anthropic.js 的最终输出格式
 *
 * 本模块只消费已建立的响应流，不介入认证、风控或浏览器模拟逻辑。
 */

const SSEFrameParser = require('../../utils/sse-frame-parser.js')
const {
    CLASSIFICATION,
    classifyUpstreamError
} = require('../../utils/anthropic-stream-classifier.js')
const config = require('../../config/index.js')

// Qwen's Web SSE endpoint may end with an OpenAI-shaped final choice instead
// of a separate [DONE] sentinel. Treat only those explicit successful final
// choices as terminal; a plain EOF remains an interrupted upstream stream.
const QWEN_TERMINAL_FINISH_REASONS = new Set(['stop', 'length', 'tool_calls', 'content_filter'])
const isQwenTerminalEvent = (payload) => {
    // 旧格式：choices[0].finish_reason
    if (Array.isArray(payload?.choices) && payload.choices.some(choice => QWEN_TERMINAL_FINISH_REASONS.has(choice?.finish_reason))) {
        return true
    }
    // 新 Responses API 格式：response.completed（qwen3.8-max-preview 等新模型使用）
    if (payload?.['response.completed']) {
        return true
    }
    return false
}

/**
 * 消费一个 axios/原生 stream，按 SSE 帧切分后串行回调
 *
 * @param {Object} options
 * @param {Object} options.upstream     - axios stream 响应（含 .on('data'/'end'/'error')）
 * @param {Object} [options.parser]     - 注入自定义 SSEFrameParser；默认 new SSEFrameParser()
 * @param {Function} options.onEvent    - 单事件回调 (json, rawEvent) => void|Promise<void>
 *                                        rawEvent = { event, data, raw, id, retry, json, error }
 * @param {Function} [options.onError]  - 帧处理/JSON 解析失败回调 (rawEvent) => void；默认不动作
 * @param {Function} [options.onEnd]    - 流结束前额外 flush 回调；返回 Promise
 * @param {Function} [options.logger]   - { error(msg, tag, ...rest) }，错误日志
 * @param {number} [options.idleTimeoutMs] - Idle timeout in ms. Default is 1 hour; aborts if no new data chunk arrives.
 * @returns {Promise<void>} 全部帧处理完成后 resolve
 */
const consumeUpstreamStream = (options) => new Promise((resolve, reject) => {
    const opts = options || {}
    const upstream = opts.upstream
    const onEvent = opts.onEvent
    const onError = opts.onError
    const onEnd = opts.onEnd
    const onSettle = opts.onSettle
    const logger = opts.logger
    const signal = opts.signal
    const onFirstByte = opts.onFirstByte
    const isTerminalEvent = opts.isTerminalEvent
    const isEndOfStreamTerminal = opts.isEndOfStreamTerminal

    if (!upstream || typeof upstream.on !== 'function') {
        reject(new Error('consumeUpstreamStream: upstream must be a stream-like with .on()'))
        return
    }
    if (typeof onEvent !== 'function') {
        reject(new Error('consumeUpstreamStream: onEvent must be a function'))
        return
    }

    // 确保 Node.js 默认 socket 超时（2 分钟）不会杀死长连接推理流
    // 上游 Qwen 可能长时间不返回数据（如 reasoning 阶段），
    // Node 的 server.timeout 默认 2 分钟会在此类场景下误杀连接。
    if (upstream && upstream.req && upstream.req.socket) {
        upstream.req.socket.setTimeout(0)
    }

    // 空闲超时保护：超过 idleTimeoutMs 无新 data chunk 才主动 abort。
    // 这个计时只看上游 data，不看下游心跳；否则下游 keepalive 会掩盖上游已卡死的问题。
    // idleTimeoutMs=0 表示不主动 abort，适合 Claude Code 这类超长任务。
    const hasIdleTimeoutOption = Object.prototype.hasOwnProperty.call(opts, 'idleTimeoutMs')
    const configuredIdleTimeout = hasIdleTimeoutOption ? Number(opts.idleTimeoutMs) : Number(config.qwenStreamIdleTimeoutMs)
    const idleTimeoutMs = Number.isFinite(configuredIdleTimeout) && configuredIdleTimeout >= 0
        ? configuredIdleTimeout
        : 2 * 60 * 60 * 1000
    let idleTimer = null
    let settled = false
    let cleanup = () => {}
    const settle = (fn, arg, info) => {
        if (settled) return
        settled = true
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
        cleanup()
        if (typeof onSettle === 'function') {
            try { onSettle(info || {}) } catch (_) { /* ignore */ }
        }
        fn(arg)
    }
    const settleResolveEnd = () => {
        const info = { classification: 'end', error: null, terminalReceived, streamIncomplete }
        settle(resolve, info, info)
    }
    const settleRejectError = (err, fallbackClassification) => {
        const error = err instanceof Error ? err : new Error(String(err || 'upstream stream error'))
        const classification = fallbackClassification || classifyUpstreamError(error)
        try { error.classification = classification } catch (_) { /* ignore */ }
        settle(reject, error, { classification, error })
    }
    const resetIdleTimer = () => {
        if (idleTimeoutMs <= 0) return
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
            if (logger && typeof logger.error === 'function') {
                logger.error('上游流空闲超时（' + idleTimeoutMs + 'ms 无新数据），主动 abort', 'UPSTREAM', '')
            }
            try { if (upstream.destroy) upstream.destroy(new Error('upstream idle timeout')) } catch (_) {}
            const err = new Error('upstream idle timeout after ' + idleTimeoutMs + 'ms')
            err.code = 'ETIMEDOUT'
            settleRejectError(err, CLASSIFICATION.UPSTREAM_TIMEOUT)
        }, idleTimeoutMs)
    }
    resetIdleTimer()

    const sseParser = opts.parser instanceof SSEFrameParser
        ? opts.parser
        : new SSEFrameParser()

    // 串行 promise 队列：保证 SSE chunk 按到达顺序被处理，
    // 且 end 事件能等待所有 in-flight 处理完成后才 resolve，
    // 避免最后一个 chunk 还没解析完就提前 resolve 外层 Promise
    let processing = Promise.resolve()
    let endSeen = false
    let terminalReceived = false
    let streamIncomplete = false
    let firstByteSeen = false
    let sawValidEvent = false
    let incompleteTrailingFrame = false
    let eventCount = 0
    const MAX_EVENT_LOG = 5

    const processChunk = async (chunk) => {
        let events
        try {
            events = sseParser.feed(chunk)
        } catch (e) {
            if (logger && typeof logger.error === 'function') {
                logger.error('SSE feed error', 'UPSTREAM', '', e)
            }
            return
        }

        for (const ev of events) {
            if (!ev) continue
            eventCount++
            // 记录前几个上游 SSE 事件用于调试
            if (eventCount <= MAX_EVENT_LOG && logger && typeof logger.warn === 'function') {
                const rawPreview = typeof ev.raw === 'string' ? ev.raw.substring(0, 300) : String(ev.raw || '').substring(0, 300)
                logger.warn(`[UPSTREAM-SSE] #${eventCount} event=${ev.event || '(none)'} data=${String(ev.data || '').substring(0, 200)} raw=${rawPreview}`, 'SSE')
            }
            // 跳过解析失败的事件（partial / invalid JSON）——不阻断流
            if (ev.error) {
                if (typeof onError === 'function') {
                    try { onError(ev) } catch (_) { /* ignore */ }
                }
                continue
            }
            // 跳过心跳 sentinel [DONE] / 空数据
            if (ev.data === '[DONE]') {
                terminalReceived = true
                continue
            }
            if (!ev.json) continue
            sawValidEvent = true
            try {
                if (typeof isTerminalEvent === 'function' && isTerminalEvent(ev.json, ev)) terminalReceived = true
            } catch (_) { /* terminal classifier must not break stream consumption */ }
            try {
                await onEvent(ev.json, ev)
            } catch (e) {
                if (logger && typeof logger.error === 'function') {
                    logger.error('上游事件处理错误', 'UPSTREAM', '', e)
                }
            }
        }
    }

    const onData = (chunk) => {
        if (!firstByteSeen) {
            firstByteSeen = true
            try { onFirstByte?.(chunk) } catch (_) { /* ignore */ }
        }
        resetIdleTimer()
        processing = processing.then(() => processChunk(chunk))
    }

    const onStreamEnd = async () => {
        if (settled) return
        endSeen = true
        try {
            // 关键：end 前必须先等待所有已入队的 data chunk 处理完，
            // 否则 sseParser.end() 会先把 parser 标记为 closed，
            // 后续 data 事件里再调用 sseParser.feed() 会直接返回 []，
            // 导致所有事件丢失。
            await processing

            // flush 残留半截 frame
            try {
                const tail = sseParser.end()
                for (const ev of tail) {
                    if (!ev) continue
                    if (ev.error) {
                        incompleteTrailingFrame = true
                        if (typeof onError === 'function') {
                            try { onError(ev) } catch (_) { /* ignore */ }
                        }
                        continue
                    }
                    if (ev.data === '[DONE]') {
                        terminalReceived = true
                        continue
                    }
                    if (!ev.json) continue
                    sawValidEvent = true
                    try {
                        if (typeof isTerminalEvent === 'function' && isTerminalEvent(ev.json, ev)) terminalReceived = true
                    } catch (_) { /* terminal classifier must not break stream consumption */ }
                    try {
                        await onEvent(ev.json, ev)
                    } catch (e) {
                        if (logger && typeof logger.error === 'function') {
                            logger.error('上游事件处理错误', 'UPSTREAM', '', e)
                        }
                    }
                }
            } catch (_) { /* ignore */ }

            // 上游断开检测：流正常结束但未收到终端事件
            // 部分模型（如 qwen3.8-max-preview）不会发送 [DONE] 或 finish_reason，
            // 属于正常行为，由 isEndOfStreamTerminal 兜底处理。
            // 仅在兜底也失败时才升级为 WARN。
            if (!terminalReceived) {
                streamIncomplete = true
            }

            // Qwen Web uses a clean HTTP end for some successful streams
            // instead of a [DONE] frame.  This fallback is opt-in per route,
            // requires at least one complete SSE payload, and rejects a
            // partial trailing frame or an unfinished protocol block.
            if (!terminalReceived && sawValidEvent && !incompleteTrailingFrame && typeof isEndOfStreamTerminal === 'function') {
                try {
                    if (isEndOfStreamTerminal() === true) {
                        terminalReceived = true
                        streamIncomplete = false
                        if (logger && typeof logger.info === 'function') {
                            logger.info(`[SSE] isEndOfStreamTerminal 兜底修复：流结束标记为终端 (totalEvents=${eventCount})`, 'SSE')
                        }
                    }
                } catch (_) { /* stay incomplete */ }
            }

            // 可选：流结束前额外回调
            if (opts.requireTerminal !== false && !terminalReceived) {
                if (logger && typeof logger.warn === 'function') {
                    logger.warn(`[SSE] 上游 SSE 流结束且兜底修复失败：无终端事件，流真正不完整 (totalEvents=${eventCount})`, 'SSE')
                }
                const err = new Error('upstream stream ended without [DONE]')
                err.code = 'UPSTREAM_STREAM_INCOMPLETE'
                throw err
            }

            if (typeof onEnd === 'function') {
                try { await onEnd() } catch (_) { /* ignore */ }
            }

            settleResolveEnd()
        } catch (e) {
            settleRejectError(e)
        }
    }

    const onStreamError = (err) => {
        if (settled || endSeen) return
        if (logger && typeof logger.error === 'function') {
            const code = err?.code || 'unknown'
            const message = String(err?.message || '').slice(0, 200)
            logger.error(`上游流读取错误 code=${code} message=${message}`, 'UPSTREAM', '', err)
        }
        settleRejectError(err)
    }

    const onStreamAborted = () => {
        if (settled || endSeen) return
        const err = new Error('upstream aborted')
        err.code = 'ECONNRESET'
        settleRejectError(err, CLASSIFICATION.UPSTREAM_ABORTED)
    }

    const onStreamClose = () => {
        // Node stream 在正常 end 后也可能触发 close，所以 endSeen 时必须忽略。
        // 只有“close 先于 end”才代表上游提前断开，需要交给 controller 决定是否 bootstrap retry。
        if (settled) return
        if (endSeen) return
        const err = new Error('upstream closed before end')
        err.code = 'ERR_STREAM_PREMATURE_CLOSE'
        if (logger && typeof logger.error === 'function') {
            logger.error('上游流提前关闭 code=ERR_STREAM_PREMATURE_CLOSE message=upstream closed before end', 'UPSTREAM', '', err)
        }
        settleRejectError(err, CLASSIFICATION.UPSTREAM_PREMATURE_CLOSE)
    }

    const onClientAbort = () => {
        if (settled) return
        const err = new Error('client disconnected')
        err.code = 'CLIENT_ABORTED'
        settleRejectError(err, 'client_aborted')
        try { upstream.destroy?.() } catch (_) { /* ignore */ }
    }

    cleanup = () => {
        upstream.removeListener?.('data', onData)
        upstream.removeListener?.('end', onStreamEnd)
        upstream.removeListener?.('error', onStreamError)
        upstream.removeListener?.('aborted', onStreamAborted)
        upstream.removeListener?.('close', onStreamClose)
        signal?.removeEventListener?.('abort', onClientAbort)
    }

    upstream.on('data', onData)
    upstream.on('end', onStreamEnd)
    upstream.on('error', onStreamError)
    upstream.on('aborted', onStreamAborted)
    upstream.on('close', onStreamClose)
    signal?.addEventListener?.('abort', onClientAbort, { once: true })
    if (signal?.aborted) onClientAbort()
})

module.exports = {
    consumeUpstreamStream,
    isQwenTerminalEvent,
    CLASSIFICATION
}
