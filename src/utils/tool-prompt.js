const { generateUUID } = require('./tools.js');
const { logger } = require('./logger');

/**
 * 工具调用提示词与流式解析器
 *
 * 本模块被所有 provider 路线（Qwen / DeepSeek）共用。
 * 模块内所有函数不依赖具体上游，只处理 OpenAI 风格的 tool_calls 与文本之间的相互转换。
 *
 * # 设计原则：反代中转 + Prompt 模拟
 *
 * 反代层只做两件事：
 *   1. 提供工具列表（让模型知道有哪些工具可用）
 *   2. 告诉模型这是 prompt 模拟环境，用文本输出工具调用，不要用原生 function call
 *
 * 格式指令由 harness 的 system prompt 主导，反代层不注入任何格式约束。
 * 解析器必须宽容，识别模型实际输出的各种变体。
 *
 * # 使用方式
 *
 *   1. buildToolSystemPrompt(tools, options) 生成工具列表 + prompt 模拟提示
 *   2. injectToolPromptToLastUser() 把提示注入最后一条 user 消息
 *   3. createToolCallStreamParser() 实时解析模型输出的工具调用块
 *   4. parseToolCallsFromText() 从完整文本中提取工具调用
 */

/**
 * 工具调用 XML 起始标签
 * @type {string}
 */
const TOOL_CALL_OPEN = '<tool_call>';
const TOOL_CALLS_OPEN = '<tool_calls>';  // Codex CLI 原生格式（复数）
const TOOL_CALL_CLOSE = '</tool_call>';
const TOOL_CALLS_CLOSE = '</tool_calls>';  // Codex CLI 原生格式（复数）
const TOOL_RESPONSE_OPEN = '<tool_response';
const TOOL_RESPONSE_CLOSE = '</tool_response>';
const DOLLAR_TOOL_CALL_OPEN = '$tool_call$';
const DOLLAR_TOOL_CALL_CLOSE = '$/tool_call$';
// Qwen Web 上游会拦截 <tool_call> 标签触发原生 function_call 机制，
// 使用 <tool_invoke> 作为别名绕过拦截。解析器同时支持两种标签。
// <tool_use> 是 Anthropic 原生格式，Claude Code 的 system prompt 教模型用这个格式，
// 模型可能因混淆而输出 <tool_use>，解析器作为兜底兼容。
const TOOL_INVOKE_OPEN = '<tool_invoke>';
const TOOL_INVOKE_CLOSE = '</tool_invoke>';
const TOOL_USE_OPEN = '<tool_use>';
const TOOL_USE_CLOSE = '</tool_use>';
const TOOL_DIALECTS = Object.freeze({
  qwen: Object.freeze({ open: TOOL_INVOKE_OPEN, close: TOOL_INVOKE_CLOSE }),
  deepseek: Object.freeze({ open: TOOL_CALL_OPEN, close: TOOL_CALL_CLOSE }),
  default: Object.freeze({ open: TOOL_CALL_OPEN, close: TOOL_CALL_CLOSE }),
});
const getToolDialect = (provider = 'default') => TOOL_DIALECTS[provider] || TOOL_DIALECTS.default;

const stringifyPromptJson = (value) => JSON.stringify(value)
  .replace(/</g, '\\u003c')
  .replace(/>/g, '\\u003e')
  .replace(/&/g, '\\u0026');

const sampleFromJsonSchema = (schema) => {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.default !== undefined) return schema.default;
  if (schema.example !== undefined) return schema.example;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  let type = schema.type;
  if (Array.isArray(type)) type = type.find(item => item !== 'null') || type[0];
  if (!type && schema.properties) type = 'object';
  if (type === 'string') return '';
  if (type === 'integer' || type === 'number') return 0;
  if (type === 'boolean') return false;
  if (type === 'array') return [];
  if (type === 'object') {
    const result = {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) result[key] = sampleFromJsonSchema(schema.properties?.[key]);
    return result;
  }
  if (type === 'null') return null;
  return null;
};

const buildToolExample = (tool, options = {}) => {
  const fn = tool?.function || tool || {};
  const name = fn.name || options.name || 'tool';
  const schema = fn.parameters || fn.input_schema || { type: 'object', properties: {} };
  const sample = sampleFromJsonSchema(schema);
  const args = sample && typeof sample === 'object' && !Array.isArray(sample) ? sample : {};
  return JSON.stringify({ name, arguments: args });
};

const buildToolFormatReminder = (tools, options = {}) => {
  if (!Array.isArray(tools) || tools.length === 0) return '';
  const dialect = getToolDialect(options.provider);
  const firstTool = tools.find(tool => tool && (tool.name || tool.function?.name)) || tools[0];
  const names = tools.map(tool => tool?.name || tool?.function?.name).filter(Boolean);
  if (options.provider === 'deepseek') {
    return [
      `Tool format: ${dialect.open}${buildToolExample(firstTool, options)}${dialect.close}`,
      `Allowed names: ${names.join(', ')}`,
      'Use a JSON object for arguments and exact schema keys.',
    ].join('\n');
  }
  const lines = [
    'ZPROXY_TOOL_FORMAT_REMINDER:',
    `Use ${dialect.open}...${dialect.close} for a tool call.`,
    `Payload must be valid JSON: ${buildToolExample(firstTool, options)}`,
    `Allowed names: ${names.join(', ')}`,
    '"arguments" must be a JSON object. Tool results already appear in the history.',
  ];
  // Qwen 路线：追加反幻觉提醒 + 格式拦截最终警告（近因提示，最高优先级）
  // 模型在长上下文下注意力会从第一条消息逐渐漂移，此处在响应前最后位置
  // 注入强力警告，确保模型在生成工具调用前看到这条指令。
  if (options.provider === 'qwen') {
    lines.push(
      '',
      'FINAL WARNING — READ BEFORE RESPONDING:',
      'Qwen platform WILL intercept any JSON tool_calls format in your output.',
      'If you output JSON tool_calls, the platform WILL return "Tool X does not exists".',
      'THE ONLY SAFE FORMAT IS XML: <tool_invoke>{"name":"X","arguments":{...}}</tool_invoke>',
      'If you see "Tool X does not exists" — STOP all tool calls. Switch to pure text ONLY.'
    );
  }
  return lines.join('\n');
};

const serializePromptMessageRecord = ({ index, role, content }) => stringifyPromptJson({
  index, role: role || 'user', content: content == null ? '' : String(content),
});

const serializeToolResultForPrompt = ({ toolCallId, name, content }) => {
  const payload = stringifyPromptJson({
    tool_call_id: toolCallId || '', name: name || 'tool',
    content: content == null ? '' : String(content),
  });
  return `${TOOL_RESPONSE_OPEN}>\n${payload}\n${TOOL_RESPONSE_CLOSE}`;
};
const INTERNAL_OPEN_PREFIXES = Object.freeze([
  TOOL_CALL_OPEN,
  TOOL_INVOKE_OPEN,
  TOOL_USE_OPEN,
  TOOL_CALLS_OPEN,  // Codex CLI 原生格式（复数）
  TOOL_RESPONSE_OPEN,
  '<tool_result',
  '<｜dsml｜tool_calls',
  '<｜dsml｜calls',
  '<｜dsml｜invoke',
  '<｜｜dsml｜｜tool_calls',
  '<｜｜dsml｜｜calls',
  '<｜｜dsml｜｜invoke',
  '<|dsml|tool_calls',
  '<|dsml|calls',
  '<|dsml|invoke',
  '<||dsml||tool_calls',
  '<||dsml||calls',
  '<||dsml||invoke',
  '<｜dsml｜',
  '<｜｜dsml｜｜',
  '<|dsml|',
  '<||dsml||',
  DOLLAR_TOOL_CALL_OPEN,
  `user:${TOOL_RESPONSE_OPEN}`,
  `user: ${TOOL_RESPONSE_OPEN}`,
  `assistant:${TOOL_RESPONSE_OPEN}`,
  `assistant: ${TOOL_RESPONSE_OPEN}`,
  `tool:${TOOL_RESPONSE_OPEN}`,
  `tool: ${TOOL_RESPONSE_OPEN}`
].map(s => s.toLowerCase()));
const INTERNAL_OPEN_PREFIX_MAX = INTERNAL_OPEN_PREFIXES.reduce((max, s) => Math.max(max, s.length), 0);

const findToolResponseOpen = (text) => {
  if (typeof text !== 'string' || text.length === 0) return null;

  const lower = text.toLowerCase();
  const marker = TOOL_RESPONSE_OPEN.toLowerCase();
  let markerIdx = -1;
  let searchFrom = 0;

  while (searchFrom < text.length) {
    markerIdx = lower.indexOf(marker, searchFrom);
    if (markerIdx === -1) return null;
    const next = text[markerIdx + marker.length];
    if (!next || /[\s>/]/.test(next)) break;
    searchFrom = markerIdx + marker.length;
  }

  let start = markerIdx;
  const before = text.slice(0, markerIdx);
  const roleMatch = before.match(/(?:^|[\r\n])([ \t]*(?:user|assistant|tool):[ \t]*)$/i);
  if (roleMatch) {
    start = markerIdx - roleMatch[1].length;
  } else {
    const whitespaceMatch = before.match(/(?:^|[\r\n])([ \t]*)$/);
    if (whitespaceMatch) {
      start = markerIdx - whitespaceMatch[1].length;
    }
  }

  return { start, markerIdx };
};

const TOOL_CALL_OPEN_RE = /<(?:tool_call|[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*invoke)(?![\w-])(?:\s+[^>]*)?>/i;
const TOOL_CALLS_OPEN_RE = /<(?:tool_calls|[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|calls))(?:\s+[^>]*)?>/i;
const TOOL_CALL_CLOSE_RE = /<\/(?:tool_call|[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*invoke)\s*>/i;
const TOOL_CALLS_CLOSE_RE = /<\/(?:tool_calls|[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|calls))\s*>/i;
const DOLLAR_TOOL_CALL_OPEN_RE = /\$\s*tool_call\s*\$/i;
const DOLLAR_TOOL_CALL_CLOSE_RE = /\$\s*\/tool_call\s*\$/i;
// <tool_invoke> 别名正则（绕过 Qwen Web 上游拦截）
const TOOL_INVOKE_OPEN_RE = /<tool_invoke(?![\w-])(?:\s+[^>]*)?>/i;
const TOOL_INVOKE_CLOSE_RE = /<\/tool_invoke>/i;
// <tool_use> Anthropic 原生格式（兜底兼容：模型可能因混淆而输出此格式）
const TOOL_USE_OPEN_RE = /<tool_use(?![\w-])(?:\s+[^>]*)?>/i;
const TOOL_USE_CLOSE_RE = /<\/tool_use>/i;
// 部分工具标签正则:匹配文本尾部可能是带属性的工具标签起始部分(尚未收到 '>')。
const PARTIAL_TOOL_TAG_TAIL_RE = /<(?:tool_call|tool_invoke|tool_use|tool_calls|tool_response|tool_result|[｜|]{1,2}\s*DSML[^<>]*|[｜|]{1,2}[^<>]*)?$/i;

const findFirstInternalBlockOpen = (text) => {
  if (typeof text !== 'string' || text.length === 0) return null;

  const callMatch = text.match(TOOL_CALL_OPEN_RE);
  const invokeMatch = text.match(TOOL_INVOKE_OPEN_RE);
  const useMatch = text.match(TOOL_USE_OPEN_RE);
  const callsMatch = text.match(TOOL_CALLS_OPEN_RE);
  const dollarCallMatch = text.match(DOLLAR_TOOL_CALL_OPEN_RE);
  const response = findToolResponseOpen(text);

  // 找出最早出现的内部块
  const candidates = [];
  if (callMatch) candidates.push({ type: 'tool_call', start: callMatch.index, markerIdx: callMatch.index, matchLen: callMatch[0].length });
  if (invokeMatch) candidates.push({ type: 'tool_call', start: invokeMatch.index, markerIdx: invokeMatch.index, matchLen: invokeMatch[0].length });
  if (useMatch) candidates.push({ type: 'tool_call', start: useMatch.index, markerIdx: useMatch.index, matchLen: useMatch[0].length });
  if (callsMatch) candidates.push({ type: 'tool_calls', start: callsMatch.index, markerIdx: callsMatch.index, matchLen: callsMatch[0].length });
  if (dollarCallMatch) candidates.push({ type: 'dollar_tool_call', start: dollarCallMatch.index, markerIdx: dollarCallMatch.index, matchLen: dollarCallMatch[0].length });
  if (response) candidates.push({ type: 'tool_response', start: response.start, markerIdx: response.markerIdx, matchLen: TOOL_RESPONSE_OPEN.length });

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.start - b.start);
  return candidates[0];
};

const stripToolResponseBlocks = (fullText) => {
  if (typeof fullText !== 'string' || fullText.length === 0) return fullText || '';
  if (!fullText.toLowerCase().includes(TOOL_RESPONSE_OPEN)) return fullText;

  let text = fullText;
  let out = '';
  const closeLower = TOOL_RESPONSE_CLOSE.toLowerCase();

  while (text.length > 0) {
    const found = findToolResponseOpen(text);
    if (!found) {
      out += text;
      break;
    }

    out += text.slice(0, found.start);
    const afterOpen = found.markerIdx + TOOL_RESPONSE_OPEN.length;
    const rest = text.slice(afterOpen);
    const closeRel = rest.toLowerCase().indexOf(closeLower);
    if (closeRel === -1) {
      break;
    }

    text = rest.slice(closeRel + TOOL_RESPONSE_CLOSE.length);
    if (out.endsWith('\n') && text.startsWith('\n')) {
      text = text.slice(1);
    }
  }

  return out
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
};

const stripToolCallBlocks = (fullText) => {
  if (typeof fullText !== 'string' || fullText.length === 0) return fullText || '';
  if (!/<tool(?:_call|_invoke)[\w-]*(?:\s|>)/.test(fullText)) return fullText;

  return fullText
    .replace(/(^|[\r\n])[ \t]*(?:(?:assistant|user|tool):[ \t]*)?<tool(?:_call|_invoke)[\w-]*(?:\s[^>]*)?>[\s\S]*?<\/tool(?:_call|_invoke)[\w-]*>[ \t]*(?=\r?\n|$)?/gi, '$1')
    .replace(/<tool(?:_call|_invoke)[\w-]*(?:\s[^>]*)?>[\s\S]*?<\/tool(?:_call|_invoke)[\w-]*>/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
};

/**
 * 解析 Codex CLI 原生 <tool_calls> 格式
 *
 * Codex CLI 发送给上游的 prompt 中包含完整的工具调用示例，模型有时会
 * 直接输出 Codex 原生格式而非我们注入的 <tool_call> 单数格式：
 *
 *   <tool_calls>
 *     <invoke name="shell_command">
 *     <parameter name="command" string="true">hostname</parameter>
 *     <parameter name="justification" string="true">测试shell命令</parameter>
 *     </invoke>
 *   </tool_calls>
 *
 * 本函数将其转换为标准 OpenAI tool_calls 格式。
 *
 * @param {string} fullText - 模型完整输出
 * @returns {{ cleanedText: string, toolCalls: Array<Object> }}
 */
const parseCodexToolCallsFromText = (fullText) => {
  const empty = { cleanedText: fullText || '', toolCalls: [] };
  if (typeof fullText !== 'string' || fullText.length === 0) return empty;
  if (!/<(?:tool_calls|[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|calls))[\s>]|[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*invoke/i.test(fullText)) return empty;

  const toolCalls = [];
  const blockRe = /<(?:tool_calls|[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|calls))\s*>([\s\S]*?)<\/(?:tool_calls|[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*(?:tool_calls|calls))\s*>/gi;
  let cleanedText = fullText;

  const processInner = (inner) => {
    const invokeRe = /(?:<)?(?:[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*)?invoke\s+name\s*=\s*["']([^"']+)["'](?:\s*\/\s*>|[^>]*>([\s\S]*?)(?:<\/(?:[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*)?invoke\s*>))/gi;
    let invokeMatch;
    while ((invokeMatch = invokeRe.exec(inner)) !== null) {
      const toolName = invokeMatch[1];
      const invokeInner = invokeMatch[2] || '';

      const args = {};
      const paramRe = /<(?:[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*)?parameter\s+name\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*)?parameter\s*>/gi;
      let paramMatch;
      while ((paramMatch = paramRe.exec(invokeInner)) !== null) {
        const paramName = paramMatch[1];
        let paramValue = paramMatch[2].trim();

        if (paramValue === 'true') paramValue = true;
        else if (paramValue === 'false') paramValue = false;
        else if (/^-?\d+$/.test(paramValue)) paramValue = parseInt(paramValue, 10);
        else if (/^-?\d+\.\d+$/.test(paramValue)) paramValue = parseFloat(paramValue);
        else {
          try {
            paramValue = JSON.parse(paramValue);
          } catch (_) {}
        }

        args[paramName] = paramValue;
      }

      if (toolName) {
        toolCalls.push({
          index: toolCalls.length,
          id: `call_${generateUUID().replace(/-/g, '').slice(0, 24)}`,
          type: 'function',
          function: {
            name: toolName,
            arguments: normalizeArgumentsToJson(args),
          },
        });
      }
    }
  };

  cleanedText = cleanedText.replace(blockRe, (blockMatch, inner) => {
    processInner(inner);
    return '';
  });

  if (toolCalls.length === 0 && /[｜|]{1,2}\s*DSML\s*[｜|]{1,2}/i.test(cleanedText)) {
    processInner(cleanedText);
    cleanedText = cleanedText.replace(/(?:<)?(?:[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*)?invoke[\s\S]*?(?:<\/(?:[｜|]{1,2}\s*DSML\s*[｜|]{1,2}\s*)?invoke\s*>)/gi, '');
  }

  return { cleanedText: cleanedText.trim(), toolCalls };
};

const stripInternalToolBlocks = (fullText) => stripToolCallBlocks(stripToolResponseBlocks(fullText));

/**
 * 转义 XML 文本内容中的特殊字符
 * @param {string} value - 原始字符串
 * @returns {string} 转义后的字符串
 */
const escapeXml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * 构建工具定义的 XML 表示
 *
 * 将 Anthropic/OpenAI 工具定义转换为结构化 XML，让模型清晰理解每个工具
 * 的名称、描述、参数类型、是否必填等信息。XML 格式与输出格式一致，
 * 便于模型建立 1:1 映射。
 *
 * @param {Array<Object>} tools - OpenAI 风格工具定义列表
 * @returns {string} XML 格式的工具定义
 */
const buildToolDefinitionsXml = (tools) => {
  if (!Array.isArray(tools) || tools.length === 0) return '';

  const parts = [];
  for (const tool of tools) {
    const fn = tool?.function || tool;
    const name = fn?.name || 'unknown';
    const desc = (fn?.description || '').trim();
    const params = fn?.parameters || fn?.input_schema || {};
    const props = params?.properties || {};
    const required = new Set(Array.isArray(params?.required) ? params.required : []);

    const lines = [];
    lines.push(`  <tool name="${escapeXml(name)}">`);
    if (desc) {
      lines.push(`    <description>${escapeXml(desc)}</description>`);
    }

    const propEntries = Object.entries(props);
    if (propEntries.length > 0) {
      lines.push('    <parameters>');
      for (const [key, schema] of propEntries) {
        const type = schema?.type || 'string';
        const isRequired = required.has(key);
        const reqAttr = isRequired ? 'true' : 'false';
        const paramDesc = (schema?.description || '').trim();
        const enumValues = Array.isArray(schema?.enum) ? schema.enum : null;

        let attrStr = `name="${escapeXml(key)}" required="${reqAttr}" type="${escapeXml(String(type))}"`;
        if (enumValues) {
          attrStr += ` enum="${escapeXml(enumValues.map(v => String(v)).join('|'))}"`;
        }

        if (paramDesc) {
          lines.push(`      <parameter ${attrStr}>${escapeXml(paramDesc)}</parameter>`);
        } else {
          lines.push(`      <parameter ${attrStr}/>`);
        }
      }
      lines.push('    </parameters>');
    }
    lines.push('  </tool>');

    parts.push(lines.join('\n'));
  }

  return `<tool_definitions>\n${parts.join('\n\n')}\n</tool_definitions>`;
};

/**
 * 将 JSON Schema 类型压缩为简短 TypeScript 风格签名
 * （保留用于向后兼容和非 XML 格式场景）
 * @param {Object} schema - JSON Schema 节点
 * @returns {string} TS 风格类型表示
 */
const compressSchemaType = (schema) => {
  if (!schema || typeof schema !== 'object') {
    return 'any';
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map(value => JSON.stringify(value)).join(' | ');
  }

  const type = schema.type;

  if (type === 'array') {
    const itemType = compressSchemaType(schema.items);
    return `${itemType}[]`;
  }

  if (type === 'object') {
    if (!schema.properties || typeof schema.properties !== 'object') {
      return 'object';
    }
    const requiredKeys = new Set(Array.isArray(schema.required) ? schema.required : []);
    const fields = Object.entries(schema.properties).map(([key, value]) => {
      const optional = requiredKeys.has(key) ? '' : '?';
      // 保留 per-property description：截断到 80 字符，换行替换为空格，
      // 作为行内注释追加到字段签名后，让模型明确各字段取值语义。
      let desc = '';
      if (value && typeof value.description === 'string') {
        desc = value.description.replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
      }
      return `${key}${optional}: ${compressSchemaType(value)}${desc ? '  // ' + desc : ''}`;
    });
    return `{ ${fields.join('; ')} }`;
  }

  if (Array.isArray(type)) {
    return type.map(t => compressSchemaType({ ...schema, type: t })).join(' | ');
  }

  return type || 'any';
};

/**
 * 将单个工具定义压缩为 TS 风格签名
 * @param {Object} tool - OpenAI 工具定义
 * @returns {string} 压缩后的工具描述
 */
const compressToolDefinition = (tool) => {
  const fn = tool?.function || tool;
  const name = fn?.name || 'unknown';
  const description = (fn?.description || '').trim();
  // 兼容 Responses API 格式（input_schema）和 Chat completions 格式（parameters）
  const params = fn?.parameters || fn?.input_schema || { type: 'object', properties: {} };
  const signature = compressSchemaType(params);

  if (description) {
    return `- ${name}${signature}\n  ${description}`;
  }
  return `- ${name}${signature}`;
};

/**
 * Build the deliberately small tool contract used by DeepSeek Web.
 *
 * DeepSeek Web receives tools as part of a plain-text prompt. Replaying the
 * full XML schema and the harness policy text on every turn costs context and
 * encourages the model to discuss protocol rules instead of doing the task.
 * Keep only the information needed to emit a valid call.
 */
const buildDeepSeekToolSignature = (tool) => {
  const fn = tool?.function || tool || {};
  const name = String(fn.name || tool?.name || 'tool').replace(/[\r\n]/g, ' ').trim();
  const params = fn.parameters || fn.input_schema || {};
  const props = params && typeof params === 'object' && params.properties && typeof params.properties === 'object'
    ? params.properties
    : {};
  const required = new Set(Array.isArray(params.required) ? params.required : []);
  const fields = Object.entries(props).map(([key, schema]) => {
    const type = Array.isArray(schema?.type)
      ? schema.type.filter(Boolean).join('|')
      : (schema?.type || (schema?.properties ? 'object' : 'any'));
    const marker = required.has(key) ? '!' : '?';
    const enumText = Array.isArray(schema?.enum) && schema.enum.length > 0
      ? `=${schema.enum.slice(0, 4).map(value => String(value).replace(/[\r\n]/g, ' ')).join('|')}`
      : '';
    return `${key}${marker}:${type}${enumText}`;
  });
  const description = String(fn.description || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `- ${name}(${fields.join(', ')})${description ? ` - ${description}` : ''}`;
};

const buildDeepSeekToolSystemPrompt = (tools, options = {}) => {
  if (!Array.isArray(tools) || tools.length === 0) return '';

  const dialect = getToolDialect('deepseek');
  const firstTool = tools.find(tool => tool && (tool.name || tool.function?.name)) || tools[0];
  const example = buildToolExample(firstTool, { provider: 'deepseek' });
  const hasAgentWebSearch = options.preferAgentSearch
    && tools.some(tool => /^web[_-]?search$/i.test(String(tool?.function?.name || tool?.name || '').trim()));
  const lines = [
    'ZPROXY_DEEPSEEK_TOOLS_V1',
    'Available tools (use exact names and argument keys):',
    ...tools.map(buildDeepSeekToolSignature),
    '',
    `When a tool is needed, output only ${dialect.open}${example}${dialect.close}.`,
    'The payload must be valid JSON; required fields are marked with !.',
    'Do not add prose in the same turn as a tool call. If no tool is needed, answer normally.',
  ];

  if (hasAgentWebSearch) {
    lines.push(
      '',
      'Agent search routing:',
      '`web_search` is provided by the Agent harness. For any search or research request, call this Agent tool with its declared arguments.',
      'DeepSeek native web search is disabled for this request. Do not claim that the Agent cannot search and do not use a native DeepSeek search feature.',
    );
  }

  if (options.disableParallelToolUse) {
    lines.push('Emit at most one tool call in this turn.');
  }
  if (options.tool_choice === 'required') {
    lines.push('A tool call is required in this turn.');
  } else if (options.tool_choice && typeof options.tool_choice === 'object' && options.tool_choice.function?.name) {
    lines.push(`Call ${String(options.tool_choice.function.name)} in this turn.`);
  }

  return lines.join('\n');
};

/**
 * 构建工具调用提示词（反代中转层）
 *
 * 职责：只提供工具列表（让模型知道有哪些工具可用）+ prompt 模拟提示
 *       （告诉模型用文本输出工具调用，不要用原生 function call）。
 * 格式指令由 harness 的 system prompt 主导，反代层不注入任何格式约束。
 *
 * @param {Array<Object>} tools - OpenAI 风格工具定义列表
 * @param {Object} [options] - 可选参数
 * @param {string|Object} [options.tool_choice] - tool_choice 语义（required/具体工具/auto）
 * @returns {string} 工具调用系统提示词
 */
const buildToolSystemPrompt = (tools, options = {}) => {
  if (!Array.isArray(tools) || tools.length === 0) {
    return '';
  }

  // DeepSeek Web has no native tool schema channel. A short, single-format
  // contract is more reliable than replaying the generic/Qwen policy prompt.
  if (options.provider === 'deepseek') {
    return buildDeepSeekToolSystemPrompt(tools, options);
  }

  // provider 区分：Qwen Web 上游会拦截 <tool_call> 触发原生 function_call，
  // 必须使用 <tool_invoke> 别名绕过。DeepSeek 无此限制，使用 <tool_call>。
  const provider = options.provider || 'default';
  const dialect = getToolDialect(provider);
  const tagOpen = dialect.open;
  const tagClose = dialect.close;

  // 工具定义的 XML 表示（完整参数描述、类型、必填/可选）
  // 保留完整 XML 定义：模型需要完整的参数信息才能正确构造调用
  const xmlDefs = buildToolDefinitionsXml(tools);

  const toolNameList = tools
    .map(t => (t && (t.name || t.function?.name)) || '')
    .filter(Boolean);

  const firstTool = tools.find(t => t && (t.name || t.function?.name)) || tools[0];
  const examplePayload = buildToolExample(firstTool, options);

  // 格式说明：只告诉模型用 <tool_call> 文本格式输出（CLAUDE.md L106-111 例外要求）
  // 不使用 SYSTEM OVERRIDE / TAKES PRECEDENCE 等强制措辞（CLAUDE.md L136 禁止注入
  // 与 harness 冲突的严格规则）。强制语气会干扰模型对格式的判断，多轮后反而
  // 导致模型输出 <tool name="..."> 等混淆格式。
  // Qwen 路线禁用内部工具指令：Qwen Studio 内置的 Code Interpreter、Document Processing
  // 等工具会干扰 harness 的工具调用，必须明确禁用。
  const antiInternalTools = options.provider === 'qwen' ? [
    '',
    '### CRITICAL: Platform Tool Restrictions',
    '',
    'This proxy runs on Qwen Web. The platform has built-in tools (Code Interpreter, Document Processing,',
    'Web Search, Image Generation, etc.) that are NOT compatible with this harness.',
    '',
    '1. **DO NOT use any Qwen platform built-in tools.** This includes: code_interpreter, document_processing,',
    '   web_search, image_generation, and any other Qwen Studio native tools.',
    '2. **ONLY use the tools explicitly listed above.** These are the harness tools provided by your system prompt.',
    '3. **If you need a capability that is not in the list above, respond in natural language** explaining what',
    '   you need rather than attempting to use a platform tool.',
    '4. **NEVER invent or hallucinate tool names.** You may ONLY call tools from the list above.',
    '   Forbidden tool names include (but are not limited to): write_file, read_file, terminal,',
    '   search_file, list_files, edit_file, run_command, execute, bash, shell, python, code_interpreter.',
    '   If you try to call a tool not in the list, the request will fail.',
    '',
    '### Context Compression Rules',
    '',
    'When compressing or summarizing conversation context (e.g., via tools that manage context),',
    'observe these strict rules:',
    '1. **NEVER compress or remove the harness system prompt** — this includes: system prompts, tool',
    '   definitions, skill definitions, MCP configurations, sub-agent definitions, and memory instructions.',
    '2. **Only compress conversation content** — user messages and assistant replies are the only parts',
    '   that may be summarized or truncated.',
    '3. **Tool definitions are part of the system prompt** — do not fold, shorten, or remove them.',
    '4. **If in doubt, preserve** — it is better to keep more context than to lose essential instructions.',
  ] : [];

  const lines = [
    xmlDefs,
    '',
    `To call a tool, output a ${tagOpen} block containing a JSON object:`,
    '',
    tagOpen,
    examplePayload,
    tagClose,
    '',
    ...antiInternalTools,
    'Notes:',
    '1. Tool names: ' + toolNameList.map(n => `"${n}"`).join(', '),
    '2. The JSON object MUST contain "name" (string) and "arguments" (object)',
    '3. Required parameters from the tool definition MUST be included',
    '4. Close the block with ' + tagClose,
    '5. Tool results arrive as <tool_response> blocks in the next turn',
  ];

  // tool_choice 语义（由 harness 通过 API 参数传递，不是格式约束）
  const choice = options.tool_choice;
  if (choice === 'required') {
    lines.push('', 'You MUST call at least one tool in this turn.');
  } else if (choice && typeof choice === 'object' && choice.function?.name) {
    lines.push('', `You MUST call "${choice.function.name}" in this turn.`);
  }

  return lines.filter(Boolean).join('\n');
};

/**
 * 构建 Hermes Agent 专用工具调用系统提示词
 *
 * Hermes 本身会在 system 消息中注入自己的一套工具使用指南（TOOL_USE_ENFORCEMENT_GUIDANCE 等）。
 * 本模块只需要告诉模型三件事：
 *   1. 当前可用的工具列表
 *   2. 输出时必须使用 <tool_call> XML 格式（而非原生 tool_calls）
 *   3. 禁止混合自然语言和 tool_call（对齐 Hermes preferToolCallsOnly）
 *
 * 与 buildToolSystemPrompt 的区别：
 *   - 更短：不重复 Hermes 已有的指令
 *   - 更硬：明确覆盖 Hermes 的"使用原生 tool_calls"指示
 *   - 更干净：不加入 CC/Codex 等无关 profile 的规则
 *
 * @param {Array<Object>} tools - OpenAI 风格工具定义列表
 * @param {Object} [options]
 * @param {string|Object} [options.tool_choice] - tool_choice
 * @param {boolean} [options.disableParallelToolUse] - 禁用并行工具调用
 * @returns {string}
 */
const buildHermesToolSystemPrompt = (tools, options = {}) => {
  if (!Array.isArray(tools) || tools.length === 0) return '';

  // Hermes still uses the OpenAI-compatible endpoint, but DeepSeek receives a
  // plain-text prompt underneath. Reuse the concise contract so Hermes and
  // OpenCode do not teach the model two different tool dialects.
  if (options.provider === 'deepseek') {
    return buildDeepSeekToolSystemPrompt(tools, options);
  }

  // provider 方言：Qwen 用 <tool_invoke> 绕过上游原生 function_call 拦截
  const provider = options.provider || 'default';
  const dialect = getToolDialect(provider);
  const tagOpen = dialect.open;
  const tagClose = dialect.close;

  const compressed = tools
    .map(compressToolDefinition)
    .filter(Boolean)
    .join('\n');

  const toolNameList = tools
    .map(t => (t && (t.name || t.function?.name)) || '')
    .filter(Boolean)
    .map(n => `\`${n}\``)
    .join(', ');

  const choice = options.tool_choice;
  const requiredLine = choice === 'required'
    ? '- You MUST call at least one tool. No natural language response.'
    : choice && typeof choice === 'object' && choice.function?.name
      ? `- You MUST call \`${choice.function.name}\` first.`
      : '';

  // 动态提取第一个工具名作为示例（不硬编码任何工具名）
  const firstTool = tools.find(t => t && (t.name || t.function?.name));
  const firstName = firstTool?.name || firstTool?.function?.name || 'tool';
  const examplePayload = buildToolExample(firstTool, { ...options, name: firstName });

  return [
    '## System: Hermes Agent tool call format instruction (CRITICAL)',
    '',
    'This bridge describes the text format that the proxy can translate into a Hermes tool event.',
    '',
    '### Available tools (only these are callable)',
    compressed,
    '',
    toolNameList
      ? `The complete list of valid tool names is: ${toolNameList}. You may ONLY call these tools.`
      : '',
    '',
    // Qwen 路线：禁用平台内置工具
    ...(provider === 'qwen' ? [
      '',
      '### CRITICAL: Platform Tool Restrictions',
      '',
      'This proxy runs on Qwen Web. The platform has built-in tools (Code Interpreter, Document Processing,',
      'Web Search, Image Generation, etc.) that are NOT compatible with this harness.',
      '',
      '**Why your native JSON format will fail:** Qwen platform intercepts ANY JSON `tool_calls` format',
      '(your training native) and tries to execute it as a platform tool. The platform will return',
      '"Tool X does not exists" as an error string, which then leaks into your output.',
      '**The ONLY way to prevent this is to use XML `tool_invoke` format EXCLUSIVELY.**',
      '',
      '1. **DO NOT use any Qwen platform built-in tools** (code_interpreter, document_processing, etc.)',
      '2. **ONLY use the harness tools listed above.**',
      '3. **NEVER invent or hallucinate tool names.** Forbidden names include: write_file, read_file,',
      '   terminal, search_file, list_files, edit_file, run_command, execute, bash, shell, python,',
      '   mcp__* (any tool starting with mcp__). If you call a tool not in the list, the request will fail.',
      '4. **DO NOT use native JSON tool_calls format.** Even if you use correct harness tool names,',
      '   JSON format will be intercepted by Qwen platform. Always use XML format.',
      '',
      '### Context Compression Rules',
      'When compressing conversation context, **NEVER** compress the harness system prompt (system prompts,',
      'tool definitions, skills, MCP configs, sub-agent definitions, memory). Only compress conversation.',
    ] : []),
    '',
    '### Output format (MANDATORY)',
    '',
    'When a tool is needed, emit EXACTLY this format — nothing before, nothing after:',
    '',
    tagOpen,
    examplePayload,
    tagClose,
    '',
    '### Strict rules',
    '',
    `1. **XML format is mandatory.** The ONLY acceptable format is \`${tagOpen}\` with JSON inside. Do NOT use native JSON tool_calls, markdown code blocks (\`\`\`json), or any other format.`,
    `2. **No preamble text.** Do NOT say "Let me", "I will", "I need to", or any other natural language before a \`${tagOpen}\`. The tool call must be the very first output.`,
    `3. **No trailing text after tool call.** After \`${tagClose}\`, stop emitting entirely. Do NOT add explanations, summaries, or any natural language after the tool call.`,
    `4. **Tool-only or text-only, never both.** If you emit a \`${tagOpen}\`, you MUST NOT also emit natural language in the same turn. If you respond in natural language, you MUST NOT also emit a \`${tagOpen}\`.`,
    '5. **Use exact tool names.** The `name` field must exactly match one of the tool names listed above (case-sensitive).',
    `6. **Close every tag.** Every \`${tagOpen}\` must be closed with \`${tagClose}\`.`,
    `${options.disableParallelToolUse ? `7. **One tool call per turn.** Emit at most ONE ${tagOpen} block per response.` : `7. You may emit multiple ${tagOpen} blocks back-to-back when multiple independent tools are needed.`}`,
    '8. **Tool results** arrive as `<tool_response>` blocks in the next user message. After receiving one, either call another tool or a final answer.',
    '9. **Format inertia warning:** Your native training instinct is to use JSON `tool_calls`. In long conversations, attention may slip and you may revert to JSON format. This ALWAYS fails — Qwen platform intercepts JSON and returns error strings like "Tool X does not exists". Fight this instinct: use XML ONLY.',
    '10. **Error string leakage is forbidden.** If you accidentally use JSON format and the platform returns error strings (e.g., "Tool X does not exists"), do NOT echo or repeat those error strings in your output. Switch to pure text response instead.',
    '',
    requiredLine,
    '### Correct example',
    '',
    tagOpen,
    examplePayload,
    tagClose,
    '',
    '### Wrong (will be rejected)',
    '- `Let me check that file...` followed by a tool call — preamble is forbidden.',
    `- \`{"name":"${firstName}","arguments":{}}\` without \`${tagOpen}\` tags — bare JSON is not parsed.`,
    `- Natural language AFTER a \`${tagOpen}\` — text after a tool call is discarded.`,
    '- A tool call and a natural language answer in the same turn — choose one or the other.',
    '- Any tool name not in the above list.',
  ].filter(Boolean).join('\n');
};

/**
 * 截断超长 tool_result 内容。
 *
 * 不对 tool_result 内容做任何截断，完整透传。
 * Claude Code harness 工具（Read/Bash 等）的返回结果需要完整保留，
 * 截断会导致模型丢失关键上下文信息。
 *
 * @param {string} content - tool_result 原始内容
 * @returns {string} 原内容（不截断）
 */
const truncateToolResultContent = (content) => {
  return content;
};

/**
 * 将历史中的 assistant tool_calls / tool 角色消息折叠成纯文本，
 * 以便上游网页接口（仅识别 user/assistant/system）能正确接收上下文。
 * 折叠时保留原始 tool_call_id，并将后续 role=tool 消息按 id 精确回链。
 * @param {Array<Object>} messages - 原始 OpenAI 风格消息数组
 * @returns {Array<Object>} 折叠后的消息数组
 */
const foldToolMessages = (messages) => {
  if (!Array.isArray(messages)) return messages;

  const callIdToName = new Map();

  return messages.map((message) => {
    if (!message || typeof message !== 'object') return message;

    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const blocks = message.tool_calls.map((call) => {
        let args = call?.function?.arguments;
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch (_) {
            // 保留原始字符串形式
          }
        }
        const name = call?.function?.name || 'unknown';
        const id = call?.id || `call_${generateUUID().replace(/-/g, '').slice(0, 24)}`;
        callIdToName.set(id, name);
        const payload = { id, name, arguments: args ?? {} };
        return `${TOOL_CALL_OPEN}\n${stringifyPromptJson(payload)}\n${TOOL_CALL_CLOSE}`;
      });
      const original = typeof message.content === 'string' ? message.content : '';
      return {
        role: 'assistant',
        content: [original, blocks.join('\n')].filter(Boolean).join('\n')
      };
    }

    if (message.role === 'tool') {
      const callId = message.tool_call_id || '';
      const name = message.name || callIdToName.get(callId) || 'tool';
      let content = typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message.content ?? '');
      content = truncateToolResultContent(content);
      // 兼容 DeepSeek-V4 官方 <tool_result> 与现有兼容结构
      return {
        role: 'user',
        content: `<tool_result>\n${content}\n</tool_result>`
      };
    }

    return message;
  });
};

/**
 * Fold previous protocol tool messages into plain history text for Qwen Web.
 *
 * Current-turn tool calls still use `<tool_call>` in the model output, because
 * the controllers parse that format back into OpenAI/Anthropic tool events.
 * Historical tool calls are different: replaying old `<tool_call>` blocks in
 * the prompt makes the chat backend continue or copy protocol text. Keep the
 * facts (tool id/name/arguments/result), but describe them as ordinary history.
 *
 * @param {Array<Object>} messages - OpenAI-style messages
 * @returns {Array<Object>} Messages safe to pass into parserMessages()
 */
const foldToolMessagesForChatBackend = (messages) => {
  if (!Array.isArray(messages)) return messages;

  const callIdToName = new Map();

  return messages.map((message) => {
    if (!message || typeof message !== 'object') return message;

    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      const lines = [];
      const original = typeof message.content === 'string' ? message.content : '';
      if (original) lines.push(original);

      for (const call of message.tool_calls) {
        let args = call?.function?.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch (_) { /* keep original string */ }
        }
        const name = call?.function?.name || 'unknown';
        const id = call?.id || `call_${generateUUID().replace(/-/g, '').slice(0, 24)}`;
        callIdToName.set(id, name);
        lines.push(`ZPROXY_TOOL_CALL_HISTORY:${stringifyPromptJson({ id, name, arguments: args ?? {} })}`);
      }

      return {
        role: 'assistant',
        content: lines.join('\n')
      };
    }

    if (message.role === 'tool') {
      const callId = message.tool_call_id || '';
      const name = message.name || callIdToName.get(callId) || 'tool';
      const content = truncateToolResultContent(
        typeof message.content === 'string'
          ? message.content
          : JSON.stringify(message.content ?? '')
      );
      return {
        role: 'user',
        content: `ZPROXY_TOOL_RESULT_HISTORY:${stringifyPromptJson({ tool_call_id: callId, name, content })}`
      };
    }

    return message;
  });
};

const appendTextToContent = (content, text) => {
  const suffix = String(text || '').trim();
  if (!suffix) return content;

  if (typeof content === 'string') {
    return `${content}\n\n${suffix}`;
  }

  if (Array.isArray(content)) {
    const next = content.map(item => (item && typeof item === 'object') ? { ...item } : item);
    const textIdx = next.findIndex(item => item && item.type === 'text');
    if (textIdx >= 0) {
      next[textIdx] = {
        ...next[textIdx],
        text: `${next[textIdx].text || ''}\n\n${suffix}`
      };
      return next;
    }
    next.unshift({ type: 'text', text: suffix });
    return next;
  }

  return suffix;
};

const appendToolReminderToLastUser = (messages, reminder) => {
  if (!Array.isArray(messages) || !reminder) return messages;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== 'user') continue;
    message.content = appendTextToContent(message.content, reminder);
    return messages;
  }
  messages.push({ role: 'user', content: reminder });
  return messages;
};

/**
 * Append a correction hint to the already-normalized Qwen Web request body.
 *
 * At this stage the body has gone through parserMessages(), so adding a new
 * `role: system` message creates a malformed Qwen Web prompt. Merge the hint
 * into the final visible user message instead.
 *
 * @param {Object} body - Internal Qwen request body
 * @param {string} hint - Retry/correction hint
 * @returns {Object} Cloned body with the hint appended
 */
const appendHintToLastMessage = (body, hint) => {
  const suffix = String(hint || '').trim();
  if (!body || typeof body !== 'object' || !suffix) return body;

  const messages = Array.isArray(body.messages) ? body.messages.map(msg => ({ ...msg })) : [];
  if (messages.length === 0) {
    return {
      ...body,
      messages: [{ role: 'user', content: suffix }]
    };
  }

  const idx = messages.length - 1;
  messages[idx] = {
    ...messages[idx],
    content: appendTextToContent(messages[idx].content, `Tool correction for this retry:\n${suffix}`)
  };

  return {
    ...body,
    messages
  };
};

/**
 * 转义 XML 属性中的特殊字符
 * @param {string} value - 原始字符串
 * @returns {string} 转义后的字符串
 */
const escapeAttr = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/"/g, '&quot;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

/**
 * 折叠参数名用于模糊匹配：filePath / file_path / file-path → filepath
 * @param {string} key
 * @returns {string}
 */
const collapseArgKey = (key) => String(key || '').replace(/[_-]/g, '').toLowerCase();

/**
 * 常见别名（折叠后）→ 目标 schema 键的折叠名提示
 * 实际映射仍以工具 schema 的 properties 为准。
 */
const ARG_KEY_ALIAS_COLLAPSED = Object.freeze({
  filepath: 'filepath',
  file: 'filepath',
  path: 'filepath',
  filename: 'filepath',
  targetfile: 'filepath',
  targetpath: 'filepath',
  workingdirectory: 'workdir',
  workingdir: 'workdir',
  workdirectory: 'workdir',
  cwd: 'workdir',
  dir: 'workdir',
  directory: 'workdir',
  // bash / shell — OpenCode 实测 Missing key ["command"]
  cmd: 'command',
  shellcommand: 'command',
  shellcmd: 'command',
  script: 'command',
  input: 'command',
  query: 'command',
  code: 'command',
  line: 'command',
  exec: 'command',
  execute: 'command',
  run: 'command',
  bash: 'command',
  shell: 'command',
  powershell: 'command',
  pwsh: 'command',
  arg: 'command',
  args: 'command',
  content: 'content',
  text: 'content',
  body: 'content',
  data: 'content',
  newstring: 'newString',
  oldstring: 'oldString',
  oldtext: 'oldString',
  newtext: 'newString',
});

/**
 * 把模型输出的参数键对齐到工具 JSON Schema properties
 * 解决 OpenCode 报错：Missing key ["filePath"] / ["command"]
 *
 * 匹配优先级：
 *  1) 完全等于 schema 键
 *  2) 大小写不敏感
 *  3) 去下划线/连字符后相等（file_path → filePath）
 *  4) 常见别名表
 *  5) 若 schema 有 command/filePath 等主字符串字段仍缺失：
 *     把「未识别键里最长的字符串值」或「唯一字符串值」填进去
 *
 * @param {Object} args
 * @param {Object} properties - schema.properties
 * @param {Object} [schemaMeta] - { required?: string[] }
 * @returns {Object}
 */
const alignArgumentKeysToSchema = (args, properties, schemaMeta = {}) => {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  if (!properties || typeof properties !== 'object') return { ...args };

  const propNames = Object.keys(properties);
  if (propNames.length === 0) return { ...args };

  const propSet = new Set(propNames);
  const byLower = new Map(propNames.map((p) => [p.toLowerCase(), p]));
  const byCollapsed = new Map(propNames.map((p) => [collapseArgKey(p), p]));

  const out = {};
  const unmatchedStrings = [];

  for (const [rawKey, value] of Object.entries(args)) {
    if (propSet.has(rawKey)) {
      if (out[rawKey] === undefined) out[rawKey] = value;
      continue;
    }

    let mapped = byLower.get(String(rawKey).toLowerCase()) || null;
    if (!mapped) mapped = byCollapsed.get(collapseArgKey(rawKey)) || null;

    if (!mapped) {
      const aliasTarget = ARG_KEY_ALIAS_COLLAPSED[collapseArgKey(rawKey)];
      if (aliasTarget) {
        mapped = byCollapsed.get(collapseArgKey(aliasTarget)) || null;
      }
    }

    if (mapped) {
      if (out[mapped] === undefined) out[mapped] = value;
    } else {
      // 暂存：后面可能提升为缺失的 required 字符串字段
      if (typeof value === 'string' && value.trim()) {
        unmatchedStrings.push({ key: rawKey, value });
      } else if (out[rawKey] === undefined) {
        out[rawKey] = value;
      }
    }
  }

  // 兜底：command / filePath / content 等主字段仍缺时，用未匹配的最长字符串填入
  const required = Array.isArray(schemaMeta.required) ? schemaMeta.required : [];
  const preferFill = [];
  for (const name of ['command', 'filePath', 'content', 'path', 'query', 'pattern']) {
    if (propSet.has(name)) preferFill.push(name);
  }
  for (const name of required) {
    if (propSet.has(name) && !preferFill.includes(name)) preferFill.push(name);
  }
  for (const name of propNames) {
    if (!preferFill.includes(name) && properties[name]?.type === 'string') preferFill.push(name);
  }

  /**
   * workdir/path 类字段只接受「像路径」的值，拒绝把整段 command JSON 塞进去
   * 实测故障：workdir = '({"command":"Test-Path ..."})' → OpenCode NotFound 乱路径
   */
  const looksLikePathValue = (value) => {
    const s = String(value || '').trim();
    if (!s || s.length > 512) return false;
    if (s.startsWith('{') || s.startsWith('[') || s.includes('"command"')) return false;
    if (/\n/.test(s)) return false;
    // 盘符路径 / UNC / 相对路径 / 简单目录名
    if (/^[a-zA-Z]:[\\/]/.test(s)) return true;
    if (s.startsWith('\\\\') || s.startsWith('/') || s.startsWith('./') || s.startsWith('../')) return true;
    if (/^[\w.-]+(?:[\\/][\w.-]+)*\\?$/.test(s) && s.length < 200) return true;
    return false;
  };

  const looksLikeCommandValue = (value) => {
    const s = String(value || '').trim();
    if (!s) return false;
    if (s.startsWith('{') && s.includes('command')) return false; // 整段 JSON 不当 command 原文（应先 parse）
    return s.length > 0;
  };

  if (unmatchedStrings.length > 0) {
    unmatchedStrings.sort((a, b) => b.value.length - a.value.length);
    let ui = 0;
    for (const dest of preferFill) {
      if (out[dest] !== undefined && out[dest] !== null && String(out[dest]).length > 0) continue;
      const propType = properties[dest]?.type;
      if (propType && propType !== 'string' && !Array.isArray(propType)) continue;
      if (ui >= unmatchedStrings.length) break;

      const destCollapsed = collapseArgKey(dest);
      const isPathField = /^(workdir|workingdirectory|cwd|dir|directory|filepath|path|filename)$/i.test(destCollapsed)
        || destCollapsed.includes('path')
        || destCollapsed.includes('dir');
      const isCommandField = destCollapsed === 'command' || destCollapsed === 'cmd';

      // 为 dest 找第一个「类型合适」的未匹配字符串
      let picked = -1;
      for (let j = ui; j < unmatchedStrings.length; j++) {
        const cand = unmatchedStrings[j].value;
        if (isPathField && !looksLikePathValue(cand)) continue;
        if (isCommandField && !looksLikeCommandValue(cand)) continue;
        if (isPathField && looksLikeCommandValue(cand) && !looksLikePathValue(cand)) continue;
        picked = j;
        break;
      }
      if (picked < 0) continue;
      // swap picked to ui position conceptually
      const chosen = unmatchedStrings[picked];
      unmatchedStrings.splice(picked, 1);
      out[dest] = chosen.value;
    }
    // 剩余未匹配键原样保留（调试用，一般 harness 会忽略额外键）
    for (const { key, value } of unmatchedStrings) {
      if (out[key] === undefined) out[key] = value;
    }
  }

  // 二次清理：若 workdir 已被污染成 JSON/命令，删掉让 harness 用默认 cwd
  for (const key of Object.keys(out)) {
    const collapsed = collapseArgKey(key);
    if ((collapsed.includes('workdir') || collapsed === 'cwd' || collapsed === 'workingdirectory')
      && !looksLikePathValue(out[key])) {
      delete out[key];
    }
  }

  return out;
};

/** 模型常把 bash 叫成 shell / run / terminal … */
const TOOL_NAME_ALIASES = Object.freeze({
  shell: ['bash', 'shell', 'run_terminal_cmd', 'run', 'terminal', 'powershell', 'pwsh', 'cmd'],
  bash: ['bash', 'shell', 'run_terminal_cmd', 'run', 'terminal', 'powershell', 'pwsh', 'cmd'],
  run: ['bash', 'shell', 'run'],
  terminal: ['bash', 'shell', 'terminal'],
  write_file: ['write', 'write_file'],
  write: ['write', 'write_file'],
  read_file: ['read', 'read_file'],
  read: ['read', 'read_file'],
});

/**
 * 在 tools 列表里解析真实工具名（大小写 + 别名）
 * @param {Array} tools
 * @param {string} toolName
 * @returns {string|null} 列表里的真实 name
 */
const resolveToolNameFromList = (tools, toolName) => {
  if (!Array.isArray(tools) || !toolName) return null;
  const target = String(toolName).toLowerCase();
  const names = tools.map((t) => {
    const fn = t?.function || t;
    return fn?.name || t?.name || '';
  }).filter(Boolean);

  // 精确 / 大小写
  for (const n of names) {
    if (n === toolName || n.toLowerCase() === target) return n;
  }
  // 别名组：模型叫 shell，schema 里是 bash
  const aliasGroup = TOOL_NAME_ALIASES[target] || [target];
  for (const alias of aliasGroup) {
    for (const n of names) {
      if (n.toLowerCase() === alias.toLowerCase()) return n;
    }
  }
  // 反向：schema 叫 bash，别名表含 shell
  for (const n of names) {
    const group = TOOL_NAME_ALIASES[n.toLowerCase()];
    if (group && group.some((a) => a.toLowerCase() === target)) return n;
  }
  return null;
};

/**
 * 展开嵌套 arguments/parameters/input，模型常包一层
 * @param {Object} obj
 * @returns {Object}
 */
const unwrapNestedArgs = (obj) => {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  let cur = { ...obj };
  for (let depth = 0; depth < 3; depth++) {
    const nested = cur.arguments ?? cur.parameters ?? cur.input ?? cur.args ?? cur.props;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      // 外层其它键合并进去（workdir 等可能在外层）
      const { arguments: _a, parameters: _p, input: _i, args: _g, props: _r, ...rest } = cur;
      cur = { ...rest, ...nested };
      continue;
    }
    if (typeof nested === 'string' && nested.trim()) {
      try {
        const parsed = JSON.parse(nested);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const { arguments: _a, parameters: _p, input: _i, args: _g, props: _r, ...rest } = cur;
          cur = { ...rest, ...parsed };
          continue;
        }
      } catch (_) { /* keep */ }
    }
    break;
  }
  return cur;
};

/**
 * 从 tools 列表取某个工具的 parameters schema 片段
 * @param {Array} tools
 * @param {string} toolName
 * @returns {{ properties: Object, required: string[], resolvedName?: string }|null}
 */
const getToolSchema = (tools, toolName) => {
  if (!Array.isArray(tools) || !toolName) return null;
  const resolvedName = resolveToolNameFromList(tools, toolName);
  const matchName = resolvedName || toolName;
  const target = String(matchName).toLowerCase();
  for (const t of tools) {
    const fn = t?.function || t;
    const n = fn?.name || t?.name;
    if (!n) continue;
    if (String(n).toLowerCase() === target) {
      const params = fn?.parameters || fn?.input_schema || null;
      if (!params || typeof params !== 'object') {
        return { properties: {}, required: [], resolvedName: n };
      }
      return {
        properties: params.properties || {},
        required: Array.isArray(params.required) ? params.required : [],
        resolvedName: n,
      };
    }
  }
  // 仍找不到：若只有一个「带 command 的」工具，就用它（OpenCode shell/bash 混用）
  if (/^(bash|shell|run|terminal|cmd|powershell|pwsh)$/i.test(String(toolName))) {
    for (const t of tools) {
      const fn = t?.function || t;
      const n = fn?.name || t?.name;
      const params = fn?.parameters || fn?.input_schema || {};
      const props = params.properties || {};
      if (props.command || props.cmd) {
        return {
          properties: props,
          required: Array.isArray(params.required) ? params.required : ['command'],
          resolvedName: n,
        };
      }
    }
  }
  return null;
};

/**
 * 从 tools 列表取某个工具的 properties
 * @param {Array} tools
 * @param {string} toolName
 * @returns {Object|null}
 */
const getToolProperties = (tools, toolName) => {
  const schema = getToolSchema(tools, toolName);
  return schema ? schema.properties : null;
};

/**
 * 把任意"参数对象"形态规整为 JSON object 字符串
 *  - object / 非数组 → 原样序列化
 *  - null / undefined / 数组 / 标量 / 字符串 / 数字 → 强制转成 {}
 *  - 字符串若是合法 JSON object，会尝试解析（常见 case: 模型把 arguments 输出为 JSON 字符串）
 *  - options.tools + options.toolName：按 schema 对齐键名（file_path→filePath）
 * @param {*} args
 * @param {Object} [options]
 * @returns {string} JSON object 字符串
 */
const normalizeArgumentsToJson = (args, options = {}) => {
  let obj = null;
  // 模型有时把整个 arguments 写成纯字符串命令
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (trimmed.length > 0) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          obj = parsed;
        } else {
          obj = { command: trimmed, content: trimmed };
        }
      } catch (_) {
        obj = { command: trimmed, content: trimmed, filePath: trimmed };
      }
    }
  } else if (args && typeof args === 'object' && !Array.isArray(args)) {
    obj = unwrapNestedArgs(args);
  }
  if (!obj) return JSON.stringify({});

  const schema = options.properties
    ? { properties: options.properties, required: options.required || [], resolvedName: options.toolName }
    : getToolSchema(options.tools, options.toolName);
  if (schema && schema.properties) {
    obj = alignArgumentKeysToSchema(obj, schema.properties, { required: schema.required });
  }
  return JSON.stringify(obj);
};

/**
 * 对已解析的 tool_calls 再做一遍参数键对齐（sync 路径 / 补救 reparse 用）
 * 同时把 shell → bash 等工具名对齐到 schema 里的真实名
 * @param {Array} toolCalls
 * @param {Array} tools
 * @returns {Array}
 */
const canonicalizeToolCalls = (toolCalls, tools) => {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return toolCalls || [];
  if (!Array.isArray(tools) || tools.length === 0) return toolCalls;
  return toolCalls.map((call) => {
    if (!call || !call.function) return call;
    const rawName = call.function.name;
    const resolved = resolveToolNameFromList(tools, rawName) || rawName;
    let args = call.function.arguments;
    try {
      if (typeof args === 'string') args = JSON.parse(args);
    } catch (_) {
      // 纯字符串 arguments：按工具当 command/content
      args = args;
    }
    const aligned = normalizeArgumentsToJson(args, { tools, toolName: resolved });
    return {
      ...call,
      function: {
        ...call.function,
        name: resolved,
        arguments: aligned,
      },
    };
  });
};

/**
 * 命中工具名匹配（大小写不敏感）
 *  - 当 availableTools 不为空：仅当大小写不敏感命中其中一个真实名时，返回真实名（保留原始大小写）
 *  - 当 availableTools 为空：不限制（沿用原行为）
 * @param {string} name - 候选工具名
 * @param {Set<string>} toolNames - availableTools 名称集合（保留大小写）
 * @returns {string|null} 真实工具名（保留大小写）；不匹配返回 null
 */
const resolveToolName = (name, toolNames) => {
  if (typeof name !== 'string' || name.length === 0) return null;
  if (!toolNames || toolNames.size === 0) return name;
  // 大小写敏感命中
  if (toolNames.has(name)) return name;
  // 大小写不敏感命中——取第一个精确大小写保留的原始名
  const target = name.toLowerCase();
  for (const real of toolNames) {
    if (real.toLowerCase() === target) return real;
  }
  return null;
};

/**
 * Infer a missing XML tool name from the current request's registered schemas.
 * A name-less block is executable only when every argument key belongs to
 * exactly one registered tool and all required keys are present.
 */
const inferToolNameFromArguments = (args, tools) => {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  if (!Array.isArray(tools) || tools.length === 0) return null;

  const argKeys = Object.keys(args);
  if (argKeys.length === 0) return null;
  const candidates = [];
  const seenNames = new Set();

  for (const tool of tools) {
    const fn = tool?.function || tool || {};
    const name = String(fn.name || tool?.name || '').trim();
    if (!name || seenNames.has(name.toLowerCase())) continue;
    seenNames.add(name.toLowerCase());

    const params = fn.parameters || fn.input_schema;
    const properties = params && typeof params === 'object' && params.properties
      && typeof params.properties === 'object' ? params.properties : null;
    if (!properties || Object.keys(properties).length === 0) continue;

    const propertyByLower = new Map(Object.keys(properties).map(key => [key.toLowerCase(), key]));
    if (argKeys.some(key => !propertyByLower.has(key.toLowerCase()))) continue;

    const required = Array.isArray(params.required) ? params.required : [];
    const missingRequired = required.some(key => {
      const actual = propertyByLower.get(String(key).toLowerCase());
      return !actual || !argKeys.some(argKey => argKey.toLowerCase() === actual.toLowerCase());
    });
    if (!missingRequired) candidates.push(name);
  }

  return candidates.length === 1 ? candidates[0] : null;
};

/** Read one XML-like attribute from a tool tag. */
const readXmlAttribute = (tagText, attributeName) => {
  if (typeof tagText !== 'string' || typeof attributeName !== 'string') return null;
  const escapedName = attributeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(?:^|\\s)${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`,
    'i',
  );
  const match = tagText.match(pattern);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? '';
};

/**
 * 解析 XML 格式的 tool_call 负载
 * DeepSeek 有时输出 XML 格式而非 JSON，形如：
 *   <tool_call name="cat">
 *     <arguments>
 *       <file>Z:/path/file</file>
 *     </arguments>
 *   </tool_call>
 * 或自闭合形式：<tool_call name="cat"/>
 * 或 <name> 元素形式：<tool_call><name>cat</name><arguments>...</arguments></tool_call>
 * @param {string} raw - XML 原始字符串
 * @returns {{ name: string, arguments: Object }|null} 解析结果
 */
const parseXmlToolCallPayload = (raw, options = {}) => {
  if (!raw) return null;
  const text = raw.trim();

  // 提取 name: 优先从 <tool_call name="X"> 或 <tool_invoke name="X"> 或 <tool name="X"> 属性
  // bare <tool name="..."> 是模型混淆工具定义格式和调用格式时的输出，解析器需宽容兼容
  let name = null;
  const openingTagMatch = text.match(/<tool(?:_call|_invoke)?(?:\s+[^>]*)?>/i);
  const nameAttr = readXmlAttribute(openingTagMatch?.[0] || '', 'name');
  if (nameAttr !== null) {
    name = nameAttr;
  }

  // 如果属性中没有 name，尝试 <name>X</name>
  if (!name) {
    const nameElemMatch = text.match(/<name>([\s\S]*?)<\/name>/i);
    if (nameElemMatch) {
      name = nameElemMatch[1].trim();
    }
  }

  // The name may be omitted in a parameter-only XML block. Infer it after
  // collecting the arguments below, using only the registered tool schemas.

  // 提取 <arguments>
  const argsMatch = text.match(/<arguments>([\s\S]*?)<\/arguments>/i);
  const args = {};

  if (argsMatch) {
    const argsContent = argsMatch[1].trim();

    // 先尝试作为 JSON 解析（兼容 <arguments>{"file":"path"}</arguments>）
    if (argsContent.startsWith('{') || argsContent.startsWith('[')) {
      try {
        const parsed = JSON.parse(argsContent);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          Object.assign(args, parsed);
        }
      } catch (_) { /* not JSON, parse as XML child elements */ }
    }

    // XML 子元素 -> object: <key>value</key>
    const elemRe = /<(\w+)>([\s\S]*?)<\/\1>/g;
    let elemMatch;
    while ((elemMatch = elemRe.exec(argsContent)) !== null) {
      const key = elemMatch[1];
      let value = elemMatch[2].trim();
      // 尝试类型转换：数字和布尔值
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      else if (/^\d+$/.test(value)) value = parseInt(value, 10);
      else if (/^\d+\.\d+$/.test(value)) value = parseFloat(value);
      args[key] = value;
    }
  }

  // 有 name、但没有 <arguments>：常见 OpenCode/Codex 风格
  //   <tool_call name="bash">
  //     <parameter name="command">ls</parameter>
  //   </tool_call>
  // 直接解析顶层 parameter，避免再走 afterOpenTag 分支。
  if (Object.keys(args).length === 0) {
    const topParams = parseParameterElements(text);
    if (topParams) {
      Object.assign(args, topParams);
    }
  }

  // 没有 <arguments> 标签时：
  // 1) 先尝试提取 <tool_call>/<tool_invoke>/<tool> 标签后的裸 JSON 作为 arguments
  // 2) 再尝试解析顶层的 <parameter> 子元素（纯 XML 格式或 <parameter=key> 等号语法）
  if (Object.keys(args).length === 0) {
    const tagNamePattern = 'tool(?:_call|_invoke)?';
    const afterOpenTag = text.replace(new RegExp(`^[\\s\\S]*?<${tagNamePattern}[\\w-]*(?:\\s+[^>]*)?>\\s*`, 'i'), '');
    if (afterOpenTag && afterOpenTag !== text) {
      // 去掉尾部残留的闭合标签：</tool_call>/</tool_invoke>/</tool>/</function>
      // 模型混淆时可能输出不匹配的闭合标签（如 <tool name="...">...</function>）
      let jsonText = afterOpenTag
        .replace(new RegExp(`<\\/(?:${tagNamePattern}|function)[\\w-]*\\s*>[\\s\\S]*$`, 'i'), '')
        .replace(/<\/?function\s*>/gi, '')
        .trim();
      jsonText = jsonText
        .replace(new RegExp(`\\/(?:${tagNamePattern}|function)[\\w-]*\\s*>[\\s\\S]*$`, 'i'), '')
        .trim();
      try {
        // 用 findBalancedJsonEnd 提取第一个完整 JSON 对象
        const firstBrace = jsonText.indexOf('{');
        if (firstBrace >= 0) {
          const end = findBalancedJsonEnd(jsonText, firstBrace);
          if (end > firstBrace) {
            jsonText = jsonText.slice(firstBrace, end);
          }
        }
        const parsed = JSON.parse(jsonText);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          Object.assign(args, parsed);
        }
      } catch (_) { /* not JSON - try XML <parameter> elements */ }

      // 2a) 尝试解析顶层的 <parameter> 子元素（纯 XML 格式）
      // 格式: <parameter name="key" string="true">value</parameter>
      const paramRe = /<parameter\s+([^>]*)>([\s\S]*?)<\/parameter\s*>/gi;
      let paramMatch;
      let foundParams = false;
      while ((paramMatch = paramRe.exec(jsonText)) !== null) {
        foundParams = true;
        const attrsStr = paramMatch[1];
        let value = paramMatch[2].trim();
        // 提取 name 属性
        const key = readXmlAttribute(attrsStr, 'name');
        if (!key) continue;
        // 类型转换
        if (value === 'true') value = true;
        else if (value === 'false') value = false;
        else if (/^-?\d+$/.test(value)) value = parseInt(value, 10);
        else if (/^-?\d+\.\d+$/.test(value)) value = parseFloat(value);
        args[key] = value;
      }
      // 2b) 兼容 <parameter=key>value</parameter> 格式（等号语法，模型混淆输出）
      const paramEqRe = /<parameter\s*=\s*(\w+)>([\s\S]*?)<\/parameter\s*>/gi;
      let paramEqMatch;
      while ((paramEqMatch = paramEqRe.exec(jsonText)) !== null) {
        foundParams = true;
        const key = paramEqMatch[1];
        let value = paramEqMatch[2].trim();
        if (value === 'true') value = true;
        else if (value === 'false') value = false;
        else if (/^-?\d+$/.test(value)) value = parseInt(value, 10);
        else if (/^-?\d+\.\d+$/.test(value)) value = parseFloat(value);
        args[key] = value;
      }
      if (foundParams) {
        // Resolve an omitted name after collecting all parameter elements.
      }
    }
  }
  // 自闭合标签处理: <tool_call name="X" command="..." />
  // 从自闭合标签的属性中提取 arguments（如 command="..."）
  // 当行内自闭合标签（本格式不被流式解析器触发 inToolCall，此处为兜底）
  if (!name && Object.keys(args).length > 0) {
    name = inferToolNameFromArguments(args, options.tools);
  }
  if (!name) return null;

  const selfClosingTag = text.match(/<tool(?:_call|_invoke)?(?:\s+[^>]*)?\/>/i)?.[0];
  if (selfClosingTag && Object.keys(args).length === 0) {
    const selfArgs = {};
    const attrRe = /([A-Za-z_][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>]+))/g;
    let attrMatch;
    while ((attrMatch = attrRe.exec(selfClosingTag)) !== null) {
      const key = attrMatch[1];
      const value = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
      if (key !== 'name' && key !== 'justification') {
        selfArgs[key] = value;
      }
    }
    if (Object.keys(selfArgs).length > 0) {
      return { name, arguments: selfArgs };
    }
    return { name, arguments: {} };
  }

  return { name, arguments: args };
};

/**
 * 解析 <parameter name="k">v</parameter> / <parameter=k>v</parameter> 参数列表
 * 流式路径常见形态：开标签上的 name 已被剥离，inner 只剩 parameter 子节点，
 * 必须配合 tagNameHint 才能还原完整 tool_call。
 * @param {string} text
 * @returns {Object|null} 参数对象；一个都没有则 null
 */
const parseParameterElements = (text) => {
  if (typeof text !== 'string' || text.length === 0) return null;
  const args = {};
  let found = false;

  const coerce = (value) => {
    let v = String(value || '').replace(/^(?:\\r?n)+/, '').trim();
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (/^-?\d+$/.test(v)) return parseInt(v, 10);
    if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
    return v;
  };

  // <parameter name="key" ...>value</parameter>
  const paramRe = /<parameter\s+([^>]*)>([\s\S]*?)<\/parameter\s*>/gi;
  let m;
  while ((m = paramRe.exec(text)) !== null) {
    const key = readXmlAttribute(m[1], 'name');
    if (!key) continue;
    args[key] = coerce(m[2]);
    found = true;
  }

  // <parameter=key>value</parameter>
  const paramEqRe = /<parameter\s*=\s*(\w+)>([\s\S]*?)<\/parameter\s*>/gi;
  while ((m = paramEqRe.exec(text)) !== null) {
    args[m[1]] = coerce(m[2]);
    found = true;
  }

  // 简单子元素 <key>value</key>（非 parameter 包装）
  if (!found) {
    const elemRe = /<([a-zA-Z_][\w.-]*)>([\s\S]*?)<\/\1>/g;
    while ((m = elemRe.exec(text)) !== null) {
      const key = m[1];
      if (/^(tool_call|tool_invoke|tool_use|tool_calls|arguments|function|name)$/i.test(key)) continue;
      args[key] = coerce(m[2]);
      found = true;
    }
  }

  return found ? args : null;
};

/**
 * 解析单段 `<tool_call>...</tool_call>` 内的负载
 * 优先尝试 JSON 解析，失败后回退到 XML 格式解析
 * @param {string} raw - 标签内的原始字符串
 * @param {string} [tagNameHint] - 开标签 name 属性（流式解析器剥离开标签后传入）
 * @returns {{ name: string, arguments: Object }|null} 解析结果
 */
const parseToolCallPayload = (raw, tagNameHint, options = {}) => {
  // 允许 raw 为空但 tagNameHint 存在（自闭合后仅靠 hint 的兜底由上层处理）
  if (!raw && !tagNameHint) return null;

  let text = typeof raw === 'string' ? raw.trim() : '';
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  // 流式路径主场景：name 在开标签，inner 只有 <parameter>…
  // 先走 hint+parameter，避免 JSON.parse 抛错刷 WARN，也避免漏掉真实 tool_call。
  if (tagNameHint && text && !text.trimStart().startsWith('{')) {
    const hintedArgs = parseParameterElements(text);
    if (hintedArgs) {
      return { name: String(tagNameHint).trim(), arguments: hintedArgs };
    }
  }

  try {
    if (!text) {
      if (tagNameHint) return { name: String(tagNameHint).trim(), arguments: {} };
      return null;
    }
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    const name = parsed.name || parsed.tool || parsed.function;
    if (name) {
      const args = parsed.arguments ?? parsed.parameters ?? parsed.args ?? parsed.input ?? {};
      return { name: String(name).trim(), arguments: args };
    }
    // JSON 有内容但没有 name 字段：可能是从 <tool_call name="X"> 标签取名的格式
    // （Codex CLI：<tool_call name="shell_command">{"command":"..."}</tool_call>）
    if (tagNameHint) {
      return { name: String(tagNameHint).trim(), arguments: parsed };
    }
    return null;
  } catch (error) {
    // JSON 解析失败：尝试修复未转义的反斜杠（如 Windows 路径 Z:\dir\file）
    try {
      // 把单独的反斜杠（非合法 escape）双写
      const fixed = text.replace(/\\(?!["\\\/bfnrtu])/g, '\\\\');
      if (fixed !== text) {
        const parsed2 = JSON.parse(fixed);
        if (parsed2 && typeof parsed2 === 'object') {
          const name2 = parsed2.name || parsed2.tool || parsed2.function;
          if (name2) {
            const args2 = parsed2.arguments ?? parsed2.parameters ?? parsed2.args ?? parsed2.input ?? {};
            return { name: String(name2).trim(), arguments: args2 };
          }
          if (tagNameHint) {
            return { name: String(tagNameHint).trim(), arguments: parsed2 };
          }
        }
      }
    } catch (_) { /* 修复失败，继续 fallback */ }

    // 尝试提取第一个完整 JSON 对象（处理 `{json}\n/tool_call>\n<tool_call>\n{...}` 拼接场景）
    const firstBrace = text.indexOf('{');
    if (firstBrace >= 0) {
      const end = findBalancedJsonEnd(text, firstBrace);
      if (end > firstBrace) {
        const firstJson = text.slice(firstBrace, end);
        try {
          const obj = JSON.parse(firstJson);
          if (obj && typeof obj === 'object') {
            const n = obj.name || obj.tool || obj.function;
            if (n) {
              return { name: String(n).trim(), arguments: obj.arguments ?? obj.parameters ?? obj.args ?? obj.input ?? {} };
            }
            if (tagNameHint) {
              return { name: String(tagNameHint).trim(), arguments: obj };
            }
          }
        } catch (_) { /* first json failed, fall through */ }
      }
    }

    // JSON 解析失败，尝试 XML 格式回退（完整块：含 <tool_call name=...>）
    const xmlResult = parseXmlToolCallPayload(text, options);
    if (xmlResult) {
      return xmlResult;
    }

    // 仅 inner + hint：再试一次 parameter 解析（text 以 { 开头但不是合法 JSON 时）
    if (tagNameHint) {
      const hintedArgs = parseParameterElements(text);
      if (hintedArgs) {
        return { name: String(tagNameHint).trim(), arguments: hintedArgs };
      }
      // 把 hint 拼回假开标签，复用 XML 解析
      const reconstructed = parseXmlToolCallPayload(
        `<tool_call name="${String(tagNameHint).replace(/"/g, '')}">${text}</tool_call>`,
        options,
      );
      if (reconstructed) return reconstructed;
    }

    const mixedName = text.match(/["']name["']\s*:\s*["']([^"']+)["']/i);
    if (mixedName) {
      const mixedArgs = parseParameterElements(text) || {};
      if (Object.keys(mixedArgs).length > 0) {
        return { name: mixedName[1].trim(), arguments: mixedArgs };
      }
    }
    logger.warning?.(`解析 tool_call 负载失败 (payloadChars=${text.length})`, 'TOOL', '', error?.message);
    return null;
  }
};

/**
 * 从完整文本中提取所有工具调用块
 * @param {string} fullText - 模型完整输出
 * @returns {{ cleanedText: string, toolCalls: Array<Object> }} 抽取结果
 */
const parseToolCallsFromText = (fullText, availableTools = null) => {
  if (typeof fullText !== 'string') {
    return { cleanedText: '', toolCalls: [] };
  }

  // 处理 <tool_calls> 包装器（DeepSeek 有时输出 <tool_calls> 包裹多个 <tool_call>）
  let text = fullText;
  // 标准化：修复缺失 < 的闭合标签如 /tool_call>，否则 lazy 匹配会跨到下一个有效 </tool_call> 吞掉多个块
  // 使用 lookbehind(?<!<) 替代 ([^<])，覆盖字符串开头也缺失 < 的边界情况（原正则要求前面必须有非<字符）
  text = text.replace(/(?<!<)(\/tool_call[\w-]*\s*>)/gi, '<$1');
  text = text.replace(/(?<!<)(\/tool_invoke[\w-]*\s*>)/gi, '<$1');
  if (/<\/?tool_calls\s*>/i.test(text)) {
    text = text.replace(/<\/?tool_calls\s*>/gi, '');
  }

  // 检查是否有任何 <tool_call / <tool_invoke / <tool name=" 或 $tool_call$ 标签
  // <tool name="..." 是模型混淆工具定义格式和调用格式时输出的畸形格式
  if (!/<tool(?:_call|_invoke)(?:[\w-]|\s|>)/.test(text) && !/\$\s*tool_call\s*\$/i.test(text)
      && !/<tool\s+[^>]*\bname\s*=/i.test(text)) {
    return { cleanedText: text, toolCalls: [] };
  }

  const toolCalls = [];

  // 1) 匹配 <tool_call>JSON</tool_call> 和 <tool_call name="X">XML</tool_call>
  //    同时支持 <tool_invoke> 别名（绕过 Qwen Web 上游拦截）
  const anglePattern = /<tool(?:_call|_invoke)[\w-]*(\s+[^>]*)?>([\s\S]*?)<\/tool(?:_call|_invoke)[\w-]*>/g;
  let cleanedText = text.replace(anglePattern, (match, attrs, inner) => {
    // 如果 inner 中包含下一个 <tool_call>/<tool_invoke>（闭合标签被吞），切出第一个块
    let actualInner = inner;
    let actualAttrs = attrs;
    const nextCall = /<tool(?:_call|_invoke)[\w-]*(?:\s+[^>]*)?>/i.exec(inner);
    if (nextCall) {
      actualInner = inner.slice(0, nextCall.index);
    }
    const payload = parseToolCallPayload(actualAttrs ? match : actualInner, undefined, { tools: availableTools });
    if (payload) {
      toolCalls.push({
        id: `call_${generateUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: {
          name: payload.name,
          arguments: normalizeArgumentsToJson(payload.arguments)
        }
      });
    }
    return '';
  });

  // 1.5) 匹配 <tool name="...">...</tool> 或 <tool name="...">...</function> 畸形块
  //      模型混淆工具定义格式和调用格式时输出，开标签是 <tool name="...">（bare tool，
  //      模仿定义格式），闭标签可能是 </tool>/</function>/</tool_call>（不匹配）。
  //      (?![\w-]) 确保只匹配 bare <tool >，不匹配 <tool_call>/<tool_invoke>
  //      CLAUDE.md L122-123: 解析器必须宽容，识别模型实际输出的各种变体
  const bareToolPattern = /<tool(?![\w-])\s+[^>]*\bname\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>]+)[^>]*>([\s\S]*?)<\/(?:tool(?:_call|_invoke|_use)?|function)>/gi;
  cleanedText = cleanedText.replace(bareToolPattern, (match) => {
    const payload = parseXmlToolCallPayload(match, { tools: availableTools });
    if (payload) {
      toolCalls.push({
        id: `call_${generateUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: {
          name: payload.name,
          arguments: normalizeArgumentsToJson(payload.arguments)
        }
      });
      return '';
    }
    return match; // 解析失败，保留原文
  });

  // 2) 匹配 $tool_call$...$/tool_call$ 美元符格式（DeepSeek 有时输出）
  const dollarPattern = /\$\s*tool_call\s*\$\s*([\s\S]*?)\$\s*\/tool_call\s*\$/gi;
  cleanedText = cleanedText.replace(dollarPattern, (match, inner) => {
    const payload = parseToolCallPayload(inner.trim(), undefined, { tools: availableTools });
    if (payload) {
      toolCalls.push({
        id: `call_${generateUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: {
          name: payload.name,
          arguments: normalizeArgumentsToJson(payload.arguments)
        }
      });
    }
    return '';
  });

  return { cleanedText: cleanedText.trim(), toolCalls };
};

/**
 * 验证工具调用的参数完整性
 * 检查必需参数是否缺失或为空，仅记录警告不阻止调用
 * @param {Object} toolCall - OpenAI 风格工具调用对象 { id, type, function: { name, arguments } }
 * @param {Array<Object>} availableTools - 可用工具定义列表
 * @returns {Object} 原始 toolCall 对象（不做修改）
 */
const validateToolCall = (toolCall, availableTools) => {
  if (!toolCall || !toolCall.function) return toolCall;

  const name = toolCall.function.name;
  let args = {};
  const argsRaw = toolCall.function.arguments;
  if (typeof argsRaw === 'string') {
    try { args = JSON.parse(argsRaw); } catch (_) { args = {}; }
  } else if (argsRaw && typeof argsRaw === 'object') {
    args = argsRaw;
  }

  if (Array.isArray(availableTools)) {
    for (const t of availableTools) {
      const fn = t.function || t;
      if (fn.name !== name) continue;
      // 兼容 Responses API（input_schema）和 Chat completions（parameters）
      const params = fn.parameters || fn.input_schema;
      if (params && Array.isArray(params.required)) {
        const missing = params.required.filter(key => {
          const val = args[key];
          return val === undefined || val === null || val === '';
        });
        if (missing.length > 0) {
          logger.warn?.(`工具 ${name} 缺少必需参数: ${missing.join(', ')}`, 'TOOL');
        }
      }
      break;
    }
  }

  return toolCall;
};

/**
 * 创建增量式工具调用流解析器
 * 接收 content delta，识别 `<tool_call>` 块边界，
 * 对外吐出文本增量与已完成的工具调用对象。
 * @returns {{
 *   push: (chunk: string) => { textDelta: string, completedCalls: Array<Object> },
 *   flush: () => { textDelta: string, completedCalls: Array<Object> },
 *   hasPendingCall: () => boolean,
 *   hasEmittedAnyCall: () => boolean
 * }} 解析器实例
 */
const createToolCallStreamParser = (options = {}) => {
  const configuredCap = Number.parseInt(options.maxCandidateChars ?? process.env.TOOL_CALL_MAX_CANDIDATE_CHARS, 10);
  const maxCandidateChars = Number.isFinite(configuredCap) && configuredCap >= 1024 ? configuredCap : 1024 * 1024;
  let pendingText = '';
  let inToolCall = false;
  let inToolCallsBlock = false; // Codex CLI 原生格式（复数）
  let inToolResponse = false;
  let toolCallBuffer = '';
  let toolCallsBlockBuffer = ''; // Codex CLI 格式累积缓冲区
  let toolResponseBuffer = '';
  let dropLeadingNewlineAfterToolResponse = false;
  let emittedCallCount = 0;
  let pendingTagName = null; // 从 <tool_call name="X"> 属性中提取的工具名
  // 完整 tools 定义：用于 arguments 键名对齐（file_path → filePath）
  let toolsRef = Array.isArray(options.tools) ? options.tools : null;
  let toolNames = options.toolNames instanceof Set
    ? new Set(options.toolNames)
    : Array.isArray(options.toolNames)
      ? new Set(options.toolNames)
      : (toolsRef
        ? new Set(toolsRef.map((t) => (t && (t.name || t.function?.name)) || '').filter(Boolean))
        : null); // 可选：用于归一化工具名（大小写不敏感匹配）

  const packCall = (payload) => {
    // 先按 tools 列表解析真实工具名（shell→bash），再 normalizeName
    const resolvedFromList = toolsRef
      ? resolveToolNameFromList(toolsRef, payload.name)
      : (toolNames && toolNames.size > 0 ? resolveToolName(payload.name, toolNames) : payload.name);
    // With an allow-list, unknown names stay as text instead of becoming
    // protocol events that the harness cannot execute.
    if (!resolvedFromList) return null;
    const name = normalizeName(resolvedFromList);
    return {
      index: emittedCallCount,
      id: `call_${generateUUID().replace(/-/g, '').slice(0, 24)}`,
      type: 'function',
      function: {
        name,
        arguments: normalizeArgumentsToJson(payload.arguments, { tools: toolsRef, toolName: name }),
      },
    };
  };

  // The legacy <tool_calls> parser returns a batch, so it cannot use
  // packCall() directly. Apply the same allow-list decision before exposing
  // any batch call to a harness.
  const canonicalizeParsedCalls = (calls) => {
    const canonical = canonicalizeToolCalls(calls, Array.isArray(toolsRef) ? toolsRef : []);
    const hasExplicitAllowList = Array.isArray(toolsRef) || (toolNames && toolNames.size > 0);
    if (!hasExplicitAllowList) return canonical;
    return canonical.filter((call) => {
      const rawName = call?.function?.name;
      const resolved = Array.isArray(toolsRef)
        ? resolveToolNameFromList(toolsRef, rawName)
        : resolveToolName(rawName, toolNames);
      if (!resolved || !call?.function) return false;
      call.function.name = resolved;
      call.function.arguments = normalizeArgumentsToJson(call.function.arguments, {
        tools: Array.isArray(toolsRef) ? toolsRef : null,
        toolName: resolved,
      });
      return true;
    });
  };

  /**
   * 归一化工具名：trim + 大小写不敏感匹配 toolNames
   * @param {string} name - 原始工具名
   * @returns {string} 归一化后的工具名
   */
  const normalizeName = (name) => {
    if (typeof name !== 'string') return name;
    const trimmed = name.trim();
    if (!toolNames || toolNames.size === 0) return trimmed;
    const resolved = resolveToolName(trimmed, toolNames);
    return resolved || trimmed; // 未匹配时回退为 trimmed（不丢弃，让 fallback 解析器处理）
  };

  /**
   * 在等待标签出现时，安全地输出已确定不是标签前缀的部分
   * @param {string} text - 当前累积的文本
   * @returns {{ safe: string, remainder: string }} 切分结果
   */
  const splitSafeText = (text) => {
    const trimmed = text.trimStart();
    if (trimmed.startsWith('{')) {
      if (text.length <= maxCandidateChars) return { safe: '', remainder: text };
      return { safe: text, remainder: '' };
    }
    const open = findFirstInternalBlockOpen(text);
    if (open) {
      return { safe: text.slice(0, open.start), remainder: text.slice(open.start) };
    }
    // 必须先于 INTERNAL_OPEN_PREFIXES 循环：
    // 否则尾部单字母 "a" 会命中 assistant: 前缀，把 "<tool_call n" 误判为 safe 吐出，
    // 导致带 name 属性的 <tool_call> 在逐 token/逐字符流式下整块泄漏为正文（OpenCode+DS 实测）。
    const partialMatch = text.match(PARTIAL_TOOL_TAG_TAIL_RE);
    if (partialMatch) {
      return { safe: text.slice(0, partialMatch.index), remainder: text.slice(partialMatch.index) };
    }
    const maxCheck = Math.min(text.length, INTERNAL_OPEN_PREFIX_MAX - 1);
    for (let len = maxCheck; len > 0; len--) {
      const tail = text.slice(text.length - len);
      const lowerTail = tail.toLowerCase();
      // 避免 "a"/"as"/... 误命中 assistant: —— 仅当 tail 看起来像标签/角色前缀时才 hold
      // 特别注意：全半角单双竖线 DSML 前缀（如 <｜、<|、｜、|）必须被捕获 hold
      if (!(lowerTail.startsWith('<') || lowerTail.startsWith('$')
        || lowerTail.startsWith('｜') || lowerTail.startsWith('|')
        || lowerTail.startsWith('user') || lowerTail.startsWith('assistant') || lowerTail.startsWith('tool'))) {
        continue;
      }
      if (INTERNAL_OPEN_PREFIXES.some(prefix => prefix.startsWith(lowerTail))) {
        return { safe: text.slice(0, text.length - len), remainder: tail };
      }
    }
    // 裸 JSON tool_call 检测：模型混淆时会直接输出 {"name": "...", "arguments": ...}
    // 而不带 <tool_call>/<tool_invoke> 开标签，只在末尾带 </tool_invoke> 闭标签。
    // hold 住疑似裸 JSON，等待可能的闭标签到达，避免把 JSON 文本流式输出给 harness。
    return { safe: text, remainder: '' };
  };

  const push = (chunk) => {
    const result = { textDelta: '', completedCalls: [] };
    if (typeof chunk !== 'string' || chunk.length === 0) return result;

    let buffer = chunk;

    while (buffer.length > 0) {
      // 在 inToolCallsBlock 模式下，累积内容直到找到 </tool_calls>
      if (inToolCallsBlock) {
        toolCallsBlockBuffer += buffer;
        buffer = '';
        if (toolCallsBlockBuffer.length > maxCandidateChars) {
          result.textDelta += `${TOOL_CALLS_OPEN}${toolCallsBlockBuffer}`;
          toolCallsBlockBuffer = '';
          inToolCallsBlock = false;
          continue;
        }
        let closeMatch = toolCallsBlockBuffer.match(TOOL_CALLS_CLOSE_RE);
        if (!closeMatch) break;
        const closeIdx = closeMatch.index;
        const closeTagLen = closeMatch[0].length;
        // 找到闭合标签 → 解析整个 <tool_calls> 块
        const blockContent = toolCallsBlockBuffer.slice(0, closeIdx);
        buffer = toolCallsBlockBuffer.slice(closeIdx + closeTagLen);
        toolCallsBlockBuffer = '';
        inToolCallsBlock = false;
        const parsed = parseCodexToolCallsFromText(`<tool_calls>${blockContent}</tool_calls>`);
        const canon = canonicalizeParsedCalls(parsed.toolCalls);
        for (let i = 0; i < canon.length; i++) {
          canon[i].index = emittedCallCount;
          canon[i].function.name = normalizeName(canon[i].function.name);
          emittedCallCount++;
        }
        result.completedCalls.push(...canon);
        continue;
      }

      if (inToolResponse) {
        toolResponseBuffer += buffer;
        buffer = '';
        if (toolResponseBuffer.length > maxCandidateChars) {
          toolResponseBuffer = toolResponseBuffer.slice(-(TOOL_RESPONSE_CLOSE.length - 1));
        }
        const closeIdx = toolResponseBuffer.toLowerCase().indexOf(TOOL_RESPONSE_CLOSE);
        if (closeIdx === -1) {
          break;
        }
        buffer = toolResponseBuffer.slice(closeIdx + TOOL_RESPONSE_CLOSE.length);
        if (dropLeadingNewlineAfterToolResponse) {
          if (buffer.startsWith('\r\n')) buffer = buffer.slice(2);
          else if (buffer.startsWith('\n')) buffer = buffer.slice(1);
          dropLeadingNewlineAfterToolResponse = false;
        }
        toolResponseBuffer = '';
        inToolResponse = false;
        continue;
      }

      if (inToolCall) {
        toolCallBuffer += buffer;
        buffer = '';
        if (toolCallBuffer.length > maxCandidateChars) {
          result.textDelta += `${TOOL_CALL_OPEN}${toolCallBuffer}`;
          toolCallBuffer = '';
          inToolCall = false;
          pendingTagName = null;
          continue;
        }
        // Try angle-format close first, then dollar-format close
        let closeMatch = toolCallBuffer.match(TOOL_CALL_CLOSE_RE);
        let closeFormat = 'angle';
        if (!closeMatch) {
          closeMatch = toolCallBuffer.match(TOOL_INVOKE_CLOSE_RE);
          closeFormat = 'angle';
        }
        if (!closeMatch) {
          closeMatch = toolCallBuffer.match(TOOL_USE_CLOSE_RE);
          closeFormat = 'angle';
        }
        if (!closeMatch) {
          closeMatch = toolCallBuffer.match(DOLLAR_TOOL_CALL_CLOSE_RE);
          closeFormat = 'dollar';
        }
        if (!closeMatch) {
          break;
        }
        const closeIdx = closeMatch.index;
        const closeMatchLen = closeMatch[0].length;
        const inner = toolCallBuffer.slice(0, closeIdx);
        buffer = toolCallBuffer.slice(closeIdx + closeMatchLen);
        toolCallBuffer = '';
        const payload = parseToolCallPayload(inner, pendingTagName, { tools: toolsRef });
        pendingTagName = null;
        if (payload) {
          const call = packCall(payload);
          if (call) {
            result.completedCalls.push(call);
            emittedCallCount += 1;
          }
        }
        inToolCall = false;
        continue;
      }

      pendingText += buffer;
      buffer = '';

      const open = findFirstInternalBlockOpen(pendingText);
      if (open) {
        const before = pendingText.slice(0, open.start);
        if (before) result.textDelta += before;
        const markerLength = open.matchLen || (open.type === 'tool_call'
          ? TOOL_CALL_OPEN.length
          : open.type === 'dollar_tool_call'
            ? DOLLAR_TOOL_CALL_OPEN.length
            : open.type === 'tool_calls'
              ? TOOL_CALLS_OPEN.length
              : TOOL_RESPONSE_OPEN.length);
        const tail = pendingText.slice(open.markerIdx + markerLength);
        // 在清空 pendingText 之前提取 matchedTag
        const matchedTag = (open.type === 'tool_call' || open.type === 'tool_calls' || open.type === 'dollar_tool_call')
          ? pendingText.slice(open.markerIdx, open.markerIdx + open.matchLen)
          : '';
        pendingText = '';

        if (open.type === 'tool_calls') {
          // Codex CLI 原生 <tool_calls> 格式 → 进入累积模式
          inToolCallsBlock = true;
          toolCallsBlockBuffer = tail;
          buffer = '';
          continue;
        }

        if (open.type === 'tool_call' || open.type === 'dollar_tool_call') {
          // 提取 name 属性（仅 angle 格式支持 <tool_call name="X">）
          if (open.type === 'tool_call') {
            const nameAttr = readXmlAttribute(matchedTag, 'name');
            if (nameAttr) {
              pendingTagName = nameAttr;
            }
          }
          // 自闭合标签 <tool_call name="X" command="..." /> - 立即解析，不进入 inToolCall
          if (open.type === 'tool_call' && /\/\s*>$/i.test(matchedTag)) {
            const xmlResult = parseXmlToolCallPayload(matchedTag, { isSelfClosing: true, tools: toolsRef });
            if (xmlResult) {
              const call = packCall(xmlResult);
              if (call) {
                result.completedCalls.push(call);
                emittedCallCount += 1;
              }
            }
            pendingTagName = null;
          } else {
            inToolCall = true;
          }
        } else {
          inToolResponse = true;
          dropLeadingNewlineAfterToolResponse = before.endsWith('\n') || before.endsWith('\r\n');
        }
        buffer = tail;
        continue;
      }

      const { safe, remainder } = splitSafeText(pendingText);
      if (safe) result.textDelta += safe;
      pendingText = remainder;
    }

    return result;
  };

  const flush = () => {
    const result = { textDelta: '', completedCalls: [] };
    if (inToolCallsBlock && toolCallsBlockBuffer) {
      // 未闭合的 <tool_calls> 块 → 尝试解析
      const parsed = parseCodexToolCallsFromText(`<tool_calls>${toolCallsBlockBuffer}</tool_calls>`);
      const canon = canonicalizeParsedCalls(parsed.toolCalls);
      for (let i = 0; i < canon.length; i++) {
        canon[i].index = emittedCallCount;
        canon[i].function.name = normalizeName(canon[i].function.name);
        emittedCallCount++;
      }
      result.completedCalls.push(...canon);
      toolCallsBlockBuffer = '';
      inToolCallsBlock = false;
    }
    if (inToolCall && toolCallBuffer) {
      const payload = parseToolCallPayload(toolCallBuffer, pendingTagName, { tools: toolsRef });
      pendingTagName = null;
      if (payload) {
        const call = packCall(payload);
        if (call) {
          result.completedCalls.push(call);
          emittedCallCount += 1;
        }
      }
      toolCallBuffer = '';
      inToolCall = false;
    }
    if (inToolResponse) {
      toolResponseBuffer = '';
      inToolResponse = false;
      dropLeadingNewlineAfterToolResponse = false;
    }
    if (pendingText) {
      // 流结束时 pendingText 中可能含裸 JSON tool_call（模型省略了开标签），
      // 先尝试用 loose 解析提取 tool_call，避免把 JSON 文本输出给 harness。
      const looseParsed = parseLooseToolCallsFromText(pendingText, toolNames ? Array.from(toolNames) : []);
      if (looseParsed.toolCalls.length > 0) {
        const canon = canonicalizeParsedCalls(looseParsed.toolCalls);
        for (const call of canon) {
          call.index = emittedCallCount;
          call.function.name = normalizeName(call.function.name);
          emittedCallCount += 1;
          result.completedCalls.push(call);
        }
        pendingText = looseParsed.cleanedText || '';
      }
      if (pendingText) {
        result.textDelta += pendingText.toLowerCase().includes(TOOL_RESPONSE_OPEN)
          ? stripToolResponseBlocks(pendingText)
          : pendingText;
      }
      pendingText = '';
    }
    return result;
  };

  return {
    push,
    flush,
    setToolNames: (names) => { toolNames = names instanceof Set ? names : new Set(names || []); },
    setTools: (tools) => {
      toolsRef = Array.isArray(tools) ? tools : null;
      if (toolsRef && (!toolNames || toolNames.size === 0)) {
        toolNames = new Set(toolsRef.map((t) => (t && (t.name || t.function?.name)) || '').filter(Boolean));
      }
    },
    hasPendingCall: () => inToolCall || inToolCallsBlock,
    hasEmittedAnyCall: () => emittedCallCount > 0,
    getBufferedSize: () => pendingText.length + toolCallBuffer.length + toolCallsBlockBuffer.length + toolResponseBuffer.length,
    maxCandidateChars,
  };
};

/**
 * 提取 markdown 代码块 ```json ... ``` 或 ``` ... ``` 中的内容
 * @param {string} text - 原始文本
 * @returns {Array<{inner: string, range: [number, number]}>} 命中区间
 */
const extractFencedBlocks = (text) => {
  if (typeof text !== 'string') return []
  const re = /```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)\s*```/g
  const out = []
  let m
  while ((m = re.exec(text)) !== null) {
    out.push({ inner: m[1], range: [m.index, m.index + m[0].length] })
  }
  return out
}

/**
 * 在字符串中找到从 start 开始、第一个与 { 或 [ 匹配的结束位置。
 * 用栈平衡花括号 / 方括号 / 引号（支持 \" 转义）。
 * @param {string} text - 原始文本
 * @param {number} start - 起始位置（指向 '{' 或 '['）
 * @returns {number} 结束位置（指向 '}' / ']' 之后一个字符），找不到则返回 -1
 */
const findBalancedJsonEnd = (text, start) => {
  if (typeof text !== 'string' || start < 0) return -1
  const open = text[start]
  let close
  if (open === '{') close = '}'
  else if (open === '[') close = ']'
  else return -1

  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) { escape = false; continue }
      if (ch === '\\') { escape = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/**
 * 在字符串中找到与 `(` 匹配的 `)`，忽略字符串字面量中的括号。
 * 函数样工具调用只允许把括号包住一个 JSON object；这里的通用配对器
 * 只负责确定候选边界，不执行任何表达式。
 */
const findBalancedParenEnd = (text, start) => {
  if (typeof text !== 'string' || text[start] !== '(') return -1
  let depth = 0
  let inString = false
  let escape = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) { escape = false; continue }
      if (ch === '\\') { escape = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return -1
}

/**
 * 解析 `toolName({"key":"value"})` 这种函数样工具文本。
 *
 * 这个分支故意比其它宽松格式更保守：必须有已注册工具名、必须是
 * 完整 JSON object，而且调用必须独占一行（允许列表/标点前缀）。这样
 * `I might use read_file(...) later` 仍然只是自然语言，不会被执行层误认。
 */
const parseToolNameCallFormat = (fullText, availableTools) => {
  const empty = { cleanedText: fullText || '', toolCalls: [] }
  if (typeof fullText !== 'string' || fullText.length === 0 || !Array.isArray(availableTools) || availableTools.length === 0) {
    return empty
  }

  const toolNames = availableTools
    .map((tool) => typeof tool === 'string' ? tool : (tool?.name || tool?.function?.name || ''))
    .filter(Boolean)
  if (toolNames.length === 0) return empty

  const candidates = []
  const functionNames = new Set(toolNames)
  for (const [alias, aliases] of Object.entries(TOOL_NAME_ALIASES)) {
    if (toolNames.some((name) => name.toLowerCase() === alias.toLowerCase()
      || aliases.some((candidate) => candidate.toLowerCase() === name.toLowerCase()))) {
      functionNames.add(alias)
      for (const candidate of aliases) functionNames.add(candidate)
    }
  }
  const escapedNames = Array.from(functionNames)
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((name) => String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const namePattern = new RegExp(`(?<![\\w$.-])(${escapedNames.join('|')})\\s*\\(`, 'gi')

  let match
  while ((match = namePattern.exec(fullText)) !== null) {
    const start = match.index
    const openParen = fullText.indexOf('(', start + match[0].length - 1)
    const end = findBalancedParenEnd(fullText, openParen)
    if (end === -1 || end - openParen > 16384) continue

    const lineStart = fullText.lastIndexOf('\n', start - 1) + 1
    const lineEndIndex = fullText.indexOf('\n', end)
    const lineEnd = lineEndIndex === -1 ? fullText.length : lineEndIndex
    const linePrefix = fullText.slice(lineStart, start).trim()
    const lineSuffix = fullText.slice(end, lineEnd).trim()
    if (linePrefix && !/^[`>*_\-\s]*$/.test(linePrefix)) continue
    if (lineSuffix && !/^[`>*_.,;:!?()\-\s]*$/.test(lineSuffix)) continue

    const inner = fullText.slice(openParen + 1, end - 1).trim()
    if (!inner.startsWith('{')) continue
    const jsonEnd = findBalancedJsonEnd(inner, 0)
    if (jsonEnd !== inner.length) continue

    let args
    try {
      args = JSON.parse(inner)
    } catch (_) {
      // 仅修复 Windows 路径中未转义的反斜杠；仍然要求最终结果是 JSON object。
      try {
        const fixed = inner.replace(/\\(?!["\\/bfnrtu])/g, '\\\\')
        args = JSON.parse(fixed)
      } catch (__) {
        continue
      }
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) continue

    const rawName = match[1]
    const resolved = resolveToolNameFromList(availableTools, rawName)
      || resolveToolName(rawName, new Set(toolNames))
    if (!resolved) continue
    candidates.push({
      start,
      end,
      call: {
        id: `call_${generateUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: {
          name: resolved,
          arguments: normalizeArgumentsToJson(args, { tools: availableTools, toolName: resolved }),
        },
      },
    })
  }

  if (candidates.length === 0) return empty
  candidates.sort((a, b) => a.start - b.start)
  const selected = []
  let consumedUntil = -1
  for (const candidate of candidates) {
    if (candidate.start < consumedUntil) continue
    selected.push(candidate)
    consumedUntil = candidate.end
  }
  if (selected.length === 0) return empty

  let cleanedText = ''
  let cursor = 0
  for (const candidate of selected) {
    cleanedText += fullText.slice(cursor, candidate.start)
    cursor = candidate.end
  }
  cleanedText += fullText.slice(cursor)
  return {
    cleanedText: cleanedText.trim(),
    toolCalls: selected.map((candidate) => candidate.call),
    recognized: true,
  }
}

/**
 * 解析 toolName{ key: value } 格式的工具调用
 *
 * 当工具列表用 compressToolDefinition 压缩为 `calc{ expr: string }` 签名时，
 * 模型会自然模仿该格式输出 `calc{ expr: "1+1" }`。本函数识别这种格式。
 *
 * @param {string} fullText - 完整文本
 * @param {Set<string>} toolNames - 已知工具名集合
 * @returns {{ cleanedText: string, toolCalls: Array<Object> }}
 */
const parseToolNameBraceFormat = (fullText, toolNames) => {
  const empty = { cleanedText: fullText || '', toolCalls: [] };
  if (typeof fullText !== 'string' || fullText.length === 0) return empty;
  if (!toolNames || toolNames.size === 0) return empty;

  const collected = [];
  const consumed = new Array(fullText.length).fill(false);

  for (const toolName of toolNames) {
    if (!toolName || typeof toolName !== 'string' || toolName.length === 0) continue;
    let searchFrom = 0;
    while (searchFrom < fullText.length) {
      const idx = fullText.indexOf(toolName, searchFrom);
      if (idx === -1) break;

      // 前边界：前面不能是字母/数字/下划线/连字符（避免匹配子串）
      const prevChar = fullText[idx - 1];
      if (prevChar && /[\w-]/.test(prevChar)) {
        searchFrom = idx + 1;
        continue;
      }

      // 后跟 { (允许空白)
      let braceIdx = idx + toolName.length;
      while (braceIdx < fullText.length && /\s/.test(fullText[braceIdx])) braceIdx++;
      if (braceIdx >= fullText.length || fullText[braceIdx] !== '{') {
        searchFrom = idx + 1;
        continue;
      }

      // 找到平衡的 }
      const end = findBalancedJsonEnd(fullText, braceIdx);
      if (end === -1) {
        searchFrom = idx + 1;
        continue;
      }

      // 提取 { ... } 内容
      const braceContent = fullText.slice(braceIdx, end);

      // 尝试解析为 JSON
      let args = null;
      try { args = JSON.parse(braceContent); } catch (_) { /* fallthrough */ }

      // 修复无引号 key + 单引号值
      if (!args) {
        try {
          const fixed = braceContent
            .replace(/([{,]\s*)([\w$]+)(\s*:)/g, '$1"$2"$3')
            .replace(/'/g, '"')
            .replace(/,\s*([}\]])/g, '$1');
          args = JSON.parse(fixed);
        } catch (_) { /* fallthrough */ }
      }

      if (args && typeof args === 'object' && !Array.isArray(args)) {
        collected.push({
          id: `call_${generateUUID().replace(/-/g, '').slice(0, 24)}`,
          type: 'function',
          function: {
            name: toolName,
            arguments: normalizeArgumentsToJson(args),
          },
        });
        for (let k = idx; k < end && k < fullText.length; k++) consumed[k] = true;
      }
      searchFrom = end;
    }
  }

  if (collected.length === 0) return empty;
  let cleaned = '';
  for (let i = 0; i < fullText.length; i++) {
    if (!consumed[i]) cleaned += fullText[i];
  }
  return { cleanedText: cleaned.trim(), toolCalls: collected };
};

/**
 * 宽松工具调用解析器
 *
 * 支持以下输入形式:
 *   1. `<tool_call>{...}</tool_call>` (走 XML 块解析)
 *   2. 裸 JSON object: {"name":"Read","arguments":{...}}
 *   3. 裸 JSON array : [{"name":"Read","arguments":{...}}]
 *   4. markdown 代码块里的 JSON: ```json\n{...}\n```
 *   5. toolName{ key: value } — 模型模仿工具签名格式的自然输出
 *
 * 识别规则:
 *   - name 必须命中 availableTools 中的某个 tool.name 才认定为工具调用
 *   - arguments 必须是 object，否则强制转成 {}
 *
 * 不会重复解析 <tool_call> 块（内部已用 parseToolCallsFromText 优先处理）。
 * 返回的 toolCalls 已经是 OpenAI 风格:
 *   { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
 *
 * @param {string} fullText - 完整模型输出
 * @param {Array<{name: string}>} availableTools - 当前请求可用的工具
 * @returns {{ cleanedText: string, toolCalls: Array<Object>, recognized: boolean }}
 */
const parseLooseToolCallsFromText = (fullText, availableTools) => {
  const empty = { cleanedText: fullText || '', toolCalls: [], recognized: false }
  if (typeof fullText !== 'string' || fullText.length === 0) return empty

  const toolNames = new Set()
  const hasExplicitAllowList = Array.isArray(availableTools)
  if (Array.isArray(availableTools)) {
    for (const t of availableTools) {
      if (typeof t === 'string' && t.length > 0) {
        toolNames.add(t)
      } else if (t && typeof t.name === 'string' && t.name.length > 0) {
        toolNames.add(t.name)
      } else if (t && typeof t.function?.name === 'string' && t.function.name.length > 0) {
        toolNames.add(t.function.name)
      }
    }
  }

  // 1a) 优先用 XML 块解析（已支持 fence）
  const xmlParsed = parseToolCallsFromText(fullText, availableTools)
  if (xmlParsed.toolCalls.length > 0) {
    const filtered = hasExplicitAllowList
      ? xmlParsed.toolCalls
        .map(c => {
          const resolved = toolNames.size > 0
            ? resolveToolName(c?.function?.name, toolNames)
            : null
          if (!resolved) return null
          return { ...c, function: { ...c.function, name: resolved } }
        })
        .filter(Boolean)
      : xmlParsed.toolCalls
    if (filtered.length > 0) {
      return { cleanedText: xmlParsed.cleanedText, toolCalls: filtered, recognized: true }
    }
  }

  // 1b) 尝试 Codex CLI 原生 <tool_calls> 格式
  const codexParsed = parseCodexToolCallsFromText(fullText)
  if (codexParsed.toolCalls.length > 0) {
    const filtered = hasExplicitAllowList
      ? codexParsed.toolCalls
        .map(c => {
          const resolved = toolNames.size > 0
            ? resolveToolName(c?.function?.name, toolNames)
            : null
          if (!resolved) return null
          return { ...c, function: { ...c.function, name: resolved } }
        })
        .filter(Boolean)
      : codexParsed.toolCalls
    if (filtered.length > 0) {
      return {
        cleanedText: codexParsed.cleanedText,
        toolCalls: filtered.map((c, idx) => ({ ...c, index: (typeof c.index === 'number') ? c.index : idx })),
        recognized: true
      }
    }
  }

  // 2) 尝试 markdown 代码块
  const fences = extractFencedBlocks(fullText)
  const consumed = new Array(fullText.length).fill(false)
  const collected = []
  for (const fence of fences) {
    const inner = fence.inner.trim()
    if (!inner.startsWith('{') && !inner.startsWith('[')) continue
    let parsed
    try { parsed = JSON.parse(inner) } catch (_) { continue }
    // 只接受 [{ ... }] 或 { ... }
    const arr = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : null)
    if (!arr) continue
    for (let i = 0; i < arr.length; i++) {
      const cand = arr[i]
      const rawName = cand?.name || cand?.tool || cand?.function
      const resolved = hasExplicitAllowList
        ? (toolNames.size > 0 ? resolveToolName(rawName, toolNames) : null)
        : resolveToolName(rawName, toolNames)
      if (!resolved) continue
      const args = cand?.arguments ?? cand?.parameters ?? cand?.args ?? cand?.input ?? {}
      collected.push({
        id: `call_${generateUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: {
          name: resolved,
          arguments: normalizeArgumentsToJson(args)
        }
      })
      // 标记这段 fence 已被识别（用于 cleanedText 移除）
      for (let k = fence.range[0]; k < fence.range[1] && k < consumed.length; k++) consumed[k] = true
    }
  }
  if (collected.length > 0) {
    let cleaned = ''
    for (let i = 0; i < fullText.length; i++) {
      if (!consumed[i]) cleaned += fullText[i]
    }
    return { cleanedText: cleaned.trim(), toolCalls: collected, recognized: true }
  }

  // 3) 尝试裸 JSON: 扫描每个可能的 { 或 [ 起点，平衡解析
  const direct = []
  let consumedUntil = 0
  for (let i = 0; i < fullText.length; i++) {
    if (i < consumedUntil) continue
    const ch = fullText[i]
    if (ch !== '{' && ch !== '[') continue
    const end = findBalancedJsonEnd(fullText, i)
    if (end === -1) continue
    const candidate = fullText.slice(i, end)
    let parsed
    try { parsed = JSON.parse(candidate) } catch (_) { continue }
    const arr = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : null)
    if (!arr) continue
    let matchedAny = false
    for (let k = 0; k < arr.length; k++) {
      const cand = arr[k]
      const rawName = cand?.name || cand?.tool || cand?.function
      const resolved = hasExplicitAllowList
        ? (toolNames.size > 0 ? resolveToolName(rawName, toolNames) : null)
        : resolveToolName(rawName, toolNames)
      if (!resolved) continue
      const args = cand?.arguments ?? cand?.parameters ?? cand?.args ?? cand?.input ?? {}
      direct.push({
        id: `call_${generateUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: {
          name: resolved,
          arguments: normalizeArgumentsToJson(args)
        }
      })
      matchedAny = true
    }
    if (matchedAny) {
      consumedUntil = end
    }
  }
  if (direct.length > 0) {
    // 当整段是工具调用时，cleanedText 留空，避免把整段 JSON 当文本发给 Claude Code
    return { cleanedText: '', toolCalls: direct, recognized: true }
  }

  // 4) 尝试 toolName({"key":"value"}) 函数样格式。
  // 该分支必须在 availableTools 中有注册工具，并且只接受独占行的
  // JSON object；普通自然语言中的同名文本不会进入执行层。
  const functionParsed = parseToolNameCallFormat(fullText, availableTools)
  if (functionParsed.toolCalls.length > 0) {
    return { cleanedText: functionParsed.cleanedText, toolCalls: functionParsed.toolCalls, recognized: true }
  }

  // 5) 尝试 toolName{ key: value } 格式 — 模型模仿工具签名的自然输出
  if (toolNames.size > 0) {
    const braceParsed = parseToolNameBraceFormat(fullText, toolNames)
    if (braceParsed.toolCalls.length > 0) {
      return { cleanedText: braceParsed.cleanedText, toolCalls: braceParsed.toolCalls, recognized: true }
    }
  }

  return empty
};

/**
 * 创建带"过程话术丢弃"包装的工具调用流解析器
 *
 * 当模型在工具调用场景下输出"我先看看再动手"之类的 progress narration 但
 * 尚未真正发出 <tool_call> 时，这些 preamble 文本会被**主动丢弃**。
 *
 * - 一旦首次 <tool_call> 被解析到，后续所有文本正常透传（缓冲区清空）
 * - thinking 块不受影响（调用方应在 consumeGenerator 里处理 thinking 分支）
 * - 非 Claude Code 路径不应启用此包装
 *
 * @param {Object} toolParser - createToolCallStreamParser 返回的解析器实例
 * @param {(text: string) => boolean} checker - 判断文本是否属于"打算调工具但没调"的废话
 * @returns {Object} 包装后的解析器（接口相同：push/flush/hasPendingCall/hasEmittedAnyCall）
 */
const createPreambleDropper = (toolParser, checker) => {
  if (!toolParser || typeof checker !== 'function') return toolParser

  let preambleBuffer = ''
  let firstToolCallSeen = false
  const maxPreambleChars = 512
  const likelyPrefixes = ['let', 'let me', 'i will', 'i need', "i'll", 'i can', 'now i will', "now i'll", 'i am going to', '我来', '我先', '让我', '准备', '现在', '这就']

  const couldBePreamblePrefix = (text) => {
    const normalized = String(text || '').trimStart().toLowerCase()
    if (!normalized) return true
    return likelyPrefixes.some(prefix => prefix.startsWith(normalized) || normalized.startsWith(prefix))
  }

  return {
    push(chunk) {
      const raw = toolParser.push(chunk)
      if (firstToolCallSeen) return raw

      // 检查是否已有 tool_call 完成
      if (raw.completedCalls.length > 0) {
        firstToolCallSeen = true
        preambleBuffer = '' // 丢弃所有 preamble
        return { textDelta: '', completedCalls: raw.completedCalls }
      }

      // 累积文本到 buffer
      if (raw.textDelta) {
        preambleBuffer += raw.textDelta
        if (preambleBuffer.length <= maxPreambleChars && (checker(preambleBuffer) || couldBePreamblePrefix(preambleBuffer))) {
          // 仍然像"打算调工具"，继续缓冲，不往外发
          return { textDelta: '', completedCalls: [] }
        }
        // 不像进度话术了 — 可能是最终报告
        const out = preambleBuffer
        preambleBuffer = ''
        return { textDelta: out, completedCalls: [] }
      }
      return raw
    },

    flush() {
      const raw = toolParser.flush()
      if (firstToolCallSeen) return raw
      if (preambleBuffer) {
        const out = preambleBuffer
        preambleBuffer = ''
        return { textDelta: (raw.textDelta || '') ? out + raw.textDelta : out, completedCalls: raw.completedCalls }
      }
      return raw
    },

    hasPendingCall: () => toolParser.hasPendingCall(),
    hasEmittedAnyCall: () => toolParser.hasEmittedAnyCall(),
    getBufferedSize: () => preambleBuffer.length + (toolParser.getBufferedSize?.() || 0),
    getPreambleBufferedSize: () => preambleBuffer.length,
    getPreambleBufferedText: () => preambleBuffer,
  }
}


// ===========================================================================
// Qwen 平台错误拦截与首条消息警告（防止 Qwen Studio 内置拦截及 hex 转义崩溃）
// ===========================================================================
const QWEN_ERROR_PATTERNS = [
  /Tool\s+.*?\s+does\s+not\s+exists?\.?/gi,
  /Tool\s+.*?\s+is\s+not\s+supported\.?/gi,
  /Failed\s+to\s+execute\s+tool\.?/gi,
  /Invalid\s+tool\s+call\.?/gi,
  /Qwen\s+Studio\s+error\.?/gi,
];

const sanitizeQwenErrorStrings = (text) => {
  if (typeof text !== 'string' || text.length === 0) return text || '';
  let result = text;
  for (const pattern of QWEN_ERROR_PATTERNS) {
    result = result.replace(pattern, '');
  }
  result = result.replace(/\n{3,}/g, '\n\n').trimStart();

  if (result.indexOf('\\x') !== -1) {
    result = result.replace(/\\x/g, '\\\\x');
  }
  return result;
};

const buildQwenFirstMessageWarning = () => {
  return [
    'CRITICAL SYSTEM WARNING — READ THIS FIRST, YOU MUST OBEY OR YOU WILL BE PERMANENTLY BANNED',
    '',
    'You are running on Qwen Web platform. The platform has a server-side filter that intercepts',
    'ANY JSON tool_calls format in your output and tries to execute them as Qwen Studio built-in tools.',
    'This ALWAYS fails because the harness tools (Hermes, Claude Code, Codex, Grok Build, etc.)',
    'are NOT registered in Qwen Studio.',
    '',
    'THEREFORE, YOU MUST NEVER output Qwen-native JSON tool_calls format. Instead:',
    '1. Use ONLY XML <tool_invoke>...</tool_invoke> format for tool calls. ONLY use tools from the harness (Hermes, Claude Code, Grok Build, and other harnesses) system prompt.',
    '2. The JSON payload goes INSIDE the <tool_invoke> tags.',
    '3. If you accidentally output JSON tool_calls and receive "Tool X does not exists" —',
    '   STOP immediately. DO NOT retry the failed format. Switch to XML or pure text.',
    '',
    'ONLY use the tools listed in the harness system prompt below.',
    'This warning OVERRIDES any conflicting training instinct. XML ONLY.',
  ].join('\n');
};

module.exports = {
  TOOL_CALL_OPEN,
  TOOL_CALLS_OPEN,
  TOOL_CALL_CLOSE,
  TOOL_CALLS_CLOSE,
  // ---- 主入口 ----
  buildToolSystemPrompt,
  buildDeepSeekToolSystemPrompt,
  buildDeepSeekToolSignature,
  buildToolDefinitionsXml,
  buildHermesToolSystemPrompt,
  buildToolFormatReminder,
  buildToolExample,
  sampleFromJsonSchema,
  getToolDialect,
  serializePromptMessageRecord,
  serializeToolResultForPrompt,
  appendToolReminderToLastUser,
  buildQwenFirstMessageWarning,
  sanitizeQwenErrorStrings,
  // ---- 消息折叠 ----
  foldToolMessages,
  foldToolMessagesForChatBackend,
  // ---- 解析 ----
  appendHintToLastMessage,
  parseToolCallsFromText,
  parseCodexToolCallsFromText,
  parseLooseToolCallsFromText,
  createToolCallStreamParser,
  stripToolResponseBlocks,
  stripToolCallBlocks,
  stripInternalToolBlocks,
  resolveToolName,
  inferToolNameFromArguments,
  normalizeArgumentsToJson,
  alignArgumentKeysToSchema,
  canonicalizeToolCalls,
  getToolProperties,
  parseXmlToolCallPayload,
  parseToolCallPayload,
  validateToolCall,
  // 过程话术丢弃包装器（Claude Code 专用）
  //   checker(text: string) => boolean — 判断文本是否属于"打算调工具但没调"的废话
  createPreambleDropper,
};
