/**
 * test-qwen-mock-stress.js
 *
 * Qwen Mock 压测脚本 — 测试 1/20/50/100 并发下 QwenScheduler 的调度稳定性。
 *
 * 场景：
 *   1. 正常流（acquire → 短处理 → release success）
 *   2. 慢首包（acquire → 长等待 → release）
 *   3. 慢流（acquire → 多次间隔释放 → release）
 *   4. 随机 5xx/断流（acquire → release failure/upstream_error/incomplete）
 *   5. 客户端断开（acquire → release client_aborted）
 *   6. backpressure（acquire → 长时间持有 → release）
 *   7. 大 Prompt（estimatedPromptBytes 参数）
 *   8. 图片上传（mediaBytes 参数）
 *
 * 检查：
 *   - inFlight 从不超过 maxConcurrencyPerAccount × accountCount
 *   - 租约无泄漏（所有 _leased 条目最终清空，_inFlight 归零）
 *   - 内存增长有界
 *   - event loop 不阻塞（setImmediate tick < 100ms）
 *
 * 运行：node --test .test/test-qwen-mock-stress.js
 */

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const { QwenScheduler } = require('../src/backends/qwen/scheduler')
const { AccountRuntime } = require('../src/backends/qwen/account-runtime')

// ──────────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

const getMemUsage = () => {
    const m = process.memoryUsage()
    return {
        rssMB: Math.round(m.rss / 1024 / 1024),
        heapUsedMB: Math.round(m.heapUsed / 1024 / 1024),
        heapTotalMB: Math.round(m.heapTotal / 1024 / 1024)
    }
}

/** Best-effort GC if --expose-gc is passed; no-op otherwise. */
const maybeGC = () => {
    if (typeof global.gc === 'function') {
        try { global.gc() } catch { /* ignore */ }
    }
}

/** Create a real AccountRuntime with mock credentials. */
const createRuntime = (accountId) => {
    return new AccountRuntime({
        accountId,
        email: `${accountId}@stress.test`,
        token: `tok-${accountId}`,
        password: 'stress'
    })
}

/**
 * Register an AccountRuntime into the scheduler.
 * The real QwenScheduler has no registerAccount() method — registration happens
 * either via the constructor Map or by directly setting accounts + _accountInFlight.
 */
const registerAccount = (sch, rt) => {
    sch.accounts.set(rt.accountId, rt)
    sch._accountInFlight.set(rt.accountId, 0)
}

// ──────────────────────────────────────────────────
//  Scenarios — each acquires a lease, simulates work, then releases.
//  All scenarios accept (sch, model, opts) where opts.deadline is forwarded
//  to acquire() so workers queued near the end of the stress window can be
//  unblocked (QUEUE_DEADLINE_EXCEEDED) instead of hanging for queueTimeoutMs.
//  try/finally guarantees release even if sleep is interrupted.
// ──────────────────────────────────────────────────

// 1. 正常流
const scenarioNormal = async (sch, model, opts = {}) => {
    const lease = await sch.acquire({ requestedModel: model, deadline: opts.deadline })
    try { await sleep(10 + Math.random() * 50) } finally { lease.release('success') }
}

// 2. 慢首包
const scenarioSlowFirstByte = async (sch, model, opts = {}) => {
    const lease = await sch.acquire({ requestedModel: model, deadline: opts.deadline })
    try { await sleep(500 + Math.random() * 500) } finally { lease.release('success') }
}

// 3. 慢流
const scenarioSlowStream = async (sch, model, opts = {}) => {
    const lease = await sch.acquire({ requestedModel: model, deadline: opts.deadline })
    try { for (let i = 0; i < 5; i++) await sleep(100) } finally { lease.release('success') }
}

// 4. 随机 5xx/断流
const scenarioRandomFailure = async (sch, model, opts = {}) => {
    const lease = await sch.acquire({ requestedModel: model, deadline: opts.deadline })
    try { await sleep(10) } finally {
        const outcomes = ['failure', 'upstream_error', 'incomplete', 'success']
        lease.release(outcomes[Math.floor(Math.random() * outcomes.length)])
    }
}

// 5. 客户端断开
const scenarioClientAbort = async (sch, model, opts = {}) => {
    const lease = await sch.acquire({ requestedModel: model, deadline: opts.deadline })
    try { await sleep(5) } finally { lease.release('client_aborted') }
}

// 6. backpressure（长时间持有租约）
const scenarioBackpressure = async (sch, model, opts = {}) => {
    const lease = await sch.acquire({ requestedModel: model, deadline: opts.deadline })
    try { await sleep(1000 + Math.random() * 2000) } finally { lease.release('success') }
}

// 7. 大 Prompt
const scenarioLargePrompt = async (sch, model, opts = {}) => {
    const lease = await sch.acquire({
        requestedModel: model,
        deadline: opts.deadline,
        estimatedPromptBytes: 500 * 1024 // 500KB
    })
    try { await sleep(50) } finally { lease.release('success') }
}

// 8. 图片上传
const scenarioImageUpload = async (sch, model, opts = {}) => {
    const lease = await sch.acquire({
        requestedModel: model,
        deadline: opts.deadline,
        mediaBytes: 5 * 1024 * 1024 // 5MB
    })
    try { await sleep(100) } finally { lease.release('success') }
}

// ──────────────────────────────────────────────────
//  runStress — runs `concurrency` workers each looping `scenario` for `durationMs`.
//  A 5ms setInterval samples inFlight/queueDepth to catch transient spikes.
//  deadline = startTime + durationMs ensures queued workers unblock promptly.
// ──────────────────────────────────────────────────

const runStress = async (sch, concurrency, scenario, durationMs) => {
    const startTime = Date.now()
    const deadline = startTime + durationMs

    maybeGC()
    const memBefore = getMemUsage()

    let completed = 0
    let failed = 0
    let maxObservedInFlight = 0
    let maxGlobalInFlight = 0
    let maxQueueDepth = 0

    // Background sampler — catches inFlight spikes the per-iteration check might miss.
    const checker = setInterval(() => {
        let total = 0
        for (const [, rt] of sch.accounts) total += rt.inFlight
        if (total > maxObservedInFlight) maxObservedInFlight = total
        if (sch._inFlight > maxGlobalInFlight) maxGlobalInFlight = sch._inFlight
        if (sch._queue.length > maxQueueDepth) maxQueueDepth = sch._queue.length
    }, 5)

    const workers = []
    for (let i = 0; i < concurrency; i++) {
        workers.push((async () => {
            while (Date.now() - startTime < durationMs) {
                try {
                    await scenario(sch, 'qwen3-max-preview', { deadline })
                    completed++
                } catch {
                    // deadline exceeded / queue full / queue timeout — expected under load
                    failed++
                }
            }
        })())
    }

    await Promise.all(workers)
    clearInterval(checker)

    maybeGC()
    const memAfter = getMemUsage()

    return {
        concurrency,
        durationMs: Date.now() - startTime,
        completed,
        failed,
        maxObservedInFlight,
        maxGlobalInFlight,
        maxQueueDepth,
        memBefore,
        memAfter,
        memGrowthMB: memAfter.heapUsedMB - memBefore.heapUsedMB,
        leasedRemaining: sch._leased.size,
        globalInFlight: sch._inFlight,
        queueRemaining: sch._queue.length
    }
}

// ──────────────────────────────────────────────────
//  Tests
// ──────────────────────────────────────────────────

describe('Mock stress test', () => {
    test('1 concurrent: normal flow', async () => {
        const sch = new QwenScheduler({
            maxConcurrencyPerAccount: 1,
            globalMaxConcurrency: 10,
            maxQueueSize: 100,
            queueTimeoutMs: 5000
        })
        registerAccount(sch, createRuntime('stress-1'))

        const result = await runStress(sch, 1, scenarioNormal, 1000)

        assert.ok(result.maxObservedInFlight <= 1,
            `inFlight=${result.maxObservedInFlight} should be <= 1`)
        assert.ok(result.completed > 0,
            `completed=${result.completed} should be > 0`)
        assert.equal(result.failed, 0,
            `failed=${result.failed} should be 0`)
        assert.equal(result.leasedRemaining, 0, 'leased map should be empty after stress')
        assert.equal(result.globalInFlight, 0, 'global inFlight should be 0 after stress')
        assert.equal(result.queueRemaining, 0, 'queue should be empty after stress')
    })

    test('20 concurrent: mixed scenarios', async () => {
        const sch = new QwenScheduler({
            maxConcurrencyPerAccount: 1,
            globalMaxConcurrency: 10,
            maxQueueSize: 200,
            queueTimeoutMs: 5000
        })
        for (let i = 0; i < 5; i++) {
            registerAccount(sch, createRuntime(`stress-20-${i}`))
        }

        const scenarios = [
            scenarioNormal,
            scenarioSlowFirstByte,
            scenarioRandomFailure,
            scenarioClientAbort,
            scenarioBackpressure
        ]
        const mixedScenario = async (sch, model, opts = {}) => {
            const s = scenarios[Math.floor(Math.random() * scenarios.length)]
            await s(sch, model, opts)
        }

        const result = await runStress(sch, 20, mixedScenario, 2000)

        // 5 accounts × 1 max = 5 slots
        assert.ok(result.maxObservedInFlight <= 5,
            `inFlight=${result.maxObservedInFlight} should be <= 5 (5 accounts × 1)`)
        assert.ok(result.completed + result.failed > 0,
            'should have some completions or failures')
        assert.equal(result.leasedRemaining, 0,
            `leased should be empty, got ${result.leasedRemaining}`)
        assert.equal(result.globalInFlight, 0,
            `global inFlight should be 0, got ${result.globalInFlight}`)
        assert.equal(result.queueRemaining, 0,
            `queue should be empty, got ${result.queueRemaining}`)

        // Per-account inFlight leak check
        for (const [, rt] of sch.accounts) {
            assert.equal(rt.inFlight, 0,
                `account ${rt.accountId} has inFlight=${rt.inFlight} after stress`)
        }
    })

    test('50 concurrent: all scenarios', async () => {
        const sch = new QwenScheduler({
            maxConcurrencyPerAccount: 2,
            globalMaxConcurrency: 30,
            maxQueueSize: 500,
            queueTimeoutMs: 5000
        })
        for (let i = 0; i < 10; i++) {
            registerAccount(sch, createRuntime(`stress-50-${i}`))
        }

        const scenarios = [
            scenarioNormal,
            scenarioSlowFirstByte,
            scenarioSlowStream,
            scenarioRandomFailure,
            scenarioClientAbort,
            scenarioBackpressure,
            scenarioLargePrompt,
            scenarioImageUpload
        ]
        const mixedScenario = async (sch, model, opts = {}) => {
            const s = scenarios[Math.floor(Math.random() * scenarios.length)]
            await s(sch, model, opts)
        }

        const result = await runStress(sch, 50, mixedScenario, 3000)

        // 10 accounts × 2 max = 20 slots
        assert.ok(result.maxObservedInFlight <= 20,
            `inFlight=${result.maxObservedInFlight} should be <= 20 (10 accounts × 2)`)
        assert.ok(result.memGrowthMB < 50,
            `memory growth ${result.memGrowthMB}MB should be < 50MB`)
        assert.equal(result.leasedRemaining, 0,
            `leased should be empty, got ${result.leasedRemaining}`)
        assert.equal(result.globalInFlight, 0,
            `global inFlight should be 0, got ${result.globalInFlight}`)
        assert.equal(result.queueRemaining, 0,
            `queue should be empty, got ${result.queueRemaining}`)

        for (const [, rt] of sch.accounts) {
            assert.equal(rt.inFlight, 0,
                `account ${rt.accountId} has inFlight=${rt.inFlight} after stress`)
        }
    })

    test('100 concurrent: stress with memory check', async () => {
        const sch = new QwenScheduler({
            maxConcurrencyPerAccount: 2,
            globalMaxConcurrency: 50,
            maxQueueSize: 1000,
            queueTimeoutMs: 5000
        })
        for (let i = 0; i < 20; i++) {
            registerAccount(sch, createRuntime(`stress-100-${i}`))
        }

        const scenarios = [
            scenarioNormal,
            scenarioSlowFirstByte,
            scenarioSlowStream,
            scenarioRandomFailure,
            scenarioClientAbort,
            scenarioBackpressure,
            scenarioLargePrompt,
            scenarioImageUpload
        ]
        const mixedScenario = async (sch, model, opts = {}) => {
            const s = scenarios[Math.floor(Math.random() * scenarios.length)]
            await s(sch, model, opts)
        }

        const result = await runStress(sch, 100, mixedScenario, 5000)

        // 20 accounts × 2 max = 40 slots
        assert.ok(result.maxObservedInFlight <= 40,
            `inFlight=${result.maxObservedInFlight} should be <= 40 (20 accounts × 2)`)
        assert.ok(result.memGrowthMB < 100,
            `memory growth ${result.memGrowthMB}MB should be < 100MB`)
        assert.equal(result.leasedRemaining, 0,
            `leased should be empty, got ${result.leasedRemaining}`)
        assert.equal(result.globalInFlight, 0,
            `global inFlight should be 0, got ${result.globalInFlight}`)
        assert.equal(result.queueRemaining, 0,
            `queue should be empty, got ${result.queueRemaining}`)

        // Per-account inFlight leak check — all must return to 0
        for (const [, rt] of sch.accounts) {
            assert.equal(rt.inFlight, 0,
                `account ${rt.accountId} has inFlight=${rt.inFlight} after stress`)
        }

        // Scheduler's internal _accountInFlight must also be 0 for every account
        for (const [id, count] of sch._accountInFlight) {
            assert.equal(count, 0,
                `_accountInFlight for ${id} should be 0, got ${count}`)
        }
    })

    test('lease leak detection: all leases released after stress', async () => {
        const sch = new QwenScheduler({
            maxConcurrencyPerAccount: 1,
            globalMaxConcurrency: 10,
            maxQueueSize: 100,
            queueTimeoutMs: 5000
        })
        for (let i = 0; i < 5; i++) {
            registerAccount(sch, createRuntime(`leak-${i}`))
        }

        const leases = []
        for (let i = 0; i < 5; i++) {
            const lease = await sch.acquire({ requestedModel: 'qwen3-max-preview' })
            leases.push(lease)
        }

        // 5 leases acquired → 5 in-flight
        assert.equal(sch._inFlight, 5, 'should have 5 in-flight after 5 acquires')
        assert.equal(sch._leased.size, 5, 'should have 5 leased entries')

        // Release all
        for (const lease of leases) {
            lease.release('success')
        }

        // Idempotent release — second call is a no-op
        for (const lease of leases) {
            lease.release('success')
        }

        assert.equal(sch._leased.size, 0, 'leased map should be empty after all releases')
        assert.equal(sch._inFlight, 0, 'global inFlight should be 0')
        for (const [, rt] of sch.accounts) {
            assert.equal(rt.inFlight, 0, `account ${rt.accountId} inFlight should be 0`)
        }
    })

    test('event loop not blocked: measure tick time under load', async () => {
        const sch = new QwenScheduler({
            maxConcurrencyPerAccount: 1,
            globalMaxConcurrency: 20,
            maxQueueSize: 500,
            queueTimeoutMs: 5000
        })
        for (let i = 0; i < 10; i++) {
            registerAccount(sch, createRuntime(`tick-${i}`))
        }

        // Run stress in background
        const stressPromise = runStress(sch, 50, scenarioNormal, 2000)

        // Measure event loop tick time via setImmediate
        let maxTick = 0
        for (let i = 0; i < 20; i++) {
            const start = Date.now()
            await new Promise(r => setImmediate(r))
            const tick = Date.now() - start
            if (tick > maxTick) maxTick = tick
        }

        await stressPromise

        // Event loop should not be blocked for more than 100ms
        assert.ok(maxTick < 100,
            `max event loop tick ${maxTick}ms should be < 100ms`)
    })
})
