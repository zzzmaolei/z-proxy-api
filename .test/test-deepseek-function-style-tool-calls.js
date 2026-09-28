const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  parseLooseToolCallsFromText,
  createToolCallStreamParser,
} = require('../src/utils/tool-prompt');

const tools = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      parameters: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'bash',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
];

test('parses registered function-style calls with Windows paths', () => {
  const text = 'read_file({"filePath":"C:\\\\tmp\\\\a.txt"})';
  const parsed = parseLooseToolCallsFromText(text, tools);

  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(parsed.toolCalls[0].function.arguments), {
    filePath: 'C:\\tmp\\a.txt',
  });
  assert.equal(parsed.cleanedText, '');
});

test('parses multiple function-style calls and normalizes aliases', () => {
  const text = [
    'read_file({"filePath":"C:\\\\tmp\\\\a.txt"})',
    'shell({"command":"Get-ChildItem"})',
  ].join('\n');
  const parsed = parseLooseToolCallsFromText(text, tools);

  assert.deepEqual(parsed.toolCalls.map((call) => call.function.name), ['read_file', 'bash']);
  assert.equal(JSON.parse(parsed.toolCalls[1].function.arguments).command, 'Get-ChildItem');
});

test('does not execute natural language, unknown tools, invalid JSON, or incomplete calls', () => {
  const natural = parseLooseToolCallsFromText(
    'I might use read_file({"filePath":"C:\\\\tmp\\\\a.txt"}) later.',
    tools,
  );
  assert.equal(natural.toolCalls.length, 0);

  const unknown = parseLooseToolCallsFromText('delete_file({"filePath":"C:\\\\tmp\\\\a.txt"})', tools);
  assert.equal(unknown.toolCalls.length, 0);

  const invalid = parseLooseToolCallsFromText('read_file({"filePath":})', tools);
  assert.equal(invalid.toolCalls.length, 0);

  const incomplete = parseLooseToolCallsFromText('read_file({"filePath":"C:\\\\tmp\\\\a.txt"}', tools);
  assert.equal(incomplete.toolCalls.length, 0);
});

test('does not treat an unregistered tool as callable when tools are absent', () => {
  const parsed = parseLooseToolCallsFromText('read_file({"filePath":"C:\\\\tmp\\\\a.txt"})', []);
  assert.equal(parsed.toolCalls.length, 0);
});

test('does not treat Codex batch or bare JSON calls as callable with an explicit empty list', () => {
  const codex = parseLooseToolCallsFromText(
    '<tool_calls><invoke name="delete_file"><parameter name="path">a.txt</parameter></invoke></tool_calls>',
    [],
  );
  const bare = parseLooseToolCallsFromText(
    '{"name":"delete_file","arguments":{"path":"a.txt"}}',
    [],
  );
  assert.equal(codex.toolCalls.length, 0);
  assert.equal(bare.toolCalls.length, 0);
});

test('accepts registered Codex batch calls from standard OpenAI tool definitions', () => {
  const parsed = parseLooseToolCallsFromText(
    '<tool_calls><invoke name="read_file"><parameter name="filePath">a.txt</parameter></invoke></tool_calls>',
    tools,
  );
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].function.name, 'read_file');
});

test('stream parser rejects XML calls for unregistered tools', () => {
  const parser = createToolCallStreamParser({ tools });
  const pushed = parser.push('<tool_call>{"name":"delete_file","arguments":{"filePath":"C:\\\\tmp\\\\a.txt"}}</tool_call>');
  const flushed = parser.flush();

  assert.equal(pushed.completedCalls.length, 0);
  assert.equal(flushed.completedCalls.length, 0);
});

test('stream parser rejects unknown calls inside a tool_calls batch', () => {
  const parser = createToolCallStreamParser({ tools });
  const result = parser.push(
    '<tool_calls><invoke name="delete_file"><parameter name="filePath">C:\\\\tmp\\\\a.txt</parameter></invoke>'
      + '<invoke name="read_file"><parameter name="filePath">a.txt</parameter></invoke></tool_calls>',
  );
  const flushed = parser.flush();
  const calls = [...result.completedCalls, ...flushed.completedCalls];

  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'read_file');
});

test('stream parser rejects every batch call when the explicit tool list is empty', () => {
  const parser = createToolCallStreamParser({ tools: [] });
  const result = parser.push(
    '<tool_calls><invoke name="delete_file"><parameter name="filePath">C:\\\\tmp\\\\a.txt</parameter></invoke></tool_calls>',
  );
  const flushed = parser.flush();

  assert.equal(result.completedCalls.length + flushed.completedCalls.length, 0);
});
