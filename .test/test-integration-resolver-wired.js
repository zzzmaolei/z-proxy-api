/**
 * test-integration-resolver-wired.js
 *
 * Verifies that resolveQwenModel is wired into both main entry points:
 *   - OpenAI /v1/chat/completions (via chat-middleware.js processRequestBody)
 *   - Anthropic /v1/messages (via controllers/anthropic.js handleAnthropicMessages)
 *
 * Strategy:
 *   1. Monkey-patch resolveQwenModel on the model-resolver module BEFORE the SUT
 *      modules are required. Since chat-middleware/anthropic use destructuring
 *      `const { resolveQwenModel } = require(...)`, the patched function is
 *      captured at SUT load time.
 *   2. Call processRequestBody and handleAnthropicMessages with mock req/res.
 *   3. Assert the spy counter was incremented. If not, FAIL with a clear message
 *      indicating which entry point is missing the wiring.
 *
 * The test is robust to downstream failures (account manager not ready,
 * parserMessages errors, etc.) because resolveQwenModel is called BEFORE
 * those code paths in both entry points.
 *
 * Run: node .test/test-integration-resolver-wired.js
 */

const assert = require('assert')

// ─── 1. Install spy on resolveQwenModel BEFORE loading SUT ────────────────
// model-resolver.js is required first, then its exported resolveQwenModel
// is replaced with a counting wrapper. When SUT later does
//   const { resolveQwenModel } = require('../backends/qwen/model-resolver.js')
// the destructuring captures the SPY (not the original), because the spy has
// been installed on the module's exports object before the SUT is loaded.
const modelResolver = require('../src/backends/qwen/model-resolver.js')
const originalResolveQwenModel = modelResolver.resolveQwenModel

let openAICallCount = 0
let anthropicCallCount = 0
let currentEntryPoint = null

modelResolver.resolveQwenModel = async function spyResolveQwenModel(requestedModel, requestOptions = {}) {
    // Increment counter BEFORE calling the original, so even if the original
    // throws (e.g., account manager not ready), the spy still records the call.
    if (currentEntryPoint === 'openai') openAICallCount++
    else if (currentEntryPoint === 'anthropic') anthropicCallCount++
    return originalResolveQwenModel.call(modelResolver, requestedModel, requestOptions)
}

// ─── 2. Require SUT AFTER spy is installed (so destructuring captures spy) ─
const { processRequestBody } = require('../src/middlewares/chat-middleware.js')
const { handleAnthropicMessages } = require('../src/controllers/anthropic.js')

// ─── 3. Mock req/res helpers ──────────────────────────────────────────────
function createMockReq(body, opts = {}) {
    return {
        body,
        headers: Object.assign({}, opts.headers || {}),
        clientProfile: opts.clientProfile || { name: 'unknown' },
        // Express req.on('close', ...) — registered by middleware for abort handling
        on: function () { return this },
        chatLatency: undefined,
    }
}

function createMockRes() {
    const res = {
        headersSent: false,
        status: function () { return res },
        set: function () { return res },
        json: function () { return res },
        end: function () { return res },
        flushHeaders: function () { return res },
    }
    return res
}

// ─── 4. Test cases ────────────────────────────────────────────────────────
async function testOpenAIEntry() {
    openAICallCount = 0
    currentEntryPoint = 'openai'

    const req = createMockReq({
        model: 'qwen3.8-max-preview-thinking',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
    })
    const res = createMockRes()

    // Even if processRequestBody fails downstream (account not ready, etc.),
    // the resolver should have been called BEFORE any failure.
    try {
        await processRequestBody(req, res, function () {})
    } catch (_) { /* ignore — we only care about the spy */ }

    assert.ok(
        openAICallCount >= 1,
        'resolver not wired into OpenAI /v1/chat/completions entry (chat-middleware.js processRequestBody never called resolveQwenModel)'
    )
    console.log(`  PASS: OpenAI /v1/chat/completions called resolveQwenModel ${openAICallCount} time(s)`)
}

async function testAnthropicEntry() {
    anthropicCallCount = 0
    currentEntryPoint = 'anthropic'

    const req = createMockReq({
        model: 'qwen3.8-max-preview-thinking',
        messages: [{ role: 'user', content: 'hello' }],
        stream: true,
        thinking: { type: 'enabled', budget_tokens: 16384 },
    }, { clientProfile: { name: 'claude-code' } })
    const res = createMockRes()

    try {
        await handleAnthropicMessages(req, res)
    } catch (_) { /* ignore — we only care about the spy */ }

    assert.ok(
        anthropicCallCount >= 1,
        'resolver not wired into Anthropic /v1/messages entry (controllers/anthropic.js handleAnthropicMessages never called resolveQwenModel)'
    )
    console.log(`  PASS: Anthropic /v1/messages called resolveQwenModel ${anthropicCallCount} time(s)`)
}

// ─── 5. Main runner ───────────────────────────────────────────────────────
async function main() {
    let passed = 0
    let failed = 0

    const test = async function (name, fn) {
        try {
            await fn()
            passed++
        } catch (e) {
            failed++
            console.log(`  FAIL: ${name} — ${e.message}`)
        }
    }

    console.log('Integration Test: resolveQwenModel wired into main chains')
    console.log('========================================================\n')

    await test('OpenAI /v1/chat/completions wires resolveQwenModel', testOpenAIEntry)
    await test('Anthropic /v1/messages wires resolveQwenModel', testAnthropicEntry)

    console.log(`\nResults: ${passed} passed, ${failed} failed`)
    if (failed > 0) {
        console.error('\nSOME TESTS FAILED')
        process.exitCode = 1
    } else {
        console.log('\nPASS')
    }
}

main().catch(function (e) {
    console.error('Test runner crashed:', e)
    process.exitCode = 1
}).finally(function () { process.exit() })
