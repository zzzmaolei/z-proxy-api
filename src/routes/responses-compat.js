/** OpenAI Responses API → chat/completions compatibility route. */
'use strict'

const crypto = require('node:crypto')
const express = require('express')
const router = express.Router()
const config = require('../config')
const { apiKeyVerify } = require('../middlewares/authorization')
const { logger } = require('../utils/logger')
const { countTokens } = require('../utils/precise-tokenizer')
const { PROVIDERS, getProviderForModel } = require('../providers/registry')
const { getDpskDefaultModel } = require('../controllers/dpsk-models.js')
const { createResponseStateStore } = require('../utils/response-state-store')
const { detectRuntimeTopology } = require('../utils/runtime-topology')
const {
  normalizeResponsesInput,
  responsesToChatCompletions,
  buildContinuationSnapshot,
  translateChatCompletionResponse,
} = require('../utils/responses-compat-core')
const { installResponsesStreamTranslator } = require('../utils/responses-stream-translator')

const PROVIDER_CONTROLLERS = Object.fromEntries(PROVIDERS.map(provider => [provider.name, provider.controller]))
const topology = detectRuntimeTopology()
const responseStateStore = createResponseStateStore({ mode: config.dataSaveMode, topology })

if (responseStateStore.available && topology.isLeader) {
  setInterval(() => {
    responseStateStore.cleanup().catch(error => {
      logger.warn(`[Responses-Compat] continuation cleanup failed: ${error.message}`, 'RESP')
    })
  }, 10 * 60 * 1000).unref()
}

function findProvider(model) {
  return getProviderForModel(model)?.name || null
}

function responsesError(res, status, code, message) {
  return res.status(status).json({
    error: { type: 'invalid_request_error', code, message },
  })
}

function installNonStreamTranslator(res, options) {
  const originalJson = res.json.bind(res)
  let translation = null
  res.json = data => {
    if (translation) return res
    translation = (async () => {
      try {
        return originalJson(await translateChatCompletionResponse(data, options))
      } catch (error) {
        res.statusCode = 500
        return originalJson({
          id: options.responseId, object: 'response', created_at: data.created || Math.floor(Date.now() / 1000),
          status: 'failed', model: data.model || options.model, output: [],
          error: { type: 'api_error', code: error.code || 'response_state_persistence_failed', message: error.message },
        })
      }
    })()
    return res
  }
  return {
    async wait() {
      if (!translation) throw new Error('Upstream did not produce a JSON response')
      await translation
    },
  }
}

router.post('/v1/responses', apiKeyVerify, async (req, res) => {
  let streamTranslator = null
  try {
    const body = req.body || {}
    const isStream = !!body.stream
    const model = body.model || await getDpskDefaultModel()
    if (!model) return responsesError(res, 400, 'model_required', 'Model is required and could not be determined automatically')

    const provider = findProvider(model)
    if (!provider) {
      return responsesError(res, 400, 'unsupported_model', `model '${model}' is not supported on /v1/responses endpoint`)
    }

    let previousState = null
    if (body.previous_response_id) {
      previousState = await responseStateStore.get(body.previous_response_id)
      if (!previousState) {
        return responsesError(
          res,
          400,
          'previous_response_not_found',
          `Previous response '${body.previous_response_id}' was not found or has expired`
        )
      }
    }

    const currentItems = normalizeResponsesInput(body)
    const chatBody = responsesToChatCompletions(body, model, previousState)
    chatBody.stream = isStream
    req.body = chatBody
    req._responsesApi = true

    const responseId = `resp_${provider}_${crypto.randomUUID().replace(/-/g, '')}`
    const persistOutput = async output => {
      const snapshot = buildContinuationSnapshot(previousState, currentItems, output)
      await responseStateStore.set(responseId, snapshot)
    }
    const promptTokens = countTokens(JSON.stringify(chatBody.messages || []), model)

    logger.info(`[Responses-Compat] ${model} → ${provider} (stream=${isStream})`, 'RESP')
    res.set('x-response-provider', provider)
    res.set('x-response-compat', 'responses-api-v1')

    let nonStreamTranslator = null
    if (isStream) {
      res.set({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      if (typeof res.flushHeaders === 'function') res.flushHeaders()
      streamTranslator = installResponsesStreamTranslator(res, {
        model, responseId, inputTokens: promptTokens, persistOutput, countTokens,
      })
    } else {
      nonStreamTranslator = installNonStreamTranslator(res, { model, responseId, persistOutput })
    }

    const controller = PROVIDER_CONTROLLERS[provider]
    await controller(req, res, () => {
      res.status(400).json({ error: { message: `模型 ${model} 无可用 provider`, type: 'invalid_request_error' } })
    })

    if (isStream) await streamTranslator.waitForEnd()
    else await nonStreamTranslator.wait()
  } catch (error) {
    logger.error('[Responses-Compat] 处理失败', 'RESP', '', error)
    if (streamTranslator) {
      streamTranslator._beginFailure(error.code || 'responses_compat_error', error.message || 'Responses compatibility failure')
      await streamTranslator.end().catch(() => {})
    } else if (!res.headersSent) {
      res.status(500).json({ error: { message: error.message, type: 'api_error', code: error.code } })
    }
  }
})

module.exports = router
module.exports._responseStateStore = responseStateStore
module.exports._installNonStreamTranslator = installNonStreamTranslator
