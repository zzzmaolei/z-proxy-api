/**
 * generic-anthropic-profile.js
 *
 * Generic Anthropic Messages API compatibility profile.
 *
 * 用于"非 Claude Code" 的 Anthropic 兼容客户端（其他 SDK、第三方 agent、
 * 自建工具、调试用 curl 等等）。它和 claude-code-profile 共用协议（anthropic），
 * 但不应用 Claude Code 特有的严苛策略：
 *   - 不丢 preamble（让客户端能看到自然语言）
 *   - 不强制 stop_reason=tool_use（保持上游原始语义）
 *   - 通用纠偏重试默认 0
 *
 * This profile intentionally keeps strict Claude Code behavior disabled.
 */

const profile = Object.freeze({
  name: 'generic-anthropic',
  version: '1.0.0',
  protocol: 'anthropic',
  // 行为开关（与 claude-code-profile 对照——刻意关闭）
  strictToolUse: false,
  dropToolPreamble: false,
  requireStopReasonToolUse: false,
  maxCorrectionRetry: 0,
  supportsThinking: 'partial',
  supportsContextManagement: false,
  // 兼容性 notice 默认走 debug 通道
  compatibilityWarningLevel: 'debug'
})

/**
 * 读取 profile 字段
 * @param {string} key
 * @returns {boolean|number|string|Array|undefined}
 */
const getFlag = (key) => {
  if (!Object.prototype.hasOwnProperty.call(profile, key)) return undefined
  return profile[key]
}

module.exports = {
  profile,
  getFlag
}
