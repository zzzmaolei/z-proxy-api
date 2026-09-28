/**
 * DeepSeek 账号管理器
 *
 * 参考 Qwen 路线的账号处理思路：
 *   - 账号数据独立存储（data/dpsk-data.json），与 Qwen 的 data/qwen-data.json 隔离
 *   - 支持自动登录、token 刷新、账号状态追踪
 *   - 多账号轮询，失败账号自动跳过
 *
 * 与 Qwen 路线的主要差异：
 *   - 禁言状态：DeepSeek 通过 biz_code=5 或 user.chat.is_muted 识别，标记 mutedUntil
 *   - 登录接口：POST /api/v0/users/login 返回 biz_data.user.token
 *   - 不需要复杂的 cookie/SSXMOD 管理
 */

const path = require('path');
const os = require('os');
const { logger } = require('../../utils/logger');
const { accountLogId } = require('../../utils/account-log-id');
const BaseAccountManager = require('../../utils/base-account');
const dpskFingerprint = require('./dpsk-fingerprint');

const isUnitTestRuntime = !!process.env.NODE_TEST_CONTEXT
  && String(process.env.ZPROXY_TEST_LOAD_ENV || '').toLowerCase() !== 'true';
const DATA_FILE = isUnitTestRuntime
  ? path.join(os.tmpdir(), `zproxy-api-dpsk-test-${process.pid}.json`)
  : path.join(__dirname, '..', '..', '..', 'data', 'dpsk-data.json');
const STATS_HISTORY_RETENTION_DAYS = 90;
const BASE_MODEL_SUFFIX_RE = /-(?:thinking|search|image|video|images|videos|tts|asr|ocr|coding|coder|vision|reasoning)$/i;

const getDateKey = (date = new Date()) => {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const normalizeBaseModel = (model) => typeof model === 'string' && model
  ? model.replace(BASE_MODEL_SUFFIX_RE, '')
  : '';

const cloneChatStats = (chat = {}) => ({
  input: Number(chat.input) || 0,
  output: Number(chat.output) || 0,
  requests: Number(chat.requests) || 0,
  byProvider: { ...(chat.byProvider || {}) },
  byModel: { ...(chat.byModel || {}) },
});

/**
 * 默认 stats 结构
 */
function createDefaultStats() {
  return {
    chat: { input: 0, output: 0, requests: 0, byProvider: {}, byModel: {} },
  };
}

/**
 * 确保账号有 stats 和 statsHistory 字段
 */
function ensureStats(account) {
  if (!account) return;
  if (!account.stats || typeof account.stats !== 'object') {
    account.stats = createDefaultStats();
  }
  if (!account.stats.chat || typeof account.stats.chat !== 'object') {
    account.stats.chat = createDefaultStats().chat;
  }
  account.stats.chat.input = Number(account.stats.chat.input) || 0;
  account.stats.chat.output = Number(account.stats.chat.output) || 0;
  account.stats.chat.requests = Number(account.stats.chat.requests) || 0;
  if (!account.stats.chat.byProvider || typeof account.stats.chat.byProvider !== 'object') account.stats.chat.byProvider = {};
  if (!account.stats.chat.byModel || typeof account.stats.chat.byModel !== 'object') account.stats.chat.byModel = {};
  if (!account.statsHistory || typeof account.statsHistory !== 'object') {
    account.statsHistory = {};
  }
}

class DpskAccountManager extends BaseAccountManager {
  constructor() {
    super({
      dataFile: DATA_FILE,
      logPrefix: 'DPSK-Account',
      logTag: 'DPSK_ACCOUNT',
    });
    this._statsRolloverTimer = null;
    this._scheduleStatsRollover();
    this._syncSchedulerAccounts();
  }

  _getDefaultDataFile() {
    return DATA_FILE;
  }

  _afterLoad(accounts) {
    accounts.forEach(ensureStats);
    const enabled = accounts.filter(a => a.enabled);
    const withToken = enabled.filter(a => a.token);
    const muted = accounts.filter(a => a.mutedUntil);
    logger.info(
      `[DPSK-Account] 账号加载完成: ${accounts.length} 总 / ${enabled.length} 启用 / ${withToken.length} 有token` +
      (muted.length ? ` / ${muted.length} 禁言` : ''),
      'DPSK_ACCOUNT'
    );
  }

  /**
   * Return the account snapshot consumed by the provider-scoped scheduler.
   * Runtime-only cooldown state is intentionally included without being
   * persisted to disk.
   */
  getSchedulerAccounts() {
    if (!this.isLoaded) this._loadAccounts();
    return this.accounts.map(account => {
      const runtime = this._getRuntimeState(account.email);
      return {
        accountId: account.accountId,
        email: account.email,
        password: account.password || '',
        token: account.token || '',
        enabled: account.enabled !== false,
        mutedUntil: account.mutedUntil || null,
        proxy: account.proxy || null,
        cooldownUntil: runtime?.nextRetryAt || 0,
      };
    });
  }

  _syncSchedulerAccounts() {
    try {
      const scheduler = require('./scheduler-singleton');
      scheduler.syncAccounts(this.getSchedulerAccounts());
    } catch (error) {
      logger.debug?.(`[DPSK-Account] scheduler sync deferred: ${error.message}`, 'DPSK_ACCOUNT');
    }
  }

  _scheduleStatsRollover() {
    if (this._statsRolloverTimer) clearTimeout(this._statsRolloverTimer);
    const next = new Date();
    next.setHours(24, 0, 2, 0);
    this._statsRolloverTimer = setTimeout(() => {
      this._rolloverStats();
      this._scheduleStatsRollover();
    }, Math.max(1000, next.getTime() - Date.now()));
    this._statsRolloverTimer.unref?.();
  }

  _rolloverStats() {
    const today = getDateKey();
    const cutoff = getDateKey(new Date(Date.now() - STATS_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000));
    let changed = false;
    for (const account of this.accounts) {
      ensureStats(account);
      const statsDate = account.statsDate;
      if (statsDate && statsDate !== today) {
        const chat = cloneChatStats(account.stats.chat);
        if (chat.input || chat.output || chat.requests) account.statsHistory[statsDate] = { chat };
        account.stats = createDefaultStats();
        changed = true;
      }
      account.statsDate = today;
      for (const key of Object.keys(account.statsHistory)) {
        if (key < cutoff) { delete account.statsHistory[key]; changed = true; }
      }
    }
    if (changed) this._saveAccounts();
  }

  _filterAvailableAccounts(excludeSet) {
    const now = Date.now();
    return this.accounts.filter(a => {
      if (!a.enabled || !a.token) return false;
      if (excludeSet.has(a.email)) return false;
      // 跳过被禁言且未到期的账号（mutedUntil 来自服务端，需要持久化）
      if (a.mutedUntil) {
        const muteUntilMs = typeof a.mutedUntil === 'number'
          ? a.mutedUntil * 1000
          : new Date(a.mutedUntil).getTime();
        if (muteUntilMs > now) return false;
      }
      // 运行时冷却（nextRetryAt / cooldown）由基类的评分循环处理，不在此过滤
      return true;
    });
  }

  /**
   * 添加账号
   */
  addAccount(email, password, token = null, proxy = null) {
    if (!this.isLoaded) this._loadAccounts();

    const exists = this.accounts.find(a => a.email === email);
    if (exists) {
      exists.password = password;
      if (token) exists.token = token;
      if (proxy !== undefined) exists.proxy = proxy;
      exists.enabled = true;
      this._saveAccounts();
      this._syncSchedulerAccounts();
      return { ...exists, password: undefined };
    }

    const account = {
      email,
      password,
      token: token || null,
      enabled: true,
      lastUsed: null,
      createdAt: new Date().toISOString(),
      proxy: proxy || null,
      stats: createDefaultStats(),
    };
    this.accounts.push(account);
    this._saveAccounts();
    this._syncSchedulerAccounts();
    return { ...account, password: undefined };
  }

  /**
   * 更新账号
   */
  updateAccount(email, updates) {
    if (!this.isLoaded) this._loadAccounts();

    const account = this.accounts.find(a => a.email === email);
    if (!account) return null;

    if (updates.token !== undefined) account.token = updates.token;
    if (updates.enabled !== undefined) account.enabled = updates.enabled;
    if (updates.password !== undefined) account.password = updates.password;
    if (updates.proxy !== undefined) account.proxy = updates.proxy;
    account.lastUsed = new Date().toISOString();

    this._saveAccounts();
    this._syncSchedulerAccounts();
    return { ...account, password: undefined };
  }

  deleteAccount(email) {
    const removed = super.deleteAccount(email);
    if (removed) this._syncSchedulerAccounts();
    return removed;
  }

  /**
   * 按邮箱查找账号
   */
  getAccountByEmail(email) {
    if (!this.isLoaded) this._loadAccounts();
    if (!email) return null;
    const account = this.accounts.find(a => a.email === email);
    if (!account) return null;
    return {
      email: account.email,
      token: account.token,
      enabled: account.enabled,
      mutedUntil: account.mutedUntil,
      proxy: account.proxy || null,
      fingerprint: this.getFingerprint(email),
    };
  }

  /**
   * 标记账号失败（不设置强制冷却，不锁定账号）
   */
  markAccountFailed(email, ms = null, reason = '') {
    if (!this.isLoaded) this._loadAccounts();
    const account = this.accounts.find(a => a.email === email);
    if (!account) return null;
    this.recordRuntimeFailure(email);
    this._syncSchedulerAccounts();
    logger.warn(`[DPSK-Account] 账号 ${accountLogId(email)} 发生失败 (reason=${reason || '-'}, failures=${(this._getRuntimeState(email) || {}).failures || 0})`, 'DPSK_ACCOUNT');
    return { ...account, password: undefined };
  }

  /**
   * 标记账号被禁言
   */
  markAccountMuted(email, muteUntil) {
    if (!this.isLoaded) this._loadAccounts();
    const account = this.accounts.find(a => a.email === email);
    if (!account) return null;

    account.mutedUntil = muteUntil;
    account.lastUsed = new Date().toISOString();
    this._saveAccounts();
    this._syncSchedulerAccounts();

    const muteDate = new Date(muteUntil * 1000).toISOString();
    logger.warn(`[DPSK-Account] 账号 ${accountLogId(email)} 已被禁言，直到 ${muteDate}`, 'DPSK_ACCOUNT');
    return { ...account, password: undefined };
  }

  /**
   * 清除账号禁言状态
   */
  clearAccountMuted(email) {
    if (!this.isLoaded) this._loadAccounts();
    const account = this.accounts.find(a => a.email === email);
    if (!account) return null;
    delete account.mutedUntil;
    this._saveAccounts();
    this._syncSchedulerAccounts();
    logger.info(`[DPSK-Account] 已清除账号 ${accountLogId(email)} 的禁言状态`, 'DPSK_ACCOUNT');
    return { ...account, password: undefined };
  }

  /**
   * 释放账号（请求完成/失败时调用，减少 inFlight 计数，仅内存操作）
   */
  releaseAccount(email) {
    if (!email) return;
    BaseAccountManager.prototype.releaseAccount.call(this, email);
  }

  /**
   * 获取账号确定性指纹（根据 email hash 分配，不写盘）
   */
  getFingerprint(email) {
    return dpskFingerprint.getFingerprint(email);
  }

  /**
   * 刷新账号 token
   */
  async refreshToken(email) {
    if (!this.isLoaded) this._loadAccounts();

    const account = this.accounts.find(a => a.email === email);
    if (!account) throw new Error('账号不存在');

    const dpskClient = require('./dpsk-client');
    const result = await dpskClient.login(account.email, account.password);

    account.token = result.token;
    account.lastUsed = new Date().toISOString();
    this._syncSchedulerAccounts();

    if (result.user?.chat?.is_muted && result.user?.chat?.mute_until) {
      account.mutedUntil = result.user.chat.mute_until;
      logger.warn(`[DPSK-Account] 账号 ${accountLogId(email)} 登录后发现已被禁言，直到 ${new Date(result.user.chat.mute_until * 1000).toISOString()}`, 'DPSK_ACCOUNT');
    } else {
      delete account.mutedUntil;
    }
    this._syncSchedulerAccounts();

    this._saveAccounts();
    logger.info(`[DPSK-Account] 账号 ${accountLogId(email)} token 刷新成功`, 'DPSK_ACCOUNT');
    return { ...account, password: undefined };
  }

  /**
   * 批量刷新所有已启用账号的 token
   */
  async autoRefreshTokens() {
    if (!this.isLoaded) this._loadAccounts();
    const enabledAccounts = this.accounts.filter(a => a.enabled && a.token);
    if (enabledAccounts.length === 0) return 0;

    logger.info(`[DPSK-Account] 开始自动刷新 token，共 ${enabledAccounts.length} 个账号`, 'DPSK_ACCOUNT');
    let refreshedCount = 0;
    for (const acc of enabledAccounts) {
      try {
        await this.refreshToken(acc.email);
        refreshedCount++;
      } catch (e) {
        logger.warn(`[DPSK-Account] 自动刷新 ${accountLogId(acc.email)} 失败: ${e.message}`, 'DPSK_ACCOUNT');
      }
    }
    logger.info(`[DPSK-Account] 自动刷新完成，成功 ${refreshedCount}/${enabledAccounts.length}`, 'DPSK_ACCOUNT');
    return refreshedCount;
  }

  /**
   * 累加账号统计
   */
  accumulateStats(email, kind, delta) {
    if (!email || !delta) return;
    if (!this.isLoaded) this._loadAccounts();
    const account = this.accounts.find(a => a.email === email);
    if (!account) return;
    this._rolloverStats();
    ensureStats(account);

    const input = Number(delta.input) || 0;
    const output = Number(delta.output) || 0;

    if (kind === 'chat') {
      account.stats.chat.input += input;
      account.stats.chat.output += output;
      account.stats.chat.requests += Number(delta.requests) || 1;
      const provider = delta.provider === 'qwen' ? 'qwen' : 'dpsk';
      const providerStats = account.stats.chat.byProvider[provider] || { input: 0, output: 0, requests: 0 };
      providerStats.input += input;
      providerStats.output += output;
      providerStats.requests += Number(delta.requests) || 1;
      account.stats.chat.byProvider[provider] = providerStats;
      const model = normalizeBaseModel(delta.model);
      if (model) {
        const modelStats = account.stats.chat.byModel[model] || { input: 0, output: 0, requests: 0, provider };
        modelStats.input += input;
        modelStats.output += output;
        modelStats.requests += Number(delta.requests) || 1;
        modelStats.provider = provider;
        account.stats.chat.byModel[model] = modelStats;
      }
      account.statsDate = getDateKey();
    }
    this._saveAccountsDebounced();
  }

  /**
   * 获取所有账号的统计（含真实 status）
   */
  getAllAccountStats() {
    if (!this.isLoaded) this._loadAccounts();
    const now = Date.now();
    return this.accounts.map(acc => {
      ensureStats(acc);
      const rt = this._getRuntimeState(acc.email);

      let kind = 'active';
      let cooldownEndsAt = null;

      // 1. 检查禁言状态（最高优先级）
      if (acc.mutedUntil) {
        const muteUntilMs = typeof acc.mutedUntil === 'number'
          ? acc.mutedUntil * 1000
          : new Date(acc.mutedUntil).getTime();
        if (muteUntilMs > now) {
          kind = 'cooldown';
          cooldownEndsAt = muteUntilMs;
        }
      }

      // 2. 检查运行时冷却（nextRetryAt）
      if (kind === 'active' && rt && rt.nextRetryAt && rt.nextRetryAt > now) {
        kind = 'cooldown';
        cooldownEndsAt = rt.nextRetryAt;
      }

      // 3. 检查运行时失败次数（warn）
      if (kind === 'active' && rt && rt.failures > 0) {
        kind = 'warn';
      }

      return {
        email: acc.email,
        stats: acc.stats,
        status: {
          kind,
          cooldownEndsAt,
          lastErrorAt: rt?.lastUsed || null,
          lastErrorCode: rt?.failures > 0 ? rt.failures : null,
        },
      };
    });
  }

  /**
   * 获取所有账号 key 列表（含完整 stats/statsHistory）
   */
  getAllAccountKeys() {
    if (!this.isLoaded) this._loadAccounts();
    return this.accounts.map(acc => {
      ensureStats(acc);
      return {
        email: acc.email,
        stats: acc.stats,
        statsHistory: acc.statsHistory,
      };
    });
  }

  /**
   * 获取今天的日期 key（YYYY-MM-DD）
   */
  getTodayKey() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }
}

// 单例 + 自动刷新初始化
const instance = new DpskAccountManager();
instance.startAutoRefresh();

// 进程退出前刷新防抖写入
process.on('exit', () => {
  try { instance._flushSave(); } catch (_) { /* ignore */ }
});
process.on('SIGINT', () => {
  try { instance._flushSave(); } catch (_) { /* ignore */ }
  process.exit(0);
});
process.on('SIGTERM', () => {
  try { instance._flushSave(); } catch (_) { /* ignore */ }
  process.exit(0);
});

module.exports = {
  getAllAccounts: (includePassword) => instance.getAllAccounts(includePassword),
  addAccount: (email, password, token, proxy) => instance.addAccount(email, password, token, proxy),
  updateAccount: (email, updates) => instance.updateAccount(email, updates),
  deleteAccount: (email) => instance.deleteAccount(email),
  getAvailableAccount: (excludeEmails) => instance.getAvailableAccount(excludeEmails),
  getSchedulerAccounts: () => instance.getSchedulerAccounts(),
  syncSchedulerAccounts: () => instance._syncSchedulerAccounts(),
  getAccountByEmail: (email) => instance.getAccountByEmail(email),
  markAccountMuted: (email, muteUntil) => instance.markAccountMuted(email, muteUntil),
  markAccountFailed: (email, ms, reason) => instance.markAccountFailed(email, ms, reason),
  clearAccountMuted: (email) => instance.clearAccountMuted(email),
  refreshToken: (email) => instance.refreshToken(email),
  getAccountStats: () => instance.getAccountStats(),
  autoRefreshTokens: () => instance.autoRefreshTokens(),
  startAutoRefresh: () => instance.startAutoRefresh(),
  stopAutoRefresh: () => instance.stopAutoRefresh(),
  accumulateStats: (email, kind, delta) => instance.accumulateStats(email, kind, delta),
  getAllAccountStats: () => instance.getAllAccountStats(),
  getAllAccountKeys: () => instance.getAllAccountKeys(),
  getTodayKey: () => instance.getTodayKey(),
  releaseAccount: (email) => instance.releaseAccount(email),
  getFingerprint: (email) => instance.getFingerprint(email),
  getRuntimeStats: (email) => instance.getRuntimeStats(email),
  ensureStats,
};
