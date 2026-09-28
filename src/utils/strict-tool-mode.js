/**
 * Claude Code/Hermes strict tool mode for the chat backend.
 *
 * Qwen Web is not a native Anthropic tool-calling API, so the bridge has to
 * classify Qwen's answer text before anything is sent to `/v1/messages`
 * clients. In strict mode an answer may leave the backend only as:
 *
 *   - a valid tool_call, converted to Anthropic `tool_use`
 *   - a clearly marked final report
 *   - a blocked error that contains `strict_tool_mode_no_tool_call`
 *
 * Progress narration such as "我继续检查" or "let me look at..." is never sent
 * as a successful `end_turn`, because Claude Code treats that as the assistant
 * deciding to stop the tool loop.
 */

const claudeCodeProfile = require('../agents/claude-code-profile.js')
const {
  parseLooseToolCallsFromText,
  resolveToolName,
  normalizeArgumentsToJson,
  appendHintToLastMessage
} = require('./tool-prompt.js')
const { generateUUID } = require('./tools.js')

// ----------------------------------------------------------------------------
// 状态常量
// ----------------------------------------------------------------------------

/**
 * 决策类型（classifyBuffer 返回的 kind 字段）
 * @type {Readonly<{TOOL_USE:string, FINAL_ANSWER:string, PROCESS_TEXT:string, INVALID_TOOL_NAME:string, INVALID_JSON:string, NO_TOOL_CALL:string, AMBIGUOUS_FINAL:string}>}
 */
const DECISION = Object.freeze({
  TOOL_USE: 'tool_use',
  FINAL_ANSWER: 'final_answer',
  PROCESS_TEXT: 'process_text',
  INVALID_TOOL_NAME: 'invalid_tool_name',
  INVALID_JSON: 'invalid_json',
  NO_TOOL_CALL: 'no_tool_call',
  AMBIGUOUS_FINAL: 'ambiguous_final'
})

/**
 * 决策类 → 触发 retry 的类别
 *   - TOOL_USE / FINAL_ANSWER : 终态，不重试
 *   - 其余 5 类 : 都触发 retry
 */
const RETRY_TRIGGERING_KINDS = new Set([
  DECISION.PROCESS_TEXT,
  DECISION.INVALID_TOOL_NAME,
  DECISION.INVALID_JSON,
  DECISION.NO_TOOL_CALL,
  DECISION.AMBIGUOUS_FINAL
])

// ----------------------------------------------------------------------------
// Process-text blacklist
// ----------------------------------------------------------------------------
// `claude-code-profile.js` intentionally keeps broad "looks like tool intent"
// patterns. Strict mode needs a narrower list of phrases that must never be
// treated as a final answer, even if they look polite or helpful.

/**
 * Phrases that are status/progress narration rather than a final answer.
 * 命中 → 直接归类为 PROCESS_TEXT，必须 retry
 * @type {Array<RegExp>}
 */
const STRICT_PROCESS_TEXT_BLACKLIST = [
  /let me understand where I am|let me check the current state|let me understand/i,
  /let me (check|look|read|see|inspect|examine|verify|review|investigate|search|find)/i,
  /I need to (check|look|read|see|inspect|examine|verify|review|investigate)/i,
  /still need to (do|run|check|verify|complete|finish)/i,
  /I will continue|continuing with|continue with remaining work/i,
  // 中文：刚改完 / 正在做 / 继续检查 / 我来看看 / 还差一点
  /刚[\s\S]{0,8}(改|做|写|跑|完|完成|测试完|改完|写完|跑完)/,
  /正在[\s\S]{0,8}(做|改|查|看|读|写|跑|运行|调试|测试|修改)/,
  /(我|让我|我们)?[\s\S]{0,4}继续[\s\S]{0,4}(检查|修改|做|查|看|读|写|跑|调试|测试|浏览)/,
  /(我|让我)?[\s\S]{0,4}来[\s\S]{0,4}(看看|查查|看看|瞧瞧|瞅瞅)/,
  /workflow[\s\S]{0,10}(卡|挂了|卡住|坏|乱|有问题|不对|出问题)/,
  /(干|做|搞|弄)完[\s\S]{0,4}再(回|说|告诉|给)/,
  /(还|還)[\s\S]{0,4}(差|欠|少|缺)[\s\S]{0,6}(一点|一些|些|一会儿)/,
  /主要部分[\s\S]{0,4}(完成|改完|写完|做完|搞定)/,
  /(我|让)?[\s\S]{0,2}(先不用|先不要|先别)[\s\S]{0,4}(回|答|说|告诉)/,
  /(我直接|我马上|我先|让我先)[\s\S]{0,8}(干|做|改|看|查|跑|读|写|调|调试|处理)/,
  /继续[\s\S]{0,4}(检查|修改|做|查|看|读|写|跑|调试|测试|浏览)/,
  /还需要做|还要做|还要改|还要写|继续语法检查|继续做|继续读/
]

/**
 * Conservative markers for a real final answer.
 * 必须命中以下任一才算 final_answer（保守判定）
 * @type {Array<RegExp>}
 */
const STRICT_FINAL_ANSWER_MARKERS = [
  // 中文：明确的总结 / 报告 / 完成结论
  /(最终报告|完成报告|修改总结|测试结果|最终结果|任务总结|工作总结)/,
  /(已|已经|已全部|已完全|已成功)?(全部|完全|整体)?(完成|做完|搞定|改完|写完|通过|测试通过|跑通)/,
  /以下是?[\s\S]{0,8}(最终|完整|结果|输出|答案|回答|报告)/,
  /下面是?[\s\S]{0,8}(最终|完整|结果|输出|答案|回答|报告)/,
  // 英文
  /\bfinal (report|answer|summary|result)\b/i,
  /\b(all|everything) (done|complete|finished|completed)\b/i,
  /\b(summary|report|recap|wrap[- ]?up)\s*:/i,
  /\bto summarize\b/i,
  /\bin conclusion\b/i,
  /\bhere'?s (the|my) (final|summary|result)\b/i
]

// ----------------------------------------------------------------------------
// Safe fallback tool set
// ----------------------------------------------------------------------------
// Retry exhaustion may still be recoverable if the model clearly intended a
// read/list/search action. The fallback path is deliberately read-only: it must
// never invent writes, deletes, notebook edits, or arbitrary shell commands.

/**
 * Tool names that fallback must never construct.
 * 任何包含在这些集合中的工具，绝不构造 fallback 工具调用
 * @type {Set<string>}
 */
const FORBIDDEN_FALLBACK_TOOL_NAMES = new Set([
  'edit',
  'multiedit',
  'write',
  'notebookedit',
  'delete',
  'remove',
  'rm',
  'create',
  'overwrite'
])

/**
 * Historical safety net for Bash-like tools. The controller currently filters
 * Bash out before fallback, so this list is kept for direct unit coverage and
 * future explicit opt-in only.
 *   - node -c <file>           语法检查
 *   - npm test                 跑测试
 *   - npm run test / lint
 *   - git status --short
 *   - git diff --stat
 * 任何不匹配这些正则的命令 → 不构造 Bash fallback
 * @type {Array<RegExp>}
 */
const BASH_FALLBACK_WHITELIST = [
  /^node\s+-c\s+[\w./-]+$/,
  /^npm\s+test$/,
  /^npm\s+run\s+test$/,
  /^npm\s+run\s+lint$/,
  /^git\s+status\s+--short$/,
  /^git\s+diff\s+--stat$/
]

/**
 * Extract the first file-looking token from the rejected model output.
 * 命中 → 用于 Read 工具的 file_path
 * @param {string} badOutput
 * @returns {string|null}
 */
const extractFirstFilePath = (badOutput) => {
  if (typeof badOutput !== 'string' || badOutput.length === 0) return null
  // 优先：src/x.js / ./x.js / x.js 形式（含扩展名）
  const re = /(?:\.{0,2}\/)?(?:[\w-]+\/)*[\w-]+\.(?:js|ts|jsx|tsx|mjs|cjs|json|md|py|css|html|vue|yaml|yml|toml|sh|sql|txt|env|gitignore)\b/i
  const m = badOutput.match(re)
  return m ? m[0] : null
}

/**
 * Extract a search pattern from rejected model output.
 * 命中 → 用于 Grep/Search 工具的 pattern / query
 * @param {string} badOutput
 * @returns {string|null}
 */
const extractSearchPattern = (badOutput) => {
  if (typeof badOutput !== 'string' || badOutput.length === 0) return null
  // 形如  search "foo" / grep for 'bar' / find pattern "xxx"
  const patterns = [
    /(?:search|grep|find|rg)\s+(?:for\s+)?["'`]([^"'`\n]{2,80})["'`]/i,
    /(?:search|grep|find|rg)\s+(?:for\s+)?pattern\s*[:=]?\s*["'`]([^"'`\n]{2,80})["'`]/i,
    /(?:pattern|regex)\s*[:=]\s*["'`]([^"'`\n]{2,80})["'`]/i
  ]
  for (const re of patterns) {
    const m = badOutput.match(re)
    if (m) return m[1]
  }
  return null
}

/**
 * Recognize a whitelisted read-only shell command from rejected output.
 * 命中 → 用于 Bash 工具的 command
 * @param {string} badOutput
 * @returns {string|null}
 */
const extractSafeBashCommand = (badOutput) => {
  if (typeof badOutput !== 'string' || badOutput.length === 0) return null
  // 先抓整段（行内 + 反引号 / 字符串内）
  const candidates = []
  // 反引号或引号包裹的命令
  const re = /["'`]([^"'`\n]{2,200})["'`]/g
  let m
  while ((m = re.exec(badOutput)) !== null) {
    candidates.push(m[1])
  }
  // 整段本身
  candidates.push(badOutput)
  for (const cand of candidates) {
    const trimmed = cand.trim()
    for (const wl of BASH_FALLBACK_WHITELIST) {
      if (wl.test(trimmed)) return trimmed
    }
  }
  return null
}

/**
 * Build a read-only fallback tool call after strict retry fails.
 *
 * 目标：retry 耗尽后，尝试把 badOutput 安全地路由到一个只读类工具，
 *       让 Claude Code 不会把过程话术当成 final answer 而停止。
 *
 * 行为规则：
 *  1. 优先按 badOutput 中的语义匹配 Read / LS / Grep / Bash（仅安全白名单）
 *  2. 严禁 fallback 到 Edit / Write / MultiEdit / NotebookEdit / Delete 等写入类
 *  3. 任何与 input_schema 冲突 / 无法构造合法 arguments → 返回 ok=false
 *  4. 没有合适的语义匹配且无安全工具可用 → 返回 ok=false（外部应返回 error）
 *  5. 不输出完整 badOutput；只记录工具名 + 触发原因
 *
 * @param {Object} options
 * @param {string|undefined|null} options.badOutput - 上一轮被判定为 process_text / invalid 的模型输出
 * @param {Array<Object>} options.tools - Anthropic 风格工具定义（{name, description, input_schema}）
 * @param {Array<Object>} [options.messages] - 当前 messages（用于上下文；本函数不主动消费）
 * @param {Object} [options.logger] - 日志
 * @param {string} [options.defaultPath] - LS/Glob fallback 时的默认路径
 * @returns {{ ok: boolean, toolCall: ?{id:string,type:string,function:{name:string,arguments:string}}, reason: string }}
 */
const buildFallbackToolUse = ({ badOutput, tools, messages, logger, defaultPath } = {}) => {
  const safeLog = (msg, kind) => {
    if (logger && typeof logger.debug === 'function') {
      try { logger.debug?.(msg, kind || 'STRICT') } catch (_) { /* ignore */ }
    }
  }

  if (!Array.isArray(tools) || tools.length === 0) {
    return { ok: false, toolCall: null, reason: 'no-tools-available' }
  }

  // 构造按工具名索引（小写比较）
  const lowerIndex = new Map()
  for (const t of tools) {
    if (t && typeof t.name === 'string' && t.name.length > 0) {
      lowerIndex.set(t.name.toLowerCase(), t)
    }
  }

  // 0) 防御：badOutput 不存在 / 完全空白 → 选 LS
  const hasBadOutput = typeof badOutput === 'string' && badOutput.trim().length > 0

  // 1) 优先级 A：badOutput 含文件名（带扩展名）→ Read
  if (hasBadOutput) {
    const filePath = extractFirstFilePath(badOutput)
    if (filePath) {
      const readTool =
        lowerIndex.get('read') ||
        lowerIndex.get('view') ||
        null
      if (readTool && !FORBIDDEN_FALLBACK_TOOL_NAMES.has('read')) {
        const args = validateArgsAgainstSchema(readTool, { file_path: filePath })
        if (args.ok) {
          const toolCall = makeToolCall(readTool.name, { file_path: filePath })
          safeLog(
            `strict_tool_mode fallback_tool_use selected Read reason=file_reference file=${filePath.replace(/[^\w./-]/g, '')}`,
            'STRICT'
          )
          return { ok: true, toolCall, reason: 'file_reference' }
        }
      }
    }
  }

  // 2) 优先级 B：badOutput 含 check / list / current state → LS / List
  //    注意：意图已明确 → 若 LS 不存在或 args 不合法，直接 ok=false
  //    （不要 fallthrough 到 Read，让上层走 error 路径；避免"用错工具"误导 Claude Code）
  if (hasBadOutput) {
    const lower = badOutput.toLowerCase()
    if (/\b(check|list|ls|current state|project|files? in)\b/.test(lower)) {
      const lsTool = lowerIndex.get('ls') || lowerIndex.get('list') || null
      if (lsTool) {
        const path = (typeof defaultPath === 'string' && defaultPath.length > 0) ? defaultPath : '.'
        const args = validateArgsAgainstSchema(lsTool, { path })
        if (args.ok) {
          const toolCall = makeToolCall(lsTool.name, { path })
          safeLog(
            `strict_tool_mode fallback_tool_use selected ${lsTool.name} reason=list_intent`,
            'STRICT'
          )
          return { ok: true, toolCall, reason: 'list_intent' }
        }
      }
      // 意图命中但工具不可用 → ok=false（避免"用错工具"）
      return { ok: false, toolCall: null, reason: 'list_intent-no-tool' }
    }
  }

  // 3) 优先级 C：badOutput 含 search / grep / find + pattern → Grep / Glob / Search
  //    意图已明确 → 工具不可用 / pattern 缺失 → 直接 ok=false
  if (hasBadOutput) {
    const lower = badOutput.toLowerCase()
    if (/\b(search|grep|find|rg|glob)\b/.test(lower)) {
      const pattern = extractSearchPattern(badOutput)
      const grepTool = lowerIndex.get('grep') || lowerIndex.get('search') || null
      if (grepTool && pattern) {
        const argShape = grepTool.name.toLowerCase() === 'search'
          ? { query: pattern }
          : { pattern }
        const args = validateArgsAgainstSchema(grepTool, argShape)
        if (args.ok) {
          const toolCall = makeToolCall(grepTool.name, args.value)
          safeLog(
            `strict_tool_mode fallback_tool_use selected ${grepTool.name} reason=search_intent`,
            'STRICT'
          )
          return { ok: true, toolCall, reason: 'search_intent' }
        }
      }
      // 退一步：Glob（不一定有 pattern）
      const globTool = lowerIndex.get('glob') || null
      if (globTool) {
        const pat = pattern || '**/*'
        const args = validateArgsAgainstSchema(globTool, { pattern: pat })
        if (args.ok) {
          const toolCall = makeToolCall(globTool.name, { pattern: pat })
          safeLog(
            `strict_tool_mode fallback_tool_use selected ${globTool.name} reason=search_intent`,
            'STRICT'
          )
          return { ok: true, toolCall, reason: 'search_intent' }
        }
      }
      // 意图命中但工具不可用 → ok=false
      return { ok: false, toolCall: null, reason: 'search_intent-no-tool' }
    }
  }

  // 4) 优先级 D：badOutput 含 syntax check / test / node -c / npm test → Bash（仅白名单）
  //    意图已明确 → 工具不可用 / 白名单命令缺失 → 直接 ok=false
  //    绝不能用 Read 替代（"用错工具"会让 Claude Code 错读上下文）
  if (hasBadOutput) {
    const lower = badOutput.toLowerCase()
    // 不要求尾部 \b，让 "syntax checks" / "syntax checking" 也能命中
    if (/(syntax check|node -c|npm test|npm run|git status|git diff|test result|run test)/.test(lower)) {
      const cmd = extractSafeBashCommand(badOutput)
      if (cmd) {
        const bashTool = lowerIndex.get('bash') || null
        if (bashTool) {
          const args = validateArgsAgainstSchema(bashTool, { command: cmd })
          if (args.ok) {
            const toolCall = makeToolCall(bashTool.name, { command: cmd })
            safeLog(
              `strict_tool_mode fallback_tool_use selected Bash reason=syntax_check_intent`,
              'STRICT'
            )
            return { ok: true, toolCall, reason: 'syntax_check_intent' }
          }
        }
      }
      // 意图命中但工具不可用 / 命令不在白名单 → ok=false
      // 不要 fallthrough 到 Read / LS（用错工具更糟）
      return { ok: false, toolCall: null, reason: 'syntax_check_intent-no-tool' }
    }
  }

  // 5) 最后兜底：badOutput 存在但无明确意图 → LS / Read 二选一
  //    这才是真正"没有意图"，fallback 出一个最无害的只读操作是合理的
  if (hasBadOutput) {
    const lsTool = lowerIndex.get('ls') || lowerIndex.get('list') || null
    if (lsTool) {
      const path = (typeof defaultPath === 'string' && defaultPath.length > 0) ? defaultPath : '.'
      const args = validateArgsAgainstSchema(lsTool, { path })
      if (args.ok) {
        const toolCall = makeToolCall(lsTool.name, { path })
        safeLog(
          `strict_tool_mode fallback_tool_use selected ${lsTool.name} reason=generic_progress_text`,
          'STRICT'
        )
        return { ok: true, toolCall, reason: 'generic_progress_text' }
      }
    }
    const readTool = lowerIndex.get('read') || lowerIndex.get('view') || null
    if (readTool) {
      const args = validateArgsAgainstSchema(readTool, { file_path: '.' })
      if (args.ok) {
        const toolCall = makeToolCall(readTool.name, { file_path: '.' })
        safeLog(
          `strict_tool_mode fallback_tool_use selected ${readTool.name} reason=generic_progress_text`,
          'STRICT'
        )
        return { ok: true, toolCall, reason: 'generic_progress_text' }
      }
    }
  }

  return { ok: false, toolCall: null, reason: 'no-safe-fallback-match' }
}

/**
 * Build the internal OpenAI-shaped tool_call object.
 * @param {string} name
 * @param {Object} args
 * @returns {{id:string,type:string,function:{name:string,arguments:string}}}
 */
const makeToolCall = (name, args) => ({
  id: `call_${generateUUID().replace(/-/g, '').slice(0, 24)}`,
  type: 'function',
  function: {
    name,
    arguments: JSON.stringify(args || {})
  }
})

/**
 * Lightly validate generated fallback arguments against the tool schema.
 *   - 检查所有 required 字段都已提供
 *   - 检查字段类型（string / number / boolean / object / array）
 *   - 字段不在 schema → 仍保留（OpenAI/Anthropic 都允许额外字段，但本函数保守：不写未声明字段）
 * 校验失败 → ok=false（外部应放弃 fallback）
 *
 * @param {Object} toolDef - 工具定义
 * @param {Object} args - 拟构造的参数
 * @returns {{ ok: boolean, value: Object }}
 */
const validateArgsAgainstSchema = (toolDef, args) => {
  if (!toolDef || typeof toolDef !== 'object') return { ok: false, value: null }
  const schema = toolDef.input_schema || toolDef.parameters || null
  if (!schema || typeof schema !== 'object') {
    // 没有 schema → 宽松通过
    return { ok: true, value: args || {} }
  }
  const props = (schema.properties && typeof schema.properties === 'object') ? schema.properties : {}
  const required = Array.isArray(schema.required) ? schema.required : []
  const finalArgs = {}

  for (const key of Object.keys(props)) {
    if (Object.prototype.hasOwnProperty.call(args || {}, key)) {
      const expected = props[key]
      const expectedType = expected && expected.type
      const val = args[key]
      if (expectedType && !matchesType(val, expectedType)) {
        return { ok: false, value: null }
      }
      finalArgs[key] = val
    }
  }
  for (const req of required) {
    if (!Object.prototype.hasOwnProperty.call(finalArgs, req)) {
      return { ok: false, value: null }
    }
  }
  return { ok: true, value: finalArgs }
}

/**
 * Minimal JSON Schema type check used by fallback validation.
 * @param {*} val
 * @param {string|Array<string>} expectedType
 * @returns {boolean}
 */
const matchesType = (val, expectedType) => {
  const types = Array.isArray(expectedType) ? expectedType : [expectedType]
  for (const t of types) {
    if (t === 'string' && typeof val === 'string') return true
    if (t === 'number' && typeof val === 'number' && Number.isFinite(val)) return true
    if (t === 'integer' && typeof val === 'number' && Number.isInteger(val)) return true
    if (t === 'boolean' && typeof val === 'boolean') return true
    if (t === 'object' && val && typeof val === 'object' && !Array.isArray(val)) return true
    if (t === 'array' && Array.isArray(val)) return true
    if (t === 'null' && val === null) return true
  }
  return false
}

// ----------------------------------------------------------------------------
// BufferState：每次 retry 独立的 buffer
// ----------------------------------------------------------------------------

/**
 * 创建一次 attempt 独立的 buffer 状态
 * 关键不变量：每次 attempt 的 buffer 都从空开始，绝不与上一次 mix
 * @returns {{
 *   append: (chunk: string) => void,
 *   getRaw: () => string,
 *   reset: () => void,
 *   size: () => number,
 *   isEmpty: () => boolean
 * }}
 */
const createBufferState = () => {
  let raw = ''
  return {
    append(chunk) {
      if (typeof chunk === 'string' && chunk.length > 0) raw += chunk
    },
    getRaw() {
      return raw
    },
    reset() {
      raw = ''
    },
    size() {
      return raw.length
    },
    isEmpty() {
      return raw.trim().length === 0
    }
  }
}

// ----------------------------------------------------------------------------
// 工具调用提取（独立于 extractToolCallsFromBuffer，不依赖 anthropic.js）
// ----------------------------------------------------------------------------

/**
 * 从原始文本提取合法的工具调用
 * - 优先 <tool_call>{...}</tool_call> XML 块
 * - 其次 markdown code block ```json ... ```
 * - 最后裸 JSON object / array
 * - 工具名必须命中 toolNames（保留大小写）
 * - arguments 必须是 object；非 object → 强制 {}
 * @param {string} text
 * @param {Set<string>} toolNames
 * @returns {{
 *   toolCalls: Array<{id:string, type:string, function:{name:string, arguments:string}}>,
 *   recognized: boolean
 * }}
 */
const extractToolCalls = (text, toolNames) => {
  if (typeof text !== 'string' || text.length === 0 || !toolNames || toolNames.size === 0) {
    return { toolCalls: [], recognized: false }
  }
  // parseLooseToolCallsFromText 期望 [{name}] 形态
  const toolNameArr = Array.from(toolNames).map((n) => ({ name: n }))
  // parseLooseToolCallsFromText 已支持 XML / code fence / 裸 JSON
  const loose = parseLooseToolCallsFromText(text, toolNameArr)
  if (loose && loose.toolCalls && loose.toolCalls.length > 0) {
    return { toolCalls: loose.toolCalls, recognized: true }
  }
  return { toolCalls: [], recognized: false }
}

/**
 * 检测"含 <tool_call> XML 块，但工具名不在白名单"
 * 命中 → INVALID_TOOL_NAME
 * @param {string} text
 * @param {Set<string>} toolNames
 * @returns {boolean}
 */
const hasUnknownToolCallBlock = (text, toolNames) => {
  if (typeof text !== 'string' || !text.includes('<tool_call>') || !toolNames || toolNames.size === 0) {
    return false
  }
  const re = /<tool_call>([\s\S]*?)<\/tool_call>/g
  let m
  while ((m = re.exec(text)) !== null) {
    const inner = m[1]
    // 试着从 inner 中提 name
    const nm = inner.match(/["'](?:name|tool|function)["']\s*:\s*["']([^"']+)["']/)
    if (!nm) {
      // 没解析出 name —— 算 unknown
      return true
    }
    const resolved = resolveToolName(nm[1], toolNames)
    if (!resolved) {
      return true
    }
  }
  return false
}

/**
 * 检测"含 JSON 形态但解析失败"
 * 命中 → INVALID_JSON
 * 条件: 同时含 { 和 }，且 <tool_call> 没匹配到，但 findBalancedJsonEnd 失败 / JSON.parse 抛
 * @param {string} text
 * @returns {boolean}
 */
const hasInvalidJsonAttempt = (text) => {
  if (typeof text !== 'string') return false
  if (text.includes('<tool_call>')) return false
  // 含 { ... "name": "..." ... } 形态
  if (!/\{[\s\S]*?["'](?:name|tool|function)["']\s*:\s*["'][^"']{1,80}["']/.test(text)) {
    return false
  }
  // 试着从最近的 { 开始平衡解析
  const idx = text.indexOf('{')
  if (idx === -1) return false
  let depth = 0
  let inString = false
  let escape = false
  for (let i = idx; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escape) { escape = false; continue }
      if (ch === '\\') { escape = true; continue }
      if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        const candidate = text.slice(idx, i + 1)
        try {
          const parsed = JSON.parse(candidate)
          // 解析成功 → 不是 invalid
          if (parsed && typeof parsed === 'object') return false
        } catch (_) {
          return true
        }
        return false
      }
    }
  }
  // 没匹配到平衡括号，但有 name 字段 → 也算 invalid
  return true
}

// ----------------------------------------------------------------------------
// 主决策：classifyBuffer
// ----------------------------------------------------------------------------

/**
 * 把 buffer 文本分类成 decision
 * @param {string} text - 原始文本
 * @param {Set<string>} toolNames - 可用工具名集合
 * @returns {{
 *   kind: string,           // DECISION.*
 *   toolCalls: Array<Object>,
 *   cleanedText: string,
 *   reason: string          // 人类可读原因（日志用）
 * }}
 *
 * 决策流程（按优先级从高到低）：
 *   1. 提取到合法 tool_call → TOOL_USE（终态）
 *   2. 命中过程话术黑名单 → PROCESS_TEXT（必须 retry）
 *   3. 命中 profile 的 toolIntentPatterns → PROCESS_TEXT（兼容历史判断）
 *   4. 含 function_calls 但工具名非法 → INVALID_TOOL_NAME
 *   5. 含 JSON 形态但解析失败 → INVALID_JSON
 *   6. 命中严格 final 白名单 → FINAL_ANSWER（终态）
 *   7. 命中 profile 的 finalReportPatterns → FINAL_ANSWER（宽匹配兜底）
 *   8. 以上都不命中 → AMBIGUOUS_FINAL（兜底，触发 retry）
 */
const classifyBuffer = (text, toolNames) => {
  const safeText = (typeof text === 'string') ? text : ''
  const safeNames = (toolNames instanceof Set) ? toolNames : new Set()
  const empty = { kind: DECISION.NO_TOOL_CALL, toolCalls: [], cleanedText: safeText, reason: 'empty-or-no-text' }

  if (safeText.trim().length === 0) return empty

  // 1) 优先尝试提取合法 tool_call
  const extracted = extractToolCalls(safeText, safeNames)
  if (extracted.toolCalls.length > 0) {
    return {
      kind: DECISION.TOOL_USE,
      toolCalls: extracted.toolCalls,
      cleanedText: '',
      reason: 'extracted-valid-tool-call'
    }
  }

  // 2) 命中"过程话术黑名单" → 绝对不能当 final
  for (const re of STRICT_PROCESS_TEXT_BLACKLIST) {
    if (re.test(safeText.slice(0, 800))) {
      return {
        kind: DECISION.PROCESS_TEXT,
        toolCalls: [],
        cleanedText: safeText,
        reason: `process-text-blacklist:${re.source.slice(0, 30)}`
      }
    }
  }

  // 3) 命中 "claude-code-profile.js" 的"打算调工具"特征（兼容历史判断）
  if (typeof claudeCodeProfile.looksLikeIntendsToCallTool === 'function'
      && claudeCodeProfile.looksLikeIntendsToCallTool(safeText)) {
    return {
      kind: DECISION.PROCESS_TEXT,
      toolCalls: [],
      cleanedText: safeText,
      reason: 'profile-tool-intent'
    }
  }

  // 4) 含 <tool_call> 但工具名非法 → invalid_tool_name
  if (hasUnknownToolCallBlock(safeText, safeNames)) {
    return {
      kind: DECISION.INVALID_TOOL_NAME,
      toolCalls: [],
      cleanedText: safeText,
      reason: 'tool-call-block-with-unknown-name'
    }
  }

  // 5) 含 JSON 形态但解析失败 → invalid_json
  if (hasInvalidJsonAttempt(safeText)) {
    return {
      kind: DECISION.INVALID_JSON,
      toolCalls: [],
      cleanedText: safeText,
      reason: 'json-parse-failed'
    }
  }

  // 6) 真正 final answer（白名单强特征）→ final_answer
  for (const re of STRICT_FINAL_ANSWER_MARKERS) {
    if (re.test(safeText.slice(0, 1500))) {
      return {
        kind: DECISION.FINAL_ANSWER,
        toolCalls: [],
        cleanedText: safeText,
        reason: `final-marker:${re.source.slice(0, 30)}`
      }
    }
  }
  // 7) 兼容：claude-code-profile.js 的 finalReportPatterns（宽匹配，但放在最后兜底）
  if (typeof claudeCodeProfile.looksLikeFinalReport === 'function'
      && claudeCodeProfile.looksLikeFinalReport(safeText)) {
    return {
      kind: DECISION.FINAL_ANSWER,
      toolCalls: [],
      cleanedText: safeText,
      reason: 'profile-final-report-pattern'
    }
  }

  // 8) 兜底：ambiguous_final
  return {
    kind: DECISION.AMBIGUOUS_FINAL,
    toolCalls: [],
    cleanedText: safeText,
    reason: 'no-strong-marker-fallback'
  }
}

// ----------------------------------------------------------------------------
// 状态机：StrictToolModeAttempt
// ----------------------------------------------------------------------------

/**
 * 创建一次 strict tool mode attempt 的状态对象
 * 每次 retry 都应该 new 一个
 * @param {{
 *   toolNames: Set<string>,
 *   attempt: number,         // 0-based, 0=首次
 *   maxRetries: number,      // CLAUDE_CODE_TOOL_CORRECTION_RETRIES
 *   logger?: Object
 * }} options
 * @returns {{
 *   buffer: {append, getRaw, reset, size, isEmpty},
 *   decide: () => {kind, toolCalls, cleanedText, reason, needsRetry, attempt},
 *   markRetryConsumed: () => void,
 *   state: () => string
 * }}
 */
const createAttempt = (options = {}) => {
  const toolNames = (options.toolNames instanceof Set) ? options.toolNames : new Set()
  const attempt = (Number(options.attempt) || 0)
  const maxRetries = (Number(options.maxRetries) || 0)
  const logger = options.logger || null

  const buffer = createBufferState()
  let state = 'collecting' // 'collecting' | 'classified' | 'retry-scheduled' | 'finalized'
  let lastDecision = null

  const log = (msg, kind) => {
    if (logger && typeof logger.debug === 'function') {
      try { logger.debug?.(`[strict-mode attempt=${attempt}] ${msg}`, kind || 'STRICT') } catch (_) { /* ignore */ }
    }
  }

  return {
    buffer,
    state: () => state,
    /**
     * classify 当前 buffer，返回 decision（不修改 state）
     * @returns {{kind:string, toolCalls:Array, cleanedText:string, reason:string, needsRetry:boolean, attempt:number}}
     */
    decide() {
      const text = buffer.getRaw()
      const decision = classifyBuffer(text, toolNames)
      const needsRetry = RETRY_TRIGGERING_KINDS.has(decision.kind)
        && (attempt < maxRetries)
        && state === 'collecting'
      lastDecision = decision
      log(
        `kind=${decision.kind} reason=${decision.reason} ` +
        `textLen=${text.length} toolCalls=${decision.toolCalls.length} needsRetry=${needsRetry}`,
        'STRICT'
      )
      return {
        kind: decision.kind,
        toolCalls: decision.toolCalls,
        cleanedText: decision.cleanedText,
        reason: decision.reason,
        needsRetry,
        attempt
      }
    },
    /**
     * 把当前 attempt 标记为"已决定 retry，下一次应另起 buffer"
     */
    markRetryConsumed() {
      if (state === 'collecting') state = 'retry-scheduled'
    },
    /**
     * 把当前 attempt 标记为"已完成（成功 / blocked）"
     */
    markFinalized() {
      state = 'finalized'
    },
    /**
     * 拿最后一次 decide 结果（不重新 classify）
     */
    getLastDecision() {
      return lastDecision
    }
  }
}

// ----------------------------------------------------------------------------
// 工具函数：appendRetryHint
// ----------------------------------------------------------------------------

/**
 * 把 bad output 摘要成可放进 hint 的安全片段
 *   - 截断到 20000 字符以内
 *   - 去掉可能含 token / cookie / Bearer / 完整 prompt 的片段
 *   - 单行（去掉换行）
 * @param {string} text
 * @returns {string}
 */
const summarizeBadOutput = (text) => {
  if (typeof text !== 'string') return ''
  // 去掉敏感字串
  let s = text
    .replace(/Bearer\s+[A-Za-z0-9_\-.=]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/cookie\s*[:=]\s*[^\s;,]+/gi, 'cookie=[REDACTED]')
    .replace(/token\s*[:=]\s*[^\s;,]+/gi, 'token=[REDACTED]')
  // 折成单行
  s = s.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (s.length > 20000) s = s.slice(0, 20000) + '...'
  return s
}

/**
 * Summarize available tools and schemas for a compact retry hint.
 * @param {Array<Object>} tools - Anthropic 风格工具定义
 * @param {number} [max=8] - 最多列几个工具（避免 hint 过长）
 * @returns {string}
 */
const summarizeToolContext = (tools, max = 8) => {
  if (!Array.isArray(tools) || tools.length === 0) return '(no tools)'
  const lines = []
  const limit = Math.min(tools.length, max)
  for (let i = 0; i < limit; i++) {
    const t = tools[i]
    if (!t || typeof t.name !== 'string') continue
    const schema = t.input_schema || t.parameters || null
    let sig = '{ ... }'
    if (schema && typeof schema === 'object') {
      const props = schema.properties && typeof schema.properties === 'object'
        ? Object.keys(schema.properties)
        : []
      const required = Array.isArray(schema.required) ? schema.required : []
      const requiredSet = new Set(required)
      const fields = props.slice(0, 6).map((k) => {
        const isReq = requiredSet.has(k)
        return `${k}${isReq ? '' : '?'}`
      })
      if (fields.length > 0) sig = `{ ${fields.join(', ')}${props.length > 6 ? ', ...' : ''} }`
    }
    lines.push(`- \`${t.name}\`: ${sig}`)
  }
  if (tools.length > limit) lines.push(`- ... (${tools.length - limit} more)`)
  return lines.join('\n')
}

/**
 * 构造 retry prompt：明确告诉模型"只输出 <tool_call> 块或最终报告"
 * - 不打印 token / cookie / 完整 prompt
 * - 同时支持中英文
 * - Optionally includes tool schema and a sanitized summary of the rejected output.
 *   这样 retry 不会"丢失工具上下文"，模型能更准确地选 tool_call
 *
 * @param {Object|undefined} previousDecision - 上一次的 decision（用于给出针对性 hint）
 * @param {Object} [options]
 * @param {Array<Object>} [options.tools] - 当前可用工具（Anthropic 风格）
 * @param {string} [options.badOutput] - 上一轮被拒绝的模型输出（仅取摘要，不入正文）
 * @returns {string} 提示文本
 */
const buildStrictRetryHint = (previousDecision, options = {}) => {
  const kind = (previousDecision && previousDecision.kind) || 'unknown'
  const hintByKind = {
    process_text: 'Your previous reply was a progress narration / status message. Claude Code stops when it sees a non-tool natural-language reply, so the workflow was interrupted.',
    invalid_tool_name: 'Your previous reply attempted a tool call but the tool name is not in the available list.',
    invalid_json: 'Your previous reply contained malformed JSON inside a tool_call block.',
    no_tool_call: 'Your previous reply did not call any tool.',
    ambiguous_final: 'Your previous reply was neither a tool call nor a clearly structured final report.'
  }
  const specific = hintByKind[kind] || 'Your previous reply did not produce a usable tool call.'

  const toolCtx = summarizeToolContext(Array.isArray(options.tools) ? options.tools : [])
  const badSummary = summarizeBadOutput(options.badOutput || '')

  return [
    'IMPORTANT — strict tool mode is active. You MUST follow these rules for this reply:',
    specific,
    '',
    'Available tools (call ONLY one of these, with arguments matching its schema):',
    toolCtx,
    '',
    'Reply with EXACTLY ONE of the following:',
    '  (A) A single <tool_call>...</tool_call> block calling one of the available tools listed above.',
    '  (B) A clearly structured final report. The final report must contain at least one of these markers: 最终报告 / 完成报告 / 修改总结 / 测试结果 / 最终结果 / 任务总结 / final report / summary / "all done" / "completed".',
    '不要输出过程话术、状态消息、承诺继续执行、道歉或前置解释。',
    'Do NOT output process narration, status messages, or "let me check..." / "I will look at..." / "我继续检查" / "正在做" / "刚改完..." / "workflow 又卡了".',
    'If the task is not finished, call a tool. If the task is finished, write a clearly-marked final report.',
    'Do NOT output anything else (no preamble, no explanation, no apology).',
    ...(badSummary ? ['', `Last bad output summary: ${badSummary}`] : []),
    '',
  ].join('\n')
}

/**
 * 把 retry hint 追加到 body.messages
 * @param {Object} body - 内部请求体
 * @param {string} hint
 * @returns {Object} 新请求体（不可变）
 */
const appendStrictRetryHint = (body, hint) => appendHintToLastMessage(body, hint)

/**
 * 把 attempt 失败的"阻断信息"包装成 tool_use 之外的明文（仅作为 blocked 状态产物）
 * @param {number} attempt - 已尝试次数
 * @returns {string} 阻断文本（不含敏感信息）
 */
const buildBlockedMessage = (attempt) => {
  return [
    '模型没有生成合法 tool_call，已阻止将过程话术作为最终回答返回。',
    `(已尝试 ${attempt + 1} 次 strict tool mode 重试；如需继续，请缩小任务范围或显式调小期望输出)`
  ].join(' ')
}

/**
 * Message returned when retry is exhausted and no safe fallback can be built.
 *   - 不再被 Claude Code 当成"任务完成"
 *   - 包含 strict_tool_mode_no_tool_call 标识 + 重试建议
 * @param {number} attempt - 已尝试次数
 * @returns {string}
 */
const buildStrictModeNoToolCallError = (attempt) => {
  return [
    'chat backend did not produce a valid tool_call after retries',
    `(strict_tool_mode_no_tool_call attempts=${attempt + 1}; please retry or narrow the task)`
  ].join(' ')
}

// ----------------------------------------------------------------------------
// 模块导出
// ----------------------------------------------------------------------------

module.exports = {
  DECISION,
  RETRY_TRIGGERING_KINDS,
  createBufferState,
  createAttempt,
  classifyBuffer,
  extractToolCalls,
  hasUnknownToolCallBlock,
  hasInvalidJsonAttempt,
  buildStrictRetryHint,
  appendStrictRetryHint,
  // 暴露给测试：黑/白名单
  STRICT_PROCESS_TEXT_BLACKLIST,
  STRICT_FINAL_ANSWER_MARKERS
}
