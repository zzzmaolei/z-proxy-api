/**
 * account-pool-redis.js
 * PM2 多 worker 共享账号池状态：inFlight / next_retry_at / last_used_at / 失败计数 / 每日 stats
 *
 * 设计目标：
 *  - dataSaveMode='redis' 时，所有 PM2 worker 共享这些 key，避免各自维护内存导致不一致
 *  - dataSaveMode='file' / 'none' 时，所有函数返回 null/false/no-op，调用方降级到内存逻辑
 *  - Redis 暂时不可用时返回 null/false，调用方继续走内存路径，不阻塞主流程
 *
 * Redis key 命名空间（避免与现有 user:* 冲突）：
 *   qwen2api:pool:in_flight:{email}     STRING 整数  TTL 24h safety
 *   qwen2api:pool:next_retry:{email}    STRING 毫秒   TTL = 冷却时间
 *   qwen2api:pool:last_used:{email}     STRING 毫秒   TTL 7d
 *   qwen2api:pool:failures:{email}      STRING 整数   TTL 24h safety
 *   qwen2api:pool:last_error:{email}    STRING JSON   TTL 24h safety
 *   qwen2api:pool:daily:{YYYY-MM-DD}    HASH    field=email, value=JSON {input,output,calls}
 *   qwen2api:pool:claude_session:{key}  STRING email  TTL = SESSION_STICKY_MS
 *
 * 失败/成功统计（请求粒度）也写在 daily stats，但与 accountManager 自带 stats 共存：
 *  - account.stats 是按"成功完成"累计的每日 token
 *  - 本模块 pool:daily 是按"任何一次请求"累计的成功 input/output 与调用次数
 *  - dashboard 优先读 account.stats（持久化），缺失再读 pool:daily
 */

const config = require('../config')
const redisClient = require('./redis')
const { logger } = require('./logger')
const { resolveProxyUrl } = require('./proxy-helper')

const KEY_PREFIX = 'qwen2api:pool'

// classifyFailure 使用的正则常量（避免每次调用都创建新 RegExp 对象）
const RE_CAPTCHA = /FAIL_SYS_USER_VALIDATE|captcha|punish|RGV587_ERROR|non-SSE response/i
const RE_AUTH = /token.*invalid|unauthor/i
const RE_NETWORK = /timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|aborted/i
const RE_NET_CODE = /^(ECONN|ETIMEDOUT|EAI|ENOTFOUND)/
// 24 小时安全 TTL——key 长期不被访问也不会无限增长
const SAFETY_TTL_SECONDS = 24 * 60 * 60
// last_used_at 7 天
const LAST_USED_TTL_SECONDS = 7 * 24 * 60 * 60

const sanitizeEmail = (email) => {
  if (typeof email !== 'string') return ''
  return email.replace(/[^a-zA-Z0-9_.@-]/g, '_')
}

const sanitizeProxyKey = (proxyUrl) => {
  if (!proxyUrl) return 'direct'
  return Buffer.from(String(proxyUrl).trim()).toString('base64url')
}

const getProxyKey = (accountOrProxy) => {
  if (!accountOrProxy) return 'direct'
  if (typeof accountOrProxy === 'string') {
    return sanitizeProxyKey(accountOrProxy)
  }
  return sanitizeProxyKey(resolveProxyUrl(accountOrProxy))
}

const todayKey = () => {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const isRedisUsable = () => config.dataSaveMode === 'redis' && !!redisClient

/**
 * 安全地调用 redis；任何异常都返回 null/false，不抛出。
 * @template T
 * @param {(c: any) => Promise<T>} fn
 * @returns {Promise<T | null>}
 */
const safe = async (fn) => {
  if (!isRedisUsable()) return null
  try {
    return await fn(redisClient)
  } catch (err) {
    // 降级为 DEBUG：Redis 临时不可用不该刷屏
    logger.debug(`pool-redis 失败: ${err.message}`, 'POOL')
    return null
  }
}

// ---------------- inFlight ----------------

/**
 * 请求开始时调用：inFlight 原子 +1，返回新的 inFlight 值。
 * @returns {Promise<number|null>} 失败时返回 null，调用方不应阻塞主流程
 */
const incrInFlight = async (email) => {
  if (!email) return null
  const key = `${KEY_PREFIX}:in_flight:${sanitizeEmail(email)}`
  const val = await safe((c) => c.incr(key))
  if (val === null || val === undefined) return null
  // 设置/续期 24h 安全 TTL（inFlight 通常请求结束就 decr 回到 0，但我们要防御进程崩溃）
  await safe((c) => c.expire(key, SAFETY_TTL_SECONDS))
  return Number(val) || 0
}

/**
 * 请求结束（成功 / 失败 / finally）时调用：inFlight 原子 -1，floor 0。
 * @returns {Promise<number|null>}
 */
const decrInFlight = async (email) => {
  if (!email) return null
  const key = `${KEY_PREFIX}:in_flight:${sanitizeEmail(email)}`
  // 原子 floor 0：使用 lua 防止出现负数（多 worker 并发 -1）
  const script = `local v = tonumber(redis.call('get', KEYS[1]) or '0')
    if v <= 0 then redis.call('set', KEYS[1], '0', 'EX', ARGV[1]) return 0 end
    v = v - 1
    redis.call('set', KEYS[1], tostring(v), 'EX', ARGV[1])
    return v`
  const val = await safe((c) => c.eval(script, 1, key, SAFETY_TTL_SECONDS))
  return val === null || val === undefined ? null : Number(val) || 0
}

/**
 * 读取 inFlight。
 * @returns {Promise<number>}
 */
const getInFlight = async (email) => {
  if (!email) return 0
  const key = `${KEY_PREFIX}:in_flight:${sanitizeEmail(email)}`
  const v = await safe((c) => c.get(key))
  return v ? (Number(v) || 0) : 0
}

/**
 * 批量读取 inFlight。
 * @param {string[]} emails
 * @returns {Promise<Record<string, number>>}
 */
const mgetInFlight = async (emails) => {
  const result = {}
  if (!Array.isArray(emails) || emails.length === 0) return result
  if (!isRedisUsable()) {
    for (const e of emails) result[e] = 0
    return result
  }
  const keys = emails.map((e) => `${KEY_PREFIX}:in_flight:${sanitizeEmail(e)}`)
  const vals = await safe((c) => c.mget(...keys))
  if (!Array.isArray(vals)) {
    for (const e of emails) result[e] = 0
    return result
  }
  for (let i = 0; i < emails.length; i++) {
    const v = vals[i]
    result[emails[i]] = v ? (Number(v) || 0) : 0
  }
  return result
}

// ---------------- next_retry / cooldown ----------------

/**
 * 设置账号的 next_retry_at（毫秒）。TTL 自动 = 冷却时长，避免过期残留。
 * @param {string} email
 * @param {number} atMs
 * @param {number} [ttlSeconds] 默认从 atMs 推导
 */
const setNextRetry = async (email, atMs, ttlSeconds) => {
  if (!email || !Number.isFinite(atMs)) return false
  const ttl = Math.max(1, Math.ceil(((ttlSeconds ? ttlSeconds * 1000 : atMs - Date.now()) / 1000)))
  const key = `${KEY_PREFIX}:next_retry:${sanitizeEmail(email)}`
  return await safe((c) => c.set(key, String(Math.floor(atMs)), 'EX', ttl)) !== null
}

const getNextRetry = async (email) => {
  if (!email) return 0
  const key = `${KEY_PREFIX}:next_retry:${sanitizeEmail(email)}`
  const v = await safe((c) => c.get(key))
  return v ? (Number(v) || 0) : 0
}

const setProxyCooldown = async (accountOrProxy, atMs, ttlSeconds) => {
  if (!Number.isFinite(atMs)) return false
  const ttl = Math.max(1, Math.ceil(((ttlSeconds ? ttlSeconds * 1000 : atMs - Date.now()) / 1000)))
  const key = `${KEY_PREFIX}:proxy_next_retry:${getProxyKey(accountOrProxy)}`
  return await safe((c) => c.set(key, String(Math.floor(atMs)), 'EX', ttl)) !== null
}

const getProxyCooldown = async (accountOrProxy) => {
  const key = `${KEY_PREFIX}:proxy_next_retry:${getProxyKey(accountOrProxy)}`
  const v = await safe((c) => c.get(key))
  return v ? (Number(v) || 0) : 0
}

// ---------------- failures / last_error ----------------

const incrFailures = async (email) => {
  if (!email) return 0
  const key = `${KEY_PREFIX}:failures:${sanitizeEmail(email)}`
  const v = await safe((c) => c.incr(key))
  if (v !== null && v !== undefined) {
    await safe((c) => c.expire(key, SAFETY_TTL_SECONDS))
    return Number(v) || 0
  }
  return 0
}

const resetFailures = async (email) => {
  if (!email) return false
  const key = `${KEY_PREFIX}:failures:${sanitizeEmail(email)}`
  return await safe((c) => c.del(key)) !== null
}

const getFailures = async (email) => {
  if (!email) return 0
  const key = `${KEY_PREFIX}:failures:${sanitizeEmail(email)}`
  const v = await safe((c) => c.get(key))
  return v ? (Number(v) || 0) : 0
}

const setLastError = async (email, errObj) => {
  if (!email) return false
  const key = `${KEY_PREFIX}:last_error:${sanitizeEmail(email)}`
  const payload = JSON.stringify({
    code: errObj && errObj.code ? String(errObj.code) : '',
    message: errObj && errObj.message ? String(errObj.message) : '',
    at: Date.now()
  })
  const ok = await safe((c) => c.set(key, payload, 'EX', SAFETY_TTL_SECONDS)) !== null
  return ok
}

const getLastError = async (email) => {
  if (!email) return null
  const key = `${KEY_PREFIX}:last_error:${sanitizeEmail(email)}`
  const v = await safe((c) => c.get(key))
  if (!v) return null
  try {
    return JSON.parse(v)
  } catch (_) {
    return null
  }
}

// ---------------- last_used_at ----------------

const setLastUsed = async (email) => {
  if (!email) return false
  const key = `${KEY_PREFIX}:last_used:${sanitizeEmail(email)}`
  return await safe((c) => c.set(key, String(Date.now()), 'EX', LAST_USED_TTL_SECONDS)) !== null
}

const getLastUsed = async (email) => {
  if (!email) return 0
  const key = `${KEY_PREFIX}:last_used:${sanitizeEmail(email)}`
  const v = await safe((c) => c.get(key))
  return v ? (Number(v) || 0) : 0
}

// ---------------- daily stats (hincrby 累计) ----------------

/**
 * 累计账号的今日 stats（仅在 chat 后端成功完成时调用）。
 * @param {string} email
 * @param {{ input?: number, output?: number, calls?: number }} delta
 */
const accumulateDaily = async (email, delta) => {
  if (!email) return false
  const d = delta || {}
  const day = todayKey()
  const hashKey = `${KEY_PREFIX}:daily:${day}`
  const field = sanitizeEmail(email)
  const input = Math.max(0, Math.floor(Number(d.input) || 0))
  const output = Math.max(0, Math.floor(Number(d.output) || 0))
  const calls = Math.max(0, Math.floor(Number(d.calls) || 0))
  // 用 pipeline 减少 round-trip
  const ok = await safe(async (c) => {
    const pipeline = c.pipeline()
    if (input) pipeline.hincrby(hashKey, `${field}:input`, input)
    if (output) pipeline.hincrby(hashKey, `${field}:output`, output)
    if (calls) pipeline.hincrby(hashKey, `${field}:calls`, calls)
    // 7 天 retention 即可
    pipeline.expire(hashKey, 7 * 24 * 60 * 60)
    await pipeline.exec()
    return true
  })
  return ok !== null
}

/**
 * 读取指定账号的今日 daily stats（用于 dashboard 兜底）。
 */
const getDailyFor = async (email) => {
  if (!email) return { input: 0, output: 0, calls: 0 }
  const day = todayKey()
  const hashKey = `${KEY_PREFIX}:daily:${day}`
  const field = sanitizeEmail(email)
  const v = await safe(async (c) => {
    const r = await c.hgetall(hashKey)
    if (!r) return null
    return {
      input: Number(r[`${field}:input`]) || 0,
      output: Number(r[`${field}:output`]) || 0,
      calls: Number(r[`${field}:calls`]) || 0
    }
  })
  return v || { input: 0, output: 0, calls: 0 }
}

// ---------------- session stickiness ----------------

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

const getStickySourceBody = (req, body) => {
  // OpenAI middleware rewrites req.body into the internal Qwen payload and adds
  // a fresh session_id/id on every request. Sticky routing must key off the
  // client request, otherwise fallback account selection treats each turn as a
  // new conversation.
  if (req && req.originalBody && typeof req.originalBody === 'object') {
    return req.originalBody
  }
  return body
}

const buildSessionKey = (req, body) => {
  // session sticky 的目标是“同一客户端任务优先命中同一 Qwen 账号”，不是按请求唯一化。
  // 因此不能使用 request id / message id 这类每次都会变的字段；否则长任务多轮会频繁换号，
  // 图片上传、tool retry、Claude Code 连续执行都会更容易丢上下文。
  //
  // 优先级：
  //   1) apiKey + metadata.user_id/session_id（Anthropic messages 常见）
  //   2) apiKey + 常见客户端 session headers
  //   3) apiKey + 最近两条消息内容指纹
  //   4) apiKey + ip + model 兜底弱粘滞
  const apiKey = (req && req.apiKey) || ''
  const safeApi = String(apiKey).slice(-12)  // 不用全 key，缩短
  const safeApiHash = simpleHash(safeApi)

  const sourceBody = getStickySourceBody(req, body)

  if (sourceBody && typeof sourceBody === 'object') {
    const meta = sourceBody.metadata
    if (meta && typeof meta === 'object') {
      const metaKey = [meta.user_id, meta.session_id].filter(Boolean).join('|')
      if (metaKey) return `m:${safeApiHash}:${simpleHash(metaKey)}`
    }
    const headerSession = firstNonEmpty(
      getHeaderValue(req, 'X-Session-ID'),
      getHeaderValue(req, 'Session_id'),
      getHeaderValue(req, 'X-Amp-Thread-Id'),
      getHeaderValue(req, 'X-Codex-Session-Id'),
      sourceBody.sessionId,
      sourceBody.session_id,
      sourceBody.conversation_id
    )
    if (headerSession) return `h:${safeApiHash}:${simpleHash(headerSession)}`
    if (Array.isArray(sourceBody.messages) && sourceBody.messages.length > 0) {
      // 取最近 2 条消息的指纹——避免长原文
      const tail = sourceBody.messages.slice(-2)
      const text = tail
        .map((m) => {
          if (typeof m?.content === 'string') return m.content
          if (Array.isArray(m?.content)) {
            return m.content
              .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
              .map((p) => p.text)
              .join(' ')
          }
          return ''
        })
        .join('|')
        .slice(0, 200)
      if (text.trim()) return `c:${safeApiHash}:${simpleHash(text)}`
    }
    if (sourceBody.model) {
      const ip = (req && (req.ip || (req.connection && req.connection.remoteAddress))) || ''
      return `f:${safeApiHash}:${simpleHash(ip + '|' + sourceBody.model)}`
    }
  }
  return `f:${safeApiHash}:${simpleHash(((req && req.ip) || '') + Date.now())}`
}

// 轻量 hash (FNV-1a 32-bit)，不依赖 crypto，速度快
const simpleHash = (s) => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(36)
}

const buildStickyRedisKey = (sessionKey) => `${KEY_PREFIX}:claude_session:${sessionKey}`

/**
 * 获取粘滞账号的 email（如果存在且未过期）。
 * @param {string} sessionKey
 * @returns {Promise<string|null>}
 */
const getStickyAccount = async (sessionKey) => {
  if (!sessionKey) return null
  return await safe((c) => c.get(buildStickyRedisKey(sessionKey)))
}

/**
 * 设置粘滞账号。TTL = SESSION_STICKY_MS（默认 30 分钟）。
 * @param {string} sessionKey
 * @param {string} email
 */
const setStickyAccount = async (sessionKey, email) => {
  if (!sessionKey || !email) return false
  const ttlSeconds = Math.max(1, Math.ceil((config.sessionStickyMs || 30 * 60 * 1000) / 1000))
  return await safe((c) => c.set(buildStickyRedisKey(sessionKey), email, 'EX', ttlSeconds)) !== null
}

/**
 * 删除粘滞关系（粘滞账号失败/被换号时调用）。
 */
const delStickyAccount = async (sessionKey) => {
  if (!sessionKey) return false
  return await safe((c) => c.del(buildStickyRedisKey(sessionKey))) !== null
}

const clearAccountState = async (email) => {
  if (!email) return false
  const safeEmail = sanitizeEmail(email)
  const keys = [
    `${KEY_PREFIX}:in_flight:${safeEmail}`,
    `${KEY_PREFIX}:next_retry:${safeEmail}`,
    `${KEY_PREFIX}:failures:${safeEmail}`,
    `${KEY_PREFIX}:last_error:${safeEmail}`,
    `${KEY_PREFIX}:last_used:${safeEmail}`
  ]
  return await safe((c) => c.del(...keys)) !== null
}

const clearAllRuntimeState = async () => {
  if (!isRedisUsable()) return true
  try {
    const client = await redisClient.ensureConnection()
    let cursor = '0'
    do {
      const result = await client.scan(cursor, 'MATCH', `${KEY_PREFIX}:*`, 'COUNT', 200)
      cursor = Array.isArray(result) ? result[0] : '0'
      const keys = Array.isArray(result) ? result[1] : []
      if (Array.isArray(keys) && keys.length > 0) {
        await client.del(...keys)
      }
    } while (cursor !== '0')
    return true
  } catch (err) {
    logger.debug(`pool-redis clearAllRuntimeState 失败: ${err.message}`, 'POOL')
    return false
  }
}

// ---------------- failure classification ----------------

/**
 * 失败分类器：决定 cooldown 时长（毫秒）+ 是否触发 next_retry_at 标记。
 * @param {object} err
 * @returns {{ cooldownMs: number, kind: string, longCooldown?: boolean }}
 */
const classifyFailure = (err) => {
  const code = err && err.code !== undefined ? String(err.code) : ''
  const status = err && err.status !== undefined ? Number(err.status) : 0
  const message = err && err.message ? String(err.message) : ''
  if (RE_CAPTCHA.test(message)) {
    return { cooldownMs: 10 * 60 * 1000, kind: 'captcha_or_risk_control', longCooldown: true }
  }

  // 401/403/token invalid：长冷却 5 分钟
  if (status === 401 || status === 403 || RE_AUTH.test(message)) {
    return { cooldownMs: 5 * 60 * 1000, kind: 'auth', longCooldown: true }
  }

  // 429：限流冷却（指数退避基准 30 秒，可被 failures 抬高）
  if (status === 429) {
    return { cooldownMs: 30 * 1000, kind: 'rate_limited' }
  }

  // 5xx：5 秒
  if (status >= 500 && status < 600) {
    return { cooldownMs: 5 * 1000, kind: 'server_5xx' }
  }

  // 408 / timeout / network：5 秒
  if (status === 408 || RE_NETWORK.test(message) ||
      RE_NET_CODE.test(code)) {
    return { cooldownMs: 5 * 1000, kind: 'network' }
  }

  // 400 / 4xx 其它：3 秒
  if (status >= 400 && status < 500) {
    return { cooldownMs: 3 * 1000, kind: 'client_4xx' }
  }

  // 未知失败：保守 5 秒
  return { cooldownMs: 5 * 1000, kind: 'unknown' }
}

// ---------------- batch snapshot (for scorer) ----------------

/**
 * 一次性读取所有候选账号的 Redis 状态（inFlight / failures / nextRetry / lastUsed）。
 * 给 scorer 在一次 MGET / pipeline 内拿到全部信息。
 * @param {string[]} emails
 * @returns {Promise<Record<string, { inFlight: number, failures: number, nextRetry: number, lastUsed: number }>>}
 */
const getStates = async (emails) => {
  const out = {}
  if (!Array.isArray(emails) || emails.length === 0) return out
  if (!isRedisUsable()) {
    for (const e of emails) out[e] = { inFlight: 0, failures: 0, nextRetry: 0, lastUsed: 0 }
    return out
  }

  const safeEmails = emails.map(sanitizeEmail)
  const keys = []
  for (const e of safeEmails) {
    keys.push(`${KEY_PREFIX}:in_flight:${e}`)
    keys.push(`${KEY_PREFIX}:failures:${e}`)
    keys.push(`${KEY_PREFIX}:next_retry:${e}`)
    keys.push(`${KEY_PREFIX}:last_used:${e}`)
  }
  const vals = await safe((c) => c.mget(...keys))
  if (!Array.isArray(vals)) {
    for (const e of emails) out[e] = { inFlight: 0, failures: 0, nextRetry: 0, lastUsed: 0 }
    return out
  }
  for (let i = 0; i < emails.length; i++) {
    const base = i * 4
    out[emails[i]] = {
      inFlight: Number(vals[base + 0]) || 0,
      failures: Number(vals[base + 1]) || 0,
      nextRetry: Number(vals[base + 2]) || 0,
      lastUsed: Number(vals[base + 3]) || 0
    }
  }
  return out
}

const getProxyStates = async (proxyKeys) => {
  const out = {}
  if (!Array.isArray(proxyKeys) || proxyKeys.length === 0) return out
  if (!isRedisUsable()) {
    for (const key of proxyKeys) out[key] = 0
    return out
  }

  const keys = proxyKeys.map((key) => `${KEY_PREFIX}:proxy_next_retry:${key}`)
  const vals = await safe((c) => c.mget(...keys))
  if (!Array.isArray(vals)) {
    for (const key of proxyKeys) out[key] = 0
    return out
  }
  for (let i = 0; i < proxyKeys.length; i++) {
    out[proxyKeys[i]] = Number(vals[i]) || 0
  }
  return out
}

module.exports = {
  // inFlight
  incrInFlight,
  decrInFlight,
  getInFlight,
  mgetInFlight,
  // next_retry / cooldown
  setNextRetry,
  getNextRetry,
  setProxyCooldown,
  getProxyCooldown,
  // failures / last_error
  incrFailures,
  resetFailures,
  clearAccountState,
  clearAllRuntimeState,
  getFailures,
  setLastError,
  getLastError,
  // last_used_at
  setLastUsed,
  getLastUsed,
  // daily stats
  accumulateDaily,
  getDailyFor,
  todayKey,
  // session stickiness
  buildSessionKey,
  getStickyAccount,
  setStickyAccount,
  delStickyAccount,
  // misc
  classifyFailure,
  getStates,
  getProxyStates,
  getProxyKey,
  isRedisUsable,
  // constants
  KEY_PREFIX
}
