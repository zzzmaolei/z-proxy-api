/**
 * DeepSeek scheduler singleton.
 *
 * This module owns only the DeepSeek scheduler instance. Account data is
 * supplied by dpsk-account through syncAccounts(), which keeps this module
 * independent from the account manager's initialization cycle.
 */

const { AccountRuntime } = require('../../shared/account-runtime')
const { AccountScheduler } = require('../../shared/account-scheduler')
const schedulerRegistry = require('../../shared/provider-scheduler-registry')
const config = require('../../config')

const PROVIDER_ID = 'deepseek'
let _scheduler = null

function schedulerConfig() {
    return {
        providerId: PROVIDER_ID,
        maxConcurrencyPerAccount: config.dpskMaxConcurrencyPerAccount,
        globalMaxConcurrency: config.dpskGlobalMaxConcurrency,
        maxQueueSize: config.dpskMaxQueueSize,
        queueTimeoutMs: config.dpskQueueTimeoutMs,
        routingStrategy: config.dpskRoutingStrategy,
        minPacingIntervalMs: config.dpskMinPacingIntervalMs,
    }
}

function ensureScheduler() {
    if (_scheduler) return _scheduler

    _scheduler = new AccountScheduler(new Map(), schedulerConfig())
    schedulerRegistry.register(PROVIDER_ID, _scheduler, { replace: true })
    return _scheduler
}

function findRuntimeByEmail(scheduler, email) {
    if (!email) return null
    for (const runtime of scheduler.accounts.values()) {
        if (runtime.email === email) return runtime
    }
    return null
}

function accountIsMuted(mutedUntil) {
    if (!mutedUntil) return false
    const timestamp = typeof mutedUntil === 'number'
        ? mutedUntil * 1000
        : new Date(mutedUntil).getTime()
    return Number.isFinite(timestamp) && timestamp > Date.now()
}

/**
 * Synchronize the current DeepSeek account snapshot into stable runtime
 * objects. Existing objects are updated in place so active leases remain
 * releasable even when a token or account flag changes.
 *
 * @param {Array<Object>} accounts
 * @returns {AccountScheduler}
 */
function syncAccounts(accounts = []) {
    const scheduler = ensureScheduler()
    const seen = new Set()

    for (const account of Array.isArray(accounts) ? accounts : []) {
        if (!account || !account.email) continue

        let runtime = account.accountId
            ? scheduler.accounts.get(account.accountId)
            : null
        runtime = runtime || findRuntimeByEmail(scheduler, account.email)
        if (!runtime) {
            runtime = new AccountRuntime(account)
        }

        const muted = accountIsMuted(account.mutedUntil)
        const eligible = account.enabled !== false && !!account.token && !muted
        const metadata = {
            email: account.email,
            token: account.token,
            password: account.password,
            enabled: account.enabled !== false,
            proxy: account.proxy || null,
            mutedUntil: account.mutedUntil || null,
            schedulerEligible: eligible,
        }
        if (Number(account.cooldownUntil) > 0) {
            metadata.cooldownUntil = Number(account.cooldownUntil)
        }
        runtime.syncFromAccount(metadata)

        scheduler.accounts.set(runtime.accountId, runtime)
        if (!scheduler._accountInFlight.has(runtime.accountId)) {
            scheduler._accountInFlight.set(runtime.accountId, 0)
        }
        seen.add(runtime.accountId)
    }

    // Removed/disabled accounts stop receiving new leases immediately. A
    // runtime with an active lease remains as a tombstone until it is idle.
    for (const [accountId, runtime] of scheduler.accounts) {
        if (seen.has(accountId)) continue
        runtime.schedulerEligible = false
        runtime.enabled = false
        const inFlight = scheduler._accountInFlight.get(accountId) || 0
        if (inFlight === 0) {
            scheduler.accounts.delete(accountId)
            scheduler._accountInFlight.delete(accountId)
        }
    }

    return scheduler
}

function getScheduler() {
    const scheduler = ensureScheduler()
    try {
        const accountManager = require('./dpsk-account')
        const accounts = typeof accountManager.getSchedulerAccounts === 'function'
            ? accountManager.getSchedulerAccounts()
            : accountManager.getAllAccounts?.(true)
        if (Array.isArray(accounts)) syncAccounts(accounts)
    } catch (_) {
        // The account manager may be mid-initialization; the next access will sync.
    }
    return scheduler
}

function getAccountIdByEmail(email) {
    const scheduler = getScheduler()
    return findRuntimeByEmail(scheduler, email)?.accountId || null
}

function registerAccount(runtime) {
    if (!runtime || !runtime.accountId) return null
    const scheduler = ensureScheduler()
    scheduler.accounts.set(runtime.accountId, runtime)
    if (!scheduler._accountInFlight.has(runtime.accountId)) {
        scheduler._accountInFlight.set(runtime.accountId, 0)
    }
    return runtime
}

async function acquire(opts) {
    return getScheduler().acquire(opts)
}

function release(leaseId, outcome) {
    if (!_scheduler) return
    _scheduler.release(leaseId, outcome)
}

function resetForTests() {
    if (_scheduler) schedulerRegistry.unregister(PROVIDER_ID, _scheduler)
    _scheduler = null
}

module.exports = {
    PROVIDER_ID,
    getScheduler,
    syncAccounts,
    getAccountIdByEmail,
    registerAccount,
    acquire,
    release,
    resetForTests,
}
