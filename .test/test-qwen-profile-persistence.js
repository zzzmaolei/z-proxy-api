/**
 * test-qwen-profile-persistence.js
 *
 * 验证 clientProfile 持久化到 AccountRuntime：
 *   1. AccountRuntime 有 clientProfile 字段（默认 null）
 *   2. AccountRuntime 构造时从 account.clientProfile 读取并存到 rt.clientProfile
 *   3. 同一 email 多次调用 assignProfileToAccount 得到相同 profile（确定性，模拟跨重启）
 *   4. profile 有稳定的 _profileId（基于 email 哈希派生）
 *   5. assignProfileToAccount 之后的 account 可直接传给 AccountRuntime 构造
 *   6. resetRuntime 不清除 clientProfile（账号恢复时特征保持）
 *
 * 运行：node --test .test/test-qwen-profile-persistence.js
 */

process.env.QWEN_CLIENT_PROFILE_MODE = 'stable-per-account'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const { AccountRuntime } = require('../src/backends/qwen/account-runtime.js')
const { assignProfileToAccount } = require('../src/backends/qwen/client-profile.js')

describe('ClientProfile persistence in AccountRuntime', () => {
    test('AccountRuntime has clientProfile field, defaults to null', () => {
        const runtime = new AccountRuntime({
            email: 'persist-field@test.com',
            token: 'tok'
        })
        assert.ok('clientProfile' in runtime, 'AccountRuntime should have clientProfile field')
        assert.equal(runtime.clientProfile, null, 'clientProfile should default to null when not provided')
    })

    test('AccountRuntime reads clientProfile from account argument (same reference)', () => {
        const fakeProfile = {
            userAgent: 'Mozilla/5.0 FakeUA',
            secChUa: '"Chromium";v="150"',
            secChUaPlatform: '"Windows"',
            secChUaMobile: '?0',
            acceptLanguage: 'en-US,en;q=0.9',
            locale: 'en-US',
            timezoneOffsetMinutes: 480,
            timezoneFamily: 'Asia/Shanghai',
            _profileId: 'Chrome-150|en-US|Asia/Shanghai'
        }
        const runtime = new AccountRuntime({
            email: 'persist-inject@test.com',
            token: 'tok',
            clientProfile: fakeProfile
        })
        assert.equal(runtime.clientProfile, fakeProfile, 'AccountRuntime should expose the injected clientProfile (same reference)')
    })

    test('same account gets same profile across simulated restarts (deterministic)', () => {
        // 模拟进程重启 → 重新加载账号 → 重新分配 profile
        const account1 = { email: 'restart@test.com', token: 'tok' }
        assignProfileToAccount(account1)

        // 模拟重启：新的 account 对象，同样的 email
        const account2 = { email: 'restart@test.com', token: 'tok' }
        assignProfileToAccount(account2)

        assert.ok(account1.clientProfile, 'first assignment should produce a profile')
        assert.ok(account2.clientProfile, 'second assignment should produce a profile')
        assert.deepEqual(
            account1.clientProfile,
            account2.clientProfile,
            'same email should produce identical profile across "restarts"'
        )
    })

    test('profile has stable _profileId derived from email', () => {
        const account1 = { email: 'stable-id@test.com', token: 'tok' }
        const account2 = { email: 'stable-id@test.com', token: 'tok' }
        assignProfileToAccount(account1)
        assignProfileToAccount(account2)
        assert.ok(account1.clientProfile._profileId, 'profile should have _profileId')
        assert.equal(
            account1.clientProfile._profileId,
            account2.clientProfile._profileId,
            '_profileId should be stable across calls for the same email'
        )
    })

    test('AccountRuntime can be constructed from an account that has been assigned a profile', () => {
        // 真实流程：accountManager 加载账号 → assignProfileToAccount → AccountRuntime 构造
        const account = { email: 'realistic@test.com', token: 'tok', password: 'pw' }
        assignProfileToAccount(account)
        assert.ok(account.clientProfile, 'assignProfileToAccount should have set clientProfile')

        const runtime = new AccountRuntime(account)
        assert.equal(
            runtime.clientProfile,
            account.clientProfile,
            'AccountRuntime should pick up clientProfile from account argument (same reference)'
        )
        assert.equal(runtime.email, 'realistic@test.com')
        assert.ok(runtime.accountId, 'runtime should have accountId')
    })

    test('resetRuntime preserves clientProfile (account recovery)', () => {
        // resetRuntime 用于账号恢复 — 不应清除 clientProfile
        const account = { email: 'reset@test.com', token: 'tok', password: 'pw' }
        assignProfileToAccount(account)
        const runtime = new AccountRuntime(account)
        const profileBefore = runtime.clientProfile
        assert.ok(profileBefore, 'profile should be set before reset')

        // Inject some runtime state
        runtime.inFlight = 2
        runtime.cooldownUntil = Date.now() + 60000
        runtime.failureState.count = 3

        runtime.resetRuntime()

        assert.equal(runtime.clientProfile, profileBefore, 'resetRuntime should preserve clientProfile (same reference)')
        assert.equal(runtime.inFlight, 0, 'resetRuntime should clear inFlight')
        assert.equal(runtime.cooldownUntil, 0, 'resetRuntime should clear cooldown')
        assert.equal(runtime.failureState.count, 0, 'resetRuntime should clear failure count')
    })

    test('account without email gets null profile (assignProfileToAccount skips)', () => {
        const account = { /* no email */ token: 'tok' }
        assignProfileToAccount(account)
        assert.equal(account.clientProfile, undefined, 'account without email should not get a profile')
    })

    test('credentials are separated from clientProfile (no leakage)', () => {
        // 验证 clientProfile 不会泄露到 credentials，反之亦然
        const account = {
            email: 'isolation@test.com',
            token: 'secret-token',
            password: 'secret-password'
        }
        assignProfileToAccount(account)
        const runtime = new AccountRuntime(account)

        assert.equal(runtime.credentials.token, 'secret-token')
        assert.equal(runtime.credentials.email, 'isolation@test.com')
        assert.ok(runtime.clientProfile)
        assert.ok(!JSON.stringify(runtime.clientProfile).includes('secret-token'),
            'clientProfile must not contain token')
        assert.ok(!JSON.stringify(runtime.clientProfile).includes('secret-password'),
            'clientProfile must not contain password')
    })
})
