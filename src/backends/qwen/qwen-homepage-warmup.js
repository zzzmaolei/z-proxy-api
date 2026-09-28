/** Qwen 主页预热 — 预先访问首页获取新鲜 Cookie 避免冷启动 */

const axios = require('axios')
const { logger } = require('../../utils/logger')
const { getChatBaseUrl, getProxyAgent } = require('../../utils/proxy-helper')

const COOKIE_ALLOWLIST = new Set(['acw_tc', 'x-ap'])
const warmupCache = new Map()
const WARMUP_TTL_MS = 60 * 60 * 1000

/**
 * accountRuntime 支持（D4）：
 *  - 传入 accountRuntime 时，warmup cache 读写都走 accountRuntime.warmupState.cacheEntry
 *    （per-account 隔离，不再使用全局 warmupCache）
 *  - 同时维护 lastWarmup / isWarm 字段，保持与 AccountRuntime 字段语义一致
 *  - 未传入 accountRuntime 时，回退到全局 warmupCache Map（向后兼容）
 *
 * warmupState.cacheEntry 结构与全局 warmupCache 的 value 保持一致：
 *   { fetchedAt: number, cookies: Array<{name, value}> }
 */

const extractSetCookies = (headers) => {
    if (!headers) return []
    const raw = headers['set-cookie'] || headers['Set-Cookie']
    if (Array.isArray(raw)) return raw
    if (typeof raw === 'string' && raw) return [raw]
    return []
}

const parseCookiePair = (setCookie) => {
    if (!setCookie || typeof setCookie !== 'string') return null
    const firstPart = setCookie.split(';')[0]?.trim()
    if (!firstPart) return null
    const eqIndex = firstPart.indexOf('=')
    if (eqIndex <= 0) return null
    const name = firstPart.slice(0, eqIndex).trim()
    const value = firstPart.slice(eqIndex + 1).trim()
    if (!name || !value) return null
    return { name, value }
}

const buildWarmupCacheKey = (account) => {
    const email = account && account.email ? String(account.email) : 'anonymous'
    const proxy = account && account.proxy ? String(account.proxy) : 'direct'
    return `${email}::${proxy}`
}

const collectWarmupCookies = (headers) => {
    const cookies = []
    const seen = new Set()
    for (const header of extractSetCookies(headers)) {
        const pair = parseCookiePair(header)
        if (!pair || !COOKIE_ALLOWLIST.has(pair.name) || seen.has(pair.name)) continue
        seen.add(pair.name)
        cookies.push(pair)
    }
    return cookies
}

/**
 * 从 warmupState.cacheEntry 读取缓存的 cookies。
 * 返回 null 表示无缓存或已过期，调用方应自行回退到全局 warmupCache。
 */
const _readFromWarmupState = (accountRuntime) => {
    if (!accountRuntime || !accountRuntime.warmupState) return null
    const entry = accountRuntime.warmupState.cacheEntry
    if (!entry || !Array.isArray(entry.cookies) || entry.cookies.length === 0) return null
    if ((Date.now() - entry.fetchedAt) > WARMUP_TTL_MS) return null
    return entry
}

/**
 * 写入 warmupState.cacheEntry，同时更新 lastWarmup / isWarm 字段。
 */
const _writeToWarmupState = (accountRuntime, cookies) => {
    if (!accountRuntime || !accountRuntime.warmupState) return
    const now = Date.now()
    accountRuntime.warmupState.cacheEntry = { fetchedAt: now, cookies }
    accountRuntime.warmupState.lastWarmup = now
    accountRuntime.warmupState.isWarm = Array.isArray(cookies) && cookies.length > 0
}

const buildWarmupCookieHeader = (account, accountRuntime) => {
    // accountRuntime 提供时优先使用其 warmupState.cacheEntry（per-account 隔离）
    if (accountRuntime && accountRuntime.warmupState) {
        const cached = _readFromWarmupState(accountRuntime)
        if (!cached) {
            // 过期或空：清理 cacheEntry，调用方应触发新的 warmup
            if (accountRuntime.warmupState.cacheEntry) {
                accountRuntime.warmupState.cacheEntry = null
                accountRuntime.warmupState.isWarm = false
            }
            return ''
        }
        return cached.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
    }
    // 回退：全局 warmupCache Map
    const cached = warmupCache.get(buildWarmupCacheKey(account))
    if (!cached || !Array.isArray(cached.cookies) || cached.cookies.length === 0) return ''
    if ((Date.now() - cached.fetchedAt) > WARMUP_TTL_MS) {
        warmupCache.delete(buildWarmupCacheKey(account))
        return ''
    }
    return cached.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
}

/**
 * 同步检查 warmup 缓存状态（不做网络请求）
 * @param {Object} [account]
 * @param {Object} [accountRuntime] - AccountRuntime 实例；提供时检查其 warmupState
 * @returns {'valid'|'expired'|'empty'}
 *   - valid: 缓存命中且未过期，调用方可直接用缓存 cookie，无需任何操作
 *   - expired: 缓存存在但已过期，调用方应后台异步刷新（不阻塞主请求）
 *   - empty: 无缓存条目（首次启动），调用方应同步等待一次 warmup
 */
const getWarmupCacheState = (account, accountRuntime) => {
    // accountRuntime 提供时检查 warmupState.cacheEntry
    if (accountRuntime && accountRuntime.warmupState) {
        const entry = accountRuntime.warmupState.cacheEntry
        if (!entry || !Array.isArray(entry.cookies) || entry.cookies.length === 0) return 'empty'
        if ((Date.now() - entry.fetchedAt) > WARMUP_TTL_MS) return 'expired'
        return 'valid'
    }
    // 回退：全局 warmupCache
    const cached = warmupCache.get(buildWarmupCacheKey(account))
    if (!cached || !Array.isArray(cached.cookies) || cached.cookies.length === 0) return 'empty'
    if ((Date.now() - cached.fetchedAt) > WARMUP_TTL_MS) return 'expired'
    return 'valid'
}

const warmupQwenHomepage = async (account, accountRuntime) => {
    // accountRuntime 提供时优先使用其 warmupState.cacheEntry
    if (accountRuntime && accountRuntime.warmupState) {
        const cached = _readFromWarmupState(accountRuntime)
        if (cached) return cached.cookies
    } else {
        const key = buildWarmupCacheKey(account)
        const cached = warmupCache.get(key)
        if (cached && (Date.now() - cached.fetchedAt) <= WARMUP_TTL_MS) {
            return cached.cookies
        }
    }

    const baseUrl = getChatBaseUrl()
    const proxyAgent = getProxyAgent(account)
    // warmup 使用原生 dns.lookup（低频操作，不需要 DNS 缓存）
    const warmupHttpAgent = new (require('http').Agent)({ keepAlive: true })
    const warmupHttpsAgent = new (require('https').Agent)({ keepAlive: true })
    const requestConfig = {
        httpAgent: warmupHttpAgent,
        httpsAgent: warmupHttpsAgent,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache'
        },
        timeout: 15000,
        maxRedirects: 2
    }

    if (proxyAgent) {
        requestConfig.httpsAgent = proxyAgent
        requestConfig.proxy = false
    }

    try {
        const response = await axios.get(baseUrl, requestConfig)
        const cookies = collectWarmupCookies(response.headers)
        // accountRuntime 提供时写入 warmupState.cacheEntry（per-account 隔离）
        if (accountRuntime && accountRuntime.warmupState) {
            _writeToWarmupState(accountRuntime, cookies)
        } else {
            const key = buildWarmupCacheKey(account)
            warmupCache.set(key, {
                fetchedAt: Date.now(),
                cookies
            })
        }
        return cookies
    } catch (error) {
        logger.debug(`Qwen 首页 warmup 失败: ${error.message}`, 'REQUEST')
        return []
    }
}

module.exports = {
    warmupQwenHomepage,
    buildWarmupCookieHeader,
    collectWarmupCookies,
    buildWarmupCacheKey,
    getWarmupCacheState,
    _warmupCache: warmupCache
}
