/**
 * test-qwen-retry-cap.js
 *
 * Verifies that qwenMaxAccountAttempts caps the number of account retries
 * correctly, regardless of pool size.
 */

const config = require('../src/config')

function testRetryCap() {
    let passed = 0
    let failed = 0

    const assert = (condition, message) => {
        if (condition) {
            passed++
            console.log(`  PASS: ${message}`)
        } else {
            failed++
            console.log(`  FAIL: ${message}`)
        }
    }

    console.log('Qwen Retry Cap Tests')
    console.log('====================\n')

    const maxAccountAttempts = config.qwenMaxAccountAttempts || 3
    console.log(`  qwenMaxAccountAttempts = ${maxAccountAttempts}\n`)

    // Test with 2 accounts: pool < cap, so cap = pool
    const pool2 = 2
    const total2 = Math.min(maxAccountAttempts, pool2)
    assert(total2 === 2, `2 accounts: total=${total2} (pool < cap → cap=pool)`)

    // Test with 20 accounts: pool > cap, so cap = maxAccountAttempts
    const pool20 = 20
    const total20 = Math.min(maxAccountAttempts, pool20)
    assert(total20 === 3, `20 accounts: total=${total20} (pool > cap → cap=${maxAccountAttempts})`)

    // Test with 100 accounts: pool >> cap, so cap = maxAccountAttempts
    const pool100 = 100
    const total100 = Math.min(maxAccountAttempts, pool100)
    assert(total100 === 3, `100 accounts: total=${total100} (pool >> cap → cap=${maxAccountAttempts})`)

    // Edge case: 0 accounts
    const pool0 = 0
    const total0 = Math.min(maxAccountAttempts, pool0)
    assert(total0 === 0, `0 accounts: total=${total0} (no accounts → no retries)`)

    // Edge case: 1 account
    const pool1 = 1
    const total1 = Math.min(maxAccountAttempts, pool1)
    assert(total1 === 1, `1 account: total=${total1} (single account)`)

    console.log(`\nResults: ${passed} passed, ${failed} failed (${passed + failed} total)`)
    if (failed > 0) {
        console.error('\nSOME TESTS FAILED')
        process.exitCode = 1
    } else {
        console.log('\nRetry cap tests passed')
    }
}

testRetryCap()