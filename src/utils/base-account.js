/**
 * BaseAccountManager — DeepSeek 账号管理公共基类
 *
 * 提供：文件加载/保存、基础 CRUD、可用账号轮询、自动刷新定时器、统计
 * 子类覆盖：_getDefaultDataFile()、_afterLoad()、_filterAvailableAccounts()、autoRefreshTokens()
 */

const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

class BaseAccountManager {
  constructor(options = {}) {
    this.dataFile = options.dataFile || this._getDefaultDataFile();
    this._logPrefix = options.logPrefix || 'BaseAccount';
    this._logTag = options.logTag || 'BASE_ACCOUNT';
    this.accounts = [];
    this.isLoaded = false;
    this.refreshInterval = null;

    // 运行时状态（仅内存，永不持久化）
    // Map<email, { inFlight, failures, nextRetryAt, lastUsed }>
    this._runtimeState = new Map();
    this._saveTimer = null;
    this._savePending = false;

    this._loadAccounts();
  }
  // =================================================================
  // Runtime state — 运行时状态管理（仅内存，不写盘）
  // =================================================================

  /**
   * 获取账号运行时状态（懒初始化）
   */
  _getRuntimeState(email) {
    if (!email) return null;
    let st = this._runtimeState.get(email);
    if (!st) {
      st = { inFlight: 0, failures: 0, nextRetryAt: 0, lastUsed: 0 };
      this._runtimeState.set(email, st);
    }
    return st;
  }

  /**
   * 增加 inFlight 计数（选中有账号时调用）
   */
  trackInFlight(email) {
    const st = this._getRuntimeState(email);
    if (st) st.inFlight = (st.inFlight || 0) + 1;
  }

  /**
   * 释放 inFlight 计数（请求完成/失败时调用）
   * @param {string} email
   */
  releaseAccount(email) {
    const st = this._getRuntimeState(email);
    if (st) {
      st.inFlight = Math.max(0, (st.inFlight || 0) - 1);
      st.lastUsed = Date.now();
    }
  }

  /**
   * 记录一次失败（移除强制冷却时间计算，仅记录计数供可观测性参考）
   */
  recordRuntimeFailure(email) {
    const st = this._getRuntimeState(email);
    if (!st) return;
    st.failures = (st.failures || 0) + 1;
    st.nextRetryAt = 0; // 彻底废弃冷却，永不因失败锁定账号
  }

  /**
   * 清除失败计数
   */
  clearRuntimeFailures(email) {
    const st = this._getRuntimeState(email);
    if (st) {
      st.failures = 0;
      st.nextRetryAt = 0;
    }
  }

  /**
   * 获取运行时统计（用于诊断）
   */
  getRuntimeStats(email) {
    if (email) {
      const st = this._runtimeState.get(email);
      return st ? { ...st } : null;
    }
    const result = {};
    for (const [email, st] of this._runtimeState) {
      result[email] = { ...st };
    }
    return result;
  }

  // =================================================================
  // Debounced save — 防抖持久化
  // =================================================================

  /**
   * 500ms 防抖写入。多次连续调用只写一次盘。
   * 用于频繁但不关键的状态更新（stats 累计等）。
   */
  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._savePending = true;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (this._savePending) {
        this._savePending = false;
        this._saveAccountsSync();
      }
    }, 500);
  }

  /**
   * 立即将防抖队列写入磁盘（进程退出前调用）
   */
  _flushSave() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._savePending) {
      this._savePending = false;
      this._saveAccountsSync();
    }
  }

  // =================================================================
  // File I/O
  // =================================================================

  /**
   * 同步写盘（原来的 _saveAccounts 逻辑）
   */
  _saveAccountsSync() {
    try {
      const dir = path.dirname(this.dataFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.dataFile, JSON.stringify(this.accounts, null, 2), 'utf-8');
    } catch (err) {
      logger.error(`[${this._logPrefix}] 保存账号数据失败`, this._logTag, '', err);
    }
  }

  /**
   * 子类必须覆盖，返回数据文件路径
   */
  _getDefaultDataFile() {
    throw new Error('子类必须实现 _getDefaultDataFile()');
  }

  /**
   * 从文件加载账号数据
   */
  _loadAccounts() {
    try {
      if (fs.existsSync(this.dataFile)) {
        const raw = fs.readFileSync(this.dataFile, 'utf-8');
        this.accounts = JSON.parse(raw);
        if (!Array.isArray(this.accounts)) this.accounts = [];
        this._afterLoad(this.accounts);
        this.isLoaded = true;
        logger.info(`[${this._logPrefix}] 加载 ${this.accounts.length} 个账号`, this._logTag);
      } else {
        this.accounts = [];
        this.isLoaded = true;
        this._saveAccounts();
      }
    } catch (err) {
      logger.error(`[${this._logPrefix}] 加载账号数据失败`, this._logTag, '', err);
      this.accounts = [];
      this.isLoaded = true;
    }
  }

  /**
   * 加载后的后处理钩子（子类覆盖：补齐默认字段、ensureStats 等）
   */
  _afterLoad(accounts) {
    // 子类覆盖
  }

  /**
   * 保存账号数据到文件（同步写，需即时持久化的操作用此方法）
   * 如 addAccount / deleteAccount / refreshToken / markAccountMuted
   */
  _saveAccounts() {
    this._saveAccountsSync();
  }

  /**
   * 防抖保存（频繁调用时合并写入）
   * 如 accumulateStats 等不关键的状态
   */
  _saveAccountsDebounced() {
    this._scheduleSave();
  }

  /**
   * 获取所有账号
   */
  getAllAccounts(includePassword = false) {
    if (!this.isLoaded) this._loadAccounts();
    return this.accounts.map(a => includePassword ? { ...a } : { ...a, password: undefined });
  }

  /**
   * 删除账号
   */
  deleteAccount(email) {
    if (!this.isLoaded) this._loadAccounts();
    const idx = this.accounts.findIndex(a => a.email === email);
    if (idx === -1) return false;
    this.accounts.splice(idx, 1);
    this._saveAccounts();
    return true;
  }

  /**
   * 获取一个可用账号（评分策略：inFlight×100 + failures×10 + token/1000 + age 惩罚）
   *
   * 运行时状态（inFlight / failures / nextRetryAt）仅存内存，不写盘。
   * lastUsed 在每次 releaseAccount() 时更新内存状态，不写盘。
   *
   * 子类覆盖 _filterAvailableAccounts() 实现各自的过滤逻辑
   * （dpsk: 跳过 muted/cooldown）
   *
   * @param {string[]} [excludeEmails] - 需排除的邮箱集合
   * @returns {Promise<Object|null>} 选中的账号对象
   */
  async getAvailableAccount(excludeEmails = []) {
    if (!this.isLoaded) this._loadAccounts();

    const excludeSet = new Set(excludeEmails);
    if (excludeSet.size > 0) {
      logger.debug(`[${this._logPrefix}] getAvailableAccount exclude=${[...excludeSet].join(',')}`, this._logTag);
    }

    const candidates = this._filterAvailableAccounts(excludeSet);
    if (candidates.length === 0) {
      logger.warning?.(`[${this._logPrefix}] 无可用账号 (total=${this.accounts.length})`, this._logTag);
      return null;
    }

    // 评分（低分优先），跳过冷却中账号
    const now = Date.now();
    const scored = [];
    for (const acc of candidates) {
      const st = this._getRuntimeState(acc.email);
      // 检查运行时冷却
      if (st && st.nextRetryAt && st.nextRetryAt > now) continue;
      const score = this._scoreAccount(acc, st, now);
      scored.push({ account: acc, score });
    }

    if (scored.length === 0) {
      logger.warning?.(`[${this._logPrefix}] 候选账号全部在冷却中`, this._logTag);
      return null;
    }

    scored.sort((a, b) => a.score - b.score);
    const chosen = scored[0].account;

    // 追踪运行时状态（不写盘）
    this.trackInFlight(chosen.email);
    logger.debug(
      `[${this._logPrefix}] 选中账号 ${chosen.email} score=${scored[0].score.toFixed(1)} runtime=${JSON.stringify(this._getRuntimeState(chosen.email))}`,
      this._logTag,
    );

    return chosen;
  }

  /**
   * 评分公式：score 越低越优先
   * - inFlight×100 + failures×10 + token/1000 + age 惩罚
   * - 冷却中（nextRetryAt > now）返回 Infinity，在调用方过滤
   */
  _scoreAccount(account, runtimeState, now) {
    const st = runtimeState || this._getRuntimeState(account.email);
    if (!st) return 0;

    const inFlight = st.inFlight || 0;
    const failures = st.failures || 0;
    const lastUsed = st.lastUsed || 0;
    const stats = account.stats?.chat || {};
    const tokenUsage = (Number(stats.input) || 0) + (Number(stats.output) || 0);

    let score = 0;
    score += 100 * inFlight;
    score += 10 * failures;
    score += 1 * (tokenUsage / 1000);
    if (lastUsed > 0 && (now - lastUsed) < 60000) {
      score += 5 * Math.max(0, 1 - (now - lastUsed) / 60000);
    }
    return score;
  }

  /**
   * 子类覆盖：从 accounts 中过滤出当前可用的账号
   * @param {Set} excludeSet - 需排除的邮箱集合
   * @returns {Array} 过滤后的账号数组
   */
  _filterAvailableAccounts(excludeSet) {
    return this.accounts.filter(a => a.enabled && a.token && !excludeSet.has(a.email));
  }

  /**
   * 获取账号统计
   */
  getAccountStats() {
    if (!this.isLoaded) this._loadAccounts();
    return {
      total: this.accounts.length,
      enabled: this.accounts.filter(a => a.enabled).length,
      withToken: this.accounts.filter(a => a.enabled && a.token).length,
    };
  }

  /**
   * 启动自动刷新定时器
   */
  startAutoRefresh() {
    this.stopAutoRefresh();
    const config = require('../config');
    if (config.autoRefresh) {
      const intervalMs = (config.autoRefreshInterval || 6 * 60 * 60) * 1000;
      this.refreshInterval = setInterval(() => {
        this.autoRefreshTokens().catch(err => {
          logger.error(`[${this._logPrefix}] 自动刷新任务异常`, this._logTag, '', err);
        });
      }, intervalMs);
      logger.info(`[${this._logPrefix}] 已启动自动刷新，间隔 ${intervalMs / 1000}s`, this._logTag);
    }
  }

  /**
   * 停止自动刷新定时器
   */
  stopAutoRefresh() {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = null;
    }
  }

  /**
   * 批量刷新 token（子类覆盖实现具体刷新逻辑）
   */
  async autoRefreshTokens() {
    // 子类覆盖
    return 0;
  }
}

module.exports = BaseAccountManager;
