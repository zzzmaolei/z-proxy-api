/**
 * client.js
 *
 * Qwen Web chat 反代的 HTTP 客户端封装。
 *
 * 暴露的语义方法（不改变现有业务接口）：
 *  - createChat({ token, account, baseUrl, model })            -> { chatId, raw }
 *  - sendChatCompletion({ token, account, baseUrl, chatId, body, responseType, timeout })
 *
 * 设计：
 *  - 内部使用统一 upstream-client（keepAlive + 代理复用）
 *  - 错误经 errors.classifyAxiosError 归类后抛出
 *  - 响应经 normalizer.normalizeChatCreateResponse 归一
 *
 * 模块边界：
 *  - 只封装已知 HTTP 请求，不引入浏览器自动化或 TLS 指纹逻辑
 *  - 不动态抓取路径
 */

const { getChatBaseUrl } = require('../../utils/proxy-helper')
const upstream = require('../../backends/qwen/upstream-client')
const { buildQwenHeaders } = require('./headers')
const { PATHS, buildUrl, buildChatCompletionsUrl } = require('./endpoints')
const {
  normalizeChatCreateResponse
} = require('./normalizer')
const {
  classifyAxiosError,
  createQwenError,
  ERROR_KINDS
} = require('./errors')

/**
 * 创建一个 chat 会话（generateChatID 用）
 *
 * @param {Object} options
 * @param {string} options.token       - Bearer token
 * @param {Object} [options.account]   - 账号对象（用于代理解析）
 * @param {string} [options.baseUrl]   - 覆盖 chat base URL
 * @param {string} options.model       - 模型名
 * @returns {Promise<{ chatId: string, raw: any }>}
 */
const createChat = async (options) => {
  const opts = options || {}
  if (!opts.token) {
    throw createQwenError(ERROR_KINDS.AUTH_ERROR, 'createChat: 缺少 token', {
      where: 'createChat'
    })
  }
  if (!opts.model) {
    throw createQwenError(ERROR_KINDS.UPSTREAM_SCHEMA_CHANGED, 'createChat: 缺少 model', {
      where: 'createChat'
    })
  }

  const baseUrl = opts.baseUrl || getChatBaseUrl()
  const url = buildUrl(baseUrl, PATHS.chatsNew)

  const requestConfig = await upstream.buildRequestConfig({
    token: opts.token,
    account: opts.account,
    baseUrl,
    extraHeaders: buildQwenHeaders({ baseUrl, token: opts.token, account: opts.account }),
    extraConfig: {
      responseType: 'json',
      timeout: 30 * 1000
    }
  })

  const payload = {
    title: 'New Chat',
    models: [opts.model],
    chat_mode: 'normal',
    chat_type: opts.chatType || 't2t',
    timestamp: Date.now()
  }

  let response
  try {
    response = await upstream.postJson(url, payload, requestConfig)
  } catch (err) {
    throw classifyAxiosError(err)
  }

  if (response.status !== 200) {
    throw createQwenError(
      ERROR_KINDS.UPSTREAM_SCHEMA_CHANGED,
      `createChat 状态异常 status=${response.status}`,
      { where: 'createChat', status: response.status, rawPreview: previewOfSafe(response.data) }
    )
  }

  return normalizeChatCreateResponse(response.data)
}

/**
 * 发送 chat completion（始终 stream=true，responseType 可由调用方覆盖）。
 *
 * 业务层仍然按 `axios` stream 模式拿到原始 stream，自己做 SSE 解析。
 * provider/client 不解析 SSE，只把上游原样返回（业务侧在 anthropic.js / chat.js
 * 内部已经处理）。
 *
 * @param {Object} options
 * @param {string} options.token
 * @param {Object} [options.account]
 * @param {string} [options.baseUrl]
 * @param {string} options.chatId
 * @param {Object} options.body        - 上游请求体（必须含 stream）
 * @param {string} [options.responseType='stream']
 * @param {number} [options.timeout=60000]
 * @returns {Promise<import('axios').AxiosResponse>} axios 原始响应
 */
const sendChatCompletion = async (options) => {
  const opts = options || {}
  if (!opts.token) {
    throw createQwenError(ERROR_KINDS.AUTH_ERROR, 'sendChatCompletion: 缺少 token', {
      where: 'sendChatCompletion'
    })
  }
  if (!opts.chatId) {
    throw createQwenError(ERROR_KINDS.UPSTREAM_SCHEMA_CHANGED, 'sendChatCompletion: 缺少 chatId', {
      where: 'sendChatCompletion'
    })
  }
  if (!_isObj(opts.body)) {
    throw createQwenError(ERROR_KINDS.UPSTREAM_SCHEMA_CHANGED, 'sendChatCompletion: 缺少 body', {
      where: 'sendChatCompletion'
    })
  }

  const baseUrl = opts.baseUrl || getChatBaseUrl()
  const url = buildChatCompletionsUrl(baseUrl, opts.chatId)

  const requestConfig = await upstream.buildRequestConfig({
    token: opts.token,
    account: opts.account,
    baseUrl,
    extraHeaders: buildQwenHeaders({ baseUrl, token: opts.token, account: opts.account }),
    extraConfig: {
      responseType: opts.responseType || 'stream',
      timeout: typeof opts.timeout === 'number' ? opts.timeout : 60 * 1000
    }
  })

  try {
    return await upstream.postJson(url, opts.body, requestConfig)
  } catch (err) {
    throw classifyAxiosError(err)
  }
}

/* ---------------- 内部 ---------------- */

const _isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)

const previewOfSafe = (data, maxLen = 400) => {
  if (data == null) return ''
  if (Buffer.isBuffer(data)) return data.toString('utf-8').slice(0, maxLen)
  if (typeof data === 'string') return data.slice(0, maxLen)
  try {
    return JSON.stringify(data).slice(0, maxLen)
  } catch (_) {
    return String(data).slice(0, maxLen)
  }
}

module.exports = {
  createChat,
  sendChatCompletion
}
