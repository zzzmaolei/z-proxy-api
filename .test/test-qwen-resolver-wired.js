/**
 * test-qwen-resolver-wired.js
 *
 * 验证 resolveQwenModel 被正确接入主链：输出字段完整、别名映射正确、
 * 用户 reasoning_effort 覆盖默认值、未知模型优雅回退。
 *
 * 注意：resolveQwenModel 是 async 函数（内部 await getLatestModelsArray()），
 * 所有调用必须 await。
 *
 * 清理：model-resolver.js → models-map.js → account.js 链路在 require 时触发
 * 异步账号加载并创建持久定时器（autoRefresh interval 未 unref）。after() 钩子
 * 等待加载完成后 destroy()，清理定时器使进程能自然退出。
 */

const { test, describe, after } = require('node:test')
const assert = require('node:assert/strict')

// after() 钩子：清理 account.js 的持久定时器（autoRefresh / saveInterval），
// 这些定时器在 require 链路中被创建且未 unref，会阻止 `node --test` 退出。
after(async () => {
    try {
        const accountManager = require('../src/utils/account.js')
        for (let i = 0; i < 20; i++) {
            if (accountManager.isInitialized) break
            await new Promise(r => setTimeout(r, 100))
        }
        if (accountManager && typeof accountManager.destroy === 'function') {
            accountManager.destroy()
        }
    } catch (e) {
        // best-effort cleanup
    }
})

describe('resolveQwenModel wired into main chain', () => {
    test('qwen3.8-max-preview resolves with correct fields', async () => {
        const { resolveQwenModel } = require('../src/backends/qwen/model-resolver.js')
        const result = await resolveQwenModel('qwen3.8-max-preview')
        assert.equal(result.baseModel, 'qwen3.8-max-preview')
        assert.equal(result.upstreamModel, 'qwen3.8-max-preview')
        assert.ok(result.aliasMode, 'aliasMode should be set')
        assert.ok(result.capabilities, 'capabilities should be present')
        assert.ok(result.maxContextLength > 0, 'maxContextLength should be positive')
    })

    test('qwen3.8-max-preview-thinking maps to base model', async () => {
        const { resolveQwenModel } = require('../src/backends/qwen/model-resolver.js')
        const result = await resolveQwenModel('qwen3.8-max-preview-thinking')
        assert.equal(result.baseModel, 'qwen3.8-max-preview')
        assert.equal(result.aliasMode, 'thinking')
        assert.ok(result.effectiveThinkingEnabled !== undefined)
    })

    test('user reasoning_effort overrides default', async () => {
        const { resolveQwenModel } = require('../src/backends/qwen/model-resolver.js')
        const result = await resolveQwenModel('qwen3.8-max-preview', { reasoningEffort: 'high' })
        assert.equal(result.effectiveReasoningEffort, 'high')
    })

    test('unknown model falls back gracefully', async () => {
        const { resolveQwenModel } = require('../src/backends/qwen/model-resolver.js')
        const result = await resolveQwenModel('unknown-model-xyz')
        assert.ok(result.baseModel, 'should have a baseModel fallback')
    })

    test('resolver output has all 10 required fields', async () => {
        const { resolveQwenModel } = require('../src/backends/qwen/model-resolver.js')
        const result = await resolveQwenModel('qwen3.8-max-preview')
        const requiredFields = [
            'requestedModel', 'baseModel', 'upstreamModel', 'aliasMode',
            'effectiveThinkingEnabled', 'effectiveThinkingBudget',
            'effectiveReasoningEffort', 'capabilities',
            'maxContextLength', 'maxOutputTokens'
        ]
        for (const field of requiredFields) {
            assert.ok(field in result, `missing field: ${field}`)
        }
    })
})
