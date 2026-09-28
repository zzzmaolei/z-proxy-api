/**
 * test-qwen-mock-concurrency.js
 *
 * Stress tests the QwenScheduler with mock concurrent requests.
 * Verifies that no account exceeds its max concurrency limit,
 * regardless of the number of concurrent requests.
 */

const { QwenScheduler } = require('../src/backends/qwen/scheduler')
const { AccountRuntime } = require('../src/backends/qwen/account-runtime')

function createMockAccounts(count) {
    const runtimes = new Map()
    for (let i = 0; i < count; i++) {
        const rt = new AccountRuntime({
            email: `user${i}@test.com`,
            token: `token_${i}`,
            password: 'test'
        })
        runtimes.set(rt.accountId, rt)
    }
    return runtimes
}

async function runConcurrencyTest(accountCount, concurrentRequests, maxPerAccount = 1) {
    const runtimes = createMockAccounts(accountCount)
    const scheduler = new QwenScheduler(runtimes, {
        qwenMaxConcurrencyPerAccount: maxPerAccount,
        qwenGlobalMaxConcurrency: accountCount,
        qwenMaxQueueSize: concurrentRequests * 2,
        qwenQueueTimeoutMs: 30000
    })

    // Track max observed inFlight per account
    const maxObserved = new Map()
    for (const [id] of runtimes) maxObserved.set(id, 0)

    // Track current inFlight per account (for real-time updates)
    const currentInFlight = new Map()
    for (const [id] of runtimes) currentInFlight.set(id, 0)

    const requests = Array.from({ length: concurrentRequests }, (_, i) =>
        (async () => {
            const lease = await scheduler.acquire()

            const current = (currentInFlight.get(lease.accountId) || 0) + 1
            currentInFlight.set(lease.accountId, current)
            if (current > (maxObserved.get(lease.accountId) || 0)) {
                maxObserved.set(lease.accountId, current)
            }

            // Simulate request processing
            await new Promise(r => setTimeout(r, Math.random() * 100 + 10))

            const after = (currentInFlight.get(lease.accountId) || 1) - 1
            currentInFlight.set(lease.accountId, after)
            lease.release()
        })()
    )

    await Promise.all(requests)

    // Check: no account exceeded maxPerAccount
    let violations = 0
    for (const [id, max] of maxObserved) {
        if (max > maxPerAccount) {
            console.log(`  VIOLATION: account ${id.slice(0, 8)}... had ${max} inFlight (max=${maxPerAccount})`)
            violations++
        }
    }

    const snapshot = scheduler.getSnapshot()
    const pass = violations === 0 && snapshot.globalInFlight === 0
    const status = pass ? 'PASS' : 'FAIL'
    console.log(`  ${status}: ${accountCount} accounts, ${concurrentRequests} concurrent → ${violations} violations, queue peak=${snapshot.queueDepth}, final inFlight=${snapshot.globalInFlight}`)

    return pass
}

async function main() {
    console.log('Qwen Scheduler Concurrency Stress Test')
    console.log('=======================================\n')

    let passed = 0
    let failed = 0

    const tests = [
        [20, 20],
        [20, 50],
        [100, 100],
        [100, 200],
        [5, 50]
    ]

    for (const [accounts, concurrency] of tests) {
        const ok = await runConcurrencyTest(accounts, concurrency)
        if (ok) passed++
        else failed++
    }

    console.log(`\nResults: ${passed} passed, ${failed} failed (${passed + failed} total)`)
    if (failed > 0) {
        console.error('SOME TESTS FAILED')
        process.exitCode = 1
    } else {
        console.log('ALL TESTS PASSED')
    }
}

main().catch(err => {
    console.error('FATAL:', err)
    process.exitCode = 1
})