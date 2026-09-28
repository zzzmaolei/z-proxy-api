/**
 * Qwen 3.8 双模型 A/B 实验脚本
 *
 * 用法：
 *   ENABLE_QWEN_LIVE_TESTS=true node .test/test-qwen-ab-experiment.js
 *
 * 实验维度：
 *   - 模型：qwen3.8-max-preview, qwen3.8-max-preview-thinking
 *   - thinking 配置：off, low, medium, high（仅对 thinking 模型有效）
 *   - thinking_budget：4096, 8192, 16384, 32768, 65536, 131072
 *   - 场景：short_qa, code_gen, long_translation, multi_turn, tool_call, image_understanding
 *   - 每组跑 5 次（默认，可通过 QWEN_AB_RUNS 环境变量调整，范围 5-10）
 *
 * 输出指标：
 *   - TTFT (Time To First Token) p50/p95
 *   - 总耗时 p50/p95
 *   - 内容字符数 p50/p95
 *   - 成功率
 *   - SSE 事件数
 *
 * 输出格式：
 *   - 控制台表格
 *   - JSON 报告文件 .test/results/ab-experiment-<timestamp>.json
 *
 * Gating：
 *   - 默认所有测试 skip，仅当 ENABLE_QWEN_LIVE_TESTS=true 时执行
 *   - 服务运行在 http://localhost:9090（可通过 QWEN_TEST_BASE_URL 覆盖）
 */

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const http = require('http')
const fs = require('fs')
const path = require('path')

const config = require('../src/config/index.js')

const BASE_URL = process.env.QWEN_TEST_BASE_URL || 'http://localhost:9090'
const API_KEY = config.adminKey || process.env.QWEN_TEST_API_KEY || ''
const ENABLE_LIVE = process.env.ENABLE_QWEN_LIVE_TESTS === 'true'
const RUNS_PER_CONFIG = Math.max(1, Math.min(10, parseInt(process.env.QWEN_AB_RUNS || '5', 10)))
const REQUEST_TIMEOUT_MS = 120000
// 单个测试用例最多 5 runs × 120s + 60s 缓冲
const TEST_TIMEOUT_MS = RUNS_PER_CONFIG * REQUEST_TIMEOUT_MS + 60000

const MODELS = ['qwen3.8-max-preview', 'qwen3.8-max-preview-thinking']
const THINKING_CONFIGS = ['off', 'low', 'medium', 'high']
const THINKING_BUDGETS = [4096, 8192, 16384, 32768, 65536, 131072]
const DEFAULT_BUDGET_FOR_CONFIG_EXPERIMENT = 32768
const DEFAULT_CONFIG_FOR_BUDGET_EXPERIMENT = 'medium'

// ──────────────── 6 种场景的 prompt ────────────────

const SCENARIOS = {
    short_qa: {
        name: '短问答',
        messages: [{ role: 'user', content: '什么是闭包？用一句话解释。' }]
    },
    code_gen: {
        name: '代码生成',
        messages: [{ role: 'user', content: '用 Python 写一个二分查找函数，包含注释和类型提示。' }]
    },
    long_translation: {
        name: '长文翻译',
        messages: [{ role: 'user', content: '将以下英文翻译成中文：\n\nThe quick brown fox jumps over the lazy dog. This sentence contains every letter of the English alphabet. It has been used for centuries to test typewriters and computer keyboards. Today, it remains a useful tool for designers and developers who need to verify that text rendering works correctly across different fonts and devices.' }]
    },
    multi_turn: {
        name: '多轮对话',
        messages: [
            { role: 'user', content: '你好' },
            { role: 'assistant', content: '你好！有什么可以帮你的？' },
            { role: 'user', content: '请告诉我今天的天气' },
            { role: 'assistant', content: '我无法获取实时天气数据，建议你查看天气预报应用。' },
            { role: 'user', content: '那你能做什么？' }
        ]
    },
    tool_call: {
        name: '工具调用',
        messages: [{ role: 'user', content: '请读取 /etc/hosts 文件的内容' }],
        tools: [{
            type: 'function',
            function: {
                name: 'read_file',
                description: '读取文件内容',
                parameters: {
                    type: 'object',
                    properties: { path: { type: 'string', description: '文件路径' } },
                    required: ['path']
                }
            }
        }]
    },
    image_understanding: {
        name: '图片理解',
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: '描述这张图片' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' } }
            ]
        }]
    }
}

// ──────────────── Helpers ────────────────

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms))
}

/**
 * 构建请求 options，覆盖多种 thinking 参数风格，让反代层选择其支持的
 */
function buildOptions(thinkingConfig, thinkingBudget) {
    const options = { max_tokens: 4096 }
    if (thinkingConfig === 'off') {
        options.enable_thinking = false
        options.reasoning_effort = 'minimal'
        options.thinking = { type: 'disabled' }
    } else {
        options.enable_thinking = true
        options.reasoning_effort = thinkingConfig
        options.thinking = { type: 'enabled', budget_tokens: thinkingBudget }
        options.thinking_budget = thinkingBudget
    }
    return options
}

// ──────────────── SSE 请求 ────────────────

/**
 * 发送 SSE 流式请求，返回 { ttft, totalTime, contentLength, eventCount, success, ... }
 * - TTFT: 从请求发送到首个 content delta 的时间（不含 reasoning_content）
 * - contentLength: 所有 content delta 的字符数总和
 * - eventCount: 收到的 SSE 事件数（不含 [DONE]）
 */
function sendRequest(model, messages, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    return new Promise((resolve) => {
        const bodyObj = {
            model,
            messages,
            stream: true,
            ...options
        }
        const body = JSON.stringify(bodyObj)

        const url = new URL(BASE_URL + '/v1/chat/completions')
        const startTime = Date.now()
        let ttft = null
        let contentLength = 0
        let reasoningLength = 0
        let eventCount = 0
        let buffer = ''
        let sawDone = false
        let firstByteTime = null

        const req = http.request({
            hostname: url.hostname,
            port: url.port || 80,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'Accept': 'text/event-stream'
            },
            timeout: timeoutMs
        }, (res) => {
            const contentType = res.headers['content-type'] || ''
            const isSSE = contentType.includes('text/event-stream')

            // 非 SSE 响应（通常是错误 JSON）
            if (!isSSE) {
                const chunks = []
                res.on('data', c => chunks.push(c))
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf-8')
                    resolve({
                        ttft: null,
                        totalTime: Date.now() - startTime,
                        firstByteTime: null,
                        contentLength: 0,
                        reasoningLength: 0,
                        eventCount: 0,
                        success: false,
                        statusCode: res.statusCode,
                        error: `non-SSE (${contentType || 'no-ct'}): ${raw.slice(0, 200)}`
                    })
                })
                return
            }

            res.on('data', (chunk) => {
                if (firstByteTime === null) firstByteTime = Date.now()
                buffer += chunk.toString('utf-8')

                // 按空行（支持 CRLF/LF）切分 SSE 事件
                const parts = buffer.split(/\r?\n\r?\n/)
                buffer = parts.pop() // 最后一段可能不完整，保留

                for (const eventStr of parts) {
                    if (!eventStr.trim()) continue
                    const lines = eventStr.split(/\r?\n/)
                    for (const line of lines) {
                        const trimmed = line.trim()
                        if (!trimmed.startsWith('data:')) continue
                        const data = trimmed.slice(5).trim()
                        if (!data) continue
                        if (data === '[DONE]') {
                            sawDone = true
                            continue
                        }
                        try {
                            const json = JSON.parse(data)
                            eventCount++
                            const delta = json.choices && json.choices[0] && json.choices[0].delta
                            if (delta) {
                                if (typeof delta.content === 'string' && delta.content.length > 0) {
                                    if (ttft === null) {
                                        ttft = Date.now() - startTime
                                    }
                                    contentLength += delta.content.length
                                }
                                if (typeof delta.reasoning_content === 'string') {
                                    reasoningLength += delta.reasoning_content.length
                                }
                            }
                        } catch (_) {
                            // 忽略无法解析的 JSON
                        }
                    }
                }
            })

            res.on('end', () => {
                const totalTime = Date.now() - startTime
                const success = res.statusCode === 200 && (eventCount > 0 || sawDone)
                resolve({
                    ttft,
                    totalTime,
                    firstByteTime: firstByteTime !== null ? firstByteTime - startTime : null,
                    contentLength,
                    reasoningLength,
                    eventCount,
                    success,
                    statusCode: res.statusCode
                })
            })
        })

        req.on('error', (err) => {
            const totalTime = Date.now() - startTime
            resolve({
                ttft: null,
                totalTime,
                firstByteTime: null,
                contentLength: 0,
                reasoningLength: 0,
                eventCount: 0,
                success: false,
                statusCode: 0,
                error: err.message
            })
        })

        req.on('timeout', () => {
            req.destroy()
            const totalTime = Date.now() - startTime
            resolve({
                ttft: null,
                totalTime,
                firstByteTime: null,
                contentLength: 0,
                reasoningLength: 0,
                eventCount: 0,
                success: false,
                statusCode: 0,
                error: 'timeout'
            })
        })

        req.write(body)
        req.end()
    })
}

// ──────────────── 统计 ────────────────

/**
 * 计算 p50/p95/mean/min/max
 */
function computeStats(values) {
    const valid = (values || []).filter(v => v !== null && v !== undefined && !Number.isNaN(v))
    if (valid.length === 0) {
        return { count: 0, min: null, max: null, mean: null, p50: null, p95: null }
    }
    const sorted = [...valid].sort((a, b) => a - b)
    const sum = sorted.reduce((a, b) => a + b, 0)
    const mean = sum / sorted.length
    const p50Index = Math.min(Math.floor(sorted.length * 0.5), sorted.length - 1)
    const p95Index = Math.min(Math.floor(sorted.length * 0.95), sorted.length - 1)
    return {
        count: sorted.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        mean: Math.round(mean),
        p50: sorted[p50Index],
        p95: sorted[p95Index]
    }
}

// ──────────────── 跑一组实验 ────────────────

/**
 * 跑一组实验：固定 model + thinkingConfig + thinkingBudget + scenario，重复 runs 次
 * 返回 { config, results, stats }
 */
async function runExperiment(model, thinkingConfig, thinkingBudget, scenarioKey, runs) {
    const scenario = SCENARIOS[scenarioKey]
    const options = buildOptions(thinkingConfig, thinkingBudget)
    if (scenario.tools) {
        options.tools = scenario.tools
    }

    const results = []
    for (let i = 0; i < runs; i++) {
        const result = await sendRequest(model, scenario.messages, options)
        result.run = i + 1
        results.push(result)
        if (i < runs - 1) await sleep(300) // 同组内 300ms 间隔
    }

    const successResults = results.filter(r => r.success)
    const ttftValues = successResults.map(r => r.ttft).filter(v => v !== null)
    const totalTimeValues = successResults.map(r => r.totalTime)
    const contentLengthValues = successResults.map(r => r.contentLength)
    const eventCountValues = successResults.map(r => r.eventCount)

    return {
        config: {
            model,
            thinkingConfig,
            thinkingBudget: thinkingConfig === 'off' ? null : thinkingBudget,
            scenario: scenarioKey,
            scenarioName: scenario.name,
            runs
        },
        results,
        stats: {
            successCount: successResults.length,
            successRate: runs > 0 ? successResults.length / runs : 0,
            ttft: computeStats(ttftValues),
            totalTime: computeStats(totalTimeValues),
            contentLength: computeStats(contentLengthValues),
            eventCount: computeStats(eventCountValues)
        }
    }
}

// ──────────────── 控制台表格 ────────────────

function pad(str, len, alignRight = false) {
    const s = String(str)
    if (s.length >= len) return s.slice(0, len)
    const padding = ' '.repeat(len - s.length)
    return alignRight ? padding + s : s + padding
}

function formatTable(results) {
    if (!Array.isArray(results) || results.length === 0) return

    const headers = [
        'Model', 'Think', 'Budget', 'Scenario', 'Runs', 'OK',
        'TTFT p50', 'TTFT p95',
        'Total p50', 'Total p95',
        'Content p50', 'Content p95',
        'Events p50'
    ]
    const widths = [28, 6, 7, 18, 4, 3, 9, 9, 9, 9, 10, 10, 9]

    const headerLine = headers.map((h, i) => pad(h, widths[i], i >= 4)).join(' | ')
    const separator = widths.map(w => '-'.repeat(w)).join('-+-')

    console.log('\n' + headerLine)
    console.log(separator)

    for (const r of results) {
        const s = r.stats
        const row = [
            r.config.model,
            r.config.thinkingConfig,
            r.config.thinkingBudget !== null ? r.config.thinkingBudget : '-',
            r.config.scenario,
            r.config.runs,
            s.successCount,
            s.ttft.p50 !== null ? s.ttft.p50 + 'ms' : '-',
            s.ttft.p95 !== null ? s.ttft.p95 + 'ms' : '-',
            s.totalTime.p50 !== null ? s.totalTime.p50 + 'ms' : '-',
            s.totalTime.p95 !== null ? s.totalTime.p95 + 'ms' : '-',
            s.contentLength.p50 !== null ? s.contentLength.p50 : '-',
            s.contentLength.p95 !== null ? s.contentLength.p95 : '-',
            s.eventCount.p50 !== null ? s.eventCount.p50 : '-'
        ]
        console.log(row.map((v, i) => pad(v, widths[i], i >= 4)).join(' | '))
    }
}

// ──────────────── 保存 JSON 报告 ────────────────

function saveReport(results) {
    if (!Array.isArray(results) || results.length === 0) return null

    const resultsDir = path.join(__dirname, 'results')
    if (!fs.existsSync(resultsDir)) {
        fs.mkdirSync(resultsDir, { recursive: true })
    }

    const now = new Date()
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename = `ab-experiment-${timestamp}.json`
    const filepath = path.join(resultsDir, filename)

    const report = {
        timestamp: now.toISOString(),
        baseUrl: BASE_URL,
        runsPerConfig: RUNS_PER_CONFIG,
        models: MODELS,
        thinkingConfigs: THINKING_CONFIGS,
        thinkingBudgets: THINKING_BUDGETS,
        scenarios: Object.fromEntries(
            Object.entries(SCENARIOS).map(([k, v]) => [k, v.name])
        ),
        results
    }

    fs.writeFileSync(filepath, JSON.stringify(report, null, 2))
    console.log(`\nReport saved to: ${filepath}`)
    return filepath
}

// ──────────────── 测试用例 ────────────────

describe('Qwen 3.8 A/B experiment', () => {
    const allResults = []
    let proxyAvailable = false

    before(async () => {
        if (!ENABLE_LIVE) {
            console.log('\n[SKIP] ENABLE_QWEN_LIVE_TESTS != true — all tests will be skipped')
            return
        }
        console.log(`\n[INFO] Base URL: ${BASE_URL}`)
        console.log(`[INFO] API Key: ${API_KEY ? '***' + API_KEY.slice(-4) : '(empty)'}`)
        console.log(`[INFO] Runs per config: ${RUNS_PER_CONFIG}`)
        console.log(`[INFO] Models: ${MODELS.join(', ')}`)
        console.log(`[INFO] Test timeout: ${TEST_TIMEOUT_MS}ms`)

        // 连通性检查
        try {
            console.log('[INFO] Checking proxy availability...')
            const check = await sendRequest(
                MODELS[0],
                SCENARIOS.short_qa.messages,
                buildOptions('off', 4096),
                15000
            )
            proxyAvailable = check.statusCode !== 0
            if (proxyAvailable) {
                console.log(`[INFO] Proxy reachable (HTTP ${check.statusCode}, ${check.totalTime}ms, success=${check.success})`)
            } else {
                console.log(`[WARN] Proxy not reachable: ${check.error || 'no response'}`)
            }
        } catch (e) {
            console.log(`[WARN] Proxy check failed: ${e.message}`)
        }
    })

    after(() => {
        if (allResults.length === 0) {
            console.log('\n[INFO] No results collected (tests skipped or all failed)')
            return
        }
        console.log('\n' + '='.repeat(120))
        console.log('FINAL CONSOLIDATED REPORT')
        console.log('='.repeat(120))
        formatTable(allResults)
        saveReport(allResults)
    })

    // ─── 实验 1：thinking 配置（4 configs × 6 scenarios × N runs × 2 models）───
    describe('A/B experiment: thinking config', () => {
        for (const model of MODELS) {
            for (const thinkingConfig of THINKING_CONFIGS) {
                for (const scenarioKey of Object.keys(SCENARIOS)) {
                    const scenarioName = SCENARIOS[scenarioKey].name
                    test(`${model} | thinking=${thinkingConfig} | ${scenarioKey}(${scenarioName})`, { timeout: TEST_TIMEOUT_MS }, async (t) => {
                        if (!ENABLE_LIVE) {
                            t.skip('ENABLE_QWEN_LIVE_TESTS != true')
                            return
                        }
                        if (!proxyAvailable) {
                            t.skip('proxy not available')
                            return
                        }

                        try {
                            const result = await runExperiment(
                                model,
                                thinkingConfig,
                                DEFAULT_BUDGET_FOR_CONFIG_EXPERIMENT,
                                scenarioKey,
                                RUNS_PER_CONFIG
                            )
                            allResults.push(result)
                            const s = result.stats
                            console.log(`  → OK ${s.successCount}/${result.config.runs} | TTFT p50=${s.ttft.p50 ?? '-'}ms | total p50=${s.totalTime.p50 ?? '-'}ms | content p50=${s.contentLength.p50 ?? '-'}`)
                            assert.equal(result.results.length, RUNS_PER_CONFIG, 'results count should match runs')
                        } catch (err) {
                            console.error(`  → ERROR: ${err.message}`)
                            // 不 rethrow，让其他测试继续跑
                        }
                    })
                }
            }
        }
    })

    // ─── 实验 2：thinking budget（6 budgets × 6 scenarios × N runs × 2 models）───
    describe('A/B experiment: thinking budget', () => {
        for (const model of MODELS) {
            for (const thinkingBudget of THINKING_BUDGETS) {
                for (const scenarioKey of Object.keys(SCENARIOS)) {
                    const scenarioName = SCENARIOS[scenarioKey].name
                    test(`${model} | budget=${thinkingBudget} | ${scenarioKey}(${scenarioName})`, { timeout: TEST_TIMEOUT_MS }, async (t) => {
                        if (!ENABLE_LIVE) {
                            t.skip('ENABLE_QWEN_LIVE_TESTS != true')
                            return
                        }
                        if (!proxyAvailable) {
                            t.skip('proxy not available')
                            return
                        }

                        try {
                            const result = await runExperiment(
                                model,
                                DEFAULT_CONFIG_FOR_BUDGET_EXPERIMENT,
                                thinkingBudget,
                                scenarioKey,
                                RUNS_PER_CONFIG
                            )
                            allResults.push(result)
                            const s = result.stats
                            console.log(`  → OK ${s.successCount}/${result.config.runs} | TTFT p50=${s.ttft.p50 ?? '-'}ms | total p50=${s.totalTime.p50 ?? '-'}ms | content p50=${s.contentLength.p50 ?? '-'}`)
                            assert.equal(result.results.length, RUNS_PER_CONFIG, 'results count should match runs')
                        } catch (err) {
                            console.error(`  → ERROR: ${err.message}`)
                        }
                    })
                }
            }
        }
    })
})
