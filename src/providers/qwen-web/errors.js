/**
 * errors.js
 *
 * 统一的 Qwen Web 上游错误分类。
 *
 * 设计目标：
 *  - 业务代码（request.js、chat.image.video.js、anthropic.js 等）
 *    不再到处 throw 字符串或混合对象
 *  - 上游小改动时，正常失败路径仍然能命中"schema_changed"，
 *    不会因为多一层 try/catch 而被默默吞掉
 *
 * 错误种类（kind）：
 *   - temporary_network_error  传输层失败（无 response）
 *   - upstream_5xx             上游 5xx
 *   - rate_limited             429 / 业务侧 RateLimited
 *   - auth_error               401 / 403
 *   - upstream_schema_changed  上游字段找不到（normalizer 抛出的）
 *   - upstream_html_error      上游返回了 HTML 错误页
 *   - sse_parse_error          SSE 流格式错误
 *
 * 不做的事：
 *  - 不做反风控绕过
 *  - 不模拟浏览器 JS Challenge
 *  - 不重写 ssxmod 逻辑
 */

const ERROR_KINDS = Object.freeze({
  TEMPORARY_NETWORK_ERROR: 'temporary_network_error',
  UPSTREAM_5XX: 'upstream_5xx',
  RATE_LIMITED: 'rate_limited',
  AUTH_ERROR: 'auth_error',
  UPSTREAM_SCHEMA_CHANGED: 'upstream_schema_changed',
  UPSTREAM_HTML_ERROR: 'upstream_html_error',
  SSE_PARSE_ERROR: 'sse_parse_error'
})

/**
 * 构造一个 Qwen Web 错误。
 *
 * @param {string} kind       - 错误种类（必须来自 ERROR_KINDS）
 * @param {string} message    - 人类可读消息
 * @param {Object} [extra]
 * @param {number} [extra.status]      - HTTP 状态码（如果有）
 * @param {string} [extra.where]      - 发生位置（normalizer 会用，比如 "normalizeChatCreateResponse"）
 * @param {string} [extra.rawPreview] - 原始响应预览（截断后）
 * @param {Error} [extra.cause]       - 触发此错误的原始 Error（如果有）
 * @returns {Error} 一个带 kind 字段的结构化 Error
 */
const createQwenError = (kind, message, extra) => {
  if (!kind) {
    throw new TypeError('[qwen-web] createQwenError 需要 kind')
  }
  const err = new Error(message || `[qwen-web] ${kind}`)
  err.name = 'QwenWebError'
  err.kind = kind

  if (extra && typeof extra === 'object') {
    if (extra.status !== undefined) err.status = extra.status
    if (extra.where) err.where = extra.where
    if (extra.rawPreview) err.rawPreview = extra.rawPreview
    if (extra.cause instanceof Error) err.cause = extra.cause
  }

  return err
}

/**
 * 把一个 axios 错误归类为 Qwen Web 错误。
 *
 * @param {Error} error
 * @returns {Error} 结构化错误
 */
const classifyAxiosError = (error) => {
  if (!error) {
    return createQwenError(ERROR_KINDS.TEMPORARY_NETWORK_ERROR, '未知错误')
  }

  // 已经是 QwenWebError，直接返回
  if (error.name === 'QwenWebError' && error.kind) {
    return error
  }

  const status = error.response ? error.response.status : null
  const raw = error.response ? error.response.data : error
  const rawPreview = previewOf(raw)

  if (isHtmlErrorPage(raw)) {
    return createQwenError(ERROR_KINDS.UPSTREAM_HTML_ERROR, `上游返回 HTML 错误页 (status=${status || 'unknown'})`, {
      status,
      rawPreview,
      cause: error
    })
  }

  if (status === 401 || status === 403) {
    return createQwenError(ERROR_KINDS.AUTH_ERROR, `上游鉴权失败 (status=${status})`, {
      status,
      rawPreview
    })
  }
  if (status === 429) {
    return createQwenError(ERROR_KINDS.RATE_LIMITED, '上游限流 (status=429)', {
      status,
      rawPreview
    })
  }
  if (status && status >= 500) {
    return createQwenError(ERROR_KINDS.UPSTREAM_5XX, `上游 5xx (status=${status})`, {
      status,
      rawPreview
    })
  }

  // 传输层失败（无 response）
  if (!status) {
    return createQwenError(
      ERROR_KINDS.TEMPORARY_NETWORK_ERROR,
      `网络错误: ${error.message || 'unknown'}`,
      { rawPreview, cause: error }
    )
  }

  // 4xx 其它：归到 schema_changed，避免静默失败
  return createQwenError(
    ERROR_KINDS.UPSTREAM_SCHEMA_CHANGED,
    `上游 4xx (status=${status})`,
    { status, rawPreview, cause: error }
  )
}

/**
 * 判断响应体是不是 HTML 错误页（不合法 JSON）。
 *
 * @param {*} data
 * @returns {boolean}
 */
const isHtmlErrorPage = (data) => {
  if (data == null) return false
  if (typeof data === 'string') {
    const head = data.slice(0, 200).trim().toLowerCase()
    return head.startsWith('<!doctype html') ||
           head.startsWith('<html') ||
           head.includes('<title>') ||
           head.includes('access denied')
  }
  return false
}

/**
 * 把任意响应体压缩为 rawPreview（截断后）。
 *
 * @param {*} data
 * @param {number} [maxLen=400]
 * @returns {string}
 */
const previewOf = (data, maxLen = 400) => {
  if (data == null) return ''
  if (Buffer.isBuffer(data)) return data.toString('utf-8').slice(0, maxLen)
  if (typeof data === 'string') return data.slice(0, maxLen)
  try {
    return JSON.stringify(data).slice(0, maxLen)
  } catch (_) {
    return String(data).slice(0, maxLen)
  }
}

module.exports = {
  ERROR_KINDS,
  createQwenError,
  classifyAxiosError,
  isHtmlErrorPage,
  previewOf
}
