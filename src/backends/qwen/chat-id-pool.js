/**
 * chat-id-pool.js
 *
 * One-shot chat_id pre-generation pool:
 *  - 每个 (account.email + model) 维护最多 N 个预生成 chat_id（默认 3，可配 1-5）
 *  - **取出即删除，不复用**——避免上下文污染
 *  - 任何被请求消费过的 chat_id 都**不会再放回池**（包括同步 generateChatID 得到的）
 *  - 池的补齐（refill）由本模块的 _maybeRefill / primeOnStartup 异步负责
 *  - TTL 5-10 分钟（默认 8 分钟），过期自动失效
 *  - 补池策略：singleflight 防惊群（同一 email+model 同时只一个补池），
 *    全局补池并发受 qwenChatIdRefillConcurrency 限制（默认 4）
 *  - 失败/冷却的账号：调用方通过 invalidate(email) 清理
 *  - 预生成失败完全不影响主请求（request.js 始终回退同步 generateChatID）
 *
 * 设计目标：
 *  - 降低首 token 前的网络等待（chat_id 通常 200-500ms）
 *  - 不增加主请求失败风险
 *  - 不污染 Qwen Web 会话上下文（chat_id 一次性使用）
 *  - Redis 模式：池状态在 Redis LIST（PM2 多 worker 共享）；file 模式：进程内
 *  - Redis 不可用时自动降级到进程内
 *
 * 公开 API 契约：
 *  - take(email, model, accountRuntime?)  : 取一个预生成 chat_id；空池返回 null；**取走即消费，不放回**
 *  - put(email, model, cid, accountRuntime?)  : **仅供预生成 / 测试使用**；生产请求路径禁止调用
 *  - invalidate(email, accountRuntime?)   : 清空指定账号的全部预生成（账号失败/冷却时调用）
 *  - primeOnStartup()    : 启动时 best-effort 并行预热
 *
 * accountRuntime 支持（D3+H1）：
 *  - 当传入 accountRuntime 时，使用 accountRuntime.chatIdPool（per-account Map）
 *    作为内存池存储，singleflight key 用 accountId 做隔离
 *  - 未传入时回退到全局 _memoryPool（向后兼容）
 *  - accountRuntime.chatIdPool 与全局 _memoryPool 互不影响，分别存放各自账号的预生成 chat_id
 */

const config = require('../../config/index.js')
const pool = require('../../utils/account-pool-redis')
const { generateChatID } = require('./chat-id')
const { logger } = require('../../utils/logger')
const { getLatestModelsArray } = require('../../models/models-map')

// 进程内 fallback 池：Redis 不可用或 file 模式时用
// _memoryPool[email + model] = [{ chatId, createdAt }]
const _memoryPool = new Map()
// 补池限流：邮箱 → last refill 时间
const _refillThrottle = new Map()
// Singleflight：防止同一 (account, model) 并发补池（惊群效应）
// key: `${accountId}:${model}` or `${email}:${model}`, value: Promise<void>
const _refillPromises = new Map()

/**
 * 解析出当前应使用的内存池 Map。
 *  - accountRuntime 提供时用其 chatIdPool（per-account 隔离）
 *  - 否则回退到全局 _memoryPool（向后兼容）
 */
const _resolveMemPool = (accountRuntime) => {
  if (accountRuntime && accountRuntime.chatIdPool instanceof Map) {
    return accountRuntime.chatIdPool
  }
  return _memoryPool
}

/**
 * 构造 singleflight key。accountRuntime 提供时优先用 accountId（满足
 * "同 accountId + baseModel 只有一个 refill/generate" 的契约）。
 */
const _sfKeyOf = (email, model, accountRuntime) => {
  if (accountRuntime && accountRuntime.accountId) {
    return `${accountRuntime.accountId}:${model}`
  }
  return `${email}:${model}`
}

// 单个 chat_id 寿命：5-10 分钟（默认 8 分钟）
const REPOOL_TTL_MS = 8 * 60 * 1000
// 同一账号补池最小间隔（池非空时生效；池空时无节流，立即补）
const REFILL_THROTTLE_MS = 1 * 1000
// Keep only N unused chat_ids per (account+model).
// 默认 6，可配置 CHAT_ID_POOL_SIZE 调整（1-6）
const POOL_MAX = Math.max(1, parseInt(config.chatIdPoolSize, 10) || 6)

const keyOf = (email, model) => `${email}::${model}`

const _now = () => Date.now()

/**
 * 拉一个可用的 chat_id；空则返回 null，回退到调用方自己 generateChatID
 * One-shot rule: once taken, a chat_id must not appear in the pool again.
 * @param {string} email
 * @param {string} model
 * @param {object} [accountRuntime] - AccountRuntime 实例；提供时使用其 chatIdPool Map
 * @returns {Promise<{ chatId: string, fromPool: boolean }|null>}
 */
const take = async (email, model, accountRuntime) => {
  if (!email || !model) return null
  const useRedis = pool.isRedisUsable()
  const key = keyOf(email, model)
  const memPool = _resolveMemPool(accountRuntime)

  if (useRedis) {
    // Redis：直接 LPOP 一个；过期由 key 自身 TTL 保证
    const redisKey = `qwen2api:pool:chat_id:${key}`
    const chatId = await _redisTake(redisKey)
    if (chatId) {
      // 异步补池（best-effort，失败不影响当前请求）
      _maybeRefill(email, model, useRedis, accountRuntime).catch(() => {})
      return { chatId, fromPool: true }
    }
    // 池空时也触发补池，否则池永远为空
    _maybeRefill(email, model, useRedis, accountRuntime).catch(() => {})
    return null
  }

  // In-memory pool: FIFO take and immediate delete.
  const arr = memPool.get(key) || []
  const fresh = arr.filter(x => (_now() - x.createdAt) < REPOOL_TTL_MS)
  if (fresh.length === 0) {
    memPool.set(key, fresh)
    // 池空时也触发补池，否则池永远为空
    _maybeRefill(email, model, false, accountRuntime).catch(() => {})
    return null
  }
  // shift 后立即写回（不依赖后续 refill），保证一次性使用
  const first = fresh.shift()
  memPool.set(key, fresh)
  // 异步补池（best-effort，失败不影响当前请求）
  _maybeRefill(email, model, false, accountRuntime).catch(() => {})
  return { chatId: first.chatId, fromPool: true }
}

const _redisTake = async (redisKey) => {
  try {
    // Redis LIST：RPOP 原子弹出最右端（最早放入的），FIFO 语义
    const redis = require('../../utils/redis.js')
    const val = await redis.rpop(redisKey)
    return val || null
  } catch (e) {
    logger.debug(`chat-id-pool redis take failed: ${e.message}`, 'POOL')
    return null
  }
}

/**
 * 查找账号对象（用于获取 token）
 * @param {string} email
 * @returns {object|null}
 */
const _getAccount = (email) => {
  const accountManager = require('../../utils/account.js')
  const acc = accountManager.accountTokens && accountManager.accountTokens.find(a => a.email === email)
  return acc || null
}

/**
 * 生成一个 chat_id（不放入池，仅生成）
 * @param {string} email
 * @param {string} model
 * @returns {Promise<string|null>}
 */
const _generateOne = async (email, model) => {
  const acc = _getAccount(email)
  if (!acc || !acc.token) return null
  const chatId = await generateChatID(acc.token, model, acc, { logFailures: false })
  return chatId || null
}

/**
 * 异步后台补池（singleflight 保护）：
 *  - 同一 (account, model) 同时只有一个补池在执行，后续请求复用同一个 Promise
 *  - 全局补池并发数受 qwenChatIdRefillConcurrency 限制（默认 4）
 *  - 池已满：跳过
 * @param {string} email
 * @param {string} model
 * @param {boolean} useRedis
 * @param {object} [accountRuntime] - AccountRuntime 实例（影响 memPool 与 singleflight key）
 */
const _maybeRefill = async (email, model, useRedis, accountRuntime) => {
  if (!config.chatIdPrewarm || config.chatIdPrewarmMode === 'off') return

  const sfKey = _sfKeyOf(email, model, accountRuntime)

  // Singleflight：如果同一 (account, model) 已有补池在进行，复用现有 Promise
  if (_refillPromises.has(sfKey)) {
    return _refillPromises.get(sfKey)
  }

  // 检查当前池大小
  const poolKey = keyOf(email, model)
  const memPool = _resolveMemPool(accountRuntime)
  let currentSize
  if (useRedis) {
    try {
      const redisKey = `qwen2api:pool:chat_id:${poolKey}`
      const redis = require('../../utils/redis.js')
      currentSize = await redis.llen(redisKey)
    } catch (e) {
      currentSize = 0
    }
  } else {
    const arr = memPool.get(poolKey) || []
    const fresh = arr.filter(x => (_now() - x.createdAt) < REPOOL_TTL_MS)
    currentSize = fresh.length
  }

  const needed = POOL_MAX - currentSize
  if (needed <= 0) return

  // 全局补池并发限制
  const maxConcurrency = config.qwenChatIdRefillConcurrency || 4
  if (_refillPromises.size >= maxConcurrency) {
    return
  }

  const refillPromise = _doRefill(email, model, needed, useRedis, accountRuntime)
  _refillPromises.set(sfKey, refillPromise)

  try {
    await refillPromise
  } finally {
    _refillPromises.delete(sfKey)
  }
}

/**
 * 并行补池：一次生成 needed 个 chat_id 并放入池中
 * @param {string} email
 * @param {string} model
 * @param {number} needed - 需要补充的数量
 * @param {boolean} useRedis
 * @param {object} [accountRuntime]
 */
const _doRefill = async (email, model, needed, useRedis, accountRuntime) => {
  const refillCount = Math.min(needed, POOL_MAX)
  const results = await Promise.allSettled(
    Array.from({ length: refillCount }, () => _generateOne(email, model))
  )
  let pushed = 0
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      await put(email, model, result.value, accountRuntime)
      pushed++
    }
  }
  if (pushed > 0) {
    logger.debug(`chat-id-pool refill: ${email} ${model} +${pushed}/${refillCount}`, 'POOL')
  }
}

const _refillOne = async (email, model, useRedis, accountRuntime) => {
  const newChatId = await _generateOne(email, model)
  if (!newChatId) return

  const key = keyOf(email, model)
  if (useRedis) {
    const redisKey = `qwen2api:pool:chat_id:${key}`
    const redis = require('../../utils/redis.js')
    // 检查池是否已满（避免无限增长）
    const currentSize = await redis.llen(redisKey)
    if (currentSize >= POOL_MAX) return
    // LPUSH 放入左侧，配合 RPOP 实现 FIFO
    await redis.lpush(redisKey, newChatId)
    // 刷新 TTL（每次写入都续期，确保活跃池不过期）
    await redis.expire(redisKey, Math.floor(REPOOL_TTL_MS / 1000))
    return
  }

  // 内存池：保留最多 POOL_MAX 个
  const memPool = _resolveMemPool(accountRuntime)
  const arr = memPool.get(key) || []
  // 清理过期
  const fresh = arr.filter(x => (_now() - x.createdAt) < REPOOL_TTL_MS)
  // 幂等保护：chatId 已存在就跳过
  if (fresh.some(x => x.chatId === newChatId)) return
  if (fresh.length < POOL_MAX) {
    fresh.push({ chatId: newChatId, createdAt: _now() })
  }
  memPool.set(key, fresh)
}

/**
 * 投入一个 chat_id 到池中（仅供预生成 / 测试使用）
 *
 * One-shot usage rule:
 *   - 生产请求路径（即 sendChatRequest 消费过的 chat_id）**禁止调用 put**
 *   - 该函数主要用于：
 *     1) _doRefill / _refillOne 后台补池
 *     2) 测试用例直接构造池数据
 *   - 函数内部做了幂等保护：同一 (email, model) 下重复 put 同一个 chatId 不会增加
 *     池容量；不同 (email, model) 的池互不影响
 *
 * @param {string} email
 * @param {string} model
 * @param {string} chatId
 * @param {object} [accountRuntime] - AccountRuntime 实例；提供时使用其 chatIdPool Map
 */
const put = async (email, model, chatId, accountRuntime) => {
  if (!email || !model || !chatId) return
  const useRedis = pool.isRedisUsable()
  const key = keyOf(email, model)
  if (useRedis) {
    const redisKey = `qwen2api:pool:chat_id:${key}`
    const redis = require('../../utils/redis.js')
    const currentSize = await redis.llen(redisKey)
    if (currentSize >= POOL_MAX) return
    await redis.lpush(redisKey, chatId)
    await redis.expire(redisKey, Math.floor(REPOOL_TTL_MS / 1000))
    return
  }
  // 内存池：先按 chatId 幂等去重
  const memPool = _resolveMemPool(accountRuntime)
  const arr = memPool.get(key) || []
  const fresh = arr.filter(x => (_now() - x.createdAt) < REPOOL_TTL_MS)
  if (fresh.some(x => x.chatId === chatId)) {
    // 已存在（重复 put），保持原 createdAt 不变
    memPool.set(key, fresh)
    return
  }
  if (fresh.length < POOL_MAX) {
    fresh.push({ chatId, createdAt: _now() })
    memPool.set(key, fresh)
  } else {
    // 已满：FIFO 淘汰最早的一个（保留最新的）
    fresh.shift()
    fresh.push({ chatId, createdAt: _now() })
    memPool.set(key, fresh)
  }
}

/**
 * 清理指定账号的所有预生成 chat_id（账号失败/冷却时调用）
 * Clear both memory and Redis pools when an account fails or cools down.
 *
 * accountRuntime 提供时也清理其 chatIdPool；为兼容混合调用场景，
 * 同时清理全局 _memoryPool 中该 email 的条目。
 *
 * @param {string} email
 * @param {object} [accountRuntime] - AccountRuntime 实例
 */
const invalidate = async (email, accountRuntime) => {
  if (!email) return
  _refillThrottle.delete(email)
  // 清理 singleflight 的进行中 Promise（避免后续请求复用失效账号的补池结果）
  // accountRuntime 提供时用 accountId 作为前缀，否则用 email
  const sfPrefix = (accountRuntime && accountRuntime.accountId)
    ? `${accountRuntime.accountId}:`
    : `${email}:`
  for (const k of Array.from(_refillPromises.keys())) {
    if (k.startsWith(sfPrefix)) _refillPromises.delete(k)
  }
  // 内存池：删该 email 的所有 key
  const prefix = `${email}::`
  // 优先清理 accountRuntime.chatIdPool（per-account）
  if (accountRuntime && accountRuntime.chatIdPool instanceof Map) {
    for (const k of Array.from(accountRuntime.chatIdPool.keys())) {
      if (k.startsWith(prefix)) accountRuntime.chatIdPool.delete(k)
    }
  }
  // 同时清理全局 _memoryPool（其他调用方可能仍使用全局池）
  for (const k of Array.from(_memoryPool.keys())) {
    if (k.startsWith(prefix)) _memoryPool.delete(k)
  }
  // Redis：如果启用，扫描删除（避免失败账号的预生成 chat_id 被新请求命中）
  if (pool.isRedisUsable()) {
    try {
      const redis = require('../../utils/redis.js')
      // 所有 model 共用一个前缀，SCAN 匹配所有 LIST key
      const pattern = `qwen2api:pool:chat_id:${email}::*`
      // 使用 SCAN 迭代代替 KEYS，避免阻塞 Redis（生产环境 KEYS 会阻塞）
      let keys = []
      let cursor = '0'
      do {
        const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
        cursor = nextCursor
        keys = keys.concat(batch)
      } while (cursor !== '0')
      // 一次性删除所有匹配的 key
      if (keys.length > 0) {
        await redis.del(...keys).catch(() => {})
      }
    } catch (e) {
      logger.debug(`chat-id-pool invalidate redis failed: ${e.message}`, 'POOL')
    }
  }
}

const prewarmOneBestEffort = (email, model, accountRuntime) => {
  if (!email || !model) return false
  if (!config.chatIdPrewarm || config.chatIdPrewarmMode === 'off') return false
  _maybeRefill(email, model, pool.isRedisUsable(), accountRuntime).catch(() => {})
  return true
}

/**
 * 启动时尝试为所有账号预生成 chat_id（best-effort，不阻塞启动）
 * 并行预热前 PREWARM_MODEL_COUNT 个模型，并发限制 3，避免高并发请求冷启动时同步生成 chat_id 的延迟
 *
 * 跳过条件（任务 D3+H1 契约）：
 *  - chatIdPrewarmMode === 'off'           ：完全关闭 prewarm
 *  - chatIdPrewarmMode === 'on_demand'     ：不全量预热（仅按请求触发的 on-demand refill）
 *  - qwenChatIdStartupBudget === 0         ：启动预算为 0，跳过启动预热
 */
const primeOnStartup = async (accountManager) => {
  if (!config.chatIdPrewarm || config.chatIdPrewarmMode === 'off') return
  // on_demand 模式：跳过启动时全量预热（仅按请求触发的 on-demand refill）
  if (config.chatIdPrewarmMode === 'on_demand') return
  // 启动预算为 0：跳过启动预热
  if (config.qwenChatIdStartupBudget === 0) return
  if (!accountManager || !Array.isArray(accountManager.accountTokens)) return
  const accounts = accountManager.accountTokens
  const models = await getLatestModelsArray()
  if (!models || models.length === 0) {
    logger.warn('chat-id-pool primeOnStartup 跳过：未能获取可用模型列表', 'POOL')
    return
  }
  // 动态选择预热目标：从实时模型列表中选第一个 t2t 模型（上游推荐位，当前为 qwen3.8-max 正式版）。
  // 不硬编码模型名 —— 列表由上游 /api/models 实时返回，选择规则与 getDefaultT2tModel 保持一致。
  const targetModel = models.find(m =>
    Array.isArray(m?.info?.meta?.chat_type) && m.info.meta.chat_type.includes('t2t')
  )
  if (!targetModel) {
    logger.warn('chat-id-pool primeOnStartup 跳过：实时模型列表中无 t2t 模型', 'POOL')
    return
  }
  const targetModels = [targetModel]
  const modelIds = targetModels.map(m => m.id || m.name)

  // 构建所有 (account, model) 任务
  const tasks = []
  for (const a of accounts) {
    if (!a || !a.email || !a.token) continue
    for (const m of targetModels) {
      const modelId = m.id || m.name
      if (!modelId) continue
      tasks.push({ email: a.email, model: modelId })
    }
  }

  logger.info(`chat-id-pool 启动预热: ${accounts.length} 个账号 × ${modelIds.length} 个模型 (${modelIds.join(', ')}) = ${tasks.length} 个任务 (并发 3)`, 'POOL')

  const useRedis = pool.isRedisUsable()
  const CONCURRENCY = 3
  let completed = 0
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const batch = tasks.slice(i, i + CONCURRENCY)
    const results = await Promise.allSettled(batch.map(t =>
      _refillOne(t.email, t.model, useRedis).catch(() => {})
    ))
    completed += results.filter(r => r.status === 'fulfilled').length
  }
  logger.info(`chat-id-pool 启动预热完成: ${completed}/${tasks.length} 个任务成功`, 'POOL')
}

module.exports = {
  take,
  invalidate,
  prewarmOneBestEffort,
  primeOnStartup,
}
