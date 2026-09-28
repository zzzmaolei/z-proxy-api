/**
 * Anthropic 协议共享辅助函数
 *
 * 本模块存放 Anthropic /v1/messages 协议相关的纯函数，被以下两个控制器共用：
 *   - controllers/anthropic.js        （Qwen 路线主控制器）
 *   - controllers/anthropic-deepseek.js（DeepSeek 路线）
 *
 * # 为什么需要这个模块
 *
 * 重构前 `controllers/anthropic.js` 既是 Qwen 路线的主控制器（1994 行），
 * 又被 DeepSeek 控制器 `require('./anthropic')` 当作共享 helper 库使用，
 * 导致职责严重过载：DeepSeek 仅仅为了拿到 `flattenAnthropicMessages`
 * 等纯函数，就把整个 Qwen 主控制器代码（含所有依赖、所有内部状态）一并加载进内存。
 *
 * 把这些纯函数剥离到 `shared/anthropic-helpers.js` 后：
 *   1. 两个控制器的依赖关系清晰：纯函数来自 shared/，业务逻辑各自维护
 *   2. `controllers/anthropic.js` 不再被作为"共享库"require，职责回归单一
 *   3. 单元测试可独立针对 shared/anthropic-helpers.js 编写，无需 mock Qwen 后端
 *
 * # 设计原则
 *
 *   - **纯函数优先**：所有导出函数不得访问 req/res 等运行时对象，不得有副作用
 *     （`getAnthropicProfile` 例外，它读取 `req.clientProfile`，但仍无副作用）
 *   - **不依赖任何 provider 后端**：本模块不 import `backends/deepseek/*` /
 *     `utils/account.js` / `backends/qwen/request.js` 等 provider 专用模块
 *   - **不依赖 SSE 写入器**：不 import `utils/anthropic-sse-state.js`
 *   - **依赖白名单**：仅可依赖 `agents/`（profile 定义）和 `utils/tools.js`（generateUUID）
 */

const { generateUUID } = require('../utils/tools.js');
const claudeCodeProfile = require('../agents/claude-code-profile.js');
const PROFILES_AGENTS = require('../agents/index.js');

// ===========================================================================
// Profile 相关
// ===========================================================================

/**
 * 根据请求对象获取 Anthropic profile
 *
 * 优先使用 `req.clientProfile`（由 middlewares/client-detection.js 注入），
 * 找不到对应 profile 时回退到 `claudeCodeProfile`（Claude Code 默认严格模式）。
 *
 * @param {Object} req - Express 请求对象（需带 clientProfile 字段）
 * @returns {Object} profile 对象
 */
const getAnthropicProfile = (req) => {
  const fromReq = req && req.clientProfile
  if (fromReq && fromReq.name && PROFILES_AGENTS.getProfile(fromReq.name)) {
    return PROFILES_AGENTS.getProfile(fromReq.name)
  }
  return claudeCodeProfile
}

/**
 * 判定当前 profile 是否要求"tool_use 时 stop_reason=tool_use"
 *
 * Claude Code 在工具调用场景下要求 stop_reason 严格为 `tool_use`，
 * 否则会误判任务结束而停止 workflow。其他客户端（如 Continue）无此要求。
 *
 * @param {Object} profile - profile 对象
 * @returns {boolean}
 */
const shouldRequireStopReasonToolUse = (profile) => {
  return !!(profile && profile.profile && profile.profile.requireStopReasonToolUse)
}

// ===========================================================================
// 字段规范化
// ===========================================================================

/**
 * 将 Anthropic system 字段规范为字符串
 *
 * Anthropic 协议允许 system 为字符串或 `[{type:'text', text:'...'}]` 数组，
 * 内部统一转为字符串处理。
 *
 * @param {string|Array<Object>} system - Anthropic system
 * @returns {string} 合并后的 system 文本
 */
const normalizeAnthropicSystem = (system) => {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .filter(b => b && b.type === 'text')
      .map(b => b.text || '')
      .join('\n');
  }
  return '';
};

/**
 * 将 Anthropic tools 列表转为 OpenAI 风格供 buildToolSystemPrompt 使用
 *
 * Anthropic 工具定义使用 `input_schema`，OpenAI 使用 `parameters`，
 * 这里统一转为 OpenAI 风格。
 *
 * @param {Array<Object>} tools - Anthropic 工具定义
 * @returns {Array<Object>} OpenAI 风格工具定义
 */
const normalizeAnthropicTools = (tools) => {
  if (!Array.isArray(tools)) return [];
  return tools.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema || { type: 'object', properties: {} }
    }
  }));
};

/**
 * 将 Anthropic tool_choice 转为内部统一形式（OpenAI 风格）
 *
 * Anthropic: { type: 'auto' | 'any' | 'tool', name?: string }
 * OpenAI   : 'auto' | 'required' | 'none' | { type:'function', function:{ name } }
 *
 * @param {Object} toolChoice - Anthropic tool_choice
 * @returns {string|Object|undefined} OpenAI 风格 tool_choice
 */
const normalizeAnthropicToolChoice = (toolChoice) => {
  if (!toolChoice || typeof toolChoice !== 'object') return undefined;
  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'tool' && toolChoice.name) {
    return { type: 'function', function: { name: toolChoice.name } };
  }
  if (toolChoice.type === 'none') return 'none';
  return undefined;
};

/**
 * 把 Anthropic image.source 规整为内部可处理的 url / data URI
 *
 * 支持两种形态：
 *   - `source.type=base64` + `media_type` + `data`：拼成 data URI
 *   - `source.url`：直接透传
 *
 * @param {Object} source - Anthropic image source
 * @returns {string} 规整后的 url（失败返回 ''）
 */
const normalizeAnthropicImageSource = (source) => {
  if (!source || typeof source !== 'object') return ''
  if (source.type === 'base64' && typeof source.data === 'string' && source.data.length > 0) {
    const mediaType = (typeof source.media_type === 'string' && source.media_type.length > 0)
      ? source.media_type
      : 'image/png'
    return `data:${mediaType};base64,${source.data}`
  }
  if (typeof source.url === 'string' && source.url.length > 0) {
    return source.url
  }
  return ''
}

// ===========================================================================
// 消息展开
// ===========================================================================

/**
 * 把 Anthropic 风格的消息（含 content blocks 与 tool_use/tool_result）展开为
 * OpenAI 风格消息列表。
 *
 * 转换规则：
 *   - assistant.text        → assistant.content (string)
 *   - assistant.tool_use    → assistant.tool_calls[]
 *   - user.tool_result      → { role:'tool', tool_call_id, content } （文本）
 *                            + 可能的 { role:'user', content:[image_url...] } （图片）
 *   - user.text             → user.content (string)
 *   - user.image            → user.content (multimodal array)
 *
 * Tool result images are emitted as a separate user multimodal message so
 * parserMessages/upload.js can upload them to Qwen OSS. Text still stays in
 * role=tool to preserve the tool_call_id relationship.
 *
 * @param {Array<Object>} messages - Anthropic messages
 * @returns {Array<Object>} OpenAI 风格 messages
 */
const flattenAnthropicMessages = (messages) => {
  if (!Array.isArray(messages)) return [];
  const out = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const role = msg.role;

    // 兜底：跳过 system 角色（应由 extractSystemFromMessages 提取到顶级 system 字段）。
    // 如果走到这里说明调用方未先调用 extractSystemFromMessages，直接丢弃避免污染对话。
    if (role === 'system') continue;

    if (typeof msg.content === 'string') {
      out.push({ role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) continue;

    if (role === 'assistant') {
      const textParts = [];
      const toolCalls = [];
      for (const block of msg.content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        } else if (block?.type === 'tool_use') {
          toolCalls.push({
            id: block.id || `toolu_${generateUUID().replace(/-/g, '').slice(0, 24)}`,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {})
            }
          });
        }
      }
      const out_msg = { role: 'assistant', content: textParts.join('') };
      if (toolCalls.length > 0) out_msg.tool_calls = toolCalls;
      out.push(out_msg);
      continue;
    }

    // user 角色：tool_result 拆为独立 role=tool 消息 + 可能的 role=user 多模态消息，
    // 普通文本/图片合并保留
    const collectedTextParts = [];
    const collectedUserImages = [];
    const collectedFiles = [];
    for (const block of msg.content) {
      if (block?.type === 'tool_result') {
        // tool_result.content may be a string or an array containing text and
        // images. Keep both paths so Claude Code image results remain visible
        // to the Qwen chat backend.
        let toolText = '';
        const toolImageUrls = [];
        let attemptedImageCount = 0; // 是否含 image 块（即使 source 字段不全）
        if (typeof block.content === 'string') {
          toolText = block.content;
        } else if (Array.isArray(block.content)) {
          for (const b of block.content) {
            if (b?.type === 'text' && typeof b.text === 'string') {
              toolText += (toolText ? '\n' : '') + b.text;
            } else if (b?.type === 'image') {
              attemptedImageCount += 1;
              const url = normalizeAnthropicImageSource(b.source);
              if (url) toolImageUrls.push(url);
            }
          }
        } else {
          try {
            toolText = JSON.stringify(block.content ?? '');
          } catch (_) {
            toolText = '';
          }
        }

        // Preserve textual tool output on role=tool with the original id.
        out.push({
          role: 'tool',
          tool_call_id: block.tool_use_id || '',
          content: toolText
        });

        // Convert valid tool_result images to OpenAI-style image_url blocks.
        // If an image block is present but unusable, send a short text signal
        // instead of silently dropping the result.
        if (toolImageUrls.length > 0) {
          const content = [];
          for (const url of toolImageUrls) {
            content.push({ type: 'image_url', image_url: { url } });
          }
          // Claude Code Read 返回图片时，主动加一行提示语，避免模型误判"看不到图"
          content.unshift({
            type: 'text',
            text: 'Tool result from Read contained an image. Please inspect the attached image.'
          });
          out.push({ role: 'user', content });
        } else if (attemptedImageCount > 0) {
          // 至少有 image 块但 source 字段不全 / 无效 → 仍发 text-only user 消息
          out.push({
            role: 'user',
            content: [{
              type: 'text',
              text: 'Tool result attempted to return an image but the image data was missing or invalid. Please call the tool again with valid file_path / file content.'
            }]
          });
        }
      } else if (block?.type === 'text' && typeof block.text === 'string') {
        collectedTextParts.push(block.text);
      } else if (block?.type === 'image') {
        // 透传 user 直接的 image 块给 parserMessages 处理（OpenAI image_url 形态）
        const url = normalizeAnthropicImageSource(block.source);
        if (url) collectedUserImages.push(url);
      } else if (block?.type === 'document') {
        const source = block.source;
        if (source && source.type === 'base64' && typeof source.data === 'string' && source.data.length > 0) {
          collectedFiles.push({
            type: 'file',
            file_data: source.data,
            media_type: (typeof source.media_type === 'string' && source.media_type.length > 0)
              ? source.media_type
              : 'application/pdf'
          });
        }
      }
    }
    if (collectedUserImages.length > 0 || collectedFiles.length > 0) {
      const content = [];
      if (collectedTextParts.length > 0) {
        content.push({ type: 'text', text: collectedTextParts.join('') });
        collectedTextParts.length = 0;
      }
      for (const url of collectedUserImages) {
        content.push({ type: 'image_url', image_url: { url } });
      }
      for (const file of collectedFiles) {
        content.push(file);
      }
      out.push({ role: 'user', content });
    }
    if (collectedTextParts.length > 0) {
      out.push({ role: 'user', content: collectedTextParts.join('') });
    }
  }

  return out;
};

// ===========================================================================
// 请求探测
// ===========================================================================

/**
 * 判断 Anthropic 请求中是否含图片（user 直传 image 块 / tool_result.image 块）
 *
 * 当请求含图片时，buildToolSystemPrompt 会启用 image-aware 模式，
 * 让模型直接看图回答，不要乱用 vision/ocr 工具。
 *
 * @param {Array<Object>} messages - 原始 Anthropic messages
 * @returns {boolean}
 */
const hasAnthropicRequestImage = (messages) => {
  if (!Array.isArray(messages)) return false;
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'image') return true;
        if (block.type === 'tool_result' && Array.isArray(block.content)) {
          for (const sub of block.content) {
            if (sub && sub.type === 'image') return true;
          }
        }
      }
    }
  }
  return false;
};

/**
 * 从 messages 数组中提取 role='system' 的消息，合并为 systemText
 *
 * Claude Code 某些版本会把 system 消息放到 messages 数组里（而非顶级 system 字段）。
 * 此函数将 system 消息提取出来，避免：
 *   1. flattenAnthropicMessages 把 system 当作 user 传给下游
 *   2. system 内容被当作历史消息而非 system prompt
 *
 * 提取后的 systemText 由调用方合并到顶级 system 字段。
 * system 消息的 content 支持 string 和 [{type:'text', text:'...'}] 数组两种形态。
 *
 * @param {Array<Object>} messages - 原始 messages 数组
 * @returns {{ messages: Array<Object>, systemText: string }}
 *   - messages: 不含 system 角色的消息列表（保持原顺序）
 *   - systemText: 合并后的 system 文本（多条以 \n\n 分隔；无 system 消息时为 ''）
 */
const extractSystemFromMessages = (messages) => {
  if (!Array.isArray(messages)) return { messages: [], systemText: '' };
  const pureMessages = [];
  const systemParts = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') {
      pureMessages.push(msg);
      continue;
    }
    if (msg.role !== 'system') {
      pureMessages.push(msg);
      continue;
    }
    // 提取 system 文本
    const content = msg.content;
    if (typeof content === 'string') {
      if (content.trim()) systemParts.push(content);
    } else if (Array.isArray(content)) {
      const text = content
        .filter(b => b && b.type === 'text' && typeof b.text === 'string')
        .map(b => b.text || '')
        .join('\n');
      if (text.trim()) systemParts.push(text);
    }
  }
  return { messages: pureMessages, systemText: systemParts.join('\n\n') };
};

module.exports = {
  // ---- Profile 相关 ----
  getAnthropicProfile,
  shouldRequireStopReasonToolUse,
  // ---- 字段规范化 ----
  normalizeAnthropicSystem,
  normalizeAnthropicTools,
  normalizeAnthropicToolChoice,
  normalizeAnthropicImageSource,
  // ---- 消息展开 ----
  flattenAnthropicMessages,
  extractSystemFromMessages,
  // ---- 请求探测 ----
  hasAnthropicRequestImage,
};
