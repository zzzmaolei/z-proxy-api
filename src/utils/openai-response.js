/**
 * openai-response.js
 *
 * OpenAI 兼容响应构造器
 *
 *  - formatOpenAIError: 把任何上游 / 内部错误归一为 OpenAI error envelope
 *  - formatOpenAIModelList: 把内部模型数据归一为 OpenAI /v1/models 列表
 *  - buildOpenAIChatCompletion: 构造非流式 chat completion 响应（字段顺序与 OpenAI 一致）
 *  - buildOpenAIChatCompletionChunk: 构造流式 chunk
 *
 * 本模块只做响应格式化与脱敏，不触碰上游连接、认证或浏览器模拟逻辑。
 */

const openaiProfile = require('../agents/openai-compatible-profile.js');
const { sanitizeErrorMessage, containsSensitiveContext } = require('./provider-errors');

/**
 * 把任意 err / message 归一为 OpenAI error envelope
 * 绝不直接返回 HTML、上游 raw error、token、cookie、proxy 信息
 *
 * 脱敏逻辑（containsSensitiveContext / HTML 检测 / 截断）复用自
 * provider-errors.js 的 sanitizeErrorMessage，确保与 sendOpenAIError 行为一致。
 *
 * OpenAI 错误格式：
 *   {
 *     error: {
 *       message: string,
 *       type: 'invalid_request_error' | 'authentication_error' | 'rate_limit_error' | 'api_error' | 'permission_error' | 'not_found_error',
 *       param: string | null,
 *       code: string | null
 *     }
 *   }
 *
 * @param {Error|string|object|null} err
 * @param {Object} [options]
 * @param {string} [options.type] - 强制 error type
 * @param {string} [options.code] - 强制 error code
 * @param {string} [options.param] - 强制 error param
 * @param {number} [options.status] - HTTP status，用于判断 type
 * @returns {{ error: { message: string, type: string, param: string|null, code: string|null } }}
 */
const formatOpenAIError = (err, options = {}) => {
  const opts = options || {}

  // 1) 提取 message
  let rawMessage = ''
  if (typeof err === 'string') {
    rawMessage = err
  } else if (err && typeof err === 'object') {
    // 优先取 err.message；其次 OpenAI 风格 nested err.error.message
    rawMessage = err.message
      || (err.error && typeof err.error === 'object' ? err.error.message : '')
      || err.msg
      || ''
    if (typeof rawMessage !== 'string') rawMessage = String(rawMessage)
  } else {
    rawMessage = ''
  }

  // 2) 脱敏 + HTML 检测 + 截断 + 非空（复用 provider-errors.js 的 sanitizeErrorMessage）
  const safeMessage = sanitizeErrorMessage(rawMessage)

  // 3) 决定 type
  let type = opts.type
  if (!type) {
    const status = Number(opts.status) || 0
    if (status === 401) type = 'authentication_error'
    else if (status === 403) type = 'permission_error'
    else if (status === 404) type = 'not_found_error'
    else if (status === 429) type = 'rate_limit_error'
    else if (status >= 500) type = 'api_error'
    else if (status >= 400) type = 'invalid_request_error'
    else type = 'api_error'
  }

  return {
    error: {
      message: safeMessage,
      type,
      param: opts.param || null,
      code: opts.code || null
    }
  }
};

/**
 * 把内部模型数据规整为 OpenAI /v1/models 列表
 *
 * 行为：
 *  - 保留 id 字符串稳定
 *  - 不返回内部敏感字段（token / cookie / proxy / raw upstream JSON / account info）
 *  - 添加 provider 信息作为扩展（OpenAI 客户端会忽略未识别字段）
 *  - 限制字段为 OpenAI 规范白名单 + 扩展
 *
 * @param {Array<object>} models - 内部模型数组
 * @returns {{ object: 'list', data: Array<object> }}
 */
const formatOpenAIModelList = (models) => {
  const out = []
  const list = Array.isArray(models) ? models : []

  for (const m of list) {
    if (!m || typeof m !== 'object') continue
    const id = String(m.id || m.name || m.upstream_id || '')
    if (!id) continue

    const ownedBy = typeof m.owned_by === 'string' && m.owned_by
      ? m.owned_by
      : (m.info?.meta?.owned_by || 'qwen')

    const entry = {
      id,
      object: openaiProfile.profile.modelObject,
      created: Number.isFinite(m.created) ? Number(m.created) : Math.floor(Date.now() / 1000),
      owned_by: ownedBy,
      // provider 字段用于客户端识别模型来源（OpenAI 客户端会忽略未识别字段）
      provider: ownedBy,
      display_name: typeof m.display_name === 'string' ? m.display_name : (m.name || id),
      // 标记能力（OpenAI 客户端会忽略）
      capabilities: Array.isArray(m.capabilities) ? m.capabilities : []
    }

    // 严格白名单：禁止任何含 token / cookie / proxy / password 字样的字段
    const blacklist = /token|cookie|proxy|password|secret|auth/i
    for (const k of Object.keys(entry)) {
      if (blacklist.test(k)) delete entry[k]
    }

    out.push(entry)
  }

  return {
    object: openaiProfile.profile.modelsListObject,
    data: out
  }
};

module.exports = {
  formatOpenAIError,
  formatOpenAIModelList,
  containsSensitiveContext,
  // 测试/外部访问 base profile
  openaiProfile: openaiProfile.profile
};
