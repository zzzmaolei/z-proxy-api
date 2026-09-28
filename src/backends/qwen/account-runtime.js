/**
 * account-runtime.js
 *
 * AccountRuntime — per-account runtime state isolation.
 *
 * Every Qwen account gets its own runtime instance managing:
 *  - inFlight counter (semaphore placeholder)
 *  - failure / cooldown / success state
 *  - request stats
 *  - chatIdPool and warmupState references (attached later by the scheduler)
 *  - cookieJar and stableHeaders references (attached later by request pipeline)
 *
 * Design:
 *  - Persistent config (accountId / credentials / clientProfile) is from accountManager
 *    config — never mutated here.
 *  - Everything else is pure runtime state, safe to reset on restart.
 *  - accountId is a stable irreversible ID — used for logging, NEVER logs the email.
 *    If `account.accountId` is provided directly, it is used as-is; otherwise it is
 *    derived via SHA-256 of the email.
 *  - This class is intentionally thin: concurrency enforcement, scheduling, and
 *    pool management live in the scheduler layer, not here.
 */

const crypto = require('crypto')
const { logger } = require('../../utils/logger')

class AccountRuntime {
    /**
     * @param {Object} account - raw account object from accountManager.accountTokens
     *   (accountId?, email, token, password, clientProfile?, proxy, etc.)
     */
    constructor(account) {
        // === Persistent (account-level, immutable) ===
        /** @type {string} stable irreversible ID (not the email). If `account.accountId`
         *  is provided, used as-is; otherwise derived via SHA-256 of the email (12-char hex). */
        this.accountId = account.accountId || crypto.createHash('sha256')
            .update(account.email || 'no-email')
            .digest('hex')
            .slice(0, 12)

        /** @type {{email:string, token:string, password:string}} account credentials (immutable) */
        this.credentials = {
            email: account.email || '',
            token: account.token || '',
            password: account.password || ''
        }

        /** @type {Object|null} StableClientProfile instance (UA / sec-ch-ua / language, etc.).
         *  May be null if no profile is assigned yet — scheduler will populate later. */
        this.clientProfile = account.clientProfile || null

        /** @type {string} network profile identifier.
         *  network-profile.js has been removed; the field is kept as a plain string
         *  for snapshot/logging compatibility. */
        this.networkProfileId = 'direct-default'

        // === Runtime (per-request state, mutable) ===
        /** @type {Object|null} cookie jar reference (attached by request pipeline) */
        this.cookieJar = null

        /** @type {Object|null} stable headers derived from clientProfile (attached by request pipeline) */
        this.stableHeaders = null

        /** @type {Map} ChatIdPool storage (per-account + baseModel).
         *  Initialized as an empty Map; chat-id-pool.js attaches the real pool later. */
        this.chatIdPool = new Map()

        /** @type {Object} warmup state — populated by qwen-homepage-warmup.js */
        this.warmupState = {
            lastWarmup: 0,
            warmupPromise: null,
            isWarm: false
        }

        /** @type {number} max concurrent requests for this account (scheduler compares
         *  inFlight against this; no real Promise semaphore — enforcement lives in scheduler) */
        this.semaphore = 4

        /** @type {number} current in-flight request count */
        this.inFlight = 0

        /** @type {{count:number, lastReason:string|null, lastFailureAt:number|null}} */
        this.failureState = {
            count: 0,
            lastReason: null,
            lastFailureAt: null
        }

        /** @type {number} epoch ms until which this account is in cooldown (0 = not cooling) */
        this.cooldownUntil = 0

        /** @type {number|null} epoch ms of last successful request */
        this.lastSuccessAt = null

        /** @type {number|null} epoch ms of last failed request */
        this.lastFailureAt = null

        /** @type {{total:number, success:number, failure:number, incomplete:number, aborted:number, totalStreamBytes:number}} */
        this.requestStats = {
            total: 0,
            success: 0,
            failure: 0,
            incomplete: 0,
            aborted: 0,
            totalStreamBytes: 0
        }
    }

    // ── Convenience getters ──

    /** @returns {string} */
    get email() {
        return this.credentials.email
    }

    /** @returns {string} */
    get token() {
        return this.credentials.token
    }

    /** @returns {boolean} whether this account is currently in cooldown */
    get isInCooldown() {
        return this.cooldownUntil > Date.now()
    }

    /** @returns {number} remaining cooldown ms (0 if not in cooldown) */
    get cooldownRemainingMs() {
        return Math.max(0, this.cooldownUntil - Date.now())
    }

    // ── Failure / cooldown ──

    /**
     * Record a successful request — reset failure counters and cooldown.
     * @param {number} [now=Date.now()]
     */
    markSuccess(now = Date.now()) {
        this.failureState.count = 0
        this.failureState.lastReason = null
        this.failureState.lastFailureAt = null
        this.cooldownUntil = 0
        this.lastSuccessAt = now
        this.requestStats.success++
        this.requestStats.total++
    }

    /**
     * Record a failed request — increment failure counters and optionally trigger cooldown.
     * @param {string} [reason='unknown'] - short tag for the failure cause (e.g. 'timeout', 'http429', 'http500')
     * @param {number} [cooldownMs=0] - if > 0, set cooldown until now + cooldownMs
     * @param {number} [now=Date.now()]
     */
    markFailure(reason = 'unknown', cooldownMs = 0, now = Date.now()) {
        this.failureState.count++
        this.failureState.lastReason = reason
        this.failureState.lastFailureAt = now
        this.lastFailureAt = now
        this.requestStats.failure++
        this.requestStats.total++

        if (cooldownMs > 0) {
            this.cooldownUntil = now + cooldownMs
            logger.warn(
                `[${this.accountId}] cooldown ${cooldownMs}ms (failures=${this.failureState.count} reason=${reason})`,
                'ACCOUNT-RUNTIME'
            )
        }
    }

    // ── inFlight tracking ──

    /**
     * Increment inFlight counter. Returns the new value.
     * @returns {number}
     */
    acquire() {
        this.inFlight++
        return this.inFlight
    }

    /**
     * Decrement inFlight counter. Returns the new value.
     * @returns {number}
     */
    release() {
        if (this.inFlight > 0) this.inFlight--
        return this.inFlight
    }

    // ── Stats ──

    /**
     * Record stream bytes received from upstream.
     * @param {number} bytes
     */
    addStreamBytes(bytes) {
        if (typeof bytes === 'number' && bytes > 0) {
            this.requestStats.totalStreamBytes += bytes
        }
    }

    /**
     * Reset all runtime stats (inFlight, failure, cooldown, stats) to initial state.
     * Does NOT touch credentials, clientProfile, cookieJar, stableHeaders, chatIdPool, or warmupState.
     * Used for testing and account recovery.
     */
    resetRuntime() {
        this.inFlight = 0
        this.failureState = { count: 0, lastReason: null, lastFailureAt: null }
        this.cooldownUntil = 0
        this.lastSuccessAt = null
        this.lastFailureAt = null
        this.requestStats = {
            total: 0,
            success: 0,
            failure: 0,
            incomplete: 0,
            aborted: 0,
            totalStreamBytes: 0
        }
    }

    /**
     * Get a summary snapshot of this account's runtime state (safe for logging — no email).
     * @returns {Object}
     */
    getSnapshot() {
        return {
            accountId: this.accountId,
            inFlight: this.inFlight,
            semaphore: this.semaphore,
            cooldownUntil: this.cooldownUntil,
            isInCooldown: this.isInCooldown,
            failureCount: this.failureState.count,
            lastReason: this.failureState.lastReason,
            lastSuccessAt: this.lastSuccessAt,
            lastFailureAt: this.lastFailureAt,
            requestStats: { ...this.requestStats },
            warmupIsWarm: this.warmupState.isWarm,
            networkProfileId: this.networkProfileId
        }
    }
}

module.exports = { AccountRuntime }
