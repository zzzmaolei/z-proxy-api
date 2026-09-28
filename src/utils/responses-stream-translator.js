'use strict'

const SSEFrameParser = require('./sse-frame-parser')
const { SafeSseWriter } = require('./safe-sse-writer')

class ResponsesStreamTranslator {
  constructor(options) {
    this.res = options.res
    this.model = options.model
    this.responseId = options.responseId
    this.createdAt = options.createdAt || Math.floor(Date.now() / 1000)
    this.persistOutput = options.persistOutput || (async () => {})
    this.countTokens = options.countTokens || (() => 0)
    this.parser = new SSEFrameParser()
    this.writer = new SafeSseWriter(this.res, { write: options.write, end: options.end })
    this.sequence = 0
    this.nextOutputIndex = 0
    this.message = null
    this.toolsByUpstreamIndex = new Map()
    this.tools = []
    this.inputTokens = options.inputTokens || 0
    this.outputTokens = 0
    this.finalizing = false
    this.finalized = false
    this._finalization = null
    this._endPromise = null
    this._emit('response.created', { response: this._response('in_progress', []) })
    this._emit('response.in_progress', { response: this._response('in_progress', []) })
  }

  _usage() {
    return {
      input_tokens: this.inputTokens,
      output_tokens: this.outputTokens,
      total_tokens: this.inputTokens + this.outputTokens,
      output_tokens_details: { reasoning_tokens: 0 },
    }
  }

  _response(status, output, error) {
    const response = {
      id: this.responseId, object: 'response', created_at: this.createdAt,
      status, model: this.model, output, usage: this._usage(),
    }
    if (error) response.error = error
    return response
  }

  _emit(type, payload = {}) {
    if (this.writer.closed || this.writer.ended) return false
    const event = { type, sequence_number: ++this.sequence, ...payload }
    return this.writer.write(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`)
  }

  _ensureMessage() {
    if (this.message) return this.message
    this.message = {
      id: `${this.responseId}_msg`,
      outputIndex: this.nextOutputIndex++,
      text: '',
    }
    this._emit('response.output_item.added', {
      output_index: this.message.outputIndex,
      item: { id: this.message.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
    })
    this._emit('response.content_part.added', {
      item_id: this.message.id, output_index: this.message.outputIndex, content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    })
    return this.message
  }

  _toolSlot(upstreamIndex) {
    const index = Number.isInteger(upstreamIndex) ? upstreamIndex : this.toolsByUpstreamIndex.size
    let tool = this.toolsByUpstreamIndex.get(index)
    if (!tool) {
      tool = { upstreamIndex: index, outputIndex: null, itemId: null, callId: null, name: null, arguments: '', pendingArguments: '' }
      this.toolsByUpstreamIndex.set(index, tool)
    }
    return tool
  }

  _startTool(tool) {
    if (tool.outputIndex !== null || !tool.callId || !tool.name) return
    tool.outputIndex = this.nextOutputIndex++
    tool.itemId = `fc_${this.responseId}_${tool.outputIndex}`
    this.tools.push(tool)
    this._emit('response.output_item.added', {
      output_index: tool.outputIndex,
      item: { id: tool.itemId, type: 'function_call', status: 'in_progress', name: tool.name, call_id: tool.callId, arguments: '' },
    })
    if (tool.pendingArguments) {
      tool.arguments += tool.pendingArguments
      this._emit('response.function_call_arguments.delta', {
        item_id: tool.itemId, output_index: tool.outputIndex, call_id: tool.callId, delta: tool.pendingArguments,
      })
      tool.pendingArguments = ''
    }
  }

  _handleToolDelta(toolCall) {
    const tool = this._toolSlot(toolCall.index)
    if (toolCall.id) tool.callId = tool.callId || toolCall.id
    if (toolCall.function?.name) tool.name = tool.name || toolCall.function.name
    this._startTool(tool)
    const args = toolCall.function?.arguments || ''
    if (!args) return
    if (tool.outputIndex === null) {
      tool.pendingArguments += args
      return
    }
    tool.arguments += args
    this._emit('response.function_call_arguments.delta', {
      item_id: tool.itemId, output_index: tool.outputIndex, call_id: tool.callId, delta: args,
    })
  }

  _handleEvent(event) {
    if (this.finalizing || this.finalized) return
    if (event.error) {
      this._beginFailure('upstream_sse_parse_error', event.error.message)
      return
    }
    if (event.data === '[DONE]') return
    const json = event.json
    if (!json) return
    if (json.error) {
      this._beginFailure(json.error.code || 'upstream_error', json.error.message || 'Upstream error')
      return
    }
    const choice = json.choices?.[0]
    if (!choice) return
    const delta = choice.delta || {}
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      const message = this._ensureMessage()
      message.text += delta.content
      this.outputTokens += this.countTokens(delta.content, this.model)
      this._emit('response.output_text.delta', {
        item_id: message.id, output_index: message.outputIndex, content_index: 0, delta: delta.content,
      })
    }
    for (const toolCall of delta.tool_calls || []) this._handleToolDelta(toolCall)
    if (choice.finish_reason) {
      if (choice.finish_reason === 'stop' || choice.finish_reason === 'tool_calls') this._beginComplete()
      else this._beginFailure('upstream_incomplete', `Upstream finished with reason ${choice.finish_reason}`)
    }
  }

  accept(chunk) {
    if (this.finalizing || this.finalized || this.writer.closed) return false
    for (const event of this.parser.feed(chunk)) this._handleEvent(event)
    return true
  }

  _buildOutput() {
    const output = []
    if (this.message) {
      output.push({
        outputIndex: this.message.outputIndex,
        item: {
          id: this.message.id, type: 'message', status: 'completed', role: 'assistant',
          content: [{ type: 'output_text', text: this.message.text, annotations: [] }],
        },
      })
    }
    for (const tool of this.tools) {
      output.push({
        outputIndex: tool.outputIndex,
        item: {
          id: tool.itemId, type: 'function_call', status: 'completed', call_id: tool.callId,
          name: tool.name, arguments: tool.arguments || '{}',
        },
      })
    }
    return output.sort((a, b) => a.outputIndex - b.outputIndex)
  }

  _emitItemDone(output) {
    for (const entry of output) {
      if (entry.item.type === 'message') {
        this._emit('response.output_text.done', {
          item_id: entry.item.id, output_index: entry.outputIndex, content_index: 0,
          text: entry.item.content[0].text,
        })
        this._emit('response.content_part.done', {
          item_id: entry.item.id, output_index: entry.outputIndex, content_index: 0,
          part: entry.item.content[0],
        })
      } else {
        this._emit('response.function_call_arguments.done', {
          item_id: entry.item.id, output_index: entry.outputIndex, call_id: entry.item.call_id,
          name: entry.item.name, arguments: entry.item.arguments,
        })
      }
      this._emit('response.output_item.done', { output_index: entry.outputIndex, item: entry.item })
    }
  }

  _beginComplete() {
    if (this._finalization) return this._finalization
    this.finalizing = true
    this._finalization = (async () => {
      const indexed = this._buildOutput()
      const output = indexed.map(entry => entry.item)
      this._emitItemDone(indexed)
      try {
        await this.persistOutput(output)
        this._emit('response.completed', { response: this._response('completed', output) })
      } catch (error) {
        this._emit('response.failed', {
          response: this._response('failed', output, {
            type: 'api_error', code: error.code || 'response_state_persistence_failed',
            message: error.message || 'Failed to persist response continuation',
          }),
        })
      }
      this.finalized = true
      this.finalizing = false
    })()
    return this._finalization
  }

  _beginFailure(code, message) {
    if (this._finalization) return this._finalization
    this.finalizing = true
    this._finalization = Promise.resolve().then(() => {
      const output = this._buildOutput().map(entry => entry.item)
      this._emit('response.failed', {
        response: this._response('failed', output, { type: 'api_error', code, message }),
      })
      this.finalized = true
      this.finalizing = false
    })
    return this._finalization
  }

  end(...args) {
    if (this._endPromise) return this._endPromise
    this._endPromise = (async () => {
      if (!this.finalizing && !this.finalized) {
        for (const event of this.parser.end()) this._handleEvent(event)
      }
      if (!this._finalization) this._beginFailure('upstream_stream_incomplete', 'Upstream stream ended before a terminal event')
      await this._finalization
      await this.writer.end(...args)
    })()
    return this._endPromise
  }
}

function installResponsesStreamTranslator(res, options) {
  const originalWrite = res.write.bind(res)
  const originalEnd = res.end.bind(res)
  const translator = new ResponsesStreamTranslator({ ...options, res, write: originalWrite, end: originalEnd })
  let requestedEnd = null
  res.write = chunk => {
    translator.accept(chunk)
    return true
  }
  res.end = (...args) => {
    requestedEnd = requestedEnd || translator.end(...args)
    return res
  }
  translator.waitForEnd = async () => {
    if (!requestedEnd) requestedEnd = translator.end()
    await requestedEnd
  }
  return translator
}

module.exports = { ResponsesStreamTranslator, installResponsesStreamTranslator }
