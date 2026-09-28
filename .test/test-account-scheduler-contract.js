const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const { AccountRuntime } = require('../src/shared/account-runtime')
const { AccountScheduler } = require('../src/shared/account-scheduler')
const { QwenScheduler } = require('../src/backends/qwen/scheduler')

function runtime(accountId, provider = 'test') {
    return new AccountRuntime({
        accountId,
        email: `${provider}-${accountId}@test.invalid`,
        token: `token-${accountId}`,
        password: 'test',
    })
}

function mapOf(...runtimes) {
    return new Map(runtimes.map(rt => [rt.accountId, rt]))
}

describe('provider-neutral account scheduler contract', () => {
    test('empty pools fail fast without creating a queued waiter', async () => {
        const scheduler = new AccountScheduler(new Map(), {
            providerId: 'deepseek',
            maxQueueSize: 3,
            queueTimeoutMs: 1000,
        })

        await assert.rejects(
            scheduler.acquire(),
            error => error.code === 'NO_AVAILABLE_ACCOUNTS' && error.status === 503,
        )
        assert.equal(scheduler.getSnapshot().queueDepth, 0)
    })

    test('an already-aborted request wins over empty-pool failure', async () => {
        const scheduler = new AccountScheduler(new Map(), {
            providerId: 'deepseek',
            maxQueueSize: 3,
            queueTimeoutMs: 1000,
        })
        const controller = new AbortController()
        controller.abort()

        await assert.rejects(
            scheduler.acquire({ signal: controller.signal }),
            error => error.code === 'CLIENT_ABORTED' && error.status === 499,
        )
        assert.equal(scheduler.getSnapshot().queueDepth, 0)
    })

    test('excluding every known account fails over immediately', async () => {
        const rt = runtime('excluded-1')
        const scheduler = new AccountScheduler(mapOf(rt), {
            providerId: 'deepseek',
            maxQueueSize: 3,
            queueTimeoutMs: 1000,
        })

        await assert.rejects(
            scheduler.acquire({ excludeAccountIds: new Set([rt.accountId]) }),
            error => error.code === 'NO_AVAILABLE_ACCOUNTS' && error.status === 503,
        )
        assert.equal(scheduler.getSnapshot().queueDepth, 0)
        assert.equal(rt.inFlight, 0)
    })

    test('lease exposes providerId and accountId while retaining account aliases', async () => {
        const rt = runtime('shared-1')
        const scheduler = new AccountScheduler(mapOf(rt), {
            providerId: 'deepseek',
            maxConcurrencyPerAccount: 1,
            globalMaxConcurrency: 1,
        })

        const lease = await scheduler.acquire()
        assert.equal(lease.providerId, 'deepseek')
        assert.equal(lease.accountId, rt.accountId)
        assert.equal(lease.account, rt)
        assert.equal(lease.accountRuntime, rt)
        assert.equal(rt.inFlight, 1)

        lease.release('success')
        assert.equal(rt.inFlight, 0)
        assert.equal(scheduler.getSnapshot().globalInFlight, 0)
    })

    test('release is idempotent and applies the first outcome only', async () => {
        const rt = runtime('shared-2')
        const scheduler = new AccountScheduler(mapOf(rt), {
            providerId: 'deepseek',
            maxConcurrencyPerAccount: 1,
            globalMaxConcurrency: 1,
        })

        const lease = await scheduler.acquire()
        lease.release('success')
        lease.release('failure')

        assert.equal(rt.requestStats.success, 1)
        assert.equal(rt.requestStats.failure, 0)
        assert.equal(rt.inFlight, 0)
        assert.equal(scheduler.getSnapshot().globalInFlight, 0)
    })

    test('Qwen wrapper preserves legacy qwen-prefixed configuration', async () => {
        const rt = runtime('qwen-compat', 'qwen')
        const scheduler = new QwenScheduler(mapOf(rt), {
            qwenMaxConcurrencyPerAccount: 1,
            qwenGlobalMaxConcurrency: 1,
            qwenMaxQueueSize: 3,
            qwenQueueTimeoutMs: 1000,
        })

        const lease = await scheduler.acquire()
        assert.equal(lease.providerId, 'qwen')
        assert.equal(scheduler.maxQueueSize, 3)
        assert.equal(scheduler.queueTimeoutMs, 1000)
        lease.release('client_aborted')
        assert.equal(rt.requestStats.failure, 0)
    })
})
