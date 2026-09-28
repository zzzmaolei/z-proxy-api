/**
 * upstream-client.js
 *
 * 统一的上游 axios 客户端。
 *
 * 设计目标：
 *  - 复用 keepAlive http/https agent：避免每次请求都新建 TCP 连接
 *  - 复用代理 agent：避免每次请求都重新实例化 proxy
 *  - 不会改变现有代理语义（账号级 proxy 优先于全局 PROXY_URL）
 *  - 不会改变现有请求路径：/api/v2/chats/new、/api/v2/chat/completions
 *
 * 使用：
 *  - getUpstreamClient()  → 默认实例（带 keepAlive）
 *  - buildRequestConfig({ token, account, baseUrl, extraHeaders, extraConfig }) → 拼装一个 config
 *  - getProxyAgent(account) 在 proxy-helper 中已有；这里只是复用，不会重新创建
 */

const axios = require('axios')
const http = require('http')
const https = require('https')
const net = require('net')
const { URL } = require('url')
const { getProxyAgent, getChatBaseUrl } = require('../../utils/proxy-helper')
const config = require('../../config/index.js')
const { buildQwenHeaders } = require('../../providers/qwen-web/headers')
const { warmupQwenHomepage, getWarmupCacheState } = require('./qwen-homepage-warmup')
const { isTlsSidecarAvailable, createTlsSidecarRequest } = require('../../utils/tls-sidecar-client')
const { cachedLookup } = require('../../utils/dns-cache')
const { logger: _debugLogger } = require('../../utils/logger')

// ──────────────── TLS Sidecar 集成 ────────────────
// 是否应该走 TLS sidecar 代理 Qwen 的 HTTPS 请求
const shouldUseSidecar = () => {
  const enabled = config.tlsSidecarEnabled
  if (!enabled) return false
  if (enabled === 'all' || enabled === 'qwen') return isTlsSidecarAvailable()
  return false
}

const buildSidecarTargetUrl = (url) => {
  // 确保是 https:// 目标
  if (typeof url !== 'string') return null
  const u = url.startsWith('http') ? url : `https://${url}`
  return u
}

// ---------------- 共享 keepAlive Agent ----------------

// DNS 缓存：所有 agent 共享 cachedLookup，避免间歇性 ENOTFOUND
// 注意：lookup 必须通过构造 options 传入（agent.options.lookup），
// 直接赋值 agent.lookup = fn 对 Node Agent 无效（createSocket 合并的是 this.options）。
const _agentLookup = (hostname, opts, cb) => cachedLookup(hostname, opts, cb)

const _httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 60 * 1000,
  maxSockets: 256,
  maxFreeSockets: 64,
  freeSocketTimeout: 30 * 1000,
  lookup: _agentLookup
})
const _httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 60 * 1000,
  maxSockets: 256,
  maxFreeSockets: 64,
  freeSocketTimeout: 30 * 1000,
  lookup: _agentLookup
})

const _streamHttpAgent = new http.Agent({
  keepAlive: false,
  maxSockets: 256,
  lookup: _agentLookup,
  // TCP keepalive 探测：防止防火墙/中间设备断开空闲长连接导致 ECONNRESET
  // 60 秒空闲后每 15 秒发一次探测
  createConnection: (options, cb) => {
    const socket = net.createConnection(options, cb)
    socket.setKeepAlive(true, 60 * 1000)
    return socket
  }
})
const _streamHttpsAgent = new https.Agent({
  keepAlive: false,
  maxSockets: 256,
  lookup: _agentLookup,
  // TCP keepalive 探测：防止防火墙/中间设备断开空闲长连接导致 ECONNRESET
  // 60 秒空闲后每 15 秒发一次探测
  createConnection: (options, cb) => {
    const socket = net.createConnection(options, cb)
    socket.setKeepAlive(true, 60 * 1000)
    return socket
  }
})

// lookup 已通过构造 options 注入（见上），此处不再需要运行时赋值

const getStreamAgent = () => {
  // 长 SSE 默认不用 keepAlive，并显式 Connection: close。
  // Qwen Web/中间代理偶发会复用一个状态不干净的长连接，表现为长任务中途断流；
  // 需要复用连接时再用 QWEN_STREAM_KEEP_ALIVE=true 显式打开。
  if (config.qwenStreamKeepAlive) {
    return { httpAgent: _httpAgent, httpsAgent: _httpsAgent }
  }
  return { httpAgent: _streamHttpAgent, httpsAgent: _streamHttpsAgent }
}

/**
 * 默认上游 axios client（带 keepAlive）
 * - 请求 chat.qwen.ai 时直接用，不传 httpsAgent；
 * - 账号级代理时调用方再覆盖 httpsAgent（见 buildRequestConfig）
 */
let _defaultClient = null
const getUpstreamClient = () => {
  if (!_defaultClient) {
    _defaultClient = axios.create({
      httpAgent: _httpAgent,
      httpsAgent: _httpsAgent,
      // 不要 axios 默认 proxy：代理由调用方决定
      proxy: false,
      timeout: config.qwenStreamTimeoutMs,
      // 启用 gzip
      decompress: true
    })
  }
  return _defaultClient
}

/**
 * 构造单次请求的 axios config。
 * - 走默认 client 的 keepAlive agent
 * - 账号级代理优先于全局代理
 * - 不会改变现有 header 语义
 *
 * @param {Object} options
 * @param {string} options.token - Bearer token
 * @param {Object} [options.account] - 账号对象（用于代理 / proxy-helper 解析）
 * @param {string} [options.baseUrl] - 覆盖 chatBaseUrl
 * @param {Object} [options.extraHeaders] - 额外 headers（覆盖默认）
 * @param {Object} [options.extraConfig] - 额外 axios config（覆盖默认）
 * @returns {Object} axios request config
 */
const buildRequestConfig = async (options) => {
  const opts = options || {}
  const baseUrl = opts.baseUrl || getChatBaseUrl()
  const token = opts.token
  const streaming = !!opts.streaming
  const proxyAgent = getProxyAgent(opts.account)
  const streamAgents = streaming ? getStreamAgent() : null

  // Qwen 首页 warmup：缓存命中直接用，过期后台异步刷新，首次启动同步等待
  // buildQwenHeaders 会通过 buildWarmupCookieHeader 自动拼接缓存中的 warmup cookies
  const warmupState = getWarmupCacheState(opts.account)
  if (warmupState === 'empty') {
    // 首次启动：同步等待一次 warmup，保证首个请求有 cookie
    await warmupQwenHomepage(opts.account).catch(err => {
      _debugLogger.debug(`Qwen warmup initial fetch failed: ${err.message}`, 'UPSTREAM')
    })
  } else if (warmupState === 'expired') {
    // 缓存过期：后台异步刷新，不阻塞主请求路径（当前请求用旧 cookie 或无 cookie）
    warmupQwenHomepage(opts.account).catch(err => {
      _debugLogger.debug(`Qwen warmup background refresh failed: ${err.message}`, 'UPSTREAM')
    })
  }
  // valid 状态：缓存命中且未过期，无需任何操作，buildQwenHeaders 直接取缓存

  const requestConfig = {
    headers: buildQwenHeaders({
      baseUrl,
      token,
      account: opts.account,
      includeCookie: opts.includeCookie,
      includeTokenCookie: opts.includeTokenCookie,
      includeWarmupCookies: opts.includeWarmupCookies
    }),
    timeout: config.qwenStreamTimeoutMs
  }

  // 流式 keepAlive：仅当 qwenStreamKeepAlive=true 时显式设置 keep-alive header。
  // 不再发送 Connection: close（会让 keepAlive agent 复用失效）；
  // 关闭时依靠 _streamHttpAgent/_streamHttpsAgent 的 keepAlive:false 自然不复用。
  if (streaming && config.qwenStreamKeepAlive) {
    requestConfig.headers.Connection = 'keep-alive'
  }

  if (opts.extraHeaders && typeof opts.extraHeaders === 'object') {
    Object.assign(requestConfig.headers, opts.extraHeaders)
  }

  // DEBUG: 打印实际发送的 bx 头（仅在 DEBUG 级别开启时构建，避免无谓的 JSON.stringify）
  if (_debugLogger.shouldLog('DEBUG')) {
    const bxHeaders = {}
    Object.keys(requestConfig.headers).forEach(k => {
      if (k.toLowerCase().startsWith('bx') || k.toLowerCase() === 'cookie' || k.toLowerCase() === 'user-agent' || k.toLowerCase() === 'sec-ch-ua') {
        bxHeaders[k] = k === 'Cookie' ? requestConfig.headers[k].substring(0, 60) + '...' : requestConfig.headers[k]
      }
    })
    _debugLogger.debug('[baxia-debug] request headers: %s', 'UPSTREAM', JSON.stringify(bxHeaders))
  }

  if (proxyAgent) {
    requestConfig.httpsAgent = proxyAgent
    requestConfig.proxy = false
  } else {
    requestConfig.httpAgent = streaming ? streamAgents.httpAgent : _httpAgent
    requestConfig.httpsAgent = streaming ? streamAgents.httpsAgent : _httpsAgent
  }

  if (opts.extraConfig && typeof opts.extraConfig === 'object') {
    Object.assign(requestConfig, opts.extraConfig)
  }

  return requestConfig
}

/**
 * 用默认 client 发送一个 POST 请求。
 * 用于 generateChatID（不要求 stream）这种小请求。
 * 如果 TLS sidecar 已启用且可用，自动通过 sidecar 转发以模拟浏览器 TLS 指纹。
 * @param {string} url
 * @param {Object} data
 * @param {Object} cfg - 由 buildRequestConfig 生成的 axios config
 * @returns {Promise<import('axios').AxiosResponse>}
 */
const postJson = async (url, data, cfg) => {
  // TLS sidecar 路径：当启用且目标是 https:// 时，通过 sidecar 转发
  if (shouldUseSidecar() && url && url.startsWith('https://')) {
    const headers = { ...(cfg.headers || {}), 'Content-Type': 'application/json' }
    const proxyUrl = cfg.httpsAgent?.proxyUrl || config.tlsSidecarProxyUrl || null
    const sidecarResult = await createTlsSidecarRequest({
      url,
      method: 'POST',
      headers,
      body: JSON.stringify(data),
      proxyUrl,
      streaming: cfg.responseType === 'stream',
      timeout: cfg.timeout || config.qwenStreamTimeoutMs,
    })
    // 把 sidecar 结果包装成 axios 风格响应
    if (sidecarResult.stream) {
      return {
        status: sidecarResult.status,
        headers: sidecarResult.headers,
        data: sidecarResult.stream,
        config: cfg,
      }
    }
    return {
      status: sidecarResult.status,
      headers: sidecarResult.headers,
      data: sidecarResult.body,
      config: cfg,
    }
  }

  // 原生 axios 路径
  const client = getUpstreamClient()
  return await client.post(url, data, cfg)
}

module.exports = {
  getUpstreamClient,
  getStreamAgent,
  buildRequestConfig,
  postJson,
  // 暴露 agent 供测试
  _httpAgent,
  _httpsAgent,
  _streamHttpAgent,
  _streamHttpsAgent
}
