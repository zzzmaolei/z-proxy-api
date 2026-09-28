/**
 * DeepSeek Anthropic 协议共享辅助
 *
 * 存放 DeepSeek 路线的每请求 session 创建、账号亲和性与 prompt 构建逻辑，
 * 被 backends/deepseek/anthropic-stream-handler.js 与 anthropic-sync-handler.js 共用。
 *
 * # 与 shared/anthropic-helpers.js 的区别
 *   - shared/anthropic-helpers.js：跨 provider 的 Anthropic 协议纯函数
 *   - backends/deepseek/anthropic-utils.js：DeepSeek 专属（账号亲和性、每请求 session、文本序列化）
 *
 * # 为什么需要本模块
 *   - DeepSeek Web session 有状态；完整 Prompt 的每次发送都必须创建新 session
 *   - DeepSeek 上游不接受 structured messages，需要 buildPrompt() 把消息数组
 *     序列化为 `system:...\n---\nuser:...` 的文本格式
 */

const crypto = require('node:crypto');
const { withRetry } = require('../../shared/retry');
const dpskClient = require('./dpsk-client');
const dpskScheduler = require('./scheduler-singleton');
const dpskFingerprint = require('./dpsk-fingerprint');
const config = require('../../config');
const { resolveProxyUrl } = require('../../utils/proxy-helper');
const { logger } = require('../../utils/logger');
const { serializePromptMessageRecord } = require('../../utils/tool-prompt');

// ===========================================================================
// 常量
// ===========================================================================

/** Session 缓存 TTL（30 分钟），与上游 chatSessionId 生命周期对齐 */
const SESSION_CACHE_TTL = 30 * 60 * 1000;

/** Request ID 前缀，便于日志区分 DeepSeek Anthropic 路线 */
const REQUEST_ID_PREFIX = 'dpsk_anth';

/** 账号亲和性缓存；用于调度器粘滞，不包含 prompt 或 token。 */
const accountAffinityCache = new Map();

/**
 * Agent 连续会话缓存。
 *
 * DeepSeek Web 保存 session 内的历史；连续会话必须由请求 header 或服务端
 * 配置显式开启。默认仍保持请求级隔离，避免把完整 history 重复写入同一
 * 个 Web session，造成第二轮短答或空流。
 */
const sessionCache = new Map();

function normalizeMessageId(value) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
    const text = String(value).trim();
    if (!text) return null;
    return /^\d+$/.test(text) ? Number(text) : text;
}

function messageFingerprint(message) {
    let serialized = '';
    try {
        serialized = JSON.stringify({
            role: message?.role || '',
            content: message?.content ?? '',
            name: message?.name || '',
            tool_call_id: message?.tool_call_id || '',
            tool_calls: message?.tool_calls || null,
        });
    } catch (_) {
        serialized = String(message?.content || '');
    }
    return crypto.createHash('sha256').update(serialized).digest('hex');
}

function fingerprintMessages(messages) {
    return Array.isArray(messages) ? messages.map(messageFingerprint) : [];
}

function normalizeSessionContext(value) {
    if (value === undefined || value === null) return '';
    return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function getExplicitClientSessionId(req) {
    const headers = req?.headers || {};
    const body = req?.body || {};
    const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {};
    const values = [
        headers['x-dpsk-session-id'],
        headers['x-hermes-session-id'],
        headers['x-opencode-session-id'],
        headers['x-opencode-thread-id'],
        headers['x-codex-session-id'],
        headers['x-codex-thread-id'],
        headers['x-session-id'],
        headers['x-thread-id'],
        headers['x-session-key'],
        headers['x-request-id'],
        headers['x-client-request-id'],
        headers['x-session-affinity'],
        metadata.session_id,
        metadata.sessionId,
        body.session_id,
        body.sessionId,
        body.conversation_id,
    ];
    for (const value of values) {
        if (value !== undefined && value !== null && String(value).trim()) {
            return String(value).trim().slice(0, 160);
        }
    }
    return '';
}

function shouldUseDeepSeekSession(req, options = {}) {
    if (options.disabled === true || options.responsesApi === true) return false;
    const headers = req?.headers || {};
    const rawOptIn = [
        headers['x-dpsk-session-continuity'],
        headers['x-dpsk-enable-session-continuity'],
    ].find(value => value !== undefined && value !== null && String(value).trim() !== '');
    if (rawOptIn !== undefined) {
        const normalized = String(rawOptIn).trim().toLowerCase();
        if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
        if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
    }

    // DeepSeek Web sessions are stateful. Do not infer continuation from an
    // agent profile or a client session id: most clients resend complete
    // history, and replaying it into a stateful Web session causes duplication
    // and short/empty second-turn responses. Enable inference only through an
    // explicit server-side opt-in.
    if (config.dpskEnableSessionContinuity !== true) return false;

    const profile = String(options.clientProfile?.name || req?.clientProfile?.name || '').toLowerCase();
    if (getExplicitClientSessionId(req) || profile === 'claude-code' || profile === 'hermes-agent') return true;
    const headerBlob = [headers['user-agent'], headers['x-client-name'], headers['x-app-name']]
        .map(value => String(value || '').toLowerCase()).join(' ');
    return /\b(opencode|open-code|codex|continue|hermes)\b/.test(headerBlob);
}

function evictExpiredSessions(now = Date.now()) {
    for (const [key, value] of sessionCache.entries()) {
        if (now - (value.lastUsedAt || value.createdAt || 0) > SESSION_CACHE_TTL) {
            sessionCache.delete(key);
        }
    }
}

function getCachedSession(sessionKey, { accountEmail, modelType, continuityEnabled = true } = {}) {
    if (!continuityEnabled || !sessionKey) return null;
    const current = sessionCache.get(sessionKey);
    if (!current) return null;
    const now = Date.now();
    if (now - (current.lastUsedAt || current.createdAt || 0) > SESSION_CACHE_TTL
        || (accountEmail && current.account !== accountEmail)
        || (modelType && current.modelType !== modelType)
        || current.lastMessageId === null
        || current.lastMessageId === undefined) {
        sessionCache.delete(sessionKey);
        return null;
    }
    current.lastUsedAt = now;
    return current;
}

function invalidateSession(sessionKey, reason = '', session = null) {
    if (!sessionKey) return;
    const current = sessionCache.get(sessionKey);
    if (!session || !current || current === session) {
        sessionCache.delete(sessionKey);
        if (reason) logger.info(`[DPSK] session invalidated: ${reason}`, 'DPSK');
    }
}

/**
 * Compare the client-provided history with the last accepted request and
 * return only the new tail. The assistant response generated by the previous
 * upstream turn is already inside Web session state, so it is omitted from the
 * delta; following tool results and new user messages are retained.
 */
function prepareIncrementalMessages(messages, session, contextFingerprint = '') {
    if (!session || session.lastMessageId === null || session.lastMessageId === undefined) {
        return { messages, isFull: true, reset: false, reason: 'no-session' };
    }
    const currentFingerprints = fingerprintMessages(messages);
    const previous = Array.isArray(session.historyFingerprints) ? session.historyFingerprints : [];
    const context = normalizeSessionContext(contextFingerprint);
    if (!previous.length || (session.contextFingerprint || '') !== context) {
        return { messages, isFull: true, reset: true, reason: 'context-changed' };
    }
    if (currentFingerprints.length <= previous.length) {
        return { messages, isFull: true, reset: true, reason: 'history-not-advanced' };
    }
    for (let index = 0; index < previous.length; index += 1) {
        if (currentFingerprints[index] !== previous[index]) {
            return { messages, isFull: true, reset: true, reason: 'history-prefix-mismatch' };
        }
    }

    const delta = messages.slice(previous.length);
    while (delta.length > 0 && delta[0]?.role === 'assistant') delta.shift();
    if (delta.length === 0) {
        return { messages, isFull: true, reset: true, reason: 'empty-delta' };
    }
    return { messages: delta, isFull: false, reset: false, reason: 'incremental' };
}

function commitSessionTurn(sessionKey, session, messages, {
    messageId,
    toolCalls = [],
    contextFingerprint = '',
    continuityEnabled = true,
} = {}) {
    if (!continuityEnabled || !sessionKey || !session) return false;
    const normalizedId = normalizeMessageId(messageId);
    if (normalizedId === null) {
        invalidateSession(sessionKey, 'response missing upstream message id', session);
        return false;
    }
    const target = sessionCache.get(sessionKey) || session;
    target.lastMessageId = normalizedId;
    target.historyFingerprints = fingerprintMessages(messages);
    target.acceptedMessageCount = Array.isArray(messages) ? messages.length : 0;
    target.contextFingerprint = normalizeSessionContext(contextFingerprint);
    target.lastResponseToolCalls = Array.isArray(toolCalls)
        ? toolCalls.map(call => ({
            id: call?.id || call?.function?.id || null,
            name: call?.function?.name || call?.name || null,
        }))
        : [];
    target.lastUsedAt = Date.now();
    target.turnCount = (target.turnCount || 0) + 1;
    sessionCache.set(sessionKey, target);
    evictExpiredSessions(target.lastUsedAt);
    return true;
}

// ===========================================================================
// 本地账号亲和性
// ===========================================================================

/**
 * 构建本地账号亲和性 key
 *
 * Key 格式：
 *   - Anthropic 路线（默认）：`dpsk:anth:<apiSuffix>:<email>:<userFirstMessageHash>`
 *   - OpenAI 路线（route='openai'）：`dpsk:<apiSuffix>:<email>:<hash>` 或
 *     `dpsk:<apiSuffix>:<email>:s:<clientSessionId>`（优先用客户端 sessionId）
 *
 * 优先基于第一条 user 消息的 hash 进行账号亲和性关联；找不到 user 消息则回退到 IP。
 * 该 key 仅用于本地账号选择，不用于复用 DeepSeek Web chatSessionId。
 * OpenAI 路线额外支持客户端 sessionId（x-hermes-session-id 等）以降低账号亲和性碰撞概率。
 *
 * @param {Object} req - Express 请求对象
 * @param {Array<Object>} messages - 已 flatten 的消息列表
 * @param {string} accountEmail - 当前账号邮箱
 * @param {Object} [options]
 * @param {string} [options.route='anthropic'] - 路线标识，'anthropic' 或 'openai'
 * @returns {string} 本地账号亲和性 key
 */
function buildSessionKey(req, messages, accountEmail, options = {}) {
    const { route = 'anthropic' } = options;
    const prefix = route === 'openai' ? 'dpsk' : 'dpsk:anth';
    const safeEmail = String(accountEmail || req?.account?.email || '').slice(0, 64);
    const safeApi = String(req?.apiKey || '').slice(-12);

    // 两条协议都优先使用客户端显式的会话标识。CcSwitch / Claude Code
    // 可能走 Anthropic 路线，不能只在 OpenAI 分支识别这些 header。
    const clientSessionId = getExplicitClientSessionId(req);
    if (clientSessionId) {
        return `${prefix}:${safeApi}:${safeEmail}:s:${clientSessionId}`;
    }

    if (Array.isArray(messages)) {
        for (let i = 0; i < messages.length; i++) {
            const m = messages[i];
            if (!m || m.role !== 'user') continue;
            let text = '';
            if (typeof m.content === 'string') text = m.content;
            else if (Array.isArray(m.content)) {
                for (const c of m.content) {
                    if (c && typeof c.text === 'string') text += c.text;
                }
            }
            if (text) {
                let h = 0;
                const s = String(text).slice(0, 64);
                for (let j = 0; j < s.length; j++) h = ((h << 5) - h + s.charCodeAt(j)) | 0;
                return `${prefix}:${safeApi}:${safeEmail}:${(h >>> 0).toString(36)}`;
            }
        }
    }
    const ip = (req && req.ip) || '';
    return `${prefix}:${safeApi}:${safeEmail}:ip:${ip}`;
}

/**
 * 为当前请求创建 DeepSeek Web session。
 *
 * 创建或复用 DeepSeek Web session。
 *
 * 只有显式 opt-in 的请求会走复用路径；普通请求仍每轮新建 session。
 * 复用时调用方必须配合 prepareIncrementalMessages() 只发送新增消息，
 * 并在响应完整结束后调用 commitSessionTurn() 保存新的 parent id。
 *
 * @param {string} sessionKey - buildSessionKey() 返回的本地账号亲和性 key
 * @param {string} token - 账号 token
 * @param {Array<Object>} messages - 已 flatten 的消息列表
 * @param {string} modelType - 模型类型（vision / chat / etc）
 * @param {string} accountEmail - 账号邮箱
 * @param {string} proxyUrl - 代理 URL
 * @param {Object} fingerprint - 账号指纹
 * @returns {Promise<Object>} 当前请求的 session 对象（含 chatSessionId / lastMessageId / createdAt 等）
 */
async function createRequestSession(sessionKey, token, messages, modelType, accountEmail, proxyUrl, fingerprint, signal = null, options = {}) {
    const continuityEnabled = options.continuityEnabled !== false;
    if (continuityEnabled) {
        const cached = getCachedSession(sessionKey, {
            accountEmail,
            modelType,
            continuityEnabled,
        });
        if (cached) return cached;
    }

    const now = Date.now();
    const session = await withRetry(
        () => dpskClient.createSession(token, proxyUrl, fingerprint, signal),
        { label: 'createSession-anthropic', logTag: 'DPSK' }
    );
    const newSession = {
        chatSessionId: session.id,
        lastMessageId: null,
        account: accountEmail || null,
        createdAt: now,
        lastUsedAt: now,
        modelType,
        continuityEnabled,
        historyFingerprints: [],
        contextFingerprint: '',
        turnCount: 0,
    };
    if (continuityEnabled && sessionKey) sessionCache.set(sessionKey, newSession);
    if (sessionKey) accountAffinityCache.set(sessionKey, { account: accountEmail || null, createdAt: now });
    if (accountAffinityCache.size % 10 === 0) {
        for (const [key, val] of accountAffinityCache.entries()) {
            if (now - val.createdAt > SESSION_CACHE_TTL) accountAffinityCache.delete(key);
        }
    }
    return newSession;
}

// ===========================================================================
// Vision→Pro 图片代理
// ===========================================================================

/**
 * 检测 flatMessages 中的图片并通过 Vision 模型描述（Vision→Pro 代理）
 *
 * Anthropic 协议下 DeepSeek 非 vision 模型不原生支持图片输入。当 flatMessages
 * 含 image_url 块且 modelType !== 'vision' 时，借用一个独立 vision 账号：
 *   1. uploadFilesFromMessages 上传图片
 *   2. pollFileStatus 轮询每个文件解析完成
 *   3. describeImageWithVision 调 vision 模型描述每个图片
 *   4. 把描述拼接到原 user 消息文本末尾（与 OpenAI 路线 dpsk-chat.js:287-377 一致）
 *   5. finally 释放 Vision scheduler lease（避免 inFlight 持续惩罚）
 *
 * 无图片 或 modelType === 'vision' → 直接返回原 flatMessages。
 * 任何步骤失败 → 抛错（由调用方决定如何响应，不静默吞掉）。
 *
 * @param {Array<Object>} flatMessages - 已 flatten 的 OpenAI 风格消息列表
 * @param {Object} options
 * @param {Object} options.account - 当前请求账号（排除自身后取 vision 账号）
 * @param {string} options.modelType - 当前模型类型
 * @param {string} options.proxyUrl - 当前账号代理 URL（透传，vision 账号另算）
 * @param {Object} options.fingerprint - 当前账号指纹（透传，vision 账号另算）
 * @param {string} options.requestId - 请求 ID（日志追踪）
 * @returns {Promise<Array<Object>>} 处理后的 flatMessages（图片描述已注入到 user 文本）
 */
async function detectImagesAndDescribe(flatMessages, {
    account,
    modelType,
    proxyUrl,
    fingerprint,
    requestId,
    signal = null,
} = {}) {
    // 检测是否有 image_url 块（flatten 后的 OpenAI 形态）
    const hasImages = Array.isArray(flatMessages) && flatMessages.some(m => {
        if (!m || !Array.isArray(m.content)) return false;
        return m.content.some(c => c && c.type === 'image_url');
    });

    // 无图片 或 已是 vision 模型 → 直接返回，不做代理
    if (!hasImages || modelType === 'vision') {
        return flatMessages;
    }

    logger.info(
        `[DPSK-Anth] Vision→Pro 代理: 检测到图片, model_type=${modelType}, requestId=${requestId}`,
        'DPSK',
    );

    let visionLease = null;
    let visionAccount = null;
    let visionOutcome = 'failure';
    const throwIfClientAborted = () => {
        if (!signal?.aborted) return;
        const error = new Error('Client disconnected');
        error.status = 499;
        error.code = 'CLIENT_ABORTED';
        throw error;
    };
    try {
        // 获取独立 vision 账号（排除当前账号避免占用同一账号配额）
        throwIfClientAborted();
        const excludeAccountIds = new Set();
        const primaryAccountId = account?.accountId
            || account?.id
            || (account?.email ? dpskScheduler.getAccountIdByEmail(account.email) : null);
        if (primaryAccountId) excludeAccountIds.add(primaryAccountId);
        visionLease = await dpskScheduler.acquire({
            requestedModel: modelType ? `deepseek-${modelType}` : 'deepseek-vision',
            baseModel: modelType || 'vision',
            estimatedPromptBytes: Buffer.byteLength(JSON.stringify(flatMessages || []), 'utf8'),
            excludeAccountIds,
            signal,
            deadline: Date.now() + (config.dpskQueueTimeoutMs || 120000),
        });
        throwIfClientAborted();
        visionAccount = visionLease?.account || null;
        if (!visionAccount || !visionAccount.token) {
            throw new Error('无可用账号进行图片上传');
        }

        // vision 账号独立的代理/指纹（与 OpenAI 路线 dpsk-chat.js:305-306 一致）
        const visionProxyUrl = resolveProxyUrl(visionAccount);
        const visionFingerprint = dpskFingerprint.getFingerprint(visionAccount.email);

        // 上传图片（文件函数需透传 proxyUrl/fingerprint，否则配置代理的账号走直连会失败）
        const visionFileIds = await dpskClient.uploadFilesFromMessages(visionAccount.token, flatMessages, {
            modelType,
            proxyUrl: visionProxyUrl,
            fingerprint: visionFingerprint,
            signal,
        });
        throwIfClientAborted();
        if (!visionFileIds || visionFileIds.length === 0) {
            throw new Error('图片上传失败');
        }

        // 轮询等待文件解析
        const pollResults = [];
        for (const fid of visionFileIds) {
            throwIfClientAborted();
            const info = await dpskClient.pollFileStatus(visionAccount.token, fid, 15, {
                proxyUrl: visionProxyUrl,
                fingerprint: visionFingerprint,
                signal,
            });
            throwIfClientAborted();
            pollResults.push(info);
        }
        const readyIds = visionFileIds.filter((_, i) => pollResults[i]?.status === 'SUCCESS');
        if (readyIds.length === 0) {
            throw new Error('图片解析超时');
        }

        // 调 vision 模型获取每张图片的描述
        const descriptions = [];
        for (const fid of readyIds) {
            throwIfClientAborted();
            const desc = await dpskClient.describeImageWithVision(visionAccount.token, fid, {
                proxyUrl: visionProxyUrl,
                fingerprint: visionFingerprint,
                signal,
            });
            throwIfClientAborted();
            if (desc) descriptions.push(desc);
        }
        if (descriptions.length === 0) {
            throw new Error('Vision 模型无法描述图片');
        }

        const combinedDesc = descriptions.join('\n');
        logger.info(
            `[DPSK-Anth] Vision→Pro 代理: 获取到 ${descriptions.length} 条描述 (${combinedDesc.length} 字符)`,
            'DPSK',
        );

        // 替换消息中的图片内容为描述文本（与 OpenAI 路线 dpsk-chat.js:347-359 一致）
        for (const msg of flatMessages) {
            if (!msg || !Array.isArray(msg.content)) continue;
            const newContent = msg.content.filter(c => c && c.type !== 'image_url');
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
        logger.info(`[DPSK-Anth] Vision→Pro 代理: 描述注入完成`, 'DPSK');

        visionOutcome = 'success';
        return flatMessages;
    } catch (error) {
        if (signal?.aborted && error?.code !== 'CLIENT_ABORTED') {
            const abortError = new Error('Client disconnected');
            abortError.status = 499;
            abortError.code = 'CLIENT_ABORTED';
            abortError.cause = error;
            error = abortError;
        }
        if (error?.code === 'CLIENT_ABORTED') visionOutcome = 'client_aborted';
        throw error;
    } finally {
        // Vision upload/poll/describe owns a separate scheduler lease.
        // Release the lease even if account validation fails after acquire.
        if (visionLease) {
            try { visionLease.release(visionOutcome); } catch (_) { /* idempotent */ }
        }
    }
}

// ===========================================================================
// Prompt 序列化
// ===========================================================================

/**
 * 把 OpenAI 风格 messages 序列化为 DeepSeek 上游可接受的文本 prompt
 *
 * 输出格式（以 `\n---\n` 分隔）：
 *   system:<system text>
 *   ---
 *   user:<user text>
 *   ---
 *   assistant:<assistant text>
 *   ---
 *   user:[Tool Result] <tool output>
 *
 * 注意：
 *   - 跳过空内容
 *   - tool 角色映射为 `user:[Tool Result]` 以便上游识别
 *   - 默认仅提取 text 内容块；OpenAI 路线可通过 contentExtractor 处理文件等内容
 *
 * @param {Array<Object>} messages - OpenAI 风格消息列表
 * @param {Object} [options]
 * @param {Function} [options.contentExtractor] - 自定义 content 数组提取函数，签名 (contentArray) => string
 * @returns {string} 序列化后的文本 prompt
 */
function buildPrompt(messages, options = {}) {
    const { contentExtractor, canonicalEnvelope = false } = options;
    const parts = [];
    for (const msg of messages) {
        const role = msg.role;
        let content = '';
        if (typeof msg.content === 'string') content = msg.content;
        else if (Array.isArray(msg.content)) {
            if (typeof contentExtractor === 'function') {
                content = contentExtractor(msg.content);
            } else {
                content = msg.content
                    .filter(c => c && c.type === 'text')
                    .map(c => c.text || '')
                    .join('\n');
            }
        }
        if (!content || (!canonicalEnvelope && !content.trim())) continue;
        if (canonicalEnvelope) {
            parts.push(serializePromptMessageRecord({ index: parts.length, role, content }));
            continue;
        }
        switch (role) {
            case 'system':
            case 'developer': parts.push(`system:${content}`); break;
            case 'user': parts.push(`user:${content}`); break;
            case 'assistant': parts.push(`assistant:${content}`); break;
            case 'tool': parts.push(`user:[Tool Result] ${content}`); break;
        }
    }
    return canonicalEnvelope
        ? `ZPROXY_MESSAGE_ENVELOPE_V1\n${parts.join('\n')}`
        : parts.join('\n---\n');
}

// 定期清理过期账号亲和性记录（每 5 分钟）。
setInterval(() => {
    const now = Date.now();
    evictExpiredSessions(now);
    for (const [k, v] of accountAffinityCache) {
        if (now - v.createdAt > SESSION_CACHE_TTL) accountAffinityCache.delete(k);
    }
}, 5 * 60 * 1000).unref();

module.exports = {
    SESSION_CACHE_TTL,
    REQUEST_ID_PREFIX,
    accountAffinityCache,
    sessionCache,
    buildSessionKey,
    getExplicitClientSessionId,
    shouldUseDeepSeekSession,
    getCachedSession,
    prepareIncrementalMessages,
    commitSessionTurn,
    invalidateSession,
    createRequestSession,
    detectImagesAndDescribe,
    buildPrompt,
};
