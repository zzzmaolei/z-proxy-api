/** 聊天中断监控 — 记录流中断详情和异常模式 */

const {
  CLASSIFICATION,
  classifyUpstreamError,
  formatLogFields
} = require('./anthropic-stream-classifier.js')

const MAX_FIELD_LENGTH = 200

// 合并 4 个 redact 正则为 1 个，按分支顺序匹配：
//   1) Bearer xxx          → 'Bearer [REDACTED]'
//   2) authorization: xxx  → 'Authorization: [REDACTED]'
//   3) cookie: xxx         → 'Cookie: [REDACTED]'
//   4) key=value           → 'key=[REDACTED]'（key 保留原大小写）
// 替换函数通过判断哪个捕获组命中来决定替换文本，语义与原 4 次串行 replace 完全一致。
const REDACT_RE = /(Bearer\s+[A-Za-z0-9._~+/-]+=*)|(authorization\s*:\s*[^\r\n]+)|(cookie\s*:\s*[^\r\n]+)|(cookie|authorization|token|api[-_]?key)=([^;\s]+)/gi

const redact = (value) => {
  if (value === undefined || value === null) return undefined
  const text = String(value).replace(REDACT_RE, (match, bearer, authColon, cookieColon, kvKey) => {
    if (bearer) return 'Bearer [REDACTED]'
    if (authColon) return 'Authorization: [REDACTED]'
    if (cookieColon) return 'Cookie: [REDACTED]'
    return `${kvKey}=[REDACTED]`
  })
  if (text.length > MAX_FIELD_LENGTH) {
    return `${text.slice(0, MAX_FIELD_LENGTH)}...<truncated:${text.length}>`
  }
  return text
}

const numberField = (value) => {
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

const booleanField = (value) => {
  return typeof value === 'boolean' ? value : undefined
}

const inferReason = (classification, fields) => {
  if (fields.reason) return fields.reason
  if (classification === CLASSIFICATION.UPSTREAM_RESET) return 'upstream_socket_reset'
  if (classification === CLASSIFICATION.UPSTREAM_ABORTED) return 'upstream_stream_aborted'
  if (classification === CLASSIFICATION.UPSTREAM_PREMATURE_CLOSE) return 'upstream_closed_before_end'
  if (classification === CLASSIFICATION.UPSTREAM_TIMEOUT) return 'upstream_idle_or_request_timeout'
  if (classification === CLASSIFICATION.UPSTREAM_HTTP_ERROR) {
    const status = fields.httpStatus || fields?.error?.response?.status
    return status ? `upstream_http_status_${status}` : 'upstream_http_error'
  }
  if (classification === CLASSIFICATION.CLIENT_ABORTED) return 'client_closed_connection'
  if (classification === CLASSIFICATION.PARSER_ERROR) return 'sse_parser_error'
  if (fields.noAnswer) return 'upstream_finished_without_answer_content'
  if (fields.requiredToolMissing) return 'required_tool_call_missing_after_retries'
  if (fields.rawToolLeak) return 'raw_internal_tool_block_detected'
  return 'unknown_interruption'
}

const inferClassification = (context = {}, error = null) => {
  if (context.classification) return context.classification
  if (error?.response?.status || context.httpStatus) return CLASSIFICATION.UPSTREAM_HTTP_ERROR
  return classifyUpstreamError(error)
}

const compactFields = (input = {}) => {
  const fields = {}
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === '') continue
    if (/token|cookie|password|secret|apikey|authorization/i.test(key)) continue
    if (typeof value === 'boolean') fields[key] = value
    else if (typeof value === 'number') fields[key] = value
    else fields[key] = redact(value)
  }
  return fields
}

const buildInterruptionFields = (context = {}, error = null) => {
  const classification = inferClassification(context, error)
  const httpStatus = error?.response?.status || context.httpStatus
  const fields = compactFields({
    protocol: context.protocol,
    route: context.route,
    requestId: context.requestId,
    profile: context.profile,
    model: context.model,
    stream: booleanField(context.stream),
    stage: context.stage,
    classification,
    reason: inferReason(classification, { ...context, httpStatus, error }),
    errorCode: error?.code || context.errorCode,
    errorName: error?.name || context.errorName,
    errorMessage: error?.message || context.errorMessage,
    httpStatus,
    account: context.account,
    hasTools: booleanField(context.hasTools),
    toolChoice: context.toolChoice,
    emittedClientDelta: booleanField(context.emittedClientDelta),
    messageStarted: booleanField(context.messageStarted),
    clientClosed: booleanField(context.clientClosed),
    upstreamEvents: numberField(context.upstreamEvents),
    upstreamParseErrors: numberField(context.upstreamParseErrors),
    answerChars: numberField(context.answerChars),
    thinkingChars: numberField(context.thinkingChars),
    completionChars: numberField(context.completionChars),
    toolCalls: numberField(context.toolCalls),
    emittedToolCalls: numberField(context.emittedToolCalls),
    retryUsed: booleanField(context.retryUsed),
    fallbackUsed: booleanField(context.fallbackUsed),
    bootstrapRetriesLeft: numberField(context.bootstrapRetriesLeft),
    canBootstrapRetry: booleanField(context.canBootstrapRetry),
    stopReason: context.stopReason,
    usageSource: context.usageSource,
    upstreamCloseKind: context.upstreamCloseKind,
    elapsedMs: numberField(context.elapsedMs),
    writableEnded: booleanField(context.writableEnded),
    destroyed: booleanField(context.destroyed)
  })
  return fields
}

const markLogged = (error) => {
  if (error && typeof error === 'object') {
    try { error._qwen2apiInterruptionLogged = true } catch (_) {}
  }
}

const alreadyLogged = (error) => !!(error && error._qwen2apiInterruptionLogged)

const logInterruption = (logger, context = {}, error = null) => {
  if (!logger || typeof logger.error !== 'function') return
  if (alreadyLogged(error)) return
  const fields = buildInterruptionFields(context, error)
  logger.error(`[chat interruption] ${formatLogFields(fields)}`, context.tag || 'CHAT', '')
  markLogged(error)
}

const logAnomaly = (logger, context = {}) => {
  if (!logger || typeof logger.warning !== 'function') return
  const fields = buildInterruptionFields({
    ...context,
    classification: context.classification || CLASSIFICATION.UNKNOWN
  }, null)
  logger.warning(`[chat anomaly] ${formatLogFields(fields)}`, context.tag || 'CHAT')
}

module.exports = {
  buildInterruptionFields,
  logInterruption,
  logAnomaly,
  redact
}
