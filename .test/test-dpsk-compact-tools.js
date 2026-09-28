/**
 * DeepSeek 多轮 tool：应使用 compact 工具提示，避免每轮重复塞完整 tools XML。
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// 直接测 dpsk-chat 内未导出的逻辑较难；这里用行为契约：
// conversationHasToolHistory 场景下，compact prompt 应显著短于 full toolSystemPrompt 注入。
// 通过 require 源码里的 buildToolSystemPrompt + 复制 compact 规则做轻量契约测试。

const {
  buildToolSystemPrompt,
  buildToolFormatReminder,
} = require('../src/utils/tool-prompt.js');
const {
  _buildIncrementalPrompt,
  _buildFullPrompt,
} = require('../src/controllers/dpsk-chat.js');

function buildCompactToolSystemPrompt(tools) {
  const names = tools.map((t) => (t && (t.name || t.function?.name)) || '').filter(Boolean);
  const reminder = buildToolFormatReminder(tools, { provider: 'deepseek' });
  return [
    '# Tools (compact — multi-turn)',
    'Continue using the same tools. Prefer short tool calls; do not restate tool schemas.',
    names.length ? `Allowed tool names: ${names.join(', ')}` : '',
    reminder,
  ].filter(Boolean).join('\n');
}

const tools = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Run a shell command with a lot of documentation '.repeat(20),
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'cmd' },
          workdir: { type: 'string', description: 'dir' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read',
      description: 'Read a file '.repeat(30),
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: 'path' },
        },
        required: ['filePath'],
      },
    },
  },
];

describe('dpsk compact tools prompt', () => {
  it('compact prompt much smaller than full tool system prompt', () => {
    const full = buildToolSystemPrompt(tools, { provider: 'deepseek', openAIProtocolHint: true });
    const compact = buildCompactToolSystemPrompt(tools);
    assert.ok(full.length > 500, `full should be long, got ${full.length}`);
    assert.ok(compact.length < full.length / 2, `compact ${compact.length} should be << full ${full.length}`);
    assert.match(compact, /bash/);
    assert.match(compact, /read/);
    assert.match(compact, /tool_call/i);
  });

  it('uses compact schemas after tool history even when the request is stateless', () => {
    const history = [
      { role: 'user', content: 'Inspect the repository.' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'bash', arguments: '{"command":"pwd"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'bash', content: 'C:\\repo' },
      { role: 'user', content: 'Continue with the result.' },
    ];
    const fullPrompt = `${'FULL_TOOL_PROMPT '.repeat(120)}\nUse the complete tool policy.`;

    const built = _buildIncrementalPrompt(history, fullPrompt, null, tools, {
      continuityEnabled: false,
    });
    assert.equal(built.isFull, true);
    assert.equal(built.compactTools, true);
    assert.doesNotMatch(built.prompt, /FULL_TOOL_PROMPT/);
    assert.match(built.prompt, /bash\(command!:string/);
    assert.match(built.prompt, /read\(filePath!:string/);

    const firstTurn = _buildIncrementalPrompt(
      [{ role: 'user', content: 'Inspect the repository.' }],
      fullPrompt,
      null,
      tools,
      { continuityEnabled: false },
    );
    assert.equal(firstTurn.compactTools, false);
    assert.match(firstTurn.prompt, /FULL_TOOL_PROMPT/);

    const responsesTurn = _buildFullPrompt(history, fullPrompt, tools);
    assert.equal(responsesTurn.compactTools, true);
    assert.doesNotMatch(responsesTurn.prompt, /FULL_TOOL_PROMPT/);
  });
});
