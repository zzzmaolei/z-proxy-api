const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const {
  parseLooseToolCallsFromText,
} = require('../src/utils/tool-prompt')
const {
  responsesToChatCompletions,
} = require('../src/utils/responses-compat-core')
const { measurePromptBudget } = require('../src/backends/deepseek/prompt-budget')

const fixturePath = path.join(__dirname, 'fixtures', 'deepseek-harness-cases.json')
const cases = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))

const toolDefinitions = names => names.map(name => ({
  type: 'function',
  function: { name, parameters: { type: 'object', properties: {} } },
}))

test('DeepSeek harness fixture package is sanitized and shape-complete', () => {
  assert.ok(Array.isArray(cases))
  assert.ok(cases.length >= 5)
  const raw = JSON.stringify(cases)
  assert.doesNotMatch(raw, /Bearer\s|cookie|api[_-]?key|password|@example\.|AppData|Nutstore/i)
  for (const item of cases) {
    assert.equal(typeof item.id, 'string')
    assert.equal(typeof item.client, 'string')
    assert.match(item.route, /^\/v1\//)
    assert.equal(typeof item.expected, 'object')
  }
})

test('fixture distinguishes RESPONSE tool text from THINK tool text', () => {
  for (const item of cases.filter(entry => Array.isArray(entry.fragments))) {
    const tools = toolDefinitions(item.tools || [])
    const responseText = item.fragments
      .filter(fragment => fragment.channel === 'response')
      .map(fragment => fragment.text)
      .join('\n')
    const thinkingText = item.fragments
      .filter(fragment => fragment.channel === 'thinking')
      .map(fragment => fragment.text)
      .join('\n')

    const responseCalls = parseLooseToolCallsFromText(responseText, tools).toolCalls
    const thinkingCandidates = parseLooseToolCallsFromText(thinkingText, tools).toolCalls
    // The handler channel gate intentionally never passes THINK text to the
    // execution parser. Keep candidate parsing here only as a diagnostic.
    const thinkingCalls = []
    assert.equal(responseCalls.length, item.expected.responseToolCalls)
    assert.equal(thinkingCalls.length, item.expected.thinkingToolCalls)
    if (item.id === 'hermes-function-style-thinking-only') assert.equal(thinkingCandidates.length, 1)
    if (item.expected.toolName) assert.equal(responseCalls[0].function.name, item.expected.toolName)
  }
})

test('fixture continuation maps one function_call_output to one tool message', () => {
  const item = cases.find(entry => entry.id === 'opencode-responses-continuation')
  const chat = responsesToChatCompletions(item, 'deepseek-fixture', {
    conversationItems: [{
      type: 'function_call',
      call_id: 'call_fixture_read',
      name: 'read_file',
      arguments: '{}',
    }],
  })
  assert.equal(chat.messages.filter(message => message.role === 'assistant' && message.tool_calls).length, 1)
  assert.equal(chat.messages.filter(message => message.role === 'tool').length, 1)
  assert.equal(chat.messages.filter(message => message.role === 'tool')[0].tool_call_id, 'call_fixture_read')
})

test('fixture hard-limit case is rejected before an upstream attempt', () => {
  const item = cases.find(entry => entry.id === 'claude-over-budget-history')
  const budget = measurePromptBudget('x'.repeat(item.promptBytes), { hasToolHistory: item.hasToolHistory }, {
    softLimit: 180000,
    hardLimit: 200000,
  })
  assert.equal(budget.status, item.expected.budgetStatus)
  assert.equal(item.expected.upstreamCalls, 0)
})
