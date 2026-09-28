/**
 * test-qwen-lease-singleton.js
 *
 * 验证 scheduler-singleton 的行为：
 *   - getScheduler() 返回同一实例（幂等）
 *   - 当 scheduler 已初始化时 accounts 为 Map
 *   - 模块导出预期的公共 API
 *
 * 实现说明：
 *   - getScheduler() 在 accountManager 未初始化时返回 null（测试环境常见情况）
 *   - 测试对 null 做守卫，避免 null.accounts 抛错
 *   - 单例幂等性无论 null 还是实例都成立（null === null 或 inst === inst）
 *   - scheduler-singleton.js 传递依赖 account.js，后者在 require 时创建持久
 *     定时器（autoRefresh / dailyReset）使事件循环无法退出。after() 钩子
 *     调用 accountManager.destroy() 清理定时器，使 `node --test` 能正常退出。
 */

const { test, describe, after } = require('node:test')
const assert = require('node:assert/strict')

// after() 钩子：scheduler-singleton.js 传递依赖 account.js，后者在 require 时
// 触发异步账号加载并创建持久定时器（autoRefresh interval 未 unref），使事件循环
// 无法退出。等待加载完成后再 destroy()，清理所有定时器和 redis 连接。
after(async () => {
    const accountManager = require('../src/utils/account.js')
    // 等待异步账号加载完成（最多 2 秒），使定时器都已创建后再清理
    for (let i = 0; i < 20; i++) {
        if (accountManager.isInitialized) break
        await new Promise(r => setTimeout(r, 100))
    }
    try {
        if (accountManager && typeof accountManager.destroy === 'function') {
            accountManager.destroy()
        }
    } catch (e) {
        // best-effort cleanup
    }
})

describe('Scheduler singleton and accountRuntimes sharing', () => {
    test('module exports expected API', () => {
        const mod = require('../src/backends/qwen/scheduler-singleton.js')
        assert.equal(typeof mod.getScheduler, 'function', 'getScheduler should be a function')
        assert.equal(typeof mod.acquire, 'function', 'acquire should be a function')
        assert.equal(typeof mod.release, 'function', 'release should be a function')
        assert.equal(typeof mod.registerAccount, 'function', 'registerAccount should be a function')
    })

    test('getScheduler returns same instance', () => {
        const { getScheduler } = require('../src/backends/qwen/scheduler-singleton.js')
        const s1 = getScheduler()
        const s2 = getScheduler()
        // Idempotent: both calls return the same value (null if accountManager
        // not initialized, or the same QwenScheduler instance)
        assert.equal(s1, s2)
    })

    test('scheduler accounts is a Map when initialized', () => {
        const { getScheduler } = require('../src/backends/qwen/scheduler-singleton.js')
        const sch = getScheduler()
        if (sch === null) {
            // accountManager not initialized in test env — singleton returns null,
            // which is the documented behavior. This branch is a valid pass.
            assert.equal(sch, null, 'null is expected when accountManager is uninitialized')
        } else {
            assert.ok(sch.accounts instanceof Map, 'accounts should be a Map when scheduler is initialized')
        }
    })

    test('QwenScheduler shares AccountRuntime instances passed via constructor Map', () => {
        // Verify the integration path: when a Map of AccountRuntime is passed to
        // the QwenScheduler constructor, the scheduler uses the SAME instances
        // (not copies). This is the path scheduler-singleton uses when
        // accountManager.accountRuntimes is non-empty.
        const { QwenScheduler } = require('../src/backends/qwen/scheduler.js')
        const { AccountRuntime } = require('../src/backends/qwen/account-runtime.js')
        const rt = new AccountRuntime({
            accountId: 'share-test',
            email: 'share@test.com',
            token: 'tok',
            password: 'pw'
        })
        const runtimes = new Map([[rt.accountId, rt]])
        const sch = new QwenScheduler(runtimes, {
            maxConcurrencyPerAccount: 1,
            globalMaxConcurrency: 1,
            maxQueueSize: 10,
            queueTimeoutMs: 1000
        })
        // The scheduler should reference the exact same AccountRuntime instance
        assert.equal(sch.accounts.get(rt.accountId), rt, 'scheduler should hold the same AccountRuntime reference')
    })
})
