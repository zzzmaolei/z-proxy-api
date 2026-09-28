/**
 * DNS 缓存模块
 *
 * 对 chat.qwen.ai 等上游域名的 DNS 解析结果进行缓存，
 * 避免因间歇性 DNS 解析失败导致 ENOTFOUND 错误。
 *
 * 缓存策略：
 *  - 成功解析缓存 5 分钟（TTL），缓存全部 A 记录（多 IP），命中时轮换返回
 *  - 系统 DNS 失败时，用 DoH（DNS over HTTPS）兜底解析，不依赖内网 resolver
 *  - 失败不计入缓存（避免缓存 NXDOMAIN）
 *  - 缓存 key 为 hostname（不含端口）
 *  - 线程安全：单进程内 Map 操作
 */

const dns = require('dns')
const { logger } = require('./logger')
const { dohResolve } = require('./doh-resolver')

const DNS_CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes
const DNS_CACHE_MAX_ENTRIES = 100

const cache = new Map()

/**
 * 清理过期缓存条目
 */
const purgeExpired = () => {
  const now = Date.now()
  for (const [key, entry] of cache) {
    if (now - entry.ts > DNS_CACHE_TTL_MS) {
      cache.delete(key)
    }
  }
}

/**
 * 定时清理（每 60 秒）
 */
setInterval(purgeExpired, 60 * 1000).unref()

/**
 * 限制缓存大小：超过上限时删最旧条目
 */
const trimCache = () => {
  if (cache.size <= DNS_CACHE_MAX_ENTRIES) return
  const oldest = [...cache.entries()]
    .sort((a, b) => a[1].ts - b[1].ts)[0]
  if (oldest) cache.delete(oldest[0])
}

/**
 * 把 IP 列表写入缓存（内部辅助）
 */
const setCache = (key, ips, family) => {
  cache.set(key, { ips, idx: 0, family, ts: Date.now() })
  trimCache()
}

/**
 * 从缓存取下一个轮换 IP（命中后自增轮换指针）
 */
const nextCachedIp = (entry) => {
  const ip = entry.ips[entry.idx % entry.ips.length]
  entry.idx += 1
  return ip
}

/**
 * 带缓存的 DNS lookup
 * 签名对齐 Node.js net 模块的 lookup 回调：
 *   (err, address, family) => void
 *
 * 解析顺序：缓存命中 → 系统 dns.lookup(all) → DoH 兜底
 *
 * @param {string} hostname
 * @param {Object} [options]
 * @param {Function} callback
 */
const cachedLookup = (hostname, options, callback) => {
  // 兼容 lookup(hostname, callback) 签名
  if (typeof options === 'function') {
    callback = options
    options = {}
  }

  const family = options.family || 0 // 0 = any

  // 清理过期
  if (cache.size > DNS_CACHE_MAX_ENTRIES) {
    purgeExpired()
  }

  const key = `${hostname}:${family}`
  const cached = cache.get(key)
  if (cached && Array.isArray(cached.ips) && cached.ips.length > 0 && Date.now() - cached.ts < DNS_CACHE_TTL_MS) {
    // 缓存命中（ips 必须非空，防止 prewarm 的空条目被误用）
    // Node v20+ autoSelectFamily：options.all=true 时回调数组，否则单地址
    if (options.all) {
      const addrs = cached.ips.map(ip => ({ address: ip, family: cached.family }))
      return process.nextTick(() => callback(null, addrs))
    }
    const ip = nextCachedIp(cached)
    return process.nextTick(() => callback(null, ip, cached.family))
  }

  // 缓存未命中：系统 DNS 解析全部 A 记录（内部总是取全部用于缓存/轮换/DoH）
  const lookupOpts = { ...options, all: true }
  dns.lookup(hostname, lookupOpts, async (err, addresses) => {
    if (!err && Array.isArray(addresses) && addresses.length > 0) {
      const ips = addresses.map(a => a.address)
      const familyOfFirst = addresses[0].family || 4
      setCache(key, ips, familyOfFirst)
      // ⚠️ Node v20+ autoSelectFamily 协议：options.all=true 时 net 期望
      // 回调 (err, addresses[])，否则 (err, address, family)。
      // 格式不匹配会触发 ERR_INVALID_IP_ADDRESS。
      if (options.all) {
        return callback(null, addresses)
      }
      const ip = ips[0]
      return callback(null, ip, familyOfFirst)
    }

    // 系统 DNS 失败 → DoH 兜底（不缓存失败结果，但缓存 DoH 成功结果）
    if (err || Array.isArray(addresses)) {
      const ips = await dohResolve(hostname)
      if (ips && ips.length > 0) {
        setCache(key, ips, 4)
        logger.warn(`[DNS-CACHE] system lookup failed (${err ? (err.code || err.message) : 'empty addresses'}), DoH fallback → ${ips[0]}`, 'DNS')
        if (options.all) {
          const addrs = ips.map(ip => ({ address: ip, family: 4 }))
          return callback(null, addrs)
        }
        return callback(null, ips[0], 4)
      }
    }
    callback(err || new Error(`DNS lookup returned no addresses for ${hostname}`))
  })
}

/**
 * 预热 DNS 缓存
 * 在服务启动时调用，提前解析上游域名；系统 DNS 失败时走 DoH 兜底
 *
 * @param {string} hostname
 * @returns {Promise<void>}
 */
const prewarmDns = async (hostname) => {
  try {
    const addresses = await new Promise((resolve, reject) => {
      dns.lookup(hostname, { all: true }, (err, res) => err ? reject(err) : resolve(res))
    })
    if (Array.isArray(addresses) && addresses.length > 0) {
      const ips = addresses.map(a => a.address)
      const familyOfFirst = addresses[0].family || 4
      setCache(`${hostname}:0`, ips, familyOfFirst)
      setCache(`${hostname}:4`, ips, 4)
      logger.debug(`[DNS-CACHE] prewarmed ${hostname} → ${ips.join(',')} (family=${familyOfFirst})`, 'DNS')
      return
    }
  } catch (err) {
    // 系统 DNS 失败 → DoH 兜底
    const ips = await dohResolve(hostname)
    if (ips && ips.length > 0) {
      setCache(`${hostname}:0`, ips, 4)
      setCache(`${hostname}:4`, ips, 4)
      logger.warn(`[DNS-CACHE] prewarm system lookup failed (${err.code || err.message}), DoH fallback → ${ips.join(',')}`, 'DNS')
      return
    }
    logger.warn(`[DNS-CACHE] prewarm failed for ${hostname}: ${err.message}`, 'DNS')
  }
}

/**
 * 获取缓存统计
 */
const getStats = () => ({
  size: cache.size,
  maxEntries: DNS_CACHE_MAX_ENTRIES,
  ttlMs: DNS_CACHE_TTL_MS,
  entries: [...cache.entries()].map(([key, entry]) => ({
    key,
    address: Array.isArray(entry.ips) ? entry.ips.join(',') : entry.address,
    family: entry.family,
    ageMs: Date.now() - entry.ts
  }))
})

module.exports = {
  cachedLookup,
  prewarmDns,
  getStats
}
