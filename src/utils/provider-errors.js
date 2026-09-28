/**
 * provider-errors.js
 *
 * 统一的 API 错误规范化工具
 *
 * 借鉴 AIClient2API 的 error normalization 设计，为两家路线（Qwen/DeepSeek）
 * 提供统一的错误格式化和 OpenAI 兼容错误响应。
 *
 * 所有控制器 catch 块调用 normalizeError(err) 即可获得标准错误对象，
 * 然后通过 sendOpenAIError(res, normalizedError) 返回标准 OpenAI 格式。
 */

const { logger } = require('./logger')

/**
 * 标准错误类型
 */
const ErrorType = Object.freeze({
    AUTHENTICATION: 'authentication_error',
    RATE_LIMIT: 'rate_limit_error',
    ACCOUNT_DISABLED: 'account_disabled',
    ACCOUNT_MUTED: 'account_muted',
    UPSTREAM_ERROR: 'upstream_error',
    TIMEOUT: 'timeout_error',
    INVALID_REQUEST: 'invalid_request_error',
    INTERNAL: 'internal_error',
    NO_ACCOUNT: 'no_account_available',
    STREAM_ERROR: 'stream_error',
})

/**
 * 判定一段字符串是否包含"敏感 token / cookie / proxy 字样"
 * 命中后该字符串会被替换为脱敏占位符，绝不外泄
 */
function containsSensitiveContext(text) {
    if (typeof text !== 'string' || text.length === 0) return false
    // 不在字符串里直接出现 token / cookie / proxy 任何敏感字样
    if (/\btoken\b/i.test(text) && /Bearer|Bearer\s|sess-|ssxmod|acw_tc|cookie/i.test(text)) return true
    if (/ssxmod|acw_tc|Bearer\s+[A-Za-z0-9._-]{20,}/i.test(text)) return true
    if (/proxy=http|proxy\s*=\s*http|HTTPS_PROXY=http/i.test(text)) return true
    if (/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d{2,5}\b/.test(text)) return true // proxy host:port
    return false
}

/**
 * 脱敏错误消息：HTML 检测 + 敏感信息脱敏 + 长度截断 + 强制非空
 *
 * 提取自 openai-response.js 的 formatOpenAIError，供 sendOpenAIError / sendAnthropicError
 * 共用，确保所有错误响应都不外泄敏感信息。
 */
function sanitizeErrorMessage(rawMessage) {
    let msg = typeof rawMessage === 'string' ? rawMessage : String(rawMessage ?? '')

    // 检测是否含 HTML（上游可能是 504 HTML 页面）
    const isHtml = /<\/?(html|body|head|title|div|span|h\d|p)\b/i.test(msg)
    if (isHtml) {
        msg = 'Upstream returned an HTML error page'
    }

    // 脱敏：含 token / cookie / proxy 字样的不外泄
    if (containsSensitiveContext(msg)) {
        msg = 'Upstream returned a sensitive context; see server logs for details'
    }

    // 上限 800 字符避免异常巨大的 message
    if (msg.length > 800) {
        msg = msg.slice(0, 800) + '...'
    }

    // 强制非空
    if (!msg || !msg.trim()) {
        msg = 'Unknown error'
    }

    return msg.trim()
}

/**
 * 标准化错误对象
 * @param {Error|Object} err - 原始错误
 * @param {Object} [context] - 额外上下文
 * @param {string} [context.provider] - 提供商名称 (qwen/dpsk)
 * @param {string} [context.model] - 模型名
 * @param {string} [context.accountEmail] - 账号邮箱
 * @returns {{ type: string, message: string, statusCode: number, provider: string, model: string, accountEmail: string, originalError: Error }}
 */
function normalizeError(err, context = {}) {
    const message = (err && err.message) ? err.message : String(err ?? '')
    const lower = message.toLowerCase()
    const { provider = 'unknown', model = '', accountEmail = '' } = context

    let type = ErrorType.INTERNAL
    let statusCode = 500

    // 认证错误
    if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('token 失效') ||
        lower.includes('token 校验失败') || lower.includes('invalid token') || lower.includes('login failed') ||
        lower.includes('登录失败') || lower.includes('认证失败')) {
        type = ErrorType.AUTHENTICATION
        statusCode = 401
    }
    // 账号被禁用
    else if (lower.includes('disabled') || lower.includes('不可用') || lower.includes('account disabled') ||
        lower.includes('biz_code=5') || lower.includes('user is muted') || lower.includes('禁言')) {
        type = ErrorType.ACCOUNT_DISABLED
        statusCode = 403
    }
    // 限流
    else if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many') ||
        lower.includes('限流') || lower.includes('too frequent')) {
        type = ErrorType.RATE_LIMIT
        statusCode = 429
    }
    // 超时
    else if (lower.includes('timeout') || lower.includes('超时') || lower.includes('etimedout')) {
        type = ErrorType.TIMEOUT
        statusCode = 504
    }
    // 无可用账号
    else if (lower.includes('no account') || lower.includes('无可用账号') || lower.includes('无账号')) {
        type = ErrorType.NO_ACCOUNT
        statusCode = 503
    }
    // 流式错误
    else if (lower.includes('stream') || lower.includes('流式') || lower.includes('aborted')) {
        type = ErrorType.STREAM_ERROR
        statusCode = 500
    }
    // 无效请求
    else if (lower.includes('400') || lower.includes('bad request') || lower.includes('invalid') ||
        lower.includes('无效')) {
        type = ErrorType.INVALID_REQUEST
        statusCode = 400
    }
    // 上游错误
    else if (lower.includes('503') || lower.includes('service unavailable') || lower.includes('biz_code') ||
        lower.includes('upstream') || lower.includes('上游')) {
        type = ErrorType.UPSTREAM_ERROR
        statusCode = 502
    }

    if (err?.code === 'dpsk_prompt_too_large') {
        type = ErrorType.INVALID_REQUEST
        statusCode = Number(err.statusCode) >= 400 ? Number(err.statusCode) : 413
    }

    if (err?.code === 'tool_call_required') {
        type = ErrorType.INVALID_REQUEST
        statusCode = Number(err.statusCode) >= 400 ? Number(err.statusCode) : 422
    }

    return {
        type,
        message,
        statusCode,
        code: err?.code || null,
        provider,
        model,
        accountEmail,
        originalError: err,
    }
}

/**
 * 发送 OpenAI 兼容错误响应
 * @param {import('express').Response} res - Express 响应对象
 * @param {Object} normalizedError - normalizeError 的返回值
 * @param {Object} [extra] - 额外字段
 */
function sendOpenAIError(res, normalizedError, extra = {}) {
    const { type, message, statusCode, provider, model } = normalizedError

    // 脱敏 message，避免外泄 token / cookie / proxy 等敏感信息
    const safeMessage = sanitizeErrorMessage(message)

    // 记录日志
    if (statusCode >= 500) {
        logger.error(`[${provider.toUpperCase()}] ${type}: ${safeMessage}`, provider.toUpperCase())
    } else {
        logger.warn(`[${provider.toUpperCase()}] ${type}: ${safeMessage}`, provider.toUpperCase())
    }

    const errorBody = {
        error: {
            message: safeMessage,
            type,
            param: null,
            code: normalizedError.code || type,
            ...extra,
        },
    }

    // 添加提供商信息（非生产环境）
    if (process.env.NODE_ENV !== 'production') {
        errorBody.error.provider = provider
        if (model) errorBody.error.model = model
    }

    res.status(statusCode).json(errorBody)
}

/**
 * 创建 OpenClaw / Claude Code 兼容的错误响应
 * @param {import('express').Response} res
 * @param {Object} normalizedError
 * @param {Object} [extra] - 额外字段（如 punish_url / upstream_status / code）
 */
function sendAnthropicError(res, normalizedError, extra = {}) {
    const { type, message, statusCode } = normalizedError

    // 脱敏 message，与 sendOpenAIError 行为一致
    const safeMessage = sanitizeErrorMessage(message)

    const errorTypes = {
        [ErrorType.AUTHENTICATION]: 'authentication_error',
        [ErrorType.RATE_LIMIT]: 'rate_limit_error',
        [ErrorType.INVALID_REQUEST]: 'invalid_request_error',
        [ErrorType.INTERNAL]: 'api_error',
        [ErrorType.TIMEOUT]: 'timeout_error',
        [ErrorType.NO_ACCOUNT]: 'overloaded_error',
        [ErrorType.UPSTREAM_ERROR]: 'api_error',
    }

    res.status(statusCode).json({
        type: 'error',
        error: {
            type: errorTypes[type] || 'api_error',
            message: safeMessage,
            ...extra,
        },
    })
}

module.exports = {
    ErrorType,
    normalizeError,
    sendOpenAIError,
    sendAnthropicError,
    sanitizeErrorMessage,
    containsSensitiveContext,
}