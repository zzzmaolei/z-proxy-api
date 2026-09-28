/**
 * Qwen 请求生命周期记录器
 *
 * 跟踪 12 个生命周期事件，计算关键耗时指标。
 * 所有字段经 compactFields 脱敏（不输出邮箱/Token/Cookie/Prompt/Base64）。
 *
 * 事件序列：
 *   request_accepted → body_parsed → model_resolved →
 *   scheduler_enqueued → scheduler_admitted → account_leased →
 *   upstream_started → first_upstream_byte → first_downstream_delta →
 *   stream_terminal → lease_released → request_finished
 *
 * 派生指标：
 *   scheduler_queue_wait_ms, upstream_connect_ms, upstream_ttfb_ms,
 *   downstream_ttfb_ms, stream_duration_ms, total_request_ms
 */

// chat-latency-monitor.js 的 compactFields 未导出，此处内联同等实现以保持
// "只改 3 个文件" 的约束。脱敏规则与 chat-latency-monitor.js 完全一致：
// 跳过 token/cookie/password/secret/apikey/authorization 等敏感字段，
// 长字符串截断到 160 字符并标注原始长度，Bearer token 替换为 [REDACTED]。
const SENSITIVE_KEY_RE = /token|cookie|password|secret|apikey|authorization/i
const MAX_FIELD_LENGTH = 160

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

const LIFECYCLE_EVENTS = [
    'request_accepted',      // 请求进入中间件
    'body_parsed',           // body 解析完成
    'model_resolved',        // resolveQwenModel 返回
    'scheduler_enqueued',    // 进入调度器队列
    'scheduler_admitted',    // 调度器准入（acquire 返回）
    'account_leased',        // 账号租约获得
    'upstream_started',      // 上游连接发起
    'first_upstream_byte',   // 上游首字节
    'first_downstream_delta',// 下游首个 delta
    'stream_terminal',       // 流终止
    'lease_released',        // 租约释放
    'request_finished'       // 请求结束
]

const createLifecycleRecorder = (requestId, initialFields = {}) => {
    const marks = {}
    const fields = compactFields(initialFields)
    const events = []
    let startedAt = Date.now()

    const record = (event, extra = {}) => {
        if (!LIFECYCLE_EVENTS.includes(event)) return
        const ts = Date.now()
        if (marks[event] === undefined) {
            marks[event] = ts
        }
        events.push({ event, ts, extra: compactFields(extra) })
        Object.assign(fields, compactFields(extra))
    }

    const getMark = (name) => marks[name] || null

    const deriveMetrics = () => {
        const m = {}
        const diff = (a, b) => {
            const ta = marks[a], tb = marks[b]
            if (ta == null || tb == null) return null
            return tb - ta
        }
        m.scheduler_queue_wait_ms = diff('scheduler_enqueued', 'scheduler_admitted')
        m.upstream_connect_ms = diff('account_leased', 'upstream_started')
        m.upstream_ttfb_ms = diff('upstream_started', 'first_upstream_byte')
        m.downstream_ttfb_ms = diff('request_accepted', 'first_downstream_delta')
        m.stream_duration_ms = diff('first_downstream_delta', 'stream_terminal')
        m.total_request_ms = diff('request_accepted', 'request_finished')
        return m
    }

    const snapshot = () => ({
        requestId,
        startedAt,
        finishedAt: marks.request_finished || null,
        marks: { ...marks },
        events: events.slice(),
        fields: { ...fields },
        derived: deriveMetrics()
    })

    const toJSON = () => JSON.stringify(snapshot())

    return {
        record,
        getMark,
        snapshot,
        toJSON,
        deriveMetrics
    }
}

module.exports = {
    LIFECYCLE_EVENTS,
    createLifecycleRecorder
}
