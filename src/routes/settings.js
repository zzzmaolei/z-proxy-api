/** 系统设置 API 路由 — 管理 API Key / 自动刷新 / 运行时配置 */

const express = require('express')
const router = express.Router()
const config = require('../config')
const DataPersistence = require('../utils/data-persistence')
const { apiKeyVerify, adminKeyVerify } = require('../middlewares/authorization')
const { logger } = require('../utils/logger')
const dpskAccount = require('../backends/deepseek/dpsk-account')
const accountManager = require('../utils/account')
const { refreshSidecarStatus } = require('../utils/tls-sidecar-client')

const configManager = require('../config/config-manager')

const dataPersistence = new DataPersistence()


router.get('/settings', adminKeyVerify, async (req, res) => {
  // 分离管理员密钥和普通密钥
  const regularKeys = config.apiKeys.filter(key => key !== config.adminKey)

  res.json({
    apiKey: config.apiKeys[0] || null, // 保持向后兼容
    adminKey: config.adminKey,
    regularKeys: regularKeys,
    defaultHeaders: config.defaultHeaders,
    defaultCookie: config.defaultCookie,
    autoRefresh: config.autoRefresh,
    autoRefreshInterval: config.autoRefreshInterval,
    batchLoginConcurrency: config.batchLoginConcurrency,
    outThink: config.outThink,
    searchInfoMode: config.searchInfoMode,
    simpleModelMap: config.simpleModelMap,
    chatRetryCount: config.chatRetryCount,
    chatRetryBackoffMs: config.chatRetryBackoffMs,
    // 两家路线独有设置
    dpskThinkEffort: config.dpskThinkEffort,
    // TLS Sidecar 设置
    tlsSidecarEnabled: config.tlsSidecarEnabled,
    tlsSidecarPort: config.tlsSidecarPort,
    persistenceMode: config.dataSaveMode,
  })
})

// 添加普通API Key
router.post('/addRegularKey', adminKeyVerify, async (req, res) => {
  try {
    const { apiKey } = req.body
    if (!apiKey) {
      return res.status(400).json({ error: 'API Key不能为空' })
    }

    // 检查是否已存在
    if (config.apiKeys.includes(apiKey)) {
      return res.status(409).json({ error: 'API Key已存在' })
    }

    // 添加到配置中
    config.apiKeys.push(apiKey)

    const persisted = await dataPersistence.saveSettings({ apiKeys: config.apiKeys })

    res.json({ message: 'API Key添加成功', persisted })
  } catch (error) {
    logger.error('添加API Key失败', 'CONFIG', '', error)
    res.status(500).json({ error: error.message })
  }
})

// 删除普通API Key
router.post('/deleteRegularKey', adminKeyVerify, async (req, res) => {
  try {
    const { apiKey } = req.body
    if (!apiKey) {
      return res.status(400).json({ error: 'API Key不能为空' })
    }

    // 不能删除管理员密钥
    if (apiKey === config.adminKey) {
      return res.status(403).json({ error: '不能删除管理员密钥' })
    }

    // 从配置中移除
    const index = config.apiKeys.indexOf(apiKey)
    if (index === -1) {
      return res.status(404).json({ error: 'API Key不存在' })
    }

    config.apiKeys.splice(index, 1)

    const persisted = await dataPersistence.saveSettings({ apiKeys: config.apiKeys })

    res.json({ message: 'API Key删除成功', persisted })
  } catch (error) {
    logger.error('删除API Key失败', 'CONFIG', '', error)
    res.status(500).json({ error: error.message })
  }
})

// 更新自动刷新设置
router.post('/setAutoRefresh', adminKeyVerify, async (req, res) => {
  try {
    const { autoRefresh, autoRefreshInterval } = req.body

    if (typeof autoRefresh !== 'boolean') {
      return res.status(400).json({ error: '无效的自动刷新设置' })
    }

    if (autoRefreshInterval !== undefined) {
      const interval = parseInt(autoRefreshInterval)
      if (isNaN(interval) || interval < 0) {
        return res.status(400).json({ error: '无效的自动刷新间隔' })
      }
    }
    config.autoRefresh = autoRefresh
    config.autoRefreshInterval = autoRefreshInterval !== undefined ? autoRefreshInterval : 6 * 60 * 60

    // 两个 provider 的计时器均需按新配置重建。
    try {
      accountManager.startAutoRefresh()
      dpskAccount.startAutoRefresh()
    } catch (e) {
      logger.warn('重启 DeepSeek 自动刷新定时器失败', 'CONFIG', '', e)
    }

    const persisted = await dataPersistence.saveSettings({
      autoRefresh: config.autoRefresh,
      autoRefreshInterval: config.autoRefreshInterval
    })
    res.json({
      status: true,
      message: '自动刷新设置更新成功',
      persisted
    })
  } catch (error) {
    logger.error('更新自动刷新设置失败', 'CONFIG', '', error)
    res.status(500).json({ error: error.message })
  }
})

// 更新批量登录并发数
router.post('/setBatchLoginConcurrency', adminKeyVerify, async (req, res) => {
  try {
    const concurrency = parseInt(req.body.batchLoginConcurrency)

    if (isNaN(concurrency) || concurrency < 1 || concurrency > 20) {
      return res.status(400).json({ error: '无效的批量登录并发数，允许范围为 1-20' })
    }

    config.batchLoginConcurrency = concurrency
    const persisted = await dataPersistence.saveSettings({ batchLoginConcurrency: concurrency })
    res.json({
      status: true,
      message: '批量登录并发数更新成功',
      persisted
    })
  } catch (error) {
    logger.error('更新批量登录并发数失败', 'CONFIG', '', error)
    res.status(500).json({ error: error.message })
  }
})

// 更新思考输出设置
router.post('/setOutThink', adminKeyVerify, async (req, res) => {
  try {
    const { outThink } = req.body;
    if (typeof outThink !== 'boolean') {
      return res.status(400).json({ error: '无效的思考输出设置' })
    }

    config.outThink = outThink
    const persisted = await dataPersistence.saveSettings({ outThink })
    res.json({
      status: true,
      message: '思考输出设置更新成功',
      persisted
    })
  } catch (error) {
    logger.error('更新思考输出设置失败', 'CONFIG', '', error)
    res.status(500).json({ error: error.message })
  }
})

// 更新搜索信息模式
router.post('/search-info-mode', adminKeyVerify, async (req, res) => {
  try {
    const { searchInfoMode } = req.body
    if (!['table', 'text'].includes(searchInfoMode)) {
      return res.status(400).json({ error: '无效的搜索信息模式' })
    }

    config.searchInfoMode = searchInfoMode
    const persisted = await dataPersistence.saveSettings({ searchInfoMode })
    res.json({
      status: true,
      message: '搜索信息模式更新成功',
      persisted
    })
  } catch (error) {
    logger.error('更新搜索信息模式失败', 'CONFIG', '', error)
    res.status(500).json({ error: error.message })
  }
})

// 更新聊天请求 retry 配置
router.post('/setRetryConfig', adminKeyVerify, async (req, res) => {
  try {
    const { chatRetryCount, chatRetryBackoffMs } = req.body
    const count = parseInt(chatRetryCount, 10)
    const backoff = parseInt(chatRetryBackoffMs, 10)

    if (isNaN(count) || count < 0 || count > 10) {
      return res.status(400).json({ error: '无效的 retry 次数，允许范围为 0-10' })
    }
    if (isNaN(backoff) || backoff < 0 || backoff > 60000) {
      return res.status(400).json({ error: '无效的 backoff 毫秒数，允许范围为 0-60000' })
    }

    config.chatRetryCount = count
    config.chatRetryBackoffMs = backoff

    // 持久化（在 'none' 模式下 saveSettings 会返回 false，但没关系——env baseline 仍然保留）
    const persisted = await dataPersistence.saveSettings({
      chatRetryCount: count,
      chatRetryBackoffMs: backoff
    })

    logger.info(
      `聊天 retry 配置更新: count=${count}, backoff=${backoff}ms (持久化: ${persisted ? '是' : '否'})`,
      'CONFIG',
      '⚙️'
    )

    res.json({
      status: true,
      message: '聊天 retry 配置更新成功',
      persisted
    })
  } catch (error) {
    logger.error('更新聊天 retry 配置失败', 'CONFIG', '', error)
    res.status(500).json({ error: error.message })
  }
})

// 更新简化模型映射设置
router.post('/simple-model-map', adminKeyVerify, async (req, res) => {
  try {
    const { simpleModelMap } = req.body
    if (typeof simpleModelMap !== 'boolean') {
      return res.status(400).json({ error: '无效的简化模型映射设置' })
    }

    config.simpleModelMap = simpleModelMap
    const persisted = await dataPersistence.saveSettings({ simpleModelMap })
    res.json({
      status: true,
      message: '简化模型映射设置更新成功',
      persisted
    })
  } catch (error) {
    logger.error('更新简化模型映射设置失败', 'CONFIG', '', error)
    res.status(500).json({ error: error.message })
  }
})

// 更新 DeepSeek 默认 think effort (low/medium/high/max)
// 客户端未显式传 reasoning_effort / thinking 时使用此默认值
router.post('/setDpskThinkEffort', adminKeyVerify, async (req, res) => {
  try {
    const { dpskThinkEffort } = req.body
    if (!['low', 'medium', 'high', 'max'].includes(dpskThinkEffort)) {
      return res.status(400).json({ error: '无效的 DeepSeek think effort，必须为 low / medium / high / max' })
    }

    config.dpskThinkEffort = dpskThinkEffort
    const persisted = await dataPersistence.saveSettings({ dpskThinkEffort })

    logger.info(
      `DeepSeek think effort 默认值更新: ${dpskThinkEffort} (持久化: ${persisted ? '是' : '否'})`,
      'CONFIG',
      '⚙️'
    )

    res.json({
      status: true,
      message: 'DeepSeek think effort 默认值更新成功',
      dpskThinkEffort,
      persisted
    })
  } catch (error) {
    logger.error('更新 DeepSeek think effort 默认值失败', 'CONFIG', '', error)
    res.status(500).json({ error: error.message })
  }
})

// 更新 TLS Sidecar 配置
// TLS_SIDECAR_ENABLED: false / 'all' / 'dpsk' / 'qwen'
router.post('/setTlsSidecar', adminKeyVerify, async (req, res) => {
  try {
    const { tlsSidecarEnabled, tlsSidecarPort } = req.body
    const validModes = [false, 'all', 'dpsk', 'qwen']

    if (tlsSidecarEnabled !== undefined) {
      if (!validModes.includes(tlsSidecarEnabled)) {
        return res.status(400).json({ error: '无效的 TLS Sidecar 模式，必须为 false / all / dpsk / qwen' })
      }
      config.tlsSidecarEnabled = tlsSidecarEnabled
    }

    if (tlsSidecarPort !== undefined) {
      const port = parseInt(tlsSidecarPort, 10)
      if (isNaN(port) || port < 1 || port > 65535) {
        return res.status(400).json({ error: '无效的端口号，必须为 1-65535' })
      }
      config.tlsSidecarPort = port
    }

    const persisted = await dataPersistence.saveSettings({
      tlsSidecarEnabled: config.tlsSidecarEnabled,
      tlsSidecarPort: config.tlsSidecarPort,
    })

    try {
      await refreshSidecarStatus()
    } catch (error) {
      logger.warn(`TLS Sidecar 健康检查失败: ${error.message}`, 'CONFIG')
    }

    logger.info(
      `TLS Sidecar 配置更新: enabled=${config.tlsSidecarEnabled}, port=${config.tlsSidecarPort} (持久化: ${persisted ? '是' : '否'})`,
      'CONFIG',
      '⚙️'
    )

    res.json({
      status: true,
      message: 'TLS Sidecar 配置更新成功',
      tlsSidecarEnabled: config.tlsSidecarEnabled,
      tlsSidecarPort: config.tlsSidecarPort,
      persisted
    })
  } catch (error) {
    logger.error('更新 TLS Sidecar 配置失败', 'CONFIG', '', error)
    res.status(500).json({ error: error.message })
  }
})

// === ClientProfile 管理 ===
// 端点实际路径前缀为 /api（server.js 中 app.use('/api', settingsRouter)）

// GET /api/qwen-profiles
// 返回所有账号的 profile 绑定表（账号 → profile 映射）
router.get('/qwen-profiles', adminKeyVerify, async (req, res) => {
  try {
    const { assignProfileToAccount } = require('../backends/qwen/client-profile.js')
    const bindings = []
    // accountManager 是单例（Account 类实例），账号列表在 accountTokens 数组上
    const accounts = accountManager.accountTokens || []
    for (const account of accounts) {
      // assignProfileToAccount 是幂等的：已分配则按确定性哈希重算同样的 profile；
      // 未启用（mode=current）则什么都不做，account.clientProfile 保持 undefined。
      assignProfileToAccount(account)
      const profile = account.clientProfile
      // 从 UA 派生 browserFamily / browserMajorVersion，从 secChUaPlatform 派生 platformFamily
      let browserFamily = null
      let browserMajorVersion = null
      if (profile && profile.userAgent) {
        const ua = String(profile.userAgent)
        const edgeMatch = ua.match(/Edg\/(\d+)/)
        const chromeMatch = ua.match(/Chrome\/(\d+)/)
        if (edgeMatch) {
          browserFamily = 'Edge'
          browserMajorVersion = parseInt(edgeMatch[1], 10) || null
        } else if (chromeMatch) {
          browserFamily = 'Chrome'
          browserMajorVersion = parseInt(chromeMatch[1], 10) || null
        }
      }
      let platformFamily = null
      if (profile && profile.secChUaPlatform) {
        // secChUaPlatform 形如 '"Windows"'，去掉外层引号
        platformFamily = String(profile.secChUaPlatform).replace(/^"|"$/g, '')
      }
      bindings.push({
        // admin only，不写入其他日志
        accountId: account.email ? account.email.split('@')[0] : 'unknown',
        email: account.email || null,
        profileId: profile ? profile._profileId || null : null,
        userAgent: profile ? profile.userAgent || null : null,
        secChUa: profile ? profile.secChUa || null : null,
        secChUaPlatform: profile ? profile.secChUaPlatform || null : null,
        acceptLanguage: profile ? profile.acceptLanguage || null : null,
        locale: profile ? profile.locale || null : null,
        timezoneFamily: profile ? profile.timezoneFamily || null : null,
        timezoneOffsetMinutes: profile ? (profile.timezoneOffsetMinutes ?? null) : null,
        // 派生字段（人类可读）
        platformFamily,
        browserFamily,
        browserMajorVersion
      })
    }
    res.json({
      total: bindings.length,
      mode: config.qwenClientProfileMode || 'current',
      experiment: !!(config.qwenClientProfileExperiment || false),
      bindings
    })
  } catch (e) {
    logger.error('qwen-profiles 查询失败', 'PROFILE', '', e)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/qwen-profile-experiment
// 设置 profile 实验模式（运行时只读，需重启生效）
// body: { mode: 'current' | 'stable-per-account', experiment: true | false }
router.post('/qwen-profile-experiment', adminKeyVerify, async (req, res) => {
  try {
    const { mode, experiment } = req.body || {}
    if (mode !== undefined && !['current', 'stable-per-account'].includes(mode)) {
      return res.status(400).json({ error: 'Invalid mode. Use "current" or "stable-per-account"' })
    }
    if (experiment !== undefined && typeof experiment !== 'boolean') {
      return res.status(400).json({ error: 'Invalid experiment flag. Must be boolean' })
    }
    // 环境变量无法运行时修改，返回当前状态提示需重启
    res.json({
      accepted: { mode, experiment },
      current: {
        mode: config.qwenClientProfileMode || 'current',
        experiment: !!(config.qwenClientProfileExperiment || false)
      },
      note: 'Changes require service restart to take effect (set QWEN_CLIENT_PROFILE_MODE / QWEN_CLIENT_PROFILE_EXPERIMENT env vars)'
    })
  } catch (e) {
    logger.error('qwen-profile-experiment 设置失败', 'PROFILE', '', e)
    res.status(500).json({ error: e.message })
  }
})

// GET /api/qwen-profile-consistency
// 验证所有账号的 profile 内部一致性（UA Chrome 版本 = sec-ch-ua Chromium 版本等）
router.get('/qwen-profile-consistency', adminKeyVerify, async (req, res) => {
  try {
    const { assignProfileToAccount, validateProfileConsistency } = require('../backends/qwen/client-profile.js')
    const accounts = accountManager.accountTokens || []
    const results = []
    for (const account of accounts) {
      if (!account || !account.email) {
        results.push({ email: null, status: 'no-email' })
        continue
      }
      assignProfileToAccount(account)
      const profile = account.clientProfile
      if (!profile) {
        // mode=current 或分配失败时无 profile，不算 invalid
        results.push({ email: account.email, status: 'no-profile' })
        continue
      }
      try {
        validateProfileConsistency(profile)
        results.push({
          email: account.email,
          profileId: profile._profileId || null,
          status: 'valid'
        })
      } catch (e) {
        results.push({
          email: account.email,
          profileId: profile._profileId || null,
          status: 'invalid',
          error: e.message
        })
      }
    }
    const valid = results.filter(r => r.status === 'valid').length
    const invalid = results.filter(r => r.status === 'invalid').length
    const noProfile = results.filter(r => r.status === 'no-profile').length
    res.json({
      total: results.length,
      valid,
      invalid,
      noProfile,
      mode: config.qwenClientProfileMode || 'current',
      results
    })
  } catch (e) {
    logger.error('qwen-profile-consistency 校验失败', 'PROFILE', '', e)
    res.status(500).json({ error: e.message })
  }
})

// GET /api/qwen-scheduler-status
// 实时查看所有账号的调度状态（忙闲、冷却、评分）
router.get('/qwen-scheduler-status', adminKeyVerify, async (req, res) => {
  try {
    const scheduler = require('../backends/qwen/scheduler-singleton')
    const sched = scheduler.getScheduler()
    if (!sched) {
      return res.json({ status: 'not_initialized', accounts: [] })
    }
    const snapshot = sched.getSnapshot()
    const accounts = []
    for (const [accountId, rt] of sched.accounts) {
      const inFlight = sched._accountInFlight.get(accountId) || 0
      const cooldownRemaining = rt.cooldownRemainingMs || 0
      const stats = rt.requestStats || {}
      const totalReqs = stats.total || 0
      const successRate = totalReqs > 0 ? (stats.success || 0) / totalReqs : 0.5
      const cooldownPenalty = cooldownRemaining ? Math.floor(cooldownRemaining / 100) : 0

      // Compute score same as _trySelectAccount (inFlight is binary filter, not score penalty)
      let score = 100
      score -= cooldownPenalty
      score -= (rt.failureState?.count || 0) * 30
      score += Math.round(successRate * 30)

      accounts.push({
        accountId,
        email: rt.credentials?.email || 'unknown',
        inFlight,
        maxConcurrency: sched.maxConcurrencyPerAccount,
        status: cooldownRemaining > 0 ? 'cooldown'
              : inFlight >= sched.maxConcurrencyPerAccount ? 'busy'
              : inFlight > 0 ? 'partial'
              : 'idle',
        score: Math.max(0, score),
        cooldownRemainingMs: cooldownRemaining,
        successRate: Math.round(successRate * 100),
        stats: { ...stats },
        cooldownUntil: rt.cooldownUntil || 0
      })
    }
    res.json({
      globalInFlight: snapshot.globalInFlight,
      globalMaxConcurrency: snapshot.globalMaxConcurrency,
      queueDepth: snapshot.queueDepth,
      maxQueueSize: snapshot.maxQueueSize,
      roundRobinCursor: sched._roundRobinCursor,
      totalAccounts: accounts.length,
      byStatus: {
        idle: accounts.filter(a => a.status === 'idle').length,
        partial: accounts.filter(a => a.status === 'partial').length,
        busy: accounts.filter(a => a.status === 'busy').length,
        cooldown: accounts.filter(a => a.status === 'cooldown').length
      },
      accounts
    })
  } catch (e) {
    logger.error('qwen-scheduler-status 获取失败', 'SCHEDULER', '', e)
    res.status(500).json({ error: e.message })
  }
})

// GET /api/scheduler-status
// 全网关统一调度遥测接口：支持 provider 参数（'deepseek' | 'qwen' | 'all'），默认聚合两家
router.get('/scheduler-status', adminKeyVerify, async (req, res) => {
  try {
    const providerParam = (req.query.provider || 'all').toLowerCase()
    const schedulerRegistry = require('../shared/provider-scheduler-registry')
    const schedulers = []

    if (providerParam === 'qwen' || providerParam === 'all') {
      const qwenScheduler = require('../backends/qwen/scheduler-singleton').getScheduler()
      if (qwenScheduler) schedulers.push({ id: 'qwen', sched: qwenScheduler })
    }
    if (providerParam === 'deepseek' || providerParam === 'all') {
      const dpskScheduler = schedulerRegistry.get('deepseek')
      if (dpskScheduler) schedulers.push({ id: 'deepseek', sched: dpskScheduler })
    }

    const providersData = {}
    let totalAccountsCount = 0
    let totalInFlightCount = 0
    let totalQueueCount = 0
    const aggregateByStatus = { idle: 0, partial: 0, busy: 0, cooldown: 0 }

    for (const { id, sched } of schedulers) {
      const snapshot = sched.getSnapshot()
      const accounts = []
      for (const [accountId, rt] of sched.accounts) {
        const inFlight = sched._accountInFlight.get(accountId) || 0
        const cooldownRemaining = rt.cooldownRemainingMs || 0
        const stats = rt.requestStats || {}
        const totalReqs = stats.total || 0
        const successRate = totalReqs > 0 ? (stats.success || 0) / totalReqs : 0.5
        const cooldownPenalty = cooldownRemaining ? Math.floor(cooldownRemaining / 100) : 0
        let score = 100 - cooldownPenalty - ((rt.failureState?.count || 0) * 30) + Math.round(successRate * 30)

        const status = cooldownRemaining > 0 ? 'cooldown'
          : inFlight >= sched.maxConcurrencyPerAccount ? 'busy'
          : inFlight > 0 ? 'partial'
          : 'idle'

        accounts.push({
          accountId,
          email: rt.credentials?.email || rt.email || 'unknown',
          inFlight,
          maxConcurrency: sched.maxConcurrencyPerAccount,
          status,
          score: Math.max(0, score),
          cooldownRemainingMs: cooldownRemaining,
          successRate: Math.round(successRate * 100),
          stats: { ...stats },
          cooldownUntil: rt.cooldownUntil || 0
        })
      }

      const byStatus = {
        idle: accounts.filter(a => a.status === 'idle').length,
        partial: accounts.filter(a => a.status === 'partial').length,
        busy: accounts.filter(a => a.status === 'busy').length,
        cooldown: accounts.filter(a => a.status === 'cooldown').length
      }

      totalAccountsCount += accounts.length
      totalInFlightCount += snapshot.globalInFlight
      totalQueueCount += snapshot.queueDepth
      aggregateByStatus.idle += byStatus.idle
      aggregateByStatus.partial += byStatus.partial
      aggregateByStatus.busy += byStatus.busy
      aggregateByStatus.cooldown += byStatus.cooldown

      providersData[id] = {
        globalInFlight: snapshot.globalInFlight,
        globalMaxConcurrency: snapshot.globalMaxConcurrency,
        queueDepth: snapshot.queueDepth,
        maxQueueSize: snapshot.maxQueueSize,
        roundRobinCursor: sched._roundRobinCursor,
        totalAccounts: accounts.length,
        byStatus,
        accounts
      }
    }

    res.json({
      status: true,
      timestamp: Date.now(),
      summary: {
        totalAccounts: totalAccountsCount,
        totalInFlight: totalInFlightCount,
        totalQueue: totalQueueCount,
        byStatus: aggregateByStatus
      },
      providers: providersData
    })
  } catch (e) {
    logger.error('scheduler-status 获取失败', 'SCHEDULER', '', e)
    res.status(500).json({ error: e.message })
  }
})

// ==========================================
// CPA 统一配置中枢接口 (GET /api/config & POST /api/config)
// ==========================================

// 敏感字段掩码辅助函数
const maskSecret = (val) => {
  if (typeof val !== 'string' || val.length === 0) return val
  if (val.length <= 8) return '********'
  return `${val.slice(0, 4)}***${val.slice(-4)}`
}

// GET /api/config — 对标 CPA 的统一配置获取接口
router.get('/config', adminKeyVerify, async (req, res) => {
  try {
    const includeSecrets = req.query.include_secrets === 'true'
    const view = req.query.view || 'categorized'
    const persistedData = configManager.readConfig()

    // 7 大分类领域全景装配
    const categorized = {
      system: {
        listenPort: config.port,
        proxyUrl: config.proxyUrl || null,
        dataSaveMode: config.dataSaveMode,
        redisURL: includeSecrets ? config.redisURL : maskSecret(config.redisURL)
      },
      security: {
        adminKey: includeSecrets ? config.adminKey : maskSecret(config.adminKey),
        apiKeys: includeSecrets ? config.apiKeys : (config.apiKeys || []).map(maskSecret)
      },
      scheduler: {
        dpskRoutingStrategy: config.dpskRoutingStrategy || 'round-robin',
        dpskMaxConcurrencyPerAccount: config.dpskMaxConcurrencyPerAccount,
        dpskGlobalMaxConcurrency: config.dpskGlobalMaxConcurrency,
        dpskMaxQueueSize: config.dpskMaxQueueSize,
        dpskQueueTimeoutMs: config.dpskQueueTimeoutMs,
        sessionStickyMs: config.sessionStickyMs
      },
      provider_qwen: {
        qwenChatProxyUrl: config.qwenChatProxyUrl,
        qwenNetworkMode: config.qwenNetworkMode,
        qwenClientProfileMode: config.qwenClientProfileMode,
        qwenMaxAccountAttempts: config.qwenMaxAccountAttempts,
        chatIdPrewarm: config.chatIdPrewarm,
        chatIdPoolSize: config.chatIdPoolSize
      },
      provider_deepseek: {
        dpskThinkEffort: config.dpskThinkEffort,
        dpskEnableToolHistoryCompression: config.dpskEnableToolHistoryCompression,
        dpskEnableSessionContinuity: config.dpskEnableSessionContinuity,
        dpskSessionAffinity: config.dpskSessionAffinity
      },
      stream_and_retry: {
        chatRetryCount: config.chatRetryCount,
        chatRetryBackoffMs: config.chatRetryBackoffMs,
        dpskStreamTimeoutMs: config.dpskStreamTimeoutMs,
        outThink: config.outThink,
        simpleModelMap: config.simpleModelMap,
        searchInfoMode: config.searchInfoMode
      },
      logging_and_sidecar: {
        logLevel: config.logLevel || 'INFO',
        tlsSidecarEnabled: config.tlsSidecarEnabled,
        tlsSidecarPort: config.tlsSidecarPort,
        autoRefresh: config.autoRefresh,
        autoRefreshInterval: config.autoRefreshInterval,
        batchLoginConcurrency: config.batchLoginConcurrency
      }
    }

    if (view === 'flat') {
      const flat = {}
      for (const [_, sub] of Object.entries(categorized)) {
        Object.assign(flat, sub)
      }
      return res.json({ status: true, code: 200, data: flat, persisted: persistedData })
    }

    res.json({
      status: true,
      code: 200,
      data: categorized,
      meta: {
        persistenceFilePath: configManager.filePath,
        persistedKeysCount: Object.keys(persistedData).length,
        isSecretsMasked: !includeSecrets
      }
    })
  } catch (e) {
    logger.error('获取统一配置失败', 'CONFIG', '', e)
    res.status(500).json({ error: e.message })
  }
})

// POST /api/config — 对标 CPA 的统一配置热同步与原子落盘接口
router.post('/config', adminKeyVerify, async (req, res) => {
  try {
    let payload = req.body || {}
    // 支持 categorized 嵌套格式自动压平
    let flatUpdates = {}
    for (const [k, v] of Object.entries(payload)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        Object.assign(flatUpdates, v)
      } else {
        flatUpdates[k] = v
      }
    }

    // 过滤与安全校验
    const allowedKeys = [
      'dpskRoutingStrategy', 'dpskMaxConcurrencyPerAccount', 'dpskGlobalMaxConcurrency',
      'dpskMaxQueueSize', 'dpskQueueTimeoutMs', 'dpskThinkEffort',
      'dpskEnableToolHistoryCompression', 'dpskEnableSessionContinuity', 'dpskSessionAffinity',
      'chatRetryCount', 'chatRetryBackoffMs', 'outThink', 'simpleModelMap', 'searchInfoMode',
      'autoRefresh', 'autoRefreshInterval', 'batchLoginConcurrency',
      'tlsSidecarEnabled', 'tlsSidecarPort', 'apiKeys'
    ]

    const validatedUpdates = {}
    for (const key of allowedKeys) {
      if (flatUpdates[key] !== undefined) {
        validatedUpdates[key] = flatUpdates[key]
      }
    }

    if (Object.keys(validatedUpdates).length === 0) {
      return res.status(400).json({ error: '没有提供可热更新的有效配置项' })
    }

    // 原子持久化并原地热同步到 live config 单例
    const saveResult = configManager.saveConfig(validatedUpdates, config)

    // 副作用热重载联动
    if (validatedUpdates.autoRefresh !== undefined || validatedUpdates.autoRefreshInterval !== undefined) {
      try {
        accountManager.startAutoRefresh()
        dpskAccount.startAutoRefresh()
      } catch (err) {
        logger.warn('重启自动刷新定时器失败', 'CONFIG', '', err)
      }
    }

    if (validatedUpdates.tlsSidecarEnabled !== undefined || validatedUpdates.tlsSidecarPort !== undefined) {
      try {
        await refreshSidecarStatus()
      } catch (err) {
        logger.warn('刷新 TLS Sidecar 失败', 'CONFIG', '', err)
      }
    }

    logger.info(
      `[Config] 成功热生效 ${Object.keys(validatedUpdates).length} 个配置项并原子持久化`,
      'CONFIG',
      '⚙️'
    )

    res.json({
      status: true,
      code: 200,
      message: '配置已成功保存并实时热生效',
      updatedKeys: Object.keys(validatedUpdates),
      persisted: saveResult.success
    })
  } catch (e) {
    logger.error('统一配置更新失败', 'CONFIG', '', e)
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
