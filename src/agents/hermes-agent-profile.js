/**
 * hermes-agent-profile.js
 *
 * Hermes Agent OpenAI-compatible profile.
 *
 * 继承自 openai-compatible-profile（基类），只声明"Hermes 偏好哪些额外严苛"。
 * 所有能力由基类定义，本文件只做"开关值 + 标识"。
 */

const openaiProfile = require('./openai-compatible-profile.js');

// 浅继承：基类 profile 字段 + Hermes 标识
const profile = Object.freeze(Object.assign({}, openaiProfile.profile, {
  name: 'hermes-agent',
  parent: 'openai-compatible',
  version: '1.0.0',
  // 协议路线
  protocol: 'openai',
  // Hermes 偏好的严苛度
  strictOpenAIStream: true,         // 流式 chunk 字段顺序与 OpenAI 规范一致
  strictToolCalls: true,             // 工具调用必须命中 availableTools
  noAnthropicFields: true,           // 不混入 anthropic 字段（type/role/stop_reason 等）
  stableModelList: true,             // /v1/models id 字符串稳定不变
  // Hermes 偏好：解析到工具调用时不要附加任何自然语言解释
  preferToolCallsOnly: true,
  // 客户端标识
  clientId: 'hermes-agent'
}));

/**
 * 判定一段响应是否符合 Hermes OpenAI 兼容约束
 * @param {Object} resp - 响应对象
 * @returns {{ ok: boolean, reason?: string }}
 */
const ALLOWED_FINISH_REASONS = Object.freeze(['stop', 'length', 'tool_calls', 'content_filter', 'function_call'])

const validateChatCompletion = (resp) => {
  if (!resp || typeof resp !== 'object') {
    return { ok: false, reason: 'response_not_object' }
  }
  if (resp.object !== 'chat.completion') {
    return { ok: false, reason: 'object_not_chat_completion' }
  }
  if (typeof resp.id !== 'string') {
    return { ok: false, reason: 'id_missing' }
  }
  if (typeof resp.created !== 'number') {
    return { ok: false, reason: 'created_missing' }
  }
  if (typeof resp.model !== 'string') {
    return { ok: false, reason: 'model_missing' }
  }
  if (!Array.isArray(resp.choices) || resp.choices.length === 0) {
    return { ok: false, reason: 'choices_empty' }
  }
  for (const c of resp.choices) {
    if (typeof c.index !== 'number') {
      return { ok: false, reason: 'choice_index_missing' }
    }
    if (!c.message || c.message.role !== 'assistant') {
      return { ok: false, reason: 'message_role_must_be_assistant' }
    }
    if (typeof c.finish_reason !== 'string') {
      return { ok: false, reason: 'finish_reason_missing' }
    }
    // Hermes is an OpenAI-compatible client; reject Anthropic-only finish reasons.
    if (ALLOWED_FINISH_REASONS.indexOf(c.finish_reason) < 0) {
      return { ok: false, reason: 'finish_reason_not_openai_compatible' }
    }
  }
  return { ok: true }
};

/**
 * 判定一段流式 chunk 是否符合 Hermes OpenAI 兼容约束
 * @param {Object} chunk
 * @returns {{ ok: boolean, reason?: string }}
 */
const validateStreamChunk = (chunk) => {
  if (!chunk || typeof chunk !== 'object') {
    return { ok: false, reason: 'chunk_not_object' }
  }
  if (chunk.object !== 'chat.completion.chunk') {
    return { ok: false, reason: 'object_not_chat_completion_chunk' }
  }
  if (typeof chunk.id !== 'string') {
    return { ok: false, reason: 'id_missing' }
  }
  if (typeof chunk.created !== 'number') {
    return { ok: false, reason: 'created_missing' }
  }
  if (typeof chunk.model !== 'string') {
    return { ok: false, reason: 'model_missing' }
  }
  if (!Array.isArray(chunk.choices)) {
    return { ok: false, reason: 'choices_must_be_array' }
  }
  return { ok: true }
};

module.exports = {
  profile,
  baseProfile: openaiProfile.profile,
  validateChatCompletion,
  validateStreamChunk
};
