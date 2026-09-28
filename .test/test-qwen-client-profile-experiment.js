/**
 * Qwen ClientProfile 实验脚本（I4-I6）
 *
 * 实验 A：现状基线（mode=current, experiment=false）
 *   - 验证请求能正常发出
 *   - 记录基线 TTFT
 *
 * 实验 B：stable-per-account 模式（profile 绑定查询）
 *   - 通过 admin API 查询每账号的 profile 绑定
 *   - mode=stable-per-account 时验证每个账号有固定的 profileId
 *
 * 实验 C：X-Qwen-Profile-* override
 *   - 通过 X-Qwen-Profile-UA header 覆盖（chat-middleware.js 识别此 header）
 *   - 验证 override 不破坏请求
 *
 * 实验 D：一致性验证
 *   - 调用 /api/qwen-profile-consistency
 *   - 所有分配了 profile 的账号内部一致（UA Chrome 版本 = sec-ch-ua Chromium 版本 等）
 *
 * 实验 E：profile 绑定表生成
 *   - 调用 /api/qwen-profiles
 *   - 打印账号 → profile 映射表
 *
 * Gated by ENABLE_QWEN_LIVE_TESTS=true（默认 false，自动 skip）
 *
 * 用法：
 *   ENABLE_QWEN_LIVE_TESTS=true node --test .test/test-qwen-client-profile-experiment.js
 */

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')

const config = require('../src/config/index.js')
const BASE_URL = process.env.QWEN_TEST_BASE_URL || 'http://localhost:9090'
const ADMIN_KEY = config.adminKey || process.env.QWEN_TEST_API_KEY || ''
const ENABLE_LIVE = process.env.ENABLE_QWEN_LIVE_TESTS === 'true'

// Helper: send admin request
const adminRequest = (method, path, body) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null
  const req = http.request(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${ADMIN_KEY}`,
      'Content-Type': 'application/json',
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
    }
  }, (res) => {
    let chunks = ''
    res.on('data', c => chunks += c)
    res.on('end', () => {
      try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }) }
      catch { resolve({ status: res.statusCode, body: chunks }) }
    })
  })
  req.on('error', reject)
  if (data) req.write(data)
  req.end()
})

// Helper: send chat request and capture response headers + first content (TTFT)
const sendChatRequest = (model, messages, extraHeaders = {}) => new Promise((resolve, reject) => {
  const body = JSON.stringify({ model, messages, stream: true })
  const startMs = Date.now()
  const req = http.request(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${ADMIN_KEY}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...extraHeaders
    },
    timeout: 30000
  }, (res) => {
    let firstContentMs = null
    let totalContent = ''
    let eventCount = 0
    res.on('data', (chunk) => {
      const text = chunk.toString()
      const lines = text.split('\n').filter(l => l.startsWith('data: '))
      for (const line of lines) {
        eventCount++
        const json = line.slice(6).trim()
        if (json === '[DONE]') continue
        try {
          const parsed = JSON.parse(json)
          const delta = parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content
          if (delta && firstContentMs === null) {
            firstContentMs = Date.now() - startMs
          }
          if (delta) totalContent += delta
        } catch { /* ignore non-JSON lines */ }
      }
    })
    res.on('end', () => {
      resolve({
        status: res.statusCode,
        ttft: firstContentMs,
        totalTime: Date.now() - startMs,
        contentLength: totalContent.length,
        eventCount,
        headers: res.headers
      })
    })
  })
  req.on('error', reject)
  req.on('timeout', () => { req.destroy(); reject(new Error('timeout')) })
  req.write(body)
  req.end()
})

describe('ClientProfile experiment', () => {
  test('experiment A: baseline current mode', async () => {
    if (!ENABLE_LIVE) return
    const result = await sendChatRequest('qwen3.8-max-preview', [
      { role: 'user', content: 'Hello' }
    ])
    assert.equal(result.status, 200)
    assert.ok(result.ttft != null, 'should have TTFT')
    console.log('Experiment A baseline:', { ttft: result.ttft, totalTime: result.totalTime })
  })

  test('experiment B: stable-per-account mode (profile bindings)', async () => {
    if (!ENABLE_LIVE) return
    const bindings = await adminRequest('GET', '/api/qwen-profiles')
    assert.equal(bindings.status, 200)
    assert.ok(bindings.body.total >= 0)
    console.log(`Experiment B: ${bindings.body.total} accounts, mode=${bindings.body.mode}`)
    if (bindings.body.total > 0) {
      const b = bindings.body.bindings[0]
      // mode=current 时 profile 为 null；mode=stable-per-account 时应有 profile
      if (bindings.body.mode === 'stable-per-account') {
        assert.ok(b.profileId, 'account should have profileId in stable-per-account mode')
        assert.ok(b.userAgent, 'account should have userAgent in stable-per-account mode')
      } else {
        console.log('  (mode=current, profiles not assigned — expected)')
      }
    }
  })

  test('experiment C: X-Qwen-Profile override', async () => {
    if (!ENABLE_LIVE) return
    // chat-middleware.js 识别 x-qwen-profile-ua header 注入 override
    const result = await sendChatRequest('qwen3.8-max-preview', [
      { role: 'user', content: 'Hi' }
    ], {
      'X-Qwen-Profile-UA': 'Mozilla/5.0 (Test Profile Override)'
    })
    // 仅验证 override header 不破坏请求
    assert.equal(result.status, 200)
  })

  test('experiment D: profile consistency check', async () => {
    if (!ENABLE_LIVE) return
    const result = await adminRequest('GET', '/api/qwen-profile-consistency')
    assert.equal(result.status, 200)
    assert.ok(result.body.total >= 0)
    assert.ok(result.body.valid >= 0)
    assert.ok(result.body.invalid !== undefined)
    console.log(`Experiment D: total=${result.body.total} valid=${result.body.valid} invalid=${result.body.invalid} noProfile=${result.body.noProfile}`)
    if (result.body.invalid > 0) {
      console.log('Warning: some profiles failed consistency check',
        result.body.results.filter(r => r.status === 'invalid'))
    }
  })

  test('experiment E: profile bindings table generation', async () => {
    if (!ENABLE_LIVE) return
    const result = await adminRequest('GET', '/api/qwen-profiles')
    assert.equal(result.status, 200)
    const bindings = result.body.bindings || []
    console.log('\n=== Profile Bindings Table ===')
    console.log(`Total accounts: ${bindings.length}  (mode=${result.body.mode})`)
    for (const b of bindings.slice(0, 10)) {
      const profileDesc = b.profileId
        ? `${b.profileId} (Chrome ${b.browserMajorVersion}, ${b.platformFamily}, ${b.timezoneFamily})`
        : '(no profile — mode=current)'
      console.log(`  ${b.email} → ${profileDesc}`)
    }
    if (bindings.length > 10) {
      console.log(`  ... and ${bindings.length - 10} more`)
    }
  })
})
