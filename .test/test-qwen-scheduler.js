/**
 * test-qwen-scheduler.js
 *
 * QwenScheduler unit test — covers acquire/release, queue wait, cancel,
 * queue full, sticky preference, cooldown, idempotent release, shutdown,
 * and a 1000-iteration race test.
 */

const { QwenScheduler } = require('../src/backends/qwen/scheduler')
const { AccountRuntime } = require('../src/backends/qwen/account-runtime')

function createMockAccount(id) {
    return new AccountRuntime({
        email: `user${id}@test.com`,
        token: `token_${id}`,
        password: 'test'
    })
}

function createScheduler(count, maxPerAccount = 1) {
    const runtimes = new Map()
    for (let i = 0; i < count; i++) {
        const rt = createMockAccount(i)
        runtimes.set(rt.accountId, rt)
    }
    return new QwenScheduler(runtimes, {
        qwenMaxConcurrencyPerAccount: maxPerAccount,
        qwenGlobalMaxConcurrency: count,
        qwenMaxQueueSize: 50,
        qwenQueueTimeoutMs: 5000
    })
}

async function runSchedulerTests() {
    let passed = 0
    let failed = 0

    const test = async (name, fn) => {
        try {
            await fn()
            passed++
            console.log(`  PASS: ${name}`)
        } catch (e) {
            failed++
            console.log(`  FAIL: ${name} — ${e.message}`)
        }
    }

    console.log('QwenScheduler Tests')
    console.log('===================\n')

    // ── Test 1: Basic acquire/release ──
    await test('basic acquire/release', async () => {
        const s = createScheduler(3)
        const snap0 = s.getSnapshot()
        if (snap0.globalInFlight !== 0) throw new Error('initial inFlight should be 0')

        const lease = await s.acquire()
        if (!lease || !lease.leaseId) throw new Error('acquire should return a lease')
        const snap1 = s.getSnapshot()
        if (snap1.globalInFlight !== 1) throw new Error(`inFlight should be 1, got ${snap1.globalInFlight}`)

        lease.release()
        const snap2 = s.getSnapshot()
        if (snap2.globalInFlight !== 0) throw new Error(`inFlight should be 0 after release, got ${snap2.globalInFlight}`)
    })

    // ── Test 2: Max concurrency per account ──
    await test('max concurrency per account', async () => {
        // Need globalMaxConcurrency >= 2 to allow 2 inFlight on 1 account
        const runtimes = new Map()
        const rt = createMockAccount(0)
        runtimes.set(rt.accountId, rt)
        const s = new QwenScheduler(runtimes, {
            qwenMaxConcurrencyPerAccount: 2,
            qwenGlobalMaxConcurrency: 2,
            qwenMaxQueueSize: 50,
            qwenQueueTimeoutMs: 5000
        })
        const l1 = await s.acquire()
        const l2 = await s.acquire()
        const snap = s.getSnapshot()
        if (snap.globalInFlight !== 2) throw new Error(`inFlight should be 2, got ${snap.globalInFlight}`)
        l1.release()
        l2.release()
    })

    // ── Test 3: Queue wait and release wake ──
    await test('queue wait and release wake', async () => {
        const s = createScheduler(1, 1) // 1 account, max 1 — forces queue
        const l1 = await s.acquire()

        // Acquire 2nd — should go to queue
        const p2 = s.acquire()
        const snap = s.getSnapshot()
        if (snap.queueDepth !== 1) throw new Error(`queueDepth should be 1, got ${snap.queueDepth}`)

        // Release — should wake waiter
        l1.release()
        const l2 = await p2
        if (!l2 || !l2.leaseId) throw new Error('waiter should be resolved')
        l2.release()
    })

    // ── Test 4: Queue timeout ──
    await test('queue timeout', async () => {
        const s = createScheduler(1, 1)
        const l1 = await s.acquire() // consume the slot

        let timedOut = false
        try {
            await s.acquire({ deadline: Date.now() + 100 })
        } catch (e) {
            if (e.status === 429) timedOut = true
        }
        if (!timedOut) throw new Error('should timeout with 429')
        l1.release()
    })

    // ── Test 5: Queue full ──
    await test('queue full', async () => {
        const s = createScheduler(1, 1)
        const l1 = await s.acquire() // consume the slot

        // Fill the queue (maxQueueSize = 50, plus 1 already in flight)
        let fullHit = false
        const promises = []
        for (let i = 0; i < 55; i++) {
            const p = s.acquire().catch(e => {
                if (e.status === 429) fullHit = true
                return null
            })
            promises.push(p)
        }
        // Wait for all to settle
        await Promise.all(promises)
        if (!fullHit) throw new Error('should hit queue full 429')
        l1.release()
    })

    // ── Test 6: Sticky preference ──
    await test('sticky preference', async () => {
        const s = createScheduler(3, 2)
        // Get all account IDs
        const accountIds = []
        for (const [id] of s.accounts) accountIds.push(id)
        const stickyId = accountIds[1]

        // Acquire with sticky preference
        const lease = await s.acquire({ stickyAccountId: stickyId })
        if (lease.accountId !== stickyId) {
            throw new Error(`sticky should prefer ${stickyId}, got ${lease.accountId}`)
        }
        lease.release()
    })

    // ── Test 7: Cooldown exclusion ──
    await test('cooldown exclusion', async () => {
        const s = createScheduler(2, 1)
        const accountIds = []
        for (const [id] of s.accounts) accountIds.push(id)

        // Put account 0 in cooldown
        s.markCooldown(accountIds[0], 30000)

        const lease = await s.acquire()
        if (lease.accountId === accountIds[0]) {
            throw new Error('account in cooldown should not be selected')
        }
        lease.release()
    })

    // ── Test 8: Idempotent release ──
    await test('idempotent release', async () => {
        const s = createScheduler(1)
        const lease = await s.acquire()
        const snap1 = s.getSnapshot()
        if (snap1.globalInFlight !== 1) throw new Error('inFlight should be 1')

        lease.release()
        lease.release() // second release should be no-op
        lease.release()

        const snap2 = s.getSnapshot()
        if (snap2.globalInFlight !== 0) throw new Error(`inFlight should be 0 after idempotent release, got ${snap2.globalInFlight}`)
    })

    // ── Test 9: Cancel waiter ──
    await test('cancel waiter', async () => {
        const s = createScheduler(1, 1)
        const l1 = await s.acquire()

        // Queue a waiter via AbortSignal
        const ac = new AbortController()
        const p = s.acquire({ signal: ac.signal })
        await new Promise(r => setTimeout(r, 10))
        ac.abort()

        let aborted = false
        try {
            await p
        } catch (e) {
            if (e.status === 499) aborted = true
        }
        if (!aborted) throw new Error('should abort with 499')
        l1.release()
    })

    // ── Test 10: Shutdown ──
    await test('shutdown rejects queued and new', async () => {
        const s = createScheduler(1, 1)
        const l1 = await s.acquire() // consume the slot

        // Enqueue a waiter
        const p = s.acquire().catch(() => 'rejected')

        await s.shutdown()

        // New acquire should throw
        let shutdownErr = false
        try {
            await s.acquire()
        } catch (e) {
            if (e.status === 503) shutdownErr = true
        }
        if (!shutdownErr) throw new Error('new acquire after shutdown should throw 503')

        // Queued waiter should be rejected
        const result = await p
        if (result !== 'rejected') throw new Error('queued waiter should be rejected on shutdown')

        l1.release()
    })

    // ── Test 11: 1000-iteration race test ──
    await test('1000-iteration race: maxInFlight <= configuredMax', async () => {
        const accountCount = 3
        const maxPerAccount = 2
        const runtimes = new Map()
        for (let i = 0; i < accountCount; i++) {
            const rt = createMockAccount(i)
            runtimes.set(rt.accountId, rt)
        }
        const s = new QwenScheduler(runtimes, {
            qwenMaxConcurrencyPerAccount: maxPerAccount,
            qwenGlobalMaxConcurrency: accountCount * maxPerAccount,
            qwenMaxQueueSize: 2000,  // large enough for 1000 concurrent tasks
            qwenQueueTimeoutMs: 30000
        })

        let observedMaxInFlight = 0
        let concurrent = 0

        const tasks = []
        for (let i = 0; i < 1000; i++) {
            const t = (async () => {
                const lease = await s.acquire()
                concurrent++
                if (concurrent > observedMaxInFlight) {
                    observedMaxInFlight = concurrent
                }
                // Simulate brief work
                await new Promise(r => setTimeout(r, Math.random() * 5))
                concurrent--
                lease.release()
            })()
            tasks.push(t)
        }

        await Promise.all(tasks)

        const configuredMax = accountCount * maxPerAccount
        if (observedMaxInFlight > configuredMax) {
            throw new Error(`observedMaxInFlight=${observedMaxInFlight} > configuredMax=${configuredMax}`)
        }
        console.log(`    observedMaxInFlight=${observedMaxInFlight}, configuredMax=${configuredMax}`)
    })

    console.log(`\nResults: ${passed} passed, ${failed} failed (${passed + failed} total)`)
    if (failed > 0) process.exitCode = 1
}

runSchedulerTests().catch(err => {
    console.error('FATAL:', err)
    process.exitCode = 1
})