/**
 * test-qwen-sse-fragmentation.js
 *
 * SSE 帧解析器的随机分片测试。
 *
 * 验证：无论 TCP 如何把字节流切成 chunk，SSEFrameParser 都能正确重组完整的
 * SSE 帧 —— 包括跨 chunk 的 UTF-8 多字节字符、CRLF 行尾、多行 data 字段、
 * 同 chunk 多事件，以及 [DONE] terminal。
 *
 * 使用 Node.js 内置 `node:test` 和 `node:assert/strict`，自包含，不依赖
 * 真实 API 凭证或网络。
 */

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { SSEFrameParser } = require('../src/utils/sse-frame-parser')

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把一串 chunk 依次喂给 parser，收集所有解析出的事件，最后调用 end() flush。
 * @param {SSEFrameParser} parser
 * @param {Array<Buffer|string>} chunks
 * @returns {Array<object>}
 */
function feedAll(parser, chunks) {
    const out = []
    for (const c of chunks) {
        const batch = parser.feed(c)
        for (const e of batch) out.push(e)
    }
    for (const e of parser.end()) out.push(e)
    return out
}

/**
 * 把一个 Buffer 随机切成大小在 [min, max] 区间的 chunk。
 * @param {Buffer} buf
 * @param {number} min
 * @param {number} max
 * @returns {Buffer[]}
 */
function randomSplitBytes(buf, min, max) {
    const chunks = []
    let pos = 0
    while (pos < buf.length) {
        const size = min + Math.floor(Math.random() * (max - min + 1))
        chunks.push(buf.subarray(pos, pos + size))
        pos += size
    }
    return chunks
}

/* ------------------------------------------------------------------ */
/* Canonical SSE stream                                               */
/* ------------------------------------------------------------------ */

/**
 * 构造一段典型 SSE 字节流，包含：
 *  1. role/initial delta（message_start 等价物）
 *  2. reasoning delta（含 CJK 多字节字符）
 *  3. content delta（含 CJK + 4 字节 emoji 🌍）
 *  4. 另一段 content delta（含 CJK 标点）
 *  5. tool call delta（arguments 内含 CJK 字符）
 *  6. [DONE] terminal
 *
 * @returns {{ bytes: Buffer, events: string[] }}
 */
function buildCanonicalStream() {
    const events = [
        // 1. role / initial delta
        'data: {"object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant","content":""}}]}',
        // 2. reasoning delta with CJK chars
        'data: {"object":"chat.completion.chunk","choices":[{"delta":{"reasoning_content":"让我思考一下这个问题..."}}]}',
        // 3. content delta with CJK + 4-byte emoji
        'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello 世界 🌍"}}]}',
        // 4. another content delta with CJK punctuation
        'data: {"object":"chat.completion.chunk","choices":[{"delta":{"content":"，这是测试。"}}]}',
        // 5. tool call with CJK in arguments
        'data: {"object":"chat.completion.chunk","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","function":{"name":"read_file","arguments":"{\\"path\\":\\"/tmp/测试文件.txt\\"}"}}]}}]}',
        // 6. terminal
        'data: [DONE]'
    ]
    const text = events.join('\n\n') + '\n\n'
    return { bytes: Buffer.from(text, 'utf8'), events }
}

/**
 * 验证解析出的事件序列与 canonical stream 完全一致。
 * 检查：事件数、role、reasoning、content（含 UTF-8）、tool calls、terminal、
 * 无 error、无重复。
 */
function verifyCanonical(events) {
    const expected = buildCanonicalStream().events
    assert.equal(
        events.length,
        expected.length,
        `event count: expected ${expected.length}, got ${events.length}`
    )

    // 最后一个事件必须是 [DONE]
    const last = events[events.length - 1]
    assert.equal(last.data, '[DONE]', 'last event data must be [DONE]')
    assert.equal(last.json, null, '[DONE] json must be null')
    assert.equal(last.error, null, '[DONE] error must be null')

    // event 0: role/initial delta
    const e0 = events[0].json
    assert.ok(e0, 'event 0 json must parse')
    assert.equal(e0.choices[0].delta.role, 'assistant')

    // event 1: reasoning
    const e1 = events[1].json
    assert.ok(e1, 'event 1 json must parse')
    assert.equal(e1.choices[0].delta.reasoning_content, '让我思考一下这个问题...')

    // event 2: content with UTF-8 + emoji (验证无乱码)
    const e2 = events[2].json
    assert.ok(e2, 'event 2 json must parse')
    assert.equal(e2.choices[0].delta.content, 'Hello 世界 🌍')

    // event 3: content with CJK punctuation
    const e3 = events[3].json
    assert.ok(e3, 'event 3 json must parse')
    assert.equal(e3.choices[0].delta.content, '，这是测试。')

    // event 4: tool call
    const e4 = events[4].json
    assert.ok(e4, 'event 4 json must parse')
    const tc = e4.choices[0].delta.tool_calls[0]
    assert.equal(tc.index, 0)
    assert.equal(tc.id, 'call_abc')
    assert.equal(tc.function.name, 'read_file')
    assert.equal(tc.function.arguments, '{"path":"/tmp/测试文件.txt"}')

    // 无任何 error
    for (let i = 0; i < events.length; i++) {
        assert.equal(
            events[i].error,
            null,
            `event ${i} should have no error: ${JSON.stringify(events[i].error)}`
        )
    }

    // 无重复（按 raw 文本）
    const raws = events.map(e => e.raw)
    const uniqueRaws = new Set(raws)
    assert.equal(
        uniqueRaws.size,
        raws.length,
        `duplicate raw events detected: ${raws.length - uniqueRaws.size} dupes`
    )
}

/* ------------------------------------------------------------------ */
/* Tests                                                              */
/* ------------------------------------------------------------------ */

describe('SSEFrameParser — 随机分片测试', () => {
    const { bytes: streamBytes } = buildCanonicalStream()

    test('baseline: 整段 stream 作为单 chunk（无分片）', () => {
        const parser = new SSEFrameParser()
        const events = feedAll(parser, [streamBytes])
        verifyCanonical(events)
    })

    test('100 轮随机分片（每 chunk 1-5 字节）', () => {
        for (let round = 0; round < 100; round++) {
            const parser = new SSEFrameParser()
            const chunks = randomSplitBytes(streamBytes, 1, 5)
            const events = feedAll(parser, chunks)
            try {
                verifyCanonical(events)
            } catch (err) {
                err.message = `round ${round} (chunks=${chunks.length}): ${err.message}`
                throw err
            }
        }
    })

    test('单字节分片（极端情况）', () => {
        const parser = new SSEFrameParser()
        const chunks = []
        for (let i = 0; i < streamBytes.length; i++) {
            chunks.push(streamBytes.subarray(i, i + 1))
        }
        const events = feedAll(parser, chunks)
        verifyCanonical(events)
    })

    test('UTF-8 多字节字符在中间被切（CJK 3 字节 + emoji 4 字节）', () => {
        // 单字节分片会自动把所有多字节 UTF-8 字符切到中间，
        // 这里额外做一个针对性测试：在 "世"（3 字节：0xE4 0xB8 0x96）的
        // 每个字节边界做切分，验证 TextDecoder {stream:true} 能正确重组。
        const text = streamBytes.toString('utf8')
        const charIdx = text.indexOf('世')
        assert.ok(charIdx >= 0, 'stream 必须包含 "世"')

        // 字符在 text 中的索引 → 字节偏移
        const byteOffset = Buffer.byteLength(text.substring(0, charIdx), 'utf8')

        // 在 "世" 的每个字节边界切分
        for (let splitPos = 1; splitPos <= 2; splitPos++) {
            const parser = new SSEFrameParser()
            const events = feedAll(parser, [
                streamBytes.subarray(0, byteOffset + splitPos),
                streamBytes.subarray(byteOffset + splitPos)
            ])
            try {
                verifyCanonical(events)
            } catch (err) {
                err.message = `splitPos=${splitPos}: ${err.message}`
                throw err
            }
        }
    })

    test('CRLF 行尾 (\\r\\n\\r\\n) + 50 轮随机分片', () => {
        const events = buildCanonicalStream().events
        const text = events.join('\r\n\r\n') + '\r\n\r\n'
        const bytes = Buffer.from(text, 'utf8')

        for (let round = 0; round < 50; round++) {
            const parser = new SSEFrameParser()
            const chunks = randomSplitBytes(bytes, 1, 5)
            const parsed = feedAll(parser, chunks)
            try {
                verifyCanonical(parsed)
            } catch (err) {
                err.message = `round ${round}: ${err.message}`
                throw err
            }
        }
    })

    test('CRLF 在 \\r 和 \\n 之间被切（2 字节对齐 chunk）', () => {
        // 2 字节对齐的 chunk 会偶尔把 \r\n 切成 \r | \n
        const events = buildCanonicalStream().events
        const text = events.join('\r\n\r\n') + '\r\n\r\n'
        const bytes = Buffer.from(text, 'utf8')

        const parser = new SSEFrameParser()
        const chunks = []
        for (let i = 0; i < bytes.length; i += 2) {
            chunks.push(bytes.subarray(i, i + 2))
        }
        const parsed = feedAll(parser, chunks)
        verifyCanonical(parsed)
    })

    test('多行 data 字段（同一事件的多个 data: 行用 \\n 合并）', () => {
        // SSE 规范：同一事件的多个 data: 行应合并为 \n 连接的单一 data 字段
        const stream = [
            'data: line1',
            'data: line2',
            'data: line3',
            '',
            ''
        ].join('\n')

        const parser = new SSEFrameParser()
        const events = feedAll(parser, [Buffer.from(stream, 'utf8')])

        assert.equal(events.length, 1, 'should parse 1 event')
        assert.equal(events[0].data, 'line1\nline2\nline3', 'multi-line data 应以 \\n 合并')
        // 非合法 JSON → json=null, error 设置
        assert.equal(events[0].json, null)
        assert.ok(events[0].error, '应有 JSON 解析错误')
        assert.equal(events[0].error.kind, 'sse_json_parse_error')
    })

    test('多行 data 字段 + 50 轮随机分片', () => {
        const stream = [
            'data: {"a":1}',
            'data: {"b":2}',
            '',
            ''
        ].join('\n')
        // 合并后 data = '{"a":1}\n{"b":2}' —— 非合法 JSON
        const bytes = Buffer.from(stream, 'utf8')

        for (let round = 0; round < 50; round++) {
            const parser = new SSEFrameParser()
            const chunks = randomSplitBytes(bytes, 1, 5)
            const events = feedAll(parser, chunks)

            assert.equal(events.length, 1, `round ${round}: expected 1 event, got ${events.length}`)
            assert.equal(
                events[0].data,
                '{"a":1}\n{"b":2}',
                `round ${round}: data mismatch: ${JSON.stringify(events[0].data)}`
            )
        }
    })

    test('同一 chunk 内含多个事件（大 chunk）', () => {
        // 整段 stream 作为单 chunk —— 所有事件都在同一个 chunk 里
        const parser = new SSEFrameParser()
        const events = feedAll(parser, [streamBytes])
        verifyCanonical(events)

        // 2 段切分 —— 第二段大概率包含多个完整事件
        const parser2 = new SSEFrameParser()
        const mid = Math.floor(streamBytes.length / 2)
        const events2 = feedAll(parser2, [
            streamBytes.subarray(0, mid),
            streamBytes.subarray(mid)
        ])
        verifyCanonical(events2)
    })

    test('terminal [DONE] 与前一事件在同一个 chunk', () => {
        // 构造切分：第二段 chunk 同时包含 tool_call 事件和 [DONE] 事件
        const { events } = buildCanonicalStream()
        const text = events.join('\n\n') + '\n\n'

        // 计算第 5 个事件（tool_call，index=4）的起始字节偏移
        let pos = 0
        for (let i = 0; i < 4; i++) {
            pos += Buffer.byteLength(events[i], 'utf8') + 2 // +2 for \n\n
        }

        const bytes = Buffer.from(text, 'utf8')
        const parser = new SSEFrameParser()
        const parsed = feedAll(parser, [
            bytes.subarray(0, pos),  // 前 4 个事件
            bytes.subarray(pos)      // tool_call + \n\n + [DONE] + \n\n
        ])
        verifyCanonical(parsed)
    })
})
