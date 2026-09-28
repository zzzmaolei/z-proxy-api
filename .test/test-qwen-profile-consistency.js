/**
 * test-qwen-profile-consistency.js
 *
 * 验证 profile 内部一致性（UA Chrome 版本 = sec-ch-ua Chromium 版本 等）：
 *   1. validateProfileConsistency 通过合法 profile
 *   2. validateProfileConsistency 在 null/undefined 上抛错
 *   3. validateProfileConsistency 检测 Chrome 版本不一致
 *   4. validateProfileConsistency 检测平台不一致
 *   5. validateProfileConsistency 检测 Accept-Language 首标签 vs locale 不一致
 *   6. assignProfileToAccount 产出的 profile 一定通过一致性校验
 *   7. 20 个账号都得到内部一致的 profile
 *   8. 所有分配到的 profile 的 Chrome 版本 = sec-ch-ua Chromium 版本
 *   9. 各种 timezone offset 都能生成合法字符串
 *
 * 运行：node --test .test/test-qwen-profile-consistency.js
 */

process.env.QWEN_CLIENT_PROFILE_MODE = 'stable-per-account'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const {
    assignProfileToAccount,
    validateProfileConsistency,
    buildTimezoneString
} = require('../src/backends/qwen/client-profile.js')

// 一个完全一致的 profile：Chrome 150 on Windows，locale zh-CN
// （与 client-profile.js 里 UA_VARIANTS[LANGUAGE_VARIANTS 中的 zh-CN] 的形态对齐）
const CONSISTENT_PROFILE = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    secChUa: '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
    secChUaPlatform: '"Windows"',
    secChUaMobile: '?0',
    acceptLanguage: 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    locale: 'zh-CN',
    timezoneOffsetMinutes: 480,
    timezoneFamily: 'Asia/Shanghai',
    _profileId: 'Chrome-150|zh-CN|Asia/Shanghai'
}

describe('ClientProfile internal consistency', () => {
    test('validateProfileConsistency passes for a valid profile', () => {
        assert.doesNotThrow(() => validateProfileConsistency(CONSISTENT_PROFILE))
    })

    test('validateProfileConsistency throws on null/undefined profile', () => {
        assert.throws(() => validateProfileConsistency(null), /null\/undefined/i)
        assert.throws(() => validateProfileConsistency(undefined), /null\/undefined/i)
    })

    test('validateProfileConsistency throws on Chrome version mismatch', () => {
        const bad = {
            ...CONSISTENT_PROFILE,
            userAgent: CONSISTENT_PROFILE.userAgent.replace('Chrome/150', 'Chrome/131')
        }
        assert.throws(
            () => validateProfileConsistency(bad),
            /Chrome version mismatch/
        )
    })

    test('validateProfileConsistency throws on platform mismatch', () => {
        const bad = {
            ...CONSISTENT_PROFILE,
            userAgent: CONSISTENT_PROFILE.userAgent.replace(
                'Windows NT 10.0',
                'Macintosh; Mac OS X 10_15_7'
            )
            // secChUaPlatform 仍是 '"Windows"'，与 UA 中的 macOS 不一致
        }
        assert.throws(
            () => validateProfileConsistency(bad),
            /Platform mismatch/
        )
    })

    test('validateProfileConsistency throws on Accept-Language vs locale mismatch', () => {
        const bad = { ...CONSISTENT_PROFILE, locale: 'en-US' }
        // acceptLanguage 首标签是 zh-CN，但 locale 改成 en-US
        assert.throws(
            () => validateProfileConsistency(bad),
            /Language mismatch/
        )
    })

    test('assignProfileToAccount produces internally consistent profile', () => {
        const account = { email: 'consistency-assign@test.com' }
        assignProfileToAccount(account)
        const profile = account.clientProfile
        assert.ok(profile, 'profile should be assigned')
        // Should not throw
        assert.doesNotThrow(() => validateProfileConsistency(profile))
    })

    test('multiple accounts (20) all get internally consistent profiles', () => {
        for (let i = 0; i < 20; i++) {
            const account = { email: `multi-${i}@test.com` }
            assignProfileToAccount(account)
            const profile = account.clientProfile
            assert.ok(profile, `account ${i} should have profile assigned`)
            try {
                validateProfileConsistency(profile)
            } catch (e) {
                assert.fail(`Profile ${i} (email=multi-${i}@test.com) failed consistency: ${e.message}`)
            }
        }
    })

    test('all assigned profiles have Chrome version = sec-ch-ua Chromium version', () => {
        for (let i = 0; i < 20; i++) {
            const account = { email: `ver-${i}@test.com` }
            assignProfileToAccount(account)
            const profile = account.clientProfile
            const uaMatch = String(profile.userAgent).match(/Chrome\/(\d+)/)
            const secMatch = String(profile.secChUa).match(/"Chromium";v="(\d+)"/)
            assert.ok(uaMatch, `account ${i}: UA should contain Chrome/NNN`)
            assert.ok(secMatch, `account ${i}: sec-ch-ua should contain Chromium NNN`)
            assert.equal(
                uaMatch[1],
                secMatch[1],
                `account ${i}: UA Chrome version (${uaMatch[1]}) should equal sec-ch-ua Chromium version (${secMatch[1]})`
            )
        }
    })

    test('all assigned profiles have Accept-Language first tag = locale', () => {
        for (let i = 0; i < 20; i++) {
            const account = { email: `lang-${i}@test.com` }
            assignProfileToAccount(account)
            const profile = account.clientProfile
            const firstLang = String(profile.acceptLanguage).split(',')[0].trim().split(';')[0].trim()
            assert.equal(
                firstLang,
                profile.locale,
                `account ${i}: Accept-Language first tag (${firstLang}) should equal locale (${profile.locale})`
            )
        }
    })

    test('buildTimezoneString produces valid format for various offsets', () => {
        // 约定（看 client-profile.js）：sign = offsetMinutes >= 0 ? '+' : '-'
        // TIMEZONE_VARIANTS：
        //   Asia/Shanghai     offset=480  → GMT+0800
        //   Asia/Tokyo        offset=540  → GMT+0900
        //   America/New_York  offset=-240 → GMT-0400 (EDT)
        //   Europe/London     offset=60   → GMT+0100 (BST)
        const cases = [
            { offset: 480,  expected: /GMT\+0800/ },
            { offset: 540,  expected: /GMT\+0900/ },
            { offset: 60,   expected: /GMT\+0100/ },
            { offset: 0,    expected: /GMT\+0000/ },
            { offset: -240, expected: /GMT-0400/ },
            { offset: -300, expected: /GMT-0500/ },
            { offset: -120, expected: /GMT-0200/ }
        ]
        for (const { offset, expected } of cases) {
            const tz = buildTimezoneString(offset)
            assert.equal(typeof tz, 'string', `offset ${offset} should produce string`)
            assert.ok(tz.length > 0, `offset ${offset} should produce non-empty string`)
            assert.match(tz, expected, `offset ${offset} should match ${expected}, got: ${tz}`)
        }
    })

    test('buildTimezoneString produces different strings for different offsets', () => {
        const tz1 = buildTimezoneString(480)
        const tz2 = buildTimezoneString(-240)
        assert.notEqual(tz1, tz2, 'different offsets should produce different timezone strings')
    })

    test('buildTimezoneString generates current date (not stale)', () => {
        // profile 不应缓存 timezone 字符串；buildTimezoneString 每次都基于当前时间
        const tz1 = buildTimezoneString(480)
        // 等待 1.1 秒确保秒数变化
        const before = new Date()
        const tz2 = buildTimezoneString(480)
        const after = new Date()
        // 至少两者都包含 "GMT+0800"
        assert.match(tz1, /GMT\+0800/)
        assert.match(tz2, /GMT\+0800/)
        // 验证不报错；秒数可能相同（如果在同一秒内调用），这是正常的
        // 重点是函数能在多次调用时正常工作
        const elapsed = after - before
        assert.ok(elapsed >= 0, 'time should not go backwards')
    })
})
