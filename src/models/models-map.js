const axios = require('axios')
const path = require('path')
const fs = require('fs')
const accountManager = require('../utils/account.js')
const { getChatBaseUrl } = require('../utils/proxy-helper')
const config = require('../config/index.js')
const { logger } = require('../utils/logger.js')
const upstream = require('../backends/qwen/upstream-client')
const { buildQwenHeaders } = require('../providers/qwen-web/headers')
const qwenWeb = require('../providers/qwen-web')

// 内存缓存：成功时写入；失败时绝不覆盖（保证"失败空数组"不会被永久缓存）
let cachedModels = null
// 上次成功缓存的时间戳（毫秒）——用于 TTL 策略
let cachedAt = 0
// 正在执行的 fetch Promise（避免并发）
let fetchPromise = null

// 磁盘缓存路径（上游失败时用作兜底，替代硬编码列表）
const DISK_CACHE_FILE = path.resolve(config.dataDir || './data', 'qwen-models-cache.json')

/**
 * 从磁盘读取上次成功的模型列表缓存
 */
function _readDiskCache() {
  try {
    if (fs.existsSync(DISK_CACHE_FILE)) {
      const raw = fs.readFileSync(DISK_CACHE_FILE, 'utf-8')
      const data = JSON.parse(raw)
      if (Array.isArray(data) && data.length > 0) {
        return data
      }
    }
  } catch (e) {
    logger.debug('[MODEL] Qwen 模型磁盘缓存读取失败: ' + e.message, 'MODEL')
  }
  return null
}

/**
 * 将模型列表写入磁盘缓存
 */
function _writeDiskCache(models) {
  try {
    const dir = path.dirname(DISK_CACHE_FILE)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(DISK_CACHE_FILE, JSON.stringify(models, null, 2), 'utf-8')
  } catch (e) {
    logger.debug('[MODEL] Qwen 模型磁盘缓存写入失败: ' + e.message, 'MODEL')
  }
}

/**
 * 获取兜底列表
 * 规则：
 *   1. 先从磁盘缓存读（上次上游成功时写入）
 *   2. 无磁盘缓存时返回空数组（绝不返回硬编码列表）
 *   3. config.modelListFallback=false 时直接返回空
 * @returns {Array}
 */
const _getFallbackModelsIfEnabled = () => {
  if (!config.modelListFallback) return []
  const diskCache = _readDiskCache()
  return diskCache && diskCache.length > 0 ? diskCache : []
}

/**
 * 脱敏的 axios 错误摘要
 * 绝不输出 token / cookie / proxy / 邮箱完整地址
 * @param {Error} error
 * @returns {{status:number|null, code:string|null, message:string}}
 */
const summarizeAxiosError = (error) => {
  if (!error) return { status: null, code: null, message: 'unknown_error' }
  const status = error.response ? Number(error.response.status) || null : null
  const code = error.code || (error.cause && error.cause.code) || null
  let message = error.message || 'unknown_error'
  if (typeof message !== 'string') message = String(message)
  message = message.slice(0, 200)
  if (/\b(Bearer\s+[A-Za-z0-9._-]{16,}|ssxmod|acw_tc|sess-|cookie=|password=|token=)\b/i.test(message)) {
    message = 'redacted_sensitive_context'
  }
  return { status, code, message }
}

/**
 * 上游成功时写入缓存（内存 + 磁盘）
 * @param {Array} data
 */
const _setCachedSuccess = (data) => {
  if (Array.isArray(data) && data.length > 0) {
    cachedModels = data
    cachedAt = Date.now()
    _writeDiskCache(data)
  }
}

/**
 * 内部共享实现：取最新模型列表
 * 返回包装对象 { models, source, error }，不直接对外
 *  - models 永远是 Array（可能为空，但不会伪造假模型）
 *  - source: 'cache' | 'upstream' | 'fallback' | 'empty'
 *  - error: 失败时附带脱敏错误
 *
 * 行为：
 *   - 优先使用上游真实模型列表
 *   - 上游失败/账号未就绪时，复用上次成功缓存（内存/磁盘）
 *   - 无缓存且 config.modelListFallback=true 时，尝试磁盘缓存
 *   - 兜底也关闭时，返回空数组，由上层控制器显式返回 503
 *   - **绝不返回硬编码模型列表**
 */
const _fetchModelsDetailed = async (force = false) => {
  const ttl = Math.max(0, Number(config.modelListCacheTtlMs) || 0)

  // 1) 命中 TTL 内的成功缓存
  if (!force && cachedModels && Array.isArray(cachedModels) && cachedModels.length > 0) {
    if (ttl <= 0 || (Date.now() - cachedAt) < ttl) {
      return { models: cachedModels, source: 'cache', error: null }
    }
  }

  // 2) 等待 accountManager 初始化完成（最多 1.5s）
  let readiness = { ready: true, count: 0 }
  try {
    readiness = await accountManager.waitUntilReady(1500)
  } catch (_) { /* ignore */ }

  // 3) 账号未就绪：复用上次成功缓存；无缓存则返回空（不伪造）
  if (!readiness.ready || readiness.count === 0) {
    const errSummary = {
      status: null, code: 'ACCOUNT_NOT_READY',
      message: `accountManager not ready (isInitialized=${accountManager.isInitialized} count=${readiness.count})`,
    }
    if (cachedModels && Array.isArray(cachedModels) && cachedModels.length > 0) {
      logger.warn(`[DIAG] getLatestModels: accountManager 未就绪，复用上次成功缓存 count=${cachedModels.length} (reason=${errSummary.code})`, 'MODEL')
      return { models: cachedModels, source: 'cache', error: errSummary }
    }
    const fallback = _getFallbackModelsIfEnabled()
    if (fallback.length > 0) {
      logger.warn(`[DIAG] getLatestModels: accountManager 未就绪，返回磁盘缓存兜底列表 count=${fallback.length} (reason=${errSummary.code})`, 'MODEL')
      return { models: fallback, source: 'fallback', error: errSummary }
    }
    logger.error(`[DIAG] getLatestModels: accountManager 未就绪且无缓存/兜底，返回空数组 (reason=${errSummary.code})`, 'MODEL')
    return { models: [], source: 'empty', error: errSummary }
  }

  // 4) 如果有正在进行的 fetch，复用它
  if (fetchPromise) return fetchPromise

  // 5) 发起新 fetch
  const chatBaseUrl = getChatBaseUrl()
  const account = accountManager.getAccount()
  if (!account || !account.token) {
    const errSummary = {
      status: null, code: 'NO_AVAILABLE_ACCOUNT',
      message: `accountManager.getAccount() returned null/empty token (count=${readiness.count})`,
    }
    if (cachedModels && Array.isArray(cachedModels) && cachedModels.length > 0) {
      logger.warn(`[DIAG] getLatestModels: getAccount() 失败，复用上次成功缓存 count=${cachedModels.length} (reason=${errSummary.code})`, 'MODEL')
      return { models: cachedModels, source: 'cache', error: errSummary }
    }
    const fallback = _getFallbackModelsIfEnabled()
    if (fallback.length > 0) {
      logger.warn(`[DIAG] getLatestModels: getAccount() 失败，返回磁盘缓存兜底列表 count=${fallback.length} (reason=${errSummary.code})`, 'MODEL')
      return { models: fallback, source: 'fallback', error: errSummary }
    }
    logger.error(`[DIAG] getLatestModels: getAccount() 失败且无缓存/兜底，返回空数组 (reason=${errSummary.code})`, 'MODEL')
    return { models: [], source: 'empty', error: errSummary }
  }

  const requestConfig = await upstream.buildRequestConfig({
    token: account.token, account, baseUrl: chatBaseUrl,
    extraHeaders: buildQwenHeaders({ baseUrl: chatBaseUrl, token: account.token, account, includeTokenCookie: false }),
    extraConfig: { timeout: 15000 },
  })

  fetchPromise = axios.get(
    qwenWeb.endpoints.buildUrl(chatBaseUrl, qwenWeb.endpoints.PATHS.models),
    requestConfig
  ).then(response => {
    const data = response && response.data && response.data.data
    if (Array.isArray(data) && data.length > 0) {
      _setCachedSuccess(data)
      return { models: cachedModels, source: 'upstream', error: null }
    }
    const errSummary = {
      status: response ? response.status : null, code: 'UPSTREAM_EMPTY_DATA',
      message: 'upstream /api/models returned empty data array',
    }
    logger.warn(`[DIAG] getLatestModels: 上游返回空数组 (status=${errSummary.status} code=${errSummary.code})`, 'MODEL')
    if (cachedModels && Array.isArray(cachedModels) && cachedModels.length > 0) {
      return { models: cachedModels, source: 'cache', error: errSummary }
    }
    const fallback = _getFallbackModelsIfEnabled()
    if (fallback.length > 0) {
      logger.warn(`[DIAG] getLatestModels: 上游返回空数组，返回磁盘缓存兜底列表 count=${fallback.length} (reason=${errSummary.code})`, 'MODEL')
      return { models: fallback, source: 'fallback', error: errSummary }
    }
    return { models: [], source: 'empty', error: errSummary }
  }).catch(error => {
    const errSummary = summarizeAxiosError(error)
    logger.error(`[DIAG] getLatestModels: 上游请求失败 (status=${errSummary.status} code=${errSummary.code} message=${errSummary.message})`, 'MODEL')
    if (cachedModels && Array.isArray(cachedModels) && cachedModels.length > 0) {
      return { models: cachedModels, source: 'cache', error: errSummary }
    }
    const fallback = _getFallbackModelsIfEnabled()
    if (fallback.length > 0) {
      logger.warn(`[DIAG] getLatestModels: 上游请求失败，返回磁盘缓存兜底列表 count=${fallback.length} (reason=${errSummary.code})`, 'MODEL')
      return { models: fallback, source: 'fallback', error: errSummary }
    }
    return { models: [], source: 'empty', error: errSummary }
  }).finally(() => { fetchPromise = null })

  return fetchPromise
}

/**
 * 公共 API：取最新模型列表
 * **只返回 Array**——这是核心契约
 *
 * @param {boolean} [force=false] - 强制刷新（跳过缓存）
 * @returns {Promise<Array>}
 */
const getLatestModels = async (force = false) => {
  try {
    const r = await _fetchModelsDetailed(force)
    return Array.isArray(r && r.models) ? r.models : []
  } catch (e) {
    logger.error('[DIAG] getLatestModels: 异常，返回空数组', 'MODEL', '', e)
    return []
  }
}

/**
 * 诊断版：返回 { models, source, error } 包装对象
 * @param {boolean} [force=false]
 * @returns {Promise<{models: Array, source: string, error: object|null}>}
 */
const getLatestModelsDetailed = async (force = false) => {
  try { return await _fetchModelsDetailed(force) }
  catch (e) { return { models: [], source: 'empty', error: summarizeAxiosError(e) } }
}

/**
 * 根据聊天类型获取默认模型
 * @param {string} chatType
 * @returns {Promise<string|null>}
 */
const getDefaultModelByChatType = async (chatType) => {
  const models = await getLatestModels()
  const matchedModel = models.find(model => model?.info?.meta?.chat_type?.includes(chatType))
  return matchedModel?.id || null
}

module.exports = {
  getLatestModels,
  getLatestModelsArray: getLatestModels,
  getLatestModelsDetailed,
  getDefaultModelByChatType,
}
