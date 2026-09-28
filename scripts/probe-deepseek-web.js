'use strict'

/**
 * Opt-in DeepSeek Web capability probe.
 *
 * This script never loads account storage and never prints the token, proxy,
 * prompt text, file contents, or a session id. It creates a fresh Web session
 * for every matrix point so the result measures the provider boundary rather
 * than session-history reuse.
 *
 * Required environment:
 *   ZPROXY_TEST_LOAD_ENV=true
 *   DPSK_PROBE_ENABLE=true
 *   DPSK_PROBE_TOKEN=<dedicated test token>
 *
 * Optional environment:
 *   DPSK_PROBE_MODEL=deepseek-default
 *   DPSK_PROBE_INPUT_TOKENS=8192,10240,16384,32768,50000
 *   DPSK_PROBE_OUTPUT_TOKENS=128,512,2048,5120
 *   DPSK_PROBE_THINKING=false,true
 *   DPSK_PROBE_MAX_CASES=24
 *   DPSK_PROBE_DELAY_MS=1000
 *   DPSK_PROBE_CASE_TIMEOUT_MS=700000
 *   DPSK_PROBE_PROXY_URL=<optional proxy, never printed>
 *   DPSK_PROBE_OUTPUT_FILE=<optional JSONL destination>
 */

const fs = require('node:fs')
const path = require('node:path')
const dpskClient = require('../src/backends/deepseek/dpsk-client')
const dpskFingerprint = require('../src/backends/deepseek/dpsk-fingerprint')

const enabled = String(process.env.ZPROXY_TEST_LOAD_ENV || '').toLowerCase() === 'true'
  && String(process.env.DPSK_PROBE_ENABLE || '').toLowerCase() === 'true'
  && typeof process.env.DPSK_PROBE_TOKEN === 'string'
  && process.env.DPSK_PROBE_TOKEN.trim().length > 0

if (!enabled) {
  console.error('[deepseek-probe] opt-in required: set ZPROXY_TEST_LOAD_ENV=true, DPSK_PROBE_ENABLE=true, and DPSK_PROBE_TOKEN')
  process.exitCode = 2
  return
}

const token = process.env.DPSK_PROBE_TOKEN.trim()
const proxyUrl = process.env.DPSK_PROBE_PROXY_URL || null
const fingerprint = dpskFingerprint.getFingerprint('deepseek-capability-probe')

function parseList(name, fallback, parser) {
  const raw = process.env[name]
  const values = String(raw || fallback).split(',').map(value => parser(value.trim())).filter(value => value !== null)
  return values.length > 0 ? values : fallback.split(',').map(value => parser(value.trim())).filter(value => value !== null)
}

function positiveInt(value, fallback) {
  const number = Number.parseInt(value, 10)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

const inputTokens = parseList('DPSK_PROBE_INPUT_TOKENS', '8192,10240,16384,32768,50000', value => {
  const number = Number.parseInt(value, 10)
  return Number.isFinite(number) && number > 0 ? number : null
})
const outputTokens = parseList('DPSK_PROBE_OUTPUT_TOKENS', '128,512,2048,5120', value => {
  const number = Number.parseInt(value, 10)
  return Number.isFinite(number) && number > 0 ? number : null
})
const thinkingModes = parseList('DPSK_PROBE_THINKING', 'false,true', value => {
  if (value === 'true' || value === '1' || value === 'on') return true
  if (value === 'false' || value === '0' || value === 'off') return false
  return null
})
const maxCases = positiveInt(process.env.DPSK_PROBE_MAX_CASES, 24)
const delayMs = Number.parseInt(process.env.DPSK_PROBE_DELAY_MS || '1000', 10)
const caseTimeoutMs = positiveInt(process.env.DPSK_PROBE_CASE_TIMEOUT_MS, 700000)

function safeError(error) {
  const message = String(error?.message || error || 'unknown error')
    .replace(/Bearer\s+[^\s]+/ig, 'Bearer [REDACTED]')
    .replace(/(?:token|cookie|authorization|api[_-]?key)\s*[=:]\s*[^\s,;]+/ig, '$1=[REDACTED]')
  return {
    code: error?.code || null,
    name: error?.name || null,
    message: message.slice(0, 240),
  }
}

function makePrompt(targetTokens) {
  const prefix = `Capability probe input ${targetTokens} tokens. `
  const targetBytes = targetTokens * 4
  const remaining = Math.max(0, targetBytes - Buffer.byteLength(prefix, 'utf8'))
  return prefix + 'x'.repeat(remaining)
}

function sleep(ms) {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve()
}

async function runCase(model, inputTokenTarget, outputTokenTarget, thinkingEnabled, index) {
  const startedAt = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), caseTimeoutMs)
  let sessionCreated = false
  let firstYieldAt = null
  let textBytes = 0
  let thinkingBytes = 0
  let yieldCount = 0
  let sawDone = false
  let terminal = 'none'
  let error = null
  try {
    const resolved = dpskClient.resolveModelOptions(model.id, {
      thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' },
    })
    const session = await dpskClient.createSession(token, proxyUrl, fingerprint, controller.signal)
    sessionCreated = !!session?.id
    const prompt = makePrompt(inputTokenTarget)
    const generator = dpskClient.sendChatMessage(token, session.id, prompt, {
      modelType: resolved.modelType,
      thinkingEnabled,
      maxTokens: outputTokenTarget,
      proxyUrl,
      fingerprint,
      parentMessageId: null,
      signal: controller.signal,
    })
    for await (const chunk of generator) {
      yieldCount += 1
      if (firstYieldAt === null) firstYieldAt = Date.now()
      if (chunk?.type === 'text') textBytes += Buffer.byteLength(String(chunk.content || ''), 'utf8')
      if (chunk?.type === 'thinking') thinkingBytes += Buffer.byteLength(String(chunk.content || ''), 'utf8')
      if (chunk?.type === 'done') {
        sawDone = true
        terminal = 'done'
      }
    }
    if (!sawDone) terminal = 'eof_without_done'
  } catch (caught) {
    error = safeError(caught)
    terminal = controller.signal.aborted ? 'client_timeout_abort' : 'error'
  } finally {
    clearTimeout(timeout)
  }
  return {
    index,
    model: model.id,
    model_type: model.model_type || null,
    input_tokens_requested: inputTokenTarget,
    output_tokens_requested: outputTokenTarget,
    thinking_enabled: thinkingEnabled,
    prompt_bytes_requested: inputTokenTarget * 4,
    session_created: sessionCreated,
    terminal,
    saw_done: sawDone,
    yield_count: yieldCount,
    text_bytes: textBytes,
    thinking_bytes: thinkingBytes,
    ttfb_ms: firstYieldAt === null ? null : firstYieldAt - startedAt,
    total_ms: Date.now() - startedAt,
    error,
  }
}

async function main() {
  const requestedModel = process.env.DPSK_PROBE_MODEL || ''
  let models = []
  if (requestedModel) {
    models = [{ id: requestedModel, model_type: dpskClient.resolveModelOptions(requestedModel).modelType }]
  } else {
    models = await dpskClient.getModels(token, { proxy: proxyUrl, email: 'capability-probe' })
  }
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error('No DeepSeek models available for the probe')
  }

  const matrix = []
  for (const model of models) {
    for (const inputTarget of inputTokens) {
      for (const outputTarget of outputTokens) {
        for (const thinking of thinkingModes) {
          matrix.push({ model, inputTarget, outputTarget, thinking })
        }
      }
    }
  }
  const selected = matrix.slice(0, maxCases)
  const metadata = {
    type: 'deepseek_web_capability_probe',
    started_at: new Date().toISOString(),
    model_count: models.length,
    case_count: selected.length,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    thinking_modes: thinkingModes,
    case_timeout_ms: caseTimeoutMs,
  }
  const lines = [JSON.stringify(metadata)]
  process.stdout.write(`${lines[0]}\n`)
  for (let index = 0; index < selected.length; index += 1) {
    const point = selected[index]
    const result = await runCase(point.model, point.inputTarget, point.outputTarget, point.thinking, index)
    const line = JSON.stringify(result)
    lines.push(line)
    process.stdout.write(`${line}\n`)
    await sleep(Number.isFinite(delayMs) ? delayMs : 0)
  }

  const outputFile = process.env.DPSK_PROBE_OUTPUT_FILE
  if (outputFile) {
    const target = path.resolve(outputFile)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `${lines.join('\n')}\n`, 'utf8')
    process.stdout.write(`[deepseek-probe] wrote redacted JSONL to ${path.basename(target)}\n`)
  }
}

main().catch(error => {
  process.stderr.write(`[deepseek-probe] failed: ${safeError(error).message}\n`)
  process.exitCode = 1
})
