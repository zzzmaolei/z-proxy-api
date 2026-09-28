/**
 * anthropic-stream-classifier.js
 *
 * 上游流式错误 / 客户端断开分类器
 *
 * 目标：
 *   1. 区分 client_aborted（下游 Claude Code 主动断开）vs upstream_aborted（上游 socket reset）
 *   2. 识别上游 ECONNRESET / ERR_STREAM_PREMATURE_CLOSE / aborted → upstream_reset / upstream_aborted
 *   3. end 之前触发的 close 视为 premature_close
 *   4. 给日志输出统一的 phase / backend / request_id / error_code / emitted_anything 字段
 *
 * 设计原则：
 *   - 不记录 token / cookie / 完整 prompt / 原始 body
 *   - 不抛错：所有分类失败都降级为 'unknown'，避免阻断主流程
 *   - 不依赖 axios / express，纯函数
 */

// ----------------------------------------------------------------------------
// 分类常量
// ----------------------------------------------------------------------------

/**
 * 上游 / 客户端 / parser 错误的分类
 */
const CLASSIFICATION = Object.freeze({
    // 上游层（Qwen Web → z.free.api）
    UPSTREAM_RESET: 'upstream_reset',           // ECONNRESET / socket hang up
    UPSTREAM_ABORTED: 'upstream_aborted',       // 上游 stream aborted
    UPSTREAM_PREMATURE_CLOSE: 'upstream_premature_close',  // close 在 end 之前
    UPSTREAM_TIMEOUT: 'upstream_timeout',       // 上游响应超时
    UPSTREAM_HTTP_ERROR: 'upstream_http_error', // 4xx / 5xx with response
    UPSTREAM_INCOMPLETE: 'upstream_incomplete', // transport ended without protocol terminal
    // 客户端层（Claude Code → z.free.api）
    CLIENT_ABORTED: 'client_aborted',           // 客户端主动断开
    // 解析层
    PARSER_ERROR: 'parser_error',               // SSE 帧解析失败
    // 其他
    UNKNOWN: 'unknown'
})

/**
 * 是否属于"上游层"的错误
 * @param {string} c
 * @returns {boolean}
 */
const isUpstreamClassification = (c) => c && c.startsWith('upstream_')

/**
 * 是否属于"客户端断开"
 * @param {string} c
 * @returns {boolean}
 */
const isClientClassification = (c) => c === CLASSIFICATION.CLIENT_ABORTED

// ----------------------------------------------------------------------------
// 错误分类（针对 Node.js 常见 stream / http 错误）
// ----------------------------------------------------------------------------

/**
 * 把一个错误对象分类
 * @param {Error|null|undefined} err
 * @returns {string} CLASSIFICATION.*
 */
const classifyUpstreamError = (err) => {
    if (!err) return CLASSIFICATION.UNKNOWN
    const code = (err.code || '').toString()
    const msg = (err.message || '').toString()

    // 1) 客户端主动断开（axios 解构的 cancel 错误 / 上游 consumer 的 client abort）
    if (code === 'ERR_CANCELED' || code === 'ECONNABORTED') {
        // 区分 timeout vs cancel：
        //   - ECONNABORTED + message 含 "timeout" → 上游超时
        //   - 其他 → 客户端取消
        if (/timeout/i.test(msg)) return CLASSIFICATION.UPSTREAM_TIMEOUT
        return CLASSIFICATION.CLIENT_ABORTED
    }
    if (code === 'CLIENT_ABORTED') return CLASSIFICATION.CLIENT_ABORTED
    if (err.name === 'CanceledError' || err.name === 'AbortError') {
        return CLASSIFICATION.CLIENT_ABORTED
    }

    // 2) 上游层网络错误
    if (code === 'ECONNRESET') return CLASSIFICATION.UPSTREAM_RESET
    if (code === 'ETIMEDOUT' || code === 'EAI_AGAIN') return CLASSIFICATION.UPSTREAM_TIMEOUT
    if (code === 'ERR_STREAM_PREMATURE_CLOSE') return CLASSIFICATION.UPSTREAM_PREMATURE_CLOSE
    if (code === 'UPSTREAM_STREAM_INCOMPLETE') return CLASSIFICATION.UPSTREAM_INCOMPLETE
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND') return CLASSIFICATION.UPSTREAM_RESET

    // 3) message 兜底
    if (/socket hang up/i.test(msg)) return CLASSIFICATION.UPSTREAM_RESET
    if (/aborted/i.test(msg)) return CLASSIFICATION.UPSTREAM_ABORTED
    if (/premature close/i.test(msg)) return CLASSIFICATION.UPSTREAM_PREMATURE_CLOSE

    return CLASSIFICATION.UNKNOWN
}

/**
 * 判定一个 err 是否属于"上游 ECONNRESET 族"（即：可以触发自动重试的错误）
 * @param {Error|null|undefined} err
 * @returns {boolean}
 */
const isUpstreamResetLike = (err) => {
    const c = classifyUpstreamError(err)
    return c === CLASSIFICATION.UPSTREAM_RESET
        || c === CLASSIFICATION.UPSTREAM_ABORTED
        || c === CLASSIFICATION.UPSTREAM_PREMATURE_CLOSE
}

// ----------------------------------------------------------------------------
// emitted 状态机
// ----------------------------------------------------------------------------

/**
 * 创建一个 SSE emitted 状态追踪器
 * 用于记录"是否已经向下游写过 SSE 帧"以及"当前输出状态是否仍可安全重试"
 *
 * @returns {{
 *   messageStarted: boolean,
 *   activeBlocks: number,
 *   emittedAnySse: boolean,
 *   emittedContentBlock: boolean,
 *   finalStopSent: boolean,
 *   clientClosed: boolean,
 *   markMessageStart: () => void,
 *   markBlockStart: () => void,
 *   markBlockStop: () => void,
 *   markFinalStop: () => void,
 *   markAnySse: () => void,
 *   markClientClosed: () => void,
 *   canRetry: () => boolean,
 *   snapshot: () => object
 * }}
 */
const createEmittedState = () => {
    const state = {
        messageStarted: false,
        activeBlocks: 0,
        emittedAnySse: false,
        emittedContentBlock: false,
        finalStopSent: false,
        clientClosed: false
    }
    return {
        get messageStarted() { return state.messageStarted },
        get activeBlocks() { return state.activeBlocks },
        get emittedAnySse() { return state.emittedAnySse },
        get emittedContentBlock() { return state.emittedContentBlock },
        get finalStopSent() { return state.finalStopSent },
        get clientClosed() { return state.clientClosed },
        markMessageStart() {
            state.messageStarted = true
            state.emittedAnySse = true
        },
        markBlockStart() {
            state.activeBlocks += 1
            state.emittedContentBlock = true
            state.emittedAnySse = true
        },
        markBlockStop() {
            state.activeBlocks = Math.max(0, state.activeBlocks - 1)
        },
        markFinalStop() {
            state.finalStopSent = true
        },
        markAnySse() {
            state.emittedAnySse = true
        },
        markClientClosed() {
            state.clientClosed = true
        },
        /**
         * 判定当前是否仍可安全重试
         *   - 没发出 message_start / 任何 content_block / 任何 SSE → 可以
         *   - 否则不能
         */
        canRetry() {
            return !state.emittedAnySse
        },
        snapshot() {
            return { ...state }
        }
    }
}

// ----------------------------------------------------------------------------
// 日志字段构造
// ----------------------------------------------------------------------------

/**
 * 给一条日志记录构造统一的结构化字段
 * @param {Object} options
 * @param {string} [options.requestId]
 * @param {string} [options.backend]  - 'chat' | ...
 * @param {string} [options.phase]    - 'before_emit' | 'after_emit' | 'connecting' | 'reading' | 'finalize' | ...
 * @param {string} [options.errorCode]
 * @param {boolean} [options.emittedAnything]
 * @param {string} [options.classification]  - CLASSIFICATION.*
 * @returns {Object} 字段对象
 */
const buildLogFields = (options = {}) => {
    const out = {}
    if (options.requestId) out.request_id = String(options.requestId)
    if (options.backend) out.backend = String(options.backend)
    if (options.phase) out.phase = String(options.phase)
    if (options.errorCode) out.error_code = String(options.errorCode)
    if (options.classification) out.classification = String(options.classification)
    if (typeof options.emittedAnything === 'boolean') {
        out.emitted_anything = options.emittedAnything
    }
    return out
}

/**
 * 把日志字段对象格式化为 "key=value key=value ..." 形式
 * 注意：绝不输出 token / cookie / prompt 之类的敏感字段
 * @param {Object} fields
 * @returns {string}
 */
const formatLogFields = (fields = {}) => {
    if (!fields || typeof fields !== 'object') return ''
    const parts = []
    for (const k of Object.keys(fields)) {
        const v = fields[k]
        if (v === undefined || v === null) continue
        // 防御：拒绝敏感字段名
        if (/token|cookie|password|secret|apikey|authorization/i.test(k)) continue
        // 防御：value 若是字符串且疑似敏感，截断或脱敏
        if (typeof v === 'string') {
            // 长字符串不输出（可能是 prompt / 消息内容）
            if (v.length > 200) {
                parts.push(`${k}=<long:${v.length}>`)
            } else {
                parts.push(`${k}=${v}`)
            }
        } else {
            parts.push(`${k}=${String(v)}`)
        }
    }
    return parts.join(' ')
}

module.exports = {
    // 分类常量
    CLASSIFICATION,
    // 错误分类函数
    classifyUpstreamError,
    isUpstreamResetLike,
    isUpstreamClassification,
    isClientClassification,
    // 状态机
    createEmittedState,
    // 日志辅助
    buildLogFields,
    formatLogFields
}
