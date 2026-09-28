/**
 * DeepSeek 聊天控制器
 * 提供 OpenAI 兼容的 /v1/chat/completions 接口
 * 将请求转发到 DeepSeek Web Chat API
 *
 * 设计要点（对齐 Qwen 路线）：
 *  - 工具调用：通过 buildToolSystemPrompt 注入工具提示词，让 DeepSeek 输出 <tool_call> 块
 *  - 消息折叠：使用 foldToolMessages 把 assistant.tool_calls / role=tool 折叠成 <tool_call>/<tool_response> XML
 *  - 流式解析：使用 createToolCallStreamParser 实时解析 <tool_call> 块并转成 OpenAI tool_calls delta
 *  - 非流式解析：使用 parseToolCallsFromText 从完整回复中提取工具调用
 *  - tool_choice=required 重试：首次未触发工具调用时追加 hint 重试多次
 *  - Claude Code 适配：检测到 claude-code profile 时启用更严格的工具模式提示
 *  - 真正的 SSE 流式：基于 dpsk-client.js 的 parseDeepSeekSSE
 *
 * Agent 请求启用 DeepSeek Web session 连续性：首轮发送完整历史，后续只发送
 * 新增 tool result / user 消息，并携带上游返回的 numeric parent_message_id。
 * 普通 OpenAI 请求仍保持请求级隔离。
 *  - XML 格式历史：用 foldToolMessages（保留 <tool_call> 标签）代替 prose 格式
 */
const { logger } = require('../utils/logger');
const config = require('../config');
const dpskClient = require('../backends/deepseek/dpsk-client');
const dpskAccount = require('../backends/deepseek/dpsk-account');
const dpskScheduler = require('../backends/deepseek/scheduler-singleton');
const { normalizeError, sendOpenAIError } = require('../utils/provider-errors');
const { handleStreamResponse } = require('../backends/deepseek/stream-handler');
const { handleSyncResponse } = require('../backends/deepseek/sync-handler');
const {
    extractFileContentFromContentArray,
    hasFilesInMessages,
} = require('../utils/chat-helpers');
const {
    buildToolSystemPrompt,
    buildHermesToolSystemPrompt,
    foldToolMessages,
    foldToolMessagesForChatBackend,
    createToolCallStreamParser,
    parseToolCallsFromText,
    parseLooseToolCallsFromText,
    resolveToolName,
    stripInternalToolBlocks,
    appendHintToLastMessage,
    createPreambleDropper,
} = require('../utils/tool-prompt');
const { attributeChatUsage } = require('../utils/usage-tracker.js');
const { countTokens } = require('../utils/precise-tokenizer.js');
const { withRetry } = require('../shared/retry');
const { injectToolPromptToLastUser, requiresToolCall, buildRequiredRetryHint, buildEmptyResponseRetryHint, buildGenericNoToolCallHint } = require('../shared/tool-injection');
const { detectProfileSafe } = require('../shared/client-detection');
const { normalizeLeaseOutcome } = require('../shared/lease-outcome');
const { accountLogId } = require('../utils/account-log-id');

const { resolveProxyUrl } = require('../utils/proxy-helper');
const dpskFingerprint = require('../backends/deepseek/dpsk-fingerprint');
const { getDpskDefaultModel } = require('./dpsk-models');
const {
    measurePromptBudget,
} = require('../backends/deepseek/prompt-budget');
const { shouldCompressToolHistory: shouldCompressToolHistoryFromConfig } = require('../backends/deepseek/history-policy');
const {
    SESSION_CACHE_TTL,
    accountAffinityCache,
    buildSessionKey,
    shouldUseDeepSeekSession,
    getCachedSession,
    prepareIncrementalMessages,
    commitSessionTurn,
    invalidateSession,
    createRequestSession,
    buildPrompt,
} = require('../backends/deepseek/anthropic-utils');

// Responses compatibility flushes its lifecycle event before entering the
// provider controller. Header telemetry is best-effort in that path; never
// turn a successful stream into ERR_HTTP_HEADERS_SENT just because metadata
// arrived after the response was committed.
function setResponseHeaderIfMutable(res, name, value) {
    if (!res || res.headersSent) return false;
    try {
        res.set(name, String(value));
        return true;
    } catch (error) {
        if (error?.code === 'ERR_HTTP_HEADERS_SENT') return false;
        throw error;
    }
}

// ========== 工具调用 ==========

/**
 * 检测是否为 Codex / Hermes / Continue 等 harness 客户端
 */
const isCodexClient = (req) => {
    try {
        const headers = (req && req.headers) || {};
        const ua = String(headers['user-agent'] || '').toLowerCase();
        // OpenCode / Codex / Hermes / Continue：编程 harness，默认关上游 web search，
        // 避免抢占本机 bash/read/glob 工具链路（OpenCode 实测会大量带 tools 调 DS）。
        if (ua.includes('codex') || ua.includes('opencode') || ua.includes('open-code')) return true;
        if (ua.includes('hermes')) return true;
        if (ua.includes('continue')) return true;
        const xClient = String(headers['x-client-name'] || '').toLowerCase();
        if (xClient.includes('codex') || xClient.includes('opencode') || xClient.includes('open-code')) return true;
        if (xClient.includes('hermes')) return true;
        if (xClient.includes('continue')) return true;
        const xApp = String(headers['x-app-name'] || '').toLowerCase();
        if (xApp.includes('codex') || xApp.includes('opencode') || xApp.includes('open-code')) return true;
        if (xApp.includes('hermes')) return true;
        if (xApp.includes('continue')) return true;
        if (headers['x-codex-session-id'] || headers['x-codex-thread-id']) return true;
        if (headers['x-opencode-session-id'] || headers['x-opencode-thread-id']) return true;
        return false;
    } catch (_) {
        return false;
    }
};

const getToolName = (tool) => String(tool?.function?.name || tool?.name || '').trim();

const resolveDeepSeekSearchPolicy = ({ searchEnabled, clientProfile, isCodex, tools } = {}) => {
    const isHarnessClient = clientProfile?.name === 'claude-code'
        || clientProfile?.name === 'hermes-agent'
        || isCodex === true;
    const hasAgentWebSearchTool = Array.isArray(tools)
        && tools.some(tool => /^web[_-]?search$/i.test(getToolName(tool)));
    const preferAgentSearch = isHarnessClient && hasAgentWebSearchTool;
    const effectiveSearchEnabled = preferAgentSearch
        ? false
        : (typeof searchEnabled === 'boolean' ? searchEnabled : !isHarnessClient);
    return {
        isHarnessClient,
        hasAgentWebSearchTool,
        preferAgentSearch,
        effectiveSearchEnabled,
    };
};

/**
 * 从内容数组中提取文本
 */
function extractContentFromArray(contentArray) {
    return extractFileContentFromContentArray(contentArray, { includeImages: false });
}

/**
 * 清洗消息，移除 DeepSeek 上游不接受的字段（原地修改）
 * - 删除 reasoning_content（DeepSeek Web API 不支持）
 * - 空 content + 有 tool_calls 的消息补占位文本
 * @param {Array<Object>} messages
 */
function sanitizeMessagesForDeepSeek(messages) {
    for (const m of messages) {
        delete m.reasoning_content;
        if ((!m.content || (typeof m.content === 'string' && !m.content.trim()))
            && m.tool_calls && m.tool_calls.length > 0) {
            m.content = '[Tool calls]';
        }
    }
}

// ========== Session 管理 & Prompt 构建 ==========
// SESSION_CACHE_TTL / accountAffinityCache / buildSessionKey / createRequestSession / buildPrompt
// 复用自 backends/deepseek/anthropic-utils.js，消除 controller 与 backend 的重复实现。
// buildSessionKey 传 { route: 'openai' } 启用客户端 sessionId 检测；
// buildPrompt 传 { contentExtractor: extractContentFromArray } 保留文件内容提取行为。

/**
 * 对话是否已进入多轮 tool 阶段（history 里已有 tool_calls / role=tool）
 * 用于决定是否注入「完整工具 XML」还是「短 reminder」。
 */
function conversationHasToolHistory(messages) {
    if (!Array.isArray(messages)) return false;
    return messages.some((m) => {
        if (!m) return false;
        if (m.role === 'tool') return true;
        if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return true;
        if (typeof m.content === 'string' && /<\/?tool_(?:call|response|invoke)/i.test(m.content)) return true;
        return false;
    });
}

/**
 * 多轮 tool 会话用的短工具提示：只保留格式 + 工具名列表，
 * 避免每轮把 20KB+ 的完整 tool XML 再塞进已经膨胀的 history。
 * （DS Web 约 50K+ tokens / ~200KB prompt 后易空 SSE；全量 tools 定义是主要可压缩项之一，
 *  且不触碰 tool_result 正文——符合「不截断 tool_result」铁律。）
 */
function buildCompactToolSystemPrompt(tools, options = {}) {
    if (!Array.isArray(tools) || tools.length === 0) return '';
    const names = tools
        .map((t) => (t && (t.name || t.function?.name)) || '')
        .filter(Boolean);
    const compactSchemas = tools.map((tool) => {
        const fn = tool?.function || tool || {};
        const params = fn.parameters || fn.input_schema || {};
        const props = params && typeof params === 'object' && params.properties && typeof params.properties === 'object'
            ? params.properties
            : {};
        const required = new Set(Array.isArray(params.required) ? params.required : []);
        const fields = Object.entries(props).map(([key, schema]) => {
            const type = Array.isArray(schema?.type) ? schema.type.filter(Boolean).join('|') : (schema?.type || 'any');
            return `${key}${required.has(key) ? '!' : '?'}:${type}`;
        });
        const name = String(fn.name || tool?.name || 'tool').replace(/[\r\n]/g, ' ').trim();
        return `- ${name}(${fields.join(', ')})`;
    });
    return [
        '# Tools (compact multi-turn)',
        'Use <tool_call>{"name":"TOOL","arguments":{...}}</tool_call> when a tool is needed.',
        ...compactSchemas,
        names.length ? `Allowed names: ${names.join(', ')}` : '',
        'Use exact argument keys and valid JSON. If no tool is needed, answer normally.',
        options.disableParallelToolUse ? 'Emit at most one tool call in this turn.' : '',
        options.toolChoice === 'required' ? 'A tool call is required in this turn.' : '',
        options.toolChoice && typeof options.toolChoice === 'object' && options.toolChoice.function?.name
            ? `Call ${String(options.toolChoice.function.name)} in this turn.`
            : '',
    ].filter(Boolean).join('\n');
}

/**
 * 注入工具提示时避免 double-append：
 * compact 路径不再额外 appendToolFormatReminder。
 */
function applyToolPromptToMessages(prepared, toolPrompt, tools, { compact }) {
    if (!toolPrompt) return;
    injectToolPromptToLastUser(prepared, toolPrompt);
}

// DeepSeek Web 经验阈值（字节，UTF-8 近似）
//  - 约 200KB ≈ 50K tokens 附近上游常返回空 SSE
//  - 180KB 起停止无意义 transport 重试
//  - L4 实测在 45–70KB 就会「只做一点就断」：多半不是硬顶墙，而是
//    全量 history + 多轮 tool 噪声让模型不调工具 / 参数乱 / 客户端中止。
//    因此在更低阈值做「历史软压缩」（不碰最新 tool 结果全文）。
/** 超过该消息数或历史体积时，压缩较早的 tool 结果 */
const DPSK_HISTORY_SOFT_MSG_COUNT = 10;
const DPSK_HISTORY_KEEP_TAIL_MSGS = 8;
const DPSK_TOOL_RESULT_SOFT_CHARS = 1200;

/**
 * 估计消息列表文本体积（粗略）
 * @param {Array} messages
 * @returns {number}
 */
function estimateMessagesBytes(messages) {
    if (!Array.isArray(messages)) return 0;
    let n = 0;
    for (const m of messages) {
        if (!m) continue;
        if (typeof m.content === 'string') n += Buffer.byteLength(m.content);
        else if (Array.isArray(m.content)) {
            for (const c of m.content) {
                if (c && typeof c.text === 'string') n += Buffer.byteLength(c.text);
                if (c && c.type === 'tool_result' && c.content) n += Buffer.byteLength(String(c.content));
            }
        }
        if (Array.isArray(m.tool_calls)) {
            n += Buffer.byteLength(JSON.stringify(m.tool_calls));
        }
    }
    return n;
}

/**
 * 软压缩多轮 tool 历史：保留任务意图 + 最近若干条完整消息，
 * 把更早的 role=tool / 过长 tool 文本收成短摘要。
 *
 * 注意：这是「组网页 prompt 时」的压缩，不是对客户端回传的 tool_result 截断。
 * 最新 KEEP_TAIL 条消息保持原样，保证当前步骤上下文完整。
 *
 * @param {Array} messages
 * @returns {{ messages: Array, compressed: boolean, droppedToolChars: number }}
 */
function softCompressToolHistory(messages) {
    if (!Array.isArray(messages) || messages.length <= DPSK_HISTORY_KEEP_TAIL_MSGS) {
        return { messages, compressed: false, droppedToolChars: 0 };
    }
    if (!conversationHasToolHistory(messages)) {
        return { messages, compressed: false, droppedToolChars: 0 };
    }

    const bytes = estimateMessagesBytes(messages);
    const should = messages.length >= DPSK_HISTORY_SOFT_MSG_COUNT || bytes >= 40000;
    if (!should) return { messages, compressed: false, droppedToolChars: 0 };

    const headCount = Math.min(3, Math.max(1, messages.length - DPSK_HISTORY_KEEP_TAIL_MSGS));
    const tailStart = Math.max(headCount, messages.length - DPSK_HISTORY_KEEP_TAIL_MSGS);
    let droppedToolChars = 0;

    const shrinkContent = (m, force) => {
        if (!m) return m;
        const clone = { ...m };
        if (clone.role === 'tool' || force) {
            const raw = typeof clone.content === 'string'
                ? clone.content
                : (Array.isArray(clone.content) ? clone.content.map((c) => c?.text || '').join('') : String(clone.content || ''));
            if (raw.length > DPSK_TOOL_RESULT_SOFT_CHARS) {
                droppedToolChars += raw.length - DPSK_TOOL_RESULT_SOFT_CHARS;
                const name = clone.name || 'tool';
                clone.content =
                    `[earlier ${name} result compressed for DeepSeek Web stability; ${raw.length} chars]\n` +
                    raw.slice(0, 400) +
                    '\n…\n' +
                    raw.slice(-400);
            }
        } else if (typeof clone.content === 'string' && clone.content.length > 4000 && clone.role === 'assistant') {
            // 旧 assistant 长叙述压缩
            droppedToolChars += clone.content.length - 1500;
            clone.content = clone.content.slice(0, 800) + '\n…[earlier assistant text compressed]…\n' + clone.content.slice(-400);
        }
        return clone;
    };

    const out = [];
    for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (i < headCount) {
            // 保留开头用户任务，轻微压缩超长 system/user
            if (m && typeof m.content === 'string' && m.content.length > 6000) {
                out.push({ ...m, content: m.content.slice(0, 5000) + '\n…[task text head kept]…' });
            } else {
                out.push(m);
            }
        } else if (i >= tailStart) {
            out.push(m); // 最近轮次完整保留（含完整 tool_result）
        } else {
            out.push(shrinkContent(m, true));
        }
    }

    // 中间插入一条系统向说明，避免模型以为历史丢了
    if (droppedToolChars > 0 && out.length > headCount) {
        out.splice(headCount, 0, {
            role: 'user',
            content:
                '[z.proxy.api] Earlier tool outputs were compressed to fit DeepSeek Web. ' +
                'Continue the task using the recent messages; re-read files if you need full content.',
        });
    }

    return { messages: out, compressed: droppedToolChars > 0, droppedToolChars };
}

function shouldCompressToolHistory() {
    return shouldCompressToolHistoryFromConfig(config);
}

/**
 * 增量 prompt 构建。
 *
 * 注意：createRequestSession 每次新建 session 且 lastMessageId=null，
 * 因此 hasHistory 在现行策略下几乎恒为 false → 始终走全量消息。
 * OpenCode 每轮也会带完整 history，prompt 会随 tool_result 暴涨。
 * 多轮 tool 时改用 compact 工具提示，避免「历史 + 完整 tools XML」双倍膨胀。
 * 另：softCompressToolHistory 压早轮 tool 噪声，让 L4 多撑几轮。
 */
function buildIncrementalPrompt(messages, toolSystemPrompt, cachedSession, tools, options = {}) {
    const continuityEnabled = options.continuityEnabled !== false;
    const selection = continuityEnabled
        ? prepareIncrementalMessages(messages, cachedSession, options.contextFingerprint || '')
        : { messages, isFull: true, reset: false, reason: 'continuity-disabled' };
    const multiTurnTools = conversationHasToolHistory(messages)
        && Array.isArray(tools)
        && tools.length > 0;
    const effectiveToolPrompt = multiTurnTools
        ? buildCompactToolSystemPrompt(tools, {
            toolChoice: options.toolChoice,
            disableParallelToolUse: options.disableParallelToolUse,
        })
        : toolSystemPrompt;

    // Compact tool schemas are safe to use on multi-turn requests. Shrinking
    // actual historical tool output is deliberately opt-in because it changes
    // the model-visible task data and may silently remove required evidence.
    const shouldCompressHistory = selection.isFull && conversationHasToolHistory(messages)
        && Array.isArray(tools) && tools.length > 0 && shouldCompressToolHistory();
    const { messages: slimMessages, compressed, droppedToolChars } = shouldCompressHistory
        ? softCompressToolHistory(selection.messages)
        : { messages: selection.messages, compressed: false, droppedToolChars: 0 };
    if (compressed) {
        logger.info(
            `[DPSK] soft-compress tool history: msgs ${messages.length}→${slimMessages.length}, dropped~${droppedToolChars} chars`,
            'DPSK',
        );
    }

    const prepared = foldToolMessages(slimMessages);
    applyToolPromptToMessages(prepared, effectiveToolPrompt, tools, { compact: multiTurnTools });
    return {
        prompt: buildPrompt(prepared, {
            contentExtractor: extractContentFromArray,
            canonicalEnvelope: !!effectiveToolPrompt,
        }),
        isFull: selection.isFull,
        compactTools: multiTurnTools,
        historyCompressed: compressed,
        reset: selection.reset,
        selectionReason: selection.reason,
    };
}

/**
 * 完整 prompt 构建（Codex/Responses API / Hermes Agent 用）：包含所有消息 + 工具定义
 *
 * Hermes Agent 模式下：工具提示词以系统消息注入（不是拼到最后一条 user 消息），
 * 让模型明确"这是系统级格式约束，必须覆盖其他工具使用指南"。
 */
function buildFullPrompt(messages, toolSystemPrompt, tools, options = {}) {
    const prepared = foldToolMessages(messages);
    const compactTools = conversationHasToolHistory(messages)
        && Array.isArray(tools)
        && tools.length > 0;
    const effectiveToolPrompt = compactTools
        ? buildCompactToolSystemPrompt(tools, {
            toolChoice: options.toolChoice,
            disableParallelToolUse: options.disableParallelToolUse,
        })
        : toolSystemPrompt;
    if (effectiveToolPrompt) {
        injectToolPromptToLastUser(prepared, effectiveToolPrompt);
    }
    return {
        prompt: buildPrompt(prepared, {
            contentExtractor: extractContentFromArray,
            canonicalEnvelope: !!effectiveToolPrompt,
        }),
        isFull: true,
        compactTools,
    };
}

// ========== 主入口 ==========

/**
 * POST /v1/dpsk/chat/completions
 * OpenAI 兼容的聊天补全接口
 */
async function chatCompletions(req, res) {
    const startTime = Date.now();
    const {
        messages: rawMessages,
        stream = false,
        thinking_enabled,
        search_enabled,
        tools,
        tool_choice,
        reasoning_effort,
        thinking,
        max_tokens,
    } = req.body;

    // 清洗消息：对缺失或空 tool_call_id 的 tool 消息进行合成保全，杜绝 400 阻断
    const messages = Array.isArray(rawMessages)
        ? rawMessages.map((msg, idx) => {
            if (msg && msg.role === 'tool' && (!msg.tool_call_id || String(msg.tool_call_id).trim() === '')) {
                return { ...msg, tool_call_id: `call_synth_${Date.now()}_${idx}` };
            }
            return msg;
        })
        : rawMessages;

    let model = req.body.model;
    if (!model) {
        model = await getDpskDefaultModel();
    }
    if (!model) {
        // 实时获取也失败，返回 400 错误而非用硬编码
        return res.status(400).json({ error: { message: 'Model is required and could not be determined automatically', type: 'invalid_request_error' } });
    }

    // 解析模型选项
    // 效果优先：默认跟随 DPSK_THINK_EFFORT（config.dpskThinkEffort，常为 high）。
    // 救火开关：DPSK_HARNESS_THINKING=0 时，OpenCode/Claude Code 等 harness 默认关 thinking
    //（多轮 tool 不稳时用）。客户端显式 reasoning_effort / thinking / thinking_enabled 始终优先。
    const clientProfileEarly = detectProfileSafe(req);
    const isHarnessEarly = clientProfileEarly.name === 'claude-code'
        || clientProfileEarly.name === 'hermes-agent'
        || isCodexClient(req);
    const harnessThinkingEnv = String(process.env.DPSK_HARNESS_THINKING || '').toLowerCase();
    const harnessForceOff = isHarnessEarly && (harnessThinkingEnv === '0' || harnessThinkingEnv === 'false' || harnessThinkingEnv === 'off');
    const cachedCapability = dpskClient.getModelCapabilities?.(model) || null;
    const modelVariant = dpskClient.getModelVariant?.(model) || 'base';
    let effectiveReasoningEffort = reasoning_effort || null;
    const hasExplicitThinkingChoice = typeof thinking_enabled === 'boolean'
        || (thinking && typeof thinking === 'object'
            && (thinking.type === 'enabled' || thinking.type === 'disabled'));
    if (!effectiveReasoningEffort && !hasExplicitThinkingChoice) {
        if ((cachedCapability && cachedCapability.thinking_enabled === false)
            || modelVariant === 'flash' || modelVariant === 'fast') {
            // A settings-backed flash/disabled variant is already an explicit
            // model choice. The global default effort must not turn it back on.
            effectiveReasoningEffort = null;
        } else if (harnessForceOff) {
            effectiveReasoningEffort = 'low'; // resolveModelOptions: low → thinking off
        } else {
            effectiveReasoningEffort = config.dpskThinkEffort;
        }
    }
    const modelOptions = dpskClient.resolveModelOptions(model, {
        reasoningEffort: effectiveReasoningEffort,
        thinking,
    });
    const requestedMaxTokens = (typeof max_tokens === 'number' && max_tokens > 0) ? max_tokens : null;
    const declaredMaxOutputTokens = Number(modelOptions.capabilities?.max_output_tokens);
    const maxOutputCap = Number.isFinite(declaredMaxOutputTokens) && declaredMaxOutputTokens > 0
        ? declaredMaxOutputTokens
        : null;
    const appliedMaxTokens = Math.min(requestedMaxTokens || 128000, maxOutputCap || Number.MAX_SAFE_INTEGER);
    let modelType = modelOptions.modelType;
    let thinkingEnabled = (typeof thinking_enabled === 'boolean')
        ? thinking_enabled
        : modelOptions.thinkingEnabled;
    if (harnessForceOff
        && typeof thinking_enabled !== 'boolean' && thinking == null && !reasoning_effort) {
        thinkingEnabled = false;
    }
    if (modelOptions.capabilities?.thinking_supported === false) {
        thinkingEnabled = false;
    }

    setResponseHeaderIfMutable(res, 'x-dpsk-model-type', modelType);
    setResponseHeaderIfMutable(res, 'x-dpsk-thinking-enabled', thinkingEnabled);
    const thinkingSupport = modelOptions.capabilities?.thinking_supported;
    setResponseHeaderIfMutable(
        res,
        'x-dpsk-thinking-supported',
        thinkingSupport == null ? 'unknown' : thinkingSupport,
    );
    setResponseHeaderIfMutable(res, 'x-dpsk-capability-source', modelOptions.capabilitySource || 'heuristic');
    if (modelOptions.capabilities?.context_window) {
        setResponseHeaderIfMutable(res, 'x-dpsk-context-window', modelOptions.capabilities.context_window);
    }
    if (modelOptions.capabilities?.max_output_tokens) {
        setResponseHeaderIfMutable(res, 'x-dpsk-max-output-tokens', modelOptions.capabilities.max_output_tokens);
    }
    if (modelOptions.capabilities?.input_character_limit) {
        setResponseHeaderIfMutable(res, 'x-dpsk-input-character-limit', modelOptions.capabilities.input_character_limit);
    }
    if (effectiveReasoningEffort) {
        setResponseHeaderIfMutable(res, 'x-dpsk-reasoning-effort', String(effectiveReasoningEffort).toLowerCase());
    }
    setResponseHeaderIfMutable(res, 'x-dpsk-requested-max-tokens', requestedMaxTokens == null ? 'unset' : requestedMaxTokens);
    setResponseHeaderIfMutable(res, 'x-dpsk-applied-max-tokens', appliedMaxTokens);

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: { message: 'messages 是必需的', type: 'invalid_request_error' } });
    }

    // 清洗消息：移除 reasoning_content、补全空 content 的 tool_use 消息
    sanitizeMessagesForDeepSeek(messages);

    // The scheduler must cancel queued work when the client disconnects.
    const requestAbortController = new AbortController();
    const onRequestAbort = () => requestAbortController.abort();
    const cleanupRequestAbort = () => {
        req.removeListener?.('aborted', onRequestAbort);
    };
    req._dpskAbortSignal = requestAbortController.signal;
    // `close` fires after a normally completed request body as well. Only
    // the `aborted` event represents a client abort before the response.
    req.once?.('aborted', onRequestAbort);
    res.once?.('finish', cleanupRequestAbort);
    res.once?.('close', cleanupRequestAbort);
    if (req.aborted) requestAbortController.abort();

    // Vision→Pro 代理：当用户选的是非 vision 模型但消息包含图片时，
    // 自动调 vision 模型描述图片，把描述注入到原模型消息中。
    // 用户无感：就像 pro 模型自己也"看到"了图片一样。
    // 如果代理流程任何一步失败 → 直接返回错误，不降级到 vision 模型。
    const hasImages = Array.isArray(messages) && messages.some(m => {
        if (!m || !Array.isArray(m.content)) return false;
        return m.content.some(c => c && (c.type === 'image_url' || c.type === 'image'));
    });

    if (hasImages && modelType !== 'vision') {
        logger.info(`[DPSK] Vision→Pro 代理: 检测到图片, model_type=${modelType}`, 'DPSK');

        let visionLease = null;
        let visionAccount = null;
        let visionOutcome = 'incomplete';
        try {
            visionLease = await dpskScheduler.acquire({
                requestedModel: model,
                baseModel: modelType,
                estimatedPromptBytes: Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8'),
                signal: req._dpskAbortSignal || null,
                deadline: Date.now() + (config.dpskQueueTimeoutMs || 120000),
            });
            visionAccount = visionLease?.account || null;
            if (!visionAccount || !visionAccount.token) {
                throw new Error('无可用账号进行图片上传');
            }

            // 上传图片到新 upload API（文件上传是通用操作，走默认模型类型）
            // 注意：uploadFilesFromMessages 等文件函数需透传 proxyUrl/fingerprint，
            // 否则配置代理的账号文件上传走直连会失败（见 dpsk-client.js 修复）
            const visionProxyUrl = resolveProxyUrl(visionAccount);
            const visionFingerprint = dpskFingerprint.getFingerprint(visionAccount.email);
            const visionFileIds = await dpskClient.uploadFilesFromMessages(visionAccount.token, messages, {
                modelType,
                proxyUrl: visionProxyUrl,
                fingerprint: visionFingerprint,
                signal: req._dpskAbortSignal || null,
            });
            if (!visionFileIds || visionFileIds.length === 0) {
                throw new Error('图片上传失败');
            }

            // 轮询等待文件解析
            const pollResults = [];
            for (const fid of visionFileIds) {
                const info = await dpskClient.pollFileStatus(visionAccount.token, fid, 15, {
                    proxyUrl: visionProxyUrl,
                    fingerprint: visionFingerprint,
                    signal: req._dpskAbortSignal || null,
                });
                pollResults.push(info);
            }
            const readyIds = visionFileIds.filter((_, i) => pollResults[i]?.status === 'SUCCESS');
            if (readyIds.length === 0) {
                throw new Error('图片解析超时');
            }

            // 调 vision 模型获取描述
            const descriptions = [];
            for (const fid of readyIds) {
                const desc = await dpskClient.describeImageWithVision(visionAccount.token, fid, {
                    proxyUrl: visionProxyUrl,
                    fingerprint: visionFingerprint,
                    signal: req._dpskAbortSignal || null,
                });
                if (desc) descriptions.push(desc);
            }
            if (descriptions.length === 0) {
                throw new Error('Vision 模型无法描述图片');
            }

            const combinedDesc = descriptions.join('\n');
            logger.info(`[DPSK] Vision→Pro 代理: 获取到 ${descriptions.length} 条描述 (${combinedDesc.length} 字符)`, 'DPSK');

            // 替换消息中的图片内容为描述文本
            for (const msg of messages) {
                if (!msg || !Array.isArray(msg.content)) continue;
                const newContent = msg.content.filter(c => c && c.type !== 'image_url' && c.type !== 'image');
                if (msg.role === 'user' && newContent.length > 0) {
                    const lastText = newContent[newContent.length - 1];
                    if (lastText && lastText.type === 'text') {
                        lastText.text += `\n\n[用户上传了一张图片，图片内容描述：${combinedDesc}]`;
                    } else {
                        newContent.push({ type: 'text', text: `[用户上传了一张图片，图片内容描述：${combinedDesc}]` });
                    }
                }
                msg.content = newContent;
            }
            logger.info(`[DPSK] Vision→Pro 代理: 描述注入完成`, 'DPSK');
            visionOutcome = 'success';
        } catch (visionProxyErr) {
            if (visionProxyErr?.code === 'CLIENT_ABORTED') {
                if (!res.headersSent) return res.status(499).json({ error: { message: 'Client disconnected', type: 'client_aborted' } });
                try { res.end(); } catch (_) { /* ignore */ }
                return;
            }
            if (visionProxyErr?.status === 429 || visionProxyErr?.status === 503) {
                setResponseHeaderIfMutable(res, 'Retry-After', visionProxyErr?.headers?.['Retry-After'] || '30');
                return res.status(visionProxyErr.status).json({
                    error: { message: visionProxyErr.message || 'DeepSeek scheduler unavailable', type: 'api_error' },
                });
            }
            const errMsg = `模型 ${model} 不支持图片输入，且 Vision→Pro 图片代理失败: ${visionProxyErr.message}`;
            logger.warn(`[DPSK] ${errMsg}`, 'DPSK');
            return res.status(400).json({
                error: {
                    message: errMsg,
                    type: 'invalid_request_error',
                }
            });
        } finally {
            // Vision upload/poll/describe owns a separate provider lease.
            if (visionLease) {
                try { visionLease.release(visionOutcome); } catch (_) { /* idempotent */ }
            }
        }
    }

    // 检测客户端 profile
    const clientProfile = detectProfileSafe(req);
    const isClaudeCode = clientProfile.name === 'claude-code';
    const isCodex = isCodexClient(req);
    logger.debug(`[DPSK] client profile: ${clientProfile.name} (source=${clientProfile.source}), codex=${isCodex}`, 'DPSK');

    // 模型名若指定了 search 语义（如 -search/-online 为 true，或 flash/think 基础命名显式声明为 false）
    let requestedSearch = search_enabled;
    if (typeof search_enabled !== 'boolean' && typeof modelOptions.searchRequested === 'boolean') {
        requestedSearch = modelOptions.searchRequested;
    }

    // 对 harness 客户端默认关闭 DeepSeek Web 端联网搜索，优先走 harness 自带工具。
    const searchPolicy = resolveDeepSeekSearchPolicy({
        searchEnabled: requestedSearch,
        clientProfile,
        isCodex,
        tools,
    });
    const {
        isHarnessClient,
        hasAgentWebSearchTool,
        preferAgentSearch,
        effectiveSearchEnabled,
    } = searchPolicy;
    setResponseHeaderIfMutable(res, 'x-dpsk-search-enabled', effectiveSearchEnabled);
    if (isHarnessClient || hasAgentWebSearchTool) {
        logger.info(`[DPSK] harness client (${clientProfile.name}), upstream web search=${effectiveSearchEnabled}, `
            + `agent web_search=${hasAgentWebSearchTool}, agent preferred=${preferAgentSearch}`, 'DPSK');
    }

    // 处理工具调用
    const hasTools = Array.isArray(tools) && tools.length > 0;
    let toolSystemPrompt = '';

    if (hasTools) {
        const hasUserImage = Array.isArray(messages) && messages.some(m => {
            if (!m || !Array.isArray(m.content)) return false;
            return m.content.some(c => c && (c.type === 'image_url' || c.type === 'image'));
        });

        // Hermes Agent 使用专用工具系统提示词
        if (clientProfile.name === 'hermes-agent') {
            toolSystemPrompt = buildHermesToolSystemPrompt(tools, {
                tool_choice: tool_choice || 'auto',
                disableParallelToolUse: !!req.body.disable_parallel_tool_use,
                provider: 'deepseek',
                preferAgentSearch,
            });
            logger.info(`[DPSK] Hermes Agent 工具调用已启用: ${tools.length} 个工具, tool_choice=${JSON.stringify(tool_choice)}`, 'DPSK');
        } else {
            toolSystemPrompt = buildToolSystemPrompt(tools, {
                tool_choice: tool_choice || 'auto',
                claudeCodeProfile: isClaudeCode,
                codexProfile: isCodex,
                provider: 'deepseek',
                hasUserImage,
                disableParallelToolUse: !!req.body.disable_parallel_tool_use,
                openAIProtocolHint: true,
                preferAgentSearch,
            });

            logger.info(`[DPSK] 工具调用已启用: ${tools.length} 个工具, tool_choice=${JSON.stringify(tool_choice)}, claude_code=${isClaudeCode}`, 'DPSK');
        }
    }

    // session key 在选中账号后构建（含账号 email）：
    // 账号轮换换到 B 时，B 的 token 不能复用 A 创建的 DeepSeek session。
    let cachedSession;
    let sessionKey = null;

    // === 账号轮换重试逻辑 ===
    const triedEmails = [];
    const maxRetries = 20;
    let lastError = null;

    // 文件上传移到 retry 循环内按需执行：确保上传账号与聊天账号一致（避免 invalid ref file id）
    let refFileIds = [];
    const chatOptions = {
        thinkingEnabled,
        searchEnabled: effectiveSearchEnabled,
        modelType,
        refFileIds,
        maxTokens: appliedMaxTokens,
        proxyUrl: null,
        fingerprint: null,
    };
    // 记录已上传的 ref file id 及对应账号；账号未变则复用，避免重复上传
    let uploadedRefFileIds = null;
    let uploadedForEmail = null;
    // 判断 messages 是否含文件（图片或 file 附件）
    const hasFiles = Array.isArray(messages) && messages.some(m => {
        if (!m || !Array.isArray(m.content)) return false;
        return m.content.some(c => c && (c.type === 'image_url' || c.type === 'image' || c.type === 'file'));
    });

    // conversationKey 仅依赖 req/messages，循环内不变，提到循环外预计算
    const conversationKey = buildSessionKey(req, messages, '', { route: 'openai' });
    const continuityEnabled = shouldUseDeepSeekSession(req, {
        clientProfile,
        responsesApi: req._responsesApi === true,
    });

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        // 优先选择对话已关联的账号（保持对话连续性，避免 session 因账号切换而丢失）
        const excludeAccountIds = new Set();
        for (const email of triedEmails) {
            const accountId = dpskScheduler.getAccountIdByEmail(email);
            if (accountId) excludeAccountIds.add(accountId);
        }
        const schedulerForAttempt = dpskScheduler.getScheduler();
        if (!schedulerForAttempt || schedulerForAttempt.accounts.size === 0
            || (excludeAccountIds.size > 0
                && excludeAccountIds.size >= schedulerForAttempt.accounts.size)) {
            break;
        }
        const cachedAffinity = (config.dpskSessionAffinity !== false && conversationKey)
            ? accountAffinityCache.get(conversationKey)
            : null;
        const stickyAccountId = (cachedAffinity?.account && config.dpskSessionAffinity !== false)
            ? dpskScheduler.getAccountIdByEmail(cachedAffinity.account)
            : null;
        let lease;
        try {
            lease = await dpskScheduler.acquire({
                requestedModel: model,
                baseModel: modelType,
                estimatedPromptBytes: Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8'),
                sessionKey: config.dpskSessionAffinity !== false ? (conversationKey || null) : null,
                stickyAccountId,
                excludeAccountIds,
                signal: requestAbortController.signal,
                deadline: Date.now() + (config.dpskQueueTimeoutMs || 120000),
            });
        } catch (acquireErr) {
            if (acquireErr?.code === 'CLIENT_ABORTED') {
                if (!res.headersSent) return res.status(499).json({ error: { message: 'Client disconnected', type: 'client_aborted' } });
                try { res.end(); } catch (_) { /* ignore */ }
                return;
            }
            lastError = acquireErr;
            if (!res.headersSent) {
                res.setHeader('Retry-After', acquireErr?.headers?.['Retry-After'] || '30');
                const normalized = normalizeError(acquireErr, { provider: 'dpsk', model });
                normalized.statusCode = acquireErr?.status === 429 || acquireErr?.status === 503
                    ? acquireErr.status
                    : 503;
                return sendOpenAIError(res, normalized);
            }
            try { res.end(); } catch (_) { /* ignore */ }
            return;
        }
        const account = lease?.account;
        if (!account) {
            try { lease?.release('failure'); } catch (_) { /* idempotent */ }
            const msg = lastError
                ? `所有 DeepSeek 账号均不可用。最后错误: ${lastError.message}`
                : '没有可用的 DeepSeek 账号';
            if (!res.headersSent) {
                return sendOpenAIError(res, normalizeError(new Error(msg), { provider: 'dpsk', model }));
            }
            try { res.end(); } catch (_) { /* ignore */ }
            return;
        }

        const token = account.token;
        let leaseOutcome = 'incomplete';
        if (!token) {
            try { lease.release('failure'); } catch (_) { /* idempotent */ }
            triedEmails.push(account.email);
            lastError = new Error(`账号 ${account.email} 未登录或 token 已过期`);
            continue;
        }

        try {
            // 含账号 email 的 sessionKey：避免账号轮换后复用前一账号 token 创建的 session
            // 注意：赋值给外层 let sessionKey（行 411），不能再用 const 声明，
            // 赋值给外层 sessionKey，便于失败时清除对应账号亲和性。
            sessionKey = buildSessionKey(req, messages, account.email, { route: 'openai' });
            const proxyUrl = resolveProxyUrl(account);
            const fingerprint = dpskFingerprint.getFingerprint(account.email);
            chatOptions.proxyUrl = proxyUrl;
            chatOptions.fingerprint = fingerprint;

            const compressedMessages = messages;
            cachedSession = continuityEnabled
                ? getCachedSession(sessionKey, {
                    accountEmail: account.email,
                    modelType,
                    continuityEnabled,
                })
                : null;

            // Responses API (Codex) 请求使用完整 prompt + 工具定义，
            // 避免增量 prompt 的上下文重复问题。
            const built = req._responsesApi
                ? buildFullPrompt(compressedMessages, toolSystemPrompt, tools, {
                    toolChoice: tool_choice,
                    disableParallelToolUse: !!req.body.disable_parallel_tool_use,
                })
                : buildIncrementalPrompt(compressedMessages, toolSystemPrompt, cachedSession, tools, {
                    continuityEnabled,
                    toolChoice: tool_choice,
                    disableParallelToolUse: !!req.body.disable_parallel_tool_use,
                });
            if (built.reset && cachedSession) {
                invalidateSession(sessionKey, `history reset (${built.selectionReason || 'mismatch'})`, cachedSession);
                cachedSession = null;
            }
            const { prompt, isFull } = built;
            const compactTools = !!built.compactTools;
            const promptBudgetOptions = {
                modelCapabilities: modelOptions.capabilities,
            };
            const promptBudget = measurePromptBudget(prompt, {
                messageCount: compressedMessages.length,
                toolCount: hasTools ? tools.length : 0,
                hasToolHistory: conversationHasToolHistory(compressedMessages),
            }, promptBudgetOptions);
            const promptBytes = promptBudget.bytes;
            setResponseHeaderIfMutable(res, 'x-dpsk-prompt-bytes', promptBudget.bytes);
            setResponseHeaderIfMutable(res, 'x-dpsk-prompt-soft-limit-bytes', promptBudget.softLimit);
            setResponseHeaderIfMutable(res, 'x-dpsk-prompt-hard-limit-bytes', promptBudget.hardLimit);

            // 硬上限：超过 Web 上下文墙仍发请求只会空 SSE + transport 重试 → OpenCode 表现为 terminated
            if (promptBudget.status === 'hard_limit') {
                leaseOutcome = 'failure';
                const msg =
                    `DeepSeek Web 上下文过大 (${promptBytes}B ≥ ${promptBudget.hardLimit}B)。` +
                    `请新开会话或缩短 tool 输出后再试（Web 端约 50K+ tokens 易空流）。`;
                logger.warn(`[DPSK] prompt 超过硬上限，拒绝请求: ${promptBytes}B tools=${hasTools ? tools.length : 0} compact=${compactTools}`, 'DPSK');
                if (!res.headersSent) {
                    return res.status(413).json({
                        error: {
                            message: msg,
                            type: 'context_length_exceeded',
                            code: 'dpsk_prompt_too_large',
                            param: null,
                            prompt_bytes: promptBytes,
                            hard_limit_bytes: promptBudget.hardLimit,
                        },
                    });
                }
                try { res.end(); } catch (_) { /* ignore */ }
                return;
            }

            // Prompt 预算通过后才做文件上传；超长请求不能先消耗 PoW、文件
            // 上传或轮询资源。上传仍在账号循环内，保证 ref_file_ids 与聊天账号一致。
            if (hasFiles && (uploadedRefFileIds === null || uploadedForEmail !== account.email)) {
                try {
                    const fids = await dpskClient.uploadFilesFromMessages(token, messages, {
                        modelType,
                        proxyUrl,
                        fingerprint,
                        signal: req._dpskAbortSignal || null,
                    });
                    const readyIds = [];
                    if (fids && fids.length > 0) {
                        for (const fid of fids) {
                            try {
                                const info = await dpskClient.pollFileStatus(token, fid, 15, {
                                    proxyUrl,
                                    fingerprint,
                                    signal: req._dpskAbortSignal || null,
                                });
                                if (info && info.status === 'SUCCESS') readyIds.push(fid);
                            } catch (_) { /* 单个文件轮询失败跳过 */ }
                        }
                    }
                    uploadedRefFileIds = readyIds;
                    uploadedForEmail = account.email;
                } catch (uploadErr) {
                    logger.debug(`[DPSK] 文件上传失败，回退到 prompt 嵌入: ${uploadErr.message}`, 'DPSK');
                    uploadedRefFileIds = [];
                }
            }
            chatOptions.refFileIds = uploadedRefFileIds || [];

            // 预算通过后才创建 session，避免超长请求先消耗 PoW/session 资源。
            cachedSession = await createRequestSession(
                sessionKey,
                token,
                messages,
                modelType,
                account.email,
                proxyUrl,
                fingerprint,
                requestAbortController.signal,
                { continuityEnabled },
            );
            const chatSessionId = cachedSession.chatSessionId;
            if (conversationKey) accountAffinityCache.set(conversationKey, { account: account.email, createdAt: Date.now() });

            chatOptions.parentMessageId = continuityEnabled && !isFull
                ? cachedSession.lastMessageId
                : null;

            logger.info(
                `[DPSK] 会话: ${chatSessionId}, model: ${model} → ${modelType}, thinking: ${thinkingEnabled},` +
                ` tools: ${hasTools ? tools.length : 0}, account: ${accountLogId(account)}, attempt: ${attempt + 1},` +
                ` fullPrompt: ${isFull}, continuity: ${continuityEnabled}, parent: ${chatOptions.parentMessageId ?? '-'},` +
                ` compactTools: ${compactTools}, promptBytes: ${promptBytes}`,
                'DPSK',
            );

            const ctx = {
                req, res, token, account, chatSessionId, prompt, model,
                chatOptions, startTime, hasTools,
                toolChoice: tool_choice || 'auto',
                tools, clientProfile,
                cachedSession, sessionKey,
                sessionContinuity: continuityEnabled,
                sessionMessages: messages,
                sessionContextFingerprint: '',
                requestSignal: requestAbortController.signal,
                promptBytes,
                promptBudget,
                promptBudgetOptions,
                skipEmptyRetry: promptBudget.status !== 'ok',
            };

            if (stream) {
                const handlerResult = await handleStreamResponse(ctx);
                leaseOutcome = normalizeLeaseOutcome(handlerResult, {
                    requestSignal: requestAbortController.signal,
                    req,
                    res,
                });
                if (leaseOutcome === 'client_aborted' && !res.headersSent) {
                    return res.status(499).json({ error: { message: 'Client disconnected', type: 'client_aborted' } });
                }
                return handlerResult;
            } else {
                const handlerResult = await handleSyncResponse(ctx);
                leaseOutcome = normalizeLeaseOutcome(handlerResult, {
                    requestSignal: requestAbortController.signal,
                    req,
                    res,
                });
                if (leaseOutcome === 'client_aborted' && !res.headersSent) {
                    return res.status(499).json({ error: { message: 'Client disconnected', type: 'client_aborted' } });
                }
                return handlerResult;
            }
        } catch (err) {
            if (requestAbortController.signal.aborted || req.aborted || res.destroyed) {
                leaseOutcome = 'client_aborted';
                if (!res.headersSent) return res.status(499).json({ error: { message: 'Client disconnected', type: 'client_aborted' } });
                try { res.end(); } catch (_) { /* ignore */ }
                return;
            }
            // 账号被禁言
            if (err.bizCode === 5 || (err.bizData && err.bizData.is_muted)) {
                leaseOutcome = 'upstream_error';
                const muteUntil = err.bizData?.mute_until;
                if (muteUntil) {
                    dpskAccount.markAccountMuted(account.email, muteUntil);
                }
                triedEmails.push(account.email);
                lastError = err;
                logger.warn(`[DPSK] 账号 ${accountLogId(account)} 被禁言，尝试下一个账号 (attempt ${attempt + 1})`, 'DPSK');
                continue;
            }

            // 限流：429 / rate limit。轮换账号 + 给当前账号短期冷却避免下次又被选中
            if (err.message && (err.message.includes('429') || err.message.toLowerCase().includes('rate limit') || err.message.toLowerCase().includes('too many'))) {
                leaseOutcome = 'upstream_error';
                triedEmails.push(account.email);
                lastError = err;
                try { dpskAccount.markAccountFailed(account.email, 120 * 1000, '429/rate limit'); } catch (_) { /* ignore */ }
                logger.warn(`[DPSK] 账号 ${accountLogId(account)} 触发限流: ${err.message}，冷却 60s 后再用`, 'DPSK');
                continue;
            }

            // 认证错误（401/403/token）：仅排除当前账号并轮换下一个账号，不触发运行时重登，避免数美风控
            if (err.message && (err.message.includes('401') || err.message.includes('403') || err.message.includes('token'))) {
                leaseOutcome = 'upstream_error';
                triedEmails.push(account.email);
                lastError = err;
                logger.warn(`[DPSK] 账号 ${accountLogId(account)} 认证失效: ${err.message}，已排除并无感轮换下一个账号`, 'DPSK');
                continue;
            }

            // 会话过期/不合法：清除缓存，重试
            if (err.message && (err.message.includes('session') || err.message.includes('expired') || err.message.includes('not found') || err.message.includes('会话'))) {
                if (sessionKey) accountAffinityCache.delete(sessionKey);
                leaseOutcome = 'upstream_error';
                triedEmails.push(account.email);
                lastError = err;
                logger.warn(`[DPSK] 会话错误，清除缓存并重试 (${err.message.slice(0, 120)})`, 'DPSK');
                continue;
            }

            // 其它未分类错误：短暂冷却避免雪崩；终态 OpenAI 兼容错误响应
            leaseOutcome = 'failure';
            try { dpskAccount.markAccountFailed(account.email, 60 * 1000, 'unknown_error'); } catch (_) { /* ignore */ }
            logger.error('[DPSK] 聊天失败', 'DPSK', '', err);
            if (!res.headersSent) {
                return sendOpenAIError(res, normalizeError(err, { provider: 'dpsk', model }));
            }
            try { res.end(); } catch (_) { /* ignore */ }
            return;
        } finally {
            try { lease.release(leaseOutcome); } catch (_) { /* idempotent */ }
        }
    }

    if (!res.headersSent) {
        return sendOpenAIError(res, normalizeError(
            new Error(lastError ? `所有 DeepSeek 账号均不可用: ${lastError.message}` : '没有可用的 DeepSeek 账号'),
            { provider: 'dpsk', model }
        ));
    }
    try { res.end(); } catch (_) { /* ignore */ }
}

module.exports = {
    chatCompletions,
    shouldCompressToolHistory,
    setResponseHeaderIfMutable,
    _resolveDeepSeekSearchPolicy: resolveDeepSeekSearchPolicy,
    // Exported with an underscore for deterministic prompt-contract tests;
    // these helpers are not part of the HTTP controller API.
    _buildCompactToolSystemPrompt: buildCompactToolSystemPrompt,
    _buildIncrementalPrompt: buildIncrementalPrompt,
    _buildFullPrompt: buildFullPrompt,
    _conversationHasToolHistory: conversationHasToolHistory,
};
