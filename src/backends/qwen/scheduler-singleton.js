/**
 * scheduler-singleton.js
 *
 * QwenScheduler singleton — lazy-initializes the scheduler from accountManager
 * on first access. Provides getScheduler() and getAccountIdByEmail() helpers,
 * plus convenience acquire()/release() wrappers that delegate to the
 * underlying scheduler instance.
 *
 * Design:
 *  - Lazy init: the scheduler is not created until the first request needs it.
 *  - AccountRuntime instances are created from accountManager's account list.
 *  - Config values (concurrency, queue size, timeout) are read from config/index.js.
 *    Both legacy `qwen*`-prefixed and short unprefixed keys are passed; the
 *    QwenScheduler constructor accepts either form.
 *  - All public methods are optional — callers must wrap in try/catch.
 */

const { QwenScheduler } = require('./scheduler')
const { AccountRuntime } = require('./account-runtime')
const accountManager = require('../../utils/account')
const config = require('../../config')

/** @type {QwenScheduler|null} */
let _scheduler = null

/**
 * Get or create the QwenScheduler singleton.
 *
 * Phase D2: prefers accountManager.accountRuntimes (pre-built by accountManager)
 * if available, so the scheduler and accountManager share the SAME AccountRuntime
 * instances. Falls back to building runtimes from accountTokens if accountManager
 * has not yet built them (defensive compatibility).
 *
 * @returns {QwenScheduler|null}
 */
function getScheduler() {
    if (_scheduler) return _scheduler

    if (!accountManager || !accountManager.isInitialized) return null

    let accountRuntimes
    // Phase D2: prefer accountManager's pre-built runtimes — single source of truth.
    if (accountManager.accountRuntimes && accountManager.accountRuntimes.size > 0) {
        accountRuntimes = accountManager.accountRuntimes
    } else {
        const accounts = accountManager.getAllAccountKeys
            ? accountManager.getAllAccountKeys()
            : (accountManager.accountTokens || [])

        if (!Array.isArray(accounts) || accounts.length === 0) return null

        accountRuntimes = new Map()
        for (const account of accounts) {
            if (!account || !account.email || !account.token) continue
            const rt = new AccountRuntime(account)
            accountRuntimes.set(rt.accountId, rt)
        }
    }

    if (accountRuntimes.size === 0) return null

    _scheduler = new QwenScheduler(accountRuntimes, {
        // Pass both short (unprefixed) and legacy (qwen-prefixed) keys so the
        // constructor sees the right value regardless of which form it checks.
        maxConcurrencyPerAccount: config.qwenMaxConcurrencyPerAccount,
        globalMaxConcurrency: config.qwenGlobalMaxConcurrency,
        maxQueueSize: config.qwenMaxQueueSize,
        queueTimeoutMs: config.qwenQueueTimeoutMs,
        qwenMaxConcurrencyPerAccount: config.qwenMaxConcurrencyPerAccount,
        qwenGlobalMaxConcurrency: config.qwenGlobalMaxConcurrency,
        qwenMaxQueueSize: config.qwenMaxQueueSize,
        qwenQueueTimeoutMs: config.qwenQueueTimeoutMs
    })

    return _scheduler
}

/**
 * Phase D2: Register an AccountRuntime with the singleton scheduler.
 *
 * Used by accountManager when accounts are loaded (initial batch) or when a
 * new account is added via addAccount / addAccountWithToken. If the scheduler
 * has not been initialized yet, this is a no-op — the runtime will be picked
 * up via accountManager.accountRuntimes when getScheduler() is first called.
 * If the scheduler already exists, the runtime is added (or replaced) in its
 * internal accounts Map and _accountInFlight counter is initialized.
 *
 * @param {import('./account-runtime').AccountRuntime} runtime
 */
function registerAccount(runtime) {
    if (!runtime || !runtime.accountId) return
    const sched = getScheduler()
    if (!sched) return
    sched.accounts.set(runtime.accountId, runtime)
    if (!sched._accountInFlight.has(runtime.accountId)) {
        sched._accountInFlight.set(runtime.accountId, 0)
    }
}

/**
 * Look up an accountId by email.
 * @param {string} email
 * @returns {string|null}
 */
function getAccountIdByEmail(email) {
    if (!_scheduler || !email) return null
    for (const [id, rt] of _scheduler.accounts) {
        if (rt.credentials && rt.credentials.email === email) return id
    }
    return null
}

/**
 * Convenience wrapper: acquire a lease on the singleton scheduler.
 *
 * Semantically equivalent to `getScheduler().acquire(opts)`, but throws a
 * 503 error if the scheduler has not been initialized.
 *
 * @param {Object} [opts] - see QwenScheduler#acquire() for full signature.
 * @returns {Promise<Object>} a lease object with `account`, `accountRuntime`,
 *          `leaseId`, `acquiredAt`, and `release(outcome)` properties.
 * @throws {Error} with status=503 if scheduler is not initialized.
 * @throws {Error} with status=429/499/503 — see QwenScheduler#acquire().
 */
async function acquire(opts) {
    const sched = getScheduler()
    if (!sched) {
        throw Object.assign(new Error('Scheduler not initialized'), { status: 503 })
    }
    return sched.acquire(opts)
}

/**
 * Convenience wrapper: release a lease on the singleton scheduler.
 *
 * Semantically equivalent to `getScheduler().release(leaseId, outcome)`.
 * Silently no-ops if the scheduler has not been initialized (e.g. during
 * shutdown) or the leaseId is unknown / already released.
 *
 * @param {string} leaseId
 * @param {'success'|'failure'|'incomplete'|'aborted'|'client_aborted'|'upstream_error'} [outcome]
 */
function release(leaseId, outcome) {
    if (!_scheduler) return
    _scheduler.release(leaseId, outcome)
}

module.exports = {
    getScheduler,
    getAccountIdByEmail,
    acquire,
    release,
    registerAccount
}
