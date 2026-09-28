/**
 * DeepSeek 上游 HTTP 客户端
 * 负责与 chat.deepseek.com 的内部 API 通信
 * 使用纯 Node.js WASM 求解 PoW（无 Playwright）
 *
 * 设计要点：
 *  - HTTP 传输统一走 upstream-http.js（axios + TLS sidecar），与 Qwen 路线同构
 *  - SSE 帧切分走统一的 SSEFrameParser，业务语义（fragment/去重/biz_code）在此层解析
 *  - sendChatMessage 是真正的 SSE 流式 generator，yield {type, content}
 *  - getModels 每次实时从 DeepSeek Web 拉取，失败时返回空数组（与 Qwen 路线一致）
 *  - 不再有任何硬编码的 deepseek-v4-flash/pro/r1 兜底列表
 *
 * 日志规范（统一 tag: DPSK）：
 *   - 发送日志（DEBUG）：method/url/body 长度/关键 header 摘要 → 上行可见
 *   - 接收日志（DEBUG）：status/body 长度/SSE 关键事件（fragment 切换、done） → 下行可见
 *   - 问题日志（WARN）：识别到的问题（biz_code 非 0、空 SSE、PoW 失败、session 缺 id…）
 *   - 报错日志（ERROR）：完整 error 对象（带 stack/cause/response）
 *
 * 开启 LOG_LEVEL=DEBUG 可看到完整发送/接收链路；INFO 只看问题/报错；
 * 生产建议 INFO + ENABLE_FILE_LOG=true 把全量落到文件便于事后排查。
 */
const fs = require('fs');
const path = require('path');
const { logger } = require('../../utils/logger');
const { accountLogId } = require('../../utils/account-log-id');
const dpskPow = require('./dpsk-pow');
const config = require('../../config');
const SSEFrameParser = require('../../utils/sse-frame-parser');
const { requestJson, requestStream } = require('../../utils/upstream-http');
const dpskFingerprint = require('./dpsk-fingerprint');
const { downloadHttpUrl, parseDataUri, isLocalPath, readLocalFile } = require('../../shared/media-downloader');

const BASE_URL = 'https://chat.deepseek.com';
const LOGIN_URL = '/api/v0/users/login';
const COMPLETION_URL = '/api/v0/chat/completion';
const SESSION_URL = '/api/v0/chat_session/create';
const CHALLENGE_URL = '/api/v0/chat/create_pow_challenge';
const SETTINGS_URL = '/api/v0/client/settings';
const UPLOAD_URL = '/api/v0/file/upload_file';
const FETCH_FILES_URL = '/api/v0/file/fetch_files';

// ---------------------------------------------------------------------------
// DeepSeek 专用日志助手 — 四类日志统一出口，方便后续 grep / 落盘过滤
// ---------------------------------------------------------------------------

/** 发送日志：发给上游的请求摘要（DEBUG 级别，包含 method/url/body 长度） */
function logDpskSend(method, urlPath, extras = {}) {
    const safeUrl = String(urlPath || '').replace(/\?.*$/, '?...');
    const parts = [`→ ${method} ${safeUrl}`];
    if (extras.bodyLen !== undefined) parts.push(`body=${extras.bodyLen}B`);
    if (extras.pow !== undefined) parts.push(`pow=${extras.pow ? 'yes' : 'no'}`);
    if (extras.account) parts.push(`account=${extras.account}`);
    if (extras.note) parts.push(`note=${extras.note}`);
    logger.debug(`[DPSK-SEND] ${parts.join(' ')}`, 'DPSK');
}

/** 接收日志：上游响应摘要（DEBUG 级别，包含 status/关键事件） */
function logDpskRecv(method, urlPath, status, extras = {}) {
    const safeUrl = String(urlPath || '').replace(/\?.*$/, '?...');
    const parts = [`← ${method} ${safeUrl} status=${status}`];
    if (extras.bodyLen !== undefined) parts.push(`body=${extras.bodyLen}B`);
    if (extras.durationMs !== undefined) parts.push(`${extras.durationMs}ms`);
    if (extras.note) parts.push(`note=${extras.note}`);
    logger.debug(`[DPSK-RECV] ${parts.join(' ')}`, 'DPSK');
}

/** 问题日志：识别到的问题（WARN 级别，不影响请求但需要关注） */
function logDpskProblem(message, data = null) {
    logger.warn(`[DPSK-PROBLEM] ${message}`, 'DPSK', '', data);
}

/** 报错日志：完整错误链（ERROR 级别，附带 err 对象） */
function logDpskError(message, err = null) {
    logger.error(`[DPSK-ERROR] ${message}`, 'DPSK', '', err);
}

const DEFAULT_HEADERS = {
    'accept': '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json',
    'origin': 'https://chat.deepseek.com',
    'referer': 'https://chat.deepseek.com/',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
    'x-app-version': '2.5.0',
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-locale': 'zh_CN',
    'x-client-platform': 'web',
    'x-client-timezone-offset': '28800',
    'x-client-version': '2.5.0',
};


// ========== WAF Cookie 自动预热与维护 ==========
let _cachedWafCookie = '';
let _lastWafFetchAt = 0;
const WAF_COOKIE_TTL_MS = 15 * 60 * 1000; // 15 分钟

async function getWafCookie(proxyUrl, force = false) {
    const now = Date.now();
    if (_cachedWafCookie && !force && (now - _lastWafFetchAt < WAF_COOKIE_TTL_MS)) {
        return _cachedWafCookie;
    }
    try {
        const { getOrCreateAgent } = require('../../utils/proxy-helper');
        const agent = getOrCreateAgent(proxyUrl || config.proxyUrl);
        const res = await requestJson({
            url: BASE_URL + '/',
            method: 'GET',
            headers: {
                'User-Agent': DEFAULT_HEADERS['user-agent'],
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            timeout: 10000,
            proxyAgent: agent,
        });
        const setCookies = res.headers?.['set-cookie'] || [];
        const header = (Array.isArray(setCookies) ? setCookies : [setCookies])
            .map(c => String(c).split(';')[0].trim())
            .filter(Boolean)
            .join('; ');
        if (header) {
            _cachedWafCookie = header;
            _lastWafFetchAt = now;
            logger.debug(`[DPSK] 成功刷新 WAF cookie: ${header.slice(0, 50)}...`, 'DPSK');
        }
    } catch (err) {
        logger.warn(`[DPSK] 预热 WAF cookie 异常: ${err.message}`, 'DPSK');
    }
    return _cachedWafCookie;
}

/** 将账号指纹合并到请求 headers */
function _mergeHeaders(extraHeaders, opts = {}) {
    const base = { ...DEFAULT_HEADERS, ...extraHeaders };
    const fp = opts.fingerprint || (opts.proxy ? dpskFingerprint.getFingerprint(opts.proxy) : null);
    if (fp) {
        if (fp.userAgent) base['user-agent'] = fp.userAgent;
        if (fp.acceptLanguage) base['accept-language'] = fp.acceptLanguage;
        if (fp.secChUa) base['sec-ch-ua'] = fp.secChUa;
        // ⚠️ x-client-platform MUST stay 'web' — DeepSeek Web API 检查此值，
        // 设为 macos/windows 等非 web 值会导致上游静默拒绝（返回空 SSE 流）。
    }
    return base;
}

/** 获取账号级代理 agent */
/**
 * 把请求 path 解析为完整 URL
 *  - 相对路径（如 LOGIN_URL）→ 拼上 BASE_URL
 *  - 绝对 URL（如图片下载用的 https://...）→ 原样使用
 */
function resolveUrl(target) {
    if (typeof target === 'string' && /^https?:\/\//i.test(target)) return target;
    return `${BASE_URL}${target}`;
}

/**
 * 发送 HTTPS 请求（缓冲整段响应）
 * 仅用于 PoW 挑战、会话创建、settings 拉取等小响应场景
 * 传输层走 upstream-http（axios + TLS sidecar），与 Qwen 路线同构
 * @returns {Promise<{status: number, headers: Object, body: string}>}
 */
function httpsRequest(method, path, headers = {}, body = null, proxyUrl = null, fingerprint = null, signal = null) {
    const bodyLen = body == null ? 0
        : (Buffer.isBuffer(body) ? body.length
            : (typeof body === 'string' ? Buffer.byteLength(body)
                : Buffer.byteLength(JSON.stringify(body || {}))));
    const hasAuth = !!(headers && headers.authorization);
    logDpskSend(method, path, {
        bodyLen,
        pow: !!(headers && headers['x-ds-pow-response']),
        account: hasAuth ? '(authed)' : '(anon)',
    });
    const startedAt = Date.now();
    const cfg = {
        url: resolveUrl(path),
        method,
        headers: _mergeHeaders(headers, { proxy: proxyUrl, fingerprint }),
        body,
        timeout: 120000,
        sidecarMode: 'dpsk',
        signal,
    };
    if (proxyUrl) {
        const { getOrCreateAgent } = require('../../utils/proxy-helper');
        cfg.proxyAgent = getOrCreateAgent(proxyUrl);
    }
    return requestJson(cfg).then((res) => {
        logDpskRecv(method, path, res.status, {
            bodyLen: res.body == null ? 0 : Buffer.byteLength(String(res.body), 'utf8'),
            durationMs: Date.now() - startedAt,
        });
        return res;
    }, (err) => {
        logDpskError(`httpsRequest 失败 ${method} ${String(path).replace(/\?.*$/, '?...')} (${Date.now() - startedAt}ms)`, err);
        throw err;
    });
}

/**
 * 发送 HTTPS 流式请求，返回原生 stream（用于 SSE 流式解析）
 * 传输层走 upstream-http（axios + TLS sidecar），与 Qwen 路线同构
 * @param {string} method
 * @param {string} path
 * @param {Object} headers
 * @param {Object|string|Buffer} body
 * @returns {Promise<{status: number, headers: Object, stream: import('http').IncomingMessage}>}
 */
function httpsStreamRequest(method, path, headers = {}, body = null, proxyUrl = null, fingerprint = null, signal = null) {
    const bodyLen = body == null ? 0
        : (Buffer.isBuffer(body) ? body.length
            : (typeof body === 'string' ? Buffer.byteLength(body)
                : Buffer.byteLength(JSON.stringify(body || {}))));
    logDpskSend(method, path, {
        bodyLen,
        pow: !!(headers && headers['x-ds-pow-response']),
        account: !!(headers && headers.authorization) ? '(authed)' : '(anon)',
        note: 'stream',
    });
    const startedAt = Date.now();
    const cfg = {
        url: resolveUrl(path),
        method,
        headers: _mergeHeaders(headers, { proxy: proxyUrl, fingerprint }),
        body,
        timeout: config.dpskStreamTimeoutMs || 600000,
        sidecarMode: 'dpsk',
        signal,
    };
    if (proxyUrl) {
        const { getOrCreateAgent } = require('../../utils/proxy-helper');
        cfg.proxyAgent = getOrCreateAgent(proxyUrl);
    }
    return requestStream(cfg).then((res) => {
        logDpskRecv(method, path, res.status, {
            durationMs: Date.now() - startedAt,
            note: res.status === 200 ? 'stream-open' : `stream-err-body`,
        });
        return res;
    }, (err) => {
        logDpskError(`httpsStreamRequest 失败 ${method} ${String(path).replace(/\?.*$/, '?...')} (${Date.now() - startedAt}ms)`, err);
        throw err;
    });
}

/**
 * 登录 DeepSeek 获取 token
 * 参考 Qwen 路线的 account.js token 登录方法
 *
 * @param {string} email - 邮箱
 * @param {string} password - 密码
 * @returns {Promise<{token: string, user: Object}>} 登录结果
 */
async function login(email, password) {
    let deviceId = 'BT8KU++Xy6WqIYUCGni0yD04/N9qiWN6FhnY0CChfJaRn1xhMwBs5f3HGFlc/4VkhFeANe2fU+WwOx5ZAt6HYNg==';
    try {
        const deviceFile = path.join(__dirname, '..', '..', '..', 'data', 'dpsk-device.json');
        if (fs.existsSync(deviceFile)) {
            const devData = JSON.parse(fs.readFileSync(deviceFile, 'utf8'));
            if (devData.deviceId) deviceId = devData.deviceId;
        }
    } catch (_) {}

    const body = {
        email,
        mobile: '',
        password,
        area_code: '',
        device_id: deviceId,
        platform: 'web',
        os: 'web',
    };

    const res = await httpsRequest('POST', LOGIN_URL, {}, body);

    if (res.status !== 200) {
        logDpskError(`login HTTP ${res.status}`, new Error(String(res.body).slice(0, 200)));
        throw new Error(`DeepSeek 登录失败: HTTP ${res.status} ${res.body.slice(0, 200)}`);
    }

    const data = JSON.parse(res.body);
    if (data.code !== 0 || !data.data || !data.data.biz_data) {
        const msg = data.data?.biz_msg || data.msg || '未知错误';
        logDpskProblem(`登录业务拒绝: ${msg}`, { code: data.code, msg });
        throw new Error(`DeepSeek 登录失败: ${msg}`);
    }

    const bizData = data.data.biz_data;
    if (bizData.code !== 0) {
        logDpskProblem(`登录 biz_code 非 0`, { biz_code: bizData.code, biz_msg: bizData.msg });
        throw new Error(`DeepSeek 登录业务错误: ${bizData.msg || bizData.code}`);
    }

    const token = bizData.user?.token;
    if (!token) {
        logDpskProblem('登录成功但未返回 token');
        throw new Error('DeepSeek 登录成功但未返回 token');
    }

    logger.info(`[DPSK] 登录成功: account=${accountLogId(email)}`, 'DPSK');
    return {
        token,
        user: bizData.user,
    };
}

/**
 * 获取 PoW 挑战
 */
async function getPowChallenge(token, proxyUrl = null, fingerprint = null, signal = null) {
    const res = await httpsRequest('POST', CHALLENGE_URL, {
        'authorization': `Bearer ${token}`,
    }, { target_path: '/api/v0/chat/completion' }, proxyUrl, fingerprint, signal);

    if (res.status !== 200) {
        logDpskError(`getPowChallenge HTTP ${res.status}`, new Error(String(res.body).slice(0, 200)));
        throw new Error(`获取 PoW 挑战失败: ${res.status} ${res.body}`);
    }

    let data;
    try {
        data = JSON.parse(res.body);
    } catch (e) {
        logDpskProblem('PoW 挑战响应非 JSON', { bodyHead: String(res.body).slice(0, 200) });
        throw new Error(`获取 PoW 挑战失败: 响应非 JSON (${String(res.body).slice(0, 200)})`);
    }
    // 上游 200 但业务码非 0 / 缺 challenge 字段时给出明确错误，避免
    // data.data.biz_data.challenge 抛 TypeError 被主循环当通用错误处理、账号不冷却。
    if (data.code !== 0 || !data.data || !data.data.biz_data || !data.data.biz_data.challenge) {
        logDpskProblem('PoW 挑战缺 challenge 字段', { code: data.code, msg: data.msg, biz_msg: data.data && data.data.biz_msg });
        const e = new Error(`获取 PoW 挑战失败: code=${data.code} msg=${data.msg || (data.data && data.data.biz_msg) || ''}`);
        e.bizCode = data.code;
        throw e;
    }
    return data.data.biz_data.challenge;
}

/**
 * 创建 DeepSeek 聊天会话
 * @param {string} token - Bearer token
 * @returns {Promise<{id: string, model_type: string}>} 会话信息
 */
async function createSession(token, proxyUrl = null, fingerprint = null, signal = null) {
    const res = await httpsRequest('POST', SESSION_URL, {
        'authorization': `Bearer ${token}`,
    }, '{}', proxyUrl, fingerprint, signal);

    if (res.status !== 200) {
        logDpskError(`createSession HTTP ${res.status}`, new Error(String(res.body).slice(0, 200)));
        throw new Error(`创建会话失败: ${res.status} ${res.body}`);
    }

    try {
        const data = JSON.parse(res.body);
        const bizData = data.data && data.data.biz_data;
        const session = bizData && (bizData.chat_session || bizData);
        const sessionId = session && (session.id || session.chat_session_id);
        const modelType = session && (session.model_type || bizData.model_type || 'default');
        if (!sessionId) {
            logDpskProblem('createSession 缺 session id', { bodyHead: String(res.body).slice(0, 200) });
            throw new Error(`DeepSeek 会话响应缺少 session id: ${res.body}`);
        }
        logger.debug(`[DPSK-RECV] createSession id=${sessionId} model_type=${modelType}`, 'DPSK');
        return { id: sessionId, model_type: modelType };
    } catch (e) {
        if (e && e.message && e.message.indexOf('session id') >= 0) {
            throw e;
        }
        logDpskProblem('createSession 响应解析失败', { bodyHead: String(res.body).slice(0, 200) });
        throw new Error(`解析会话响应失败: ${res.body}`);
    }
}

/**
 * 构造 DeepSeek 业务错误（biz_code 非 0）
 * 携带 bizCode/bizMsg/bizData，并在 msg 命中 context/length 关键词时打 contextTooLong 标记，
 * 供上层 controller 触发上下文压缩重试。
 */
function makeBizError(biz) {
    const errMsg = biz.biz_msg || `biz_code=${biz.biz_code}`;
    const isMuted = biz.biz_code === 5;
    logDpskProblem(
        `上游业务错误 biz_code=${biz.biz_code} biz_msg=${biz.biz_msg || ''}` + (isMuted ? ' (账号禁言)' : ''),
        { biz_code: biz.biz_code, biz_msg: biz.biz_msg, biz_data: biz.biz_data || {} },
    );
    const err = new Error(`DeepSeek 上游错误: ${errMsg}`);
    err.bizCode = biz.biz_code;
    err.bizMsg = biz.biz_msg;
    err.bizData = biz.biz_data || {};
    const lowMsg = String(biz.biz_msg || '').toLowerCase();
    if (lowMsg.indexOf('context') >= 0 || lowMsg.indexOf('too long') >= 0 ||
        lowMsg.indexOf('length') >= 0 || String(biz.biz_code || '').toLowerCase().indexOf('context') >= 0) {
        err.contextTooLong = true;
    }
    return err;
}

/**
 * SSE 流式解析器：用统一的 SSEFrameParser 切帧，再按 DeepSeek 业务语义解析。
 *
 * DeepSeek SSE 帧格式：
 *  1) 初始 fragment（update_session 事件）：data.v.response.fragments[]
 *     携带 fragment 的 type（THINK 或 RESPONSE）
 *  2) 新 fragment 开始：data.p === 'response/fragments' && data.o === 'APPEND'
 *     data.v 是数组，每个元素含 id/type/content
 *  3) 内容增量追加：data.p === 'response/fragments/-1/content' && typeof data.v === 'string'
 *     追加到当前最后一个 fragment（类型由 currentFragmentType 决定）
 *  4) 仅 v 字符串（无 p）：同 3）
 *  5) 状态：data.p === 'response/status' && data.o === 'SET' && data.v === 'FINISHED'
 *
 * 非 SSE 的裸 JSON 错误响应（账号禁言、PoW 失败等，无 data: 前缀）：
 *  SSEFrameParser 会在 end() 阶段把残留作为 trailing 事件吐出（data 为空、raw 为原文），
 *  这里对 raw 做 JSON.parse 并检测 biz_code / 顶层 code 错误。
 *
 * @param {import('http').IncomingMessage} stream
 * @yields {{type: 'text'|'thinking'|'done'|'message_id', content: string|number}}
 */
async function* parseDeepSeekSSE(stream, options = {}) {
    const parser = new SSEFrameParser();
    let sawDone = false;
    let fragmentCount = 0;
    let yieldCount = 0;
    let totalTextChars = 0;
    let totalThinkChars = 0;
    const startedAt = Date.now();
    // 跟踪当前 fragment 类型（THINK 或 RESPONSE）
    let currentFragmentType = null;
    // 跟踪初始 fragments 中已 yield 的内容，用于对后续 -1/content 增量做去重。
    // DeepSeek 有时在 update_session 里携带完整内容，又通过 -1/content 逐字增量发一遍。
    let lastInitThinkContent = '';
    let lastInitTextContent = '';
    let lastEmittedMessageId = null;

    // DeepSeek's Web API uses u32 message ids.  Keep numeric ids numeric so
    // the next request can send a valid parent_message_id instead of a JSON
    // string (the upstream rejects `"2"` with HTTP 422).
    const normalizeMessageId = (value) => {
        if (value === undefined || value === null || value === '') return null;
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
        const text = String(value).trim();
        if (!text) return null;
        if (/^\d+$/.test(text)) return Number(text);
        return text;
    };

    const getResponseMessageId = (data) => normalizeMessageId(
        data?.response_message_id
        ?? data?.v?.response?.message_id
        ?? data?.v?.response?.current_message_id,
    );

    const prependMessageId = (items, data) => {
        const messageId = getResponseMessageId(data);
        if (messageId === null || messageId === lastEmittedMessageId) return items;
        lastEmittedMessageId = messageId;
        return [{ type: 'message_id', content: messageId }, ...items];
    };

    // utf8 解码：避免多字节字符在 chunk 边界被拆成无效序列（覆盖 axios / sidecar 两条路径）
    if (typeof stream.setEncoding === 'function') stream.setEncoding('utf8');

    /**
     * 处理一个 SSEFrameParser 事件，返回待 yield 的 {type, content} 数组。
     * 命中业务错误时直接 throw（保留与旧实现一致的错误对象形态）。
     */
    const processEvent = (ev) => {
        if (!ev) return [];
        if (sawDone) return [];

        // [DONE] sentinel
        if (ev.data === '[DONE]') {
            sawDone = true;
            logger.debug(`[DPSK-RECV] SSE [DONE] sentinel (text=${totalTextChars}B think=${totalThinkChars}B fragments=${fragmentCount} yields=${yieldCount} ${Date.now() - startedAt}ms)`, 'DPSK');
            return [{ type: 'done', content: '' }];
        }

        // 增量内容去重：若新内容以初始 fragment 内容为前缀，去掉前缀；去重后重置 init 避免后续误删。
        // 返回单个 {type, content}（content 为空时返回 null，由外层 for 过滤）。
        const dedupAppend = (content, fragType) => {
            if (fragType === 'THINK') {
                let c = content;
                if (lastInitThinkContent && c.startsWith(lastInitThinkContent)) {
                    c = c.slice(lastInitThinkContent.length);
                    lastInitThinkContent = '';
                }
                return c ? { type: 'thinking', content: c } : null;
            }
            let c = content;
            if (lastInitTextContent && c.startsWith(lastInitTextContent)) {
                c = c.slice(lastInitTextContent.length);
                lastInitTextContent = '';
            }
            return c ? { type: 'text', content: c } : null;
        };

        // 正常 SSE 帧：data 已被 SSEFrameParser JSON.parse
        if (ev.json != null) {
            const data = ev.json;
            if (data && typeof data === 'object') {
                if (typeof data.code === 'number' && data.code !== 0) {
                    const error = new Error(`DeepSeek 上游错误: ${data.msg || `code=${data.code}`}`);
                    error.bizCode = data.code;
                    throw error;
                }
                // SSE 帧内业务错误
                if (data.data && data.data.biz_code && data.data.biz_code !== 0) {
                    throw makeBizError(data.data);
                }

                // 1) 初始 fragment
                if (data.v && typeof data.v === 'object' && data.v.response && Array.isArray(data.v.response.fragments)) {
                    const out = [];
                    const fragments = data.v.response.fragments;
                    if (fragments.length > 0) {
                        const lastFrag = fragments[fragments.length - 1];
                        if (lastFrag && lastFrag.type) currentFragmentType = lastFrag.type;
                        for (const frag of fragments) {
                            if (frag && typeof frag.content === 'string' && frag.content) {
                                if (frag.type === 'THINK') {
                                    lastInitThinkContent = frag.content;
                                    totalThinkChars += frag.content.length;
                                    out.push({ type: 'thinking', content: frag.content });
                                } else {
                                    lastInitTextContent = frag.content;
                                    totalTextChars += frag.content.length;
                                    out.push({ type: 'text', content: frag.content });
                                }
                            }
                        }
                        fragmentCount += fragments.length;
                        logger.debug(`[DPSK-RECV] 初始 fragment x${fragments.length} type=${currentFragmentType} msg_id=${data.v.response.current_message_id || '-'}`, 'DPSK');
                    }
                    return prependMessageId(out, data);
                }
                // 2) 新 fragment 开始
                if (data.p === 'response/fragments' && data.o === 'APPEND' && Array.isArray(data.v)) {
                    const out = [];
                    for (const frag of data.v) {
                        if (frag && frag.type) currentFragmentType = frag.type;
                        if (frag && typeof frag.content === 'string' && frag.content) {
                            if (frag.type === 'THINK') {
                                lastInitThinkContent = frag.content;
                                totalThinkChars += frag.content.length;
                                out.push({ type: 'thinking', content: frag.content });
                            } else {
                                lastInitTextContent = frag.content;
                                totalTextChars += frag.content.length;
                                out.push({ type: 'text', content: frag.content });
                            }
                        }
                    }
                    fragmentCount += data.v.length;
                    logger.debug(`[DPSK-RECV] 新 fragment APPEND x${data.v.length} type=${currentFragmentType}`, 'DPSK');
                    return prependMessageId(out, data);
                }
                // 3) 内容增量追加
                // 注意：content append 有时携带 "o":"APPEND" 有时省略，不能强制要求 data.o === 'APPEND'，
                // 否则会丢内容（典型的 <tool_call> 被截成 <_call>）
                if (data.p === 'response/fragments/-1/content' && typeof data.v === 'string') {
                    const item = dedupAppend(data.v, currentFragmentType);
                    if (item) {
                        if (item.type === 'thinking') totalThinkChars += item.content.length;
                        else totalTextChars += item.content.length;
                    }
                    return prependMessageId([item], data);
                }
                // 4) 仅 v 字符串（无 p）—— 同 3）
                if (typeof data.v === 'string' && !data.p) {
                    const item = dedupAppend(data.v, currentFragmentType);
                    if (item) {
                        if (item.type === 'thinking') totalThinkChars += item.content.length;
                        else totalTextChars += item.content.length;
                    }
                    return prependMessageId([item], data);
                }

                // 5) 状态
                if (data.p === 'response/status' && data.o === 'SET' && data.v === 'FINISHED') {
                    sawDone = true;
                    logger.debug(`[DPSK-RECV] response/status=FINISHED (text=${totalTextChars}B think=${totalThinkChars}B fragments=${fragmentCount} yields=${yieldCount} ${Date.now() - startedAt}ms)`, 'DPSK');
                    return [{ type: 'done', content: '' }];
                }
            }
            return prependMessageId([], data);
        }

        // json == null：可能是裸 JSON 错误响应（无 data: 前缀），尝试从 raw 恢复
        const raw = String(ev.raw || '').trim();
        if (raw.startsWith('{')) {
            let parsed = null;
            try { parsed = JSON.parse(raw); } catch (_) { /* not json, ignore */ }
            if (parsed && typeof parsed === 'object') {
                if (parsed.data && parsed.data.biz_code && parsed.data.biz_code !== 0) {
                    throw makeBizError(parsed.data);
                }
                if (typeof parsed.code === 'number' && parsed.code !== 0) {
                    const errMsg = parsed.msg || `code=${parsed.code}`;
                    logDpskProblem(`SSE trailing 裸 JSON 错误 code=${parsed.code} msg=${parsed.msg}`, { code: parsed.code, msg: parsed.msg });
                    throw new Error(`DeepSeek 上游错误: ${errMsg}`);
                }
            }
        }
        return [];
    };

    let firstByteSeen = false;
    for await (const chunk of stream) {
        if (!firstByteSeen) {
            firstByteSeen = true;
            try { options.onFirstByte?.(chunk); } catch (_) { /* ignore */ }
        }
        // setEncoding('utf8') 后 chunk 为 string；SSEFrameParser 也兼容 Buffer
        for (const ev of parser.feed(chunk)) {
            for (const item of processEvent(ev)) {
                if (item) {
                    yieldCount++;
                    yield item;
                }
            }
        }
    }
    // 流结束：flush 残留（含可能的裸 JSON 错误）
    for (const ev of parser.end()) {
        for (const item of processEvent(ev)) {
            if (item) {
                yieldCount++;
                yield item;
            }
        }
    }

    if (!sawDone) {
        logDpskProblem(`SSE 流结束但未收到 [DONE]/FINISHED (text=${totalTextChars}B think=${totalThinkChars}B fragments=${fragmentCount} yields=${yieldCount} ${Date.now() - startedAt}ms)`, null);
        const error = new Error('DeepSeek upstream stream ended without [DONE]/FINISHED');
        error.code = 'UPSTREAM_STREAM_INCOMPLETE';
        throw error;
    }
}

/**
 * 发送聊天消息（真正的 SSE 流式）
 * @param {string} token - Bearer token
 * @param {string} chatSessionId - 会话 ID
 * @param {string} prompt - 消息内容
 * @param {object} options - 额外选项
 * @returns {AsyncGenerator<{type: string, content: string}>} SSE 事件流
 */
async function* sendChatMessage(token, chatSessionId, prompt, options = {}, account = null) {
    const {
        parentMessageId = null,
        modelType = 'expert',
        thinkingEnabled = true,
        searchEnabled = false,
        refFileIds = [],
        maxTokens = null,
        proxyUrl = null,
        fingerprint = null,
        signal = null,
        onFirstByte = null,
    } = options;

    const sendStartedAt = Date.now();
    const promptLen = typeof prompt === 'string' ? Buffer.byteLength(prompt, 'utf8') : 0;
    logger.info(
        `[DPSK-SEND] chat completion session=${chatSessionId} model=${modelType} think=${thinkingEnabled} search=${searchEnabled}` +
        ` prompt=${promptLen}B parent=${parentMessageId || '-'} files=${Array.isArray(refFileIds) ? refFileIds.length : 0}` +
        (maxTokens ? ` max_tokens=${maxTokens}` : ''),
        'DPSK',
    );

    // 1. 获取 PoW 挑战
    const challenge = await getPowChallenge(token, proxyUrl, fingerprint, signal);

    // 2. 求解 PoW
    const powResponse = await dpskPow.solvePow(challenge, signal);
    logger.debug(`[DPSK-SEND] PoW 已求解 (answer=${challenge.answer !== undefined ? 'cached' : 'fresh'})`, 'DPSK');

    // 3. 发送消息（流式）
    const normalizedParentMessageId = parentMessageId === undefined || parentMessageId === null
        ? null
        : (typeof parentMessageId === 'number' && Number.isInteger(parentMessageId)
            ? parentMessageId
            : (/^\d+$/.test(String(parentMessageId).trim())
                ? Number(String(parentMessageId).trim())
                : parentMessageId));
    const body = {
        chat_session_id: chatSessionId,
        parent_message_id: normalizedParentMessageId,
        model_type: modelType,
        prompt: prompt,
        ref_file_ids: refFileIds,
        thinking_enabled: thinkingEnabled,
        search_enabled: searchEnabled,
        action: null,
        preempt: false,
    };
    if (maxTokens !== null && maxTokens > 0) {
        body.max_tokens = maxTokens;
    }

    const res = await httpsStreamRequest('POST', COMPLETION_URL, {
        'authorization': `Bearer ${token}`,
        'x-ds-pow-response': powResponse,
    }, body, proxyUrl, fingerprint, signal);

    if (res.status !== 200) {
        // 流式错误响应需要缓冲读取
        let errBody = '';
        try {
            for await (const chunk of res.stream) {
                errBody += chunk.toString('utf8');
                if (errBody.length > 2048) break;
            }
        } catch (_) { /* ignore */ }
        logDpskError(`sendChatMessage 上游非 200 status=${res.status}`, new Error(errBody.slice(0, 500)));
        throw new Error(`发送消息失败: ${res.status} ${errBody.slice(0, 200)}`);
    }

    // 4. 真正的 SSE 流式解析
    let yieldCount = 0;
    try {
        for await (const item of parseDeepSeekSSE(res.stream, { onFirstByte })) {
            yieldCount++;
            yield item;
        }
    } finally {
        if (signal?.aborted && !res.stream?.destroyed) {
            try { res.stream?.destroy?.() } catch (_) { /* ignore */ }
        }
        logger.info(
            `[DPSK-RECV] chat completion stream 结束 session=${chatSessionId} yields=${yieldCount} ${Date.now() - sendStartedAt}ms`,
            'DPSK',
        );
    }
}

/**
 * 从 DeepSeek Web 实时获取模型配置（通过 settings API scope=model）
 *
 * 返回模型配置数组，每个元素包含：
 *   { model_type, name, description, enabled, switchable, is_default,
 *     think_feature, search_feature, file_feature }
 *
 * 失败时返回 null，不抛异常。
 */
async function getModelConfigs(token, account = null) {
    if (!token) return null;
    try {
        const did = `dpsk-sdk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const proxyUrl = account?.proxy || null;
        const fingerprint = account?.fingerprint || (account?.email ? dpskFingerprint.getFingerprint(account.email) : null);
        const res = await httpsRequest('GET', `/api/v0/client/settings?did=${encodeURIComponent(did)}&scope=model`, {
            'authorization': `Bearer ${token}`,
        }, null, proxyUrl, fingerprint);
        if (res.status !== 200) {
            logger.warn(`[DPSK] getModelConfigs: HTTP ${res.status}`, 'DPSK');
            return null;
        }
        const data = JSON.parse(res.body);
        if (data.code !== 0 || data.data?.biz_code !== 0) {
            logger.warn(`[DPSK] getModelConfigs: biz_code=${data.data?.biz_code}`, 'DPSK');
            return null;
        }
        const configs = data.data?.biz_data?.settings?.model_configs?.value;
        if (!Array.isArray(configs) || configs.length === 0) {
            logger.warn('[DPSK] getModelConfigs: 返回空配置', 'DPSK');
            return null;
        }
        return configs;
    } catch (err) {
        logger.warn(`[DPSK] getModelConfigs: ${err.message}`, 'DPSK');
        return null;
    }
}

const modelCapabilityCache = {
    at: 0,
    byId: new Map(),
    byType: new Map(),
};
const MODEL_CAPABILITY_CACHE_TTL_MS = 5 * 60 * 1000;

function featureEnabled(value) {
    return featureState(value) === true;
}

/**
 * Parse a Web settings feature without collapsing "not declared" into false.
 * DeepSeek currently returns `think_feature: {}` for models that still accept
 * an explicit thinking_enabled=true request, so the empty object is unknown.
 */
function featureState(value) {
    if (typeof value === 'boolean') return value;
    if (value == null) return null;
    if (typeof value === 'object') {
        if (Object.prototype.hasOwnProperty.call(value, 'enabled')) return featureState(value.enabled);
        const flags = Object.values(value);
        if (flags.length === 0) return null;
        const booleanLikeFlags = flags.filter(flag => (
            typeof flag === 'boolean'
            || (typeof flag === 'number' && (flag === 0 || flag === 1))
            || (typeof flag === 'string' && ['0', '1', 'true', 'false', 'on', 'off', 'enabled', 'disabled'].includes(flag.toLowerCase()))
        ));
        if (booleanLikeFlags.length > 0) return booleanLikeFlags.some(flag => featureState(flag));
        // A non-empty descriptive object (for example { type: 'thinking' })
        // indicates a declared feature, while {} remains unknown.
        return true;
    }
    const normalized = String(value).toLowerCase().trim();
    if (!normalized) return null;
    return !['0', 'false', 'off', 'disabled'].includes(normalized);
}

function firstFiniteNumber(...values) {
    for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number) && number > 0) return number;
    }
    return null;
}

function buildModelCapability(cfg, thinkingEnabled) {
    const fileFeature = cfg.file_feature && typeof cfg.file_feature === 'object' ? cfg.file_feature : null;
    const searchFeature = cfg.search_feature && typeof cfg.search_feature === 'object' ? cfg.search_feature : null;
    const thinkingSupported = featureState(cfg.think_feature);
    const contextWindow = firstFiniteNumber(
        cfg.context_window,
        cfg.context_length,
        cfg.max_context_length,
        cfg.context?.max_tokens,
    );
    const maxOutputTokens = firstFiniteNumber(
        cfg.max_output_tokens,
        cfg.max_completion_tokens,
        cfg.output_token_limit,
    );
    const inputCharacterLimit = firstFiniteNumber(
        cfg.input_character_limit,
        cfg.input_characters_limit,
        cfg.max_input_characters,
    );
    const capability = {
        model_type: cfg.model_type,
        thinking_supported: thinkingSupported,
        thinking_enabled: thinkingEnabled,
        file_supported: featureEnabled(fileFeature),
        vision_supported: !!(fileFeature && (fileFeature.vision === true || featureEnabled(fileFeature.vision))),
        search_supported: featureEnabled(searchFeature),
        source: 'settings',
        observed_at: new Date().toISOString(),
    };
    if (contextWindow) capability.context_window = contextWindow;
    if (maxOutputTokens) capability.max_output_tokens = maxOutputTokens;
    if (inputCharacterLimit) capability.input_character_limit = inputCharacterLimit;
    return capability;
}

function cacheModelCapabilities(models) {
    modelCapabilityCache.at = Date.now();
    modelCapabilityCache.byId = new Map();
    modelCapabilityCache.byType = new Map();
    for (const model of models) {
        const id = String(model?.id || '').toLowerCase();
        const type = String(model?.model_type || '').toLowerCase();
        if (id) modelCapabilityCache.byId.set(id, { ...model.capabilities, model_type: model.model_type });
        if (type && !modelCapabilityCache.byType.has(type)) {
            modelCapabilityCache.byType.set(type, { ...model.capabilities, model_type: model.model_type });
        }
    }
}

// Claude Code may append a display-only context-window marker such as
// "[1M]" to the model id. It must never be sent as DeepSeek's model_type.
function stripModelDisplaySuffix(modelName) {
    return String(modelName || '')
        .trim()
        .replace(/\s*\[(?:\d+(?:\.\d+)?m|context-\d+(?:\.\d+)?m)\]\s*$/i, '');
}

function parseModelNameParts(modelName) {
    const normalized = stripModelDisplaySuffix(modelName);
    let lower = normalized.toLowerCase().trim();
    if (lower.startsWith('deepseek-')) lower = lower.slice(9);
    else if (lower.startsWith('dpsk-')) lower = lower.slice(5);

    // 1. 解析联网搜索标志 (-search, -online)
    let search = false;
    if (lower.includes('-search') || lower.includes('-online')) {
        search = true;
        lower = lower.replace(/-search|-online/g, '');
    }

    // 2. 解析显式深度思考标志 (-think, -thinking)
    let explicitThink = false;
    if (lower.includes('-think') || lower.includes('-thinking')) {
        explicitThink = true;
        lower = lower.replace(/-think(?:ing)?/g, '');
    }

    // 3. 解析快速无思考标志 (-flash, -fast)
    let hasFlash = false;
    if (lower.includes('-flash') || lower.includes('-fast') || lower === 'flash' || lower === 'fast') {
        hasFlash = true;
        lower = lower.replace(/-flash|-fast/g, '');
        if (lower === 'flash' || lower === 'fast') lower = 'default';
    }

    // 规范化清洗尾部连接符
    let typePart = lower.replace(/^-+|-+$/g, '');
    if (!typePart || ['chat', 'reasoner', 'r1', 'v3', 'v4', 'v4.1', 'v4pro', 'v4-pro', 'default'].includes(typePart)) {
        typePart = 'default';
    }

    // 决定思考模式：
    // 若显式带有 -think / -thinking (如 deepseek-v4.1-flash-think)，则必须开启深度思考！
    // 否则若带有 -flash / -fast 且没有 -think，则关闭思考。
    // 否则默认开启思考。
    let variant = 'base';
    let thinkingEnabled = true;
    if (explicitThink) {
        variant = 'think';
        thinkingEnabled = true;
    } else if (hasFlash) {
        variant = 'flash';
        thinkingEnabled = false;
    } else {
        variant = 'base';
        thinkingEnabled = true;
    }

    return {
        normalized,
        lower,
        typePart,
        variant,
        search,
        thinkingEnabled,
    };
}

function getModelVariant(modelName) {
    return parseModelNameParts(modelName).variant;
}

function getModelCapabilities(modelName) {
    if (!modelName || Date.now() - modelCapabilityCache.at > MODEL_CAPABILITY_CACHE_TTL_MS) return null;
    const parts = parseModelNameParts(modelName);
    const exact = modelCapabilityCache.byId.get(parts.normalized.toLowerCase());
    const base = exact || modelCapabilityCache.byType.get(parts.typePart);
    if (!base) return null;
    // A flash/fast request is a deliberate thinking-off variant even when
    // settings only exposes the base model id.
    if (parts.variant === 'flash' || parts.variant === 'fast') {
        return { ...base, thinking_enabled: false, model_variant: parts.variant };
    }
    return { ...base, model_variant: 'base' };
}

/**
 * 从 DeepSeek Web 实时探测可用模型列表。
 *
 * settings 返回的 model_configs 是唯一能力来源。这里不把未知模型类型
 * 猜成某个固定模型，而是把 model_type、thinking/file/search 能力以及
 * 上游明确提供的 context/output 限制原样整理到缓存中。
 */
async function getModels(token, account = null) {
    if (!token) {
        logger.warn('[DPSK] getModels: 无 token，返回空列表', 'DPSK');
        return [];
    }

    const configs = await getModelConfigs(token, account);
    if (!configs) {
        logger.warn('[DPSK] getModels: 获取模型配置失败，返回空列表', 'DPSK');
        return [];
    }

    const models = [];
    for (const cfg of configs) {
        if (!featureEnabled(cfg.enabled)) continue;

        const mt = String(cfg.model_type || '').trim();
        if (!mt) continue;
        const thinkSupported = featureState(cfg.think_feature);
        const searchSupported = featureState(cfg.search_feature) !== false;

        // 针对主力 default 模型，构建统一标准的 DeepSeek V4.1 旗舰矩阵：
        // 1) deepseek-v4.1-flash              (快速模式, 无思考, 无联网)
        // 2) deepseek-v4.1-flash-search       (快速联网, 无思考, 联网搜索)
        // 3) deepseek-v4.1-flash-think        (深度思考, 开启思考, 无联网)
        // 4) deepseek-v4.1-flash-think-search (顶配形态, 开启思考, 联网搜索)
        // 5) deepseek-v4.1                    (基础别名, 深度思考, 无联网)
        if (mt === 'default') {
            const v4FlashCap = buildModelCapability(cfg, false);
            const v4ThinkCap = buildModelCapability(cfg, true);

            // 1. deepseek-v4.1-flash
            models.push({
                id: 'deepseek-v4.1-flash',
                name: 'DeepSeek V4.1 Flash',
                owned_by: 'deepseek',
                model_type: mt,
                thinking_enabled: false,
                search_enabled: false,
                capabilities: v4FlashCap,
            });

            // 2. deepseek-v4.1-flash-search
            if (searchSupported) {
                models.push({
                    id: 'deepseek-v4.1-flash-search',
                    name: 'DeepSeek V4.1 Flash Search',
                    owned_by: 'deepseek',
                    model_type: mt,
                    thinking_enabled: false,
                    search_enabled: true,
                    capabilities: v4FlashCap,
                });
            }

            // 3. deepseek-v4.1-flash-think
            if (thinkSupported !== false) {
                models.push({
                    id: 'deepseek-v4.1-flash-think',
                    name: 'DeepSeek V4.1 Flash Think',
                    owned_by: 'deepseek',
                    model_type: mt,
                    thinking_enabled: true,
                    search_enabled: false,
                    capabilities: v4ThinkCap,
                });
            }

            // 4. deepseek-v4.1-flash-think-search
            if (thinkSupported !== false && searchSupported) {
                models.push({
                    id: 'deepseek-v4.1-flash-think-search',
                    name: 'DeepSeek V4.1 Flash Think Search',
                    owned_by: 'deepseek',
                    model_type: mt,
                    thinking_enabled: true,
                    search_enabled: true,
                    capabilities: v4ThinkCap,
                });
            }
        } else {
            // 非 default 的特殊类型模型（如已启用的 vision/expert）
            const baseName = cfg.name || mt;
            const mainThinkingEnabled = thinkSupported !== false;
            models.push({
                id: `deepseek-${mt}`,
                name: `DeepSeek ${baseName}`,
                owned_by: 'deepseek',
                model_type: mt,
                thinking_enabled: mainThinkingEnabled,
                search_enabled: false,
                file_feature: cfg.file_feature || null,
                search_feature: cfg.search_feature || null,
                capabilities: buildModelCapability(cfg, mainThinkingEnabled),
            });
        }
    }

    cacheModelCapabilities(models);
    logger.info(`[DPSK] 实时模型探测成功: ${models.length} 个模型`, 'DPSK');
    return models;
}

function resolveModelOptions(modelName, options = {}) {
    const { reasoningEffort, thinking } = options;

    let modelType = 'expert';
    let thinkingEnabled = true;
    const cachedCapability = getModelCapabilities(modelName);

    if (cachedCapability?.model_type) {
        modelType = cachedCapability.model_type;
        // `thinking_enabled` is true by default when settings did not declare
        // a capability. Only an explicit false disables the request.
        thinkingEnabled = cachedCapability.thinking_enabled !== false;
    } else if (modelName) {
        const parts = parseModelNameParts(modelName);
        thinkingEnabled = parts.thinkingEnabled;

        let typePart = parts.typePart;
        // 剥掉前缀
        if (typePart.startsWith('deepseek-')) typePart = typePart.slice(9);
        else if (typePart.startsWith('dpsk-')) typePart = typePart.slice(5);

        // 解析模型类型（零硬编码映射，全规则推导）
        if (typePart === 'expert' || typePart === 'v4-pro' || typePart === 'v4pro') {
            modelType = 'expert';
        } else if (typePart === 'vision' || typePart === 'vl') {
            modelType = 'vision';
        } else if (['default', 'chat', 'reasoner', 'r1', 'v3', 'v4', 'v4.1', 'v4pro', 'v4-pro'].includes(typePart)) {
            modelType = 'default';
        } else {
            modelType = typePart || 'default';
        }
    }

    // OpenAI 风格 reasoning_effort 覆盖（low/medium/high/max）
    // low/minimal → thinking_enabled=false
    // medium/high/max/maximum → thinking_enabled=true
    if (reasoningEffort) {
        const effort = String(reasoningEffort).toLowerCase().trim();
        if (effort === 'low' || effort === 'minimal') {
            thinkingEnabled = false;
        } else if (['medium', 'high', 'max', 'maximum'].includes(effort)) {
            thinkingEnabled = true;
        }
    }

    // Anthropic 风格 thinking 字段覆盖
    // {type:'enabled', budget_tokens:N} → thinking_enabled=true
    // {type:'disabled'} → thinking_enabled=false
    // budget_tokens 较小时可考虑映射为 low，但 DeepSeek 只有开/关，所以不细分
    if (thinking && typeof thinking === 'object') {
        if (thinking.type === 'enabled') {
            thinkingEnabled = true;
        } else if (thinking.type === 'disabled') {
            thinkingEnabled = false;
        }
    }

    // A client may request thinking, but never make an unsupported settings
    // capability appear available merely because the model name said so.
    if (cachedCapability && cachedCapability.thinking_supported === false) {
        thinkingEnabled = false;
    }

    const parsedParts = parseModelNameParts(modelName);
    return {
        modelType,
        thinkingEnabled,
        searchRequested: parsedParts.search,
        modelVariant: getModelVariant(modelName),
        capabilities: cachedCapability,
        capabilitySource: cachedCapability
            ? (cachedCapability.thinking_supported == null ? 'settings-unknown' : 'settings')
            : 'heuristic',
    };
}

/**
 * 上传文件到 DeepSeek Web（新 API v2）
 *
 * 使用 PoW 认证 + multipart/form-data 上传文件到 /api/v0/file/upload_file。
 * 上传成功后返回 file_id，可用于 chat completion 的 ref_file_ids。
 *
 * @param {string} token - Bearer token
 * @param {Buffer} fileBuffer - 文件内容
 * @param {string} filename - 文件名
 * @param {Object} [options] - 可选参数
 * @param {string} [options.modelType] - 目标模型类型（vision/default）
 * @param {string} [options.contentType] - MIME 类型
 * @param {string} [options.proxyUrl] - 账号级代理 URL（透传给底层 httpsRequest）
 * @param {Object} [options.fingerprint] - 账号指纹（透传给底层 httpsRequest）
 * @returns {Promise<{fileId: string, fileName: string}|null>}
 */
async function uploadFile(token, fileBuffer, filename, options = {}) {
    if (!token || !fileBuffer || !filename) {
        logger.warn('[DPSK] uploadFile: 缺少必要参数', 'DPSK');
        return null;
    }

    const mimeType = options.contentType || 'application/octet-stream';
    // 文件上传是通用操作，默认走 default；调用方（如 vision 流程）可显式覆盖
    const modelType = options.modelType || 'default';
        const { proxyUrl, fingerprint, signal = null } = options;

    try {
        // 1. 获取 PoW 挑战（upload_file 场景）
        const challengeRes = await httpsRequest('POST', '/api/v0/chat/create_pow_challenge', {
            'authorization': `Bearer ${token}`,
            'content-type': 'application/json',
        }, JSON.stringify({ target_path: '/api/v0/file/upload_file' }), proxyUrl, fingerprint, signal);

        const challengeData = JSON.parse(challengeRes.body);
        if (challengeData.code !== 0 || challengeData.data?.biz_code !== 0) {
            logger.warn(`[DPSK] uploadFile: PoW 挑战失败 code=${challengeData.code} biz_code=${challengeData.data?.biz_code}`, 'DPSK');
            return null;
        }
        const challenge = challengeData.data.biz_data.challenge;
        const powResponse = await dpskPow.solvePow(challenge, signal);

        // 2. 构建 multipart — 仅 file 字段（与前端 FormData 一致）
        const CRLF = '\r\n';
        const boundary = `----FormBoundary${Date.now()}${Math.random().toString(36).slice(2)}`;
        const parts = [];
        parts.push(Buffer.from(
            `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="file"; filename="${filename}"${CRLF}` +
            `Content-Type: ${mimeType}${CRLF}${CRLF}`
        ));
        parts.push(fileBuffer);
        parts.push(Buffer.from(`${CRLF}--${boundary}--${CRLF}`));
        const body = Buffer.concat(parts);

        // 3. 上传
        const res = await httpsRequest('POST', UPLOAD_URL, {
            'authorization': `Bearer ${token}`,
            'content-type': `multipart/form-data; boundary=${boundary}`,
            'x-ds-pow-response': powResponse,
            'x-thinking-enabled': '0',
            'x-model-type': modelType,
            'x-file-size': String(fileBuffer.length),
        }, body, proxyUrl, fingerprint, signal);

        // 兼容旧端点 HTML 回退
        if (typeof res.body === 'string' && (res.body.startsWith('<!doctype html>') || res.body.startsWith('<!DOCTYPE html>'))) {
            logger.warn('[DPSK] uploadFile: 端点返回 HTML，回退', 'DPSK');
            return null;
        }

        const data = JSON.parse(res.body);
        if (data.code !== 0 || data.data?.biz_code !== 0) {
            logger.warn(`[DPSK] uploadFile: 上传失败 status=${res.status} code=${data.code} biz_code=${data.data?.biz_code} body=${String(res.body).slice(0, 300)}`, 'DPSK');
            return null;
        }

        const bizData = data.data.biz_data;
        const fileId = bizData.id || bizData.file_id;
        if (fileId) {
            logger.info(`[DPSK] uploadFile: 成功 fileId=${fileId}`, 'DPSK');
            return { fileId: String(fileId), fileName: filename };
        }

        logger.warn(`[DPSK] uploadFile: 响应中无 fileId body=${String(res.body).slice(0, 300)}`, 'DPSK');
        return null;
    } catch (err) {
        logger.warn(`[DPSK] uploadFile: 异常: ${err.message}`, 'DPSK');
        return null;
    }
}

/**
 * 轮询文件解析状态，直到 SUCCESS/FAILED 或超时
 *
 * @param {string} token - Bearer token
 * @param {string} fileId - 文件 ID
 * @param {number} [maxRetries=15] - 最大轮询次数（每次间隔 2s）
 * @param {Object} [options={}] - 可选参数
 * @param {string} [options.proxyUrl] - 账号级代理 URL（透传给底层 httpsRequest）
 * @param {Object} [options.fingerprint] - 账号指纹（透传给底层 httpsRequest）
 * @returns {Promise<Object|null>} 文件信息对象，失败返回 null
 */
async function pollFileStatus(token, fileId, maxRetries = 15, options = {}) {
    const { proxyUrl, fingerprint, signal = null } = options;
    for (let i = 0; i < maxRetries; i++) {
        if (signal?.aborted) return null;
        await new Promise((resolve) => {
            let onAbort = null;
            const timer = setTimeout(() => {
                if (signal && onAbort) signal.removeEventListener('abort', onAbort);
                resolve();
            }, 2000);
            if (!signal) return;
            onAbort = () => {
                clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
                resolve();
            };
            signal.addEventListener('abort', onAbort, { once: true });
        });
        if (signal?.aborted) return null;
        try {
            const res = await httpsRequest('GET', `${FETCH_FILES_URL}?file_ids=${encodeURIComponent(fileId)}`, {
                'authorization': `Bearer ${token}`,
            }, null, proxyUrl, fingerprint, signal);

            const data = JSON.parse(res.body);
            if (data.code !== 0) continue;

            const files = data.data?.biz_data?.files || [];
            const file = files.find(f => f.id === fileId);
            if (!file) continue;

            if (file.status === 'SUCCESS' || file.status === 'FAILED' || file.status === 'CONTENT_FILTER') {
                return file;
            }
        } catch (_) { /* 忽略轮询错误，继续 */ }
    }
    return null;
}

/**
 * 调用 vision 模型描述图片，返回图片描述文本
 *
 * 创建独立的 vision session，发送图片 ref_file_id，收集 text 输出。
 *
 * @param {string} token - Bearer token
 * @param {string} fileId - 已上传的文件 ID
 * @param {Object} [options]
 * @param {string} [options.prompt] - 描述提示词
 * @param {string} [options.proxyUrl] - 账号级代理 URL（透传给 createSession / sendChatMessage）
 * @param {Object} [options.fingerprint] - 账号指纹（透传给 createSession / sendChatMessage）
 * @returns {Promise<string>} 图片描述文本（空字符串表示失败）
 */
async function describeImageWithVision(token, fileId, options = {}) {
    const prompt = options.prompt || '请详细描述这张图片中的内容，包括颜色、形状、物体等。只输出描述内容，不要额外说明。';
    const { proxyUrl, fingerprint, signal = null } = options;
    // 30 秒超时控制，防止上游无响应时一直挂起
    const VISION_TIMEOUT_MS = 30000;
    let timeoutId;
    let localAbort = null;
    let onParentAbort = null;
    try {
        localAbort = new AbortController();
        onParentAbort = () => localAbort.abort();
        if (signal) {
            signal.addEventListener('abort', onParentAbort, { once: true });
            if (signal.aborted) localAbort.abort();
        }
        const timeoutPromise = new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
                localAbort.abort();
                reject(new Error('describeImageWithVision 超时'));
            }, VISION_TIMEOUT_MS);
        });
        const result = await Promise.race([
            (async () => {
                const session = await createSession(token, proxyUrl, fingerprint, localAbort.signal);
                const stream = sendChatMessage(token, session.id, prompt, {
                    modelType: 'vision',
                    thinkingEnabled: false,
                    refFileIds: [fileId],
                    proxyUrl,
                    fingerprint,
                    signal: localAbort.signal,
                });

                let text = '';
                for await (const chunk of stream) {
                    if (chunk.type === 'text') {
                        text += chunk.content;
                    }
                }
                return text.trim();
            })(),
            timeoutPromise,
        ]);
        if (signal?.aborted) return '';
        return result;
    } catch (err) {
        logger.debug(`[DPSK] describeImageWithVision: ${err.message}`, 'DPSK');
        return '';
    } finally {
        clearTimeout(timeoutId);
        if (signal && onParentAbort) signal.removeEventListener('abort', onParentAbort);
        localAbort?.abort();
    }
}

/**
 * 从消息中提取文件，尝试上传到 DeepSeek，返回 ref_file_ids
 *
 * @param {string} token - Bearer token
 * @param {Array<Object>} messages - 消息数组
 * @param {Object} [options] - 可选参数
 * @param {string} [options.modelType] - 上传时使用的模型类型，默认 default
 * @param {string} [options.proxyUrl] - 账号级代理 URL（透传给 uploadFile）
 * @param {Object} [options.fingerprint] - 账号指纹（透传给 uploadFile）
 * @returns {Promise<Array<string>>} ref_file_ids 数组
 */
async function uploadFilesFromMessages(token, messages, options = {}) {
    if (!token || !Array.isArray(messages)) return [];

    const uploadModelType = options.modelType || 'default';
    const { proxyUrl, fingerprint, signal = null } = options;
    const fileIds = [];
    for (const msg of messages) {
        if (!msg || !Array.isArray(msg.content)) continue;
        for (const c of msg.content) {
            if (signal?.aborted) return fileIds;
            if (!c) continue;

            let fileBuffer = null;
            let mimeType = 'application/octet-stream';
            let fileName = 'file';

            if (c.type === 'image_url' || c.type === 'image') {
                // 图片：支持 OpenAI image_url（data URI / HTTP URL）和 Anthropic image.source.base64
                const source = c.image?.source;
                if (source && source.type === 'base64' && typeof source.data === 'string') {
                    // Anthropic 格式：source.data 是纯 base64，source.media_type 是 MIME
                    mimeType = source.media_type || 'image/png';
                    try {
                        fileBuffer = Buffer.from(source.data, 'base64');
                        const extMatch = mimeType.match(/\/(\w+)$/);
                        fileName = `image.${extMatch ? extMatch[1] : 'png'}`;
                    } catch (_) { /* ignore */ }
                } else {
                    const imageData = c.image_url?.url || c.image?.url || '';
                    const dataUri = parseDataUri(imageData);
                    if (dataUri) {
                        mimeType = dataUri.mimeType;
                        fileBuffer = dataUri.data;
                        const extMatch = mimeType.match(/\/(\w+)$/);
                        fileName = `image.${extMatch ? extMatch[1] : 'png'}`;
                    } else if (imageData.startsWith('http://') || imageData.startsWith('https://')) {
                        // HTTP(S) 图片 URL：下载后上传
                        try {
                            const { buffer: imgBuffer } = await downloadHttpUrl(imageData, { timeout: 30000, signal });
                            fileBuffer = imgBuffer;
                            mimeType = 'image/png';
                            fileName = 'image.png';
                        } catch (err) {
                            logger.warn(`[DPSK] uploadFilesFromMessages: 下载图片失败 ${imageData.slice(0, 80)}: ${err.message}`, 'DPSK');
                        }
                    }
                }
            } else {
                // 文件：从 file_url 提取
                const fileUrl = c.file_url?.url || c.file?.url || c.url || '';
                fileName = c.file_url?.filename || c.file?.filename || c.filename || 'file';

                const fileDataUri = parseDataUri(fileUrl);
                if (fileDataUri) {
                    mimeType = fileDataUri.mimeType;
                    fileBuffer = fileDataUri.data;
                } else if (fileUrl && isLocalPath(fileUrl)) {
                    try {
                        if (fs.existsSync(fileUrl)) {
                            fileBuffer = readLocalFile(fileUrl);
                            const ext = path.extname(fileUrl).toLowerCase();
                            const extMap = { '.txt': 'text/plain', '.js': 'text/javascript', '.py': 'text/x-python', '.json': 'application/json', '.md': 'text/markdown', '.pdf': 'application/pdf', '.csv': 'text/csv', '.html': 'text/html', '.css': 'text/css', '.xml': 'text/xml', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
                            mimeType = extMap[ext] || 'application/octet-stream';
                        }
                    } catch (_) { /* ignore */ }
                }
            }

            if (fileBuffer && fileBuffer.length > 0) {
                const result = await uploadFile(token, fileBuffer, fileName, { contentType: mimeType, modelType: uploadModelType, proxyUrl, fingerprint, signal });
                if (result && result.fileId) {
                    fileIds.push(result.fileId);
                } else {
                    logger.warn(`[DPSK] uploadFilesFromMessages: 上传失败 ${fileName} (${mimeType})`, 'DPSK');
                }
            }
        }
    }

    return fileIds;
}

module.exports = {
    login,
    createSession,
    sendChatMessage,
    getModels,
    getModelCapabilities,
    getModelVariant,
    // Deterministic fixture hook; production callers should use getModels().
    _setModelCapabilitiesForTest: (models) => cacheModelCapabilities(Array.isArray(models) ? models : []),
    _featureEnabledForTest: featureEnabled,
    _featureStateForTest: featureState,
    resolveModelOptions,
    uploadFile,
    uploadFilesFromMessages,
    pollFileStatus,
    describeImageWithVision,
    httpsRequest,
    parseDeepSeekSSE,
};
