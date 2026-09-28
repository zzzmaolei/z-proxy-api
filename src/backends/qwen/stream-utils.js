/**
 * Qwen OpenAI 协议流式处理共享工具
 *
 * 供以下三方共用：
 *   - backends/qwen/stream-handler.js（流式处理）
 *   - backends/qwen/sync-handler.js（同步处理）
 *   - controllers/chat.js（编排层 catch 兜底）
 *
 * 与 backends/stream-utils.js（DeepSeek 通用）的区别：
 *   - 本文件专注 OpenAI 兼容协议（chat.completion.chunk 格式）
 *   - 心跳间隔 12s（OpenAI 客户端常用值），DeepSeek 为 120s
 *   - 已开始的流发生错误时中断 transport，避免伪造正常结束
 *   - 非流式 keepalive 用 JSON whitespace（OpenAI 风格），非 SSE
 *
 * 从 src/controllers/chat.js 提取，保持纯函数语义，不持有运行时状态。
 */
const config = require('../../config/index.js');
const { requiresToolCall, buildRequiredRetryHint } = require('../../shared/tool-injection.js');

const DEFAULT_HEARTBEAT_MS = 12 * 1000;

/**
 * 启动 OpenAI SSE 心跳定时器
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 * @param {number} [intervalMs=DEFAULT_HEARTBEAT_MS] - 心跳间隔
 * @returns {() => void} stop 函数
 */
const startOpenAIHeartbeat = (res, intervalMs = DEFAULT_HEARTBEAT_MS) => {
    const timer = setInterval(() => {
        try {
            if (!res.writableEnded && !res.destroyed) {
                res.write(`: ping\n\n`)
            }
        } catch (_) { /* client disconnected */ }
    }, intervalMs)
    return () => {
        clearInterval(timer)
    }
}

/**
 * 非流式 keepalive：按需写 JSON whitespace 保活
 * JSON 解析允许前置空白，最终 payload 仍由 writeJsonPayload 一次性写入。
 * 只在 NONSTREAM_KEEPALIVE_INTERVAL_MS>0 时启用。
 * @param {import('http').ServerResponse} res
 * @returns {() => void} stop 函数
 */
const startNonStreamKeepalive = (res) => {
    const intervalMs = Number(config.nonStreamKeepaliveIntervalMs) || 0
    if (intervalMs <= 0) return () => {}
    const timer = setInterval(() => {
        try {
            if (!res.writableEnded && !res.destroyed) {
                res.write('\n')
            }
        } catch (_) { /* client disconnected */ }
    }, intervalMs)
    const stop = () => clearInterval(timer)
    try { res.once?.('close', stop) } catch (_) {}
    return stop
}

/**
 * 写 JSON 响应（兼容 headersSent 与否）
 * @param {import('http').ServerResponse} res
 * @param {Object} payload
 */
const writeJsonPayload = (res, payload) => {
    const body = JSON.stringify(payload)
    if (res.headersSent) {
        res.end(body)
    } else {
        res.json(payload)
    }
}

/**
 * 写 OpenAI 流式错误 + [DONE] 并结束响应
 * @param {import('http').ServerResponse} res
 * @param {Error|Object} error
 * @param {Object} [options]
 * @param {string} [options.code] - 错误码
 * @param {string} [options.messageId] - chatcmpl 消息 ID
 */
const writeOpenAIStreamErrorAndDone = (res, error, options = {}) => {
    try {
        if (!res || res.writableEnded || res.destroyed) return
        const errMsg = error?.message || String(error || 'Unknown error')
        const errorChunk = {
            error: {
                message: errMsg,
                type: 'upstream_error',
                code: options.code || 'upstream_error',
                ...(options.upstreamCode ? { upstream_code: options.upstreamCode } : {})
            }
        }
        res.write(`data: ${JSON.stringify(errorChunk)}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
    } catch (_) {
        try { res.destroy?.() } catch (__) { /* ignore */ }
    }
}

/**
 * 从上游 delta 提取图片 markdown 列表
 * 常规聊天在触发 image_gen_tool 时，仅使用 image_list 中用于展示的图片链接。
 * @param {Object} delta - 上游 SSE delta
 * @returns {string[]} markdown 图片链接列表
 */
const getImageMarkdownListFromDelta = (delta) => {
    const imageList = []
    const displayImages = delta?.extra?.image_list || []

    for (const item of displayImages) {
        if (item?.image) {
            imageList.push(`![image](${item.image})`)
        }
    }

    return imageList
}

/**
 * 判断 delta.phase 是否为 thinking 阶段
 *
 * Qwen Web API 的 thinking 模型有两个 phase：
 *   - `'think'`：传统 thinking 输出，content 字段直接包含 thinking 文本
 *   - `'thinking_summary'`：summary 阶段，content 为空，真实文本在
 *     `delta.extra.summary_thought.content[]` 累积数组里
 *
 * @param {string} [phase] - 上游 delta.phase
 * @returns {boolean}
 */
const isThinkingPhase = (phase) => phase === 'think' || phase === 'thinking_summary'

/**
 * 从 thinking_summary 事件的 extra.summary_thought.content 提取 thinking 增量文本
 *
 * Qwen Web API 的 thinking_summary 事件 payload 特征：
 *   - `delta.content` 为空字符串或 undefined
 *   - 真实 thinking 文本在 `delta.extra.summary_thought.content`
 *   - 该字段是**累积数组**：每次事件包含全部历史 thinking，例如
 *     ["A", "AB", "ABC"]，每个元素都是全量文本
 *
 * 本函数用相邻两元素的差值计算增量（latest.slice(prev.length)），
 * 避免重复输出全量文本导致 Claude Code 收到重复的 thinking_delta。
 * 原地修改 delta.content（若需要），返回是否填充过。
 *
 * @param {Object} delta - 上游 SSE delta（会被原地修改）
 * @returns {boolean} 是否填充了 delta.content
 */
const extractThinkingSummaryDelta = (delta) => {
    if (!delta) return false
    if (delta.phase !== 'thinking_summary') return false
    if (delta.content) return false // 已有 content，无需提取
    const thoughts = delta.extra?.summary_thought?.content
    if (!thoughts) return false

    if (Array.isArray(thoughts)) {
        if (thoughts.length === 0) return false
        // 累积数组：取最后一个元素作为全量文本，与前一个元素做 diff 得到增量
        const latest = String(thoughts[thoughts.length - 1] || '')
        const prev = thoughts.length > 1 ? String(thoughts[thoughts.length - 2] || '') : ''
        const incremental = latest.slice(prev.length)
        if (!incremental) return false // 没有新内容，跳过
        delta.content = incremental
        return true
    }
    // 兜底：非数组形态直接转字符串（理论上游不会出现，但保持容错）
    delta.content = String(thoughts || '')
    return true
}

// requiresToolCall / buildRequiredRetryHint 从 shared/tool-injection.js 导入并重新导出
// （shared 版本支持 retryCount 渐进增强，与 dpsk-chat 行为一致）

module.exports = {
    startOpenAIHeartbeat,
    startNonStreamKeepalive,
    writeJsonPayload,
    writeOpenAIStreamErrorAndDone,
    getImageMarkdownListFromDelta,
    isThinkingPhase,
    extractThinkingSummaryDelta,
    requiresToolCall,
    buildRequiredRetryHint,
};
