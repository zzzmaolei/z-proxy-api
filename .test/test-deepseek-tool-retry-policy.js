const { test } = require('node:test');
const assert = require('node:assert/strict');

const { shouldRetrySemantic } = require('../src/backends/deepseek/tool-retry-policy');

const tools = true;

test('tool retry policy allows one required correction but never none', () => {
  assert.equal(shouldRetrySemantic({ toolChoice: 'required', hasTools: tools, reason: 'required' }), true);
  assert.equal(shouldRetrySemantic({ toolChoice: 'required', hasTools: tools, reason: 'generic' }), false);
  assert.equal(shouldRetrySemantic({ toolChoice: 'none', hasTools: tools, reason: 'required' }), false);
});

test('auto does not retry ordinary answers or thinking-only tool text', () => {
  assert.equal(shouldRetrySemantic({
    toolChoice: 'auto',
    hasTools: tools,
    reason: 'generic',
    responseText: 'The model is DeepSeek.',
    explicitToolIntent: false,
  }), false);
  assert.equal(shouldRetrySemantic({
    toolChoice: 'auto',
    hasTools: tools,
    reason: 'generic',
    responseText: 'I will use read_file(...)',
    explicitToolIntent: true,
  }), true);
  assert.equal(shouldRetrySemantic({
    toolChoice: 'auto',
    hasTools: tools,
    reason: 'generic',
    responseText: '',
    thinkingText: 'I will use read_file(...)',
    explicitToolIntent: true,
  }), false);
});

test('empty correction is limited to an actually empty response', () => {
  assert.equal(shouldRetrySemantic({
    toolChoice: 'auto',
    hasTools: tools,
    reason: 'empty',
    responseText: '',
    thinkingText: '',
  }), true);
  assert.equal(shouldRetrySemantic({
    toolChoice: 'auto',
    hasTools: tools,
    reason: 'empty',
    responseText: 'normal answer',
  }), false);
  assert.equal(shouldRetrySemantic({
    toolChoice: 'auto',
    hasTools: tools,
    hasToolCalls: true,
    reason: 'empty',
  }), false);
});
