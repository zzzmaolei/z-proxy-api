'use strict'

const { test, after } = require('node:test')
const assert = require('node:assert/strict')

const dpskClient = require('../src/backends/deepseek/dpsk-client')
const anthropicUtils = require('../src/backends/deepseek/anthropic-utils')
const { handleAnthropicSync } = require('../src/backends/deepseek/anthropic-sync-handler')

const originalCreateSession = dpskClient.createSession
const originalSendChatMessage = dpskClient.sendChatMessage

function makeRequest({ continuity = false } = {}) {
  const headers = { 'x-session-id': 'anthropic-sync-continuity-test' }
  if (continuity) headers['x-dpsk-session-continuity'] = 'true'
  return {
    headers,
    body: {},
    apiKey: 'test-api-key',
    ip: '127.0.0.1',
    aborted: false,
    clientProfile: { name: 'claude-code' },
    removeListener() {},
  }
}

function makeResponse() {
  return {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    statusCode: 200,
    set() { return this },
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; this.headersSent = true; this.writableEnded = true; return this },
  }
}

async function* upstreamResponse(messageId, text) {
  yield { type: 'message_id', content: messageId }
  yield { type: 'text', content: text }
  yield { type: 'done', content: '' }
}

async function* upstreamResponseWithThinking(messageId, thinking, text) {
  yield { type: 'message_id', content: messageId }
  yield { type: 'thinking', content: thinking }
  yield { type: 'text', content: text }
  yield { type: 'done', content: '' }
}

function context(req, res, messages) {
  return {
    req,
    res,
    model: 'deepseek-chat',
    messages,
    system: null,
    tools: [],
    tool_choice: undefined,
    max_tokens: 256,
    thinking: null,
    account: { email: 'continuity@example.invalid', token: 'test-token', proxy: null },
    startTime: Date.now(),
  }
}

test('Anthropic sync reuses the Web session with a numeric parent message id', async () => {
  anthropicUtils.sessionCache.clear()
  const sent = []
  let sessionCount = 0
  dpskClient.createSession = async () => ({ id: `web-session-${++sessionCount}` })
  dpskClient.sendChatMessage = (token, chatSessionId, prompt, options) => {
    sent.push({ chatSessionId, prompt, options: { ...options } })
    return upstreamResponse(sent.length === 1 ? '101' : '102', sent.length === 1 ? 'first answer' : 'second answer')
  }

  try {
    const firstReq = makeRequest({ continuity: true })
    const firstRes = makeResponse()
    const first = await handleAnthropicSync(context(firstReq, firstRes, [
      { role: 'user', content: 'first question' },
    ]))
    assert.equal(first, 'success')
    assert.equal(firstRes.statusCode, 200)

    const secondReq = makeRequest({ continuity: true })
    const secondRes = makeResponse()
    const second = await handleAnthropicSync(context(secondReq, secondRes, [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ]))
    assert.equal(second, 'success')
    assert.equal(sent.length, 2)
    assert.equal(sessionCount, 1)
    assert.equal(sent[0].chatSessionId, 'web-session-1')
    assert.equal(sent[1].chatSessionId, 'web-session-1')
    assert.equal(sent[0].options.parentMessageId, null)
    assert.equal(sent[1].options.parentMessageId, 101)
    assert.equal(typeof sent[1].options.parentMessageId, 'number')
    assert.match(sent[0].prompt, /first question/)
    assert.match(sent[1].prompt, /second question/)
    assert.doesNotMatch(sent[1].prompt, /first question/)
  } finally {
    anthropicUtils.sessionCache.clear()
    dpskClient.createSession = originalCreateSession
    dpskClient.sendChatMessage = originalSendChatMessage
  }
})

test('Anthropic sync keeps Web sessions isolated unless explicitly opted in', async () => {
  anthropicUtils.sessionCache.clear()
  const sent = []
  let sessionCount = 0
  dpskClient.createSession = async () => ({ id: `stateless-web-session-${++sessionCount}` })
  dpskClient.sendChatMessage = (token, chatSessionId, prompt, options) => {
    sent.push({ chatSessionId, prompt, options: { ...options } })
    return upstreamResponse(sent.length, sent.length === 1 ? 'first answer' : 'second answer')
  }

  try {
    const firstRes = makeResponse()
    const first = await handleAnthropicSync(context(makeRequest(), firstRes, [
      { role: 'user', content: 'first question' },
    ]))
    assert.equal(first, 'success')

    const secondRes = makeResponse()
    const second = await handleAnthropicSync(context(makeRequest(), secondRes, [
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ]))
    assert.equal(second, 'success')
    assert.equal(sessionCount, 2)
    assert.equal(sent[0].options.parentMessageId, null)
    assert.equal(sent[1].options.parentMessageId, null)
    assert.match(sent[1].prompt, /first question/)
    assert.match(sent[1].prompt, /second question/)
  } finally {
    anthropicUtils.sessionCache.clear()
    dpskClient.createSession = originalCreateSession
    dpskClient.sendChatMessage = originalSendChatMessage
  }
})

test('Anthropic sync suppresses unsigned DeepSeek thinking blocks', async () => {
  anthropicUtils.sessionCache.clear()
  const original = dpskClient.sendChatMessage
  dpskClient.createSession = async () => ({ id: 'unsigned-thinking-session' })
  dpskClient.sendChatMessage = () => upstreamResponseWithThinking('301', 'internal reasoning', 'final answer')

  try {
    const res = makeResponse()
    const result = await handleAnthropicSync(context(makeRequest(), res, [
      { role: 'user', content: 'return a final answer' },
    ]))
    assert.equal(result, 'success')
    assert.deepEqual(res.body.content, [{ type: 'text', text: 'final answer' }])
    assert.equal(res.body.content.some(block => block.type === 'thinking'), false)
  } finally {
    anthropicUtils.sessionCache.clear()
    dpskClient.createSession = originalCreateSession
    dpskClient.sendChatMessage = original
  }
})

after(() => anthropicUtils.sessionCache.clear())
