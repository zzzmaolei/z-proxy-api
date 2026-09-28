/**
 * test-qwen-client-abort-no-leak.js
 *
 * 验证客户端断开时 lease 被正确释放（无 inFlight 泄漏，无错误惩罚）：
 *   1. lease.release('client_aborted') → inFlight 归零，账号不被惩罚
 *   2. lease.release('incomplete') → inFlight 归零，不增加 failure 计数
 *   3. 双重 release 幂等安全
 *   4. 释放后账号立即可重新 acquire
 *   5. 客户端断开时排队中的 waiter 被移出队列并以 499 reject
 *   6. client_aborted 不设置 cooldown
 *
 * 运行：node --test .test/test-qwen-client-abort-no-leak.js
 */

process.env.QWEN_CLIENT_PROFILE_MODE = 'stable-per-account'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const { QwenScheduler } = require('../src/backends/qwen/scheduler.js')
const { AccountRuntime } = require('../src/backends/qwen/account-runtime.js')

function createRuntime(idSuffix) {
    return new AccountRuntime({
        email: `abort-${idSuffix}@test.com`,
        token: `tok-${idSuffix}`,
        password: 'pw'
    })
}

function createSchedulerWithOneAccount(rt, opts = {}) {
    const map = new Map()
    map.set(rt.accountId, rt)
    return new QwenScheduler(map, {
        maxConcurrencyPerAccount: 1,
        globalMaxConcurrency: 1,
        maxQueueSize: 10,
        queueTimeoutMs: 5000,
        ...opts
    })
}

describe('Client abort does not leak lease', () => {
    test('lease released on client_aborted → inFlight=0, no failure mark', async () => {
        const rt = createRuntime('1')
        const sch = createSchedulerWithOneAccount(rt)
        const lease = await sch.acquire({ requestedModel: 'qwen3.8-max-preview' })
        assert.equal(rt.inFlight, 1, 'inFlight should be 1 after acquire')
        assert.equal(sch.getSnapshot().globalInFlight, 1)

        lease.release('client_aborted')

        assert.equal(rt.inFlight, 0, 'inFlight should be 0 after client_aborted release')
        assert.equal(sch.getSnapshot().globalInFlight, 0)
        assert.equal(rt.requestStats.failure, 0, 'account should NOT be penalized for client_aborted')
        assert.equal(rt.requestStats.aborted, 0, 'client_aborted should not increment aborted counter')
        assert.equal(rt.requestStats.success, 0, 'client_aborted should not increment success counter')
    })

    test('lease released on incomplete → inFlight=0, light cooldown for rotation', async () => {
        const rt = createRuntime('2')
        const sch = createSchedulerWithOneAccount(rt)
        const lease = await sch.acquire({ requestedModel: 'qwen3.8-max-preview' })

        lease.release('incomplete')

        assert.equal(rt.inFlight, 0)
        assert.equal(sch.getSnapshot().globalInFlight, 0)
        // incomplete now gets 1s cooldown to force rotation away from this account
        assert.ok(rt.cooldownUntil > Date.now() - 100, 'should have cooldown set')
        assert.equal(rt.requestStats.failure, 1, 'incomplete marks as failure for rotation')
        assert.equal(rt.requestStats.success, 0)
        assert.equal(rt.requestStats.incomplete, 0)
        assert.equal(rt.requestStats.aborted, 0)
    })

    test('double release on abort is safe (idempotent)', async () => {
        const rt = createRuntime('3')
        const sch = createSchedulerWithOneAccount(rt)
        const lease = await sch.acquire({ requestedModel: 'qwen3.8-max-preview' })

        lease.release('client_aborted')
        // Second release should be a no-op — lease already removed from _leased map
        assert.doesNotThrow(() => lease.release('client_aborted'))

        assert.equal(rt.inFlight, 0)
        assert.equal(sch.getSnapshot().globalInFlight, 0)
    })

    test('account available again immediately after abort release', async () => {
        const rt = createRuntime('4')
        const sch = createSchedulerWithOneAccount(rt)
        const lease1 = await sch.acquire({ requestedModel: 'qwen3.8-max-preview' })
        lease1.release('client_aborted')
        assert.equal(sch.getSnapshot().globalInFlight, 0)

        // Should be able to acquire again immediately
        const lease2 = await sch.acquire({ requestedModel: 'qwen3.8-max-preview' })
        assert.ok(lease2, 'should acquire second lease after abort release')
        assert.ok(lease2.account, 'lease should have account')
        assert.equal(rt.inFlight, 1)
        lease2.release('success')

        // Verify the success was recorded (not the abort)
        assert.equal(rt.requestStats.success, 1)
        assert.equal(rt.requestStats.failure, 0)
    })

    test('queue waiter removed on client disconnect (AbortSignal)', async () => {
        const rt = createRuntime('5')
        const sch = createSchedulerWithOneAccount(rt)

        // Fill the only slot
        const lease1 = await sch.acquire({ requestedModel: 'qwen3.8-max-preview' })
        assert.equal(sch.getSnapshot().queueDepth, 0)

        // Queue a second request with AbortSignal
        const controller = new AbortController()
        const acquirePromise = sch.acquire({
            requestedModel: 'qwen3.8-max-preview',
            signal: controller.signal,
            deadline: Date.now() + 5000
        })

        // Give the waiter a moment to be enqueued
        await new Promise(r => setTimeout(r, 20))
        assert.equal(sch._queue.length, 1, 'waiter should be in queue')

        // Abort while waiting
        controller.abort()

        await assert.rejects(
            acquirePromise,
            (err) => {
                assert.equal(err.status, 499, `expected status=499, got ${err.status}`)
                assert.equal(err.code, 'CLIENT_ABORTED', `expected code=CLIENT_ABORTED, got ${err.code}`)
                return true
            },
            'queued acquire should reject with 499 CLIENT_ABORTED'
        )

        // Waiter should have been removed from the queue
        assert.equal(sch._queue.length, 0, 'queue should be empty after abort')

        // Release the first lease — should not wake anything (queue is empty)
        lease1.release('success')
        assert.equal(rt.inFlight, 0)
        assert.equal(sch.getSnapshot().queueDepth, 0)
    })

    test('client_aborted does not set cooldown', async () => {
        const rt = createRuntime('6')
        const sch = createSchedulerWithOneAccount(rt)
        const lease = await sch.acquire({ requestedModel: 'qwen3.8-max-preview' })
        const cooldownBefore = rt.cooldownUntil

        lease.release('client_aborted')

        assert.equal(rt.cooldownUntil, cooldownBefore, 'cooldown should be unchanged by client_aborted')
        assert.equal(rt.isInCooldown, false, 'account should NOT be in cooldown after client_aborted')
    })

    test('client_aborted differs from aborted (the latter penalizes account)', async () => {
        // 验证 client_aborted (客户端断开) vs aborted (上游中断) 的语义差异
        const rt1 = createRuntime('7a')
        const sch1 = createSchedulerWithOneAccount(rt1)
        const lease1 = await sch1.acquire({})
        lease1.release('client_aborted')
        assert.equal(rt1.requestStats.failure, 0, 'client_aborted should NOT mark failure')

        const rt2 = createRuntime('7b')
        const sch2 = createSchedulerWithOneAccount(rt2)
        const lease2 = await sch2.acquire({})
        lease2.release('aborted')
        assert.equal(rt2.requestStats.failure, 1, 'aborted should mark failure (upstream abort penalizes account)')
        assert.equal(rt2.failureState.lastReason, 'aborted')
    })
})
