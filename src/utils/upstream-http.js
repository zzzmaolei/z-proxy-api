/**
 * upstream-http.js
 *
 * Provider 无关的统一上游 HTTP 客户端（axios + TLS Sidecar）。
 *
 * 设计目标：
 *  - 把"axios 传输 + keepAlive agent + TLS sidecar 转发"下沉为通用能力，
 *    各 provider 只负责自己的 header / 认证 / 业务解析。
 *  - 行为对标原 dpsk-client 的 httpsRequest / httpsStreamRequest：
 *      非流式 → { status, headers, body: string }
 *      流式   → { status, headers, stream: IncomingMessage }
 *  - 不按状态码抛错（validateStatus 恒 true），由调用方判断 status。
 *
 * 与 upstream-client.js 的关系：
 *  upstream-client.js 是 Qwen 专用（buildRequestConfig 内嵌 buildQwenHeaders）。
 *  本模块是 provider 无关的传输层，DeepSeek 等可复用。
 *  Qwen 暂未迁移到此，保持其既有行为不动（一次只改一个链）。
 */

const axios = require('axios')
const http = require('http')
const https = require('https')
const config = require('../config')
const { createTlsSidecarRequest, isTlsSidecarAvailable } = require('./tls-sidecar-client')

// ──────────────── 共享 keepAlive Agent ────────────────

const _httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 64,
  maxFreeSockets: 16,
})
const _httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 64,
  maxFreeSockets: 16,
})

// 流式：长 SSE 默认不复用连接（与 upstream-client 的 getStreamAgent 同理）
const _streamHttpAgent = new http.Agent({ keepAlive: false, maxSockets: 64 })
const _streamHttpsAgent = new https.Agent({ keepAlive: false, maxSockets: 64 })

let _client = null
const getClient = () => {
  if (!_client) {
    _client = axios.create({
      httpAgent: _httpAgent,
      httpsAgent: _httpsAgent,
      proxy: false,
      // 不按状态码抛错
      validateStatus: () => true,
      // 关闭 axios 默认 transform：
      //  - transformResponse 默认会 JSON.parse 字符串，破坏"body 恒为 string"契约
      //  - transformRequest 默认对 object 会序列化，我们只传 string/Buffer，自己控制
      transformRequest: [],
      transformResponse: [],
    })
  }
  return _client
}

/**
 * 判断是否应走 TLS sidecar
 * @param {'qwen'|'dpsk'} mode
 * @returns {boolean}
 */
function shouldUseSidecar(mode) {
  const enabled = config.tlsSidecarEnabled
  if (!enabled) return false
  if (enabled === 'all' || enabled === mode) return isTlsSidecarAvailable()
  return false
}

const toBody = (body) => {
  if (body == null) return null
  if (typeof body === 'string') return body
  if (Buffer.isBuffer(body)) return body
  return JSON.stringify(body)
}

/**
 * 非流式请求：缓冲整段响应
 * @returns {Promise<{status: number, headers: Object, body: string}>}
 */
async function requestJson({ url, method = 'GET', headers = {}, body = null, timeout, sidecarMode = null, proxyAgent = null }) {
  // TLS sidecar 路径
  if (sidecarMode && shouldUseSidecar(sidecarMode) && /^https:\/\//i.test(url)) {
    const res = await createTlsSidecarRequest({
      url,
      method,
      headers,
      body: toBody(body),
      proxyUrl: config.tlsSidecarProxyUrl || null,
      streaming: false,
      timeout: timeout || config.tlsSidecarTimeout,
    })
    return { status: res.status, headers: res.headers, body: res.body }
  }

  // axios 路径
  const cfg = {
    method,
    url,
    headers: { ...headers },
    timeout: timeout || 120000,
    responseType: 'text',
    validateStatus: () => true,
    transformRequest: [],
    transformResponse: [],
  }
  if (proxyAgent) {
    cfg.httpAgent = proxyAgent
    cfg.httpsAgent = proxyAgent
    cfg.proxy = false
  } else {
    cfg.httpAgent = _httpAgent
    cfg.httpsAgent = _httpsAgent
  }

  if (body != null) {
    const bodyData = toBody(body)
    cfg.data = bodyData
    // 显式补 Content-Length（与原 dpsk-client 行为一致，避免依赖 axios 版本差异）
    const len = Buffer.isBuffer(bodyData) ? bodyData.length : Buffer.byteLength(bodyData)
    if (!cfg.headers['Content-Length'] && !cfg.headers['content-length']) {
      cfg.headers['Content-Length'] = String(len)
    }
  }

  const resp = await getClient().request(cfg)
  const data = typeof resp.data === 'string'
    ? resp.data
    : (resp.data == null ? '' : String(resp.data))
  return { status: resp.status, headers: resp.headers, body: data }
}

/**
 * 流式请求：返回原生 stream
 * @returns {Promise<{status: number, headers: Object, stream: import('http').IncomingMessage}>}
 */
async function requestStream({ url, method = 'POST', headers = {}, body = null, timeout, sidecarMode = null, proxyAgent = null, signal = null }) {
  if (sidecarMode && shouldUseSidecar(sidecarMode) && /^https:\/\//i.test(url)) {
    const res = await createTlsSidecarRequest({
      url,
      method,
      headers,
      body: toBody(body),
      proxyUrl: config.tlsSidecarProxyUrl || null,
      streaming: true,
      timeout: timeout || config.dpskStreamTimeoutMs || 600000,
    })
    if (signal) {
      const abort = () => { try { res.stream?.destroy?.() } catch (_) { /* ignore */ } }
      signal.addEventListener('abort', abort, { once: true })
      res.stream?.once?.('close', () => signal.removeEventListener('abort', abort))
      if (signal.aborted) abort()
    }
    return { status: res.status, headers: res.headers, stream: res.stream }
  }

  const cfg = {
    method,
    url,
    headers: { ...headers },
    timeout: timeout || config.dpskStreamTimeoutMs || 600000,
    responseType: 'stream',
    validateStatus: () => true,
    transformRequest: [],
    transformResponse: [],
    signal: signal || undefined,
  }
  if (proxyAgent) {
    cfg.httpAgent = proxyAgent
    cfg.httpsAgent = proxyAgent
    cfg.proxy = false
  } else {
    cfg.httpAgent = _streamHttpAgent
    cfg.httpsAgent = _streamHttpsAgent
  }

  if (body != null) {
    const bodyData = toBody(body)
    cfg.data = bodyData
    const len = Buffer.isBuffer(bodyData) ? bodyData.length : Buffer.byteLength(bodyData)
    if (!cfg.headers['Content-Length'] && !cfg.headers['content-length']) {
      cfg.headers['Content-Length'] = String(len)
    }
  }

  const resp = await getClient().request(cfg)
  return { status: resp.status, headers: resp.headers, stream: resp.data }
}

module.exports = {
  requestJson,
  requestStream,
  shouldUseSidecar,
  getClient,
  _httpAgent,
  _httpsAgent,
  _streamHttpAgent,
  _streamHttpsAgent,
}
