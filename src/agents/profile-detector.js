/**
 * profile-detector.js
 *
 * Detect the request's client profile from route, headers, user-agent, and
 * request body shape.
 *
 * 关键不变量：
 *   - protocol（anthropic / openai）由 URL 路径决定（/v1/messages vs /v1/chat/completions）
 *   - profile 必须在 protocol 允许的集合内，否则回退到该 protocol 的默认 profile
 *   - 未知 profile / 异常 body → 兜底默认 profile，永不抛错
 *   - 不在 profile-detector 里做任何账号/token/cookie/CLI 决策
 */

const HEADER_NAME = 'x-qwen-client-profile'

// 已注册的 profile 集合（按 name 索引；来源是各 profile 文件）
// 注意：这里只 import 元数据（profile 对象），不调用其内部函数，
// 避免循环依赖，detector 只读 profile.protocol / profile.name。
const PROFILE_NAMES = Object.freeze([
  'claude-code',
  'generic-anthropic',
  'openai-compatible',
  'hermes-agent',
  'pi-agent',
  'codex'
])

// protocol -> 允许的 profile 名称
// 注意：'claude-code' 同时允许 anthropic + openai 协议。
//   - 在 anthropic 协议下：Claude Code SDK 原生调用，`/v1/messages`。
//   - 在 openai 协议下：Claude Code 通过 openai 兼容中转层（如 LiteLLM、自建 relay）调用 deepseek 路线。
//     由 detectClaudeCodeFromOpenAIBody() 启发式识别 system 消息或工具列表中的 Claude Code 特征。
const PROTOCOL_ALLOWED = Object.freeze({
  anthropic: Object.freeze(['claude-code', 'generic-anthropic']),
  openai: Object.freeze(['openai-compatible', 'hermes-agent', 'claude-code', 'pi-agent', 'codex'])
})

// protocol -> 默认 profile 名称
const PROTOCOL_DEFAULT = Object.freeze({
  anthropic: 'claude-code',
  openai: 'openai-compatible'
})

/**
 * 内部：把任意值规整成小写字符串
 */
const toLowerString = (v) => {
  if (typeof v === 'string') return v.trim().toLowerCase()
  if (v == null) return ''
  if (Array.isArray(v)) {
    // 多值 header：取第一个
    return toLowerString(v[0])
  }
  return String(v).trim().toLowerCase()
}

/**
 * 内部：从 header 字典安全取值（不区分大小写键名）
 */
const pickHeader = (req, name) => {
  if (!req || typeof req !== 'object') return ''
  if (req.headers && typeof req.headers === 'object') {
    if (Object.prototype.hasOwnProperty.call(req.headers, name)) {
      return req.headers[name]
    }
    // 不区分大小写
    const target = name.toLowerCase()
    for (const k of Object.keys(req.headers)) {
      if (k.toLowerCase() === target) return req.headers[k]
    }
  }
  if (req.get && typeof req.get === 'function') {
    try { return req.get(name) || '' } catch (_) { /* swallow */ }
  }
  return ''
}

/**
 * 内部：判断一个 profile 名是否在某个 protocol 的允许集合内
 */
const isProfileAllowed = (name, protocol) => {
  if (!name || !protocol) return false
  const allowed = PROTOCOL_ALLOWED[protocol]
  if (!allowed) return false
  return allowed.indexOf(name) >= 0
}

/**
 * 内部：取 protocol 默认 profile
 */
const getDefaultProfileName = (protocol) => {
  return PROTOCOL_DEFAULT[protocol] || null
}

/**
 * 自动识别：User-Agent / 自定义 header 含 hermes → hermes-agent
 * 条件：只在 openai protocol 下生效
 */
const detectHermesFromHeaders = (req) => {
  const ua = toLowerString(pickHeader(req, 'user-agent'))
  const xClient = toLowerString(pickHeader(req, 'x-client-name'))
  const xApp = toLowerString(pickHeader(req, 'x-app-name'))
  const xSource = toLowerString(pickHeader(req, 'x-source'))
  const explicitHermes = [
    pickHeader(req, 'x-hermes-session-id'),
    pickHeader(req, 'x-hermes-client'),
    pickHeader(req, 'x-hermes-agent'),
  ].some(value => value !== undefined && value !== null && String(value).trim() !== '')
  const blob = [ua, xClient, xApp, xSource].join(' ')
  if (explicitHermes) return true
  if (!blob) return false
  if (blob.includes('hermes-agent')) return true
  if (blob.includes('nousresearch')) return true
  if (/\bhermes\b/.test(blob)) return true
  return false
}

/**
 * 自动识别：User-Agent / Header 含 Pi 编码助手 → pi-agent
 * 条件：只在 openai protocol 下生效
 */
const detectPiFromHeaders = (req) => {
  const ua = toLowerString(pickHeader(req, 'user-agent'))
  const xClient = toLowerString(pickHeader(req, 'x-client-name'))
  const blob = [ua, xClient].join(' ')
  if (!blob) return false
  if (blob.includes('pi (coding agent)') || blob.includes('pi-coding-agent') || /^pi[\s/]/i.test(blob)) return true
  return false
}

/**
 * 自动识别：User-Agent / Header 含 Codex CLI → codex
 * 条件：只在 openai protocol 下生效
 */
const detectCodexFromHeaders = (req) => {
  const ua = toLowerString(pickHeader(req, 'user-agent'))
  const xClient = toLowerString(pickHeader(req, 'x-client-name'))
  const blob = [ua, xClient].join(' ')
  if (blob.includes('codex') || /^codex[\s/]/i.test(blob)) return true
  if (pickHeader(req, 'x-codex-session-id') || pickHeader(req, 'x-codex-thread-id')) return true
  return false
}

const collectPromptText = (value, depth = 0) => {
  if (depth > 8 || value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(item => collectPromptText(item, depth + 1)).filter(Boolean).join('\n')
  if (typeof value !== 'object') return ''

  return ['text', 'content', 'value']
    .map(key => collectPromptText(value[key], depth + 1))
    .filter(Boolean)
    .join('\n')
}

const containsHermesIdentity = (value) => {
  const text = collectPromptText(value)
  return /hermes\s*agent/i.test(text) || /nous\s*research/i.test(text)
}

/**
 * 自动识别：system 消息含 Hermes Agent 特征 → hermes-agent
 * 条件：只在 openai protocol 下生效，作为 headers 检测的 fallback
 * （Hermes 使用 Python OpenAI SDK 时可能不设 Hermes 专属 UA）
 */
const detectHermesFromBody = (body) => {
  if (!body || typeof body !== 'object') return false
  if (containsHermesIdentity(body.system)
    || containsHermesIdentity(body.developer)
    || containsHermesIdentity(body.instructions)) return true

  // Only inspect system/developer messages. User/tool content may contain
  // quoted text mentioning Hermes and must not change the client profile.
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (msg && (msg.role === 'system' || msg.role === 'developer') && containsHermesIdentity(msg.content)) {
        return true
      }
    }
  }
  return false
}

/**
 * 自动识别：anthropic body 有 tools / tool_choice / anthropic-version / Claude Code 常见字段
 * 命中即 claude-code（默认即是 claude-code，但显式声明更可观测）
 */
const detectClaudeCodeFromBody = (body) => {
  if (!body || typeof body !== 'object') return false
  if (Array.isArray(body.tools) && body.tools.length > 0) return true
  if (body.tool_choice !== undefined && body.tool_choice !== null) return true
  if (typeof body.anthropic_version === 'string' && body.anthropic_version.length > 0) return true
  // Claude Code 常见 system 字段包含 "Claude Code"
  const sys = body.system
  if (typeof sys === 'string' && /claude\s*code/i.test(sys)) return true
  if (Array.isArray(sys)) {
    for (const seg of sys) {
      if (seg && typeof seg === 'object' && typeof seg.text === 'string' && /claude\s*code/i.test(seg.text)) {
        return true
      }
    }
  }
  // model 字段以 claude- 开头也是 Claude 系列客户端特征
  if (typeof body.model === 'string' && /^claude[-_]/i.test(body.model)) return true
  return false
}

/**
 * 自动识别：OpenAI 协议 body 是否来自 Claude Code 客户端。
 *
 * 触发场景：用户用 LiteLLM / 自建 OpenAI 兼容中转层 / claude-code 的 openai 兼容模式
 * 把 Claude Code 的请求转成 OpenAI 协议转发到本服务。
 *
 * 启发式（任意一条命中即视为 Claude Code）：
 *  - system 消息含 "Claude Code"
 *  - tools 列表同时含 Read + Bash + Edit 三个标志性工具
 *  - tools 列表含 ≥ 4 个 Claude Code 标志性工具
 *    （Read/Write/Edit/Bash/Glob/Grep/WebSearch/WebFetch 中任意）
 *  - model 字段以 claude- 开头
 *
 * 注意：只读 system/tools/model 三个字段，不读 messages 内部（避免泄漏内容）。
 *
 * @param {Object} body - OpenAI 协议请求 body
 * @returns {boolean}
 */
const detectClaudeCodeFromOpenAIBody = (body) => {
  if (!body || typeof body !== 'object') return false

  // 1) system 消息含 "Claude Code"
  const sys = body.system
  if (typeof sys === 'string' && /claude\s*code/i.test(sys)) return true
  if (Array.isArray(sys)) {
    for (const seg of sys) {
      if (seg && typeof seg === 'object' && typeof seg.text === 'string' && /claude\s*code/i.test(seg.text)) {
        return true
      }
    }
  }

  // 2) model 以 claude- 开头
  if (typeof body.model === 'string' && /^claude[-_]/i.test(body.model)) return true

  // 3) tools 列表特征
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const names = new Set()
    for (const t of body.tools) {
      // OpenAI 风格：{ type: "function", function: { name } }
      const name = t && (t.name || t.function?.name)
      if (typeof name === 'string' && name.length > 0) names.add(name)
    }
    // 标志性工具
    const has = (n) => names.has(n)
    // 条件 A: 同时含 Read + Bash + Edit（强信号）
    if (has('Read') && has('Bash') && has('Edit')) return true
    // 条件 B: 含 ≥ 4 个 Claude Code 标志性工具
    const claudeCodeToolNames = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task', 'KillBash', 'NotebookEdit']
    let hit = 0
    for (const n of claudeCodeToolNames) {
      if (has(n)) hit += 1
      if (hit >= 4) return true
    }
  }

  return false
}

/**
 * 对外：根据 req + protocol 推断 client profile
 *
 * @param {Object} req - Express req（可只取 headers + body）
 * @param {'anthropic'|'openai'} protocol - 由路径决定
 * @param {Object} [options]
 * @param {Object} [options.body] - 可显式传入 body（用于测试或中间件前置）
 * @returns {{ name: string, source: string, protocol: string }}
 */
const detectClientProfile = (req, protocol, options = {}) => {
  const safeProtocol = (protocol === 'anthropic' || protocol === 'openai') ? protocol : null

  // 0. 协议无效 → 兜底 'unknown'
  if (!safeProtocol) {
    return { name: 'unknown', source: 'invalid_protocol', protocol: String(protocol || '') }
  }

  // 1. 显式 header 优先
  let headerName = toLowerString(pickHeader(req, HEADER_NAME))
  if (headerName) {
    // 校验是否在已知集合
    if (PROFILE_NAMES.indexOf(headerName) < 0) {
      // 未知 profile → 兜底默认 + 记录来源
      return {
        name: getDefaultProfileName(safeProtocol),
        source: 'header_unknown_fallback',
        protocol: safeProtocol,
        headerValue: headerName
      }
    }
    // 校验 protocol 兼容性
    if (!isProfileAllowed(headerName, safeProtocol)) {
      return {
        name: getDefaultProfileName(safeProtocol),
        source: 'header_incompatible_fallback',
        protocol: safeProtocol,
        headerValue: headerName
      }
    }
    return { name: headerName, source: 'header', protocol: safeProtocol }
  }

  // 2. 自动识别
  if (safeProtocol === 'openai' && detectHermesFromHeaders(req)) {
    return { name: 'hermes-agent', source: 'auto_hermes_ua', protocol: safeProtocol }
  }
  if (safeProtocol === 'openai' && detectPiFromHeaders(req)) {
    return { name: 'pi-agent', source: 'auto_pi_ua', protocol: safeProtocol }
  }
  if (safeProtocol === 'openai' && detectCodexFromHeaders(req)) {
    return { name: 'codex', source: 'auto_codex_ua', protocol: safeProtocol }
  }
  if (safeProtocol === 'openai') {
    // OpenAI 协议下识别 Claude Code（用户用 LiteLLM / openai 兼容中转层）
    const body = options.body || (req && req.body) || null
    if (detectClaudeCodeFromOpenAIBody(body)) {
      return { name: 'claude-code', source: 'auto_claude_code_openai_body', protocol: safeProtocol }
    }
    // body 检测 Hermes（UA 检测的 fallback）
    if (detectHermesFromBody(body)) {
      return { name: 'hermes-agent', source: 'auto_hermes_body', protocol: safeProtocol }
    }
  }
  if (safeProtocol === 'anthropic') {
    const body = options.body || (req && req.body) || null
    if (detectClaudeCodeFromBody(body)) {
      return { name: 'claude-code', source: 'auto_claude_code_body', protocol: safeProtocol }
    }
  }

  // 3. 协议默认
  return { name: getDefaultProfileName(safeProtocol), source: 'protocol_default', protocol: safeProtocol }
}

/**
 * 取某个协议下默认 profile 名
 */
const getDefaultProfile = (protocol) => {
  return getDefaultProfileName(protocol)
}

/**
 * 判定某 profile 名是否兼容某 protocol
 */
const isProfileCompatible = (name, protocol) => {
  return isProfileAllowed(name, protocol)
}

module.exports = {
  HEADER_NAME,
  PROFILE_NAMES,
  PROTOCOL_ALLOWED,
  PROTOCOL_DEFAULT,
  detectClientProfile,
  detectClaudeCodeFromBody,
  detectClaudeCodeFromOpenAIBody,
  getDefaultProfile,
  isProfileCompatible
}
