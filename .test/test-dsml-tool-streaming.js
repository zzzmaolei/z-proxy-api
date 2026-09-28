'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
    createToolCallStreamParser,
    parseCodexToolCallsFromText,
    parseLooseToolCallsFromText,
    foldToolMessages,
} = require('../src/utils/tool-prompt');
const { writeToolCallsDelta } = require('../src/backends/stream-utils');

describe('DeepSeek DSML Tool Calling & OpenAI Streaming Protocol Contract', () => {
    const mockTools = [
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

    it('1. 1-byte streaming of DSML variants produces 0 leaked text chars and valid tool_call with index', () => {
        const variants = [
            '<｜DSML｜tool_calls>\n<｜DSML｜invoke name="bash">\n<｜DSML｜parameter name="command" string="true">ls -l "/usr/local/skills"</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜tool_calls>',
            '<｜DSML｜ calls>\n｜DSML｜ invoke name="bash">\n<｜DSML｜ parameter name="command" string="true">ls -l "/usr/local/skills"</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>',
            '<|DSML|tool_calls>\n<|DSML|invoke name="bash">\n<|DSML|parameter name="command" string="true">ls -la</|DSML|parameter>\n</|DSML|invoke>\n</|DSML|tool_calls>',
            '<｜DSML｜invoke name="bash">\n<｜DSML｜parameter name="command" string="true">pwd</｜DSML｜parameter>\n</｜DSML｜invoke>',
        ];

        for (const text of variants) {
            const parser = createToolCallStreamParser({ tools: mockTools });
            let leaked = '';
            const calls = [];
            for (let i = 0; i < text.length; i++) {
                const res = parser.push(text[i]);
                if (res.textDelta) leaked += res.textDelta;
                if (res.completedCalls.length > 0) calls.push(...res.completedCalls);
            }
            const flushed = parser.flush();
            if (flushed.textDelta) leaked += flushed.textDelta;
            if (flushed.completedCalls.length > 0) calls.push(...flushed.completedCalls);

            assert.equal(leaked, '', `Variant should not leak any DSML text: ${text.slice(0, 30)}`);
            assert.equal(calls.length, 1, `Variant should produce 1 tool call: ${text.slice(0, 30)}`);
            assert.equal(calls[0].function.name, 'bash');
            assert.equal(typeof calls[0].index, 'number');
            assert.equal(calls[0].index, 0);
        }
    });

    it('2. writeToolCallsDelta always includes a numeric index in every SSE chunk', () => {
        const chunks = [];
        const mockRes = { write: (d) => chunks.push(d) };
        const unindexedCalls = [
            {
                id: 'call_test_01',
                type: 'function',
                function: {
                    name: 'bash',
                    arguments: '{"command":"ls -la /tmp/test_directory_with_long_path"}',
                },
            },
        ];

        writeToolCallsDelta(mockRes, 'req-test', 'deepseek-v4.1-flash-think', unindexedCalls, 16);
        assert.ok(chunks.length >= 3);

        for (const rawChunk of chunks) {
            const jsonStr = rawChunk.replace(/^data:\s*/, '').trim();
            const parsed = JSON.parse(jsonStr);
            const tc = parsed.choices[0].delta.tool_calls[0];
            assert.equal(typeof tc.index, 'number', 'Every tool_call delta chunk must have a numeric index');
            assert.equal(tc.index, 0);
        }
    });

    it('3. foldToolMessages encodes tool results with DeepSeek-V4 official <tool_result> tags', () => {
        const history = [
            { role: 'user', content: 'check dir' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [
                    {
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'bash', arguments: '{"command":"ls"}' },
                    },
                ],
            },
            { role: 'tool', tool_call_id: 'call_1', name: 'bash', content: 'Cargo.toml\nsrc' },
        ];

        const folded = foldToolMessages(history);
        assert.equal(folded[2].role, 'user');
        assert.ok(folded[2].content.includes('<tool_result>'));
        assert.ok(folded[2].content.includes('Cargo.toml'));
        assert.ok(folded[2].content.includes('</tool_result>'));
    });
});
