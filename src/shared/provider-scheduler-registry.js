/**
 * Provider-scoped scheduler registry.
 *
 * The registry owns no scheduling policy. It only keeps independent scheduler
 * instances addressable by provider id so one provider cannot accidentally use
 * another provider's queue or concurrency counters.
 */

const schedulers = new Map()

function normalizeProviderId(providerId) {
    const value = String(providerId || '').trim().toLowerCase()
    if (!value) throw new TypeError('providerId is required')
    return value
}

function assertScheduler(scheduler) {
    if (!scheduler || typeof scheduler.acquire !== 'function' || typeof scheduler.release !== 'function') {
        throw new TypeError('scheduler must expose acquire() and release()')
    }
}

function register(providerId, scheduler, { replace = false } = {}) {
    const key = normalizeProviderId(providerId)
    assertScheduler(scheduler)
    const existing = schedulers.get(key)
    if (existing && existing !== scheduler && !replace) {
        throw new Error(`scheduler already registered for provider: ${key}`)
    }
    schedulers.set(key, scheduler)
    return scheduler
}

function get(providerId) {
    return schedulers.get(normalizeProviderId(providerId)) || null
}

function has(providerId) {
    return schedulers.has(normalizeProviderId(providerId))
}

function unregister(providerId, scheduler = null) {
    const key = normalizeProviderId(providerId)
    const existing = schedulers.get(key)
    if (!existing) return false
    if (scheduler && existing !== scheduler) return false
    schedulers.delete(key)
    return true
}

function list() {
    return new Map(schedulers)
}

function clear() {
    schedulers.clear()
}

module.exports = {
    register,
    get,
    has,
    unregister,
    list,
    clear,
}
