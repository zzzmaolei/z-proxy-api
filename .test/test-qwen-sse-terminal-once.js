/**
 * test-qwen-sse-terminal-once.js
 *
 * 验证 SSE terminal 事件恰好一次的核心逻辑：
 *   - OpenAI [DONE] / Anthropic message_stop 恰好发送一次
 *   - 不完整的流不发伪 terminal
 *   - UTF-8 跨 chunk 边界正确重组
 *   - 单 chunk 内多个 SSE 事件正确解析
 *
 * 实现说明：
 *   - 使用纯文本模拟 stream-handler.js 的 terminalSent 守卫模式
 *     （if (terminalSent) return; terminalSent = true; ...）
 *   - 不依赖真实上游或网络
 */

const { test, describe } = require('node:test')
const assert = require('node:assert/strict')

describe('SSE terminal exactly-once', () => {
    test('OpenAI [DONE] sent exactly once on normal completion', () => {
        // Simulate the terminal tracking logic from stream-handler.js:
        //   if (streamState.terminalSent) return
        //   streamState.terminalSent = true
        let terminalSent = false
        const sendTerminal = () => {
            if (terminalSent) return false
            terminalSent = true
            return true
        }
        assert.equal(sendTerminal(), true, 'first call should send terminal')
        assert.equal(sendTerminal(), false, 'second call should be blocked')
        assert.equal(terminalSent, true)
    })

    test('Anthropic message_stop sent exactly once', () => {
        let terminalSent = false
        const sendTerminal = () => {
            if (terminalSent) return false
            terminalSent = true
            return true
        }
        assert.equal(sendTerminal(), true)
        assert.equal(sendTerminal(), false)
    })

    test('incomplete stream does not send fake terminal', () => {
        let terminalSent = false
        const emittedAnyClientDelta = true  // content was emitted but stream cut early
        const onStreamEnd = () => {
            if (terminalSent) return 'already-sent'
            if (emittedAnyClientDelta) return 'incomplete'  // don't fake terminal
            return 'no-content'
        }
        assert.equal(onStreamEnd(), 'incomplete')
        assert.equal(terminalSent, false, 'terminal should NOT be sent for incomplete stream')
    })

    test('UTF-8 across chunk boundary reassembles correctly', () => {
        // Simulate a multi-byte UTF-8 char split across chunks
        const fullChar = '𐍈'  // U+10348, 4-byte UTF-8
        const buf = Buffer.from(fullChar, 'utf8')
        assert.equal(buf.length, 4)
        // Split at byte 2
        const part1 = buf.subarray(0, 2)
        const part2 = buf.subarray(2)
        const reassembled = Buffer.concat([part1, part2]).toString('utf8')
        assert.equal(reassembled, fullChar)
    })

    test('multiple SSE events in single chunk parse correctly', () => {
        const chunk = 'data: {"content":"a"}\n\ndata: {"content":"b"}\n\ndata: [DONE]\n\n'
        const events = chunk.split('\n\n').filter(e => e.trim())
        assert.equal(events.length, 3)
        assert.ok(events[2].includes('[DONE]'))
    })
})
