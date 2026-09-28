/**
 * test-qwen-client-profile-applied.js
 *
 * 验证 StableClientProfile 真正应用到请求头：
 *   1. isEnabled() 在 stable-per-account 模式下返回 true
 *   2. assignProfileToAccount 把 clientProfile 写到 account.clientProfile，
 *      含 UA / sec-ch-ua / Accept-Language / 时区等必需字段
 *   3. 同一 email 多次调用得到相同 profile（确定性哈希）
 *   4. 不同 email 多数情况下得到不同 profile
 *   5. buildTimezoneString 生成合法的 "Mon Jul 20 2026 18:44:07 GMT+0800" 格式
 *
 * 运行：node --test .test/test-qwen-client-profile-applied.js
 */

// 必须在 require 任何项目模块之前设置，以便 config/index.js 的 IIFE 能读到
process.env.QWEN_CLIENT_PROFILE_MODE = 'stable-per-account'

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

const {
    assignProfileToAccount,
    buildTimezoneString,
    isEnabled
} = require('../src/backends/qwen/client-profile.js')

describe('StableClientProfile applied to request headers', () => {
    test('isEnabled() returns true under stable-per-account mode', () => {
        assert.equal(isEnabled(), true)
    })

    test('assignProfileToAccount populates account.clientProfile with required fields', () => {
        const account = { email: 'applied-1@example.com' }
        assignProfileToAccount(account)
        const profile = account.clientProfile
        assert.ok(profile, 'account.clientProfile should be set after assignProfileToAccount')
        assert.ok(profile.userAgent, 'profile should have userAgent')
        assert.ok(profile.secChUa, 'profile should have secChUa')
        assert.ok(profile.secChUaPlatform, 'profile should have secChUaPlatform')
        assert.ok(profile.secChUaMobile, 'profile should have secChUaMobile')
        assert.ok(profile.acceptLanguage, 'profile should have acceptLanguage')
        assert.ok(profile.locale, 'profile should have locale')
        assert.equal(
            typeof profile.timezoneOffsetMinutes,
            'number',
            'profile should have numeric timezoneOffsetMinutes'
        )
        assert.ok(profile.timezoneFamily, 'profile should have timezoneFamily')
        assert.ok(profile._profileId, 'profile should have _profileId metadata')
    })

    test('same email always gets same profile (deterministic)', () => {
        const a1 = { email: 'deterministic@example.com' }
        const a2 = { email: 'deterministic@example.com' }
        assignProfileToAccount(a1)
        assignProfileToAccount(a2)
        assert.ok(a1.clientProfile, 'first account should have profile')
        assert.ok(a2.clientProfile, 'second account should have profile')
        assert.deepEqual(a1.clientProfile, a2.clientProfile)
    })

    test('different emails get different profiles (likely)', () => {
        const accounts = []
        for (let i = 0; i < 20; i++) {
            const a = { email: `distinct-${i}@example.com` }
            assignProfileToAccount(a)
            accounts.push(a)
        }
        const profileIds = new Set(accounts.map(a => a.clientProfile._profileId))
        // 5 UA × 5 lang × 5 tz = 125 combinations；20 个账号至少应该分到 3 个不同的 _profileId
        assert.ok(
            profileIds.size >= 3,
            `expected at least 3 distinct profile IDs across 20 accounts, got ${profileIds.size}: ${[...profileIds].join(', ')}`
        )
    })

    test('buildTimezoneString produces valid format (GMT+/-HHMM)', () => {
        const tz = buildTimezoneString(-480) // Asia/Shanghai GMT+8 — 这里 -480 是反向符号
        assert.equal(typeof tz, 'string')
        // 格式："Mon Jul 20 2026 18:44:07 GMT+0800"
        assert.match(tz, /GMT[+-]\d{4}/, `timezone should match GMT+/-HHMM, got: ${tz}`)
    })

    test('buildTimezoneString respects offset sign', () => {
        // 看 client-profile.js：sign = offsetMinutes >= 0 ? '+' : '-'
        // TIMEZONE_VARIANTS 中 Asia/Shanghai offset=480 → GMT+0800
        //                  America/New_York offset=-240 → GMT-0400
        const plus = buildTimezoneString(480)    // → GMT+0800
        const minus = buildTimezoneString(-240)  // → GMT-0400
        assert.match(plus, /GMT\+\d{4}/, `offset=480 should produce GMT+HHMM, got: ${plus}`)
        assert.match(minus, /GMT-\d{4}/, `offset=-240 should produce GMT-HHMM, got: ${minus}`)
    })

    test('buildTimezoneString includes day/month/year/time components', () => {
        const tz = buildTimezoneString(0)
        // "Mon Jul 20 2026 18:44:07 GMT+0000"
        const parts = tz.split(' ')
        assert.ok(parts.length >= 5, `expected at least 5 space-separated parts, got: ${tz}`)
        assert.match(parts[0], /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)$/, `day-of-week part should be 3-letter, got: ${parts[0]}`)
        assert.match(parts[1], /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)$/, `month part should be 3-letter, got: ${parts[1]}`)
    })

    test('profile fields reference UA_VARIANTS values (Chrome/Edge only)', () => {
        // 当前 UA_VARIANTS 池里全是桌面端 Windows UA，secChUaMobile 应该恒为 '?0'
        for (let i = 0; i < 10; i++) {
            const account = { email: `ua-check-${i}@example.com` }
            assignProfileToAccount(account)
            const profile = account.clientProfile
            assert.equal(profile.secChUaMobile, '?0', `account ${i}: secChUaMobile should be ?0 for desktop UA`)
            assert.match(profile.userAgent, /Windows NT 10\.0/, `account ${i}: UA should be Windows desktop`)
            assert.match(profile.secChUaPlatform, /"Windows"/, `account ${i}: sec-ch-ua-platform should be "Windows"`)
        }
    })
})
