/**
 * Anthropic 协议流式控制器共享基础设施
 *
 * 本模块存放 DeepSeek Anthropic 控制器（controllers/anthropic-deepseek.js）
 * 共用的流式处理工具函数与常量。
 *
 * # 与 shared/anthropic-helpers.js 的区别
 *
 *   - `anthropic-helpers.js`：纯函数，处理 Anthropic 协议数据结构（messages/tools/choice
 *     等的规范化与展开），无副作用、无 I/O 依赖
 *   - `anthropic-base.js`：流式处理工具，涉及 SSE writer、heartbeat、retry 等带状态/带 I/O
 *     的辅助逻辑，依赖 `utils/anthropic-sse-state.js`、`utils/strict-tool-mode.js` 等基础设施
 *
 * # 设计原则
 *
 *   - **provider 无关**：本模块不引用任何 `utils/dpsk-*` 模块
 *   - **provider 注入**：所有 provider 差异通过 options 参数注入（logTag / provider 名等）
 *   - **不持有全局状态**：所有函数均为纯函数或工厂函数，状态由调用方管理
 *
 * # 依赖关系
 *
 *   - utils/anthropic-sse-state.js（SSE writer）
 *   - utils/strict-tool-mode.js（fallback tool use）
 *   - utils/usage-tracker.js（usage attribution）
 *   - utils/tool-prompt.js（tool parser / preamble dropper）
 *   - agents/claude-code-profile.js（profile）
 *   - utils/logger.js
 */

const { logger } = require('../utils/logger');
const {
    createToolCallStreamParser,
    createPreambleDropper,
} = require('../utils/tool-prompt');
const { attributeChatUsage } = require('../utils/usage-tracker');
const claudeCodeProfile = require('../agents/claude-code-profile');

// ===========================================================================
// 常量
// ===========================================================================

/**
 * SSE 心跳间隔（毫秒）
 *
 * Anthropic SSE 流在长时间无数据时会被客户端/代理断开，
 * 每 12s 发送一个 `: ping` 注释行保活。
 */
const HEARTBEAT_MS = 12 * 1000;

/**
 * 只读工具名集合
 *
 * 当模型空响应时，会从用户提供的工具列表中筛选出只读工具，
 * 自动触发一个安全的只读 tool_use 作为 fallback（避免 Claude Code 误判任务结束）。
 */
const READONLY_FALLBACK_TOOL_NAMES = new Set(['read', 'ls', 'glob', 'grep', 'search', 'view', 'list']);

// ===========================================================================
// 纯 helper
// ===========================================================================

/**
 * 从工具列表中筛选出只读工具
 *
 * 用于空响应 fallback：只读工具（read/ls/glob/grep 等）无副作用，
 * 可以安全地自动触发，避免触发写工具（edit/write/bash）造成破坏。
 *
 * @param {Array<Object>} toolArray - OpenAI 风格工具列表
 * @returns {Array<Object>} 只读工具子集
 */
const filterReadonlyFallbackTools = (toolArray) => {
    if (!Array.isArray(toolArray)) return [];
    return toolArray.filter(t => {
        const name = String(t?.name || t?.function?.name || '').toLowerCase();
        return READONLY_FALLBACK_TOOL_NAMES.has(name);
    });
};

/**
 * 判断文本是否"实质为空"
 *
 * 去除空白和常见标点后判断是否还有有效字符。
 * 用于空响应 fallback 触发条件：模型只输出标点/空白时也视为空响应。
 *
 * @param {string} text - 待检测文本
 * @returns {boolean} 实质为空返回 true
 */
const isTextEssentiallyEmpty = (text) => {
    if (!text) return true;
    return text.replace(/[\s\.\,\!\?\:\;\-。，！？]/g, '').length === 0;
};

// ===========================================================================
// Heartbeat
// ===========================================================================

/**
 * 启动 Anthropic SSE 心跳
 *
 * 每 intervalMs 毫秒向 res 写入一个 `: ping\n\n` 注释行保活。
 * 客户端断开时自动静默（写入失败被 catch）。
 *
 * @param {Object} res - Express response 对象
 * @param {number} [intervalMs=HEARTBEAT_MS] - 心跳间隔（毫秒）
 * @returns {Function} stopHeartbeat — 停止心跳的函数
 */
function startHeartbeat(res, intervalMs = HEARTBEAT_MS) {
    const timer = setInterval(() => {
        try {
            if (!res.writableEnded && !res.destroyed) {
                res.write(': ping\n\n');
            }
        } catch (_) { /* client disconnected */ }
    }, intervalMs);
    return () => { clearInterval(timer); };
}

// ===========================================================================
// Tool parser 工厂
// ===========================================================================

/**
 * 构建 tool call 流式解析器
 *
 * 根据是否有工具与 profile 决定返回何种 parser：
 *   - 无工具：返回 null
 *   - 有工具 + Claude Code profile：返回 preambleDropper 包装的 parser
 *     （丢弃"我来看看"等过程话术，避免 CC 误判任务开始）
 *   - 有工具 + 其他 profile：返回裸 parser
 *
 * @param {Object} options
 * @param {boolean} options.hasTools - 是否启用了工具
 * @param {boolean} options.isClaudeCode - 是否为 Claude Code profile
 * @param {Set<string>} [options.toolNames] - 有效工具名集合（用于大小写不敏感归一化）
 * @returns {Object|null} toolParser 实例（无工具时为 null）
 */
function buildToolParser({ hasTools, isClaudeCode, toolNames, tools }) {
    const baseParser = hasTools
        ? createToolCallStreamParser({
            toolNames: toolNames || undefined,
            tools: Array.isArray(tools) ? tools : undefined,
        })
        : null;
    if (!baseParser) return null;
    if (toolNames && toolNames.size > 0 && typeof baseParser.setToolNames === 'function') {
        baseParser.setToolNames(toolNames);
    }
    if (Array.isArray(tools) && tools.length > 0 && typeof baseParser.setTools === 'function') {
        baseParser.setTools(tools);
    }
    if (isClaudeCode) {
        return createPreambleDropper(baseParser, claudeCodeProfile.looksLikeIntendsToCallTool);
    }
    return baseParser;
}

/**
 * 刷新 tool parser 的尾部缓冲
 *
 * 在流式响应结束时调用，将 parser 内部缓冲的未完成文本/工具调用 flush 出来。
 * flush 出的 textDelta 和 completedCalls 会通过 writer emit 给客户端。
 *
 * @param {Object|null} toolParser - buildToolParser 返回的 parser 实例
 * @param {Object} writer - Anthropic SSE writer
 */
function flushToolParser(toolParser, writer) {
    if (!toolParser) return;
    const tail = toolParser.flush();
    if (tail.textDelta && tail.textDelta.trim()) {
        writer.emitTextDelta(tail.textDelta);
    }
    if (tail.completedCalls.length > 0) {
        writer.writeToolCalls(tail.completedCalls);
    }
}

// ===========================================================================
// Retry answer 消费
// ===========================================================================

/**
 * 消费重试 generator 的完整文本响应
 *
 * 用于工具调用纠偏重试：把上游返回的 generator 完整消费，
 * 收集所有 text chunk 拼成完整文本，供后续 parseToolCallsFromText 解析。
 *
 * @param {AsyncGenerator} retryGen - 上游 chat generator
 * @param {Object} [options]
 * @param {Function} [options.isDisconnected] - 返回 true 时提前终止消费
 * @returns {Promise<string>} 完整文本
 */
async function consumeRetryAnswer(retryGen, options = {}) {
    const { isDisconnected } = options;
    let retryText = '';
    try {
        for await (const chunk of retryGen) {
            if (isDisconnected && isDisconnected()) return retryText;
            if (!chunk) continue;
            if (chunk.type === 'text') retryText += chunk.content;
        }
    } catch (_) { /* stream error leaves retryText partial */ }
    return retryText;
}

// ===========================================================================
// Usage attribution
// ===========================================================================

/**
 * 归因 Anthropic 响应的 token 使用量
 *
 * 仅在有可见输出（text 或 tool_use）时归因，
 * 避免空响应/错误响应被计入账号用量。
 *
 * 支持两种调用形态：
 *   - 流式：传入 writer，自动检查 `writer.hasVisibleOutput || writer.emittedAnyToolCall`
 *   - 同步：传入 hasOutput 布尔值（如 `fullText.trim() || hasToolUseBlock`）
 *
 * @param {Object} options
 * @param {Object} options.account - 账号对象
 * @param {number} options.inputTokens - 输入 token 数
 * @param {number} options.outputTokens - 输出 token 数
 * @param {string} options.provider - provider 名（'deepseek'）
 * @param {Object} [options.writer] - Anthropic SSE writer（流式路径）
 * @param {boolean} [options.hasOutput] - 是否有可见输出（同步路径）
 */
function attributeAnthropicUsage({ account, inputTokens, outputTokens, provider, model, writer, hasOutput }) {
    if (!account || !account.email) return;
    if (writer) {
        if (!(writer.hasVisibleOutput || writer.emittedAnyToolCall)) return;
    } else if (!hasOutput) {
        return;
    }
    attributeChatUsage(account, {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        estimated: true,
    }, {
        usageSource: 'estimated',
        provider,
        model: model || '',
    });
}

module.exports = {
    // ---- 常量 ----
    HEARTBEAT_MS,
    READONLY_FALLBACK_TOOL_NAMES,
    // ---- 纯 helper ----
    filterReadonlyFallbackTools,
    isTextEssentiallyEmpty,
    // ---- Heartbeat ----
    startHeartbeat,
    // ---- Tool parser ----
    buildToolParser,
    flushToolParser,
    // ---- Retry answer 消费 ----
    consumeRetryAnswer,
    // ---- Usage attribution ----
    attributeAnthropicUsage,
};
