'use strict'

// 官方 Web 端底层实测支持 2MB~3MB+ 超长吞吐，现将预算上限对齐至 256K tokens 级别 (约 1MB~1.5MB UTF-8)
const DEFAULT_SOFT_LIMIT = 1000000
const DEFAULT_HARD_LIMIT = 1500000

function positiveLimit(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function getPromptLimits(options = {}) {
  const configuredSoftLimit = positiveLimit(
    options.softLimit ?? process.env.DPSK_PROMPT_SOFT_LIMIT,
    DEFAULT_SOFT_LIMIT,
  )
  const configuredHardLimit = positiveLimit(
    options.hardLimit ?? process.env.DPSK_PROMPT_HARD_LIMIT,
    DEFAULT_HARD_LIMIT,
  )
  const modelLimit = positiveLimit(
    options.inputCharacterLimit
      ?? options.modelCapabilities?.input_character_limit
      ?? options.capabilities?.input_character_limit,
    Number.MAX_SAFE_INTEGER,
  )
  const hardLimit = Math.min(configuredHardLimit, modelLimit)
  const softLimit = Math.min(configuredSoftLimit, hardLimit)
  return { softLimit, hardLimit }
}

function measurePromptBudget(prompt, metadata = {}, options = {}) {
  const text = typeof prompt === 'string' ? prompt : String(prompt || '')
  const bytes = Buffer.byteLength(text, 'utf8')
  const { softLimit, hardLimit } = getPromptLimits(options)
  const status = bytes >= hardLimit ? 'hard_limit' : (bytes >= softLimit ? 'soft_limit' : 'ok')
  return {
    status,
    bytes,
    tokenEstimate: Math.ceil(bytes / 4),
    softLimit,
    hardLimit,
    messageCount: Number.isFinite(metadata.messageCount) ? metadata.messageCount : null,
    toolCount: Number.isFinite(metadata.toolCount) ? metadata.toolCount : null,
    hasToolHistory: metadata.hasToolHistory === true,
  }
}

/**
 * Build a semantic retry prompt without bypassing the Web prompt budget.
 *
 * Retry hints are user-visible protocol instructions, so they must be
 * measured together with the original prompt.  Callers can decide whether
 * a hard-limit result should become a protocol error or simply suppress an
 * optional correction retry.
 */
function buildRetryPrompt(basePrompt, hint, metadata = {}, options = {}) {
  const base = typeof basePrompt === 'string' ? basePrompt : String(basePrompt || '')
  const suffix = typeof hint === 'string' ? hint.trim() : String(hint || '').trim()
  const prompt = suffix ? `${base}\n---\nuser:${suffix}` : base
  const budget = measurePromptBudget(prompt, metadata, options)
  return {
    prompt,
    budget,
    allowed: budget.status !== 'hard_limit',
  }
}

function createPromptTooLargeError(budget) {
  const error = new Error(
    `DeepSeek prompt exceeds Web budget (${budget.bytes} bytes >= ${budget.hardLimit} bytes)`,
  )
  error.code = 'dpsk_prompt_too_large'
  error.statusCode = 413
  error.budget = budget
  return error
}

module.exports = {
  DEFAULT_SOFT_LIMIT,
  DEFAULT_HARD_LIMIT,
  getPromptLimits,
  measurePromptBudget,
  buildRetryPrompt,
  createPromptTooLargeError,
}
