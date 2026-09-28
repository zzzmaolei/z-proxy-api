/**
 * account-scorer.js
 * 评分式 chat 账号选择：score 越低越优先
 *
 * 评分公式（v1，基线可调）：
 *   score = inFlightWeight * inFlight
 *         + tokenWeight     * (input + output) / 1000
 *         + failureWeight   * failures
 *         + ageWeight       * max(0, 1 - (now - lastUsed) / 60s)
 *
 *   单账号并发上限：MAX_INFLIGHT_PER_ACCOUNT = 2
 *     - inFlight < 2：正常计分
 *     - inFlight >= 2：+W_INFLIGHT_OVER_LIMIT (10000) 加重惩罚，确保优先选未超限的账号
 *     - 所有账号都超限时仍可选（不会拒绝请求），选分数最低的
 *
 *   过滤：
 *     - nextRetry > now：完全跳过（冷却中）
 *     - token 缺失 / 已过期：跳过
 *
 *   inFlight 权重：100          // 一个 inFlight 等价 100k token 的"占用感"
 *   token 权重：  1             // 1 / 1000 token
 *   failure 权重：10            // 一次失败 ≈ 10 个 inFlight
 *   age 权重：   5              // 60 秒内刚用过的轻微惩罚
 *
 *   → 5 个账号相同 input/output 0，1 个 inFlight=1 + 1 个 failures=3
 *     A(inFlight=0) score = 0
 *     B(inFlight=1) score = 100
 *     C(failures=3)  score = 30
 *     A 仍然赢，但 B 不至于完全压死 A
 *
 * 注意：评分只是辅助选择。实际换号仍由 request.js 在失败/异常路径上做。
 */

const config = require('../config')
const pool = require('./account-pool-redis')

// 权重
const W_INFLIGHT = 100
const W_TOKEN = 1
const W_FAILURE = 10
const W_AGE = 5
const AGE_WINDOW_MS = 60 * 1000

// 单账号最大并发 inFlight 数（超过后加重惩罚，但不会被完全排除）
const MAX_INFLIGHT_PER_ACCOUNT = 2
// 超过上限时的额外惩罚分（确保只有在所有账号都超限时才选中超限账号）
const W_INFLIGHT_OVER_LIMIT = 10000

/**
 * 评估单个账号的可用性 + 分数。
 * @param {object} account
 * @param {object} state { inFlight, failures, nextRetry, lastUsed }
 * @param {object} options { now }
 * @returns {null | { score: number, reasons: string[] }}
 */
const scoreAccount = (account, state, options) => {
  if (!account || !account.email) return null
  const now = (options && options.now) || Date.now()

  // token 缺失：跳过
  if (!account.token) return null

  // expires 已过：跳过
  if (account.expires) {
    const expMs = parseExpires(account.expires)
    if (expMs && expMs > 0 && expMs < now) return null
  }

  // 冷却中：跳过
  if (state && state.nextRetry && state.nextRetry > now) return null

  const inFlight = (state && state.inFlight) || 0
  const failures = (state && state.failures) || 0
  const lastUsed = (state && state.lastUsed) || 0

  // 今日 token 累计（来自 accountManager 自身 stats）
  const today = account.stats && account.stats.chat ? account.stats.chat : { input: 0, output: 0 }
  const tokens = (Number(today.input) || 0) + (Number(today.output) || 0)

  let score = 0
  // 单账号并发上限：未超限正常计分，超限加重惩罚（确保所有账号超限时仍可选，但优先选未超限的）
  if (inFlight >= MAX_INFLIGHT_PER_ACCOUNT) {
    score += W_INFLIGHT_OVER_LIMIT + W_INFLIGHT * (inFlight - MAX_INFLIGHT_PER_ACCOUNT + 1)
  } else {
    score += W_INFLIGHT * inFlight
  }
  score += W_TOKEN * (tokens / 1000)
  score += W_FAILURE * failures

  if (lastUsed > 0) {
    const dt = now - lastUsed
    if (dt < AGE_WINDOW_MS) {
      // 越接近 0，age 因子越接近 1；越接近 60s，越接近 0
      score += W_AGE * Math.max(0, 1 - dt / AGE_WINDOW_MS)
    }
  }

  return { score, reasons: [] }
}

const parseExpires = (expires) => {
  if (!expires) return 0
  if (typeof expires === 'number') return expires > 1e12 ? expires : expires * 1000
  if (typeof expires === 'string') {
    // ISO
    if (/^\d+$/.test(expires)) {
      const n = Number(expires)
      return n > 1e12 ? n : n * 1000
    }
    const t = Date.parse(expires)
    return Number.isFinite(t) ? t : 0
  }
  return 0
}

/**
 * 从候选列表中按分数选择最佳账号。
 * 若 excludeEmail 存在，则先把它排除。
 * 若 stickyEmail 存在且可用（分数有效），优先返回。
 *
 * @param {Array} accounts
 * @param {object} options { excludeEmail, stickyEmail, now }
 * @returns {Promise<object|null>}
 */
const pickBestAccount = async (accounts, options) => {
  const opts = options || {}
  const exclude = opts.excludeEmail
  const sticky = opts.stickyEmail
  const now = opts.now || Date.now()

  if (!Array.isArray(accounts) || accounts.length === 0) return null

  // 1) 一次性取所有账号的 Redis 状态
  const emails = accounts.map((a) => a && a.email).filter(Boolean)
  const states = await pool.getStates(emails)

  // 2) 计算每个候选的分数
  const scored = []
  for (const a of accounts) {
    if (!a || !a.email) continue
    if (exclude && a.email === exclude) continue
    const s = scoreAccount(a, states[a.email], { now })
    if (!s) continue
    scored.push({ account: a, score: s.score })
  }

  if (scored.length === 0) return null

  // 3) 粘滞账号：若仍在候选里且 score 合理，优先用
  if (sticky) {
    const stickyEntry = scored.find((e) => e.account.email === sticky)
    if (stickyEntry) {
      // 粘滞的轻微加成：score -1 避免它被"刚用过"的微弱惩罚压制
      stickyEntry.score -= 1
    }
  }

  // 4) 排序取最低
  scored.sort((x, y) => x.score - y.score)
  return scored[0].account
}

module.exports = {
  scoreAccount,
  pickBestAccount,
  // 暴露给测试
  W_INFLIGHT,
  W_TOKEN,
  W_FAILURE,
  W_AGE,
  AGE_WINDOW_MS,
  MAX_INFLIGHT_PER_ACCOUNT,
  W_INFLIGHT_OVER_LIMIT
}
