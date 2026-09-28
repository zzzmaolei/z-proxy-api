const { test, describe, after } = require('node:test')
const assert = require('node:assert/strict')

const { AccountScheduler } = require('../src/shared/account-scheduler')
const { AccountRuntime } = require('../src/shared/account-runtime')
const registry = require('../src/shared/provider-scheduler-registry')
const deepseekScheduler = require('../src/backends/deepseek/scheduler-singleton')

const futureMute = () => Math.floor(Date.now() / 1000) + 3600

function account(email, overrides = {}) {
    return {
        email,
        password: 'password',
        token: `token-${email}`,
        enabled: true,
        mutedUntil: null,
        proxy: null,
        ...overrides,
    }
}

after(() => {
    deepseekScheduler.resetForTests()
    registry.unregister('qwen')
})

describe('DeepSeek provider-scoped scheduler', () => {
    test('keeps DeepSeek and Qwen scheduler state isolated', async () => {
        const dpsk = deepseekScheduler.syncAccounts([account('dpsk-isolated')])
        const qwenRuntime = new AccountRuntime({
            accountId: 'qwen-isolated',
            email: 'qwen-isolated@test.invalid',
            token: 'qwen-token',
        })
        const qwen = new AccountScheduler(new Map([[qwenRuntime.accountId, qwenRuntime]]), {
            providerId: 'qwen',
            maxConcurrencyPerAccount: 1,
            globalMaxConcurrency: 1,
        })
        registry.register('qwen', qwen)

        const qwenLease = await qwen.acquire()
        assert.equal(qwen.getSnapshot().globalInFlight, 1)
        assert.equal(dpsk.getSnapshot().globalInFlight, 0)
        qwenLease.release('client_aborted')
        assert.equal(qwenRuntime.inFlight, 0)
    })

    test('syncs token and proxy updates without replacing an active runtime', async () => {
        const initial = account('dpsk-update')
        const scheduler = deepseekScheduler.syncAccounts([initial])
        const accountId = [...scheduler.accounts.keys()][0]
        const runtime = scheduler.accounts.get(accountId)
        const lease = await scheduler.acquire({ stickyAccountId: accountId })

        deepseekScheduler.syncAccounts([account('dpsk-update', {
            token: 'token-rotated',
            proxy: 'http://127.0.0.1:18080',
        })])

        assert.equal(scheduler.accounts.get(accountId), runtime)
        assert.equal(runtime.token, 'token-rotated')
        assert.equal(runtime.proxy, 'http://127.0.0.1:18080')
        lease.release('success')
        assert.equal(runtime.inFlight, 0)
    })

    test('excludes muted accounts and removes deleted idle accounts', async () => {
        const scheduler = deepseekScheduler.syncAccounts([
            account('dpsk-muted', { mutedUntil: futureMute() }),
            account('dpsk-active'),
        ])
        const mutedId = [...scheduler.accounts.entries()]
            .find(([, runtime]) => runtime.email === 'dpsk-muted')[0]
        const activeId = [...scheduler.accounts.entries()]
            .find(([, runtime]) => runtime.email === 'dpsk-active')[0]

        const activeLease = await scheduler.acquire()
        assert.equal(activeLease.accountId, activeId)
        activeLease.release('success')

        const held = await scheduler.acquire({ stickyAccountId: mutedId })
        assert.equal(held.accountId, activeId, 'muted sticky account must be skipped')
        held.release('success')

        const deletedLease = await scheduler.acquire({ stickyAccountId: activeId })
        deepseekScheduler.syncAccounts([account('dpsk-muted', { mutedUntil: futureMute() })])
        assert.ok(scheduler.accounts.has(activeId), 'active lease account must remain releasable')
        deletedLease.release('client_aborted')

        deepseekScheduler.syncAccounts([account('dpsk-muted', { mutedUntil: futureMute() })])
        assert.equal(scheduler.accounts.has(activeId), false, 'idle deleted account should be pruned')
    })

    test('queued abort and double release leave no scheduler leak', async () => {
        const scheduler = deepseekScheduler.syncAccounts([account('dpsk-abort')])
        const first = await scheduler.acquire()
        const controller = new AbortController()
        const waiting = scheduler.acquire({ signal: controller.signal })

        await new Promise(resolve => setTimeout(resolve, 10))
        controller.abort()
        await assert.rejects(waiting, error => {
            assert.equal(error.status, 499)
            assert.equal(error.code, 'CLIENT_ABORTED')
            return true
        })

        first.release('client_aborted')
        first.release('failure')
        assert.equal(scheduler.getSnapshot().globalInFlight, 0)
        assert.equal(scheduler.getSnapshot().queueDepth, 0)
    })
})
