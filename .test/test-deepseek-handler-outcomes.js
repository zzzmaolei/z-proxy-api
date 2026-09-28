const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const dpskClient = require('../src/backends/deepseek/dpsk-client')
const anthropicUtils = require('../src/backends/deepseek/anthropic-utils')

const originalSendChatMessage = dpskClient.sendChatMessage
const originalCreateSession = dpskClient.createSession
const originalCreateRequestSession = anthropicUtils.createRequestSession
const originalDetectImagesAndDescribe = anthropicUtils.detectImagesAndDescribe

let upstreamMode = 'success'
let pendingResolve = null
let upstreamCallCount = 0

async function* fakeUpstream() {
    if (upstreamMode === 'empty') {
        return
    }
    if (upstreamMode === 'partial') {
        yield { type: 'text', content: 'partial output' }
        throw new Error('fake upstream interrupted')
    }
    if (upstreamMode === 'client-aborted') {
        yield { type: 'text', content: 'before abort' }
        await new Promise(resolve => {
            pendingResolve = resolve
        })
        return
    }
    if (upstreamMode === 'thinking') {
        yield { type: 'thinking', content: 'reasoning detail' }
        yield { type: 'text', content: 'final answer' }
        yield { type: 'done', content: '' }
        return
    }
    if (upstreamMode === 'reasoning-only') {
        yield { type: 'thinking', content: 'reasoning without answer' }
        yield { type: 'done', content: '' }
        return
    }
    yield { type: 'text', content: 'complete output' }
    yield { type: 'done', content: '' }
}

dpskClient.sendChatMessage = () => {
    upstreamCallCount += 1
    return fakeUpstream()
}
dpskClient.createSession = async () => ({ id: 'retry-session' })
anthropicUtils.createRequestSession = async () => ({
    chatSessionId: 'test-chat-session',
    lastMessageId: null,
    createdAt: Date.now(),
})
anthropicUtils.detectImagesAndDescribe = async messages => messages

const { handleStreamResponse } = require('../src/backends/deepseek/stream-handler')
const { handleAnthropicStream } = require('../src/backends/deepseek/anthropic-stream-handler')

function makeResponse() {
    const res = new EventEmitter()
    res.headers = {}
    res.headersSent = false
    res.writableEnded = false
    res.destroyed = false
    res.statusCode = 200
    res.body = ''
    res.set = values => {
        Object.assign(res.headers, values || {})
        return res
    }
    res.setHeader = (name, value) => {
        res.headers[name] = value
        return res
    }
    res.flushHeaders = () => {
        res.headersSent = true
    }
    res.write = chunk => {
        if (res.destroyed || res.writableEnded) return false
        res.headersSent = true
        res.body += String(chunk)
        return true
    }
    res.end = chunk => {
        if (chunk) res.body += String(chunk)
        res.headersSent = true
        res.writableEnded = true
        return res
    }
    res.destroy = () => {
        res.destroyed = true
        res.writableEnded = true
        return res
    }
    return res
}

function makeJsonResponse() {
    const res = makeResponse()
    res.status = code => {
        res.statusCode = code
        return res
    }
    res.json = payload => {
        res.body = payload
        res.headersSent = true
        res.writableEnded = true
        return res
    }
    return res
}

function makeRequest() {
    const req = new EventEmitter()
    req.body = {}
    req.headers = {}
    req.aborted = false
    req.clientProfile = { name: 'openai-compatible' }
    return req
}

function openaiContext() {
    return {
        req: makeRequest(),
        res: makeResponse(),
        token: 'test-token',
        account: { email: 'test@example.invalid', token: 'test-token', proxy: null },
        chatSessionId: 'test-chat-session',
        prompt: 'hello',
        model: 'deepseek-chat',
        chatOptions: { modelType: 'default', thinkingEnabled: false },
        startTime: Date.now(),
        hasTools: false,
        toolChoice: 'auto',
        tools: [],
        clientProfile: { name: 'openai-compatible' },
        cachedSession: null,
        sessionKey: null,
    }
}

function anthropicContext() {
    return {
        req: makeRequest(),
        res: makeResponse(),
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: 'hello' }],
        system: null,
        tools: [],
        tool_choice: 'auto',
        max_tokens: 64,
        thinking: null,
        account: { email: 'test@example.invalid', token: 'test-token', proxy: null },
        startTime: Date.now(),
    }
}

function openaiSyncContext() {
    const ctx = openaiContext()
    ctx.res = makeJsonResponse()
    return ctx
}

function anthropicSyncContext() {
    const ctx = anthropicContext()
    ctx.res = makeJsonResponse()
    return ctx
}

async function waitFor(predicate, timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error('condition timed out')
        await new Promise(resolve => setTimeout(resolve, 1))
    }
}

const { handleSyncResponse } = require('../src/backends/deepseek/sync-handler')
const { handleAnthropicSync } = require('../src/backends/deepseek/anthropic-sync-handler')

test('DeepSeek OpenAI stream returns success only after a complete upstream stream', async () => {
    upstreamMode = 'success'
    const ctx = openaiContext()
    const outcome = await handleStreamResponse(ctx)

    assert.equal(outcome, 'success')
    assert.match(ctx.res.body, /\[DONE\]/)
})

test('DeepSeek OpenAI stream forwards reasoning_content deltas', async () => {
    upstreamMode = 'thinking'
    const ctx = openaiContext()
    ctx.chatOptions.thinkingEnabled = true
    const outcome = await handleStreamResponse(ctx)

    assert.equal(outcome, 'success')
    assert.match(ctx.res.body, /reasoning_content/)
    assert.match(ctx.res.body, /reasoning detail/)
})

test('DeepSeek OpenAI stream rejects reasoning-only completion', async () => {
    upstreamMode = 'reasoning-only'
    const ctx = openaiContext()
    ctx.chatOptions.thinkingEnabled = true
    const outcome = await handleStreamResponse(ctx)

    assert.equal(outcome, 'upstream_error')
    assert.match(ctx.res.body, /dpsk_reasoning_only/)
    assert.doesNotMatch(ctx.res.body, /"finish_reason":"stop"/)
})

test('DeepSeek OpenAI stream marks partial upstream output incomplete', async () => {
    upstreamMode = 'partial'
    const ctx = openaiContext()
    const outcome = await handleStreamResponse(ctx)

    assert.equal(outcome, 'incomplete')
    assert.equal(ctx.res.destroyed, true)
})

test('DeepSeek OpenAI empty stream emits an error event instead of fake success text', async () => {
    upstreamMode = 'empty'
    const ctx = openaiContext()
    const outcome = await handleStreamResponse(ctx)

    assert.equal(outcome, 'failure')
    assert.match(ctx.res.body, /"error"/)
    assert.doesNotMatch(ctx.res.body, /\[z\.proxy\.api\]/)
})

test('DeepSeek OpenAI stream maps an in-flight client disconnect to client_aborted', async () => {
    upstreamMode = 'client-aborted'
    const ctx = openaiContext()
    const pending = handleStreamResponse(ctx)

    await waitFor(() => ctx.res.body.includes('before abort'))
    ctx.res.emit('close')
    pendingResolve?.()
    const outcome = await pending

    assert.equal(outcome, 'client_aborted')
})

test('DeepSeek Anthropic stream returns success only after a complete upstream stream', async () => {
    upstreamMode = 'success'
    const ctx = anthropicContext()
    const outcome = await handleAnthropicStream(ctx)

    assert.equal(outcome, 'success')
    assert.match(ctx.res.body, /message_stop/)
})

test('DeepSeek Anthropic stream marks partial upstream output incomplete', async () => {
    upstreamMode = 'partial'
    const ctx = anthropicContext()
    const outcome = await handleAnthropicStream(ctx)

    assert.equal(outcome, 'incomplete')
    assert.match(ctx.res.body, /error/)
})

test('DeepSeek Anthropic stream maps an in-flight client disconnect to client_aborted', async () => {
    upstreamMode = 'client-aborted'
    pendingResolve = null
    const ctx = anthropicContext()
    const pending = handleAnthropicStream(ctx)

    await waitFor(() => ctx.res.body.includes('before abort'))
    ctx.res.emit('close')
    pendingResolve?.()
    const outcome = await pending

    assert.equal(outcome, 'client_aborted')
})

test('DeepSeek OpenAI sync handler returns success for a complete upstream response', async () => {
    upstreamMode = 'success'
    const ctx = openaiSyncContext()
    const outcome = await handleSyncResponse(ctx)

    assert.equal(outcome, 'success')
    assert.equal(ctx.res.statusCode, 200)
    assert.equal(ctx.res.body.choices[0].message.content, 'complete output')
})

test('DeepSeek OpenAI sync handler preserves reasoning content and usage details', async () => {
    upstreamMode = 'thinking'
    const ctx = openaiSyncContext()
    ctx.chatOptions.thinkingEnabled = true
    const outcome = await handleSyncResponse(ctx)

    assert.equal(outcome, 'success')
    assert.equal(ctx.res.body.choices[0].message.reasoning_content, 'reasoning detail')
    assert.equal(ctx.res.body.usage.completion_tokens_details.reasoning_tokens > 0, true)
})

test('DeepSeek OpenAI sync handler rejects reasoning-only completion', async () => {
    upstreamMode = 'reasoning-only'
    const ctx = openaiSyncContext()
    ctx.chatOptions.thinkingEnabled = true
    const outcome = await handleSyncResponse(ctx)

    assert.equal(outcome, 'failure')
    assert.equal(ctx.res.body.error.code, 'dpsk_reasoning_only')
})

test('DeepSeek OpenAI sync handler does not report upstream failure as success', async () => {
    upstreamMode = 'partial'
    const ctx = openaiSyncContext()
    const outcome = await handleSyncResponse(ctx)

    assert.notEqual(outcome, 'success')
    assert.equal(outcome, 'failure')
})

test('DeepSeek Anthropic sync handler returns success for a complete upstream response', async () => {
    upstreamMode = 'success'
    const ctx = anthropicSyncContext()
    const outcome = await handleAnthropicSync(ctx)

    assert.equal(outcome, 'success')
    assert.equal(ctx.res.statusCode, 200)
    assert.equal(ctx.res.body.content[0].text, 'complete output')
})

test('DeepSeek Anthropic sync handler does not report upstream failure as success', async () => {
    upstreamMode = 'partial'
    const ctx = anthropicSyncContext()
    const outcome = await handleAnthropicSync(ctx)

    assert.notEqual(outcome, 'success')
    assert.equal(outcome, 'failure')
})

function addRequiredTool(ctx, anthropic = false) {
    const tool = anthropic
        ? { name: 'read_file', input_schema: { type: 'object', properties: {} } }
        : { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }
    if (anthropic) {
        ctx.tools = [tool]
        ctx.tool_choice = { type: 'any' }
    } else {
        ctx.hasTools = true
        ctx.tools = [tool]
        ctx.toolChoice = 'required'
    }
    return ctx
}

test('required tool choice never downgrades to normal text on OpenAI sync', async () => {
    upstreamMode = 'success'
    const ctx = addRequiredTool(openaiSyncContext())
    const outcome = await handleSyncResponse(ctx)

    assert.equal(outcome, 'failure')
    assert.equal(ctx.res.statusCode, 422)
    assert.equal(ctx.res.body.error.code, 'tool_call_required')
})

test('required tool choice never downgrades to normal text on OpenAI stream', async () => {
    upstreamMode = 'success'
    const ctx = addRequiredTool(openaiContext())
    const outcome = await handleStreamResponse(ctx)

    assert.equal(outcome, 'incomplete')
    assert.match(ctx.res.body, /"code":"tool_call_required"/)
    assert.doesNotMatch(ctx.res.body, /"finish_reason":"stop"/)
})

test('required tool choice never downgrades to normal text on Anthropic sync', async () => {
    upstreamMode = 'success'
    const ctx = addRequiredTool(anthropicSyncContext(), true)
    const outcome = await handleAnthropicSync(ctx)

    assert.equal(outcome, 'failure')
    assert.equal(ctx.res.statusCode, 422)
    assert.equal(ctx.res.body.error.code, 'tool_call_required')
})

test('required tool choice never downgrades to normal text on Anthropic stream', async () => {
    upstreamMode = 'success'
    const ctx = addRequiredTool(anthropicContext(), true)
    const outcome = await handleAnthropicStream(ctx)

    assert.equal(outcome, 'incomplete')
    assert.match(ctx.res.body, /tool_call_required/)
    assert.doesNotMatch(ctx.res.body, /"stop_reason":"end_turn"/)
})

test('all four handlers block a retry when the appended hint exceeds the hard budget', async () => {
    const previousSoft = process.env.DPSK_PROMPT_SOFT_LIMIT
    const previousHard = process.env.DPSK_PROMPT_HARD_LIMIT
    process.env.DPSK_PROMPT_SOFT_LIMIT = '1400'
    process.env.DPSK_PROMPT_HARD_LIMIT = '1450'
    try {
        upstreamMode = 'empty'
        upstreamCallCount = 0

        const openaiSync = addRequiredTool(openaiSyncContext())
        openaiSync.prompt = 'x'.repeat(1300)
        const openaiSyncOutcome = await handleSyncResponse(openaiSync)
        assert.equal(openaiSyncOutcome, 'failure')
        assert.equal(openaiSync.res.statusCode, 413)
        assert.equal(openaiSync.res.body.error.code, 'dpsk_prompt_too_large')

        const openaiStream = addRequiredTool(openaiContext())
        openaiStream.prompt = 'x'.repeat(1300)
        const openaiStreamOutcome = await handleStreamResponse(openaiStream)
        assert.equal(openaiStreamOutcome, 'upstream_error')
        assert.match(openaiStream.res.body, /dpsk_prompt_too_large/)

        const anthropicSync = addRequiredTool(anthropicSyncContext(), true)
        anthropicSync.messages = [{ role: 'user', content: 'x'.repeat(850) }]
        const anthropicSyncOutcome = await handleAnthropicSync(anthropicSync)
        assert.equal(anthropicSyncOutcome, 'failure')
        assert.equal(anthropicSync.res.statusCode, 413)
        assert.equal(anthropicSync.res.body.error.code, 'dpsk_prompt_too_large')

        const anthropicStream = addRequiredTool(anthropicContext(), true)
        anthropicStream.messages = [{ role: 'user', content: 'x'.repeat(850) }]
        const anthropicStreamOutcome = await handleAnthropicStream(anthropicStream)
        assert.equal(anthropicStreamOutcome, 'upstream_error')
        assert.match(anthropicStream.res.body, /dpsk_prompt_too_large/)

        assert.equal(upstreamCallCount, 4)
    } finally {
        if (previousSoft === undefined) delete process.env.DPSK_PROMPT_SOFT_LIMIT
        else process.env.DPSK_PROMPT_SOFT_LIMIT = previousSoft
        if (previousHard === undefined) delete process.env.DPSK_PROMPT_HARD_LIMIT
        else process.env.DPSK_PROMPT_HARD_LIMIT = previousHard
    }
})

after(() => {
    dpskClient.sendChatMessage = originalSendChatMessage
    dpskClient.createSession = originalCreateSession
    anthropicUtils.createRequestSession = originalCreateRequestSession
    anthropicUtils.detectImagesAndDescribe = originalDetectImagesAndDescribe
})
