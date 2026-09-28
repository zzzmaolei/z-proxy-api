/**
 * scheduler.js
 *
 * AccountScheduler — provider-neutral atomic account lease scheduler.
 *
 * Provides hard concurrency semaphores per account and globally, a bounded
 * FIFO waiting queue with timeout, sticky session preference, and graceful
 * shutdown. All state is in-process (file/none mode); no Redis dependency.
 *
 * Design:
 *  - Atomic selection: iterate accounts, find one with inFlight < max, increment.
 *    In single-process JS this is achieved by sequential execution (no preemption).
 *  - Hard semaphore: inFlight >= maxConcurrencyPerAccount → skip that account.
 *  - Sticky preference: if sessionKey is provided, look up its bound accountId
 *    (or stickyAccountId for direct legacy use) and try it first. If the bound
 *    account is busy, fall back to any idle account. On successful acquire,
 *    bind sessionKey → accountId for future calls.
 *  - Bounded queue: queue full → throw 429 with Retry-After.
 *  - Queue timeout: each waiter has a deadline; expired waiters reject on wake.
 *  - AbortSignal: if signal is provided and aborted, remove from queue
 *    immediately and reject.
 *  - Idempotent release: tracked via leased map; second release is a no-op.
 *  - Account cooldown: accounts in cooldown are excluded from selection.
 *  - Outcome-aware release: lease.release(outcome) routes to
 *    AccountRuntime.markSuccess / markFailure / (skip) based on outcome.
 */

const crypto = require('crypto')
const { logger } = require('../utils/logger')

const DEFAULTS = Object.freeze({
    maxConcurrencyPerAccount: 1,
    globalMaxConcurrency: 20,
    maxQueueSize: 150,
    queueTimeoutMs: 120000,
})

/** @typedef {'success'|'failure'|'incomplete'|'aborted'|'client_aborted'|'upstream_error'} LeaseOutcome */

class AccountScheduler {
    /**
     * @param {Map<string, import('./account-runtime').AccountRuntime>} [accountRuntimes]
     *        Map of accountId → AccountRuntime instances.
     * @param {Object} [cfg] - provider-neutral config overrides.
     *        Provider-specific defaults are resolved by the provider singleton,
     *        not by this shared scheduler.
     */
    constructor(accountRuntimes, cfg = {}) {
        // Allow AccountScheduler(cfg) shorthand without accountRuntimes.
        if (
            accountRuntimes &&
            typeof accountRuntimes === 'object' &&
            !(accountRuntimes instanceof Map)
        ) {
            cfg = accountRuntimes
            accountRuntimes = undefined
        }

        this.providerId = cfg.providerId || 'unknown'
        this.accounts = new Map()
        this._accountInFlight = new Map()

        if (accountRuntimes instanceof Map) {
            for (const [id, rt] of accountRuntimes) {
                this.accounts.set(id, rt)
                this._accountInFlight.set(id, 0)
            }
        }

        this.maxConcurrencyPerAccount = cfg.maxConcurrencyPerAccount
            ?? DEFAULTS.maxConcurrencyPerAccount
        this.globalMaxConcurrency = cfg.globalMaxConcurrency
            ?? DEFAULTS.globalMaxConcurrency
        this.maxQueueSize = cfg.maxQueueSize
            ?? DEFAULTS.maxQueueSize
        this.queueTimeoutMs = cfg.queueTimeoutMs
            ?? DEFAULTS.queueTimeoutMs
        this.routingStrategy = cfg.routingStrategy || 'round-robin'
        /** @type {number} 账号最小呼吸间隔（毫秒），默认 0（关闭），正数则在有多账号就绪时优先避开刚调用完毕的账号 */
        this.minPacingIntervalMs = Number(cfg.minPacingIntervalMs) || 0

        /**
         * @type {Array<{
         *   waiterId: number,
         *   stickyAccountId: string|null,
         *   sessionKey: string|null,
         *   resolve: Function,
         *   reject: Function,
         *   timer: NodeJS.Timeout,
         *   signal: AbortSignal|null,
         *   onAbort: Function,
         *   enqueuedAt: number,
         *   deadline: number
         * }>}
         */
        this._queue = []
        /** @type {number} global in-flight request count */
        this._inFlight = 0
        /** @type {boolean} */
        this._shutdown = false
        /**
         * @type {Map<string, { accountId: string, outcome: LeaseOutcome|null, releasedAt: number }>}
         * leaseId → metadata for idempotent release + per-account decrement.
         */
        this._leased = new Map()
        /** @type {number} */
        this._nextLeaseId = 0
        /** @type {number} */
        this._nextWaiterId = 0
        /** @type {Map<string, string>} sessionKey → accountId for sticky binding */
        this._stickyBindings = new Map()
        // ──────────────────────────────────────────────
        //  High-Concurrency O(1) & Zero-Allocation Cache
        // ──────────────────────────────────────────────
        /** @type {string[]} cached list of account IDs to avoid Array.from() allocations on every acquire */
        this._accountIdsCache = []
        this._accountIdsCacheDirty = true
        /** @type {number} round-robin cursor for fair account selection */
        this._roundRobinCursor = 0
    }

    // ──────────────────────────────────────────────
    //  Internal helpers
    // ──────────────────────────────────────────────

    /**
     * Get a lightweight snapshot of an account's current scheduler state.
     * @param {string} accountId
     * @returns {{ accountId: string, account: import('./account-runtime').AccountRuntime, inFlight: number, cooldownUntil: number } | null}
     */
    _getAccountState(accountId) {
        const rt = this.accounts.get(accountId)
        if (!rt) return null
        const inFlight = this._accountInFlight.get(accountId) || 0
        const cooldownUntil = rt.cooldownUntil || 0
        return { accountId, account: rt, inFlight, cooldownUntil }
    }

    /**
     * Resolve the sticky accountId for a given sessionKey/stickyAccountId pair.
     * Direct stickyAccountId (legacy) takes priority over sessionKey binding.
     *
     * @param {string|null} stickyAccountId
     * @param {string|null} sessionKey
     * @returns {string|null}
     */
    _resolveStickyAccountId(stickyAccountId, sessionKey) {
        if (stickyAccountId) return stickyAccountId
        if (sessionKey) {
            return this._stickyBindings.get(sessionKey) || null
        }
        return null
    }

    /**
     * Try to select an account atomically.
     *
     * Does NOT increment counters — the caller must do that after confirming
     * the global limit is also satisfied.
     *
     * Selection strategy (two-tier, idle-first):
     *   1. Sticky account (sessionKey binding): used only if idle (inFlight=0).
     *      If sticky is busy/cooldown, fall through to general pool.
     *   2. Tier 1 — idle accounts (inFlight=0): scored by health, weighted random.
     *      Busy accounts (inFlight>0) are NOT considered at this tier.
     *   3. Tier 2 — partial accounts (0<inFlight<maxConcurrency): only if NO
     *      idle accounts exist. Scored and weighted random.
     *   4. If no eligible accounts, return null (caller queues).
     *
     * Score formula (per account):
     *   base 100 - cooldownPenalty - failurePenalty + successBonus
     *   (inFlight is a binary filter, not a score penalty)
     *
     * @param {string|null} stickyAccountId
     * @returns {{ accountId: string, account: import('./account-runtime').AccountRuntime, inFlight: number, cooldownUntil: number } | null}
     */
    _trySelectAccount(stickyAccountId, excludeSet = null) {
        const now = Date.now()

        const isEligible = (state) => {
            if (!state) return false
            const runtime = state.account
            if (runtime.schedulerEligible === false || runtime.enabled === false) return false
            if (typeof runtime.token === 'string' && runtime.token.length === 0) return false
            const mutedUntil = typeof runtime.mutedUntil === 'number'
                ? runtime.mutedUntil * 1000
                : runtime.mutedUntil
                    ? new Date(runtime.mutedUntil).getTime()
                    : 0
            return mutedUntil <= now
        }

        // Prefer sticky account — but ONLY if routingStrategy is NOT round-robin,
        // and ONLY if it's idle (inFlight=0) and not excluded
        if (this.routingStrategy !== 'round-robin' && stickyAccountId && (!excludeSet || !excludeSet.has(stickyAccountId))) {
            const state = this._getAccountState(stickyAccountId)
            if (
                state &&
                state.inFlight === 0 &&
                state.cooldownUntil <= now &&
                isEligible(state)
            ) {
                return state
            }
        }

        // Get or build cached accountIds array to avoid allocating Array.from() on every acquire
        if (this._accountIdsCacheDirty || this._accountIdsCache.length !== this.accounts.size) {
            this._accountIdsCache = Array.from(this.accounts.keys())
            this._accountIdsCacheDirty = false
        }
        const accountIds = this._accountIdsCache
        const total = accountIds.length
        if (total === 0) return null

        // High-Concurrency O(1) Fast Path for 'round-robin' strategy:
        // Scans cyclically from _roundRobinCursor with zero candidate array allocations.
        if (this.routingStrategy === 'round-robin') {
            const scanRoundRobin = (maxInFlight, checkPacing = true) => {
                for (let step = 0; step < total; step++) {
                    const idx = (this._roundRobinCursor + step) % total
                    const accountId = accountIds[idx]
                    if (excludeSet && excludeSet.has(accountId)) continue
                    const state = this._getAccountState(accountId)
                    if (!state || !isEligible(state)) continue
                    if (state.inFlight > maxInFlight) continue
                    if (state.cooldownUntil > now) continue
                    // 拟真呼吸间隔：如果启用了 minPacingIntervalMs，且上次完成请求距今不足间隔，优先寻找其他已充分休息的账号
                    if (checkPacing && this.minPacingIntervalMs > 0 && state.account.lastSuccessAt) {
                        if (now - state.account.lastSuccessAt < this.minPacingIntervalMs) {
                            continue
                        }
                    }
                    this._roundRobinCursor = (idx + 1) % total
                    return state
                }
                return null
            }

            // Tier 1a: idle accounts with pacing satisfied (已充分休息的空闲账号优先)
            let idle = scanRoundRobin(0, true)
            // Tier 1b: fallback to any idle account if all are currently in breathing window (避免无谓阻塞)
            if (!idle && this.minPacingIntervalMs > 0) {
                idle = scanRoundRobin(0, false)
            }
            if (idle) return idle

            // Tier 2: partial accounts (inFlight < maxConcurrencyPerAccount)
            if (this.maxConcurrencyPerAccount > 1) {
                const partial = scanRoundRobin(this.maxConcurrencyPerAccount - 1, false)
                if (partial) return partial
            }

            return null
        }

        const scoreAccount = (state, rt) => {
            const stats = rt.requestStats || {}
            const totalReqs = stats.total || 0
            const successRate = totalReqs > 0 ? (stats.success || 0) / totalReqs : 0.5
            const cooldownPenalty = rt.cooldownRemainingMs
                ? Math.floor(rt.cooldownRemainingMs / 100)
                : 0
            let score = 100
            score -= cooldownPenalty
            score -= (rt.failureState?.count || 0) * 30
            score += Math.round(successRate * 30)
            return score
        }

        const collectCandidates = (maxInFlight) => {
            const result = []
            for (let i = 0; i < total; i++) {
                const accountId = accountIds[i]
                // Skip excluded accounts (already failed in this retry loop)
                if (excludeSet && excludeSet.has(accountId)) continue
                const state = this._getAccountState(accountId)
                if (!state) continue
                if (!isEligible(state)) continue
                if (state.inFlight > maxInFlight) continue
                if (state.cooldownUntil > now) continue
                const score = scoreAccount(state, state.account)
                if (score <= 0) continue
                result.push({ state, score, index: i })
            }
            return result
        }

        const pickWeighted = (candidates) => {
            if (candidates.length === 0) return null

            // If round-robin strategy is configured, select candidate by cyclic round-robin cursor
            if (this.routingStrategy === 'round-robin') {
                const sorted = [...candidates].sort((a, b) => {
                    const distA = (a.index - this._roundRobinCursor + total) % total
                    const distB = (b.index - this._roundRobinCursor + total) % total
                    return distA - distB
                })
                const chosen = sorted[0]
                this._roundRobinCursor = (chosen.index + 1) % total
                return chosen.state
            }

            candidates.sort((a, b) => b.score - a.score)
            const totalWeight = candidates.reduce((sum, c) => sum + c.score, 0)
            let roll = Math.random() * totalWeight
            for (const c of candidates) {
                roll -= c.score
                if (roll <= 0) {
                    this._roundRobinCursor = (c.index + 1) % total
                    return c.state
                }
            }
            this._roundRobinCursor = (candidates[0].index + 1) % total
            return candidates[0].state
        }

        // Tier 1: idle accounts only (inFlight=0)
        const idle = collectCandidates(0)
        if (idle.length > 0) {
            return pickWeighted(idle)
        }

        // Tier 2: partial accounts (inFlight < maxConcurrencyPerAccount)
        const partial = collectCandidates(this.maxConcurrencyPerAccount - 1)
        return pickWeighted(partial)
    }

    /**
     * Commit a selected account: increment inFlight counters and produce a lease.
     *
     * @param {{ accountId: string, account: import('./account-runtime').AccountRuntime, inFlight: number }} selected
     * @param {Object} [ctx]
     * @param {string} [ctx.sessionKey] - if provided, bind sessionKey → accountId
     * @returns {{
     *   account: import('./account-runtime').AccountRuntime,
     *   accountRuntime: import('./account-runtime').AccountRuntime,
     *   leaseId: string,
     *   acquiredAt: number,
     *   release: (outcome?: LeaseOutcome) => void
     * }}
     */
    _commitLease(selected, ctx = {}) {
        // Increment scheduler's per-account counter
        selected.inFlight++
        this._accountInFlight.set(selected.accountId, selected.inFlight)
        // Increment AccountRuntime's own inFlight counter (mirror state)
        selected.account.acquire()
        this._inFlight++

        const leaseId = String(this._nextLeaseId++)
        const acquiredAt = Date.now()
        this._leased.set(leaseId, {
            accountId: selected.accountId,
            outcome: null,
            releasedAt: 0
        })

        // Bind sessionKey → accountId for sticky semantics on future calls
        if (ctx.sessionKey) {
            this._stickyBindings.set(ctx.sessionKey, selected.accountId)
        }

        const accountRuntime = selected.account
        const self = this
        return {
            providerId: this.providerId,
            accountId: selected.accountId,
            account: accountRuntime,
            accountRuntime,
            leaseId,
            acquiredAt,
            release(outcome) {
                return self.release(leaseId, outcome)
            }
        }
    }

    /**
     * Remove a waiter from the queue and clean up its resources.
     * @param {number} waiterId
     */
    _removeWaiter(waiterId) {
        const idx = this._queue.findIndex(w => w.waiterId === waiterId)
        if (idx < 0) return
        const w = this._queue[idx]
        clearTimeout(w.timer)
        if (w.signal) {
            w.signal.removeEventListener('abort', w.onAbort)
        }
        this._queue.splice(idx, 1)
    }

    /**
     * Wake the next eligible waiter from the queue.
     * Called after every release().
     */
    _wakeNext() {
        if (this._shutdown || this._queue.length === 0) return

        for (let i = 0; i < this._queue.length; i++) {
            const waiter = this._queue[i]
            // Resolve sticky preference from either explicit stickyAccountId
            // or sessionKey binding (set by a prior acquire).
            const stickyAccountId = this._resolveStickyAccountId(
                waiter.stickyAccountId,
                waiter.sessionKey
            )
            const selected = this._trySelectAccount(stickyAccountId, waiter.excludeSet)
            if (selected && this._inFlight < this.globalMaxConcurrency) {
                // Remove from queue
                this._queue.splice(i, 1)
                clearTimeout(waiter.timer)
                if (waiter.signal) {
                    waiter.signal.removeEventListener('abort', waiter.onAbort)
                }

                waiter.resolve(this._commitLease(selected, { sessionKey: waiter.sessionKey }))
                return
            }
        }
    }

    // ──────────────────────────────────────────────
    //  Public API
    // ──────────────────────────────────────────────

    /**
     * Acquire a lease for an account.
     *
     * If an account is immediately available, returns synchronously (resolved
     * promise). Otherwise, the caller is placed in a bounded FIFO queue and
     * will be resolved when a lease is released.
     *
     * @param {Object} [opts]
     * @param {string} [opts.requestedModel] - original requested model name
     *        (kept for observability; not used in selection logic)
     * @param {string} [opts.baseModel] - base model name after alias resolution
     *        (kept for observability; not used in selection logic)
     * @param {'fast'|'thinking'|'none'} [opts.aliasMode] - alias mode
     *        (kept for observability; not used in selection logic)
     * @param {number} [opts.estimatedPromptBytes] - estimated prompt size in
     *        bytes (kept for observability/future quota logic)
     * @param {number} [opts.mediaBytes] - media bytes (kept for observability)
     * @param {string} [opts.sessionKey] - sticky session key. On first use,
     *        the chosen accountId is bound to this key; subsequent calls with
     *        the same key prefer that account when it has a free slot.
     * @param {string} [opts.stickyAccountId] - (legacy) direct accountId to
     *        prefer; overrides sessionKey binding.
     * @param {AbortSignal} [opts.signal] - abort signal for client disconnect.
     *        If aborted while queued, the waiter is removed and rejected.
     * @param {number} [opts.deadline] - epoch ms deadline. If already exceeded,
     *        rejects with status=429. Defaults to now + queueTimeoutMs.
     * @returns {Promise<{
     *   account: import('./account-runtime').AccountRuntime,
     *   accountRuntime: import('./account-runtime').AccountRuntime,
     *   leaseId: string,
     *   acquiredAt: number,
     *   release: (outcome?: LeaseOutcome) => void
     * }>}
     * @throws {Error} with status=429 if queue is full
     * @throws {Error} with status=429 if queue timeout expires (code=QUEUE_TIMEOUT)
     * @throws {Error} with status=429 if deadline already exceeded (code=QUEUE_DEADLINE_EXCEEDED)
     * @throws {Error} with status=499 if client disconnects (code=CLIENT_ABORTED)
     * @throws {Error} with status=503 if scheduler is shutting down
     */
    async acquire({
        requestedModel,
        baseModel,
        aliasMode,
        estimatedPromptBytes,
        mediaBytes,
        sessionKey,
        stickyAccountId,
        excludeAccountIds,
        signal,
        deadline
    } = {}) {
        if (this._shutdown) {
            throw Object.assign(new Error('Scheduler is shutting down'), { status: 503 })
        }

        const excludeSet = excludeAccountIds instanceof Set
            ? excludeAccountIds
            : Array.isArray(excludeAccountIds)
                ? new Set(excludeAccountIds)
                : null

        // Resolve sticky account preference:
        //  - Explicit stickyAccountId (legacy) takes priority
        //  - Otherwise look up sessionKey binding
        const resolvedStickyAccountId = this._resolveStickyAccountId(
            stickyAccountId || null,
            sessionKey || null
        )

        // Check deadline already exceeded (before queueing)
        if (deadline && Date.now() >= deadline) {
            throw Object.assign(new Error('Queue deadline exceeded'), {
                status: 429,
                code: 'QUEUE_DEADLINE_EXCEEDED',
                headers: { 'Retry-After': '30' }
            })
        }

        // Check cancellation before pool state so an already-disconnected
        // client consistently receives the client-aborted outcome.
        if (signal && signal.aborted) {
            throw Object.assign(new Error('Client disconnected'), {
                status: 499,
                code: 'CLIENT_ABORTED'
            })
        }

        // An empty account pool can never become serviceable by releasing a
        // lease. Fail immediately instead of occupying a queue slot until the
        // configured timeout. The same applies when the caller explicitly
        // excludes every currently known account during failover.
        if (this.accounts.size === 0 || (
            excludeSet &&
            excludeSet.size >= this.accounts.size &&
            Array.from(this.accounts.keys()).every(accountId => excludeSet.has(accountId))
        )) {
            throw Object.assign(new Error('No available accounts'), {
                status: 503,
                code: 'NO_AVAILABLE_ACCOUNTS',
                headers: { 'Retry-After': '30' }
            })
        }

        const timeoutMs = deadline
            ? Math.max(0, deadline - Date.now())
            : this.queueTimeoutMs

        // Try immediate selection
        const selected = this._trySelectAccount(resolvedStickyAccountId, excludeSet)
        if (selected) {
            this._logger?.warn(`[SCHEDULER] selected account=${selected.account?.email} inFlight=${selected.inFlight}`, 'SCHEDULER')
        } else {
            this._logger?.warn(`[SCHEDULER] no idle account available, queuing (queue=${this._queue.length}/${this.maxQueueSize})`, 'SCHEDULER')
        }
        if (selected && this._inFlight < this.globalMaxConcurrency) {
            return this._commitLease(selected, { sessionKey: sessionKey || undefined })
        }

        // Queue — check capacity
        if (this._queue.length >= this.maxQueueSize) {
            throw Object.assign(new Error('Queue is full'), {
                status: 429,
                code: 'QUEUE_FULL',
                headers: { 'Retry-After': '30' }
            })
        }

        const waiterId = this._nextWaiterId++
        const waiterDeadline = deadline || (Date.now() + this.queueTimeoutMs)
        // suppress unused-parameter lint for observability-only fields
        void requestedModel
        void baseModel
        void aliasMode
        void estimatedPromptBytes
        void mediaBytes

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._removeWaiter(waiterId)
                reject(Object.assign(new Error('Queue timeout'), {
                    status: 429,
                    code: 'QUEUE_TIMEOUT',
                    headers: { 'Retry-After': '30' }
                }))
            }, timeoutMs)

            const onAbort = () => {
                clearTimeout(timer)
                this._removeWaiter(waiterId)
                reject(Object.assign(new Error('Client disconnected'), {
                    status: 499,
                    code: 'CLIENT_ABORTED'
                }))
            }

            if (signal) {
                signal.addEventListener('abort', onAbort, { once: true })
            }

            this._queue.push({
                waiterId,
                stickyAccountId: resolvedStickyAccountId,
                sessionKey: sessionKey || null,
                excludeSet: excludeSet || null,
                resolve,
                reject,
                timer,
                signal: signal || null,
                onAbort,
                enqueuedAt: Date.now(),
                deadline: waiterDeadline
            })

            logger.debug(
                `[scheduler] waiter ${waiterId} enqueued (depth=${this._queue.length}/${this.maxQueueSize})`,
                'ACCOUNT-SCHEDULER'
            )
        })
    }

    /**
     * Release a lease by leaseId. Idempotent — calling twice is a no-op.
     *
     * Applies outcome-based state transitions to the underlying AccountRuntime:
     *   - 'success'        → rt.markSuccess() (resets failure counter, clears cooldown)
     *   - 'failure'         → rt.markFailure('failure')
     *   - 'aborted'         → rt.markFailure('aborted')
     *   - 'upstream_error'  → rt.markFailure('upstream_error')
     *   - 'client_aborted'  → no mark (don't penalize account for client disconnects)
     *   - 'incomplete' / undefined → no mark (just release the slot)
     *
     * Always decrements both scheduler._accountInFlight and accountRuntime.inFlight,
     * then wakes the next eligible queued waiter.
     *
     * @param {string} leaseId
     * @param {LeaseOutcome} [outcome]
     */
    release(leaseId, outcome) {
        const lease = this._leased.get(leaseId)
        if (!lease) return // idempotent: already released (or unknown leaseId)
        this._leased.delete(leaseId)

        const accountId = lease.accountId
        const rt = this.accounts.get(accountId)

        // Apply outcome → AccountRuntime state transition
        // DeepSeek 路线彻底移除惩罚性冷却锁死 (cooldownMs=0)，保证轮询可调度；Qwen 路线保持既有轻量退避契约
        if (rt) {
            const isDpsk = this.providerId === 'deepseek'
            switch (outcome) {
                case 'success':
                    rt.markSuccess()
                    break
                case 'failure':
                    rt.markFailure('failure', isDpsk ? 0 : 5000)
                    break
                case 'aborted':
                    rt.markFailure('aborted', isDpsk ? 0 : 2000)
                    break
                case 'upstream_error':
                    rt.markFailure('upstream_error', isDpsk ? 0 : 3000)
                    break
                case 'client_aborted':
                    // Client disconnect — don't penalize the account
                    break
                case 'incomplete':
                default:
                    if (outcome === 'incomplete') {
                        rt.markFailure('incomplete', isDpsk ? 0 : 1000)
                    }
                    break
            }
            // Decrement AccountRuntime's own inFlight counter
            rt.release()
        }

        // Decrement scheduler counters
        this._inFlight = Math.max(0, this._inFlight - 1)
        const af = this._accountInFlight.get(accountId)
        if (af !== undefined) {
            this._accountInFlight.set(accountId, Math.max(0, af - 1))
        }

        // Wake next waiter
        this._wakeNext()
    }

    /**
     * Cancel a waiting request by waiter ID (e.g. on client disconnect).
     * @param {number} waiterId
     */
    cancelWaiter(waiterId) {
        const idx = this._queue.findIndex(w => w.waiterId === waiterId)
        if (idx < 0) return
        const waiter = this._queue[idx]
        clearTimeout(waiter.timer)
        if (waiter.signal) {
            waiter.signal.removeEventListener('abort', waiter.onAbort)
        }
        this._queue.splice(idx, 1)
        waiter.reject(Object.assign(new Error('Client disconnected'), {
            status: 499,
            code: 'CLIENT_ABORTED'
        }))
    }

    /**
     * Mark an account's request as successful.
     * Delegates to AccountRuntime.markSuccess().
     * @param {string} accountId
     */
    markSuccess(accountId) {
        const rt = this.accounts.get(accountId)
        if (rt) {
            rt.markSuccess()
        }
    }

    /**
     * Mark an account's request as failed.
     * Delegates to AccountRuntime.markFailure().
     * @param {string} accountId
     * @param {string} [errorType] - short failure tag (e.g. 'timeout', 'http429')
     */
    markFailure(accountId, errorType) {
        const rt = this.accounts.get(accountId)
        if (rt) {
            rt.markFailure(errorType || 'unknown')
        }
    }

    /**
     * Put an account into cooldown for a specified duration.
     * @param {string} accountId
     * @param {number} [durationMs=30000]
     */
    markCooldown(accountId, durationMs) {
        const rt = this.accounts.get(accountId)
        if (rt) {
            rt.cooldownUntil = Date.now() + (durationMs || 30000)
            logger.warn(
                `[${rt.accountId}] scheduler cooldown ${durationMs || 30000}ms`,
                'ACCOUNT-SCHEDULER'
            )
        }
    }

    /**
     * Get a snapshot of the scheduler state for observability.
     * @returns {Object}
     */
    getSnapshot() {
        const accounts = []
        for (const [id, rt] of this.accounts) {
            // AccountRuntime's failureState field was renamed in commit f75cdd7
            // from `consecutiveFailures` to `count`. Accept either form for
            // defensive compatibility.
            const failureCount = rt.failureState
                ? (rt.failureState.count ?? rt.failureState.consecutiveFailures ?? 0)
                : 0
            accounts.push({
                accountId: id,
                inFlight: this._accountInFlight.get(id) || 0,
                cooldownRemaining: Math.max(0, (rt.cooldownUntil || 0) - Date.now()),
                failures: failureCount,
                stats: rt.requestStats ? { ...rt.requestStats } : {}
            })
        }
        return {
            accounts,
            queueDepth: this._queue.length,
            globalInFlight: this._inFlight,
            maxQueueSize: this.maxQueueSize,
            globalMaxConcurrency: this.globalMaxConcurrency,
            shutdown: this._shutdown,
            stickyBindings: this._stickyBindings.size
        }
    }

    /**
     * Graceful shutdown: reject all queued waiters and stop accepting new
     * acquisitions. Already-in-flight leases are not affected.
     */
    async shutdown() {
        this._shutdown = true
        const count = this._queue.length
        for (const waiter of this._queue) {
            clearTimeout(waiter.timer)
            if (waiter.signal) {
                waiter.signal.removeEventListener('abort', waiter.onAbort)
            }
            waiter.reject(Object.assign(new Error('Scheduler is shutting down'), { status: 503 }))
        }
        this._queue = []
        if (count > 0) {
            logger.info(
                `[scheduler] shutdown: rejected ${count} queued waiters`,
                'ACCOUNT-SCHEDULER'
            )
        }
    }
}

module.exports = { AccountScheduler, DEFAULTS }
