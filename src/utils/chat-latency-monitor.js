/** 聊天延迟追踪器 — 记录各阶段耗时（chat_id/上游/下游） */

const config = require('../config/index.js')
const { formatLogFields } = require('./anthropic-stream-classifier.js')

const SENSITIVE_KEY_RE = /token|cookie|password|secret|apikey|authorization/i
const MAX_FIELD_LENGTH = 160

const now = () => Date.now()

const redactValue = (value) => {
  if (value === undefined || value === null) return undefined
  const text = String(value)
  if (/Bearer\s+[A-Za-z0-9._~+/-]+=*/i.test(text)) return '[REDACTED]'
  if (text.length > MAX_FIELD_LENGTH) return `${text.slice(0, MAX_FIELD_LENGTH)}...<truncated:${text.length}>`
  return text
}

const compactFields = (input = {}) => {
  const fields = {}
  for (const [key, value] of Object.entries(input || {})) {
    if (value === undefined || value === null || value === '') continue
    if (SENSITIVE_KEY_RE.test(key)) continue
    if (typeof value === 'number') {
      if (Number.isFinite(value)) fields[key] = value
    } else if (typeof value === 'boolean') {
      fields[key] = value
    } else {
      fields[key] = redactValue(value)
    }
  }
  return fields
}

const countPromptChars = (messages) => {
  if (!Array.isArray(messages)) return 0
  let total = 0
  const visit = (value) => {
    if (!value) return
    if (typeof value === 'string') {
      total += value.length
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (typeof value === 'object') {
      if (typeof value.text === 'string') total += value.text.length
      else if (typeof value.content === 'string') total += value.content.length
      else if (Array.isArray(value.content)) visit(value.content)
    }
  }
  for (const message of messages) {
    if (!message) continue
    visit(message.content)
  }
  return total
}

const messageStats = (messages) => ({
  messageCount: Array.isArray(messages) ? messages.length : 0,
  promptChars: countPromptChars(messages)
})

const createChatLatencyTracker = (fields = {}) => {
  if (!config.chatLatencyLog) return null
  const startedAt = now()
    return {
      startedAt,
      marks: { requestStart: startedAt },
      fields: compactFields(fields),
      loggedStages: new Set(),
      loggedSlowReasons: new Set()
  }
}

const setLatencyFields = (tracker, fields = {}) => {
  if (!tracker) return
  Object.assign(tracker.fields, compactFields(fields))
}

const markLatency = (tracker, name, fields = {}) => {
  if (!tracker || !name) return
  if (!tracker.marks[name]) tracker.marks[name] = now()
  setLatencyFields(tracker, fields)
}

const addLatencyMetric = (tracker, name, amount) => {
  if (!tracker || !name) return
  const value = Number(amount)
  if (!Number.isFinite(value)) return
  tracker.fields[name] = (Number(tracker.fields[name]) || 0) + value
}

const createLatencyHoldObserver = (tracker, prefix) => {
  let startedAt = null
  let maxBytes = 0
  const flush = () => {
    if (startedAt === null) return
    addLatencyMetric(tracker, `${prefix}HeldMs`, Math.max(0, now() - startedAt))
    addLatencyMetric(tracker, `${prefix}HeldBytes`, maxBytes)
    startedAt = null
    maxBytes = 0
  }
  return {
    sample(bytes) {
      const size = Math.max(0, Number(bytes) || 0)
      if (size > 0) {
        if (startedAt === null) startedAt = now()
        maxBytes = Math.max(maxBytes, size)
      } else {
        flush()
      }
    },
    flush
  }
}

const duration = (tracker, from, to) => {
  if (!tracker) return undefined
  const start = tracker.marks[from]
  const end = tracker.marks[to]
  if (!start || !end) return undefined
  return Math.max(0, end - start)
}

const sinceStart = (tracker, mark) => duration(tracker, 'requestStart', mark)

const buildLatencyFields = (tracker, stage, extra = {}) => {
  if (!tracker) return {}
  return compactFields({
    ...tracker.fields,
    ...extra,
    stage,
    totalMs: sinceStart(tracker, stage) ?? Math.max(0, now() - tracker.startedAt),
    bodyMs: duration(tracker, 'requestStart', 'bodyNormalized'),
    accountMs: duration(tracker, 'requestStart', 'accountSelected'),
    chatIdMs: duration(tracker, 'chatIdStart', 'chatIdEnd'),
    upstreamHeadersMs: duration(tracker, 'upstreamPostStart', 'upstreamHeaders'),
    firstEventMs: sinceStart(tracker, 'firstUpstreamEvent'),
    upstreamFirstEventWaitMs: duration(tracker, 'upstreamPostStart', 'firstUpstreamEvent'),
    firstWriteMs: sinceStart(tracker, 'firstDownstreamWrite'),
    firstUpstreamByteMs: sinceStart(tracker, 'firstUpstreamByte'),
    firstParsedEventMs: sinceStart(tracker, 'firstParsedEvent'),
    firstMeaningfulUpstreamDeltaMs: sinceStart(tracker, 'firstMeaningfulUpstreamDelta'),
    firstProtocolWriteMs: sinceStart(tracker, 'firstProtocolWrite'),
    firstSemanticWriteMs: sinceStart(tracker, 'firstSemanticWrite'),
    firstContentDeltaMs: sinceStart(tracker, 'firstContentDelta'),
    firstReasoningDeltaMs: sinceStart(tracker, 'firstReasoningDelta'),
    firstToolDeltaMs: sinceStart(tracker, 'firstToolDelta')
  })
}

const slowReasons = (tracker) => {
  const reasons = []
  const chatIdMs = duration(tracker, 'chatIdStart', 'chatIdEnd')
  const upstreamHeadersMs = duration(tracker, 'upstreamPostStart', 'upstreamHeaders')
  const upstreamFirstEventWaitMs = duration(tracker, 'upstreamPostStart', 'firstUpstreamEvent')
  const firstProtocolWriteMs = sinceStart(tracker, 'firstProtocolWrite')
  const firstSemanticWriteMs = sinceStart(tracker, 'firstSemanticWrite')
  if (chatIdMs !== undefined && chatIdMs > config.chatLatencySlowChatIdMs) reasons.push('slow_chat_id')
  if (upstreamHeadersMs !== undefined && upstreamHeadersMs > config.chatLatencySlowUpstreamHeadersMs) reasons.push('slow_upstream_headers')
  if (upstreamFirstEventWaitMs !== undefined && upstreamFirstEventWaitMs > config.chatLatencySlowFirstEventMs) reasons.push('slow_first_upstream_event')
  if (firstProtocolWriteMs !== undefined && firstProtocolWriteMs > config.chatLatencySlowFirstEventMs) reasons.push('slow_first_protocol_write')
  if (firstSemanticWriteMs !== undefined && firstSemanticWriteMs > config.chatLatencySlowFirstEventMs) reasons.push('slow_first_semantic_write')
  return reasons
}

const writeLog = (logger, level, message) => {
  if (!logger) return
  if (level === 'warning') {
    if (typeof logger.warning === 'function') return logger.warning(message, 'LATENCY')
    if (typeof logger.warn === 'function') return logger.warn(message, 'LATENCY')
  }
  if (typeof logger.debug === 'function') logger.debug(message, 'LATENCY')
}

const logLatency = (logger, tracker, stage, extra = {}, options = {}) => {
  if (!tracker || !config.chatLatencyLog) return false
  if (!stage) stage = 'checkpoint'
  const key = `${stage}:${extra.reason || ''}`
  if (tracker.loggedStages.has(key)) return false
  const reasons = options.reason ? [options.reason] : slowReasons(tracker)
  const newReasons = reasons.filter(reason => !tracker.loggedSlowReasons.has(reason))
  const shouldWarn = options.forceWarning || newReasons.length > 0
  if (!shouldWarn && !options.debugNormal) return false
  tracker.loggedStages.add(key)
  if (shouldWarn) newReasons.forEach(reason => tracker.loggedSlowReasons.add(reason))
  const fields = buildLatencyFields(tracker, stage, {
    ...extra,
    slowReasons: reasons.join(',')
  })
  writeLog(logger, shouldWarn ? 'warning' : 'debug', `[chat latency] ${formatLogFields(fields)}`)
  return true
}

const markFirstUpstreamEvent = (tracker, logger, fields = {}) => {
  if (!tracker || tracker.marks.firstUpstreamEvent) return
  markLatency(tracker, 'firstUpstreamEvent', fields)
  logLatency(logger, tracker, 'first_upstream_event')
}

const markFirstDownstreamWrite = (tracker, logger, fields = {}) => {
  if (!tracker || tracker.marks.firstDownstreamWrite) return
  markLatency(tracker, 'firstDownstreamWrite', fields)
  logLatency(logger, tracker, 'first_downstream_write')
}

const markFirst = (tracker, logger, mark, stage, fields = {}) => {
  if (!tracker || tracker.marks[mark]) return
  markLatency(tracker, mark, fields)
  logLatency(logger, tracker, stage)
}

const markFirstUpstreamByte = (tracker, logger, fields = {}) => markFirst(
  tracker, logger, 'firstUpstreamByte', 'first_upstream_byte', fields
)

const markFirstParsedEvent = (tracker, logger, fields = {}) => markFirst(
  tracker, logger, 'firstParsedEvent', 'first_parsed_event', fields
)

const markFirstMeaningfulUpstreamDelta = (tracker, logger, fields = {}) => markFirst(
  tracker, logger, 'firstMeaningfulUpstreamDelta', 'first_meaningful_upstream_delta', fields
)

const markFirstProtocolWrite = (tracker, logger, fields = {}) => markFirst(
  tracker, logger, 'firstProtocolWrite', 'first_protocol_write', fields
)

const markFirstSemanticWrite = (tracker, logger, kind = 'content', fields = {}) => {
  markFirst(tracker, logger, 'firstSemanticWrite', 'first_semantic_write', { ...fields, downstreamKind: kind })
  const markByKind = {
    content: 'firstContentDelta',
    reasoning: 'firstReasoningDelta',
    tool: 'firstToolDelta',
    tool_calls: 'firstToolDelta'
  }
  const mark = markByKind[kind]
  if (mark) markFirst(tracker, logger, mark, `first_${kind}_delta`, fields)
}

const finalizeLatency = (logger, tracker, fields = {}) => {
  if (!tracker) return false
  markLatency(tracker, 'finalized', fields)
  return logLatency(logger, tracker, 'finalized', fields, { debugNormal: true })
}

module.exports = {
  createChatLatencyTracker,
  setLatencyFields,
  markLatency,
  addLatencyMetric,
  createLatencyHoldObserver,
  markFirstUpstreamEvent,
  markFirstDownstreamWrite,
  markFirstUpstreamByte,
  markFirstParsedEvent,
  markFirstMeaningfulUpstreamDelta,
  markFirstProtocolWrite,
  markFirstSemanticWrite,
  finalizeLatency,
  logLatency,
  buildLatencyFields,
  countPromptChars,
  messageStats
}
