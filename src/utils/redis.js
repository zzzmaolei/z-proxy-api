const Redis = require('ioredis')
const config = require('../config/index.js')
const { logger } = require('./logger')

/**
 * Redis 连接管理器
 * 实现按需连接机制，仅在读写操作时建立连接
 */

// 连接配置
const REDIS_CONFIG = {
  maxRetries: 3,
  connectTimeout: 10000,
  commandTimeout: 15000,
  retryDelayOnFailover: 200,
  maxRetriesPerRequest: 3,
  enableOfflineQueue: false,
  enableReadyCheck: false,
  lazyConnect: true,
  keepAlive: 30000,
  connectionName: 'qwen2api_on_demand'
}

// 连接状态
let redis = null
let isConnecting = false
let connectionPromise = null
let lastActivity = 0
let idleTimer = null

// 进程退出时清理空闲定时器（避免 node 进程被句柄挂住）
const IDLE_TIMEOUT = 5 * 60 * 1000
// 空闲后命令通道 PING 校验次数
const REDIS_VERIFY_RETRIES = 2
const REDIS_VERIFY_RETRY_DELAY = 300

// Redis 连接策略：不再在短时间空闲后主动断开并重连。
// 原因：主动断连会在 chat_id pool / account pool / settings cache
//   等被高频复用）会反复触发 disconnect/reconnect 循环，导致请求中出现
//   "Connection is closed" 错误。
// 新策略：
//   - Redis 连接建立后尽量复用，不要主动断开
//   - 长时间空闲（>5 分钟）时清理空闲定时器句柄，但不断连
//   - 健康检查：每次取连接时如果客户端已 ended / closed / 状态非 ready，
//     才会触发重建。重建前会做 PING 校验，避免误判
//   - 不在正常请求过程中主动 close Redis

/**
 * 判断是否需要TLS
 */
const isTLS = config.redisURL && (config.redisURL.startsWith('rediss://') || config.redisURL.includes('--tls'))

/**
 * 创建Redis连接配置
 */
const createRedisConfig = () => ({
  ...REDIS_CONFIG,
  // TLS配置
  ...(isTLS ? {
    tls: {
      rejectUnauthorized: true
    }
  } : {}),

  // 重试策略
  retryStrategy(times) {
    if (times > REDIS_CONFIG.maxRetries) {
      logger.error(`Redis连接重试次数超限: ${times}`, 'REDIS')
      return null
    }

    const delay = Math.min(100 * Math.pow(2, times), 3000)
    logger.info(`Redis重试连接: ${times}, 延迟: ${delay}ms`, 'REDIS', '🔄')
    return delay
  },

  // 错误重连策略
  reconnectOnError(err) {
    const targetErrors = ['READONLY', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE']
    return targetErrors.some(e => err.message.includes(e))
  }
})

/**
 * 验证 Redis 命令通道是否可用
 * @param {object} client - Redis 客户端实例
 * @returns {Promise<void>} 验证结果
 */
const verifyRedisCommandChannel = async (client) => {
  let lastError = null

  for (let attempt = 1; attempt <= REDIS_VERIFY_RETRIES; attempt++) {
    try {
      const pong = await client.ping()
      if (pong !== 'PONG') {
        throw new Error(`PING 返回异常: ${pong}`)
      }

      if (attempt > 1) {
        logger.info(`Redis命令通道在第 ${attempt} 次校验时恢复正常`, 'REDIS', '✅')
      }

      return
    } catch (error) {
      lastError = error

      if (attempt >= REDIS_VERIFY_RETRIES) {
        break
      }

      logger.warn(`Redis命令通道校验失败，第 ${attempt} 次后准备重试: ${error.message}`, 'REDIS')
      await new Promise(resolve => setTimeout(resolve, REDIS_VERIFY_RETRY_DELAY))
    }
  }

  throw new Error(`Redis命令通道不可用: ${lastError ? lastError.message : '未知错误'}`)
}

/**
 * 清理空闲定时器
 */
const clearIdleTimer = () => {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
}

/**
 * 等待现有 Redis 客户端恢复为可用状态
 * @param {object} client - Redis 客户端实例
 * @returns {Promise<object>} 可用的 Redis 客户端
 */
const waitForRedisReady = (client) => new Promise((resolve, reject) => {
  if (!client) {
    reject(new Error('Redis客户端不存在'))
    return
  }

  if (client.status === 'ready') {
    resolve(client)
    return
  }

  const timeout = setTimeout(() => {
    cleanup()
    reject(new Error('等待Redis连接恢复超时'))
  }, REDIS_CONFIG.connectTimeout + REDIS_CONFIG.commandTimeout)

  const cleanup = () => {
    clearTimeout(timeout)
    client.off('ready', handleReady)
    client.off('close', handleClose)
    client.off('end', handleEnd)
  }

  const handleReady = () => {
    cleanup()
    resolve(client)
  }

  const handleClose = () => {
    cleanup()
    reject(new Error('Redis连接已关闭'))
  }

  const handleEnd = () => {
    cleanup()
    reject(new Error('Redis连接已结束'))
  }

  client.once('ready', handleReady)
  client.once('close', handleClose)
  client.once('end', handleEnd)
})

/**
 * 更新活动时间并重置空闲定时器
 *
 * 空闲超时只清理本地定时器，不主动 disconnect Redis。
 * 主动断开会在 chat_id pool / account pool / settings cache 等高频路径上
 * 触发 reconnect 循环，导致 "Connection is closed"。现在：
 *   - 不再因为空闲定时器触发而 disconnect
 *   - 长时间空闲时只清理定时器句柄（避免进程退出被挂住）
 *   - 重连判断完全交给 ensureConnection() 的 PING 健康检查
 */
const updateActivity = () => {
  lastActivity = Date.now()

  clearIdleTimer()

  // 空闲定时器只清理句柄，不主动 disconnect。
  // 这样正常请求路径上不会因为短时间空闲就触发重连
  idleTimer = setTimeout(() => {
    // 仅清掉定时器本身，避免进程被 setTimeout 句柄挂住
    idleTimer = null
  }, IDLE_TIMEOUT)
  idleTimer.unref()
}

/**
 * 绑定 Redis 事件
 * @param {object} client - Redis 客户端实例
 */
const bindRedisEvents = (client) => {
  client.on('connect', () => {
    logger.success('Redis连接建立', 'REDIS')
  })

  client.on('ready', () => {
    logger.success('Redis准备就绪', 'REDIS')
    if (redis === client) {
      updateActivity()
    }
  })

  client.on('error', (err) => {
    logger.error('Redis连接错误', 'REDIS', '', err)
  })

  client.on('close', () => {
    logger.info('Redis连接关闭', 'REDIS', '🔌')
    if (redis === client) {
      redis = null
      clearIdleTimer()
    }
  })

  client.on('end', () => {
    logger.info('Redis连接结束', 'REDIS', '🔌')
    if (redis === client) {
      redis = null
      clearIdleTimer()
    }
  })

  client.on('reconnecting', (delay) => {
    logger.info(`Redis重新连接中...延迟: ${delay}ms`, 'REDIS', '🔄')
  })
}

/**
 * 建立Redis连接
 */
const connectRedis = async () => {
  if (redis && redis.status === 'ready') {
    updateActivity()
    return redis
  }

  if (redis && ['connect', 'connecting', 'reconnecting'].includes(redis.status)) {
    if (!connectionPromise) {
      isConnecting = true
      connectionPromise = waitForRedisReady(redis)
        .then(client => {
          updateActivity()
          return client
        })
        .finally(() => {
          isConnecting = false
          connectionPromise = null
        })
    }

    return connectionPromise
  }

  if (connectionPromise) {
    return connectionPromise
  }

  isConnecting = true
  connectionPromise = (async () => {
    let newRedis = null

    try {
      logger.info('建立Redis连接...', 'REDIS', '🔌')

      newRedis = new Redis(config.redisURL, createRedisConfig())
      redis = newRedis
      bindRedisEvents(newRedis)

      await newRedis.connect()
      await verifyRedisCommandChannel(newRedis)
      updateActivity()
      return newRedis
    } catch (error) {
      if (redis === newRedis) {
        redis = null
      }

      if (newRedis) {
        try {
          newRedis.disconnect()
        } catch (disconnectError) {
        }
      }

      logger.error('Redis连接失败', 'REDIS', '', error)
      throw error
    } finally {
      isConnecting = false
      connectionPromise = null
    }
  })()

  return connectionPromise
}

/**
 * 断开Redis连接
 */
const disconnectRedis = async () => {
  clearIdleTimer()

  if (redis) {
    const currentRedis = redis

    try {
      currentRedis.disconnect()
      logger.info('Redis连接已断开', 'REDIS', '🔌')
    } catch (error) {
      logger.error('断开Redis连接时出错', 'REDIS', '', error)
    } finally {
      if (redis === currentRedis) {
        redis = null
      }

      isConnecting = false
      connectionPromise = null
    }
  }
}

/**
 * 确保Redis连接可用
 *
 * 短时间空闲后继续复用 ready 连接，不主动重连。
 *  - 短时间空闲时直接复用，不触发 disconnect/reconnect
 *  - 只有当客户端已进入 ended / closed 状态时才需要重建连接
 *  - 重建前会做 PING 健康检查，避免误判一个正常 ready 连接为"已死"
 */
const ensureConnection = async () => {
  if (config.dataSaveMode !== 'redis') {
    logger.error('当前数据保存模式不是Redis', 'REDIS')
    throw new Error('当前数据保存模式不是Redis')
  }

  if (!redis || redis.status !== 'ready') {
    return await connectRedis()
  }

  // 当前连接处于 ready 状态时直接复用。
  updateActivity()
  return redis
}

/**
 * 获取所有账户
 * @returns {Promise<Array>} 所有账户信息数组
 */
const getAllAccounts = async () => {
  try {
    const client = await ensureConnection()

    // 使用SCAN命令替代KEYS命令，避免阻塞Redis服务器
    const keys = []
    let cursor = '0'

    do {
      const result = await client.scan(cursor, 'MATCH', 'user:*', 'COUNT', 100)
      cursor = result[0]
      keys.push(...result[1])
    } while (cursor !== '0')

    if (!keys.length) {
      logger.info('没有找到任何账户', 'REDIS', '✅')
      return []
    }

    // 使用pipeline一次性获取所有账户数据
    const pipeline = client.pipeline()
    keys.forEach(key => {
      pipeline.hgetall(key)
    })

    const results = await pipeline.exec()
    if (!results) {
      logger.error('获取账户数据失败', 'REDIS')
      return []
    }

    const accounts = results.map((result, index) => {
      // result格式为[err, value]
      const [err, accountData] = result
      if (err) {
        logger.error(`获取账户 ${keys[index]} 数据失败`, 'REDIS', '', err)
        return null
      }
      if (!accountData || Object.keys(accountData).length === 0) {
        logger.error(`账户 ${keys[index]} 数据为空`, 'REDIS')
        return null
      }
      // stats 以 JSON 字符串存储于 HSET——malformed/missing 返回 undefined，由上层 ensureStats 补默认
      let stats
      if (accountData.stats) {
        try {
          stats = JSON.parse(accountData.stats)
        } catch (parseError) {
          logger.warn(`账户 ${keys[index]} stats JSON 解析失败，使用默认值: ${parseError.message}`, 'REDIS')
          stats = undefined
        }
      }
      // statsHistory is stored as a JSON string in HSET; malformed/missing → undefined, ensureStats fills {} upstream
      let statsHistory
      if (accountData.statsHistory) {
        try {
          statsHistory = JSON.parse(accountData.statsHistory)
        } catch (parseError) {
          logger.warn(`账户 ${keys[index]} statsHistory JSON 解析失败，使用默认值: ${parseError.message}`, 'REDIS')
          statsHistory = undefined
        }
      }
      return {
        email: keys[index].replace('user:', ''),
        password: accountData.password || '',
        token: accountData.token || '',
        expires: accountData.expires || '',
        proxy: accountData.proxy || null,
        stats,
        statsHistory
      }
    }).filter(Boolean) // 过滤掉null值

    logger.success(`获取所有账户成功，共 ${accounts.length} 个账户`, 'REDIS')
    return accounts
  } catch (err) {
    logger.error('获取账户时出错', 'REDIS', '', err)
    throw err
  }
}

/**
 * 设置账户
 * @param {string} key - 键名（邮箱）
 * @param {Object} value - 账户信息
 * @returns {Promise<boolean>} 设置是否成功
 */
const setAccount = async (key, value) => {
  try {
    const client = await ensureConnection()

    const { password, token, expires, proxy, stats, statsHistory } = value

    // 仅写入显式传入的字段——HSET 不影响其他字段，保留 MERGE 语义
    // 这样 partial save（token refresh / proxy update）不会清零 daily stats
    const payload = {}
    if (password !== undefined) payload.password = password || ''
    if (token !== undefined) payload.token = token || ''
    if (expires !== undefined) payload.expires = expires || ''
    if (proxy !== undefined) payload.proxy = proxy || ''
    if (stats !== undefined) payload.stats = JSON.stringify(stats)
    if (statsHistory !== undefined) payload.statsHistory = JSON.stringify(statsHistory)

    if (Object.keys(payload).length === 0) {
      logger.warn(`账户 ${key} setAccount 收到空 payload，跳过写入`, 'REDIS')
      return true
    }

    await client.hset(`user:${key}`, payload)

    logger.success(`账户 ${key} 设置成功`, 'REDIS')
    return true
  } catch (err) {
    logger.error(`设置账户 ${key} 失败`, 'REDIS', '', err)
    return false
  }
}

/**
 * 删除账户
 * @param {string} key - 键名（邮箱）
 * @returns {Promise<boolean>} 删除是否成功
 */
const deleteAccount = async (key) => {
  try {
    const client = await ensureConnection()

    const result = await client.del(`user:${key}`)
    if (result > 0) {
      logger.success(`账户 ${key} 删除成功`, 'REDIS')
      return true
    } else {
      logger.warn(`账户 ${key} 不存在`, 'REDIS')
      return false
    }
  } catch (err) {
    logger.error(`删除账户 ${key} 失败`, 'REDIS', '', err)
    return false
  }
}

const SETTINGS_KEY = 'qwen2api:settings'

/**
 * 判断一个值是否“坏值”——非合法 JSON / 字符串 "undefined" / undefined / null
 * 命中则视为 Redis 中存了脏数据，调用方应清掉并视为空设置
 */
const _isBadSettingsRaw = (raw) => {
  if (raw === undefined || raw === null) return true
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed === 'undefined' || trimmed === 'null') return true
  }
  return false
}

/**
 * 安全解析 Redis settings 字符串
 * @param {string} raw - hgetall 返回的 json 字段值
 * @returns {Object|null} 解析结果；坏值返回 null
 */
const _safeParseSettings = (raw) => {
  if (_isBadSettingsRaw(raw)) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed
    }
    return null
  } catch (_) {
    return null
  }
}

/**
 * 获取运行时设置
 *
 * 健壮性：
 *   - settings key 不存在 / hgetall 为空 → 返回 {}
 *   - json 字段是 "undefined" / undefined / null / "" → 返回 {} 并清掉坏值
 *   - JSON.parse 失败 → warn + 返回 {} 并清掉坏值
 *   - 解析后非对象（数组等）→ 返回 {} 并清掉坏值
 *
 * @returns {Promise<Object>} 设置对象 (空对象表示尚未存储任何值)
 */
const getSettings = async () => {
  try {
    const client = await ensureConnection()
    const data = await client.hgetall(SETTINGS_KEY)
    // data 为空对象（key 不存在）
    if (!data || Object.keys(data).length === 0) {
      return {}
    }
    // data 不为空但没有 json 字段——空设置
    if (!('json' in data)) {
      return {}
    }
    const raw = data.json
    if (raw === undefined) {
      return {}
    }
    const parsed = _safeParseSettings(raw)
    if (parsed === null) {
      // 坏值：清掉避免下次再踩坑
      logger.warn(`Redis settings 字段为坏值(${typeof raw === 'string' ? raw.slice(0, 32) : typeof raw})，已清理并返回 {}`, 'REDIS')
      try {
        await client.hdel(SETTINGS_KEY, 'json')
      } catch (_) { /* ignore cleanup error */ }
      return {}
    }
    return parsed
  } catch (err) {
    logger.error('获取运行时设置失败', 'REDIS', '', err)
    return {}
  }
}

/**
 * 保存运行时设置（与现有 settings 合并）
 *
 * 修复：原实现每次 hset 一个新的 partial，会把旧字段丢掉。
 * 新实现先 hgetall 取出已有 → 合并 → JSON.stringify → hset 'json' field。
 *
 * 健壮性：
 *   - partial 不是对象 / 是 undefined → 拒绝写入
 *   - 合并后 JSON.stringify 必须是合法 JSON（不会写 undefined）
 *   - 解析失败不写脏数据
 *
 * @param {Object} partial - 要写入的字段
 * @returns {Promise<boolean>} 设置是否成功
 */
const setSettings = async (partial) => {
  try {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
      logger.warn(`setSettings 拒绝非法 partial: ${typeof partial}`, 'REDIS')
      return false
    }
    const client = await ensureConnection()
    // 读出现有 settings 并合并——保证“部分保存”不会把旧字段清零
    const existingData = await client.hgetall(SETTINGS_KEY)
    const existing = _safeParseSettings(existingData && existingData.json) || {}
    const merged = { ...existing, ...partial }
    // 兜底：确保 merged 仍是合法可序列化对象
    let serialized
    try {
      serialized = JSON.stringify(merged)
      // sanity check：能反序列化回来且类型一致
      const roundtrip = JSON.parse(serialized)
      if (!roundtrip || typeof roundtrip !== 'object' || Array.isArray(roundtrip)) {
        throw new Error('序列化结果非对象')
      }
    } catch (serErr) {
      logger.error('setSettings 合并后 JSON 序列化失败，拒绝写入', 'REDIS', '', serErr)
      return false
    }
    await client.hset(SETTINGS_KEY, { json: serialized })
    return true
  } catch (err) {
    logger.error('保存运行时设置失败', 'REDIS', '', err)
    return false
  }
}

/**
 * 检查键是否存在
 * @param {string} key - 键名
 * @returns {Promise<boolean>} 键是否存在
 */
const checkKeyExists = async (key = 'headers') => {
  try {
    const client = await ensureConnection()

    const exists = await client.exists(key)
    const result = exists === 1

    logger.info(`键 "${key}" ${result ? '存在' : '不存在'}`, 'REDIS', result ? '✅' : '❌')
    return result
  } catch (err) {
    logger.error(`检查键 "${key}" 时出错`, 'REDIS', '', err)
    return false
  }
}

/**
 * 获取连接状态
 * @returns {Object} 连接状态信息
 */
const getConnectionStatus = () => {
  return {
    connected: redis && redis.status === 'ready',
    status: redis ? redis.status : 'disconnected',
    lastActivity: lastActivity,
    idleTimeout: IDLE_TIMEOUT,
    config: REDIS_CONFIG
  }
}

/**
 * 手动断开连接（用于应用关闭时清理）
 */
const cleanup = async () => {
  logger.info('清理Redis连接...', 'REDIS', '🧹')
  await disconnectRedis()
}

// 创建兼容的Redis客户端对象
const redisClient = {
  getAllAccounts,
  setAccount,
  deleteAccount,
  checkKeyExists,
  getSettings,
  setSettings,
  getConnectionStatus,
  cleanup,

  // 直接Redis命令的代理方法（按需连接）
  async hset(key, ...args) {
    const client = await ensureConnection()
    return client.hset(key, ...args)
  },

  async hget(key, field) {
    const client = await ensureConnection()
    return client.hget(key, field)
  },

  async hgetall(key) {
    const client = await ensureConnection()
    return client.hgetall(key)
  },

  async exists(key) {
    const client = await ensureConnection()
    return client.exists(key)
  },

  async keys(pattern) {
    const client = await ensureConnection()
    // 使用SCAN命令替代KEYS命令，避免阻塞Redis服务器
    const keys = []
    let cursor = '0'

    do {
      const result = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100)
      cursor = result[0]
      keys.push(...result[1])
    } while (cursor !== '0')

    return keys
  },

  /**
   * 原子 SET key value NX PX ttlMs
   * @param {string} key
   * @param {string} value
   * @param {number} ttlMs
   * @returns {Promise<boolean>} 是否成功获取
   */
  async setNxPx(key, value, ttlMs) {
    const client = await ensureConnection()
    const result = await client.set(key, value, 'PX', ttlMs, 'NX')
    return result === 'OK'
  },

  async get(key) {
    const client = await ensureConnection()
    return client.get(key)
  },

  async set(key, value, ...args) {
    const client = await ensureConnection()
    // ioredis set signature: set(key, value, ...flags)
    // 支持 ['EX', seconds] / ['PX', ms] / ['NX' | 'XX'] 等
    return client.set(key, value, ...args)
  },

  async setex(key, ttlSeconds, value) {
    const client = await ensureConnection()
    return client.setex(key, ttlSeconds, value)
  },

  async psetex(key, ttlMs, value) {
    const client = await ensureConnection()
    return client.psetex(key, ttlMs, value)
  },

  async del(key) {
    const client = await ensureConnection()
    return client.del(key)
  },

  async incr(key) {
    const client = await ensureConnection()
    return client.incr(key)
  },

  async incrby(key, increment) {
    const client = await ensureConnection()
    return client.incrby(key, increment)
  },

  async decr(key) {
    const client = await ensureConnection()
    return client.decr(key)
  },

  async decrby(key, decrement) {
    const client = await ensureConnection()
    return client.decrby(key, decrement)
  },

  async expire(key, ttlSeconds) {
    const client = await ensureConnection()
    return client.expire(key, ttlSeconds)
  },

  async pexpire(key, ttlMs) {
    const client = await ensureConnection()
    return client.pexpire(key, ttlMs)
  },

  async pttl(key) {
    const client = await ensureConnection()
    return client.pttl(key)
  },

  async ttl(key) {
    const client = await ensureConnection()
    return client.ttl(key)
  },

  async hincrby(key, field, increment) {
    const client = await ensureConnection()
    return client.hincrby(key, field, increment)
  },

  async hdel(key, ...fields) {
    const client = await ensureConnection()
    return client.hdel(key, ...fields)
  },

  async mget(...keys) {
    const client = await ensureConnection()
    return client.mget(...keys)
  },

  async eval(script, numKeys, ...args) {
    const client = await ensureConnection()
    return client.eval(script, numKeys, ...args)
  }
}

// 进程退出时清理连接
process.on('exit', cleanup)
process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)

// 根据配置决定是否导出Redis客户端
module.exports = config.dataSaveMode === 'redis' ? redisClient : null
