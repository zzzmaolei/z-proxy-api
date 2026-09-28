/**
 * Qwen 路线 Anthropic 协议共享辅助函数
 *
 * 本模块存放 Qwen 后端在处理 Anthropic /v1/messages 时使用的纯函数与共享逻辑，
 * 被 backends/qwen/anthropic-stream-handler.js 和 anthropic-sync-handler.js 共用。
 *
 * # 为什么不在 shared/anthropic-helpers.js
 *
 * shared/anthropic-helpers.js 只放"协议级"纯函数（normalize / flatten / profile 检测），
 * 不依赖任何 provider 后端。本模块的函数都和 Qwen 上游（sendChatRequest）、
 * strict-tool-mode、tool-prompt 解析器强耦合，属于 Qwen 后端专属逻辑。
 *
 * # 设计原则
 *
 *   - 不持有 req/res 状态：所有函数接受 plain object 入参
 *   - 不直接写 SSE：交给 stream/sync handler 处理
 *   - 依赖 Qwen 后端：可 import sendChatRequest / strictToolMode / tool-prompt
 */
const { sendChatRequest } = require('./request.js');
const {
    parseToolCallsFromText,
    parseLooseToolCallsFromText,
    resolveToolName,
    stripInternalToolBlocks,
    appendHintToLastMessage
} = require('../../utils/tool-prompt.js');
const { logger } = require('../../utils/logger');
const strictToolMode = require('../../utils/strict-tool-mode.js');
const SSEFrameParser = require('../../utils/sse-frame-parser');
const { consumeUpstreamStream, isQwenTerminalEvent } = require('./upstream-consumer.js');
const claudeCodeProfile = require('../../agents/claude-code-profile.js');
const { buildRequiredRetryHint, buildUnknownToolCallHint, requiresToolCall } = require('../../shared/tool-injection');
// 复用 shared/anthropic-base.js 的纯函数，消除与 DeepSeek 路线的重复定义
const {
    isTextEssentiallyEmpty,
} = require('../../shared/anthropic-base');

// ===========================================================================
// Profile 相关判定（Qwen 专属，非协议级）
// ===========================================================================

/**
 * 判定当前 profile 是否要求"严格工具调用"
 * @param {Object} profile
 * @returns {boolean}
 */
const isStrictToolUse = (profile) => {
    return !!(profile && profile.profile && profile.profile.strictToolUse)
}

/**
 * 判定当前 profile 是否要求"解析到 tool_use 时丢弃 preamble"
 * @param {Object} profile
 * @returns {boolean}
 */
const shouldDropToolPreamble = (profile) => {
    return !!(profile && profile.profile && profile.profile.dropToolPreamble)
}

/**
 * strict tool mode 是否启用
 *
 * 旧的 chat-backed 桥接只用 strictToolUse 做 parser 过滤（工具名必须匹配 availableTools，
 * 但失败纠偏不会变成硬阻塞响应）。新版 strict-tool-mode 硬阻塞
 * （`strict_tool_mode_no_tool_call`）会在 Qwen Web 返回普通叙述而非 XML 时立即让 Claude Code
 * 不可用。保持硬模式 opt-in；默认 chat 模式必须能像 known-good backup 一样降级。
 * @param {boolean} hasTools
 * @param {string|Object} toolChoice
 * @param {Object} profile
 * @returns {boolean}
 */
const isStrictToolModeActive = (hasTools, toolChoice, profile) => {
    return process.env.QWEN_STRICT_TOOL_MODE === 'true'
        && !!hasTools
        && toolChoice !== 'none'
        && isStrictToolUse(profile)
}

// ===========================================================================
// 工具列表过滤与 strict mode 重试
// ===========================================================================

// filterReadonlyFallbackTools / READONLY_FALLBACK_TOOL_NAMES 复用自 shared/anthropic-base.js

/**
 * 在 strict tool mode 下解析并（必要时）重试得到最终 toolCalls / cleanedText
 *
 * 流程：
 *   1) classifyBuffer 判定当前 buffer 是 TOOL_USE / FINAL_ANSWER / 需重试
 *   2) 触发重试时调用 consumeRetryAnswer(upstreamResp.response) 拉取新 answer
 *   3) 仍无有效 tool_use 时尝试 readonly fallback（read/ls/glob/grep ...）
 *   4) 兜底返回 NO_TOOL_CALL，cleanedText 设为 strict mode 错误提示
 *
 * @param {Object} params
 * @returns {Promise<Object>}
 */
const resolveToolCallsWithStrictMode = async ({
    rawAnswer,
    requestBody,
    toolNames,
    rawTools,
    rawMessages,
    currentAccount,
    consumeRetryAnswer,
    maxRetries,
    requestId
}) => {
    let answer = rawAnswer || ''
    let decision = strictToolMode.classifyBuffer(answer, toolNames)
    let retryUsed = false
    let fallbackUsed = false
    let blocked = false
    let retryPromptTokens = 0
    let retryCompletionTokens = 0
    let account = currentAccount
    let attemptsUsed = 0

    const isTerminal = () => (
        decision.kind === strictToolMode.DECISION.TOOL_USE ||
        decision.kind === strictToolMode.DECISION.FINAL_ANSWER
    )

    while (!isTerminal()
        && strictToolMode.RETRY_TRIGGERING_KINDS.has(decision.kind)
        && attemptsUsed < Math.max(0, Number(maxRetries) || 0)) {
        attemptsUsed += 1
        retryUsed = true
        const hint = strictToolMode.buildStrictRetryHint(decision, {
            tools: rawTools,
            badOutput: answer
        })
        const retryBody = strictToolMode.appendStrictRetryHint(requestBody, hint)
        logger.warning?.(
            `Anthropic strict tool retry requestId=${requestId || '-'} attempt=${attemptsUsed} reason=${decision.kind}`,
            'ANTHROPIC'
        )
        try {
            const retryResp = await sendChatRequest(retryBody, null, { account })
            if (!retryResp.status || !retryResp.response) break
            account = retryResp.currentAccount || account
            const retryResult = await consumeRetryAnswer(retryResp.response)
            answer = retryResult.answer || ''
            retryPromptTokens += Number(retryResult.promptTokens) || 0
            retryCompletionTokens += Number(retryResult.completionTokens) || 0
            decision = strictToolMode.classifyBuffer(answer, toolNames)
        } catch (error) {
            logger.error('Anthropic strict tool retry failed', 'ANTHROPIC', '', error)
            break
        }
    }

    if (!isTerminal()) {
        // 反代层不构造 fallback 工具调用，也不伪造错误阻断响应。
        // 模型没输出工具调用就如实返回文本，由 harness 决定下一步。
        decision = {
            kind: strictToolMode.DECISION.NO_TOOL_CALL,
            toolCalls: [],
            cleanedText: answer || '',
            reason: 'no-tool-call-from-model'
        }
    }

    return {
        parsed: {
            toolCalls: decision.toolCalls || [],
            cleanedText: decision.cleanedText || ''
        },
        rawAnswer: answer,
        decision,
        retryUsed,
        fallbackUsed,
        blocked,
        retryPromptTokens,
        retryCompletionTokens,
        currentAccount: account
    }
}

// ===========================================================================
// 重试提示词构造
// ===========================================================================

/**
 * 在请求体中追加用于 required 重试的强制提示
 * @param {Object} body - 内部请求体
 * @param {string} hint - 重试提示词
 * @returns {Object} 新请求体
 */
const appendRetryHint = (body, hint) => appendHintToLastMessage(body, hint)

/**
 * Detect whether raw model text looks like an attempted tool call.
 * Normal final answers and explanations should not trigger this path.
 * @param {string} text - 模型原始输出
 * @returns {boolean}
 */
const looksLikeToolCallAttempt = (text) => {
    if (typeof text !== 'string' || text.length === 0) return false
    // <tool_call> XML 块
    if (text.includes('<tool_call>')) return true
    // 裸 JSON object / array 形态：含 name 字段
    if (/["'](?:name|tool|function)["']\s*:\s*["'][^"']{1,80}["']/.test(text)
        && /["'](?:arguments|args|parameters|input)["']\s*:/.test(text)) {
        return true
    }
    return false
}

// Tool-intent and final-answer heuristics 来自 profile，保持 generic Anthropic 行为松散
const looksLikeIntendsToCallTool = claudeCodeProfile.looksLikeIntendsToCallTool
const looksLikeFinalReport = claudeCodeProfile.looksLikeFinalReport

// isTextEssentiallyEmpty 复用自 shared/anthropic-base.js

// ===========================================================================
// Tool call 解析
// ===========================================================================

/**
 * Parse toolCandidateBuffer as XML first, then loose JSON.
 * strictToolUse enforces the request's available tool names; generic
 * Anthropic keeps the more permissive legacy behavior.
 * @param {string} buffer - 待解析文本
 * @param {Set<string>} toolNames - 可用工具名集合
 * @param {Object} [options]
 * @param {boolean} [options.strictToolUse=true] - 是否严格按 toolNames 过滤；false 时不做大小写不敏感以外的限制
 * @returns {{ toolCalls: Array<Object>, cleanedText: string }}
 */
const extractToolCallsFromBuffer = (buffer, toolNames, options = {}) => {
    const strict = options.strictToolUse !== false
    if (typeof buffer !== 'string' || buffer.length === 0) {
        return { toolCalls: [], cleanedText: '' }
    }
    // 1) XML 解析
    const xml = parseToolCallsFromText(buffer)
    let toolCalls = xml.toolCalls
    let cleanedText = stripInternalToolBlocks(xml.cleanedText)
    if (toolCalls.length > 0 && toolNames.size > 0 && strict) {
        const filtered = toolCalls
            .map(c => {
                const resolved = resolveToolName(c?.function?.name, toolNames)
                if (!resolved) return null
                return { ...c, function: { ...c.function, name: resolved } }
            })
            .filter(Boolean)
        if (filtered.length > 0) {
            return { toolCalls: filtered, cleanedText }
        }
    }
    if (toolCalls.length > 0 && (toolNames.size === 0 || !strict)) {
        return { toolCalls, cleanedText }
    }
    // 2) 宽松 JSON 解析
    const loose = parseLooseToolCallsFromText(stripInternalToolBlocks(buffer), Array.from(toolNames))
    if (loose.toolCalls.length > 0) {
        return { toolCalls: loose.toolCalls, cleanedText: stripInternalToolBlocks(loose.cleanedText || '') }
    }
    return { toolCalls: [], cleanedText: stripInternalToolBlocks(cleanedText || buffer) }
}

// ===========================================================================
// 上游 SSE 消费
// ===========================================================================

/**
 * Consume Qwen's axios stream and invoke onDelta for each parsed SSE JSON.
 * Stream edge cases stay centralized in consumeUpstreamStream.
 * @param {object} upstream - axios stream 响应
 * @param {(json: Object) => Promise<void>|void} onDelta - 单个 delta 回调
 * @param {(rawEvent: Object) => void} [onParseError] - 解析错误回调
 * @returns {Promise<void>} 完成 Promise
 */
const consumeUpstream = (upstream, onDelta, onParseError, options = {}) => consumeUpstreamStream({
    upstream,
    parser: new SSEFrameParser(),
    logger,
    onEvent: onDelta,
    onError: onParseError,
    signal: options.signal,
    isTerminalEvent: options.isTerminalEvent || isQwenTerminalEvent,
    isEndOfStreamTerminal: options.isEndOfStreamTerminal || (() => true),
    onFirstByte: options.onFirstByte
})

module.exports = {
    // profile 判定
    isStrictToolUse,
    shouldDropToolPreamble,
    isStrictToolModeActive,
    // strict mode
    resolveToolCallsWithStrictMode,
    // 重试提示词
    appendRetryHint,
    requiresToolCall,
    buildRequiredRetryHint,
    buildUnknownToolCallHint,
    looksLikeToolCallAttempt,
    looksLikeIntendsToCallTool,
    looksLikeFinalReport,
    isTextEssentiallyEmpty,
    // tool call 解析
    extractToolCallsFromBuffer,
    // 上游消费
    consumeUpstream,
}
