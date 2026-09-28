const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    buildToolSystemPrompt,
    buildHermesToolSystemPrompt,
} = require('../src/utils/tool-prompt');
const { looksLikeDirectToolIntent } = require('../src/backends/deepseek/stream-handler');

const tools = [
    {
        type: 'function',
        function: {
            name: 'read_file',
            description: 'Read a local file from disk. '.repeat(20),
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Absolute path' },
                    limit: { type: 'integer' },
                },
                required: ['filePath'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'bash',
            description: 'Run a shell command. '.repeat(20),
            parameters: {
                type: 'object',
                properties: { command: { type: 'string' } },
                required: ['command'],
            },
        },
    },
];

test('DeepSeek tool prompts stay compact and use one unambiguous format', () => {
    const prompt = buildToolSystemPrompt(tools, {
        provider: 'deepseek',
        tool_choice: 'auto',
    });
    const hermesPrompt = buildHermesToolSystemPrompt(tools, {
        provider: 'deepseek',
        tool_choice: 'auto',
    });

    assert.ok(prompt.length < 1500, `prompt unexpectedly long: ${prompt.length}`);
    assert.equal(hermesPrompt, prompt);
    assert.match(prompt, /<tool_call>/);
    assert.match(prompt, /read_file\(filePath!:string/);
    assert.doesNotMatch(prompt, /CRITICAL|native JSON|Format inertia|Qwen platform/i);
});

test('tool-intent correction ignores normal short answers', () => {
    assert.equal(looksLikeDirectToolIntent('The model is DeepSeek Chat.', tools), false);
    assert.equal(
        looksLikeDirectToolIntent('I will use read_file({"filePath":"C:\\\\tmp\\\\a.txt"}) now.', tools),
        true,
    );
    assert.equal(
        looksLikeDirectToolIntent('<tool_call>{"name":"bash","arguments":{}}</tool_call>', tools),
        true,
    );
});
