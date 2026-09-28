/**
 * anthropic-sse-state.js
 *
 * Anthropic SSE content_block 状态机追踪 + 工具调用 / 文本写入辅助
 *
 * 解决的问题：
 *   Claude Code 在收到不合法 Anthropic SSE 序列时会报
 *   "API Error: Content block not found"。常见根因包括：
 *     - content_block_delta 发给未 start 的 index
 *     - content_block_stop 关闭未 start 的 index
 *     - message_stop 之前未关闭所有 content block
 *     - tool_use 输出中混入普通 text
 *     - retry / fallback / blocked 文本插入已经开始的 tool_use block
 *     - 多个 tool_use 时 index 未从 0 开始递增 / start/stop 不成对
 *
 * 本文件提供的"防御 + 收敛"：
 *   1. AnthropicSSEStateTracker 状态机
 *      - startedBlocks / closedBlocks / messageStartSent / finalStopReason
 *      - 每个 write 方法都会自检，遇到非法顺序直接 throw
 *      - 在开发/测试环境抛错（让协议 bug 在 CI 暴露），生产环境降级为 logger.error
 *   2. emitAnthropicToolUse(res, messageId, toolCalls, tracker)
 *      - 输出顺序：message_start → 每个 tool_call: start → input_json_delta(s) → stop
 *      - 严禁在 tool_use 输出中夹 text
 *   3. emitAnthropicTextBlock(res, text, tracker)
 *      - 单独输出 text block
 *      - 与 emitAnthropicToolUse 互斥（一次只允许一种）
 *   4. finalizeAnthropicStream(res, tracker, { stopReason })
 *      - 关闭所有未关闭的 block → message_delta → message_stop
 *      - 严禁"先 stop 再 start"或"重复 stop"
 *
 * 设计原则：
 *   - 不修改 anthropic.js / strict-tool-mode.js 之外的代码
 *   - 不打印 token / cookie / prompt
 *   - 状态机异常走 logger.error，不打 info / warn
 */

const { logger } = require('./logger.js')

// ----------------------------------------------------------------------------
// 状态机常量
// ----------------------------------------------------------------------------

/**
 * Anthropic content_block type 枚举
 * 状态机只接受这三种类型
 */
const BLOCK_TYPES = Object.freeze({
  TEXT: 'text',
  THINKING: 'thinking',
  TOOL_USE: 'tool_use'
})

/**
 * Anthropic stop_reason 枚举
 */
const STOP_REASONS = Object.freeze({
  END_TURN: 'end_turn',
  TOOL_USE: 'tool_use',
  MAX_TOKENS: 'max_tokens',
  STOP_SEQUENCE: 'stop_sequence',
  REFUSAL: 'refusal'
})

/**
 * 流式输出模式：
 *   - TOOL_USE: 决定只输出 tool_use（不夹 text）
 *   - TEXT: 决定只输出 text（不夹 tool_use）
 *   - UNDECIDED: 尚未决定（允许按顺序先 text 后 tool_use）
 *   - ERROR: 已发送 error 事件，后续必须走 finalizeAnthropicStream 收尾
 *
 * 一次 stream 中一旦从 UNDECIDED 切到 TOOL_USE / TEXT，就不能再切回去
 */
const STREAM_MODE = Object.freeze({
  UNDECIDED: 'undecided',
  TOOL_USE: 'tool_use',
  TEXT: 'text',
  ERROR: 'error'
})

// ----------------------------------------------------------------------------
// 状态机
// ----------------------------------------------------------------------------

/**
 * 创建 Anthropic SSE 状态追踪器
 *
 * @param {Object} [options]
 * @param {Object} [options.logger] - 日志对象（默认使用模块 logger）
 * @param {boolean} [options.strictThrow=true] - 遇到非法顺序是否 throw；false 时仅 logger.error
 * @returns {{
 *   startedBlocks: Set<number>,
 *   closedBlocks: Set<number>,
 *   messageStartSent: boolean,
 *   finalStopReason: string|null,
 *   mode: string,
 *   currentIndex: number,
 *   markMessageStart: () => void,
 *   requireBlockStart: (index:number, type:string) => void,
 *   requireBlockStop: (index:number) => void,
 *   requireDelta: (index:number) => void,
 *   setMode: (mode:string) => void,
 *   setStopReason: (reason:string) => void,
 *   canEmitText: () => boolean,
 *   canEmitToolUse: () => boolean,
 *   isMessageFinalized: () => boolean,
 *   getOpenBlocks: () => number[],
 *   assertAllBlocksClosed: () => void
 * }}
 */
const createAnthropicSSEState = (options = {}) => {
  const log = (options && options.logger) || logger
  const strictThrow = options.strictThrow !== false

  const state = {
    startedBlocks: new Set(),
    closedBlocks: new Set(),
    // 已 start 但未 stop 的 block（用于 finalize 时一次性关掉）
    openBlocks: new Set(),
    messageStartSent: false,
    finalStopReason: null,
    mode: STREAM_MODE.UNDECIDED,
    // 当前可用 index（0 开始递增）
    currentIndex: 0,
    // 当前正在写的 block type
    currentBlockType: null,
    // 是否已 finalize
    finalized: false,
    // 状态是否已损坏（不变量违反后标记，finalize 时降级为只发 message_stop）
    broken: false
  }

  /**
   * 抛错 or logger.error
   * @param {string} msg
   */
  const fail = (msg) => {
    try {
      log?.error?.(`[anthropic-sse-state] ${msg}`, 'ANTHROPIC')
    } catch (_) { /* ignore */ }
    if (strictThrow) {
      const err = new Error(`AnthropicSSEState 非法操作: ${msg}`)
      err.code = 'ANTHROPIC_SSE_STATE_VIOLATION'
      throw err
    }
  }

  return {
    // 只读 getters
    get startedBlocks() { return new Set(state.startedBlocks) },
    get closedBlocks() { return new Set(state.closedBlocks) },
    get messageStartSent() { return state.messageStartSent },
    get finalStopReason() { return state.finalStopReason },
    get mode() { return state.mode },
    get currentIndex() { return state.currentIndex },
    get finalized() { return state.finalized },

    /**
     * 标记 message_start 已发送
     *   - 只能调用一次
     *   - 调用之前不能 start 任何 block
     */
    markMessageStart() {
      if (state.messageStartSent) {
        fail('markMessageStart 重复调用')
        return
      }
      if (state.openBlocks.size > 0 || state.startedBlocks.size > 0) {
        fail(`markMessageStart 前不应有 open block (open=${state.openBlocks.size})`)
        return
      }
      state.messageStartSent = true
    },

    /**
     * 记录"开始一个 block"
     *   - index 必须等于 currentIndex（保证从 0 递增、不跳号）
     *   - 同一 index 不能 start 两次
     * @param {number} index
     * @param {string} type - BLOCK_TYPES.*
     */
    requireBlockStart(index, type) {
      if (!state.messageStartSent) {
        fail(`content_block_start index=${index} 在 message_start 之前发送`)
        return
      }
      if (state.finalized) {
        fail(`content_block_start index=${index} 在 message_stop 之后发送`)
        return
      }
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
        fail(`content_block_start 收到非法 index=${index}`)
        return
      }
      if (index !== state.currentIndex) {
        fail(`content_block_start index=${index} 违反递增约束（当前 currentIndex=${state.currentIndex}）`)
        return
      }
      if (state.startedBlocks.has(index)) {
        fail(`content_block_start index=${index} 重复 start`)
        return
      }
      if (!Object.values(BLOCK_TYPES).includes(type)) {
        fail(`content_block_start index=${index} type=${type} 不在白名单`)
        return
      }
      state.startedBlocks.add(index)
      state.openBlocks.add(index)
      state.currentBlockType = type
      // currentIndex 暂不递增，等 block stop 后再递增
    },

    /**
     * 推进 index（在 block stop 时调用）
     * @param {number} index
     */
    advanceIndex(index) {
      if (index === state.currentIndex) {
        state.currentIndex += 1
      }
      state.currentBlockType = null
    },

    /**
     * 记录"停止一个 block"
     *   - block 必须已 start
     *   - 同一 block 不能 stop 两次
     * @param {number} index
     */
    requireBlockStop(index) {
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
        fail(`content_block_stop 收到非法 index=${index}`)
        return
      }
      if (!state.startedBlocks.has(index)) {
        fail(`content_block_stop index=${index} 未 start 就 stop`)
        return
      }
      if (state.closedBlocks.has(index)) {
        fail(`content_block_stop index=${index} 重复 stop`)
        return
      }
      state.closedBlocks.add(index)
      state.openBlocks.delete(index)
      this.advanceIndex(index)
    },

    /**
     * 记录"一个 delta 发往 index"
     *   - index 必须已 start 且未 stop
     * @param {number} index
     */
    requireDelta(index) {
      if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
        fail(`content_block_delta 收到非法 index=${index}`)
        return
      }
      if (!state.startedBlocks.has(index)) {
        fail(`content_block_delta index=${index} 在 block 未 start 时发送`)
        return
      }
      if (state.closedBlocks.has(index)) {
        fail(`content_block_delta index=${index} 在 block 已 stop 后还发送 delta`)
        return
      }
    },

    /**
     * 切换流模式
     *   - UNDECIDED → TOOL_USE / TEXT / ERROR：自由切换
     *   - TEXT → TOOL_USE：允许（"先解释后调用"是合法路径）
     *   - TEXT → UNDECIDED / ERROR：允许（ERROR 永远可达）
     *   - TOOL_USE → TEXT：禁止（一旦决定调工具，绝不能"反悔"输出 text，会触发 Content block not found）
     *   - TOOL_USE → UNDECIDED：禁止（同上）
     *   - finalized 状态：只允许切到 ERROR（用于"无法再 emit 任何 block"的标记）
     * @param {string} mode
     */
    setMode(mode) {
      if (!Object.values(STREAM_MODE).includes(mode)) {
        fail(`setMode 收到非法 mode=${mode}`)
        return
      }
      if (state.finalized && mode !== STREAM_MODE.ERROR) {
        fail(`setMode 在 finalized 状态不能切到 ${mode}`)
        return
      }
      const nameOf = (v) => {
        for (const k of Object.keys(STREAM_MODE)) {
          if (STREAM_MODE[k] === v) return k
        }
        return String(v)
      }
      if (state.mode === mode) return // no-op
      // 允许的切换图：
      //   UNDECIDED → 任何
      //   TEXT → TOOL_USE / ERROR
      //   TOOL_USE → ERROR
      //   ERROR → 任何？不行，ERROR 是终态
      if (state.mode === STREAM_MODE.ERROR && mode !== STREAM_MODE.ERROR) {
        fail(`setMode 从 ${nameOf(state.mode)} 切到 ${nameOf(mode)} 不合法（ERROR 是终态）`)
        return
      }
      if (state.mode === STREAM_MODE.TOOL_USE && mode === STREAM_MODE.TEXT) {
        fail(`setMode 从 TOOL_USE 切到 TEXT 不合法（一旦决定调工具，不能反悔）`)
        return
      }
      if (state.mode === STREAM_MODE.TOOL_USE && mode === STREAM_MODE.UNDECIDED) {
        fail(`setMode 从 TOOL_USE 切到 UNDECIDED 不合法`)
        return
      }
      state.mode = mode
    },

    /**
     * 判定当前能否 emit text block
     */
    canEmitText() {
      if (state.finalized) return false
      if (state.mode === STREAM_MODE.TOOL_USE || state.mode === STREAM_MODE.ERROR) return false
      return true
    },

    /**
     * 判定当前能否 emit tool_use block
     *   - finalized / ERROR 模式：禁止
     *   - TOOL_USE 模式：允许（多次发 tool_use，index 递增）
     *   - TEXT 模式：允许（text → tool_use 是一次合法的"先解释后调用"路径）
     *   - UNDECIDED 模式：允许
     *   - 关键不允许的路径是：TOOL_USE → TEXT
     */
    canEmitToolUse() {
      if (state.finalized) return false
      if (state.mode === STREAM_MODE.ERROR) return false
      return true
    },

    /**
     * 设置 stop_reason
     *   - 决定 tool_use 时必须是 TOOL_USE
     *   - 决定 text 时不能是 TOOL_USE
     * @param {string} reason
     */
    setStopReason(reason) {
      if (!Object.values(STOP_REASONS).includes(reason)) {
        fail(`setStopReason 收到非法 reason=${reason}`)
        return
      }
      const nameOf = (v) => {
        for (const k of Object.keys(STOP_REASONS)) {
          if (STOP_REASONS[k] === v) return k
        }
        return String(v)
      }
      if (state.mode === STREAM_MODE.TOOL_USE && reason !== STOP_REASONS.TOOL_USE) {
        fail(`mode=TOOL_USE 但 stop_reason=${nameOf(reason)}，必须是 TOOL_USE`)
        // 不变量违反后直接 return，避免把非法 reason 写入 finalStopReason
        return
      }
      if (state.mode === STREAM_MODE.TEXT && reason === STOP_REASONS.TOOL_USE) {
        fail(`mode=TEXT 但 stop_reason=TOOL_USE，不一致`)
        // 同上，禁止写入非法 reason
        return
      }
      state.finalStopReason = reason
    },

    /**
     * 标记流已 finalize
     */
    markFinalized() {
      state.finalized = true
    },

    /**
     * 判定 message 是否已 finalize
     */
    isMessageFinalized() {
      return state.finalized
    },

    /**
     * 拿当前 open 的 block indices
     */
    getOpenBlocks() {
      return Array.from(state.openBlocks).sort((a, b) => a - b)
    },

    /**
     * 断言所有 block 都已 stop（message_stop 前必须调用）
     *   - 失败时 fail（可能 throw）
     */
    assertAllBlocksClosed() {
      if (state.openBlocks.size > 0) {
        const openList = Array.from(state.openBlocks).sort((a, b) => a - b)
        // 标记状态已损坏，finalize 据此降级（只发 message_stop，跳过 message_delta）
        state.broken = true
        fail(`message_stop 时仍有 open block: [${openList.join(',')}]`)
      }
    }
  }
}

// ----------------------------------------------------------------------------
// 写入辅助
// ----------------------------------------------------------------------------

/**
 * 写一行 Anthropic SSE 事件
 * @param {object} res
 * @param {string} event
 * @param {object} data
 */
const writeAnthropicEvent = (res, event, data) => {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  } catch (_) { /* ignore */ }
}

/**
 * 把工具调用的 arguments JSON 字符串切成 input_json_delta 切片
 * @param {string} argsJson
 * @param {number} [chunkSize=32]
 * @returns {string[]}
 */
const sliceArgsJson = (argsJson, chunkSize = 32) => {
  const out = []
  const s = (typeof argsJson === 'string') ? argsJson : '{}'
  for (let i = 0; i < s.length; i += chunkSize) {
    out.push(s.slice(i, i + chunkSize))
  }
  return out.length > 0 ? out : ['']
}

/**
 * 发出一个完整的 Anthropic message_start
 * @param {object} res
 * @param {string} messageId
 * @param {string} model
 * @param {object} state
 */
const emitAnthropicMessageStart = (res, messageId, model, state) => {
  if (state.messageStartSent) return
  writeAnthropicEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  })
  state.markMessageStart()
}

/**
 * 发出一个完整的 Anthropic tool_use block
 *   - 顺序：content_block_start → 一系列 input_json_delta → content_block_stop
 *   - 与其它 block 互斥：调用前 state.canEmitToolUse() 必须 true
 *   - 多次调用：每次 +1 index，自动 start/stop 成对
 *   - 调完一次后 state.mode 切到 TOOL_USE
 *
 * @param {object} res
 * @param {Array<{id:string, function:{name:string, arguments:string|object}}>} toolCalls
 * @param {object} state
 * @param {object} [options]
 * @param {boolean} [options.skipMessageStart=false] - 如果调用方已经发过 message_start
 * @returns {number} 最后一个 tool_use block 的 index
 */
const emitAnthropicToolUse = (res, toolCalls, state, options = {}) => {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return -1
  }
  if (!state.canEmitToolUse()) {
    // 切到 ERROR 模式：后续 finalizeAnthropicStream 会关掉所有 open block
    state.setMode(STREAM_MODE.ERROR)
    return -1
  }

  let lastIndex = -1
  for (const call of toolCalls) {
    if (!call || typeof call !== 'object') continue
    const id = (call.id && typeof call.id === 'string')
      ? call.id
      : `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const name = (call.function && call.function.name) || (call.name) || 'unknown'
    const argsRaw = (call.function && call.function.arguments) || '{}'
    const argsStr = (typeof argsRaw === 'string') ? argsRaw : JSON.stringify(argsRaw || {})

    // 1) 关闭任何上一个 open block
    while (state.getOpenBlocks().length > 0) {
      const openIdx = state.getOpenBlocks()[0]
      writeAnthropicEvent(res, 'content_block_stop', { type: 'content_block_stop', index: openIdx })
      state.requireBlockStop(openIdx)
    }

    // 2) start 一个新 tool_use block
    const idx = state.currentIndex
    state.requireBlockStart(idx, BLOCK_TYPES.TOOL_USE)
    writeAnthropicEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: idx,
      content_block: { type: 'tool_use', id, name, input: {} }
    })

    // 3) input_json_delta 切片
    for (const piece of sliceArgsJson(argsStr)) {
      state.requireDelta(idx)
      writeAnthropicEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: idx,
        delta: { type: 'input_json_delta', partial_json: piece }
      })
    }

    // 4) stop
    state.requireBlockStop(idx)
    writeAnthropicEvent(res, 'content_block_stop', { type: 'content_block_stop', index: idx })
    lastIndex = idx
  }

  state.setMode(STREAM_MODE.TOOL_USE)
  state.setStopReason(STOP_REASONS.TOOL_USE)
  return lastIndex
}

/**
 * 发出一个 Anthropic text block（可选）
 *   - 仅在 state.canEmitText() === true 时执行
 *   - 一旦切到 TOOL_USE / ERROR 模式，本函数立即返回
 *   - 调完一次后 state.mode 切到 TEXT
 *
 * @param {object} res
 * @param {string} text
 * @param {object} state
 * @returns {number} text block 的 index；如果 text 为空或模式不允许，返回 -1
 */
const emitAnthropicTextBlock = (res, text, state) => {
  if (typeof text !== 'string' || text.length === 0) return -1
  if (!state.canEmitText()) return -1

  // 关闭任何 open block
  while (state.getOpenBlocks().length > 0) {
    const openIdx = state.getOpenBlocks()[0]
    writeAnthropicEvent(res, 'content_block_stop', { type: 'content_block_stop', index: openIdx })
    state.requireBlockStop(openIdx)
  }

  const idx = state.currentIndex
  state.requireBlockStart(idx, BLOCK_TYPES.TEXT)
  writeAnthropicEvent(res, 'content_block_start', {
    type: 'content_block_start',
    index: idx,
    content_block: { type: 'text', text: '' }
  })

  state.requireDelta(idx)
  writeAnthropicEvent(res, 'content_block_delta', {
    type: 'content_block_delta',
    index: idx,
    delta: { type: 'text_delta', text }
  })

  state.requireBlockStop(idx)
  writeAnthropicEvent(res, 'content_block_stop', { type: 'content_block_stop', index: idx })

  state.setMode(STREAM_MODE.TEXT)
  state.setStopReason(STOP_REASONS.END_TURN)
  return idx
}

/**
 * 关闭所有 open block（finalize 前调用）
 *   - 状态机严格保证：调用后所有 block 已 stop
 * @param {object} res
 * @param {object} state
 */
const closeAllOpenBlocks = (res, state) => {
  // 防御：使用副本迭代，避免 state.getOpenBlocks() 在迭代中变化
  const openList = state.getOpenBlocks().slice()
  for (const idx of openList) {
    writeAnthropicEvent(res, 'content_block_stop', { type: 'content_block_stop', index: idx })
    state.requireBlockStop(idx)
  }
}

/**
 * 发出 Anthropic message_delta + message_stop
 *   - 严格保证：所有 open block 在 message_stop 之前已 stop
 *   - 重复调用：第二次会通过 state.assertAllBlocksClosed 失败（fail / throw）
 *   - 调完一次后 state.finalized = true
 *
 * @param {object} res
 * @param {object} state
 * @param {object} [options]
 * @param {string} [options.stopReason] - 默认 state.finalStopReason
 * @param {number} [options.inputTokens=0]
 * @param {number} [options.outputTokens=0]
 * @returns {void}
 */
const finalizeAnthropicStream = (res, state, options = {}) => {
  if (state.isMessageFinalized()) return
  // 1) 关掉所有 open block
  closeAllOpenBlocks(res, state)
  // 2) 断言全部已关
  state.assertAllBlocksClosed()
  // 2.5) 状态已损坏（仍有未关闭 block）→ 跳过 message_delta，只发 message_stop 收尾
  if (state.broken) {
    writeAnthropicEvent(res, 'message_stop', { type: 'message_stop' })
    state.markFinalized()
    return
  }
  // 3) message_delta
  const reason = options.stopReason || state.finalStopReason || STOP_REASONS.END_TURN
  writeAnthropicEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: reason, stop_sequence: null },
    usage: {
      input_tokens: Number(options.inputTokens) || 0,
      output_tokens: Number(options.outputTokens) || 0
    }
  })
  // 4) message_stop
  writeAnthropicEvent(res, 'message_stop', { type: 'message_stop' })
  state.markFinalized()
}

/**
 * 发送 Anthropic SSE error event，并终止普通消息生命周期。
 *   - 用于 strict mode retry 耗尽 + fallback 失败 的场景
 *   - error 与正常 message_delta/message_stop 互斥，避免把失败伪装成 end_turn
 * @param {object} res
 * @param {string} message
 * @param {object} state
 * @param {string} [errorType='api_error']
 * @param {string} [errorCode]
 */
const emitAnthropicErrorAndFinalize = (res, message, state, errorType = 'api_error', errorCode = null) => {
  const error = {
    type: errorType,
    ...(errorCode ? { code: errorCode } : {}),
    message,
  }
  if (state.isMessageFinalized()) {
    // 已经 finalize → 只发 error 即可（不再发 message_delta/stop）
    try {
      writeAnthropicEvent(res, 'error', {
        type: 'error',
        error,
      })
    } catch (_) { /* ignore */ }
    return
  }
  // 切到 ERROR 模式（不能再 emit text/tool_use）
  state.setMode(STREAM_MODE.ERROR)
  // 1) 关掉所有 open block
  closeAllOpenBlocks(res, state)
  state.assertAllBlocksClosed()
  // 2) 发 error
  try {
    writeAnthropicEvent(res, 'error', {
      type: 'error',
      error,
    })
  } catch (_) { /* ignore */ }
  // 3) message_delta + message_stop（让客户端知道 message 已结束）
  state.markFinalized()
}

/**
 * 创建 Anthropic 流式写入器
 *
 * 提供与 Qwen anthropic.js 一致的事件发射模式，消除 DeepSeek 重复：
 * - 自动管理 content block 的 start/delta/stop 序列
 * - streaming text_delta / thinking_delta
 * - tool_use block 发射（含 input_json_delta 切片）
 * - message_start 生命周期
 *
 * 用法示例（在 controller 中）：
 *   const sseState = createAnthropicSSEState({ logger, strictThrow: false });
 *   const writer = createAnthropicStreamWriter(res, sseState, { messageId, model });
 *   writer.emitTextDelta('Hello');
 *   writer.emitToolUseBlock({ id: 'call_1', function: { name: 'Read', arguments: '{}' } });
 *   writer.closeAllBlocks();
 *   finalizeAnthropicStream(res, sseState, { stopReason: 'end_turn' });
 *
 * @param {object} res - Express Response
 * @param {object} sseState - createAnthropicSSEState 返回的状态机
 * @param {object} [options]
 * @param {string} [options.messageId] - 消息 ID
 * @param {string} [options.model] - 模型名
 * @returns {object} 写入器实例
 */
const createAnthropicStreamWriter = (res, sseState, options = {}) => {
  const { messageId, model, onFirstMessageStart } = options;

  let textBlockOpen = false;
  let thinkingBlockOpen = false;
  let blockIndex = -1;
  let messageStarted = false;
  let emittedAnyToolCall = false;
  let hasVisibleOutput = false;
  let closed = false;

  const ensureMessageStart = () => {
    if (messageStarted || closed) return;
    if (typeof onFirstMessageStart === 'function') {
      onFirstMessageStart();
    }
    writeAnthropicEvent(res, 'message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
    sseState.markMessageStart();
    messageStarted = true;
  };

  const closeTextBlock = () => {
    if (textBlockOpen) {
      sseState.requireBlockStop(blockIndex);
      writeAnthropicEvent(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
      textBlockOpen = false;
    }
  };

  const closeThinkingBlock = () => {
    if (thinkingBlockOpen) {
      sseState.requireBlockStop(blockIndex);
      writeAnthropicEvent(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
      thinkingBlockOpen = false;
    }
  };

  const closeAllBlocks = () => {
    closeThinkingBlock();
    closeTextBlock();
  };

  /**
   * 输出文本增量；按需打开新文本块
   * @param {string} text
   */
  const emitTextDelta = (text) => {
    if (!text || closed) return;
    hasVisibleOutput = true;
    ensureMessageStart();
    if (!textBlockOpen) {
      closeThinkingBlock();
      blockIndex += 1;
      sseState.requireBlockStart(blockIndex, BLOCK_TYPES.TEXT);
      writeAnthropicEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index: blockIndex,
        content_block: { type: 'text', text: '' },
      });
      textBlockOpen = true;
    }
    sseState.requireDelta(blockIndex);
    writeAnthropicEvent(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'text_delta', text },
    });
  };

  /**
   * 输出思维增量；按需打开新思维块
   * @param {string} text
   * @param {boolean} [outThinkEnabled=true] - 是否允许输出思维块
   */
  const emitThinkingDelta = (text, outThinkEnabled = true) => {
    void text;
    void outThinkEnabled;
    // Qwen/DeepSeek Web 不提供 Anthropic 可验证 signature。隐藏 reasoning 仅用于
    // 内部统计，不伪造 thinking block，也不降级成最终答案文本。
    return false;
  };

  /**
   * 输出一个完整的 tool_use 块（start + input_json_delta 切片 + stop）
   * @param {Object} call - 工具调用 { id, function: { name, arguments } }
   */
  const emitToolUseBlock = (call) => {
    if (!call || closed) return;
    hasVisibleOutput = true;
    ensureMessageStart();
    closeAllBlocks();
    blockIndex += 1;
    sseState.requireBlockStart(blockIndex, BLOCK_TYPES.TOOL_USE);
    writeAnthropicEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: {
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: {},
      },
    });
    const argsStr = typeof call.function.arguments === 'string'
      ? call.function.arguments
      : JSON.stringify(call.function.arguments || {});
    for (const piece of sliceArgsJson(argsStr)) {
      sseState.requireDelta(blockIndex);
      writeAnthropicEvent(res, 'content_block_delta', {
        type: 'content_block_delta',
        index: blockIndex,
        delta: { type: 'input_json_delta', partial_json: piece },
      });
    }
    sseState.requireBlockStop(blockIndex);
    writeAnthropicEvent(res, 'content_block_stop', { type: 'content_block_stop', index: blockIndex });
    emittedAnyToolCall = true;
  };

  /**
   * 批量输出工具调用块
   * @param {Array<Object>} calls
   */
  const writeToolCalls = (calls) => {
    if (!Array.isArray(calls) || calls.length === 0) return;
    for (const call of calls) emitToolUseBlock(call);
  };

  /** 标记写入器为已关闭（停止所有发射） */
  const close = () => { closed = true; };

  return Object.freeze({
    // getters
    get textBlockOpen() { return textBlockOpen },
    get thinkingBlockOpen() { return thinkingBlockOpen },
    get blockIndex() { return blockIndex },
    get messageStarted() { return messageStarted },
    get emittedAnyToolCall() { return emittedAnyToolCall },
    get hasVisibleOutput() { return hasVisibleOutput },
    // 生命周期
    ensureMessageStart,
    closeTextBlock,
    closeThinkingBlock,
    closeAllBlocks,
    // 发射
    emitTextDelta,
    emitThinkingDelta,
    emitToolUseBlock,
    writeToolCalls,
    close,
  });
};

module.exports = {
  // 状态机
  createAnthropicSSEState,
  BLOCK_TYPES,
  STOP_REASONS,
  STREAM_MODE,
  // 流式写入器（消除 DeepSeek/Qwen emit 重复）
  createAnthropicStreamWriter,
  // 写入函数
  writeAnthropicEvent,
  sliceArgsJson,
  emitAnthropicMessageStart,
  emitAnthropicToolUse,
  emitAnthropicTextBlock,
  closeAllOpenBlocks,
  finalizeAnthropicStream,
  emitAnthropicErrorAndFinalize
}
