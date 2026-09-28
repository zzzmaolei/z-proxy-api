'use strict'

function contentToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(part => {
    if (typeof part === 'string') return part
    if (!part || typeof part !== 'object') return ''
    if (typeof part.text === 'string') return part.text
    if (typeof part.output_text === 'string') return part.output_text
    return ''
  }).join('')
}

function outputToText(output) {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) {
    return output.map(value => {
      if (typeof value === 'string') return value
      if (value && typeof value.text === 'string') return value.text
      return value == null ? '' : JSON.stringify(value)
    }).filter(Boolean).join('\n')
  }
  return output && typeof output === 'object' ? JSON.stringify(output) : ''
}

function normalizeResponsesInput(body = {}) {
  const items = []
  if (body.instructions) {
    items.push({ type: 'message', role: 'system', content: String(body.instructions) })
  }
  if (typeof body.input === 'string') {
    items.push({ type: 'message', role: 'user', content: body.input })
  } else if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (item && typeof item === 'object') items.push(JSON.parse(JSON.stringify(item)))
    }
  }
  return items
}

function conversationItemsToMessages(items) {
  const messages = []
  for (const item of items || []) {
    if (!item || typeof item !== 'object') continue
    if (item.type === 'message') {
      messages.push({ role: item.role || 'user', content: contentToText(item.content) })
      continue
    }
    if (item.type === 'function_call' || item.type === 'tool_call') {
      const callId = item.call_id || item.id || ''
      const toolCall = {
        id: callId,
        type: 'function',
        function: {
          name: item.name || item.function?.name || item.tool_name || 'unknown',
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments || {}),
        },
      }
      const previous = messages[messages.length - 1]
      if (previous?.role === 'assistant' && Array.isArray(previous.tool_calls)) previous.tool_calls.push(toolCall)
      else messages.push({ role: 'assistant', content: null, tool_calls: [toolCall] })
      continue
    }
    if (item.type === 'function_call_output' || item.type === 'tool_result') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id || item.id || '',
        content: outputToText(item.output ?? item.content ?? item.result),
      })
    }
  }
  return messages
}

function responsesToChatCompletions(body, defaultModel, previousState = null) {
  const currentItems = normalizeResponsesInput(body)
  const priorItems = Array.isArray(previousState?.conversationItems) ? previousState.conversationItems : []
  const messages = conversationItemsToMessages([...priorItems, ...currentItems])
  const chatBody = { model: body.model || defaultModel || null, messages }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    chatBody.tools = body.tools.map(tool => tool.function ? tool : {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: tool.input_schema || tool.parameters || { type: 'object', properties: {} },
      },
    })
    chatBody.tool_choice = body.tool_choice || 'auto'
    if (chatBody.tool_choice && typeof chatBody.tool_choice === 'object' && chatBody.tool_choice.name && !chatBody.tool_choice.function) {
      chatBody.tool_choice = {
        type: chatBody.tool_choice.type || 'function',
        function: { name: chatBody.tool_choice.name },
      }
    }
  }
  if (typeof body.max_output_tokens === 'number' && body.max_output_tokens > 0) chatBody.max_tokens = body.max_output_tokens
  if (body.reasoning_effort) chatBody.reasoning_effort = body.reasoning_effort
  return chatBody
}

function buildContinuationSnapshot(previousState, currentItems, outputItems, now = Date.now()) {
  const previous = Array.isArray(previousState?.conversationItems) ? previousState.conversationItems : []
  return {
    conversationItems: [...previous, ...(currentItems || []), ...(outputItems || [])],
    createdAt: now,
  }
}

function chatCompletionToResponsesOutput(data, responseId) {
  const choice = data?.choices?.[0]
  if (!choice) return []
  const message = choice.message || {}
  const output = []
  if (typeof message.content === 'string' && message.content.length > 0) {
    output.push({
      id: `${responseId}_msg`, type: 'message', status: 'completed', role: 'assistant',
      content: [{ type: 'output_text', text: message.content, annotations: [] }],
    })
  }
  for (const toolCall of message.tool_calls || []) {
    const callId = toolCall.id || `call_${responseId}`
    output.push({
      id: `fc_${responseId}_${output.length}`,
      type: 'function_call', status: 'completed', call_id: callId,
      name: toolCall.function?.name || 'unknown',
      arguments: toolCall.function?.arguments || '{}',
    })
  }
  return output
}

async function translateChatCompletionResponse(data, options) {
  const createdAt = data?.created || Math.floor(Date.now() / 1000)
  if (!data?.choices) {
    const error = data?.error || {}
    return {
      id: options.responseId, object: 'response', created_at: createdAt,
      status: 'failed', model: options.model, output: [],
      error: { type: error.type || 'api_error', code: error.code, message: error.message || data?.message || 'Invalid upstream response' },
    }
  }
  const output = chatCompletionToResponsesOutput(data, options.responseId)
  if (output.length === 0) {
    return {
      id: options.responseId, object: 'response', created_at: createdAt,
      status: 'failed', model: data.model || options.model, output: [],
      error: { type: 'api_error', code: 'upstream_empty_response', message: 'Upstream returned no response output' },
    }
  }
  await options.persistOutput(output)
  const usage = data.usage || {}
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0
  const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0
  return {
    id: options.responseId, object: 'response', created_at: createdAt,
    status: 'completed', model: data.model || options.model, output,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      total_tokens: usage.total_tokens ?? (inputTokens + outputTokens),
      output_tokens_details: usage.output_tokens_details || { reasoning_tokens: 0 },
    },
  }
}

module.exports = {
  normalizeResponsesInput,
  conversationItemsToMessages,
  responsesToChatCompletions,
  buildContinuationSnapshot,
  chatCompletionToResponsesOutput,
  translateChatCompletionResponse,
  contentToText,
  outputToText,
}
