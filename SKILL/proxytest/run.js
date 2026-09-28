#!/usr/bin/env node
/**
 * proxytest - z.proxy.api 全链路烟雾测试
 *
 * 用法：node SKILL/proxytest/run.js [--base-only] [--long-only] [--no-stream] [--no-long] [--no-compat]
 *   --base-only   只跑基础测试 #1-#10
 *   --long-only   只跑超长上下文 #13-#16
 *   --no-stream   跳过流式测试
 *   --no-long     跳过超长上下文测试
 *   --no-compat   跳过 Claude Code 兼容性测试 #17-#18
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------- 配置 ----------
const HOST = '127.0.0.1';
const PORT = 9090;

// 从 .env 读取 API_KEY
function loadApiKey() {
  try {
    const envPath = path.resolve(process.cwd(), '.env');
    const env = fs.readFileSync(envPath, 'utf8');
    const m = env.match(/^API_KEY\s*=\s*(.+)\s*$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch (_) {}
  return null;
}

const API_KEY = loadApiKey() || 'sk-666666';

// ---------- HTTP 请求 ----------
function request(method, urlPath, body, headers = {}, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const reqHeaders = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
      ...headers,
    };
    if (bodyStr) reqHeaders['Content-Length'] = Buffer.byteLength(bodyStr);

    const start = Date.now();
    const req = http.request(
      { host: HOST, port: PORT, path: urlPath, method, headers: reqHeaders, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            elapsed: ((Date.now() - start) / 1000).toFixed(2),
          });
        });
      }
    );
    req.on('error', (e) => resolve({ status: 0, error: e.message, elapsed: ((Date.now() - start) / 1000).toFixed(2), body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout', elapsed: ((Date.now() - start) / 1000).toFixed(2), body: '' }); });
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ---------- XML 泄漏检测 ----------
const XML_LEAK_RE = /<tool_invoke>|<\/tool_invoke>|<tool_call|<\/tool_call|\$tool_call\$|<tool_response/i;
function hasXmlLeak(text) {
  if (!text || typeof text !== 'string') return false;
  return XML_LEAK_RE.test(text);
}

// ---------- 测试用例定义 ----------
const QWEN_MODEL = 'qwen3-max';
const DPSK_MODEL = 'deepseek';
const OPENAI_URL = '/v1/chat/completions';
const ANTH_URL = '/v1/messages';
const ANTH_HEADERS = { 'anthropic-version': '2023-06-01' };

const calcToolOpenAI = [{ type: 'function', function: { name: 'calc', description: 'calculate a math expression', parameters: { type: 'object', properties: { expr: { type: 'string' } }, required: ['expr'] } } }];
const calcToolAnthropic = [{ name: 'calc', description: 'calculate a math expression', input_schema: { type: 'object', properties: { expr: { type: 'string' } }, required: ['expr'] } }];

// ---------- 结果收集 ----------
const results = [];
function record(idx, route, proto, mode, elapsed, ok, note) {
  results.push({ idx, route, proto, mode, elapsed, ok, note });
  const mark = ok ? '✅' : '❌';
  console.log(`${mark} #${idx} ${route} ${proto} ${mode} (${elapsed}s) ${ok ? '' : '| ' + note}`);
}

// ---------- 基础测试 ----------
async function baseTests() {
  console.log('\n========== A. 基础测试 #1-#10 ==========');

  // #1 Qwen 普通非流式
  {
    const r = await request('POST', OPENAI_URL, { model: QWEN_MODEL, messages: [{ role: 'user', content: 'say hi in 3 words' }], stream: false });
    let ok = false, note = '';
    try {
      const j = JSON.parse(r.body);
      ok = r.status === 200 && !!j.choices?.[0]?.message?.content && j.choices[0].finish_reason === 'stop';
      if (!ok) note = `status=${r.status} content=${j.choices?.[0]?.message?.content} fr=${j.choices?.[0]?.finish_reason}`;
    } catch (e) { note = `parse error: ${e.message} body=${r.body?.slice(0, 200)}`; }
    record(1, 'Qwen', 'OpenAI', '普通非流式', r.elapsed, ok, note);
  }

  // #2 Qwen 普通流式
  {
    const r = await request('POST', OPENAI_URL, { model: QWEN_MODEL, messages: [{ role: 'user', content: 'say hi in 3 words' }], stream: true });
    let ok = false, note = '';
    try {
      const lines = r.body.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'));
      const contentParts = lines.map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
      const hasContent = contentParts.some(c => c.choices?.[0]?.delta?.content);
      const hasDone = r.body.includes('[DONE]');
      ok = r.status === 200 && hasContent && hasDone;
      if (!ok) note = `status=${r.status} contentEvents=${contentParts.length} hasDone=${hasDone}`;
    } catch (e) { note = `error: ${e.message}`; }
    record(2, 'Qwen', 'OpenAI', '普通流式', r.elapsed, ok, note);
  }

  // #3 Qwen tools 非流式
  {
    const r = await request('POST', OPENAI_URL, { model: QWEN_MODEL, messages: [{ role: 'user', content: 'what is 1+1? use the calc tool' }], tools: calcToolOpenAI, stream: false });
    let ok = false, note = '';
    try {
      const j = JSON.parse(r.body);
      const tc = j.choices?.[0]?.message?.tool_calls;
      const content = j.choices?.[0]?.message?.content;
      ok = r.status === 200 && tc?.length > 0 && tc[0].function.name === 'calc' && j.choices[0].finish_reason === 'tool_calls' && !hasXmlLeak(content);
      if (!ok) note = `status=${r.status} tool_calls=${JSON.stringify(tc)} fr=${j.choices?.[0]?.finish_reason} content=${content?.slice(0,100)}`;
    } catch (e) { note = `error: ${e.message} body=${r.body?.slice(0, 200)}`; }
    record(3, 'Qwen', 'OpenAI', 'tools非流式', r.elapsed, ok, note);
  }

  // #4 Qwen tools 流式
  {
    const r = await request('POST', OPENAI_URL, { model: QWEN_MODEL, messages: [{ role: 'user', content: 'what is 1+1? use the calc tool' }], tools: calcToolOpenAI, stream: true });
    let ok = false, note = '';
    try {
      const lines = r.body.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'));
      const events = lines.map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
      const hasToolCall = events.some(c => c.choices?.[0]?.delta?.tool_calls);
      const hasFinish = events.some(c => c.choices?.[0]?.finish_reason === 'tool_calls');
      const hasDone = r.body.includes('[DONE]');
      // 收集所有 content
      const allContent = events.map(c => c.choices?.[0]?.delta?.content || '').join('');
      ok = r.status === 200 && hasToolCall && hasFinish && hasDone && !hasXmlLeak(allContent);
      if (!ok) note = `status=${r.status} toolCall=${hasToolCall} finish=${hasFinish} done=${hasDone} leak=${hasXmlLeak(allContent)}`;
    } catch (e) { note = `error: ${e.message}`; }
    record(4, 'Qwen', 'OpenAI', 'tools流式', r.elapsed, ok, note);
  }

  // #5 Qwen Anthropic tools 非流式
  {
    const r = await request('POST', ANTH_URL, { model: QWEN_MODEL, messages: [{ role: 'user', content: 'what is 1+1? use the calc tool' }], tools: calcToolAnthropic, stream: false, max_tokens: 1024 }, ANTH_HEADERS);
    let ok = false, note = '';
    try {
      const j = JSON.parse(r.body);
      const blocks = j.content || [];
      const toolUse = blocks.find(b => b.type === 'tool_use' && b.name === 'calc');
      const textBlocks = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
      ok = r.status === 200 && toolUse && j.stop_reason === 'tool_use' && !hasXmlLeak(textBlocks);
      if (!ok) note = `status=${r.status} stop=${j.stop_reason} toolUse=${!!toolUse} leak=${hasXmlLeak(textBlocks)}`;
    } catch (e) { note = `error: ${e.message} body=${r.body?.slice(0, 200)}`; }
    record(5, 'Qwen', 'Anthropic', 'tools非流式', r.elapsed, ok, note);
  }

  // #6 DeepSeek 普通非流式
  {
    const r = await request('POST', OPENAI_URL, { model: DPSK_MODEL, messages: [{ role: 'user', content: 'say hi in 3 words' }], stream: false });
    let ok = false, note = '';
    try {
      const j = JSON.parse(r.body);
      ok = r.status === 200 && !!j.choices?.[0]?.message?.content && j.choices[0].finish_reason === 'stop';
      if (!ok) note = `status=${r.status} content=${j.choices?.[0]?.message?.content} fr=${j.choices?.[0]?.finish_reason}`;
    } catch (e) { note = `error: ${e.message} body=${r.body?.slice(0, 200)}`; }
    record(6, 'DeepSeek', 'OpenAI', '普通非流式', r.elapsed, ok, note);
  }

  // #7 DeepSeek 普通流式
  {
    const r = await request('POST', OPENAI_URL, { model: DPSK_MODEL, messages: [{ role: 'user', content: 'say hi in 3 words' }], stream: true });
    let ok = false, note = '';
    try {
      const lines = r.body.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'));
      const events = lines.map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
      const hasContent = events.some(c => c.choices?.[0]?.delta?.content);
      const hasDone = r.body.includes('[DONE]');
      ok = r.status === 200 && hasContent && hasDone;
      if (!ok) note = `status=${r.status} contentEvents=${events.length} hasDone=${hasDone}`;
    } catch (e) { note = `error: ${e.message}`; }
    record(7, 'DeepSeek', 'OpenAI', '普通流式', r.elapsed, ok, note);
  }

  // #8 DeepSeek tools 非流式
  {
    const r = await request('POST', OPENAI_URL, { model: DPSK_MODEL, messages: [{ role: 'user', content: 'what is 1+1? use the calc tool' }], tools: calcToolOpenAI, stream: false });
    let ok = false, note = '';
    try {
      const j = JSON.parse(r.body);
      const tc = j.choices?.[0]?.message?.tool_calls;
      const content = j.choices?.[0]?.message?.content;
      ok = r.status === 200 && tc?.length > 0 && tc[0].function.name === 'calc' && j.choices[0].finish_reason === 'tool_calls' && !hasXmlLeak(content);
      if (!ok) note = `status=${r.status} tool_calls=${JSON.stringify(tc)} fr=${j.choices?.[0]?.finish_reason}`;
    } catch (e) { note = `error: ${e.message} body=${r.body?.slice(0, 200)}`; }
    record(8, 'DeepSeek', 'OpenAI', 'tools非流式', r.elapsed, ok, note);
  }

  // #9 DeepSeek tools 流式
  {
    const r = await request('POST', OPENAI_URL, { model: DPSK_MODEL, messages: [{ role: 'user', content: 'what is 1+1? use the calc tool' }], tools: calcToolOpenAI, stream: true });
    let ok = false, note = '';
    try {
      const lines = r.body.split('\n').filter(l => l.startsWith('data: ') && !l.includes('[DONE]'));
      const events = lines.map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
      const hasToolCall = events.some(c => c.choices?.[0]?.delta?.tool_calls);
      const hasFinish = events.some(c => c.choices?.[0]?.finish_reason === 'tool_calls');
      const hasDone = r.body.includes('[DONE]');
      const allContent = events.map(c => c.choices?.[0]?.delta?.content || '').join('');
      ok = r.status === 200 && hasToolCall && hasFinish && hasDone && !hasXmlLeak(allContent);
      if (!ok) note = `status=${r.status} toolCall=${hasToolCall} finish=${hasFinish} done=${hasDone} leak=${hasXmlLeak(allContent)}`;
    } catch (e) { note = `error: ${e.message}`; }
    record(9, 'DeepSeek', 'OpenAI', 'tools流式', r.elapsed, ok, note);
  }

  // #10 DeepSeek Anthropic tools 非流式
  {
    const r = await request('POST', ANTH_URL, { model: DPSK_MODEL, messages: [{ role: 'user', content: 'what is 1+1? use the calc tool' }], tools: calcToolAnthropic, stream: false, max_tokens: 1024 }, ANTH_HEADERS);
    let ok = false, note = '';
    try {
      const j = JSON.parse(r.body);
      const blocks = j.content || [];
      const toolUse = blocks.find(b => b.type === 'tool_use' && b.name === 'calc');
      const textBlocks = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
      ok = r.status === 200 && toolUse && j.stop_reason === 'tool_use' && !hasXmlLeak(textBlocks);
      if (!ok) note = `status=${r.status} stop=${j.stop_reason} toolUse=${!!toolUse}`;
    } catch (e) { note = `error: ${e.message} body=${r.body?.slice(0, 200)}`; }
    record(10, 'DeepSeek', 'Anthropic', 'tools非流式', r.elapsed, ok, note);
  }
}

// ---------- Anthropic tools 流式 ----------
async function anthropicStreamTests() {
  console.log('\n========== B. Anthropic tools 流式 #11-#12 ==========');

  // #11 Qwen
  {
    const r = await request('POST', ANTH_URL, { model: QWEN_MODEL, messages: [{ role: 'user', content: 'what is 1+1? use the calc tool' }], tools: calcToolAnthropic, stream: true, max_tokens: 1024 }, ANTH_HEADERS);
    let ok = false, note = '';
    try {
      const body = r.body;
      const hasToolUseStart = /event:\s*content_block_start/.test(body) && /"type":\s*"tool_use"/.test(body) && /"name":\s*"calc"/.test(body);
      const hasInputJsonDelta = /"type":\s*"input_json_delta"/.test(body);
      const hasStopReason = /"stop_reason":\s*"tool_use"/.test(body);
      const hasMessageStop = /event:\s*message_stop/.test(body);
      // 收集所有 text_delta 的文本
      const textMatches = body.match(/"text":\s*"((?:[^"\\]|\\.)*)"/g) || [];
      // 需过滤 tool_use 相关，简单检测是否有 XML 泄漏
      ok = r.status === 200 && hasToolUseStart && hasInputJsonDelta && hasStopReason && hasMessageStop && !hasXmlLeak(body);
      if (!ok) note = `status=${r.status} toolUseStart=${hasToolUseStart} inputDelta=${hasInputJsonDelta} stopReason=${hasStopReason} msgStop=${hasMessageStop} leak=${hasXmlLeak(body)}`;
    } catch (e) { note = `error: ${e.message}`; }
    record(11, 'Qwen', 'Anthropic', 'tools流式', r.elapsed, ok, note);
  }

  // #12 DeepSeek
  {
    const r = await request('POST', ANTH_URL, { model: DPSK_MODEL, messages: [{ role: 'user', content: 'what is 1+1? use the calc tool' }], tools: calcToolAnthropic, stream: true, max_tokens: 1024 }, ANTH_HEADERS);
    let ok = false, note = '';
    try {
      const body = r.body;
      const hasToolUseStart = /event:\s*content_block_start/.test(body) && /"type":\s*"tool_use"/.test(body) && /"name":\s*"calc"/.test(body);
      const hasInputJsonDelta = /"type":\s*"input_json_delta"/.test(body);
      const hasStopReason = /"stop_reason":\s*"tool_use"/.test(body);
      const hasMessageStop = /event:\s*message_stop/.test(body);
      ok = r.status === 200 && hasToolUseStart && hasInputJsonDelta && hasStopReason && hasMessageStop && !hasXmlLeak(body);
      if (!ok) note = `status=${r.status} toolUseStart=${hasToolUseStart} inputDelta=${hasInputJsonDelta} stopReason=${hasStopReason} msgStop=${hasMessageStop} leak=${hasXmlLeak(body)}`;
    } catch (e) { note = `error: ${e.message}`; }
    record(12, 'DeepSeek', 'Anthropic', 'tools流式', r.elapsed, ok, note);
  }
}

// ---------- 超长上下文 + tools 多轮 ----------
function genFiller(targetTokens = 30000) {
  // 英文约 4 字符/token，生成 ~targetTokens * 4 字符
  const para = 'The quick brown fox jumps over the lazy dog near the riverbank at sunset while birds sing in the trees and the wind gently rustles the leaves creating a peaceful atmosphere that calms the mind and soothes the soul. ';
  const targetChars = targetTokens * 4;
  const repeats = Math.ceil(targetChars / para.length);
  return para.repeat(repeats).slice(0, targetChars);
}

async function longContextTest(idx, route, proto) {
  console.log(`\n--- #${idx} ${route} ${proto} 超长上下文+tools多轮 ---`);
  const model = route === 'Qwen' ? QWEN_MODEL : DPSK_MODEL;
  const isAnthropic = proto === 'Anthropic';
  const url = isAnthropic ? ANTH_URL : OPENAI_URL;
  const headers = isAnthropic ? ANTH_HEADERS : {};
  const tools = isAnthropic ? calcToolAnthropic : calcToolOpenAI;
  const filler = genFiller(30000);

  const exprs = ['1+1', '2+2', '4+4'];
  const expectedArgs = ['1+1', '2+2', '4+4'];
  const expectedResults = ['2', '4', '8'];

  // 构造多轮 messages
  let messages = [];
  let allOk = true;
  let note = '';

  for (let round = 0; round < 3; round++) {
    const userContent = `${filler}\n\nRound ${round + 1}: The previous results were ${expectedResults.slice(0, round).join(', ') || 'none'}. Calculate ${exprs[round]} using the calc tool.`;

    if (isAnthropic) {
      messages.push({ role: 'user', content: userContent });
      // 补上历史轮的 assistant tool_use + tool_result
      if (round > 0) {
        // 前一轮的 assistant
        messages.splice(messages.length - 1, 0, {
          role: 'assistant',
          content: [{ type: 'tool_use', id: `call_r${round}`, name: 'calc', input: { expr: exprs[round - 1] } }]
        });
        // tool_result 作为 user 消息
        messages.splice(messages.length - 1, 0, {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: `call_r${round}`, content: expectedResults[round - 1] }]
        });
      }
    } else {
      messages.push({ role: 'user', content: userContent });
      if (round > 0) {
        messages.splice(messages.length - 1, 0,
          { role: 'assistant', content: '', tool_calls: [{ id: `call_r${round}`, type: 'function', function: { name: 'calc', arguments: JSON.stringify({ expr: exprs[round - 1] }) } }] },
          { role: 'tool', tool_call_id: `call_r${round}`, name: 'calc', content: expectedResults[round - 1] }
        );
      }
    }

    const body = isAnthropic
      ? { model, messages: JSON.parse(JSON.stringify(messages)), tools, stream: false, max_tokens: 1024 }
      : { model, messages: JSON.parse(JSON.stringify(messages)), tools, stream: false };

    console.log(`  Round ${round + 1}: sending (messages=${messages.length})...`);
    const r = await request('POST', url, body, headers, 180000);

    let roundOk = false;
    let roundNote = '';
    try {
      if (isAnthropic) {
        const j = JSON.parse(r.body);
        const blocks = j.content || [];
        const toolUse = blocks.find(b => b.type === 'tool_use' && b.name === 'calc');
        const textBlocks = blocks.filter(b => b.type === 'text').map(b => b.text).join('');
        const leaked = hasXmlLeak(textBlocks);
        roundOk = r.status === 200 && toolUse && j.stop_reason === 'tool_use' && !leaked;
        if (!roundOk) roundNote = `status=${r.status} stop=${j.stop_reason} toolUse=${!!toolUse} leak=${leaked}`;
        // 检查 input.expr
        if (roundOk && toolUse && !JSON.stringify(toolUse.input).includes(expectedArgs[round])) {
          roundOk = false;
          roundNote = `wrong args: ${JSON.stringify(toolUse.input)}`;
        }
      } else {
        const j = JSON.parse(r.body);
        const tc = j.choices?.[0]?.message?.tool_calls;
        const content = j.choices?.[0]?.message?.content;
        const leaked = hasXmlLeak(content);
        roundOk = r.status === 200 && tc?.length > 0 && tc[0].function.name === 'calc' && j.choices[0].finish_reason === 'tool_calls' && !leaked;
        if (!roundOk) roundNote = `status=${r.status} tc=${JSON.stringify(tc)} fr=${j.choices?.[0]?.finish_reason} leak=${leaked}`;
        if (roundOk && !tc[0].function.arguments.includes(expectedArgs[round])) {
          roundOk = false;
          roundNote = `wrong args: ${tc[0].function.arguments}`;
        }
      }
    } catch (e) {
      roundNote = `error: ${e.message} body=${r.body?.slice(0, 300)}`;
    }

    console.log(`  Round ${round + 1}: ${roundOk ? '✅' : '❌'} (${r.elapsed}s) ${roundOk ? '' : roundNote}`);
    if (!roundOk) {
      allOk = false;
      note = `R${round + 1}失败: ${roundNote}`;
      break;
    }
  }

  record(idx, route, proto, '超长上下文+tools多轮', '-', allOk, note);
}

// ---------- Claude Code 兼容性测试 ----------
async function claudeCodeCompatTests() {
  console.log('\n========== D. Claude Code 兼容性 #17-#18 ==========');

  // 验证 system role in messages + assistant content=null 能通过
  // Claude Code 某些版本会把 system 放到 messages 数组，assistant 多轮 tools 中 content 可能为 null
  const messages = [
    { role: 'user', content: 'Calculate 1+1 using the calc tool.' },
    { role: 'system', content: 'You are a helpful assistant that always uses tools when asked to calculate.' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_prev', type: 'function', function: { name: 'calc', arguments: JSON.stringify({ expr: '0+0' }) } }] },
    { role: 'user', content: 'Now calculate 1+1 using the calc tool.' },
  ];

  for (const [route, model, idx] of [['Qwen', QWEN_MODEL, 17], ['DeepSeek', DPSK_MODEL, 18]]) {
    const r = await request('POST', ANTH_URL, {
      model,
      messages,
      tools: calcToolAnthropic,
      stream: true,
      max_tokens: 1024,
    }, ANTH_HEADERS);

    let ok = false, note = '';
    try {
      const body = r.body;
      // 不应返回 400
      if (r.status !== 200) {
        note = `status=${r.status} body=${body.slice(0, 300)}`;
      } else {
        const hasMessageStart = /event:\s*message_start/.test(body);
        const hasToolUseStart = /event:\s*content_block_start/.test(body) && /"type":\s*"tool_use"/.test(body) && /"name":\s*"calc"/.test(body);
        const hasStopReason = /"stop_reason":\s*"tool_use"/.test(body);
        const hasMessageStop = /event:\s*message_stop/.test(body);
        const leaked = hasXmlLeak(body);
        ok = hasMessageStart && hasToolUseStart && hasStopReason && hasMessageStop && !leaked;
        if (!ok) note = `msgStart=${hasMessageStart} toolUse=${hasToolUseStart} stop=${hasStopReason} msgStop=${hasMessageStop} leak=${leaked}`;
      }
    } catch (e) { note = `error: ${e.message} body=${r.body?.slice(0, 200)}`; }
    record(idx, route, 'Anthropic', 'CC兼容性', r.elapsed, ok, note);
  }
}

// ---------- 主流程 ----------
async function main() {
  console.log(`proxytest - z.proxy.api 全链路烟雾测试`);
  console.log(`API_KEY: ${API_KEY.slice(0, 6)}...${API_KEY.slice(-4)}`);
  console.log(`Target: http://${HOST}:${PORT}`);

  const args = process.argv.slice(2);
  const baseOnly = args.includes('--base-only');
  const longOnly = args.includes('--long-only');
  const noStream = args.includes('--no-stream');
  const noLong = args.includes('--no-long');
  const noCompat = args.includes('--no-compat');

  if (!longOnly) await baseTests();
  if (!longOnly && !noStream) await anthropicStreamTests();
  if (!noCompat) await claudeCodeCompatTests();
  if (!baseOnly && !noLong) {
    await longContextTest(13, 'Qwen', 'OpenAI');
    await longContextTest(14, 'DeepSeek', 'OpenAI');
    await longContextTest(15, 'Qwen', 'Anthropic');
    await longContextTest(16, 'DeepSeek', 'Anthropic');
  }

  // 汇总
  console.log('\n========== 汇总报告 ==========');
  console.log('# | 路由 | 协议 | 模式 | 耗时 | 结果 | 备注');
  console.log('-'.repeat(80));
  for (const r of results) {
    const mark = r.ok ? '✅' : '❌';
    console.log(`${r.idx} | ${r.route} | ${r.proto} | ${r.mode} | ${r.elapsed}s | ${mark} | ${r.note}`);
  }
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  console.log('-'.repeat(80));
  console.log(`总计: ${results.length} | 通过: ${passed} | 失败: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('Fatal:', e); process.exit(2); });
