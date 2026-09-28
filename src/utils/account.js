const config = require('../config/index.js')
const DataPersistence = require('./data-persistence')
const { sha256Encrypt, JwtDecode } = require('./tools')
const { getProxyAgent, getChatBaseUrl } = require('./proxy-helper')
const { buildQwenHeaders } = require('../providers/qwen-web/headers')
const { assignProfileToAccount, assignAllProfiles } = require('../backends/qwen/client-profile')
const { AccountRuntime } = require('../backends/qwen/account-runtime')
// Note: scheduler-singleton is lazy-required inside methods to avoid a circular
// dependency (scheduler-singleton.js top-level requires account.js).

/**
 * 内联 TokenManager — 替代已删除的 src/utils/token-manager.js
 * 提供 JWT token 的登录、验证、刷新、健康统计等功能。
 */
class TokenManager {
    constructor() {
        this.defaultHeaders = buildQwenHeaders({
            baseUrl: getChatBaseUrl(),
            includeCookie: false,
            includeTokenCookie: false,
            includeWarmupCookies: false
        })
    }

    get loginEndpoint() {
        return `${getChatBaseUrl()}/api/v1/auths/signin`
    }

    async login(email, password, account) {
        try {
            const axios = require('axios')
            const proxyAgent = getProxyAgent(account)
            const requestConfig = {
                headers: this.defaultHeaders,
                timeout: 10000
            }
            if (proxyAgent) {
                requestConfig.httpsAgent = proxyAgent
                requestConfig.proxy = false
            }
            const response = await axios.post(this.loginEndpoint, {
                email: email,
                password: sha256Encrypt(password)
            }, requestConfig)
            if (response.data && response.data.token) {
                return response.data.token
            }
            return null
        } catch (error) {
            logger.error(`${email} 登录失败`, 'AUTH', '', error)
            return null
        }
    }

    validateToken(token) {
        try {
            if (!token) return null
            const decoded = JwtDecode(token)
            if (!decoded || !decoded.exp) return null
            const now = Math.floor(Date.now() / 1000)
            if (decoded.exp <= now) return null
            return decoded
        } catch (error) {
            return null
        }
    }

    isTokenExpiringSoon(token, thresholdHours = 6) {
        const decoded = this.validateToken(token)
        if (!decoded) return true
        const now = Math.floor(Date.now() / 1000)
        const thresholdSeconds = thresholdHours * 60 * 60
        return decoded.exp - now < thresholdSeconds
    }

    async refreshToken(account) {
        try {
            const newToken = await this.login(account.email, account.password, account)
            if (!newToken) return null
            const decoded = this.validateToken(newToken)
            if (!decoded) return null
            return { ...account, token: newToken, expires: decoded.exp }
        } catch (error) {
            logger.error(`刷新令牌失败 (${account.email})`, 'TOKEN', '', error)
            return null
        }
    }

    getTokenHealthStats(accounts) {
        const stats = { total: accounts.length, valid: 0, expired: 0, expiringSoon: 0, invalid: 0 }
        accounts.forEach(account => {
            if (!account.token) { stats.invalid++; return }
            const decoded = this.validateToken(account.token)
            if (!decoded) { stats.invalid++; return }
            const now = Math.floor(Date.now() / 1000)
            if (decoded.exp <= now) { stats.expired++ }
            else if (this.isTokenExpiringSoon(account.token, 6)) { stats.expiringSoon++ }
            else { stats.valid++ }
        })
        return stats
    }
}
const AccountRotator = require('./account-rotator')
const { logger } = require('./logger')

/**
 * 默认 daily stats 结构。返回新对象，调用方安全修改
 * @returns {Object} default stats
 */
const CHAT_STATS_FIELDS = [
    'input',
    'output',
    'requests',
    'blockedRequests',
    'upstreamInput',
    'upstreamOutput',
    'estimatedInput',
    'estimatedOutput',
    'retryInput',
    'retryOutput'
]

const createDefaultChatStats = () => CHAT_STATS_FIELDS.reduce((acc, field) => {
    acc[field] = 0
    return acc
}, {})

const createDefaultStats = () => ({
    chat: createDefaultChatStats()
})

/**
 * 保证账户具备 stats 和 statsHistory 字段（兼容老 qwen-data.json/Redis 数据）
 * @param {Object} account - 账户对象
 */
const ensureStats = (account) => {
    if (!account) return
    if (!account.stats || typeof account.stats !== 'object') {
        account.stats = createDefaultStats()
    } else {
        if (!account.stats.chat || typeof account.stats.chat !== 'object') {
            account.stats.chat = createDefaultChatStats()
        } else {
            for (const field of CHAT_STATS_FIELDS) {
                account.stats.chat[field] = Number(account.stats.chat[field]) || 0
            }
        }
        // Backward-compat: ensure breakdown buckets always exist.
        if (!account.stats.chat.byProvider || typeof account.stats.chat.byProvider !== 'object') {
            account.stats.chat.byProvider = {}
        }
        if (!account.stats.chat.byModel || typeof account.stats.chat.byModel !== 'object') {
            account.stats.chat.byModel = {}
        }
    }
    // statsHistory: { 'YYYY-MM-DD': { chat:{input,output, byProvider, byModel} } }
    // Backward-compat: legacy records without the field — initialize to {}
    if (!account.statsHistory || typeof account.statsHistory !== 'object') {
        account.statsHistory = {}
    }
}

/**
 * YYYY-MM-DD date key for (now + offsetDays) in Node process local TZ
 * @param {number} offsetDays - day offset (negative = past)
 * @returns {string}
 */
const _formatDateKey = (offsetDays) => {
    const d = new Date()
    d.setDate(d.getDate() + offsetDays)
    const yyyy = d.getFullYear()
    const mm = String(d.getMonth() + 1).padStart(2, '0')
    const dd = String(d.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}`
}

const _getTodayKey = () => _formatDateKey(0)
const _getYesterdayKey = () => _formatDateKey(-1)
const _dateKeyDaysAgo = (n) => _formatDateKey(-n)

const _hasNonZeroStats = (stats) => {
    if (!stats || typeof stats !== 'object') return false
    const c = stats.chat || {}
    if (CHAT_STATS_FIELDS.some(field => (Number(c[field]) || 0) > 0)) return true
    // Include provider / model breakdown so days with only model-level activity
    // are still archived.
    if (_hasNonZeroProviderOrModel(c)) return true
    return false
}

const _hasNonZeroProviderOrModel = (chat) => {
    if (!chat || typeof chat !== 'object') return false
    const prov = chat.byProvider
    if (prov && typeof prov === 'object') {
        for (const p of Object.values(prov)) {
            if (Number(p?.input) > 0 || Number(p?.output) > 0 || Number(p?.requests) > 0) return true
        }
    }
    const bym = chat.byModel
    if (bym && typeof bym === 'object') {
        for (const m of Object.values(bym)) {
            if (Number(m?.input) > 0 || Number(m?.output) > 0 || Number(m?.requests) > 0) return true
        }
    }
    return false
}

/**
 * Normalize a model id to its "base" form by stripping the trailing variant
 * suffixes the upstream Qwen / DeepSeek providers attach (e.g.
 * `qwen3.7-max-thinking` -> `qwen3.7-max`, `qwen3-coder-plus-search` ->
 * `qwen3-coder-plus`, `deepseek-chat-thinking` -> `deepseek-chat`).
 *
 * Important: callers rely on this for stats aggregation, so it must be
 * deterministic and never throw.
 */
const BASE_MODEL_SUFFIX_RE = /-(?:thinking|search|image|video|images|videos|tts|asr|ocr|coding|coder|vision|reasoning)$/i
const normalizeBaseModel = (model) => {
    if (typeof model !== 'string' || !model) return ''
    return model.replace(BASE_MODEL_SUFFIX_RE, '')
}

const VALID_PROVIDERS = ['qwen', 'dpsk']
const normalizeProvider = (p) => {
    if (p === 'dpsk' || p === 'deepseek') return 'dpsk'
    if (p === 'qwen') return 'qwen'
    return ''
}

const STATS_HISTORY_RETENTION_DAYS = 90
/**
 * 账户管理器
 * 统一管理账户、令牌、模型等功能
 */
class Account {
    constructor() {
        // 初始化各个管理器
        this.dataPersistence = new DataPersistence()
        this.tokenManager = new TokenManager()
        this.accountRotator = new AccountRotator()

        // 账户数据
        this.accountTokens = []
        this.isInitialized = false

        // Phase D2: per-account runtime state.
        // accountRuntimes: Map<accountId, AccountRuntime>
        // _runtimeByEmail: Map<email, AccountRuntime> — fast lookup for recordAccountFailure
        this.accountRuntimes = new Map()
        this._runtimeByEmail = new Map()

        // 配置信息
        this.defaultHeaders = config.defaultHeaders || {}

        // Keep the init promise so debug methods can await readiness
        this._initPromise = this._initialize()
    }

    /**
     * 异步初始化
     * @private
     */
    async _initialize() {
        try {
            // 加载账户信息
            await this.loadAccountTokens()

            // 同一入口也会在 Web 设置保存或启动时恢复配置后调用。
            this.startAutoRefresh()

            this.isInitialized = true

            // Phase D2: build AccountRuntime per account and register to QwenScheduler.
            // Must run AFTER isInitialized=true so schedulerSingleton.getScheduler()
            // can return a scheduler instance.
            this._buildAccountRuntimes()

            logger.success(`账户管理器初始化完成，共加载 ${this.accountTokens.length} 个账户`, 'ACCOUNT')
        } catch (error) {
            this.isInitialized = false
            logger.error('账户管理器初始化失败', 'ACCOUNT', '', error)
        }
    }

    /**
     * Phase D2: 为已加载的账户构建 AccountRuntime 实例并注册到 QwenScheduler 单例。
     *
     * 在 loadAccountTokens() 完成（含 token 校验/清理、profile 分配）之后调用，
     * 保证 accountTokens 已最终稳定。后续 addAccount / addAccountWithToken
     * 新增账号时单独构建并注册（见 _registerRuntimeForAccount）。
     *
     * scheduler-singleton 是 lazy-required 以避免循环依赖
     *（scheduler-singleton.js 顶层 require account.js）。
     *
     * @private
     */
    _buildAccountRuntimes() {
        this.accountRuntimes = new Map()
        this._runtimeByEmail = new Map()

        let schedulerSingleton = null
        try {
            schedulerSingleton = require('../backends/qwen/scheduler-singleton')
        } catch (error) {
            logger.error('Failed to load scheduler-singleton module', 'ACCOUNT', '', error)
        }

        for (const account of this.accountTokens) {
            if (!account || !account.email || !account.token) continue
            const runtime = new AccountRuntime(account)
            this.accountRuntimes.set(runtime.accountId, runtime)
            this._runtimeByEmail.set(account.email, runtime)

            if (schedulerSingleton && typeof schedulerSingleton.registerAccount === 'function') {
                try {
                    schedulerSingleton.registerAccount(runtime)
                } catch (error) {
                    logger.error(
                        `Failed to register AccountRuntime for ${account.email}`,
                        'ACCOUNT', '', error
                    )
                }
            }
        }

        logger.info(
            `[Phase D2] Built ${this.accountRuntimes.size} AccountRuntime instances ` +
            `(accountTokens=${this.accountTokens.length})`,
            'ACCOUNT'
        )
    }

    /**
     * Phase D2 helper: 为单个账号构建并注册 AccountRuntime。
     * 用于 addAccount / addAccountWithToken 在新增账号时同步运行时状态。
     * @param {Object} account - 刚添加到 accountTokens 的账号对象
     * @private
     */
    _registerRuntimeForAccount(account) {
        if (!account || !account.email || !account.token) return
        const runtime = new AccountRuntime(account)
        this.accountRuntimes.set(runtime.accountId, runtime)
        this._runtimeByEmail.set(account.email, runtime)

        try {
            const schedulerSingleton = require('../backends/qwen/scheduler-singleton')
            if (typeof schedulerSingleton.registerAccount === 'function') {
                schedulerSingleton.registerAccount(runtime)
            }
        } catch (error) {
            logger.error(
                `Failed to register AccountRuntime for ${account.email}`,
                'ACCOUNT', '', error
            )
        }
    }

    /**
     * 紧急救火：等待账号管理器初始化完成
     * - 上层调用方（如 /v1/models、parserModel）在使用账号前应该 await 此方法
     *   避免 "accountManager.getAccount() 返回 null" 的隐性失败
     * - 如果初始化已经在跑：复用同一个 Promise（不会并发触发多份初始化）
     * - 如果已经初始化完成：立即 resolve
     * - 如果初始化失败：仍然 resolve，但会返回当前 isInitialized 状态——调用方
     *   必须自行根据 isInitialized / accountTokens.length 判定
     * @param {number} [timeoutMs=10000] - 最长等待时间（毫秒）；超时后强制 resolve
     * @returns {Promise<{ready: boolean, count: number}>}
     */
    async waitUntilReady(timeoutMs = 10000) {
        if (this.isInitialized) {
            return { ready: true, count: this.accountTokens.length }
        }
        if (!this._initPromise) {
            // 极端兜底：构造时未创建 _initPromise；补一个
            this._initPromise = this._initialize()
        }
        let timeoutHandle = null
        const timeoutPromise = new Promise((resolve) => {
            timeoutHandle = setTimeout(() => resolve(false), Math.max(0, timeoutMs))
        })
        try {
            const initialized = await Promise.race([
                this._initPromise.then(() => true),
                timeoutPromise
            ])
            if (timeoutHandle) clearTimeout(timeoutHandle)
            return { ready: !!initialized && this.isInitialized, count: this.accountTokens.length }
        } catch (_) {
            if (timeoutHandle) clearTimeout(timeoutHandle)
            return { ready: false, count: this.accountTokens.length }
        }
    }

    startAutoRefresh() {
        this.stopAutoRefresh()
        if (!config.autoRefresh) return
        const intervalMs = (config.autoRefreshInterval || 21600) * 1000
        this.refreshInterval = setInterval(() => {
            this.autoRefreshTokens().catch(error => {
                logger.error('Qwen 自动刷新任务异常', 'ACCOUNT', '', error)
            })
        }, intervalMs)
        logger.info(`Qwen 自动刷新已启动，间隔 ${intervalMs / 1000}s`, 'ACCOUNT')
    }

    stopAutoRefresh() {
        if (!this.refreshInterval) return
        clearInterval(this.refreshInterval)
        this.refreshInterval = null
    }

    /**
     * 加载账户令牌数据
     * @returns {Promise<void>}
     */
    async loadAccountTokens() {
        try {
            // 紧急救火：脱敏的诊断日志——不打印 token / cookie / 邮箱完整地址 / 密码
            try {
                const fs = require('fs')
                const path = require('path')
                const dataFilePath = path.join(__dirname, '../../data/qwen-data.json')
                let dataFileExists = false
                let dataFileAccounts = 0
                try {
                    dataFileExists = fs.existsSync(dataFilePath)
                    if (dataFileExists) {
                        const raw = fs.readFileSync(dataFilePath, 'utf-8')
                        const parsed = JSON.parse(raw)
                        dataFileAccounts = Array.isArray(parsed.accounts) ? parsed.accounts.length : 0
                    }
                } catch (_) { /* ignore */ }

                // REDIS_URL 脱敏摘要
                let redisSummary = 'unset'
                if (config.redisURL) {
                    const url = String(config.redisURL)
                    // 仅保留 host:port（剥掉 protocol / userinfo / path / query）
                    const m = url.match(/^(?:rediss?:\/\/)?(?:[^@/]+@)?([^/?#]+)(?:\/.*)?$/)
                    redisSummary = m ? `set[host=${m[1]}]` : 'set[masked]'
                }

                const envAccountRaw = process.env.ACCOUNTS || ''
                const envAccounts = envAccountRaw ? envAccountRaw.split(',').filter(s => s && s.includes('@')).length : 0

                logger.info(
                    `[DIAG] ACCOUNT_LOAD: dataSaveMode=${config.dataSaveMode} redisURL=${redisSummary} ` +
                    `envAccounts=${envAccounts} dataFileExists=${dataFileExists} ` +
                    `dataFileAccounts=${dataFileAccounts} fallback=${config.accountLoadFallback}`,
                    'ACCOUNT'
                )
            } catch (_) { /* 诊断日志失败不影响主流程 */ }

            this.accountTokens = await this.dataPersistence.loadAccounts()

            // 兼容历史数据：旧 qwen-data.json/Redis 没有 stats 字段
            this.accountTokens.forEach(ensureStats)

            // 每账号分配固定 client profile（UA / 语言 / 时区）
            // 基于 email 确定性哈希，同一账号始终相同，新增账号自动适配
            assignAllProfiles(this)

            // 统计有 token 的账号数量
            const withTokenCount = this.accountTokens.filter(a => a && a.token).length

            // 紧急救火：账号加载结果摘要（脱敏）
            logger.info(
                `[DIAG] ACCOUNT_LOADED: total=${this.accountTokens.length} withToken=${withTokenCount}`,
                'ACCOUNT'
            )

            // 如果是环境变量模式，需要进行登录获取令牌
            if (config.dataSaveMode === 'none' && this.accountTokens.length > 0) {
                await this._loginEnvironmentAccounts()
            }

            // 验证和清理无效令牌
            await this._validateAndCleanTokens()

            // 更新账户轮询器
            this.accountRotator.setAccounts(this.accountTokens)

            // 设置每日 stats 重置定时器
            this._setupDailyResetTimer()

            logger.success(`成功加载 ${this.accountTokens.length} 个账户`, 'ACCOUNT')

            // 紧急救火：账号为 0 时明确警告——便于诊断 Redis / qwen-data.json / ACCOUNTS 哪个出问题
            if (this.accountTokens.length === 0) {
                logger.error(
                    '[DIAG] 未加载到任何账号，请检查 DATA_SAVE_MODE / REDIS_URL / ACCOUNTS / qwen-data.json ' +
                    `当前 dataSaveMode=${config.dataSaveMode} accountLoadFallback=${config.accountLoadFallback}`,
                    'ACCOUNT'
                )
            }
        } catch (error) {
            logger.error('加载账户令牌失败', 'ACCOUNT', '', error)
            this.accountTokens = []
            this.accountRotator.setAccounts(this.accountTokens)
            throw error
        }
    }

    /**
     * 为环境变量模式的账户进行登录
     * @private
     */
    async _loginEnvironmentAccounts() {
        const loginPromises = this.accountTokens.map(async (account) => {
            if (!account.token && account.email && account.password) {
                const token = await this.tokenManager.login(account.email, account.password, account)
                if (token) {
                    const decoded = this.tokenManager.validateToken(token)
                    if (decoded) {
                        account.token = token
                        account.expires = decoded.exp
                    }
                }
            }
            return account
        })

        this.accountTokens = await Promise.all(loginPromises)
    }

    /**
     * 设置每日重置定时器
     * @private
     */
    _setupDailyResetTimer() {
        logger.info('设置每日 00:00 重置定时器（daily stats）', 'STATS')

        // 计算到下一天00:00:00的毫秒数
        const now = new Date()
        const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0)
        const timeDiff = tomorrow.getTime() - now.getTime()

        logger.info(`距离下次重置还有 ${Math.round(timeDiff / 1000 / 60)} 分钟`, 'STATS')

        // 首次执行使用setTimeout
        this.dailyResetTimeout = setTimeout(() => {
            this._resetDailyCounters()

            // 设置每24小时执行一次的定时器
            this.dailyResetInterval = setInterval(() => {
                this._resetDailyCounters()
            }, 24 * 60 * 60 * 1000)
            this.dailyResetInterval.unref()
        }, timeDiff)
        this.dailyResetTimeout.unref()
    }

    /**
     * Daily 00:00 reset: chat daily stats.
     * Before zeroing, snapshot yesterday into account.statsHistory and prune
     * entries older than STATS_HISTORY_RETENTION_DAYS days, then a single
     * saveAllAccounts batch (instead of 30 individual saves).
     *
     * Caveats:
     * - PM2_INSTANCES > 1: each worker archives its own partial copy of stats;
     *   the daily total would be under-reported proportionally to the worker
     *   count. With instances=1 (ecosystem.config.js default) this is not
     *   triggered.
     * - DATA_SAVE_MODE=none: saveAllAccounts returns false and history is not
     *   persisted. Set DATA_SAVE_MODE=file or redis to enable the feature.
     * @private
     */
    async _resetDailyCounters() {
        const yesterday = _getYesterdayKey()
        const cutoff = _dateKeyDaysAgo(STATS_HISTORY_RETENTION_DAYS)
        let archivedCount = 0

        // For every account (including inactive ones) prune old history;
        // for accounts with any non-zero counters, snapshot yesterday.
        this.accountTokens.forEach(account => {
            ensureStats(account)

            // Date-based pruning (string compare is valid for YYYY-MM-DD).
            for (const key of Object.keys(account.statsHistory)) {
                if (key < cutoff) {
                    delete account.statsHistory[key]
                }
            }

            // Snapshot only if there was at least one non-zero counter.
            if (_hasNonZeroStats(account.stats)) {
                account.statsHistory[yesterday] = {
                    chat: { ...account.stats.chat }
                }
                archivedCount++
            }

            // Reset today.
            for (const field of CHAT_STATS_FIELDS) {
                account.stats.chat[field] = 0
            }
            // Reset byProvider / byModel breakdown for the new day.
            account.stats.chat.byProvider = {}
            account.stats.chat.byModel = {}
        })

        logger.info(
            `已重置 ${this.accountTokens.length} 个账户 daily stats，归档 ${archivedCount} 条 statsHistory[${yesterday}]`,
            'STATS'
        )

        // Single batch save. In file mode — one qwen-data.json rewrite; in redis
        // mode — sequential HSETs (the saveAccountStats debounce is not used).
        try {
            await this.dataPersistence.saveAllAccounts(this.accountTokens)
        } catch (error) {
            logger.error('每日重置后 persist 失败', 'ACCOUNT', '', error)
        }
    }

    /**
     * Public helper: today's YYYY-MM-DD key in Node process local TZ.
     * Paired with the _getYesterdayKey used inside _resetDailyCounters.
     * The /statsHistory route must use this rather than new Date() in the
     * browser — otherwise differing browser/container TZs can shift month
     * boundaries.
     * @returns {string}
     */
    getTodayKey() {
        return _getTodayKey()
    }

    /**
     * Debug: manual trigger for archive/reset (used by the dev endpoint).
     * The readiness guard prevents wiping data.accounts = [] before init finishes.
     * @returns {Promise<void>}
     */
    async archiveYesterdayForTest() {
        if (this._initPromise) {
            await this._initPromise
        }
        if (!this.isInitialized || !Array.isArray(this.accountTokens) || this.accountTokens.length === 0) {
            throw new Error('account manager not initialized — refusing to archive (would wipe data)')
        }
        return this._resetDailyCounters()
    }

    /**
     * 验证和清理无效令牌
     * @private
     */
    async _validateAndCleanTokens() {
        const validAccounts = []

        for (const account of this.accountTokens) {
            if (account.token && this.tokenManager.validateToken(account.token)) {
                validAccounts.push(account)
            } else if (account.email && account.password) {
                // 尝试重新登录
                logger.info(`令牌无效，尝试重新登录: ${account.email}`, 'TOKEN', '🔄')
                const newToken = await this.tokenManager.login(account.email, account.password, account)
                if (newToken) {
                    const decoded = this.tokenManager.validateToken(newToken)
                    if (decoded) {
                        account.token = newToken
                        account.expires = decoded.exp
                        validAccounts.push(account)

                        // 关键修复：重新登录成功后立即固化到持久化存储，
                        // 避免下次启动仍使用旧过期 token
                        try {
                            await this.dataPersistence.saveAccount(account.email, {
                                password: account.password,
                                token: account.token,
                                expires: account.expires,
                                proxy: account.proxy ?? null
                            })
                            logger.info(`令牌已重新登录并固化: ${account.email}`, 'TOKEN', '💾')
                        } catch (saveErr) {
                            logger.error(`令牌重新登录后固化失败 (${account.email})`, 'TOKEN', '', saveErr)
                        }
                    }
                }
            }
        }

        this.accountTokens = validAccounts
    }


    /**
     * 自动刷新即将过期的令牌
     * @param {number} thresholdHours - 过期阈值（小时）
     * @returns {Promise<number>} 成功刷新的令牌数量
     */
    async autoRefreshTokens(thresholdHours = 24) {
        if (!this.isInitialized) {
            logger.warn('账户管理器尚未初始化，跳过自动刷新', 'TOKEN')
            return 0
        }

        logger.info('开始自动刷新令牌...', 'TOKEN', '🔄')

        // 获取需要刷新的账户
        const needsRefresh = this.accountTokens.filter(account =>
            this.tokenManager.isTokenExpiringSoon(account.token, thresholdHours)
        )

        if (needsRefresh.length === 0) {
            logger.info('没有需要刷新的令牌', 'TOKEN')
            return 0
        }

        logger.info(`发现 ${needsRefresh.length} 个令牌需要刷新`, 'TOKEN')

        let successCount = 0
        let failedCount = 0

        // 逐个刷新账户，每次成功后立即保存
        for (const account of needsRefresh) {
            try {
                const updatedAccount = await this.tokenManager.refreshToken(account)
                if (updatedAccount) {
                    // 立即更新内存中的账户数据
                    const index = this.accountTokens.findIndex(acc => acc.email === account.email)
                    if (index !== -1) {
                        this.accountTokens[index] = updatedAccount
                    }

                    // 立即保存到持久化存储
                    await this.dataPersistence.saveAccount(account.email, {
                        password: updatedAccount.password,
                        token: updatedAccount.token,
                        expires: updatedAccount.expires,
                        proxy: updatedAccount.proxy ?? account.proxy ?? null
                    })

                    // 重置失败计数
                    this.accountRotator.resetFailures(account.email)
                    successCount++

                    logger.info(`账户 ${account.email} 令牌刷新并保存成功 (${successCount}/${needsRefresh.length})`, 'TOKEN', '✅')
                } else {
                    // 记录失败的账户
                    this.accountRotator.recordFailure(account.email)
                    failedCount++
                    logger.error(`账户 ${account.email} 令牌刷新失败 (${failedCount} 个失败)`, 'TOKEN', '❌')
                }
            } catch (error) {
                this.accountRotator.recordFailure(account.email)
                failedCount++
                logger.error(`账户 ${account.email} 刷新过程中出错`, 'TOKEN', '', error)
            }

            // 添加延迟避免请求过于频繁
            await this._delay(1000)
        }

        // 更新轮询器
        this.accountRotator.setAccounts(this.accountTokens)

        logger.success(`令牌刷新完成: 成功 ${successCount} 个，失败 ${failedCount} 个`, 'TOKEN')
        return successCount
    }

    /**
     * 获取下一个可用的账户对象（包含 proxy 等完整字段）
     * @returns {Object|null} 账户对象或 null
     */
    getAccount() {
        if (!this.isInitialized) {
            // 紧急救火：明确说明尚未初始化（之前只 console.warn）
            logger.warn('[DIAG] getAccount() 拒绝：账户管理器尚未初始化完成', 'ACCOUNT')
            return null
        }

        if (this.accountTokens.length === 0) {
            logger.error('[DIAG] getAccount() 拒绝：没有可用的账户令牌（已加载 0 个）', 'ACCOUNT')
            return null
        }

        const account = this.accountRotator.getNextAccount()
        if (!account) {
            logger.error('[DIAG] getAccount() 返回 null：所有账户令牌都不可用', 'ACCOUNT')
        }

        return account
    }

    /**
     * 获取下一个可用账户，但排除指定 email
     * 失败重试时避免反复命中同一账号
     * @param {string} excludeEmail
     * @returns {Object|null}
     */
    getAccountExcluding(excludeEmail) {
        if (!this.isInitialized) return null
        if (this.accountTokens.length === 0) return null
        return this.accountRotator.getNextAccountExcluding(excludeEmail)
    }

    /**
     * 获取下一个可用账户，排除一组 email（用于媒体生成等需要逐个排除已失败账号的场景）
     * @param {Set<string>} excludeEmails
     * @returns {Object|null}
     */
    getAccountExcludingSet(excludeEmails) {
        if (!this.isInitialized) return null
        if (this.accountTokens.length === 0) return null
        return this.accountRotator.getNextAccountExcludingSet(excludeEmails)
    }

    /**
     * 获取可用的账户令牌（向后兼容的便捷方法）
     * @returns {string|null} 账户令牌或null
     */
    getAccountToken() {
        const account = this.getAccount()
        return account ? account.token : null
    }

    /**
     * 根据邮箱获取特定账户对象
     * @param {string} email - 邮箱地址
     * @returns {Object|null} 账户对象或 null
     */
    getAccountByEmail(email) {
        return this.accountRotator.getAccountByEmail(email)
    }

    /**
     * 根据令牌反查账户对象（用于只持有 token 的下游调用解析账号级代理）
     * @param {string} token - 访问令牌
     * @returns {Object|null} 账户对象或 null
     */
    getAccountByToken(token) {
        if (!token) return null
        return this.accountTokens.find(acc => acc.token === token) || null
    }

    /**
     * 根据邮箱获取特定账户的令牌（向后兼容）
     * @param {string} email - 邮箱地址
     * @returns {string|null} 账户令牌或null
     */
    getTokenByEmail(email) {
        return this.accountRotator.getTokenByEmail(email)
    }

    /**
     * 保存更新后的账户数据
     * @param {Array} updatedAccounts - 更新后的账户列表
     * @private
     */
    async _saveUpdatedAccounts(updatedAccounts) {
        try {
            for (const account of updatedAccounts) {
                await this.dataPersistence.saveAccount(account.email, {
                    password: account.password,
                    token: account.token,
                    expires: account.expires,
                    proxy: account.proxy ?? null
                })
            }
        } catch (error) {
            logger.error('保存更新后的账户数据失败', 'ACCOUNT', '', error)
        }
    }

    /**
     * 手动刷新指定账户的令牌
     * @param {string} email - 邮箱地址
     * @returns {Promise<boolean>} 刷新是否成功
     */
    async refreshAccountToken(email) {
        const account = this.accountTokens.find(acc => acc.email === email)
        if (!account) {
            logger.error(`未找到邮箱为 ${email} 的账户`, 'ACCOUNT')
            return false
        }

        const updatedAccount = await this.tokenManager.refreshToken(account)
        if (updatedAccount) {
            // 更新内存中的数据
            const index = this.accountTokens.findIndex(acc => acc.email === email)
            if (index !== -1) {
                this.accountTokens[index] = updatedAccount
            }

            // 保存到持久化存储
            await this.dataPersistence.saveAccount(email, {
                password: updatedAccount.password,
                token: updatedAccount.token,
                expires: updatedAccount.expires,
                proxy: updatedAccount.proxy ?? account.proxy ?? null
            })

            // 重置失败计数
            this.accountRotator.resetFailures(email)

            return true
        }

        return false
    }

    /**
     * 生成 Markdown 表格
     * @param {Array} websites - 网站信息数组
     * @param {string} mode - 模式 ('table' 或 'text')
     * @returns {Promise<string>} Markdown 字符串
     */
    async generateMarkdownTable(websites, mode) {
        // 输入校验
        if (!Array.isArray(websites) || websites.length === 0) {
            return ''
        }

        let markdown = ''
        if (mode === 'table') {
            markdown += '| **序号** | **网站URL** | **来源** |\n'
            markdown += '|:---|:---|:---|\n'
        }

        // 默认值
        const DEFAULT_TITLE = '未知标题'
        const DEFAULT_URL = 'https://www.baidu.com'
        const DEFAULT_HOSTNAME = '未知来源'

        // 表格内容
        websites.forEach((site, index) => {
            const { title, url, hostname } = site
            // 处理字段值，若为空则使用默认值
            const urlCell = `[${title || DEFAULT_TITLE}](${url || DEFAULT_URL})`
            const hostnameCell = hostname || DEFAULT_HOSTNAME
            if (mode === 'table') {
                markdown += `| ${index + 1} | ${urlCell} | ${hostnameCell} |\n`
            } else {
                markdown += `[${index + 1}] ${urlCell} | 来源: ${hostnameCell}\n`
            }
        })

        return markdown
    }



    /**
     * 获取所有账户信息
     * @returns {Array} 账户列表
     */
    getAllAccountKeys() {
        return this.accountTokens
    }

    /**
     * 用户登录（委托给 TokenManager）
     * @param {string} email - 邮箱
     * @param {string} password - 密码
     * @returns {Promise<string|null>} 令牌或null
     */
    async login(email, password) {
        return await this.tokenManager.login(email, password)
    }

    /**
     * 获取账户健康状态统计
     * @returns {Object} 健康状态统计
     */
    getHealthStats() {
        const tokenStats = this.tokenManager.getTokenHealthStats(this.accountTokens)
        const rotatorStats = this.accountRotator.getStats()

        return {
            accounts: tokenStats,
            rotation: rotatorStats,
            initialized: this.isInitialized
        }
    }

    /**
     * 记录账户传输层失败（影响 cooldown）
     * 仅在 timeout/ECONNRESET 等传输层错误调用——HTTP 4xx/5xx 走 recordAccountError
     *
     * Phase D2: 同步转发到 AccountRuntime.markFailure，让 scheduler 感知失败次数
     * 用于冷却判断。accountRotator 仍保留持久化职责（cooldown UI 指示）。
     *
     * @param {string} email - 邮箱地址
     * @param {string|number} [code] - 错误码（err.code 或 HTTP status）
     */
    recordAccountFailure(email, code) {
        // 保留持久化职责：accountRotator 处理 cooldown 持久化
        this.accountRotator.recordFailure(email, code)

        // Phase D2: forward to AccountRuntime.markFailure to sync scheduler runtime state.
        // Runtime may not exist yet (during _initialize), so guard with safe lookup.
        const runtime = this._runtimeByEmail && this._runtimeByEmail.get(email)
        if (runtime && typeof runtime.markFailure === 'function') {
            const reason = (code != null) ? String(code) : 'unknown'
            runtime.markFailure(reason)
        }
    }

    /**
     * 记录账户错误（仅用于 UI warn 指示，不影响 cooldown）
     * HTTP 4xx/5xx 走这里——上游主动拒绝，账户本身有效
     * @param {string} email - 邮箱地址
     * @param {string|number} [code] - HTTP status 或错误码
     */
    recordAccountError(email, code) {
        this.accountRotator.recordError(email, code)
    }

    /**
     * 累计 daily stats（per-account）
     * 调用方：chat.js / anthropic.js 在成功消费完上游 usage 后
     * 注意：PM2_INSTANCES>1 时各 worker 各持一份 in-memory 副本（已记于 epic notes）
     * @param {string} email - 邮箱地址
     * @param {'chat'} kind - 统计类别
     * @param {Object} delta - 增量
     * @param {number} [delta.input] - 输入 tokens
     * @param {number} [delta.output] - 输出 tokens
     */
    accumulateStats(email, kind, delta) {
        if (!email || !delta) return
        const account = this.accountTokens.find(acc => acc.email === email)
        if (!account) return

        ensureStats(account)

        if (kind === 'chat') {
            for (const field of CHAT_STATS_FIELDS) {
                account.stats.chat[field] += Number(delta[field]) || 0
            }
            // Provider 维度（qwen / dpsk）
            const provider = normalizeProvider(delta.provider)
            if (provider) {
                if (!account.stats.chat.byProvider || typeof account.stats.chat.byProvider !== 'object') {
                    account.stats.chat.byProvider = {}
                }
                const bucket = account.stats.chat.byProvider[provider] || { input: 0, output: 0, requests: 0 }
                bucket.input += Number(delta.input) || 0
                bucket.output += Number(delta.output) || 0
                bucket.requests += 1
                account.stats.chat.byProvider[provider] = bucket
            }
            // Model 维度（按 base model 聚合，-thinking/-search/-image 等归一化）
            const baseModel = normalizeBaseModel(delta.model)
            if (baseModel) {
                if (!account.stats.chat.byModel || typeof account.stats.chat.byModel !== 'object') {
                    account.stats.chat.byModel = {}
                }
                const m = account.stats.chat.byModel[baseModel] || { input: 0, output: 0, requests: 0 }
                m.input += Number(delta.input) || 0
                m.output += Number(delta.output) || 0
                m.requests += 1
                m.provider = provider || m.provider || ''
                account.stats.chat.byModel[baseModel] = m
            }
        } else {
            return
        }

        // 异步 debounced persist——失败不影响调用方
        try {
            this.dataPersistence.saveAccountStats(email, account.stats)
        } catch (error) {
            logger.error(`accumulateStats persist 调度失败 (${email})`, 'STATS', '', error)
        }
    }

    /**
     * 重置账户失败计数
     * @param {string} email - 邮箱地址
     */
    resetAccountFailures(email) {
        this.accountRotator.resetFailures(email)
    }

    /**
     * 添加新账户
     * @param {string} email - 邮箱
     * @param {string} password - 密码
     * @param {string|null} [proxy] - 账号专属代理 URL（HTTP/HTTPS/SOCKS5）
     * @returns {Promise<boolean>} 添加是否成功
     */
    async addAccount(email, password, proxy = null) {
        try {
            // 检查账户是否已存在
            const existingAccount = this.accountTokens.find(acc => acc.email === email)
            if (existingAccount) {
                logger.warn(`账户 ${email} 已存在`, 'ACCOUNT')
                return false
            }

            // 尝试登录获取令牌
            const token = await this.tokenManager.login(email, password)
            if (!token) {
                logger.error(`账户 ${email} 登录失败，无法添加`, 'ACCOUNT')
                return false
            }

            const decoded = this.tokenManager.validateToken(token)
            if (!decoded) {
                logger.error(`账户 ${email} 令牌无效，无法添加`, 'ACCOUNT')
                return false
            }

            const newAccount = {
                email,
                password,
                token,
                expires: decoded.exp,
                proxy: (typeof proxy === 'string' && proxy.trim()) ? proxy.trim() : null,
                stats: createDefaultStats()
            }

            // 添加到内存
            this.accountTokens.push(newAccount)
            const insertedIndex = this.accountTokens.length - 1

            // 保存到持久化存储
            const saved = await this.dataPersistence.saveAccount(email, newAccount)
            if (!saved) {
                this.accountTokens.splice(insertedIndex, 1)
                this.accountRotator.setAccounts(this.accountTokens)
                logger.error(`账户 ${email} 持久化失败，已回滚内存数据`, 'ACCOUNT')
                return false
            }

            // 更新轮询器
            this.accountRotator.setAccounts(this.accountTokens)

            // 为新账号分配固定 client profile
            assignProfileToAccount(newAccount)

            // Phase D2: build and register AccountRuntime for the new account
            this._registerRuntimeForAccount(newAccount)

            logger.success(`成功添加账户: ${email}`, 'ACCOUNT')
            return true
        } catch (error) {
            logger.error(`添加账户失败 (${email})`, 'ACCOUNT', '', error)
            return false
        }
    }

    /**
     * 直接添加账户（已有token，无需登录）
     * @param {string} email - 邮箱
     * @param {string} password - 密码
     * @param {string} token - 已获取的令牌
     * @param {number} expires - 过期时间戳
     * @param {string|null} [proxy] - 账号专属代理 URL
     * @returns {Promise<boolean>} 添加是否成功
     */
    async addAccountWithToken(email, password, token, expires, proxy = null) {
        try {
            // 检查账户是否已存在
            const existingAccount = this.accountTokens.find(acc => acc.email === email)
            if (existingAccount) {
                logger.warn(`账户 ${email} 已存在`, 'ACCOUNT')
                return false
            }

            const newAccount = {
                email,
                password,
                token,
                expires,
                proxy: (typeof proxy === 'string' && proxy.trim()) ? proxy.trim() : null,
                stats: createDefaultStats()
            }

            // 添加到内存
            this.accountTokens.push(newAccount)
            const insertedIndex = this.accountTokens.length - 1

            // 保存到持久化存储
            const saved = await this.dataPersistence.saveAccount(email, newAccount)
            if (!saved) {
                this.accountTokens.splice(insertedIndex, 1)
                this.accountRotator.setAccounts(this.accountTokens)
                logger.error(`账户 ${email} 持久化失败，已回滚内存数据`, 'ACCOUNT')
                return false
            }

            // 更新轮询器
            this.accountRotator.setAccounts(this.accountTokens)

            // 为新账号分配固定 client profile
            assignProfileToAccount(newAccount)

            // Phase D2: build and register AccountRuntime for the new account
            this._registerRuntimeForAccount(newAccount)

            logger.success(`成功添加账户: ${email}`, 'ACCOUNT')
            return true
        } catch (error) {
            logger.error(`添加账户失败 (${email})`, 'ACCOUNT', '', error)
            return false
        }
    }

    /**
     * 更新账户的代理 URL
     * 同时使旧 URL 对应的 agent 失效（释放底层 socket）
     * @param {string} email - 邮箱
     * @param {string|null} proxy - 新代理 URL，空字符串/null 表示清除
     * @returns {Promise<boolean>} 更新是否成功
     */
    async updateAccountProxy(email, proxy) {
        try {
            const account = this.accountTokens.find(acc => acc.email === email)
            if (!account) {
                logger.warn(`账户 ${email} 不存在`, 'ACCOUNT')
                return false
            }

            const oldProxy = account.proxy || null
            const newProxy = (typeof proxy === 'string' && proxy.trim()) ? proxy.trim() : null

            if (oldProxy === newProxy) {
                logger.info(`账户 ${email} 代理未变化，无需更新`, 'ACCOUNT')
                return true
            }

            // 先更新内存，再持久化；持久化失败时回滚
            account.proxy = newProxy
            const saved = await this.dataPersistence.saveAccount(email, {
                password: account.password,
                token: account.token,
                expires: account.expires,
                proxy: newProxy,
                enabled: account.enabled !== false
            })
            if (!saved) {
                account.proxy = oldProxy
                logger.error(`账户 ${email} 代理持久化失败，已回滚内存数据`, 'ACCOUNT')
                return false
            }

            // 旧代理 URL 不再被该账户引用，主动失效缓存
            // 注意：其他账户可能仍在使用同一 URL，但 invalidate 仅按 URL 操作；
            // 多账户共享代理的场景下后续请求会重新创建 agent，安全
            if (oldProxy && oldProxy !== newProxy) {
                const { invalidateProxyAgent } = require('./proxy-helper')
                invalidateProxyAgent(oldProxy)
            }

            return true
        } catch (error) {
            logger.error(`更新账户 ${email} 代理时发生错误`, 'ACCOUNT', '', error)
            return false
        }
    }

    /**
     * 启用/停用账户
     * @param {string} email - 邮箱
     * @param {boolean} enabled - 是否启用
     * @returns {Promise<boolean>}
     */
    async toggleAccount(email, enabled) {
        try {
            const account = this.accountTokens.find(acc => acc.email === email)
            if (!account) {
                logger.warn(`账户 ${email} 不存在`, 'ACCOUNT')
                return false
            }

            const oldEnabled = account.enabled !== false
            const targetEnabled = typeof enabled === 'boolean' ? enabled : !oldEnabled

            account.enabled = targetEnabled
            const saved = await this.dataPersistence.saveAccount(email, {
                password: account.password,
                token: account.token,
                expires: account.expires,
                proxy: account.proxy,
                enabled: targetEnabled
            })

            if (!saved) {
                account.enabled = oldEnabled
                logger.error(`账户 ${email} 状态持久化失败，已回滚内存`, 'ACCOUNT')
                return false
            }

            // 同步更新轮询器和调度器
            this.accountRotator.setAccounts(this.accountTokens)
            const runtime = this._runtimeByEmail.get(email)
            if (runtime) {
                runtime.enabled = targetEnabled
                runtime.schedulerEligible = targetEnabled && !!account.token
            }

            logger.info(`[ACCOUNT] 账户 ${email} 状态变更为: ${targetEnabled ? '已启用' : '已停用'}`, 'ACCOUNT')
            return true
        } catch (error) {
            logger.error(`切换账户 ${email} 启用状态失败`, 'ACCOUNT', '', error)
            return false
        }
    }

    async clearAllAccounts() {
        try {
            const accounts = [...this.accountTokens]
            for (const account of accounts) {
                if (!account?.email) continue
                const removed = await this.removeAccount(account.email)
                if (!removed) {
                    logger.error(`清空账户时删除失败 (${account.email})`, 'ACCOUNT')
                    return false
                }
            }

            try {
                const pool = require('./account-pool-redis')
                await pool.clearAllRuntimeState()
            } catch (_) { /* ignore */ }

            return true
        } catch (error) {
            logger.error('清空所有账户失败', 'ACCOUNT', '', error)
            return false
        }
    }

    /**
     * 移除账户
     * @param {string} email - 邮箱地址
     * @returns {Promise<boolean>} 移除是否成功
     */
    async removeAccount(email) {
        try {
            const index = this.accountTokens.findIndex(acc => acc.email === email)
            if (index === -1) {
                logger.warn(`账户 ${email} 不存在`, 'ACCOUNT')
                return false
            }

            const persisted = await this.dataPersistence.deleteAccount(email)
            if (!persisted) {
                logger.error(`账户 ${email} 持久化删除失败`, 'ACCOUNT')
                return false
            }

            try {
                const pool = require('./account-pool-redis')
                await pool.clearAccountState(email)
            } catch (_) { /* ignore */ }

            // 从内存中移除
            this.accountTokens.splice(index, 1)

            // 更新轮询器
            this.accountRotator.setAccounts(this.accountTokens)

            logger.success(`成功移除账户: ${email}`, 'ACCOUNT')
            return true
        } catch (error) {
            logger.error(`移除账户失败 (${email})`, 'ACCOUNT', '', error)
            return false
        }
    }

    /**
     * 删除账户（向后兼容）
     * @param {string} email - 邮箱地址
     * @returns {boolean} 删除是否成功
     */
    deleteAccount(email) {
        const index = this.accountTokens.findIndex(t => t.email === email)
        if (index !== -1) {
            this.accountTokens.splice(index, 1)
            this.accountRotator.setAccounts(this.accountTokens)
            return true
        }
        return false
    }

    /**
     * 延迟函数
     * @param {number} ms - 延迟毫秒数
     * @private
     */
    async _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    /**
     * 清理资源
     */
    destroy() {
        // 清理自动保存定时器
        if (this.saveInterval) {
            clearInterval(this.saveInterval)
            this.saveInterval = null
        }

        // 清理自动刷新定时器
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval)
            this.refreshInterval = null
        }

        // 清理每日 stats 重置定时器
        if (this.dailyResetTimeout) {
            clearTimeout(this.dailyResetTimeout)
            this.dailyResetTimeout = null
        }

        if (this.dailyResetInterval) {
            clearInterval(this.dailyResetInterval)
            this.dailyResetInterval = null
        }

        this.accountRotator.reset()
        logger.info('账户管理器已清理资源', 'ACCOUNT', '🧹')
    }

}

const isUnitTestRuntime = !!process.env.NODE_TEST_CONTEXT
    && String(process.env.ZPROXY_TEST_LOAD_ENV || '').toLowerCase() !== 'true'

if (!(process.env.API_KEY || config.apiKey) && !isUnitTestRuntime) {
    logger.error('请务必设置 API_KEY 环境变量', 'CONFIG', '⚙️')
    process.exit(1)
}

const accountManager = new Account()
// Stats API consumes the same normalization rule used during accumulation.
// Attach it to the singleton export to keep the existing account-manager API.
accountManager.normalizeBaseModel = normalizeBaseModel

// 添加进程退出时的清理
process.on('exit', () => {
    if (accountManager) {
        accountManager.destroy()
    }
})

// 处理意外退出
process.on('SIGINT', () => {
    if (accountManager) {
        accountManager.destroy()
    }
    process.exit(0)
})


module.exports = accountManager
