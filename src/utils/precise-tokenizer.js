/**
 * precise-tokenizer.js
 *
 * Token usage 计数策略：
 *  - 一次 usage 统计最多创建一次 tiktoken encoding（之前每条消息都 encoding_for_model / free）
 *  - 上游有 usage 时优先用上游 usage
 *  - 新增 TOKEN_USAGE_MODE: estimate | precise | auto
 *    - estimate: 轻量字符估算，避免长上下文 CPU 卡顿
 *    - precise : 用 tiktoken 准确计数（一次 encoding 复用）
 *    - auto    : 上游有 usage 用上游，否则按 estimate
 *  - 所有统计失败都不影响主响应
 */

const config = require('../config/index.js')

// 缓存一个 per-model 的 encoding，进程内复用
let _encodingCache = null
let _encodingCacheModel = null

const _getEncoding = (model) => {
  if (_encodingCache && _encodingCacheModel === model) return _encodingCache
  try {
    const tiktoken = require('tiktoken')
    _encodingCache = tiktoken.encoding_for_model(model)
    _encodingCacheModel = model
    return _encodingCache
  } catch (_) {
    return null
  }
}

/**
 * 字符估算 token 数（中英文混合：1 字符 ≈ 1 token；纯中文 ≈ 1 字符；纯英文按 0.25 字符/token）
 * 比 tiktoken 慢 30-50 倍，比 chatGPT 接口读取还快
 */
const estimateTokens = (text) => {
  if (!text || typeof text !== 'string') return 0
  let total = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code >= 0x4e00 && code <= 0x9fff) {
      // CJK Unified Ideographs：每个汉字约 1.5 token
      total += 1.5
    } else if (code < 0x80) {
      // ASCII：每 4 字符约 1 token
      total += 0.25
    } else {
      // 其它（扩展字符 / 标点等）：每个 1 token
      total += 1
    }
  }
  return Math.round(total)
}

/**
 * 使用 tiktoken 准确计数（一个 encoding 复用）
 */
const countTokens = (text, model = 'gpt-3.5-turbo', mode = null) => {
  if (!text || typeof text !== 'string') return 0
  // 解析 mode：未传则读取全局配置，保证与 countMessagesTokens 行为一致
  // 仅 precise 模式强制走 tiktoken；auto / estimate / fast 走字符估算
  // （auto 模式无上游 usage 时按 estimate 处理，与 countMessagesTokens 一致；
  //   传入未知 mode 时安全 fallback 到 estimate，不污染 tiktoken 缓存）
  const resolvedMode = mode || config.tokenUsageMode || 'estimate'
  if (resolvedMode !== 'precise') {
    return estimateTokens(text)
  }
  const encoding = _getEncoding(model)
  if (!encoding) return estimateTokens(text)
  try {
    const tokens = encoding.encode(text)
    return tokens.length
  } catch (_) {
    return estimateTokens(text)
  }
}

/**
 * 计算消息数组的 token 数量
 * 一次调用只创建一次 encoding（之前是每条消息都创建/释放）
 */
const countMessagesTokens = (messages, model = 'gpt-3.5-turbo') => {
  if (!Array.isArray(messages)) return 0
  const mode = config.tokenUsageMode || 'estimate'
  const usePrecise = mode === 'precise'  // auto 模式无上游 usage 时走 estimate，与文档一致

  let totalTokens = 0
  const messageOverhead = 4

  if (usePrecise) {
    const encoding = _getEncoding(model)
    if (encoding) {
      try {
        for (const message of messages) {
          totalTokens += messageOverhead
          if (message && message.role) totalTokens += encoding.encode(String(message.role)).length
          if (typeof message?.content === 'string') {
            totalTokens += encoding.encode(message.content).length
          } else if (Array.isArray(message?.content)) {
            for (const item of message.content) {
              if (item && item.text) totalTokens += encoding.encode(String(item.text)).length
            }
          }
          if (message && message.function_call) {
            totalTokens += encoding.encode(JSON.stringify(message.function_call)).length
          }
        }
        totalTokens += 2
        return totalTokens
      } catch (_) { /* fallthrough to estimate */ }
    }
  }

  // estimate 模式（或 precise 失败时回退）
  for (const message of messages) {
    totalTokens += messageOverhead
    if (message && message.role) totalTokens += Math.max(1, Math.round(String(message.role).length / 4))
    if (typeof message?.content === 'string') {
      totalTokens += estimateTokens(message.content)
    } else if (Array.isArray(message?.content)) {
      for (const item of message.content) {
        if (item && item.text) totalTokens += estimateTokens(String(item.text))
      }
    }
    if (message && message.function_call) {
      totalTokens += estimateTokens(JSON.stringify(message.function_call))
    }
  }
  totalTokens += 2
  return totalTokens
}

/**
 * 构造 usage 对象。
 * 优先级：上游 usage > precise > estimate
 */
const createUsageObject = (promptMessages, completionText = '', realUsage = null, model = 'gpt-3.5-turbo') => {
  // 1) 优先：上游真实 usage
  if (realUsage && (realUsage.prompt_tokens || realUsage.completion_tokens)) {
    return {
      prompt_tokens: Number(realUsage.prompt_tokens) || 0,
      completion_tokens: Number(realUsage.completion_tokens) || 0,
      total_tokens: Number(realUsage.total_tokens) || ((Number(realUsage.prompt_tokens) || 0) + (Number(realUsage.completion_tokens) || 0))
    }
  }

  // 2) auto 模式无上游 usage 时回退到字符估算，不再返回 0
  // 估算 / 精准
  let promptTokens = 0
  if (Array.isArray(promptMessages)) {
    promptTokens = countMessagesTokens(promptMessages, model)
  } else if (typeof promptMessages === 'string') {
    promptTokens = countTokens(promptMessages, model)
  }
  const completionTokens = countTokens(completionText, model)
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens
  }
}

module.exports = {
  countTokens,
  countMessagesTokens,
  createUsageObject,
  estimateTokens
}
