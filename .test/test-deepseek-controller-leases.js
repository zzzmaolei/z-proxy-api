const { test, describe, after } = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const config = require('../src/config')
const dpskAccount = require('../src/backends/deepseek/dpsk-account')
const dpskClient = require('../src/backends/deepseek/dpsk-client')
const dpskScheduler = require('../src/backends/deepseek/scheduler-singleton')
const anthropicUtils = require('../src/backends/deepseek/anthropic-utils')
const openaiStreamModule = require('../src/backends/deepseek/stream-handler')
const openaiSyncModule = require('../src/backends/deepseek/sync-handler')
const anthropicStreamModule = require('../src/backends/deepseek/anthropic-stream-handler')
const anthropicSyncModule = require('../src/backends/deepseek/anthropic-sync-handler')

const TEST_ACCOUNT = {
    accountId: 'dpsk-controller-test',
    email: 'dpsk-controller-test@example.invalid',
    password: 'test-password',
    token: 'dpsk-controller-token',
    enabled: true,
    mutedUntil: null,
    proxy: null,
}

const SECOND_TEST_ACCOUNT = {
    ...TEST_ACCOUNT,
    accountId: 'dpsk-controller-test-2',
    email: 'dpsk-controller-test-2@example.invalid',
    token: 'dpsk-controller-token-2',
}

const behavior = {
    openai: { mode: 'resolve', starts: 0, resolver: null, accounts: [] },
    anthropic: { mode: 'resolve', starts: 0, resolver: null, accounts: [] },
}

const originalConfig = {
    dpskMaxConcurrencyPerAccount: config.dpskMaxConcurrencyPerAccount,
    dpskGlobalMaxConcurrency: config.dpskGlobalMaxConcurrency,
    dpskMaxQueueSize: config.dpskMaxQueueSize,
    dpskQueueTimeoutMs: config.dpskQueueTimeoutMs,
    dpskThinkEffort: config.dpskThinkEffort,
}

const originalAccountMethods = {
    getSchedulerAccounts: dpskAccount.getSchedulerAccounts,
    getAvailableAccount: dpskAccount.getAvailableAccount,
    releaseAccount: dpskAccount.releaseAccount,
    markAccountMuted: dpskAccount.markAccountMuted,
    markAccountFailed: dpskAccount.markAccountFailed,
}

const originalClientMethods = {
    resolveModelOptions: dpskClient.resolveModelOptions,
}

const originalAnthropicUtils = {
    createRequestSession: anthropicUtils.createRequestSession,
}

// These replacements are installed before loading the controllers because both
// controllers destructure their handler imports at module load time.
openaiStreamModule.handleStreamResponse = async (ctx) => runHandler('openai', ctx)
openaiSyncModule.handleSyncResponse = async (ctx) => runHandler('openai', ctx)
anthropicStreamModule.handleAnthropicStream = async (ctx) => runHandler('anthropic', ctx)
anthropicSyncModule.handleAnthropicSync = async (ctx) => runHandler('anthropic', ctx)
anthropicUtils.createRequestSession = async () => ({
    chatSessionId: 'test-chat-session',
    lastMessageId: null,
    createdAt: Date.now(),
})

const { chatCompletions } = require('../src/controllers/dpsk-chat')
const { handleAnthropicDeepSeek } = require('../src/controllers/anthropic-deepseek')

function runHandler(kind, ctx) {
    const state = behavior[kind]
    state.starts += 1
    state.accounts.push(ctx?.account?.email || null)
    state.lastContext = ctx
    if (state.mode === '429-once' && state.starts === 1) {
        throw new Error('429 upstream rate limit')
    }
    if (state.mode === 'throw') {
        throw new Error(`${kind} handler failure`)
    }
    if (state.mode === 'block') {
        assert.ok(ctx?.requestSignal?.aborted === false, `${kind} handler must receive the request abort signal`)
        return new Promise(resolve => {
            state.resolver = () => resolve('success')
        })
    }
    assert.ok(ctx && ctx.account, `${kind} handler must receive the leased account`)
    if (state.mode === 'response-object') return ctx.res
    if (state.mode === 'success-error-response') {
        ctx.res.statusCode = 500
        return 'success'
    }
    if (state.mode === 'undefined') return undefined
    return 'success'
}

function makeRequest(body) {
    const req = new EventEmitter()
    req.body = body
    req.headers = {}
    req.apiKey = 'test-api-key'
    req.ip = '127.0.0.1'
    req.aborted = false
    return req
}

function makeResponse() {
    const res = new EventEmitter()
    res.headersSent = false
    res.writableEnded = false
    res.destroyed = false
    res.statusCode = 200
    res.body = null
    res.headers = {}
    res.set = (name, value) => {
        if (name && typeof name === 'object') Object.assign(res.headers, name)
        else if (name) res.headers[String(name).toLowerCase()] = String(value)
        return res
    }
    res.setHeader = () => res
    res.flushHeaders = () => {}
    res.status = code => {
        res.statusCode = code
        return res
    }
    res.json = body => {
        res.body = body
        res.headersSent = true
        res.writableEnded = true
        return res
    }
    res.end = body => {
        res.body = body
        res.headersSent = true
        res.writableEnded = true
        return res
    }
    res.write = () => true
    return res
}

function openaiBody(message, stream = false) {
    return {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: message }],
        stream,
    }
}

function anthropicBody(message, stream = false) {
    return {
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: message }],
        stream,
        max_tokens: 128,
    }
}

function waitFor(predicate, timeoutMs = 1500) {
    const deadline = Date.now() + timeoutMs
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (predicate()) return resolve()
            if (Date.now() >= deadline) return reject(new Error('condition timed out'))
            setTimeout(poll, 5).unref?.()
        }
        poll()
    })
}

function prepareScheduler(accounts = [TEST_ACCOUNT]) {
    config.dpskMaxConcurrencyPerAccount = 1
    config.dpskGlobalMaxConcurrency = 1
    config.dpskMaxQueueSize = 4
    config.dpskQueueTimeoutMs = 1000

    dpskScheduler.resetForTests()
    dpskAccount.getSchedulerAccounts = () => accounts.map(account => ({ ...account }))
    dpskAccount.getAvailableAccount = () => {
        throw new Error('legacy getAvailableAccount must not be used by scheduler path')
    }
    dpskAccount.releaseAccount = () => {
        throw new Error('legacy releaseAccount must not be used by scheduler path')
    }
    dpskAccount.markAccountMuted = () => null
    dpskAccount.markAccountFailed = () => null
    dpskClient.resolveModelOptions = () => ({
        modelType: 'default',
        thinkingEnabled: false,
    })
    anthropicUtils.accountAffinityCache.clear()
    behavior.openai = { mode: 'resolve', starts: 0, resolver: null, accounts: [], lastContext: null }
    behavior.anthropic = { mode: 'resolve', starts: 0, resolver: null, accounts: [], lastContext: null }

    const scheduler = dpskScheduler.syncAccounts(accounts.map(account => ({ ...account })))
    const releaseCalls = []
    const originalAcquire = scheduler.acquire
    scheduler.acquire = async function instrumentedAcquire(options) {
        const lease = await originalAcquire.call(this, options)
        const originalRelease = lease.release.bind(lease)
        lease.release = outcome => {
            releaseCalls.push({ lease, outcome })
            return originalRelease(outcome)
        }
        return lease
    }

    return { scheduler, releaseCalls }
}

function assertDrained(scheduler) {
    const snapshot = scheduler.getSnapshot()
    assert.equal(snapshot.globalInFlight, 0)
    assert.equal(snapshot.queueDepth, 0)
    for (const account of scheduler.accounts.values()) {
        assert.equal(account.inFlight, 0)
    }
}

after(() => {
    dpskScheduler.resetForTests()
    Object.assign(config, originalConfig)
    dpskClient._setModelCapabilitiesForTest?.([])
    Object.assign(dpskAccount, originalAccountMethods)
    Object.assign(dpskClient, originalClientMethods)
    Object.assign(anthropicUtils, originalAnthropicUtils)
    dpskAccount.stopAutoRefresh?.()
})

describe('DeepSeek controller scheduler lease contract', () => {
    test('settings-backed flash model stays thinking-off under the global high default', async () => {
        const { scheduler, releaseCalls } = prepareScheduler()
        dpskClient.resolveModelOptions = originalClientMethods.resolveModelOptions
        dpskClient._setModelCapabilitiesForTest([
            {
                id: 'deepseek-lab-r2-flash',
                model_type: 'lab-r2',
                capabilities: {
                    model_type: 'lab-r2',
                    thinking_supported: true,
                    thinking_enabled: false,
                },
            },
        ])
        config.dpskThinkEffort = 'high'

        const first = await chatCompletions(
            makeRequest({ ...openaiBody('flash-default'), model: 'deepseek-lab-r2-flash' }),
            makeResponse(),
        )
        assert.equal(first, 'success')
        assert.equal(behavior.openai.lastContext.chatOptions.thinkingEnabled, false)

        const second = await chatCompletions(
            makeRequest({ ...openaiBody('flash-explicit-on'), model: 'deepseek-lab-r2-flash', thinking_enabled: true }),
            makeResponse(),
        )
        assert.equal(second, 'success')
        assert.equal(behavior.openai.lastContext.chatOptions.thinkingEnabled, true)

        const explicitOff = makeResponse()
        const third = await chatCompletions(
            makeRequest({ ...openaiBody('flash-explicit-off'), model: 'deepseek-lab-r2-flash', thinking_enabled: false }),
            explicitOff,
        )
        assert.equal(third, 'success')
        assert.equal(behavior.openai.lastContext.chatOptions.thinkingEnabled, false)
        assert.equal(explicitOff.headers['x-dpsk-reasoning-effort'], undefined)
        assert.equal(releaseCalls.length, 3)
        assertDrained(scheduler)
    })

    test('OpenAI controller releases one lease after a successful sync handler', async () => {
        const { scheduler, releaseCalls } = prepareScheduler()
        const result = await chatCompletions(
            makeRequest(openaiBody('openai-success')),
            makeResponse(),
        )

        assert.equal(result, 'success')
        assert.equal(behavior.openai.starts, 1)
        assert.equal(releaseCalls.length, 1)
        assertDrained(scheduler)
    })

    test('OpenAI controller rejects non-contract handler results', async () => {
        const { scheduler, releaseCalls } = prepareScheduler()
        behavior.openai.mode = 'response-object'

        await chatCompletions(
            makeRequest(openaiBody('openai-response-object')),
            makeResponse(),
        )

        assert.equal(releaseCalls.length, 1)
        assert.equal(releaseCalls[0].outcome, 'failure')
        assertDrained(scheduler)
    })

    test('OpenAI controller does not accept success after an error response', async () => {
        const { scheduler, releaseCalls } = prepareScheduler()
        behavior.openai.mode = 'success-error-response'

        await chatCompletions(
            makeRequest(openaiBody('openai-success-error-response')),
            makeResponse(),
        )

        assert.equal(releaseCalls.length, 1)
        assert.equal(releaseCalls[0].outcome, 'failure')
        assertDrained(scheduler)
    })

    test('OpenAI controller maps a handler abort to HTTP 499 and client_aborted', async () => {
        const { scheduler, releaseCalls } = prepareScheduler()
        behavior.openai.mode = 'block'
        const req = makeRequest(openaiBody('openai-handler-abort'))
        const res = makeResponse()
        const pending = chatCompletions(req, res)

        await waitFor(() => scheduler.getSnapshot().globalInFlight === 1 && behavior.openai.starts === 1)
        req.aborted = true
        req.emit('aborted')
        behavior.openai.resolver()
        await pending

        assert.equal(res.statusCode, 499)
        assert.equal(releaseCalls.length, 1)
        assert.equal(releaseCalls[0].outcome, 'client_aborted')
        assertDrained(scheduler)
    })

    test('OpenAI controller releases one lease when the handler throws', async () => {
        const { scheduler, releaseCalls } = prepareScheduler()
        behavior.openai.mode = 'throw'
        const res = makeResponse()

        await chatCompletions(makeRequest(openaiBody('openai-throw')), res)

        assert.equal(behavior.openai.starts, 1)
        assert.equal(releaseCalls.length, 1)
        assertDrained(scheduler)
    })

    test('OpenAI controller releases each lease when a 429 switches accounts', async () => {
        const { scheduler, releaseCalls } = prepareScheduler([TEST_ACCOUNT, SECOND_TEST_ACCOUNT])
        behavior.openai.mode = '429-once'

        await chatCompletions(
            makeRequest(openaiBody('openai-switch-429')),
            makeResponse(),
        )

        assert.equal(behavior.openai.starts, 2)
        assert.notEqual(behavior.openai.accounts[0], behavior.openai.accounts[1])
        assert.equal(releaseCalls.length, 2)
        assert.equal(releaseCalls[0].outcome, 'upstream_error')
        assert.equal(releaseCalls[1].outcome, 'success')
        assertDrained(scheduler)
    })

    test('OpenAI queued acquire is cancelled by client abort without a lease leak', async () => {
        const { scheduler, releaseCalls } = prepareScheduler()
        behavior.openai.mode = 'block'

        const first = chatCompletions(
            makeRequest(openaiBody('openai-first')),
            makeResponse(),
        )
        await waitFor(() => scheduler.getSnapshot().globalInFlight === 1 && behavior.openai.starts === 1)

        const secondReq = makeRequest(openaiBody('openai-second'))
        const secondRes = makeResponse()
        const second = chatCompletions(secondReq, secondRes)
        await waitFor(() => scheduler.getSnapshot().queueDepth === 1)
        secondReq.emit('close')
        await new Promise(resolve => setTimeout(resolve, 20))
        assert.equal(scheduler.getSnapshot().queueDepth, 1, 'normal request close must not abort queued work')
        secondReq.aborted = true
        secondReq.emit('aborted')
        await second

        assert.equal(secondRes.statusCode, 499)
        assert.equal(behavior.openai.starts, 1)
        assert.equal(releaseCalls.length, 0, 'queued abort must not create a lease')
        behavior.openai.resolver()
        await first
        assert.equal(releaseCalls.length, 1)
        assertDrained(scheduler)
    })

    test('Anthropic controller releases one lease after a successful sync handler', async () => {
        const { scheduler, releaseCalls } = prepareScheduler()
        await handleAnthropicDeepSeek(
            makeRequest(anthropicBody('anthropic-success')),
            makeResponse(),
        )

        assert.equal(behavior.anthropic.starts, 1)
        assert.equal(releaseCalls.length, 1)
        assertDrained(scheduler)
    })

    test('Anthropic controller rejects non-contract handler results', async () => {
        const { scheduler, releaseCalls } = prepareScheduler()
        behavior.anthropic.mode = 'response-object'

        await handleAnthropicDeepSeek(
            makeRequest(anthropicBody('anthropic-response-object')),
            makeResponse(),
        )

        assert.equal(releaseCalls.length, 1)
        assert.equal(releaseCalls[0].outcome, 'failure')
        assertDrained(scheduler)
    })

    test('Anthropic controller does not accept success after an error response', async () => {
        const { scheduler, releaseCalls } = prepareScheduler()
        behavior.anthropic.mode = 'success-error-response'

        await handleAnthropicDeepSeek(
            makeRequest(anthropicBody('anthropic-success-error-response')),
            makeResponse(),
        )

        assert.equal(releaseCalls.length, 1)
        assert.equal(releaseCalls[0].outcome, 'failure')
        assertDrained(scheduler)
    })

    test('Anthropic controller releases one lease when the handler throws', async () => {
        const { scheduler, releaseCalls } = prepareScheduler()
        behavior.anthropic.mode = 'throw'
        const res = makeResponse()

        await handleAnthropicDeepSeek(makeRequest(anthropicBody('anthropic-throw')), res)

        assert.equal(behavior.anthropic.starts, 1)
        assert.equal(releaseCalls.length, 1)
        assertDrained(scheduler)
    })

    test('Anthropic queued acquire is cancelled by client abort without a lease leak', async () => {
        const { scheduler, releaseCalls } = prepareScheduler()
        behavior.anthropic.mode = 'block'

        const first = handleAnthropicDeepSeek(
            makeRequest(anthropicBody('anthropic-first')),
            makeResponse(),
        )
        await waitFor(() => scheduler.getSnapshot().globalInFlight === 1 && behavior.anthropic.starts === 1)

        const secondReq = makeRequest(anthropicBody('anthropic-second'))
        const secondRes = makeResponse()
        const second = handleAnthropicDeepSeek(secondReq, secondRes)
        await waitFor(() => scheduler.getSnapshot().queueDepth === 1)
        secondReq.emit('close')
        await new Promise(resolve => setTimeout(resolve, 20))
        assert.equal(scheduler.getSnapshot().queueDepth, 1, 'normal request close must not abort queued work')
        secondReq.aborted = true
        secondReq.emit('aborted')
        await second

        assert.equal(secondRes.statusCode, 499)
        assert.equal(behavior.anthropic.starts, 1)
        assert.equal(releaseCalls.length, 0, 'queued abort must not create a lease')
        behavior.anthropic.resolver()
        await first
        assert.equal(releaseCalls.length, 1)
        assertDrained(scheduler)
    })
})
