'use strict'

/**
 * DeepSeek semantic retry policy.
 *
 * Transport retries are coordinated separately by retry-context. This module
 * only answers whether a tool/empty-response correction is semantically valid
 * for the current response; it never performs a retry or mutates a prompt.
 */

function requiresToolCall(toolChoice) {
  return toolChoice === 'required'
    || !!(toolChoice && typeof toolChoice === 'object'
      && toolChoice.type === 'function' && toolChoice.function?.name)
}

function requiredToolName(toolChoice) {
  if (!toolChoice || typeof toolChoice !== 'object') return null
  const name = toolChoice.function?.name
  return typeof name === 'string' && name.trim() ? name.trim() : null
}

function hasRequiredToolCall(toolCalls, toolChoice) {
  if (!requiresToolCall(toolChoice)) return true
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) return false
  const requestedName = requiredToolName(toolChoice)
  if (!requestedName) return true
  return toolCalls.some(call => {
    const name = call?.function?.name || call?.name
    return name === requestedName
  })
}

function createToolCallRequiredError(toolChoice) {
  const requestedName = requiredToolName(toolChoice)
  const error = new Error(requestedName
    ? `DeepSeek did not produce the required tool call: ${requestedName}`
    : 'DeepSeek did not produce a required tool call')
  error.code = 'tool_call_required'
  error.statusCode = 422
  error.requestedTool = requestedName
  return error
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * @param {Object} options
 * @param {string|Object} options.toolChoice
 * @param {boolean} options.hasTools
 * @param {boolean} [options.hasToolCalls]
 * @param {string} options.reason - required|generic|no-tool-nudge|empty
 * @param {string} [options.responseText]
 * @param {string} [options.thinkingText]
 * @param {boolean} [options.explicitToolIntent]
 */
function shouldRetrySemantic(options = {}) {
  const {
    toolChoice,
    hasTools,
    hasToolCalls = false,
    reason,
    responseText = '',
    thinkingText = '',
    explicitToolIntent = false,
  } = options

  if (!hasTools || hasToolCalls || toolChoice === 'none') return false

  if (requiresToolCall(toolChoice)) {
    return reason === 'required' || reason === 'empty'
  }

  if (reason === 'generic' || reason === 'no-tool-nudge') {
    if (!hasText(responseText) && hasText(thinkingText)) return false
    return explicitToolIntent
  }

  // An actually empty upstream response is a transport/semantic boundary
  // case. One correction is allowed, but a normal answer must never enter
  // this path merely because tools were present in the request.
  if (reason === 'empty') {
    // THINK-only completions are not usable turns. Allow the existing single
    // empty-response retry to request a final answer or tool call.
    return !hasText(responseText)
  }

  return false
}

module.exports = {
  requiresToolCall,
  requiredToolName,
  hasRequiredToolCall,
  createToolCallRequiredError,
  shouldRetrySemantic,
}
