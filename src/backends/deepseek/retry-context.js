'use strict'

const crypto = require('node:crypto')
const dpskClient = require('./dpsk-client')
const { withRetry } = require('../../shared/retry')
const { logger } = require('../../utils/logger')

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function createDeepSeekAttemptCoordinator(options = {}) {
  const maxAttempts = positiveInt(options.maxAttempts ?? process.env.DPSK_MAX_CHAT_ATTEMPTS, 3)
  const maxTransportRetries = positiveInt(options.maxTransportRetries ?? process.env.DPSK_MAX_TRANSPORT_RETRIES, 1)
  const maxSemanticRetries = positiveInt(options.maxSemanticRetries ?? process.env.DPSK_MAX_SEMANTIC_RETRIES, 1)
  let attempts = 1
  let transportRetries = 0
  let semanticRetries = 0

  return {
    acquire(kind, reason) {
      const retryKind = kind === 'transport' ? 'transport' : 'semantic'
      const used = retryKind === 'transport' ? transportRetries : semanticRetries
      const limit = retryKind === 'transport' ? maxTransportRetries : maxSemanticRetries
      if (attempts >= maxAttempts || used >= limit) {
        const error = new Error(`DeepSeek retry budget exhausted (${retryKind}:${reason || 'unknown'})`)
        error.code = 'retry_budget_exhausted'
        throw error
      }
      attempts++
      if (retryKind === 'transport') transportRetries++
      else semanticRetries++
      return attempts
    },
    snapshot() {
      return { attempts, transportRetries, semanticRetries, maxAttempts, maxTransportRetries, maxSemanticRetries }
    },
  }
}

async function createFreshRetryContext(options) {
  const {
    token, account, chatOptions, retryReason, retryKind = 'semantic', coordinator,
    isDisconnected = () => false, client = dpskClient,
  } = options
  if (isDisconnected()) {
    const error = new Error('Client disconnected before DeepSeek retry')
    error.code = 'client_disconnected'
    throw error
  }
  const attempt = coordinator.acquire(retryKind, retryReason)
  const nextOptions = { ...chatOptions, parentMessageId: null }
  const session = await withRetry(
    () => client.createSession(token, nextOptions.proxyUrl, nextOptions.fingerprint, nextOptions.signal || null),
    { label: `createSession-${retryKind}-retry`, logTag: 'DPSK' }
  )
  if (isDisconnected()) {
    const error = new Error('Client disconnected during DeepSeek retry bootstrap')
    error.code = 'client_disconnected'
    throw error
  }
  const sessionId = session?.id
  if (!sessionId) {
    const error = new Error('DeepSeek retry session did not return an ID')
    error.code = 'retry_session_invalid'
    throw error
  }
  const sessionSummary = crypto.createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 10)
  logger.info(
    `[DPSK-RETRY] attempt=${attempt} kind=${retryKind} reason=${retryReason || 'unknown'} session=${sessionSummary} account=${account?.email ? 'selected' : 'unknown'}`,
    'DPSK'
  )
  return { attempt, chatSessionId: sessionId, chatOptions: nextOptions }
}

async function createFreshRetryGenerator(options) {
  const context = await createFreshRetryContext(options)
  return {
    ...context,
    generator: (options.client || dpskClient).sendChatMessage(
      options.token,
      context.chatSessionId,
      options.prompt,
      context.chatOptions
    ),
  }
}

function isRetryBudgetError(error) {
  return error?.code === 'retry_budget_exhausted' || error?.code === 'client_disconnected'
}

function isRetryableTransportError(error) {
  if (!error) return true
  if (error.bizCode !== undefined || error.contextTooLong) return false
  if (['dpsk_prompt_too_large', 'tool_call_required'].includes(error.code)) return false
  const status = Number(error.statusCode ?? error.status)
  if (Number.isFinite(status) && status >= 400 && status < 500) return false
  const message = String(error.message || '').toLowerCase()
  if (/\b(401|403|429)\b/.test(message)
    || message.includes('unauthorized')
    || message.includes('rate limit')
    || message.includes('too many')
    || message.includes('token')) return false
  return true
}

module.exports = {
  createDeepSeekAttemptCoordinator,
  createFreshRetryContext,
  createFreshRetryGenerator,
  isRetryBudgetError,
  isRetryableTransportError,
}
