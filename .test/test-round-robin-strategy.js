const test = require('node:test')
const assert = require('node:assert/strict')
const { AccountScheduler } = require('../src/shared/account-scheduler')
const { AccountRuntime } = require('../src/shared/account-runtime')

test('AccountScheduler round-robin routing strategy rotates across accounts', async () => {
    const runtimes = new Map()
    for (let i = 1; i <= 5; i++) {
        const rt = new AccountRuntime({
            email: `acc${i}@test.com`,
            token: `token${i}`,
            enabled: true,
        })
        runtimes.set(rt.accountId, rt)
    }

    const scheduler = new AccountScheduler(runtimes, {
        providerId: 'deepseek',
        routingStrategy: 'round-robin',
        maxConcurrencyPerAccount: 5,
        globalMaxConcurrency: 25,
    })

    const selectedEmails = []
    const leases = []
    for (let i = 0; i < 5; i++) {
        const lease = await scheduler.acquire({ sessionKey: 'test-session' })
        selectedEmails.push(lease.account.email)
        leases.push(lease)
    }

    assert.deepEqual(selectedEmails, [
        'acc1@test.com',
        'acc2@test.com',
        'acc3@test.com',
        'acc4@test.com',
        'acc5@test.com',
    ], 'First round should rotate acc1..acc5')

    // Second round (still rotating even with sessionKey provided)
    const secondRoundEmails = []
    for (let i = 0; i < 5; i++) {
        const lease = await scheduler.acquire({ sessionKey: 'test-session' })
        secondRoundEmails.push(lease.account.email)
        leases.push(lease)
    }

    assert.deepEqual(secondRoundEmails, [
        'acc1@test.com',
        'acc2@test.com',
        'acc3@test.com',
        'acc4@test.com',
        'acc5@test.com',
    ], 'Second round should rotate acc1..acc5 again under high concurrency')

    for (const l of leases) l.release('success')
})