/**
 * openai-compatible-profile.js
 *
 * Base OpenAI Chat Completions compatibility profile.
 *
 * 目标：让 /v1/chat/completions 满足 OpenAI 客户端的"标准最小可解析"形态，
 * 不修改 chat.js 业务行为，只声明"我们对外承诺的字段集合"。
 */

const profile = Object.freeze({
  name: 'openai-compatible',
  version: '1.0.0',
  // 协议路线
  protocol: 'openai',
  // 行为开关
  strictOpenAIStream: true,         // 严格 OpenAI 流式 chunk 形态
  strictToolCalls: true,             // 工具调用解析命中后才输出 tool_calls
  noAnthropicFields: true,           // 不在 OpenAI 响应里混入 anthropic 字段
  stableModelList: true,             // /v1/models 返回稳定 id
  // 命名约定
  chunkObject: 'chat.completion.chunk',
  completionObject: 'chat.completion',
  modelsListObject: 'list',
  modelObject: 'model',
  // finish_reason 允许值
  finishReasons: Object.freeze(['stop', 'length', 'tool_calls', 'content_filter', 'function_call']),
  // tool_calls id 前缀（OpenAI 规范）
  toolCallIdPrefix: 'call_',
  // stream 终止 sentinel
  doneSentinel: '[DONE]',
  // error envelope
  errorEnvelope: Object.freeze({
    object: 'error',
    shape: 'openai'
  })
});

/**
 * 读取 profile 字段
 * @param {string} key
 */
const getFlag = (key) => {
  if (!Object.prototype.hasOwnProperty.call(profile, key)) return undefined;
  return profile[key];
};

/**
 * 判定一个 finish_reason 是否在 OpenAI 允许值集合内
 * @param {string} reason
 * @returns {boolean}
 */
const isKnownFinishReason = (reason) => {
  if (typeof reason !== 'string') return false;
  return profile.finishReasons.includes(reason);
};

/**
 * 规范化 finish_reason：未识别的值映射到 'stop'（OpenAI 客户端不会因为 stop 而 panic）
 * @param {string} reason
 * @returns {string}
 */
const normalizeFinishReason = (reason) => {
  if (isKnownFinishReason(reason)) return reason;
  return 'stop';
};

module.exports = {
  profile,
  getFlag,
  isKnownFinishReason,
  normalizeFinishReason
};
