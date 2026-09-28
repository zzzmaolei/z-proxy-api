/**
 * DoH (DNS over HTTPS) 解析器
 *
 * 系统 DNS（内网 resolver）对 chat.qwen.ai 等上游域名的解析间歇性失败，
 * 导致 node dns.lookup 返回 ENOTFOUND。浏览器走 DoH 所以不受影响。
 * 本模块提供不依赖系统 DNS 的 HTTPS 解析，作为 dns.lookup 失败时的兜底。
 *
 * 数据源（RFC 8484 JSON 格式，GET + accept: application/dns-json）：
 *   1. 阿里公共 DNS    https://dns.alidns.com/resolve
 *   2. 腾讯 DNSPod     https://doh.pub/dns-query
 *   3. Cloudflare      https://cloudflare-dns.com/dns-query
 *
 * Node >= 18 有全局 fetch；本项目 Node 22，可直接使用。
 */

const { logger } = require('./logger')

const DOH_SOURCES = [
  'https://dns.alidns.com/resolve',
  'https://doh.pub/dns-query',
  'https://cloudflare-dns.com/dns-query'
]
const TIMEOUT_MS = 3000

/**
 * 解析 hostname 的 A 记录（IPv4 列表）
 * @param {string} hostname
 * @returns {Promise<string[]|null>} 全部源都失败时返回 null
 */
const dohResolve = async (hostname) => {
  for (const base of DOH_SOURCES) {
    try {
      const url = `${base}?name=${encodeURIComponent(hostname)}&type=A`
      const res = await fetch(url, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      if (!res.ok) continue
      const data = await res.json()
      const ips = (Array.isArray(data.Answer) ? data.Answer : [])
        .filter(a => a.type === 1 && typeof a.data === 'string')
        .map(a => a.data)
      if (ips.length > 0) {
        logger.debug(`[DOH] ${base} → ${ips.join(',')}`, 'DNS')
        return ips
      }
    } catch (e) {
      logger.debug(`[DOH] ${base} failed for ${hostname}: ${e.message}`, 'DNS')
    }
  }
  return null
}

module.exports = { dohResolve, DOH_SOURCES }
