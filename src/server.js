/** Express 服务器入口 — 挂载所有路由、中间件、静态资源 */

const express = require('express')
const bodyParser = require('body-parser')
const config = require('./config/index.js')
const cors = require('cors')
const { logger } = require('./utils/logger')
const { initSsxmodManager } = require('./backends/qwen/ssxmod-manager')
const DataPersistence = require('./utils/data-persistence')
const app = express()
const path = require('path')
const fs = require('fs')
const modelsRouter = require('./routes/models.js')
const chatRouter = require('./routes/chat.js')

const anthropicRouter = require('./routes/anthropic.js')
const verifyRouter = require('./routes/verify.js')
const accountsRouter = require('./routes/accounts.js')
const settingsRouter = require('./routes/settings.js')
const dpskChatRouter = require('./routes/dpsk-chat.js')
const dpskAccountsRouter = require('./routes/dpsk-accounts.js')
const responsesCompatRouter = require('./routes/responses-compat.js')
const accountManager = require('./utils/account.js')
const chatIdPool = require('./backends/qwen/chat-id-pool.js')
const { prewarmDns } = require('./utils/dns-cache')
const { getChatBaseUrl } = require('./utils/proxy-helper')
const dpskAccount = require('./backends/deepseek/dpsk-account.js')
const dpskPow = require('./backends/deepseek/dpsk-pow.js')
const { startAutoRefresh: startBaxiaRefresh } = require('./backends/qwen/baxia-umid')

if (config.dataSaveMode === 'file') {
  if (!fs.existsSync(path.join(__dirname, '../data/qwen-data.json'))) {
    fs.writeFileSync(path.join(__dirname, '../data/qwen-data.json'), JSON.stringify({"accounts": [] }, null, 2))
  }
}

// 初始化 SSXMOD Cookie 管理器
initSsxmodManager()

app.use(bodyParser.json({ limit: '128mb' }))
app.use(bodyParser.urlencoded({ limit: '128mb', extended: true }))
app.use(cors())

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    logger.warn('Invalid JSON request body', 'SERVER', '', { message: err.message })
    return res.status(400).json({
      error: {
        message: 'Invalid JSON request body',
        type: 'invalid_request_error',
        param: null,
        code: 'invalid_json'
      }
    })
  }
  next(err)
})

// API路由
app.use(modelsRouter)
app.use(chatRouter)

app.use(anthropicRouter)
app.use(verifyRouter)
app.use('/api', accountsRouter)
app.use('/api', settingsRouter)
// DeepSeek 路线：/v1/dpsk/* 聊天接口 + /api/dpsk/* 账号管理
app.use(dpskChatRouter)
app.use('/api', dpskAccountsRouter)
app.use(responsesCompatRouter)

app.use(express.static(path.join(__dirname, '../public/dist')))

// API 路径兜底：未注册的 /api/* 和 /v1/* GET 请求返回 JSON 404，而非 HTML
app.get('/api/*', (req, res) => res.status(404).json({ error: 'Not found' }))
app.get('/v1/*', (req, res) => res.status(404).json({ error: 'Not found' }))

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dist/index.html'), (err) => {
    if (err) {
      logger.error('管理页面加载失败', 'SERVER', '', err)
      res.status(500).send('服务器内部错误')
    }
  })
})

// 处理错误中间件（必须放在所有路由之后）
app.use((err, req, res, next) => {
  logger.error('服务器内部错误', 'SERVER', '', err)
  // 若 headers 已发送（如 SSE 流式响应中途出错），不能再设置 status，
  // 否则抛 "Cannot set headers after they are sent" 导致 worker 崩溃
  if (res.headersSent) {
    try { res.end() } catch (_) { /* 客户端可能已断开 */ }
    return
  }
  res.status(500).send('服务器内部错误')
})


// 服务器启动信息
const serverInfo = {
  address: config.listenAddress || 'localhost',
  port: config.listenPort,
  outThink: config.outThink ? '开启' : '关闭',
  searchInfoMode: config.searchInfoMode === 'table' ? '表格' : '文本',
  dataSaveMode: config.dataSaveMode,
  logLevel: config.logLevel,
  enableFileLog: config.enableFileLog
}

// 应用持久化的运行时设置（web UI > env > hardcoded default）
// Web UI 可覆盖 chatRetryCount / chatRetryBackoffMs；env 在 config/index.js 中作为 baseline。
const applyPersistedSettings = async () => {
  try {
    const persisted = await new DataPersistence().loadSettings()
    if (persisted.chatRetryCount !== undefined && persisted.chatRetryCount !== '') {
      const v = parseInt(persisted.chatRetryCount, 10)
      if (!isNaN(v) && v >= 0) config.chatRetryCount = v
    }
    if (persisted.chatRetryBackoffMs !== undefined && persisted.chatRetryBackoffMs !== '') {
      const v = parseInt(persisted.chatRetryBackoffMs, 10)
      if (!isNaN(v) && v >= 0) config.chatRetryBackoffMs = v
    }
    if (typeof persisted.outThink === 'boolean') {
      config.outThink = persisted.outThink
    }
    if (persisted.searchInfoMode && ['table', 'text'].includes(persisted.searchInfoMode)) {
      config.searchInfoMode = persisted.searchInfoMode
    }
    if (typeof persisted.simpleModelMap === 'boolean') {
      config.simpleModelMap = persisted.simpleModelMap
    }
    if (typeof persisted.autoRefresh === 'boolean') {
      config.autoRefresh = persisted.autoRefresh
    }
    if (persisted.autoRefreshInterval !== undefined && persisted.autoRefreshInterval !== '') {
      const v = parseInt(persisted.autoRefreshInterval, 10)
      if (!isNaN(v) && v >= 0) config.autoRefreshInterval = v
    }
    if (persisted.batchLoginConcurrency !== undefined && persisted.batchLoginConcurrency !== '') {
      const v = parseInt(persisted.batchLoginConcurrency, 10)
      if (!isNaN(v) && v >= 1 && v <= 20) config.batchLoginConcurrency = v
    }
    // 持久化 apiKeys 与 env/`.env` apiKeys 取并集：已通过 Web UI 保存的 key 保留，
    // 同时 env 中新增的 key 也自动生效，避免 env 的 key 被持久化覆盖导致 401。
    if (Array.isArray(persisted.apiKeys) && persisted.apiKeys.length > 0) {
      const envKeys = Array.isArray(config.apiKeys) ? config.apiKeys : (config.apiKeys ? [config.apiKeys] : [])
      const merged = [...new Set([...envKeys, ...persisted.apiKeys])]
      config.apiKeys = merged
      config.apiKeySet = new Set(merged)
      // 仅在 adminKey 未设置时才用 merged[0] 兜底，避免覆盖 env ADMIN_KEY
      config.adminKey = config.adminKey || (merged.length > 0 ? merged[0] : null)
    }
    // DeepSeek 默认 think effort（客户端未显式传 reasoning_effort 时使用）
    if (persisted.dpskThinkEffort && ['low', 'medium', 'high', 'max'].includes(persisted.dpskThinkEffort)) {
      config.dpskThinkEffort = persisted.dpskThinkEffort;
    }
    // TLS Sidecar 配置
    if (persisted.tlsSidecarEnabled !== undefined) {
      const validModes = [false, 'all', 'dpsk', 'qwen']
      if (validModes.includes(persisted.tlsSidecarEnabled)) {
        config.tlsSidecarEnabled = persisted.tlsSidecarEnabled
      }
    }
    if (persisted.tlsSidecarPort !== undefined) {
      const v = parseInt(persisted.tlsSidecarPort, 10)
      if (!isNaN(v) && v >= 1 && v <= 65535) config.tlsSidecarPort = v
    }

    // 持久化设置加载后，同步启动/重启 DeepSeek 自动刷新定时器
    try {
      accountManager.startAutoRefresh()
      dpskAccount.startAutoRefresh()
    } catch (err) {
      logger.warn('启动 DeepSeek 自动刷新定时器失败', 'CONFIG', '', err.message)
    }
    try {
      startBaxiaRefresh()
    } catch (err) {
      logger.warn('启动 Baxia umidtoken 自动刷新定时器失败', 'CONFIG', '', err.message)
    }
  } catch (err) {
    logger.warn('加载持久化设置失败, 使用 env/默认值', 'CONFIG', '', err.message)
  }
}

const warmChatIdPoolOnStartup = () => {
  if (!config.chatIdPrewarm || config.chatIdPrewarmMode === 'off') return
  accountManager.waitUntilReady(10000)
    .then((state) => {
      if (!state?.ready || state.count <= 0) {
        logger.debug(`chat_id startup prewarm skipped ready=${!!state?.ready} count=${state?.count || 0}`, 'POOL')
        return
      }
      return chatIdPool.primeOnStartup(accountManager)
    })
    .then(() => {
      logger.debug('chat_id startup prewarm finished', 'POOL')
    })
    .catch((error) => {
      logger.debug(`chat_id startup prewarm failed: ${error?.message || error}`, 'POOL')
    })
}

/**
 * DeepSeek 冷启动预热 — 预加载 WASM PoW 求解器
 *
 * dpsk-pow.js 的 WASM 模块在首次调用 solvePow 时才会异步编译，
 * 编译耗时约 100-500ms，会让 harness 第一次请求的 PoW 步骤看起来"卡住"。
 * 在服务启动时主动触发 loadWasm() 让编译在后台异步进行，
 * 这样首个真实请求到达时 wasmInstance 已就绪，可直接求解。
 *
 * 注意：dpskPow.loadWasm() 是 promise 单例，重复调用不会重复编译。
 */
const warmDpskPowOnStartup = () => {
  dpskPow.loadWasm()
    .then(() => {
      logger.info('[DPSK] WASM PoW 求解器预加载完成', 'DPSK')
    })
    .catch((err) => {
      logger.warn(`[DPSK] WASM PoW 求解器预加载失败: ${err?.message || err}`, 'DPSK')
    })
}

const onServerStarted = () => {
  try {
    const qwenStats = accountManager.getAccountStats();
    const dpskStats = dpskAccount.getAccountStats();
    logger.info(
      `账号状态 — Qwen: ${qwenStats.withToken}/${qwenStats.enabled}/${qwenStats.total} (可用/启用/总数) | ` +
      `DPSK: ${dpskStats.withToken}/${dpskStats.enabled}/${dpskStats.total}`,
      'SERVER', ''
    );
  } catch (_) { /* 账号统计非关键，失败不影响启动 */ }
  logger.server('服务器启动成功', 'SERVER', serverInfo)
  warmChatIdPoolOnStartup()
  warmDpskPowOnStartup()

  // 预热 DNS 缓存：提前解析上游域名，避免首个请求触发 ENOTFOUND
  const chatBaseUrl = getChatBaseUrl()
  try {
    const hostname = new URL(chatBaseUrl).hostname
    prewarmDns(hostname).then(() => {
      logger.debug(`[DNS-CACHE] prewarmed ${hostname}`, 'SERVER')
    })
  } catch (_) { /* URL 解析失败不阻塞启动 */ }
}

const onServerError = (err) => {
  // 端口占用必须直接退出，让外层 PM2/脚本看到明确失败。
  // 之前端口被 WSL 或旧进程占用时，cluster 会不断重启 worker，
  // 表面上像 Redis/账户管理器重复清理，实际根因是 listen 失败。
  if (err && err.code === 'EADDRINUSE') {
    const host = config.listenAddress || '0.0.0.0'
    logger.error(`服务端口已被占用: ${host}:${config.listenPort}。请先关闭旧的 z.free.api/WSL/PM2 进程，或修改 SERVICE_PORT。`, 'SERVER', '', err)
    process.exit(1)
  }
  logger.error('服务器启动失败', 'SERVER', '', err)
  process.exit(1)
}

const startServer = () => {
  // Memory 调度器要求单进程：PM2 cluster 或多实例模式下每个进程独立维护内存状态，
  // 会导致 inFlight 计数不共享、多实例同时选中同一账号，失去并发控制能力。
  // 注意：不能仅凭 .env 中的 PM2_INSTANCES 判断——start.js 在非 PM2 托管时
  // 会回退到单进程，此时 .env 的 PM2_INSTANCES 值不代表实际进程数。
  if (config.qwenSchedulerBackend === 'memory') {
    const cluster = require('cluster')
    const isPm2Cluster = process.env.NODE_APP_INSTANCE !== undefined
    const isNodeCluster = cluster.isWorker
    const isPm2Managed = process.env.pm_id !== undefined

    // PM2 cluster 模式或 Node.js direct cluster 模式 → 一定多进程
    if (isPm2Cluster || isNodeCluster) {
      logger.error(
        '[FATAL] QWEN_SCHEDULER_BACKEND=memory 不支持多进程模式。' +
        `当前 ${isPm2Cluster ? 'PM2 cluster' : 'Node.js cluster'} 模式。` +
        '请改为：1) 单进程运行（PM2 instances=1 或 node start.js）；或 2) 设置 QWEN_SCHEDULER_BACKEND=redis。',
        'SCHEDULER'
      )
      process.exit(1)
    }

    // PM2 fork 模式（pm_id 已设置但 NODE_APP_INSTANCE 未设置）
    if (isPm2Managed) {
      const pm2Instances = parseInt(process.env.PM2_INSTANCES || process.env.instances || '1', 10)
      if (pm2Instances > 1) {
        logger.error(
          '[FATAL] QWEN_SCHEDULER_BACKEND=memory 不支持多进程模式。' +
          `当前 PM2 fork instances=${pm2Instances}。` +
          '请改为：1) 设置 PM2 instances=1 单进程运行；或 2) 设置 QWEN_SCHEDULER_BACKEND=redis。',
          'SCHEDULER'
        )
        process.exit(1)
      }
    }
  }

  const server = config.listenAddress
    ? app.listen(config.listenPort, config.listenAddress, onServerStarted)
    : app.listen(config.listenPort, onServerStarted)
  server.on('error', onServerError)
}

applyPersistedSettings().finally(startServer)
