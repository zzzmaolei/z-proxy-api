'use strict'

// Keep scheduler release values closed over a small, provider-neutral set.
const LEASE_OUTCOMES = Object.freeze([
    'success',
    'failure',
    'upstream_error',
    'incomplete',
    'client_aborted',
])

const LEASE_OUTCOME_SET = new Set(LEASE_OUTCOMES)

function isLeaseOutcome(value) {
    return typeof value === 'string' && LEASE_OUTCOME_SET.has(value)
}

function isClientAbortError(error) {
    return error?.code === 'CLIENT_ABORTED'
        || error?.code === 'client_disconnected'
        || error?.classification === 'client_aborted'
}

function isRequestAborted({ error, requestSignal, req, res } = {}) {
    return isClientAbortError(error)
        || !!requestSignal?.aborted
        || !!req?.aborted
        || !!res?.destroyed
}

/**
 * Normalize a handler result before passing it to lease.release().
 * A handler must return a known string; legacy/accidental values are never
 * forwarded to the scheduler.
 */
function normalizeLeaseOutcome(value, {
    fallback = 'failure',
    error = null,
    requestSignal = null,
    req = null,
    res = null,
} = {}) {
    if (isClientAbortError(error)
        || !!requestSignal?.aborted
        || !!req?.aborted) {
        return 'client_aborted'
    }
    // A handler that claims success while already writing an error response
    // must not reset the account's failure state.
    if (value === 'success' && Number(res?.statusCode) >= 400) return 'failure'
    if (isLeaseOutcome(value)) return value
    if (!!res?.destroyed) return 'client_aborted'
    if (Number(res?.statusCode) >= 400) return 'failure'
    return isLeaseOutcome(fallback) ? fallback : 'failure'
}

module.exports = {
    LEASE_OUTCOMES,
    isLeaseOutcome,
    isClientAbortError,
    isRequestAborted,
    normalizeLeaseOutcome,
}
