const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  measurePromptBudget,
  buildRetryPrompt,
  getPromptLimits,
  createPromptTooLargeError,
} = require('../src/backends/deepseek/prompt-budget');

test('prompt budget counts UTF-8 bytes and separates soft/hard limits', () => {
  const budget = measurePromptBudget('你好', { messageCount: 2, toolCount: 1 }, {
    softLimit: 5,
    hardLimit: 10,
  });
  assert.equal(budget.bytes, 6);
  assert.equal(budget.status, 'soft_limit');
  assert.equal(budget.messageCount, 2);
  assert.equal(budget.toolCount, 1);
  assert.equal(budget.hasToolHistory, false);
});

test('hard limit is classified before upstream/session work', () => {
  const budget = measurePromptBudget('1234567890', {}, { softLimit: 5, hardLimit: 10 });
  assert.equal(budget.status, 'hard_limit');
  const error = createPromptTooLargeError(budget);
  assert.equal(error.code, 'dpsk_prompt_too_large');
  assert.equal(error.statusCode, 413);
  assert.equal(error.budget.bytes, 10);
});

test('invalid limits use deterministic defaults and preserve soft <= hard', () => {
  const limits = getPromptLimits({ softLimit: -1, hardLimit: 1 });
  assert.ok(limits.softLimit > 0);
  assert.ok(limits.hardLimit >= limits.softLimit);
});

test('model input character limit caps configured DeepSeek Web budget', () => {
  const limits = getPromptLimits({
    softLimit: 180000,
    hardLimit: 200000,
    modelCapabilities: { input_character_limit: 163840 },
  });
  assert.equal(limits.hardLimit, 163840);
  assert.equal(limits.softLimit, 163840);

  const budget = measurePromptBudget('x'.repeat(163840), {}, {
    softLimit: 180000,
    hardLimit: 200000,
    modelCapabilities: { input_character_limit: 163840 },
  });
  assert.equal(budget.status, 'hard_limit');
});

test('retry prompt budget includes the appended hint and never slices the base text', () => {
  const base = '中'.repeat(5);
  const retry = buildRetryPrompt(base, 'Use the registered tool.', {}, { softLimit: 10, hardLimit: 12 });
  assert.equal(retry.allowed, false);
  assert.equal(retry.budget.status, 'hard_limit');
  assert.match(retry.prompt, /^中+\n---\nuser:/);
  assert.equal(retry.prompt.includes('Use the registered tool.'), true);
});
