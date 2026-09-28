const { logger } = require('./logger')
const pool = require('./account-pool-redis')
const scorer = require('./account-scorer')

/**
 * 账户轮询管理器
 * 负责账户的轮询选择和负载均衡
 */
class AccountRotator {
  constructor() {
    this.accounts = []
    this.currentIndex = 0
    this.lastUsedTimes = new Map() // 记录每个账户的最后使用时间
    this.failureCounts = new Map() // 记录每个账户的失败次数（仅传输层失败累积，触发 cooldown）
    this.lastErrorAt = new Map() // 最近一次错误的时间戳（用于 UI warn 指示，含 HTTP 4xx/5xx）
    this.lastErrorCode = new Map() // 最近一次错误码（HTTP status 或 transport err.code）
    this.cooldownStartedAt = new Map() // 进入 cooldown 的起始时间戳（failureCounts 达阈值时刻）
    this.cooldownUntil = new Map() // 强制冷却截止时间（用于 captcha/risk-control）
    this.maxFailures = 3 // 最大失败次数
    this.cooldownPeriod = 5 * 60 * 1000 // 5分钟冷却期
  }

  /**
   * 设置账户列表
   * @param {Array} accounts - 账户列表
   */
  setAccounts(accounts) {
    if (!Array.isArray(accounts)) {
      logger.error('账户列表必须是数组', 'ACCOUNT')
      throw new Error('账户列表必须是数组')
    }
    
    this.accounts = [...accounts]
    this.currentIndex = 0
    
    // 清理不存在账户的记录
    this._cleanupRecords()
  }

  /**
   * 获取下一个可用的账户对象
   * @returns {Object|null} 账户对象或 null
   */
  getNextAccount() {
    if (this.accounts.length === 0) {
      logger.error('没有可用的账户', 'ACCOUNT')
      return null
    }

    const availableAccounts = this._getAvailableAccounts()
    if (availableAccounts.length === 0) {
      logger.warn('所有账户都不可用，使用轮询策略', 'ACCOUNT')
      return this._getAccountByRoundRobin()
    }

    // 从可用账户中选择最少使用的
    const selectedAccount = this._selectLeastUsedAccount(availableAccounts)
    this._recordUsage(selectedAccount.email)

    return selectedAccount
  }

  /**
   * 获取下一个可用账户，但排除指定 email（用于 chat 请求失败时切换账号）
   * 综合评分（chat 流量低 + inFlight 少 + 不在 cooldown 优先）
   * @param {string} [excludeEmail] - 排除该账户（重试时不发同一账号）
   * @returns {Object|null}
   */
  getNextAccountExcluding(excludeEmail) {
    if (this.accounts.length === 0) return null
    const available = this._getAvailableAccounts().filter(a => a.email !== excludeEmail)
    if (available.length === 0) {
      logger.warn(`没有 exclude=${excludeEmail || 'none'} 之外的可用账号`, 'ACCOUNT')
      return null
    }
    const ranked = this._rankByChatScore(available)
    const best = ranked[0]
    if (!best) return null
    this._recordUsage(best.email)
    return best
  }

  /**
   * 获取下一个可用账户，排除一组 email（用于媒体生成等需要逐个排除已失败账号的场景）
   * @param {Set<string>} excludeEmails - 排除的 email 集合
   * @returns {Object|null}
   */
  getNextAccountExcludingSet(excludeEmails) {
    if (this.accounts.length === 0) return null
    const excludeSet = excludeEmails instanceof Set ? excludeEmails : new Set(excludeEmails ? [excludeEmails] : [])
    const available = this._getAvailableAccounts().filter(a => !excludeSet.has(a.email))
    if (available.length === 0) {
      logger.warn(`没有可用账号（已排除 ${excludeSet.size} 个）`, 'ACCOUNT')
      return null
    }
    const ranked = this._rankByChatScore(available)
    const best = ranked[0]
    if (!best) return null
    this._recordUsage(best.email)
    return best
  }

  /**
   * 评分式选择（Redis-backed）。
   * - Redis 模式：从 Redis 读取 inFlight / failures / nextRetry / lastUsed
   * - file 模式：全部走 0
   * - 始终优先 excludeEmail 之外、stickyEmail 之内（如果 sticky 可用）的最低分账号
   *
   * @param {object} options { excludeEmail, stickyEmail }
   * @returns {Promise<Object|null>}
   */
  async getNextAccountByScore(options) {
    const opts = options || {}
    if (this.accounts.length === 0) return null

    // 同步先按本地 _isAccountAvailable 过滤（in-memory cooldown）
    const available = this._getAvailableAccounts().filter(a => a.email !== opts.excludeEmail)
    if (available.length === 0) {
      logger.warn(`没有 exclude=${opts.excludeEmail || 'none'} 之外的可用账号`, 'ACCOUNT')
      return null
    }

    // 再用 scorer 选最低分（scorer 内部会再过滤 nextRetry、token、expired）
    const chosen = await scorer.pickBestAccount(available, {
      excludeEmail: opts.excludeEmail,
      stickyEmail: opts.stickyEmail,
      now: Date.now()
    })
    if (chosen && chosen.email) {
      this._recordUsage(chosen.email)
    }
    return chosen
  }

  /**
   * 返回所有账号（不脱敏，调用方负责不要直接暴露给客户端）。
   * 给 request.js / dashboard 内部使用。
   * @returns {Array}
   */
  getAllAccountKeys() {
    return [...this.accounts]
  }

  /**
   * 综合评分 chat 候选账号
   * 评分（越低越优）：
   *   - 今日 chat input/output 总量（in_flight 越多越不利）
   * @param {Array} accounts
   * @returns {Array<Object>} 按 score 升序
   * @private
   */
  _rankByChatScore(accounts) {
    return accounts.map(acc => {
      const stats = acc.stats || { chat: { input: 0, output: 0 } }
      const chat = stats.chat || { input: 0, output: 0 }
      const chatTraffic = (chat.input || 0) + (chat.output || 0)
      const score = chatTraffic
      return { ...acc, _score: score }
    }).sort((a, b) => a._score - b._score)
  }

  /**
   * 获取下一个可用的账户令牌（向后兼容的便捷方法）
   * @returns {string|null} 账户令牌或null
   */
  getNextToken() {
    const account = this.getNextAccount()
    return account ? account.token : null
  }

  /**
   * 根据邮箱获取账户对象
   * @param {string} email - 邮箱地址
   * @returns {Object|null} 账户对象或 null
   */
  getAccountByEmail(email) {
    const account = this.accounts.find(acc => acc.email === email)
    if (!account) {
      logger.error(`未找到邮箱为 ${email} 的账户`, 'ACCOUNT')
      return null
    }

    if (!this._isAccountAvailable(account)) {
      logger.warn(`账户 ${email} 当前不可用`, 'ACCOUNT')
      return null
    }

    this._recordUsage(email)
    return account
  }

  /**
   * 获取指定邮箱的账户令牌（向后兼容的便捷方法）
   * @param {string} email - 邮箱地址
   * @returns {string|null} 账户令牌或null
   */
  getTokenByEmail(email) {
    const account = this.getAccountByEmail(email)
    return account ? account.token : null
  }

  /**
   * 记录账户传输层失败（影响 cooldown）
   * 仅在传输层错误（timeout/ECONNRESET 等）调用——HTTP 4xx/5xx 走 recordError
   * @param {string} email - 邮箱地址
   * @param {string|number} [code] - 错误码（err.code 或 HTTP status），用于 UI warn
   */
  recordFailure(email, code) {
    const currentFailures = this.failureCounts.get(email) || 0
    const nextFailures = currentFailures + 1
    this.failureCounts.set(email, nextFailures)

    // 同时填充 warn 指示状态（recordFailure 是 recordError 的超集）
    this.lastErrorAt.set(email, Date.now())
    if (code !== undefined && code !== null) {
      this.lastErrorCode.set(email, code)
    }

    // 达到阈值的瞬间标记 cooldown 起点（独立于 lastUsedTimes，失败也正确）
    if (nextFailures >= this.maxFailures && !this.cooldownStartedAt.has(email)) {
      this.cooldownStartedAt.set(email, Date.now())
      logger.warn(`账户 ${email} 失败次数达到上限，将进入冷却期`, 'ACCOUNT')
    }
  }

  /**
   * 记录账户错误（仅用于 UI warn 指示，不影响 cooldown）
   * HTTP 4xx/5xx 走这里——上游主动拒绝，账户本身有效，不应进入 cooldown
   * @param {string} email - 邮箱地址
   * @param {string|number} [code] - HTTP status 或错误码
   */
  recordError(email, code) {
    this.lastErrorAt.set(email, Date.now())
    if (code !== undefined && code !== null) {
      this.lastErrorCode.set(email, code)
    }
  }

  /**
   * 立即让账户进入本进程冷却期。
   * Redis next_retry 负责多 worker 共享；这里兜住 file/none 模式。
   * @param {string} email
   * @param {string|number} [code]
   * @param {number} [cooldownMs]
   */
  forceCooldown(email, code, cooldownMs = this.cooldownPeriod) {
    if (!email) return
    const now = Date.now()
    this.failureCounts.set(email, this.maxFailures)
    this.lastErrorAt.set(email, now)
    if (code !== undefined && code !== null) {
      this.lastErrorCode.set(email, code)
    }
    this.cooldownStartedAt.set(email, now)
    this.cooldownUntil.set(email, now + Math.max(1000, Number(cooldownMs) || this.cooldownPeriod))
  }

  /**
   * 重置账户失败计数（清除 cooldown）
   * 注意：不清理 lastErrorAt/lastErrorCode——它们由 endpoint 的 15 分钟窗口管理
   * @param {string} email - 邮箱地址
   */
  resetFailures(email) {
    this.failureCounts.delete(email)
    this.cooldownStartedAt.delete(email)
    this.cooldownUntil.delete(email)
  }

  /**
   * 获取账户统计信息
   * @returns {Object} 统计信息
   */
  getStats() {
    const total = this.accounts.length
    const available = this._getAvailableAccounts().length
    const inCooldown = total - available
    
    const usageStats = {}
    this.accounts.forEach(account => {
      const email = account.email
      const cooldownStart = this.cooldownStartedAt.get(email)
      const forcedCooldownUntil = this.cooldownUntil.get(email)
      usageStats[email] = {
        failures: this.failureCounts.get(email) || 0,
        lastUsed: this.lastUsedTimes.get(email) || null,
        available: this._isAccountAvailable(account),
        lastErrorAt: this.lastErrorAt.get(email) || null,
        lastErrorCode: this.lastErrorCode.get(email) || null,
        cooldownEndsAt: forcedCooldownUntil || (cooldownStart ? cooldownStart + this.cooldownPeriod : null)
      }
    })

    return {
      total,
      available,
      inCooldown,
      currentIndex: this.currentIndex,
      usageStats
    }
  }

  /**
   * 获取可用账户列表
   * @private
   */
  _getAvailableAccounts() {
    return this.accounts.filter(account => this._isAccountAvailable(account))
  }

  /**
   * 检查账户是否可用
   * @param {Object} account - 账户对象
   * @returns {boolean} 是否可用
   * @private
   */
  _isAccountAvailable(account) {
    if (!account.token) {
      return false
    }

    if (account.enabled === false) {
      return false
    }

    const forcedCooldownUntil = this.cooldownUntil.get(account.email)
    if (forcedCooldownUntil) {
      if (Date.now() < forcedCooldownUntil) {
        return false
      }
      this.cooldownUntil.delete(account.email)
      this.cooldownStartedAt.delete(account.email)
      this.failureCounts.delete(account.email)
    }

    // 基于 cooldownStartedAt（显式标记）而非 lastUsedTimes——
    // 后者对失败不更新，导致 cooldown 计算不准
    const cooldownStart = this.cooldownStartedAt.get(account.email)
    if (cooldownStart) {
      if (Date.now() - cooldownStart < this.cooldownPeriod) {
        return false // 仍在冷却期
      }
      // 冷却期结束，清理 cooldown 标记与失败计数（lastError* 不动，由 endpoint 管理 warn 窗口）
      this.cooldownStartedAt.delete(account.email)
      this.failureCounts.delete(account.email)
    }

    return true
  }

  /**
   * 选择最少使用的账户
   * @param {Array} accounts - 可用账户列表
   * @returns {Object} 选中的账户
   * @private
   */
  _selectLeastUsedAccount(accounts) {
    if (accounts.length === 1) {
      return accounts[0]
    }

    // 按最后使用时间排序，选择最久未使用的
    return accounts.reduce((least, current) => {
      const leastLastUsed = this.lastUsedTimes.get(least.email) || 0
      const currentLastUsed = this.lastUsedTimes.get(current.email) || 0
      
      return currentLastUsed < leastLastUsed ? current : least
    })
  }

  /**
   * 轮询策略获取账户对象
   * @returns {Object|null} 账户对象或null
   * @private
   */
  _getAccountByRoundRobin() {
    if (this.currentIndex >= this.accounts.length) {
      this.currentIndex = 0
    }

    const account = this.accounts[this.currentIndex]
    this.currentIndex++

    if (account && account.token && account.enabled !== false) {
      this._recordUsage(account.email)
      return account
    }

    // 如果当前账户无效，尝试下一个
    if (this.currentIndex < this.accounts.length) {
      return this._getAccountByRoundRobin()
    }

    return null
  }

  /**
   * 记录账户使用
   * @param {string} email - 邮箱地址
   * @private
   */
  _recordUsage(email) {
    this.lastUsedTimes.set(email, Date.now())
  }

  /**
   * 清理不存在账户的记录
   * @private
   */
  _cleanupRecords() {
    const currentEmails = new Set(this.accounts.map(acc => acc.email))

    const maps = [
      this.failureCounts,
      this.lastUsedTimes,
      this.lastErrorAt,
      this.lastErrorCode,
      this.cooldownStartedAt,
      this.cooldownUntil
    ]
    for (const map of maps) {
      for (const email of map.keys()) {
        if (!currentEmails.has(email)) {
          map.delete(email)
        }
      }
    }
  }

  /**
   * 重置所有统计数据
   */
  reset() {
    this.currentIndex = 0
    this.lastUsedTimes.clear()
    this.failureCounts.clear()
    this.lastErrorAt.clear()
    this.lastErrorCode.clear()
    this.cooldownStartedAt.clear()
    this.cooldownUntil.clear()
  }
}

module.exports = AccountRotator
