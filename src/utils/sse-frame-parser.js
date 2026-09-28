/**
 * sse-frame-parser.js
 *
 * 统一的 SSE 帧解析器。
 *
 * 解决的问题：
 *  - 上游 chunk 可能被 TCP 分片切到半截 JSON
 *  - 不同上游混合 \n\n 与 \r\n\r\n 帧分隔
 *  - 一个 frame 内可能有多个 `data:` 行，需要合并
 *  - chat.js / anthropic.js / chat.image.video.js 都有手写 SSE 解析
 *    分散在多处、行为略有差异
 *
 * 设计原则：
 *  - 接受 Buffer / string / Uint8Array
 *  - 内部用 TextDecoder 统一转字符串，避免 buffer 拼接的编码坑
 *  - 内部维护 buffer；半截 frame 不外抛
 *  - 解析失败（JSON.parse 抛错）输出结构化 error，不抛
 *  - 只做 SSE 文本解析，不介入认证、风控或浏览器模拟逻辑
 *
 * 用法：
 *   const parser = new SSEFrameParser()
 *   for (const ev of parser.feed(chunk)) { ... }
 *   // 流结束时：
 *   for (const ev of parser.end()) { ... }  // 安全 flush
 *
 * 输出事件结构：
 *   {
 *     event: string,         // 'message' 兜底
 *     data: string,          // 多行 data: 已用 \n 合并
 *     raw: string,           // 原始 frame 文本（去尾随空白）
 *     id: string|null,       // SSE id 字段（暂未启用）
 *     retry: number|null,    // SSE retry 字段（暂未启用）
 *     json: object|null,     // JSON.parse(data)；失败为 null
 *     error: null | { kind: string, message: string }
 *   }
 */

const DEFAULT_EVENT = 'message'

const ERROR_KIND = Object.freeze({
  JSON_PARSE_ERROR: 'sse_json_parse_error',
  INCOMPLETE_TRAILING: 'sse_incomplete_trailing'
})

/**
 * 找下一个 SSE 帧分隔符位置
 * - 优先匹配 \r\n\r\n；其次 \n\n
 * - 没有则返回 -1
 */
const findFrameBoundary = (str, from = 0) => {
  const a = str.indexOf('\r\n\r\n', from)
  const b = str.indexOf('\n\n', from)
  if (a === -1 && b === -1) return -1
  if (a === -1) return b
  if (b === -1) return a
  return Math.min(a, b)
}

const _isObj = (x) => x !== null && typeof x === 'object'

class SSEFrameParser {
  constructor(options) {
    const opts = options || {}
    this._decoder = opts.decoder || new TextDecoder('utf-8')
    this._buffer = ''
    this._closed = false
    // 跨 chunk 累积的 event / id 字段（半截 frame 时不能用默认值覆盖）
    this._lastId = null
  }

  /**
   * 喂一段 chunk（Buffer / string / Uint8Array）
   * @param {Buffer|string|Uint8Array} chunk
   * @returns {Array<object>} 解析出的事件列表（可能为空）
   */
  feed(chunk) {
    if (this._closed) {
      // 已关闭，丢弃后续 chunk
      return []
    }

    if (chunk == null) return []

    if (typeof chunk === 'string') {
      this._buffer += chunk
    } else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
      this._buffer += this._decoder.decode(chunk, { stream: true })
    } else {
      // 未知类型：尽量 toString
      this._buffer += String(chunk)
    }

    return this._extractFrames()
  }

  /**
   * 关闭 parser 并 flush 残留内容
   * - 若 buffer 中有非空白残留，会作为最后一段 event 输出
   *   并附带 error.kind = 'sse_incomplete_trailing'，便于上层识别
   * - 关闭后 feed() 不会再产生新事件
   * @returns {Array<object>}
   */
  end() {
    if (this._closed) return []

    // 把 decoder 内部残留字符 flush 出来
    try {
      this._buffer += this._decoder.decode(new Uint8Array(0), { stream: false })
    } catch (_) { /* ignore */ }

    this._closed = true

    // 先尝试解析已有的完整 frame
    const events = this._extractFrames()

    // 残留 buffer：非空白时作为最后一段
    const tail = this._buffer.trim()
    if (tail.length > 0) {
      events.push(this._parseFrame(tail, { allowError: true, incomplete: true }))
    }

    this._buffer = ''
    return events
  }

  /**
   * 关闭 parser，丢弃残留（用于出错时）
   * @returns {void}
   */
  reset() {
    this._buffer = ''
    this._closed = true
    this._lastId = null
  }

  /**
   * 当前 buffer 中未解析的字符串（仅用于调试 / 测试）
   */
  get pending() {
    return this._buffer
  }

  /* ---------------- 内部 ---------------- */

  _extractFrames() {
    const events = []
    let from = 0

    while (true) {
      const idx = findFrameBoundary(this._buffer, from)
      if (idx === -1) break

      // 取一段 frame 文本
      let raw = this._buffer.substring(from, idx)

      // 决定分隔符长度（\r\n\r\n=4 / \n\n=2）
      const sepLen = (this._buffer[idx] === '\r' &&
                      this._buffer[idx + 1] === '\n' &&
                      this._buffer[idx + 2] === '\r' &&
                      this._buffer[idx + 3] === '\n') ? 4 : 2
      // \r\n\r\n 真正结尾是 \r\n\r\n；只匹配到 \n\n 时同样 OK
      from = idx + sepLen
      // 去尾随空白
      raw = raw.replace(/\r?\n$/, '')
      const frame = this._parseFrame(raw, { allowError: false, incomplete: false })
      if (frame) events.push(frame)
    }

    if (from > 0) {
      this._buffer = this._buffer.substring(from)
    }

    return events
  }

  /**
   * 解析单帧文本为结构化事件
   * @param {string} raw  - 帧原始文本
   * @param {Object} opts
   * @param {boolean} opts.allowError  - 是否允许在解析失败时仍返回事件
   * @param {boolean} opts.incomplete  - 是否标记为"流末尾的半截 frame"
   */
  _parseFrame(raw, opts) {
    const allowError = !!(opts && opts.allowError)
    const incomplete = !!(opts && opts.incomplete)

    // 拆行（兼容 \r\n 和 \n）
    const lines = String(raw || '').split(/\r?\n/)

    let event = DEFAULT_EVENT
    const dataLines = []
    let id = null
    let retry = null

    for (const line of lines) {
      if (!line) continue
      // 注释行
      if (line.startsWith(':')) continue

      // 字段：值 形式（首个冒号分割）
      const colonIdx = line.indexOf(':')
      let field, value
      if (colonIdx === -1) {
        field = line
        value = ''
      } else {
        field = line.slice(0, colonIdx)
        value = line.slice(colonIdx + 1)
        // 去掉值前导的一个空格（spec 要求）
        if (value.startsWith(' ')) value = value.slice(1)
      }

      switch (field) {
        case 'event':
          event = value || DEFAULT_EVENT
          break
        case 'data':
          dataLines.push(value)
          break
        case 'id':
          if (value && !value.includes('\0')) id = value
          break
        case 'retry':
          if (/^\d+$/.test(value)) retry = Number(value)
          break
        default:
          // 忽略未知字段
          break
      }
    }

    if (id) this._lastId = id

    const data = dataLines.join('\n')
    const rawFrame = String(raw || '')

    // [DONE] sentinel：不解析 JSON，作为正常事件返回（json=null）
    if (data === '[DONE]') {
      return {
        event,
        data,
        raw: rawFrame,
        id: id || this._lastId,
        retry,
        json: null,
        error: null
      }
    }

    // 空 data + 无 event 增量：跳过
    if (data === '' && event === DEFAULT_EVENT && !incomplete) {
      return null
    }

    let json = null
    let error = null
    if (data) {
      try {
        json = JSON.parse(data)
      } catch (e) {
        error = {
          kind: incomplete ? ERROR_KIND.INCOMPLETE_TRAILING : ERROR_KIND.JSON_PARSE_ERROR,
          message: e && e.message ? String(e.message) : 'JSON parse failed'
        }
        if (!allowError && !incomplete) {
          // 不允许错误时仍可选择抛出 / 返回 null；这里采取"返回带 error 的事件"
          // 让上层决定怎么处理
        }
      }
    }

    return {
      event,
      data,
      raw: rawFrame,
      id: id || this._lastId,
      retry,
      json,
      error
    }
  }
}

module.exports = SSEFrameParser
module.exports.SSEFrameParser = SSEFrameParser
module.exports.SSE_ERROR_KIND = ERROR_KIND
module.exports.SSE_DEFAULT_EVENT = DEFAULT_EVENT
