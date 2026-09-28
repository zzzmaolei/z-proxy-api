const { test } = require('node:test');
const assert = require('node:assert/strict');

const { detectClientProfile } = require('../src/agents/profile-detector');
const { buildDeepSeekToolSystemPrompt } = require('../src/utils/tool-prompt');
const { _resolveDeepSeekSearchPolicy } = require('../src/controllers/dpsk-chat');

const webSearchTool = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web using the Agent runtime.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
};

test('Hermes profile detection reads nested system/developer text blocks', () => {
  const systemBlockRequest = {
    headers: {},
    body: {
      messages: [{
        role: 'system',
        content: [{ type: 'text', text: 'You are Hermes Agent from Nous Research.' }],
      }],
    },
  };
  const developerRequest = {
    headers: {},
    body: {
      developer: [{ content: [{ type: 'text', text: 'Hermes Agent runtime instructions' }] }],
    },
  };

  assert.equal(detectClientProfile(systemBlockRequest, 'openai').name, 'hermes-agent');
  assert.equal(detectClientProfile(developerRequest, 'openai').name, 'hermes-agent');
});

test('Hermes profile detection ignores user text that merely mentions Hermes', () => {
  const request = {
    headers: {},
    body: {
      messages: [{ role: 'user', content: 'Please compare Hermes Agent with another model.' }],
    },
  };
  assert.equal(detectClientProfile(request, 'openai').name, 'openai-compatible');
});

test('Agent web_search takes precedence over DeepSeek native search', () => {
  const policy = _resolveDeepSeekSearchPolicy({
    searchEnabled: true,
    clientProfile: { name: 'hermes-agent' },
    isCodex: false,
    tools: [webSearchTool],
  });
  assert.equal(policy.isHarnessClient, true);
  assert.equal(policy.hasAgentWebSearchTool, true);
  assert.equal(policy.preferAgentSearch, true);
  assert.equal(policy.effectiveSearchEnabled, false);
});

test('DeepSeek prompt routes search requests through the Agent tool', () => {
  const prompt = buildDeepSeekToolSystemPrompt([webSearchTool], {
    preferAgentSearch: true,
  });
  assert.match(prompt, /Agent search routing/);
  assert.match(prompt, /call this Agent tool/i);
  assert.match(prompt, /native web search is disabled/i);
});

test('Pi coding agent profile detection reads user-agent header', () => {
  const piUaRequest = {
    headers: { 'user-agent': 'pi (coding agent) 0.85.1' },
    body: {},
  };
  const piClientRequest = {
    headers: { 'x-client-name': 'pi-coding-agent' },
    body: {},
  };
  assert.equal(detectClientProfile(piUaRequest, 'openai').name, 'pi-agent');
  assert.equal(detectClientProfile(piClientRequest, 'openai').name, 'pi-agent');
});
