/**
 * Qwen Web chat 上游请求编排层。
 *
 * 这里是账号选择、会话粘滞、chat_id 获取、上游请求、失败换号的唯一入口。
 * Controller 不应该自己并发打多个账号；需要重试时调用 sendChatRequest(body, req, { account })，
 * 让这里保持“优先同账号，失败再串行换号”的不变量。
 */
const axios = require('axios')
const accountManager = require('../../utils/account.js')
const config = require('../../config/index.js')
const { logger } = require('../../utils/logger')
const pool = require('../../utils/account-pool-redis')
const scorer = require('../../utils/account-scorer')
const upstream = require('./upstream-client')
const { buildQwenHeaders } = require('../../providers/qwen-web/headers')
const chatIdPool = require('./chat-id-pool')
const qwenWeb = require('../../providers/qwen-web')
const { generateChatID } = require('./chat-id')
const { getChatBaseUrl } = require('../../utils/proxy-helper')

/**
 * 从 account.clientProfile 和 req.qwenProfileOverride 提取 per-account 请求头覆盖。
 * 用于实验：每账号固定不同设备指纹/语言/时区。
 * req.qwenProfileOverride 优先级高于 account.clientProfile。
 * 默认 clientProfile 和 qwenProfileOverride 均为空，不改变现有行为。
 */
const buildAccountExtraHeaders = (account, req) => {
  const p = (req && req.qwenProfileOverride) ? req.qwenProfileOverride : (account && account.clientProfile) || {}
  if (!p || (!p.userAgent && !p.secChUa && !p.secChUaPlatform && !p.acceptLanguage && !p.timezone)) return {}
  const extra = {}
  if (p.userAgent) {
    extra['User-Agent'] = p.userAgent
  }
  if (p.secChUa) {
    extra['sec-ch-ua'] = p.secChUa
    extra['Sec-Ch-Ua'] = p.secChUa
  }
  if (p.secChUaPlatform) extra['Sec-Ch-Ua-Platform'] = p.secChUaPlatform
  if (p.acceptLanguage) extra['Accept-Language'] = p.acceptLanguage
  if (p.timezone) extra['Timezone'] = p.timezone
  return extra
}
const {
    markLatency,
    setLatencyFields,
    logLatency,
    messageStats
} = require('../../utils/chat-latency-monitor.js')

// 传输层（非 HTTP）错误码 — 这些重试的, HTTP 响应不重试
const RETRYABLE_ERROR_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ECONNABORTED',
    'EAI_AGAIN',
    'ENOTFOUND'  // DNS 解析失败：间歇性发生，换号/换代理可恢复
])

const isRetryableNetworkError = (error) => {
    if (!error) return false
    // 已收到 HTTP 响应 = 上游回包了, 不是传输问题
    if (error.response) return false
    if (error.code && RETRYABLE_ERROR_CODES.has(error.code)) return true
    if (typeof error.message === 'string' && error.message.includes('socket hang up')) return true
    return false
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const readStreamPreview = (stream, maxBytes = 4096) => new Promise((resolve) => {
    if (!stream || typeof stream.on !== 'function') {
        resolve('')
        return
    }
    const chunks = []
    let total = 0
    let settled = false
    const finish = () => {
        if (settled) return
        settled = true
        try {
            resolve(Buffer.concat(chunks, Math.min(total, maxBytes)).toString('utf8'))
        } catch (_) {
            resolve('')
        }
    }
    stream.on('data', (chunk) => {
        if (settled) return
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        if (total < maxBytes) {
            const take = Math.min(buf.length, maxBytes - total)
            chunks.push(buf.subarray(0, take))
        }
        total += buf.length
        if (total >= maxBytes) {
            try { stream.destroy() } catch (_) {}
            finish()
        }
    })
    stream.on('end', finish)
    stream.on('error', finish)
    stream.on('close', finish)
})

const isEventStreamResponse = (response) => {
    const contentType = String(response?.headers?.['content-type'] || '').toLowerCase()
    return contentType.includes('text/event-stream')
}

const isRiskControlPayload = (text) => (
    /FAIL_SYS_USER_VALIDATE|RGV587_ERROR|captcha|punish/i.test(String(text || ''))
)

const parseRiskControlPayload = (text) => {
    const rawText = String(text || '')
    if (!rawText) return null

    let parsed = null
    try {
        parsed = JSON.parse(rawText)
    } catch (_) {
        parsed = null
    }

    const retList = Array.isArray(parsed?.ret) ? parsed.ret.map(item => String(item)) : []
    const punishUrl = parsed?.data?.url ? String(parsed.data.url) : ''
    const riskCode = retList[0] || ''
    const riskMessage = retList[1] || ''

    return {
        rawText,
        parsed,
        retList,
        punishUrl,
        riskCode,
        riskMessage
    }
}

const getChatAccounts = () => {
    const accounts = accountManager.getAllAccountKeys
        ? accountManager.getAllAccountKeys()
        : accountManager.accountTokens
    return Array.isArray(accounts) ? accounts : []
}

const pickFailoverAccount = async (excludedEmails) => {
    const excluded = excludedEmails instanceof Set ? excludedEmails : new Set()
    const now = Date.now()
    const candidates = getChatAccounts().filter(account => (
        account && account.email && account.token && !excluded.has(account.email)
    ))
    if (candidates.length === 0) return null

    // 预先构建 account -> proxyKey 映射，避免对每个账号重复调用 pool.getProxyKey
    const proxyKeyOf = new Map(candidates.map(account => [account, pool.getProxyKey(account)]))
    const proxyKeys = [...new Set(proxyKeyOf.values())]
    const proxyStates = await pool.getProxyStates(proxyKeys)
    const available = candidates.filter((account) => {
        const proxyCooldown = proxyStates[proxyKeyOf.get(account)] || 0
        return proxyCooldown <= now
    })
    const picked = await scorer.pickBestAccount(available.length > 0 ? available : candidates, { now })
    return picked || null
}

const getHeaderValue = (req, name) => {
    if (!req || !name) return ''
    if (typeof req.get === 'function') return req.get(name) || ''
    const headers = req.headers || {}
    return headers[name] || headers[name.toLowerCase()] || ''
}

const firstNonEmpty = (...values) => {
    for (const value of values) {
        if (value !== undefined && value !== null && String(value).trim()) {
            return String(value).trim()
        }
    }
    return ''
}

const getStickySourceBody = (req) => {
    if (req && req.originalBody && typeof req.originalBody === 'object') {
        return req.originalBody
    }
    return (req && req.body) || {}
}

/**
 * 会话粘滞：同一 API key + 同一 session 指纹 30 分钟内优先同一账号
 * 失败（网络/5xx/429/chat_id=null）会换下一个——粘滞不等于死锁
 *
 * 指纹来源（按优先级）：
 *   1) Anthropic metadata.user_id / metadata.session_id
 *   2) 常见客户端会话 header：X-Session-ID / X-Amp-Thread-Id / X-Codex-Session-Id 等
 *   3) req.body.sessionId / req.body.session_id（客户端显式传）
 *   4) Anthropic/OpenAI 风格：取最后一条 user 消息前 64 字符
 *   5) 没有则用 IP（弱粘滞）
 * @param {Object} req - Express 请求
 * @returns {string|null} session fingerprint
 */
const extractSessionFingerprint = (req) => {
    if (!req) return null
    const body = getStickySourceBody(req)
    const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : {}
    const explicitSession = firstNonEmpty(
        metadata.user_id,
        metadata.session_id,
        getHeaderValue(req, 'X-Session-ID'),
        getHeaderValue(req, 'Session_id'),
        getHeaderValue(req, 'X-Amp-Thread-Id'),
        getHeaderValue(req, 'X-Codex-Session-Id'),
        body.sessionId,
        body.session_id,
        body.conversation_id
    )
    if (explicitSession) return `explicit_${explicitSession}`

    const messages = Array.isArray(body.messages) ? body.messages : []
    if (messages.length > 0) {
        // 取最后一条 user 消息的纯文本前 64 字符
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i]
            if (!m || m.role !== 'user') continue
            let text = ''
            if (typeof m.content === 'string') text = m.content
            else if (Array.isArray(m.content)) {
                for (const c of m.content) {
                    if (c && typeof c.text === 'string') text += c.text
                }
            }
            if (text) {
                // 简单哈希：避免暴露用户原文
                let h = 0
                const s = String(text).slice(0, 64)
                for (let j = 0; j < s.length; j++) h = ((h << 5) - h + s.charCodeAt(j)) | 0
                return `s_${(h >>> 0).toString(16)}`
            }
        }
    }

    if (req.ip) return `ip_${req.ip}`
    return null
}

// 进程内 sticky fallback：file/none 模式时使用，避免每个请求都查 Redis
// Redis 模式下，sticky 走 account-pool-redis 共享
const stickyTable = new Map()
const stickyWindowMs = () => config.sessionStickyMs || 30 * 60 * 1000

// 用 Redis 时的 key 持久化层：把 stickyTable 改为 redis
const _useRedisSticky = () => config.dataSaveMode === 'redis'

/**
 * 在 sticky 窗口内命中时返回之前选中的账号；miss 时回退到默认选择
 * - Redis 模式：sticky 走 Redis，所有 PM2 worker 共享
 * - file/none 模式：进程内 stickyTable（仅单进程内粘滞）
 * - score 评分始终从 Redis 取（如果可用）
 *
 * @param {Object} accountManager
 * @param {Object} req
 * @returns {Promise<Object|null>} 选中的 account
 */
const pickAccountWithSticky = async (accountManager, req) => {
    if (!accountManager || !accountManager.isInitialized) return null
    const window = stickyWindowMs()
    if (window <= 0) return accountManager.getAccount()

    const body = (req && req.body) || {}
    const sessionKey = pool.buildSessionKey(req, body)
    const now = Date.now()

    // 1) Redis 粘滞：尝试从共享 sticky 取
    let stickyEmail = null
    if (_useRedisSticky()) {
        stickyEmail = await pool.getStickyAccount(sessionKey)
    } else {
        // 进程内 sticky
        const fp = extractSessionFingerprint(req)
        const apiKey = (req && req.apiKey) || 'anon'
        if (fp) {
            const key = `${apiKey}::${fp}`
            const cached = stickyTable.get(key)
            if (cached && (Date.now() - cached.lastUsedAt) < window) {
                stickyEmail = cached.email
            }
        }
    }

    // 2) 评分选择（Redis 模式读取 Redis state；file 模式也支持读 in-memory 0）
    const accounts = accountManager.getAllAccountKeys ? accountManager.getAllAccountKeys() : accountManager.accountTokens
    const proxyKeys = [...new Set((accounts || []).map(account => pool.getProxyKey(account)))]
    const proxyStates = await pool.getProxyStates(proxyKeys)
    const availableAccounts = (accounts || []).filter((account) => {
        if (!account || !account.token) return false
        const proxyCooldown = proxyStates[pool.getProxyKey(account)] || 0
        return proxyCooldown <= now
    })
    // 兜底：proxy cooldown 把所有账号都过滤时，放行最近期的可用账号
    const withToken = (accounts || []).filter(a => a && a.token)
    const candidateAccounts = availableAccounts.length > 0
        ? availableAccounts
        : withToken
    const stickyAccount = stickyEmail
        ? candidateAccounts.find(account => account.email === stickyEmail)
        : null
    const effectiveStickyEmail = stickyAccount ? stickyEmail : null
    let chosen = await scorer.pickBestAccount(candidateAccounts, {
        excludeEmail: null,
        stickyEmail: effectiveStickyEmail,
        now
    })

    // 兜底：scorer 没返回时回到 manager.getAccount
    if (!chosen) {
        chosen = effectiveStickyEmail
            ? stickyAccount
            : (candidateAccounts[0] || null)
    }

    if (chosen && chosen.email) {
        // 3) 写回 sticky
        if (_useRedisSticky()) {
            await pool.setStickyAccount(sessionKey, chosen.email)
        } else {
            const fp = extractSessionFingerprint(req)
            const apiKey = (req && req.apiKey) || 'anon'
            if (fp) stickyTable.set(`${apiKey}::${fp}`, { email: chosen.email, lastUsedAt: Date.now() })
        }
        // 4) last_used_at
        await pool.setLastUsed(chosen.email)
    }
    return chosen
}

/**
 * 把 sticky 表里指定账号的绑定清掉——失败重试时调用
 * 同时清 Redis + 进程内 fallback
 * @param {string} email
 */
const invalidateStickyFor = async (email) => {
    if (!email) return
    // 进程内
    for (const [key, val] of stickyTable.entries()) {
        if (val.email === email) stickyTable.delete(key)
    }
    // Redis：当前没有 sessionKey，无法精确删除。改为：让 entry 自然 TTL 过期。
    // 失败重试期间不会再选该账号（exclusion），所以不需要立即删
}

/**
 * 把当前 sticky 绑定到新的 email（粘滞失败后切换账号用）
 * @param {Object} req
 * @param {string} newEmail
 */
const rebindSticky = async (req, newEmail) => {
    if (!req || !newEmail) return
    const body = (req && req.body) || {}
    const sessionKey = pool.buildSessionKey(req, body)
    if (_useRedisSticky()) {
        await pool.setStickyAccount(sessionKey, newEmail)
    } else {
        const fp = extractSessionFingerprint(req)
        const apiKey = (req && req.apiKey) || 'anon'
        if (fp) stickyTable.set(`${apiKey}::${fp}`, { email: newEmail, lastUsedAt: Date.now() })
    }
}

/**
 * 发送聊天请求
 * - generateChatID 失败时立即换下一个账号重试，不发送 null chat_id
 * - 5xx / 429 / 网络错误切下一个账号（不再固定同一账号重试）
 * - 同 API key + 同 session 指纹 30 分钟内优先同一账号
 * - Redis 模式：inFlight / failures / next_retry 全部走共享
 * - finally 内一定 inFlight -1，避免泄漏
 *
 * Account consistency:
 *   - options.account lets controllers reuse the account selected before image upload.
 *   - If that account fails, failover still happens serially; uploaded OSS
 *     file_url values stay usable and are not re-uploaded.
 * @param {Object} body - 请求体
 * @param {Object} [req] - Express 请求（用于会话粘滞）
 * @param {Object} [options] - 选项
 * @param {Object} [options.account] - 预选账号（含 token / proxy / email）
 * @returns {Promise<Object>} 响应结果，结构：
 *   { status: number|false, response: axiosStream|null, currentAccount, error? }
 *
 * 关键流程：
 *   1. 账号选择：优先 options.account → pickAccountWithSticky（会话粘滞 30min）
 *   2. chat_id 获取：优先从 chatIdPool 取 → 无池则调 generateChatID 同步生成
 *   3. 上游请求：统一走 upstream-client.buildRequestConfig（keepAlive + 代理缓存）
 *   4. 重试策略：网络错误/5xx/429 → 换下一个账号重试，chat_id=null 也换号
 *   5. 始终流式：上游 Qwen Web 不支持 stream=false，responseType 永远是 stream
 */
const sendChatRequest = async (body, req, options = {}) => {
    // Do not hard-block the chat path on accountManager readiness here. The
    // normal account selection path already handles sticky state, chat_id pool,
    // failover, and inFlight accounting; if no account is available, that path
    // returns a precise no-account error.
    // 如果确实拿不到可用账号（getAccount() 返回 null/空 token），由后续
    //   "no_available_account" 兜底逻辑兜住——同样不会因临时初始化问题误判。

    // 优先使用预选账号；未提供才走 pickAccountWithSticky。
    // 预选账号通常来自 middleware/buildInternalRequest，用于保证图片上传、
    // 首轮请求、controller 级 retry 使用同一个账号，减少跨账号上下文不一致。
    const hasPreSelected = !!(options && options.account && options.account.token)
    // C5: req.lease 存在时优先使用 lease.account，跳过 pickAccountWithSticky
    //   （并发控制/账号选择已由 scheduler + lease 完成，request.js 不再二次选号）
    const hasLease = !!(req && req.lease && req.lease.account && req.lease.account.token)
    let currentAccount = hasPreSelected
        ? options.account
        : hasLease
            ? req.lease.account
            : (req ? await pickAccountWithSticky(accountManager, req) : accountManager.getAccount())
    let currentToken = currentAccount ? currentAccount.token : null
    // J2: 已输出内容后禁止透明重试 — 由 stream-handler 通过 options/req 传入该标志
    //   当 caller 已向客户端输出过 reasoning/content/tool_call delta 时，request.js
    //   内部不再切账号重试，避免不同账号输出拼接造成客户端语义混乱。
    //   注意：stream-handler 异步设置 req.emittedAnyClientDelta，必须动态读取
    const hasEmitted = () => !!(options && options.emittedAnyClientDelta)
        || !!(req && req.emittedAnyClientDelta)
    const latency = options.latency || req?.chatLatency || null
    setLatencyFields(latency, {
        account: currentAccount?.email,
        model: body?.model,
        ...messageStats(body?.messages)
    })
    markLatency(latency, 'accountSelected', {
        account: currentAccount?.email
    })

    if (!currentToken) {
        // 紧急救火：明确报错（之前只 console.error 然后默默返回 status=false）
        const count = (accountManager && accountManager.accountTokens) ? accountManager.accountTokens.length : 0
        const reason = count === 0 ? 'no_accounts_loaded' : 'no_available_account'
        logger.error(`[DIAG] 无法获取有效的访问令牌: ${reason} (count=${count})`, 'TOKEN')
        return {
            status: false,
            response: null,
            error: `no_available_account: count=${count} reason=${reason}`
        }
    }

    // inFlight +1（Redis 模式原子共享；file 模式 no-op）
    // C6: req.lease 存在时并发控制由 scheduler 负责，跳过 pool.incrInFlight/decrInFlight
    if (!hasLease) {
        await pool.incrInFlight(currentAccount.email)
    }

    let released = false
    const release = async (reason = 'manual') => {
        if (released) return false
        released = true
        // C6: lease 存在时由 scheduler 管理并发，跳过 pool.decrInFlight
        if (!hasLease && currentAccount && currentAccount.email) {
            try {
                await pool.decrInFlight(currentAccount.email)
            } catch (_) { /* ignore */ }
        }
        return true
    }

    const bindStreamRelease = (stream) => {
        // 成功返回的是还没被 controller 读完的上游 stream。
        // inFlight 不能在 return 前释放，否则账号评分会低估长任务占用；
        // 也不能依赖 controller 手动释放，所以绑定 stream end/close/error 自动释放。
        if (!stream || typeof stream.once !== 'function') return
        const autoRelease = (reason) => {
            release(reason).catch(() => {})
        }
        stream.once('end', () => autoRelease('stream-end'))
        stream.once('close', () => autoRelease('stream-close'))
        stream.once('error', () => autoRelease('stream-error'))
    }

    const chatBaseUrl = getChatBaseUrl()

    const maxRetries = Math.max(0, parseInt(config.chatRetryCount, 10) || 0)
    const backoffMs = Math.max(0, parseInt(config.chatRetryBackoffMs, 10) || 0)
    // 重试上限由配置 QWEN_MAX_ACCOUNT_ATTEMPTS 控制，同时不超过 25% 的账号池（至少 1 个）
    const accountPoolSize = Math.max(1, getChatAccounts().filter(account => account && account.token).length)
    const maxAccountAttempts = Math.min(
        config.qwenMaxAccountAttempts,
        Math.max(1, Math.floor(accountPoolSize * 0.25))
    )
    const totalAttempts = Math.min(maxAccountAttempts, accountPoolSize)

    let lastError = null
    let successResponse = false
    const failedEmails = new Set()
    let connectionErrorCount = 0  // 连续连接错误计数器，≥2 触发快速失败
    const switchToNextAccount = async (logMessage) => {
        if (currentAccount && currentAccount.email) {
            failedEmails.add(currentAccount.email)
        }
        // C6: hasLease → release old lease + acquire new one from scheduler
        //     (respects idle-first scoring, cooldown, weighted random)
        if (hasLease && req && req.lease) {
            try {
                // Release old lease — the account that just failed
                req.lease.release('upstream_error')
            } catch (_) { /* idempotent */ }
            req.lease = null

            // Acquire new lease from scheduler (idle-first weighted scoring)
            try {
                const scheduler = require('./scheduler-singleton')
                const sched = scheduler.getScheduler()
                if (sched) {
                    // Convert failedEmails to accountIds for the scheduler
                    const excludeAccountIds = new Set()
                    for (const email of failedEmails) {
                        const aid = scheduler.getAccountIdByEmail?.(email)
                        if (aid) excludeAccountIds.add(aid)
                    }
                    const newLease = await sched.acquire({
                        requestedModel: req?.modelResolution?.requestedModel || body?.model,
                        baseModel: req?.modelResolution?.baseModel,
                        aliasMode: req?.modelResolution?.aliasMode,
                        estimatedPromptBytes: Buffer.byteLength(JSON.stringify(body || {}), 'utf8'),
                        mediaBytes: 0,
                        signal: req?.abortSignal || null,
                        deadline: Date.now() + 120000,
                        excludeAccountIds
                    })
                    if (newLease && newLease.account && newLease.account.token) {
                        req.lease = newLease
                        currentAccount = newLease.account
                        currentToken = newLease.account.token
                        logger.warn(`聊天请求换号(scheduler): ${logMessage({ email: currentAccount.email })}`, 'REQUEST')
                        if (backoffMs > 0) await delay(backoffMs)
                        return true
                    }
                }
            } catch (e) {
                logger.warn(`Scheduler acquire failed during retry: ${e.message}`, 'REQUEST')
            }
        }

        // Fallback: old pickFailoverAccount (no scheduler / scheduler unavailable)
        const next = await pickFailoverAccount(failedEmails)
        if (!next || !next.token) return false
        logger.warn(logMessage(next), 'REQUEST')
        await _switchAccount(req, currentAccount, next)
        currentAccount = next
        currentToken = next.token
        if (backoffMs > 0) await delay(backoffMs)
        return true
    }
    try {
        for (let attempt = 1; attempt <= totalAttempts; attempt++) {
            // 并行化：buildRequestConfig（含 warmup）与 getOrGenerateChatID（池/网络）相互独立，
            // 同时启动以重叠等待时间，降低首字延迟（chatIdMs 不再串行累加到 firstWriteMs）
            markLatency(latency, 'chatIdStart', {
                account: currentAccount?.email
            })
            // 复用已生成的 chat_id（bootstrap retry 场景），跳过池/网络生成
            const reuseChatId = options && options.reuseChatId ? options.reuseChatId : null
            const chatIdPromise = reuseChatId
                ? Promise.resolve({ chatId: reuseChatId, fromPool: false, reused: true })
                : getOrGenerateChatID(currentToken, body.model, currentAccount)

            // Rebuild per attempt because account-level proxies may differ.
            let requestConfig = await upstream.buildRequestConfig({
                token: currentToken,
                account: currentAccount,
                baseUrl: chatBaseUrl,
                streaming: true,
                includeWarmupCookies: false,
                extraHeaders: {
                    ...buildQwenHeaders({ baseUrl: chatBaseUrl, token: currentToken, account: currentAccount, includeAuthHeader: false, extra: buildAccountExtraHeaders(currentAccount, req) }),
                    'Accept': 'text/event-stream'
                },
                extraConfig: {
                    responseType: 'stream', // 永远流式：上游不支持 stream=false
                    timeout: config.qwenStreamTimeoutMs
                }
            })

            try {
                // 降级：日常请求不打 info 日志
                if (attempt > 1) {
                    logger.info(`聊天请求重试 (尝试 ${attempt}/${totalAttempts})`, 'REQUEST')
                }
                // Prefer a pre-generated one-shot chat_id; fall back to direct generation.
                // chatIdPromise 已在 buildRequestConfig 之前启动，此处仅 await 取回结果
                const idResult = await chatIdPromise
                markLatency(latency, 'chatIdEnd', {
                    chatIdSource: idResult?.reused ? 'reused' : (idResult?.fromPool ? 'pool' : 'generated')
                })
                const chat_id = idResult && idResult.chatId
                if (!chat_id) {
                    // generateChatID 返回 null：当前账号本次失败，换下一个账号
                    lastError = new Error('generateChatID returned null')
                    lastError.chatIdFailure = true
                    if (!hasEmitted() && attempt < totalAttempts) {
                        // 失败分类：chat_id 生成失败 → 短冷却 5s
                        await _recordFailure(currentAccount, lastError)
                        const fromEmail = currentAccount?.email
                        if (await switchToNextAccount(next => `生成 chat_id 失败，换账号重试 (${fromEmail} -> ${next.email})`)) {
                            continue
                        }
                    }
                    break
                }
                // Fix: update Referer to use actual chatId instead of "guest" to avoid x5sec
                requestConfig.headers['Referer'] = `${chatBaseUrl}/c/${encodeURIComponent(chat_id)}`
                const url = qwenWeb.endpoints.buildChatCompletionsUrl(chatBaseUrl, chat_id)
                const payload = { ...body, stream: true, chat_id, parent_id: null }
                const payloadJson = JSON.stringify(payload)
                logger.warn(`[UPSTREAM-REQ] account=${currentAccount?.email} model=${body.model} chatId=${chat_id} payloadChars=${payloadJson.length} messages=${body.messages?.length} hasTools=${req?.has_tools ?? '?'} thinking=${req?.enable_thinking ?? '?'} attempt=${attempt}/${totalAttempts}`, 'REQUEST')
                // 打印上游请求完整 body（调试用，前 4000 字符）
                logger.warn(`[UPSTREAM-BODY] ${payloadJson.substring(0, 4000)}`, 'REQUEST')
                markLatency(latency, 'upstreamPostStart', {
                    account: currentAccount?.email
                })
                let response = await upstream.postJson(url, payload, requestConfig)
                markLatency(latency, 'upstreamHeaders', {
                    httpStatus: response.status
                })
                logLatency(logger, latency, 'upstream_headers')
                if (response.status === 200) {
                    if (!isEventStreamResponse(response)) {
                        const rawPreview = await readStreamPreview(response.data)
                        const contentType = response.headers?.['content-type'] || 'unknown'
                        const nonSseError = new Error(`Upstream returned non-SSE response content-type=${contentType}: ${rawPreview.slice(0, 500)}`)
                        const riskInfo = isRiskControlPayload(rawPreview) ? parseRiskControlPayload(rawPreview) : null
                        nonSseError.response = {
                            status: response.status,
                            headers: response.headers,
                            data: rawPreview
                        }
                        nonSseError.status = response.status
                        nonSseError.kind = riskInfo ? 'upstream_risk_control' : 'upstream_non_sse_response'
                        nonSseError.punishUrl = riskInfo?.punishUrl || ''
                        nonSseError.riskCode = riskInfo?.riskCode || ''
                        nonSseError.riskMessage = riskInfo?.riskMessage || ''
                        lastError = nonSseError
                        await _recordFailure(currentAccount, nonSseError)
                        logger.debug(`[CAPTCHA] upstream raw response content-type=${contentType} preview=${rawPreview.slice(0, 2000)}`, 'REQUEST')
                        if (riskInfo) {
                            const fromEmail = currentAccount?.email

                            // ── RGV587_ERROR 风控绕过策略 ──
                            // 1) 刷新首页预热 cookie（acw_tc / x-ap），可能过期了
                            // 2) 如果有 TLS sidecar，通过 sidecar 模拟浏览器 TLS 指纹重试
                            // 3) 以上都失败再切账号
                            let captchaRecovered = false
                            if (attempt === 1 || attempt === 2) {
                                // 第 1-2 次尝试：刷新 warmup cookies
                                logger.warn(`[CAPTCHA] 检测到风控响应，刷新首页预热 cookie 重试 (${fromEmail})`, 'REQUEST')
                                try {
                                    const { warmupQwenHomepage, _warmupCache, buildWarmupCacheKey } = require('./qwen-homepage-warmup')
                                    const cacheKey = currentAccount?.email
                                        ? buildWarmupCacheKey(currentAccount)
                                        : null
                                    if (cacheKey) _warmupCache.delete(cacheKey)
                                    await warmupQwenHomepage(currentAccount)
                                } catch (_) { /* ignore */ }
                                // 重建 requestConfig（headers 里有预热 cookie）
                                requestConfig = await upstream.buildRequestConfig({
                                    token: currentToken,
                                    account: currentAccount,
                                    baseUrl: chatBaseUrl,
                                    streaming: true,
                                    extraHeaders: {
                                        ...buildQwenHeaders({ baseUrl: chatBaseUrl, token: currentToken, account: currentAccount, includeAuthHeader: false, extra: buildAccountExtraHeaders(currentAccount, req) }),
                                        'Accept': 'text/event-stream'
                                    },
                                    extraConfig: {
                                        responseType: 'stream',
                                        timeout: config.qwenStreamTimeoutMs
                                    }
                                })
                                requestConfig.headers['Referer'] = `${chatBaseUrl}/c/${encodeURIComponent(chat_id)}`
                                try {
                                    const retryResp = await upstream.postJson(url, payload, requestConfig)
                                    if (retryResp.status === 200 && isEventStreamResponse(retryResp)) {
                                        logger.info(`[CAPTCHA] 预热 cookie 刷新后恢复成功 (${fromEmail})`, 'REQUEST')
                                        captchaRecovered = true
                                        response = retryResp
                                    }
                                } catch (_) { /* ignore */ }
                            }

                            if (!captchaRecovered && attempt === 2) {
                                // 第 2 次：尝试 TLS sidecar（如果有）
                                const { isTlsSidecarAvailable, refreshSidecarStatus } = require('../../utils/tls-sidecar-client')
                                const sidecarOk = await refreshSidecarStatus()
                                if (sidecarOk) {
                                    logger.warn(`[CAPTCHA] 尝试通过 TLS sidecar 绕过风控 (${fromEmail})`, 'REQUEST')
                                    const sidecarConfig = { ...requestConfig }
                                    // 走 sidecar 时移除 httpsAgent（sidecar 自己处理 TLS）
                                    delete sidecarConfig.httpsAgent
                                    sidecarConfig.baseURL = undefined
                                    try {
                                        const sidecarResp = await upstream.postJson(url, payload, sidecarConfig)
                                        if (sidecarResp.status === 200 && isEventStreamResponse(sidecarResp)) {
                                            logger.info(`[CAPTCHA] TLS sidecar 绕过风控成功 (${fromEmail})`, 'REQUEST')
                                            captchaRecovered = true
                                            response = sidecarResp
                                        }
                                    } catch (_) { /* ignore */ }
                                }
                            }

                            if (captchaRecovered) {
                                // 恢复成功：走正常成功路径
                                if (currentAccount && currentAccount.email) {
                                    await _recordSuccess(currentAccount, body)
                                }
                                // C4: scheduler 成功统计通过 req.lease.release(outcome)
                                //   在 stream-handler 的 finally 中触发，不在 request.js 中调用
                                successResponse = true
                                bindStreamRelease(response.data)
                                return {
                                    currentToken,
                                    currentAccount,
                                    status: true,
                                    response: response.data,
                                    release,
                                    chat_id
                                }
                            }

                            // J2: 已输出内容后禁止透明重试，不再切账号
                            if (!hasEmitted()) {
                                const switched = await switchToNextAccount(next => (
                                    `Qwen upstream returned captcha/risk-control response; cooling down account and switching (${fromEmail} -> ${next.email})`
                                ))
                                if (switched) {
                                    continue
                                }
                            }
                            logger.warn(`Qwen upstream returned captcha/risk-control response; no failover account available (${fromEmail})`, 'REQUEST')
                            break
                        }
                        if (!hasEmitted() && attempt < totalAttempts) {
                            const fromEmail = currentAccount?.email
                            if (await switchToNextAccount(next => `Upstream returned non-SSE response, switching account (${fromEmail} -> ${next.email})`)) {
                                continue
                            }
                        }
                        break
                    }
                    // 成功：累计 daily stats + reset failures
                    if (currentAccount && currentAccount.email) {
                        await _recordSuccess(currentAccount, body)
                    }
                    // C4: scheduler 成功统计通过 req.lease.release(outcome)
                    //   在 stream-handler 的 finally 中触发，不在 request.js 中调用
                    successResponse = true
                    bindStreamRelease(response.data)
                    return {
                        currentToken,
                        currentAccount,
                        status: true,
                        response: response.data,
                        release,
                        chat_id
                    }
                }
                // 非 200 但是没抛——退出循环
                const rawPreview = await readStreamPreview(response.data).catch(() => 'unreadable')
                logger.warn(`[UPSTREAM-RESP] httpStatus=${response.status} contentType=${response.headers?.['content-type'] || 'unknown'} bodyPreview=${rawPreview.slice(0, 500)} account=${currentAccount?.email} attempt=${attempt}/${totalAttempts}`, 'REQUEST')
                lastError = new Error(`Unexpected status ${response.status}`)
                lastError.response = { status: response.status }
                lastError.status = response.status
                // 5xx 切换到下一个账号
                if (!hasEmitted() && response.status >= 500 && attempt < totalAttempts) {
                    await _recordFailure(currentAccount, lastError)
                    const fromEmail = currentAccount?.email
                    if (await switchToNextAccount(next => `聊天请求 5xx (status=${response.status})，换账号重试 (${fromEmail} -> ${next.email})`)) {
                        continue
                    }
                }
                break
            } catch (error) {
                lastError = error
                if (!hasEmitted() && isRetryableNetworkError(error) && attempt < totalAttempts) {
                    connectionErrorCount++
                    // 网络错误 / timeout 切到下一个账号（避免反复打同一 IP）
                    // 但连接错误是网络层问题，非账号问题，连续 2 次后快速失败
                    await _recordFailure(currentAccount, error)
                    const fromEmail = currentAccount?.email
                    // 连接错误前先等待 500ms，给瞬态网络问题（DNS flap、服务器重启等）恢复窗口
                    if (connectionErrorCount >= 2) {
                        logger.warn(`[UPSTREAM-CONN] 连续 ${connectionErrorCount} 次连接错误，判定为网络层问题，快速失败 (${fromEmail})`, 'REQUEST')
                        break
                    }
                    logger.warn(`[UPSTREAM-CONN] 连接错误 (${fromEmail}, code=${error.code || 'unknown'}), 等待 500ms 后换号重试`, 'REQUEST')
                    await delay(500)
                    if (await switchToNextAccount(next => `聊天请求传输错误，换账号重试 (${fromEmail} -> ${next.email}, code=${error.code || 'unknown'}): ${error.message}`)) {
                        continue
                    }
                }
                // 429 Too Many Requests——切到下一个账号
                if (!hasEmitted() && error.response && error.response.status === 429 && attempt < totalAttempts) {
                    const respBody = typeof error.response.data === 'string' ? error.response.data.slice(0, 500) : JSON.stringify(error.response.data || {}).slice(0, 500)
                    logger.warn(`[UPSTREAM-429] account=${currentAccount?.email} attempt=${attempt}/${totalAttempts} body=${respBody}`, 'REQUEST')
                    // 429/5xx/网络错误才允许换号；正常 controller retry 会把当前账号传回来。
                    // 这样既保留多账号容灾，又不会把同一请求同时扇出给多个账号。
                    await _recordFailure(currentAccount, error)
                    const fromEmail = currentAccount?.email
                    if (await switchToNextAccount(next => `聊天请求 429，换账号重试 (${fromEmail} -> ${next.email})`)) {
                        continue
                    }
                }
                // 401/403/token invalid：标记需要刷新，不清空账号
                if (error.response && (error.response.status === 401 || error.response.status === 403)) {
                    await _recordFailure(currentAccount, error)
                }
                break
            }
        }
    } finally {
        if (!successResponse) {
            await release('finally-failure')
        }
        // C4: scheduler 失败统计通过 req.lease.release(outcome) 在 stream-handler 的
        //   finally 中触发，不在 request.js 中调用
    }

    // 所有尝试失败 — 分类错误
    if (lastError && currentAccount?.email) {
        const hadHttpResponse = !!lastError.response
        if (!hadHttpResponse && isRetryableNetworkError(lastError)) {
            // 传输层失败耗尽重试——记 failure，累计可触发 cooldown
            const networkCode = lastError.code || 'unknown'
            const networkMessage = String(lastError.message || '').slice(0, 200)
            const isTimeout = networkCode === 'ETIMEDOUT'
                || networkCode === 'ECONNABORTED'
                || /timeout/i.test(networkMessage)
            logger.error(
                isTimeout
                    ? `聊天请求超时 (code=${networkCode}, attempts=${totalAttempts}): ${networkMessage}`
                    : `聊天请求传输失败 (code=${networkCode}, attempts=${totalAttempts}): ${networkMessage}`,
                'REQUEST',
                '',
                lastError
            )
            accountManager.recordAccountFailure(currentAccount.email, lastError.code)
        } else if (lastError.chatIdFailure) {
            // generateChatID 返回 null——记 error，不刷屏
            logger.error(
                `聊天请求 chat_id 生成失败耗尽重试 (已尝试 ${totalAttempts} 次)`,
                'REQUEST',
                '',
                lastError
            )
            accountManager.recordAccountError(currentAccount.email, null)
        } else {
            // HTTP 4xx/5xx (上游主动拒绝, 账户有效) — 仅刷新 warn 指示, 不影响 cooldown
            const status = lastError.response?.status
            logger.error('发送聊天请求失败', 'REQUEST', '', lastError)
            accountManager.recordAccountError(currentAccount.email, status)
        }
    } else if (lastError) {
        logger.error('发送聊天请求失败', 'REQUEST', '', lastError)
    }

    return {
        status: false,
        response: null,
        error: lastError?.message || 'send_chat_request_failed',
        errorKind: lastError?.kind || null,
        punishUrl: lastError?.punishUrl || '',
        upstreamStatus: lastError?.status || lastError?.response?.status || null,
        // J2: 已输出内容后失败时标记 incomplete，调用方不应再透明重试
        incomplete: hasEmitted() || false
    }
}

/**
 * 记录请求成功：累计 daily stats + reset failures
 * @param {Object} account
 * @param {Object} body
 */
const _recordSuccess = async (account, body) => {
    if (!account || !account.email) return
    try {
        // 估算 input tokens（粗略）；output 留 0（流式响应不返回总输出，dashboard 也会在解析时补全）
        let input = 0
        try {
            if (Array.isArray(body && body.messages)) {
                // 粗略估算：1 字符 ≈ 1 token（中文 + 英文混合的简化估算）
                for (const m of body.messages) {
                    if (!m) continue
                    if (typeof m.content === 'string') {
                        input += m.content.length
                    } else if (Array.isArray(m.content)) {
                        for (const c of m.content) {
                            if (c && typeof c.text === 'string') input += c.text.length
                        }
                    }
                }
            }
        } catch (_) { /* ignore */ }

        await pool.accumulateDaily(account.email, { input, output: 0, calls: 1 })
        await pool.resetFailures(account.email)
    } catch (_) { /* ignore */ }
}

/**
 * 记录请求失败：分类 + 设置 next_retry_at + 累计 failures
 * @param {Object} account
 * @param {Error} error
 */
const _recordFailure = async (account, error) => {
    if (!account || !account.email) return
    try {
        const cls = pool.classifyFailure(error)
        const failCount = await pool.incrFailures(account.email)
        const cooldown = cls.cooldownMs

        // Short failures back off up to 60s. Long cooldown failures (captcha/auth)
        // must keep their full quarantine window instead of being capped to 60s.
        const rawBackoff = cooldown * Math.pow(2, Math.max(0, failCount - 1))
        const backoff = cls.longCooldown
            ? Math.min(rawBackoff, 60 * 60 * 1000)
            : Math.min(rawBackoff, 60 * 1000)
        const nextRetry = Date.now() + backoff
        await pool.setNextRetry(account.email, nextRetry)
        if (cls.kind === 'captcha_or_risk_control') {
            await pool.setProxyCooldown(account, nextRetry)
        }
        await pool.setLastError(account.email, {
            code: cls.kind,
            message: (error && error.message) ? String(error.message).slice(0, 200) : '',
            at: Date.now()
        })
    } catch (_) { /* ignore */ }
}

/**
 * Switch accounts, update sticky state/inFlight, and invalidate chat_id values
 * generated for the failed account.
 * @param {Object} req
 * @param {Object} fromAccount
 * @param {Object} toAccount
 */
const _switchAccount = async (req, fromAccount, toAccount) => {
    try {
        // C6: req.lease 存在时并发控制由 scheduler 负责，跳过 pool.incrInFlight/decrInFlight
        const hasLease = !!(req && req.lease)
        if (fromAccount && fromAccount.email) {
            if (!hasLease) {
                await pool.decrInFlight(fromAccount.email)
            }
            await invalidateStickyFor(fromAccount.email)
            try { await chatIdPool.invalidate(fromAccount.email) } catch (_) { /* ignore */ }
        }
        if (toAccount && toAccount.email) {
            if (!hasLease) {
                await pool.incrInFlight(toAccount.email)
            }
            await pool.setLastUsed(toAccount.email)
            await rebindSticky(req, toAccount.email)
        }
    } catch (_) { /* ignore */ }
}


/**
 * Get a one-shot chat_id, preferably from the pre-generation pool.
 *
 * Design rule: never put used chat_id values back into the pool.
 *   - 池里的 chat_id 是"预生成但尚未使用"的；取出即被消费，不会再放回
 *   - 同步 generateChatID 得到的 chat_id 也只给当前请求使用，**不再 put 回池**——
 *     避免下一个请求拿到同一个 chat_id，污染 Qwen Web 的会话上下文
 *   - 池的补齐（refill）完全由 chat-id-pool 的 _maybeRefill / primeOnStartup
 *     后台异步逻辑负责；预生成失败不影响当前请求，会回退到同步 generateChatID
 *
 * @param {string} currentToken
 * @param {string} model
 * @param {Object} [account] - 当前账户对象（用于 email 维度分桶）
 * @returns {Promise<{ chatId: string|null, fromPool: boolean }>}
 */
const getOrGenerateChatID = async (currentToken, model, account, options = {}) => {
    const email = account && account.email
    // 1) 先从池里取（take 内部已删除，**不会放回**）
    // 注意：池中的 chat_id 都是 t2t 类型，t2i/t2v/image_edit 不走池
    const skipPool = options.chatType && options.chatType !== 't2t'
    if (email && !skipPool) {
        try {
            const fromPool = await chatIdPool.take(email, model)
            if (fromPool && fromPool.chatId) {
                logger.debug(`chat_id 来自预生成池: ${fromPool.chatId} (${email})`, 'REQUEST')
                return fromPool
            }
        } catch (_) { /* fallthrough to direct generation */ }
    }
    // Pool miss: generate synchronously and consume it exactly once.
    const chatId = await generateChatID(currentToken, model, account, options)
    if (chatId && email) {
        chatIdPool.prewarmOneBestEffort(email, model)
    }
    return { chatId, fromPool: false }
}

module.exports = {
    sendChatRequest,
    generateChatID,
    getOrGenerateChatID,
    pickAccountWithSticky,
    invalidateStickyFor,
    rebindSticky
}
