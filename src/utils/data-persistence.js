const fs = require('fs').promises
const fsSync = require('fs')
const path = require('path')
const os = require('os')
const config = require('../config/index.js')
const redisClient = require('./redis')
const { logger } = require('./logger')
const { detectRuntimeTopology, buildFileModeRuntimeDiagnostic } = require('./runtime-topology')

/**
 * 数据持久化管理器
 * 统一处理账户数据的存储和读取
 */
// Debounce 窗口（per-email）写入 stats——避免每次 token 累计都触发文件 I/O
const STATS_PERSIST_DEBOUNCE_MS = 5000
// File-mode 写锁等待（毫秒）+ 重试间隔——多 PM2 worker 共享 qwen-data.json 必须
// 串行化写以避免 race 导致覆盖
const FILE_LOCK_RETRY_MS = 80
const FILE_LOCK_MAX_ATTEMPTS = 60  // 60 * 80ms = 4.8s 等待上限

/**
 * 跨进程文件写锁（基于 atomic rename + PID stamp）
 * - PM2 多个 worker 共享同一份 qwen-data.json，简单 PID 自旋不够。
 * - 采用 `lockf` POSIX advisory lock（Node FileHandle 不带 lock API）——
 *   改用 O_EXCL 原子创建哨兵文件 + PID 校验。
 *   - 尝试 O_EXCL 创建 <data>.lock
 *     - 成功：拿到锁（写入 PID + hostname + acquiredAt + expiresAt）
 *     - 失败：读取现有锁
 *       - 若 PID 仍 alive + 没过期：等待后重试
 *       - 若过期 / PID 死掉：unlink 旧锁后重试 O_EXCL
 * - 退避：每 80ms 重试一次，最多 60 次
 * @param {string} lockPath
 * @returns {Promise<{release: () => Promise<void>}>}
 */
const _isPidAlive = (pid) => {
    if (!pid || pid <= 0) return false
    try {
        // 信号 0 不发信号，只检测进程是否存在
        process.kill(pid, 0)
        return true
    } catch (err) {
        return false
    }
}

const acquireFileLock = async (lockPath) => {
    const lockTtlMs = 30000  // 30s 锁 TTL，超过这个时间认为持锁者已死
    let lastErr = null

    for (let attempt = 0; attempt < FILE_LOCK_MAX_ATTEMPTS; attempt++) {
        const payload = JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            acquiredAt: Date.now(),
            expiresAt: Date.now() + lockTtlMs
        })

        try {
            // 尝试 O_EXCL 创建
            const fd = await fs.open(lockPath, 'wx')
            try {
                await fd.writeFile(payload, 'utf-8')
            } finally {
                await fd.close()
            }
            return {
                _lockPath: lockPath,
                release: async () => {
                    try {
                        // 只在持锁者仍是自己的情况下 unlink——避免 unlink 别人的锁
                        const raw = await fs.readFile(lockPath, 'utf-8').catch(() => '')
                        let parsed = null
                        try { parsed = JSON.parse(raw) } catch (_) { /* ignore */ }
                        if (parsed && parsed.pid === process.pid) {
                            await fs.unlink(lockPath)
                        }
                    } catch (_) { /* ignore */ }
                }
            }
        } catch (err) {
            if (err.code !== 'EEXIST') {
                lastErr = err
                await new Promise(r => setTimeout(r, FILE_LOCK_RETRY_MS))
                continue
            }
            // 已存在——读锁
            try {
                const raw = await fs.readFile(lockPath, 'utf-8')
                let parsed = null
                try { parsed = JSON.parse(raw) } catch (_) { /* ignore */ }

                const now = Date.now()
                const expired = parsed && parsed.expiresAt && parsed.expiresAt < now
                const deadHolder = parsed && parsed.pid && !_isPidAlive(parsed.pid)

                if (expired || deadHolder) {
                    // 旧锁持有者死了——unlink 后重试 O_EXCL
                    try { await fs.unlink(lockPath) } catch (_) { /* ignore */ }
                    continue
                }
            } catch (_) { /* ignore */ }

            lastErr = err
            await new Promise(r => setTimeout(r, FILE_LOCK_RETRY_MS))
        }
    }
    throw new Error(`获取文件写锁超时 (${lockPath}): ${lastErr?.message || 'unknown'}`)
}

class DataPersistence {
  constructor() {
    this.dataFilePath = path.join(__dirname, '../../data/qwen-data.json')
    this._dataFileLockPath = `${this.dataFilePath}.lock`
    // 每个 email 的待持久化 stats 与定时器（debounce）
    this._statsPersistTimers = new Map()
    this._statsPendingPayload = new Map()
    this._warnedFileModePm2 = false
  }

  /**
   * 在 file 模式 + PM2 多 worker 场景下，给出一次性警告
   * 不阻塞启动——只是提示
   */
  _maybeWarnFileModePm2() {
    if (this._warnedFileModePm2) return
    this._warnedFileModePm2 = true
    if (config.dataSaveMode !== 'file') return
    const diagnostic = buildFileModeRuntimeDiagnostic(
      config.dataSaveMode,
      detectRuntimeTopology()
    )
    if (diagnostic.shouldWarn) {
      logger.warn(
        `检测到多 worker file mode (detectedRuntime=${diagnostic.detectedRuntime}, ` +
        `actualWorkerId=${diagnostic.actualWorkerId ?? 'n/a'}, configuredInstances=${diagnostic.configuredInstances ?? 'max'}, ` +
        `dataSaveMode=${diagnostic.dataSaveMode})——` +
        '已启用文件写锁串行化 qwen-data.json 写入，但高并发场景强烈建议改用 DATA_SAVE_MODE=redis 避免锁竞争。',
        'DATA'
      )
    }
  }

  /**
   * 加载所有账户数据
   * @returns {Promise<Array>} 账户列表
   */
  async loadAccounts() {
    try {
      switch (config.dataSaveMode) {
        case 'redis':
          return await this._loadFromRedisWithFallback()
        case 'file':
          return await this._loadFromFile()
        case 'none':
          return await this._loadFromEnv()
        default:
          logger.error(`不支持的数据保存模式: ${config.dataSaveMode}`, 'DATA')
          throw new Error(`不支持的数据保存模式: ${config.dataSaveMode}`)
      }
    } catch (error) {
      logger.error('加载账户数据失败', 'DATA', '', error)
      throw error
    }
  }

  /**
   * 紧急救火：DATA_SAVE_MODE=redis 时的主入口
   * - 优先从 Redis 加载
   * - 失败 / 返回 0 账号时，按 config.accountLoadFallback 决定是否回退
   *   - 'none' (默认)：不回退，向上抛
   *   - 'file'：从 data/qwen-data.json 加载（仅记录数量，不写回 Redis）
   *   - 'env' ：从 process.env.ACCOUNTS 加载
   * @returns {Promise<Array>}
   * @private
   */
  async _loadFromRedisWithFallback() {
    let primaryError = null
    let primaryCount = 0
    let accounts = []
    try {
      accounts = await this._loadFromRedis()
      primaryCount = accounts.length
      if (primaryCount > 0) {
        logger.success(`[DIAG] Redis 主加载成功: count=${primaryCount}`, 'DATA')
        return accounts
      }
      logger.warn('[DIAG] Redis 主加载返回 0 账号，准备判定是否 fallback', 'DATA')
    } catch (err) {
      primaryError = err
      logger.error('[DIAG] Redis 主加载失败，准备判定是否 fallback', 'DATA', '', err)
    }

    const fallback = String(config.accountLoadFallback || 'none').toLowerCase()
    if (fallback === 'none') {
      // 严格模式：不 fallback
      if (primaryError) {
        // 把 primary error 重新抛出——上层会捕获并记录
        throw primaryError
      }
      // 0 账号 + strict：原行为是返回 []——保持兼容，不抛
      return []
    }

    if (fallback === 'file') {
      try {
        const fb = await this._loadFromFile()
        logger.warn(
          `[DIAG] ACCOUNT_LOAD_FALLBACK=file 触发：从 data/qwen-data.json 加载 (count=${fb.length})`,
          'DATA'
        )
        // 不自动写回 Redis
        return fb
      } catch (fbErr) {
        logger.error('[DIAG] file fallback 也失败', 'DATA', '', fbErr)
        if (primaryError) throw primaryError
        return []
      }
    }

    if (fallback === 'env') {
      try {
        const fb = await this._loadFromEnv()
        logger.warn(
          `[DIAG] ACCOUNT_LOAD_FALLBACK=env 触发：从 ACCOUNTS 环境变量加载 (count=${fb.length})`,
          'DATA'
        )
        return fb
      } catch (fbErr) {
        logger.error('[DIAG] env fallback 也失败', 'DATA', '', fbErr)
        if (primaryError) throw primaryError
        return []
      }
    }

    // 未知 fallback 值：当作 none
    logger.warn(`[DIAG] 未知的 accountLoadFallback=${fallback}，按 none 处理`, 'DATA')
    if (primaryError) throw primaryError
    return accounts
  }

  /**
   * 保存单个账户数据
   * @param {string} email - 邮箱
   * @param {Object} accountData - 账户数据
   * @returns {Promise<boolean>} 保存是否成功
   */
  async saveAccount(email, accountData) {
    try {
      switch (config.dataSaveMode) {
        case 'redis':
          return await this._saveToRedis(email, accountData)
        case 'file':
          return await this._saveToFile(email, accountData)
        case 'none':
          logger.warn('环境变量模式不支持保存账户数据', 'DATA')
          return false
        default:
          logger.error(`不支持的数据保存模式: ${config.dataSaveMode}`, 'DATA')
          throw new Error(`不支持的数据保存模式: ${config.dataSaveMode}`)
      }
    } catch (error) {
      logger.error(`保存账户数据失败 (${email})`, 'DATA', '', error)
      return false
    }
  }

  /**
   * Delete one persisted account.
   * @param {string} email
   * @returns {Promise<boolean>}
   */
  async deleteAccount(email) {
    try {
      switch (config.dataSaveMode) {
        case 'redis':
          return await redisClient.deleteAccount(email)
        case 'file':
          return await this._deleteFromFile(email)
        case 'none':
          logger.warn('环境变量模式不支持删除账户数据', 'DATA')
          return false
        default:
          logger.error(`不支持的数据保存模式: ${config.dataSaveMode}`, 'DATA')
          throw new Error(`不支持的数据保存模式: ${config.dataSaveMode}`)
      }
    } catch (error) {
      logger.error(`删除账户数据失败 (${email})`, 'DATA', '', error)
      return false
    }
  }

  /**
   * 加载运行时设置（chat retry config 等）
   * 在 'none' 模式下返回 {}, 因为没有可写存储
   * @returns {Promise<Object>} 设置对象 (空对象表示尚未存储任何值)
   */
  async loadSettings() {
    try {
      switch (config.dataSaveMode) {
        case 'redis':
          return (await redisClient.getSettings()) || {}
        case 'file':
          return await this._loadSettingsFromFile()
        case 'none':
          return {}
        default:
          logger.error(`不支持的数据保存模式: ${config.dataSaveMode}`, 'DATA')
          return {}
      }
    } catch (error) {
      logger.error('加载运行时设置失败', 'DATA', '', error)
      return {}
    }
  }

  /**
   * 保存运行时设置（部分合并）
   * @param {Object} partial - 要写入的字段
   * @returns {Promise<boolean>} 保存是否成功
   */
  async saveSettings(partial) {
    try {
      switch (config.dataSaveMode) {
        case 'redis':
          return await redisClient.setSettings(partial)
        case 'file':
          return await this._saveSettingsToFile(partial)
        case 'none':
          logger.warn('环境变量模式不支持保存运行时设置', 'DATA')
          return false
        default:
          logger.error(`不支持的数据保存模式: ${config.dataSaveMode}`, 'DATA')
          return false
      }
    } catch (error) {
      logger.error('保存运行时设置失败', 'DATA', '', error)
      return false
    }
  }

  async _loadSettingsFromFile() {
    await this._ensureDataFileExists()
    const fileContent = await fs.readFile(this.dataFilePath, 'utf-8')
    const data = JSON.parse(fileContent)
    return (data.settings && typeof data.settings === 'object') ? data.settings : {}
  }

  async _saveSettingsToFile(partial) {
    await this._ensureDataFileExists()
    const fileContent = await fs.readFile(this.dataFilePath, 'utf-8')
    const data = JSON.parse(fileContent)
    data.settings = { ...(data.settings || {}), ...partial }
    await fs.writeFile(this.dataFilePath, JSON.stringify(data, null, 2), 'utf-8')
    return true
  }

  /**
   * 批量保存账户数据
   * @param {Array} accounts - 账户列表
   * @returns {Promise<boolean>} 保存是否成功
   */
  async saveAllAccounts(accounts) {
    try {
      switch (config.dataSaveMode) {
        case 'redis':
          return await this._saveAllToRedis(accounts)
        case 'file':
          return await this._saveAllToFile(accounts)
        case 'none':
          logger.warn('环境变量模式不支持保存账户数据', 'DATA')
          return false
        default:
          logger.error(`不支持的数据保存模式: ${config.dataSaveMode}`, 'DATA')
          throw new Error(`不支持的数据保存模式: ${config.dataSaveMode}`)
      }
    } catch (error) {
      logger.error('批量保存账户数据失败', 'DATA', '', error)
      return false
    }
  }

  /**
   * 从 Redis 加载账户数据
   * @private
   */
  async _loadFromRedis() {
    const accounts = await redisClient.getAllAccounts()
    return accounts.length > 0 ? accounts : []
  }

  /**
   * 从文件加载账户数据
   * @private
   */
  async _loadFromFile() {
    // 确保文件存在
    await this._ensureDataFileExists()
    
    const fileContent = await fs.readFile(this.dataFilePath, 'utf-8')
    const data = JSON.parse(fileContent)
    
    return data.accounts || []
  }

  /**
   * 从环境变量加载账户数据
   * @private
   */
  async _loadFromEnv() {
    if (!process.env.ACCOUNTS) {
      return []
    }

    const { parseAccountLine } = require('./account-parser')
    const accountTokens = process.env.ACCOUNTS.split(',')
    const accounts = []

    // 解析委托给共用 parser，与后台批量添加保持一致；
    // 注意：这里仅加载凭据，token 在 Account 类中按需登录获取
    for (const item of accountTokens) {
      const parsed = parseAccountLine(item)
      if (parsed) {
        accounts.push({ ...parsed, token: null, expires: null })
      }
    }

    return accounts
  }

  /**
   * 保存到 Redis
   * @private
   */
  async _saveToRedis(email, accountData) {
    return await redisClient.setAccount(email, accountData)
  }

  /**
   * 保存到文件（MERGE 语义）
   * partial save（仅 token、proxy、stats）不应覆盖未传字段——保留 existing 值
   * 多 PM2 worker 场景下用文件写锁串行化
   * @private
   */
  async _saveToFile(email, accountData) {
    await this._ensureDataFileExists()
    this._maybeWarnFileModePm2()

    let lock = null
    try {
      lock = await acquireFileLock(this._dataFileLockPath)
    } catch (lockErr) {
      logger.error(`获取 qwen-data.json 写锁失败 (${email})，尝试无锁写入`, 'DATA', '', lockErr)
    }

    try {
      const fileContent = await fs.readFile(this.dataFilePath, 'utf-8')
      const data = JSON.parse(fileContent)

      if (!data.accounts) {
        data.accounts = []
      }

      const existingIndex = data.accounts.findIndex(account => account.email === email)
      const existing = existingIndex !== -1 ? data.accounts[existingIndex] : {}

      // 仅写入显式传入的字段；未传字段保留 existing 值。stats 同理——
      // 避免 token refresh / proxy update 的 partial save 把累计 stats 清零
      const merged = { ...existing, email }
      if (accountData.password !== undefined) merged.password = accountData.password
      if (accountData.token !== undefined) merged.token = accountData.token
      if (accountData.expires !== undefined) merged.expires = accountData.expires
      if (accountData.proxy !== undefined) merged.proxy = accountData.proxy ?? null
      if (accountData.stats !== undefined) merged.stats = accountData.stats
      if (accountData.statsHistory !== undefined) merged.statsHistory = accountData.statsHistory

      if (existingIndex !== -1) {
        data.accounts[existingIndex] = merged
      } else {
        data.accounts.push(merged)
      }

      await fs.writeFile(this.dataFilePath, JSON.stringify(data, null, 2), 'utf-8')
      return true
    } finally {
      if (lock) {
        try { await lock.release() } catch (_) { /* ignore */ }
      }
    }
  }

  /**
   * 批量保存到 Redis
   * @private
   */
  async _saveAllToRedis(accounts) {
    let successCount = 0
    for (const account of accounts) {
      const success = await this._saveToRedis(account.email, account)
      if (success) successCount++
    }
    return successCount === accounts.length
  }

  /**
   * 批量保存到文件
   * @private
   */
  async _saveAllToFile(accounts) {
    await this._ensureDataFileExists()
    this._maybeWarnFileModePm2()

    let lock = null
    try {
      lock = await acquireFileLock(this._dataFileLockPath)
    } catch (lockErr) {
      logger.error('获取 qwen-data.json 写锁失败 (saveAll)，尝试无锁写入', 'DATA', '', lockErr)
    }

    try {
      const fileContent = await fs.readFile(this.dataFilePath, 'utf-8')
      const data = JSON.parse(fileContent)

      data.accounts = accounts.map(account => ({
        email: account.email,
        password: account.password,
        token: account.token,
        expires: account.expires,
        proxy: account.proxy ?? null,
        stats: account.stats ?? undefined,
        statsHistory: account.statsHistory ?? undefined
      }))

      await fs.writeFile(this.dataFilePath, JSON.stringify(data, null, 2), 'utf-8')
      return true
    } finally {
      if (lock) {
        try { await lock.release() } catch (_) { /* ignore */ }
      }
    }
  }

  async _deleteFromFile(email) {
    await this._ensureDataFileExists()
    this._maybeWarnFileModePm2()

    let lock = null
    try {
      lock = await acquireFileLock(this._dataFileLockPath)
    } catch (lockErr) {
      logger.error(`获取 qwen-data.json 写锁失败 (delete ${email})，尝试无锁写入`, 'DATA', '', lockErr)
    }

    try {
      const fileContent = await fs.readFile(this.dataFilePath, 'utf-8')
      const data = JSON.parse(fileContent)
      const accounts = Array.isArray(data.accounts) ? data.accounts : []
      const nextAccounts = accounts.filter(account => account.email !== email)
      if (nextAccounts.length === accounts.length) return false
      data.accounts = nextAccounts
      await fs.writeFile(this.dataFilePath, JSON.stringify(data, null, 2), 'utf-8')
      return true
    } finally {
      if (lock) {
        try { await lock.release() } catch (_) {}
      }
    }
  }

  /**
   * 调度 per-account daily stats 持久化（debounce 5 秒）
   * 高频 accumulateStats 调用合并为单次 I/O——重复调用替换上一个 timer
   * dataSaveMode='none' 时不写盘，返回 false
   * @param {string} email - 邮箱
   * @param {Object} stats - 完整 stats 对象 { chat: {input,output} }
   * @returns {boolean} 是否调度成功
   */
  saveAccountStats(email, stats) {
    if (config.dataSaveMode === 'none') {
      return false
    }
    if (!email || !stats) {
      return false
    }

    // 替换 pending payload 与 timer
    this._statsPendingPayload.set(email, stats)
    const prev = this._statsPersistTimers.get(email)
    if (prev) clearTimeout(prev)

    const timer = setTimeout(async () => {
      this._statsPersistTimers.delete(email)
      const payload = this._statsPendingPayload.get(email)
      this._statsPendingPayload.delete(email)
      if (!payload) return
      try {
        await this.saveAccount(email, { stats: payload })
      } catch (error) {
        logger.error(`stats 持久化失败 (${email})`, 'STATS', '', error)
      }
    }, STATS_PERSIST_DEBOUNCE_MS)

    this._statsPersistTimers.set(email, timer)
    return true
  }

  /**
   * 确保数据文件存在
   * @private
   */
  async _ensureDataFileExists() {
    try {
      await fs.access(this.dataFilePath)
    } catch (error) {
      logger.info('数据文件不存在，正在创建默认文件...', 'FILE', '📁')

      // 确保目录存在
      const dirPath = path.dirname(this.dataFilePath)
      await fs.mkdir(dirPath, { recursive: true })

      // 创建默认数据结构
      const defaultData = {
        defaultHeaders: null,
        defaultCookie: null,
        accounts: []
      }

      await fs.writeFile(this.dataFilePath, JSON.stringify(defaultData, null, 2), 'utf-8')
      logger.success('默认数据文件创建成功', 'FILE')
    }
  }
}

module.exports = DataPersistence
