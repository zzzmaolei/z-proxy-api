/**
 * test-qwen-scheduler-wired.js
 *
 * 验证 QwenScheduler acquire/release 的核心语义：
 *   - lease 含 release() 方法、release 幂等
 *   - 达到 maxConcurrencyPerAccount 的账号被跳过
 *   - outcome 映射（success/failure/client_aborted）
 *   - 1000 轮竞争下 inFlight 永不超过 maxConcurrency
 *
 * 实现说明：
 *   - QwenScheduler 无 registerAccount 方法，账号通过构造函数的 Map 注册
 *   - 使用真实 AccountRuntime 而非 mock，避免 mock 漂移
 *   - 1000 轮竞争测试修复了示例中的死锁（持有 50 lease 但 globalMaxConcurrency=20）
 */

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const { QwenScheduler } = require('../src/backends/qwen/scheduler.js')
const { AccountRuntime } = require('../src/backends/qwen/account-runtime.js')

// Helper: create a real AccountRuntime with a stable accountId
function createRuntime(accountId) {
    return new AccountRuntime({
        accountId,
        email: `${accountId}@test.com`,
        token: `token-${accountId}`,
        password: 'test'
    })
}

// Helper: build a scheduler with N accounts
function buildScheduler(accountIds, opts = {}) {
    const runtimes = new Map()
    for (const id of accountIds) {
        const rt = createRuntime(id)
        runtimes.set(rt.accountId, rt)
    }
    return new QwenScheduler(runtimes, {
        maxConcurrencyPerAccount: opts.maxConcurrencyPerAccount ?? 1,
        globalMaxConcurrency: opts.globalMaxConcurrency ?? accountIds.length,
        maxQueueSize: opts.maxQueueSize ?? 500,
        queueTimeoutMs: opts.queueTimeoutMs ?? 5000
    })
}

describe('QwenScheduler wired correctly', () => {
    test('acquire returns lease with release() method', async () => {
        const sch = buildScheduler(['acc-1'])
        const lease = await sch.acquire({ requestedModel: 'qwen3.8-max-preview' })
        assert.ok(lease.account, 'lease.account should exist')
        assert.ok(typeof lease.release === 'function', 'release should be a function')
        assert.ok(lease.leaseId != null, 'leaseId should be non-null')
        lease.release('success')
        const rt = sch.accounts.get(lease.accountRuntime.accountId)
        assert.equal(rt.inFlight, 0, 'inFlight should be 0 after release')
    })

    test('release is idempotent', async () => {
        const sch = buildScheduler(['acc-2'])
        const lease = await sch.acquire({ requestedModel: 'qwen3.8-max-preview' })
        lease.release('success')
        lease.release('success')  // second call should be no-op
        lease.release('failure')  // third call should be no-op
        const rt = sch.accounts.get(lease.accountRuntime.accountId)
        assert.equal(rt.inFlight, 0, 'inFlight should be 0')
        assert.equal(rt.requestStats.success, 1, 'success count should be 1')
        assert.equal(rt.requestStats.failure, 0, 'failure count should be 0')
    })

    test('account at max concurrency is skipped', async () => {
        const sch = buildScheduler(['acc-3', 'acc-4'], { maxConcurrencyPerAccount: 1 })
        const lease1 = await sch.acquire({ requestedModel: 'qwen3.8-max-preview' })
        const rt1 = lease1.accountRuntime
        const rt2 = [...sch.accounts.values()].find(r => r.accountId !== rt1.accountId)
        assert.equal(rt1.inFlight + rt2.inFlight, 1, 'one account should be in-flight')

        const lease2 = await sch.acquire({ requestedModel: 'qwen3.8-max-preview' })
        assert.equal(rt1.inFlight + rt2.inFlight, 2, 'both accounts should be in-flight')
        // The account that got lease1 should NOT get lease2
        assert.notEqual(lease1.accountRuntime.accountId, lease2.accountRuntime.accountId)
        lease1.release('success')
        lease2.release('success')
    })

    test('outcome success calls markSuccess', async () => {
        const sch = buildScheduler(['acc-5'])
        const lease = await sch.acquire({ requestedModel: 'qwen3.8-max-preview' })
        lease.release('success')
        const rt = sch.accounts.get(lease.accountRuntime.accountId)
        assert.equal(rt.requestStats.success, 1, 'markSuccess should increment success')
    })

    test('outcome failure calls markFailure', async () => {
        const sch = buildScheduler(['acc-6'])
        const lease = await sch.acquire({ requestedModel: 'qwen3.8-max-preview' })
        lease.release('failure')
        const rt = sch.accounts.get(lease.accountRuntime.accountId)
        assert.equal(rt.requestStats.failure, 1, 'markFailure should increment failure')
    })

    test('outcome client_aborted does not penalize', async () => {
        const sch = buildScheduler(['acc-7'])
        const lease = await sch.acquire({ requestedModel: 'qwen3.8-max-preview' })
        lease.release('client_aborted')
        const rt = sch.accounts.get(lease.accountRuntime.accountId)
        assert.equal(rt.requestStats.failure, 0, 'client_aborted should not count as failure')
        assert.equal(rt.requestStats.success, 0, 'client_aborted should not count as success')
    })

    test('1000-round contention: inFlight never exceeds maxConcurrency', async () => {
        const accountIds = []
        for (let i = 0; i < 20; i++) accountIds.push(`acc-contend-${i}`)
        const sch = buildScheduler(accountIds, {
            maxConcurrencyPerAccount: 1,
            globalMaxConcurrency: 20,
            maxQueueSize: 500,
            queueTimeoutMs: 10000
        })
        const runtimes = [...sch.accounts.values()]
        let observedMaxInFlight = 0
        const leases = []
        for (let i = 0; i < 1000; i++) {
            // Release oldest first when at global capacity to avoid deadlock
            // (acquire would otherwise block forever waiting for a slot)
            if (leases.length >= 20) {
                const old = leases.shift()
                old.release('success')
            }
            const lease = await sch.acquire({ requestedModel: 'qwen3.8-max-preview' })
            leases.push(lease)
            const totalInFlight = runtimes.reduce((s, r) => s + r.inFlight, 0)
            observedMaxInFlight = Math.max(observedMaxInFlight, totalInFlight)
        }
        // Drain remaining
        while (leases.length > 0) {
            leases.shift().release('success')
        }
        assert.ok(observedMaxInFlight <= 20, `observedMaxInFlight=${observedMaxInFlight} should be <= 20`)
    })
})
