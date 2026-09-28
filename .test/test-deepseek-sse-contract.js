const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');

const { parseDeepSeekSSE } = require('../src/backends/deepseek/dpsk-client');

function frame(payload) {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

async function collect(stream) {
  const output = [];
  for await (const item of parseDeepSeekSSE(stream)) output.push(item);
  return output;
}

test('DeepSeek SSE preserves THINK/RESPONSE channels and emits one terminal event', async () => {
  const source = [
    frame({ v: { response: { current_message_id: 'msg_1', fragments: [{ type: 'THINK', content: 'read_file(...)' }] } } }),
    frame({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: 'hello' }] }),
    frame({ p: 'response/fragments/-1/content', v: ' world' }),
    frame({ p: 'response/status', o: 'SET', v: 'FINISHED' }),
    frame('[DONE]'),
  ].join('');
  const split = Array.from(Buffer.from(source)).map((byte) => Buffer.from([byte]));
  const items = await collect(Readable.from(split));

  assert.deepEqual(items.filter((item) => item.type === 'thinking').map((item) => item.content), ['read_file(...)']);
  assert.deepEqual(items.filter((item) => item.type === 'text').map((item) => item.content), ['hello', ' world']);
  assert.equal(items.filter((item) => item.type === 'done').length, 1);
});

test('DeepSeek SSE exposes numeric response message ids for parent continuation', async () => {
  const source = [
    'event: ready\n',
    frame({ request_message_id: 1, response_message_id: 2, model_type: 'default' }),
    frame({ v: { response: { message_id: 2, parent_id: 1, fragments: [{ type: 'RESPONSE', content: 'OK' }] } } }),
    frame({ p: 'response/status', o: 'SET', v: 'FINISHED' }),
  ].join('');
  const items = await collect(Readable.from([source]));

  assert.deepEqual(items.filter((item) => item.type === 'message_id').map((item) => item.content), [2]);
  assert.equal(typeof items.find((item) => item.type === 'message_id').content, 'number');
});

test('DeepSeek SSE rejects a normal EOF without FINISHED or DONE', async () => {
  await assert.rejects(
    collect(Readable.from([frame({ p: 'response/fragments', o: 'APPEND', v: [{ type: 'RESPONSE', content: 'partial' }] })])),
    (error) => error?.code === 'UPSTREAM_STREAM_INCOMPLETE',
  );
});

test('DeepSeek SSE surfaces top-level business errors', async () => {
  await assert.rejects(
    collect(Readable.from([frame({ code: 429, msg: 'rate limited' })])),
    (error) => error?.bizCode === 429,
  );
});
