/**
 * src/agents/index.js
 *
 * Unified export point for client profile detection and profile modules.
 *
 * 导出：
 *   - profiles                 : { [name]: { profile, ...helpers } }
 *   - getProfile(name)         : 取一个 profile 模块（找不到返回兜底）
 *   - detectClientProfile      : 见 profile-detector.js
 *   - getDefaultProfile        : 见 profile-detector.js
 *   - isProfileCompatible      : 见 profile-detector.js
 *   - HEADER_NAME              : x-qwen-client-profile
 */

const claudeCode = require('./claude-code-profile.js')
const genericAnthropic = require('./generic-anthropic-profile.js')
const openaiCompatible = require('./openai-compatible-profile.js')
const hermesAgent = require('./hermes-agent-profile.js')

const detector = require('./profile-detector.js')

const profiles = Object.freeze({
  'claude-code': claudeCode,
  'generic-anthropic': genericAnthropic,
  'openai-compatible': openaiCompatible,
  'hermes-agent': hermesAgent
})

const PROFILE_FALLBACK_ORDER = Object.freeze([
  'claude-code',
  'openai-compatible',
  'generic-anthropic',
  'hermes-agent'
])

/**
 * 按 name 取 profile 模块；找不到则返回第一个可用兜底
 * @param {string} name
 * @returns {Object|null}
 */
const getProfile = (name) => {
  if (name && Object.prototype.hasOwnProperty.call(profiles, name)) {
    return profiles[name]
  }
  for (const fallback of PROFILE_FALLBACK_ORDER) {
    if (profiles[fallback]) return profiles[fallback]
  }
  return null
}

module.exports = {
  // profile 模块
  profiles,
  getProfile,
  // 直接 re-export profile 模块的 getFlag / helpers（方便调用方写 import 一次）
  claudeCode,
  genericAnthropic,
  openaiCompatible,
  hermesAgent,
  // detector
  detectClientProfile: detector.detectClientProfile,
  getDefaultProfile: detector.getDefaultProfile,
  isProfileCompatible: detector.isProfileCompatible,
  HEADER_NAME: detector.HEADER_NAME,
  PROFILE_NAMES: detector.PROFILE_NAMES,
  PROTOCOL_ALLOWED: detector.PROTOCOL_ALLOWED,
  PROTOCOL_DEFAULT: detector.PROTOCOL_DEFAULT
}
