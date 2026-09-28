/**
 * Per-account Client Profile — 每账号固定不同设备指纹 / 语言 / 时区
 *
 * 通过 QWEN_CLIENT_PROFILE_MODE=stable-per-account 启用。
 * 每个账号根据 email 的确定性哈希分配到 profile 变体池中的固定组合，
 * 同一账号始终获得相同 profile，不同账号获得不同 profile。
 * 新增账号自动适配，无需手动配置。
 *
 * 实现原则：
 *   - 只改 HTTP 请求头（UA / sec-ch-ua / Accept-Language / Timezone）
 *   - 不随机指纹、不改 TLS、不改 IP、不绕 CAPTCHA
 *   - 默认关闭，不改变现有行为
 */

const config = require('../../config')
const { logger } = require('../../utils/logger')

// ──────────────── Profile 变体池 ────────────────

const UA_VARIANTS = [
  {
    name: 'Edge-150',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0',
    secChUa: '"Not;A=Brand";v="8", "Chromium";v="150", "Microsoft Edge";v="150"',
    secChUaPlatform: '"Windows"'
  },
  {
    name: 'Edge-149',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0',
    secChUa: '"Not;A=Brand";v="8", "Chromium";v="149", "Microsoft Edge";v="149"',
    secChUaPlatform: '"Windows"'
  },
  {
    name: 'Edge-148',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36 Edg/148.0.0.0',
    secChUa: '"Not;A=Brand";v="8", "Chromium";v="148", "Microsoft Edge";v="148"',
    secChUaPlatform: '"Windows"'
  },
  {
    name: 'Chrome-150',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36',
    secChUa: '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"',
    secChUaPlatform: '"Windows"'
  },
  {
    name: 'Chrome-149',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    secChUa: '"Not;A=Brand";v="8", "Chromium";v="149", "Google Chrome";v="149"',
    secChUaPlatform: '"Windows"'
  }
]

const LANGUAGE_VARIANTS = [
  { name: 'zh-CN', value: 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7' },
  { name: 'en-US', value: 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7' },
  { name: 'ja-JP', value: 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7' },
  { name: 'ko-KR', value: 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7' },
  { name: 'zh-TW', value: 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7' }
]

// 时区 → GMT offset 映射（分钟）
const TIMEZONE_VARIANTS = [
  { name: 'Asia/Shanghai',    offset: 480 },   // GMT+8
  { name: 'Asia/Tokyo',       offset: 540 },   // GMT+9
  { name: 'America/New_York', offset: -240 },  // GMT-4 (EDT)
  { name: 'Europe/London',    offset: 60 },    // GMT+1 (BST)
  { name: 'Asia/Singapore',   offset: 480 }    // GMT+8
]

// ──────────────── 确定性哈希 ────────────────

/**
 * DJB2 哈希（32-bit），确定性、无碰撞概率极低
 */
function hashEmail(email) {
  let hash = 5381
  for (let i = 0; i < email.length; i++) {
    hash = ((hash << 5) + hash) + email.charCodeAt(i) // hash * 33 + c
    hash = hash & 0xffffffff // 32-bit
  }
  return hash >>> 0 // unsigned
}

// ──────────────── 时区字符串生成 ────────────────

/**
 * 为指定 GMT offset 生成 Qwen Web 风格的 timezone 字符串
 * 格式: "Mon Jul 20 2026 18:44:07 GMT+0800"
 *
 * 注意：每次调用都基于当前时间生成，不缓存结果。
 * profile 对象中只保存 timezoneOffsetMinutes / timezoneFamily，
 * 调用方（如 headers.js）应在每次构建 headers 时动态调用：
 *   buildTimezoneString(profile.timezoneOffsetMinutes)
 * 不要把返回值写进 profile，否则会导致每次请求都用同一个过期日期字符串。
 */
function buildTimezoneString(offsetMinutes) {
  const now = new Date()
  // 用 UTC 时间 + offset 计算目标时区的本地时间
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000
  const local = new Date(utcMs + offsetMinutes * 60000)

  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const pad = (n) => String(n).padStart(2, '0')

  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absOffset = Math.abs(offsetMinutes)
  const h = pad(Math.floor(absOffset / 60))
  const m = pad(absOffset % 60)

  return `${days[local.getDay()]} ${months[local.getMonth()]} ${pad(local.getDate())} ${local.getFullYear()} ` +
         `${pad(local.getHours())}:${pad(local.getMinutes())}:${pad(local.getSeconds())} ` +
         `GMT${sign}${h}${m}`
}

// ──────────────── 一致性校验 ────────────────

/**
 * 校验 client profile 内部字段一致性
 *
 * 检查项：
 *   1. UA Chrome 版本 = sec-ch-ua Chromium 版本
 *      （从 UA 提取 `Chrome/XXX`，从 sec-ch-ua 提取 `"Chromium";v="XXX"`，比较 XXX）
 *   2. UA 平台 = sec-ch-ua-platform
 *      （从 UA 提取 `Windows NT` / `Macintosh` / `X11; Linux`，
 *      映射到 `Windows` / `macOS` / `Linux`，与 sec-ch-ua-platform 比较）
 *   3. Accept-Language 的第一个语言标签 = profile.locale
 *   4. 移动端标记与 UA/平台一致
 *      （UA 含 `Mobile` / `Android` / `iPhone` 时 sec-ch-ua-mobile 应为 `?1`，否则 `?0`）
 *
 * 不一致时抛出 Error，消息包含 _profileId 和具体的不一致字段列表。
 *
 * @param {Object} profile - client profile 对象
 * @throws {Error} 一致性校验失败时抛出
 */
function validateProfileConsistency(profile) {
  if (!profile || typeof profile !== 'object') {
    throw new Error('ClientProfile consistency check failed: profile is null/undefined')
  }

  const {
    userAgent,
    secChUa,
    secChUaPlatform,
    acceptLanguage,
    locale,
    secChUaMobile,
    _profileId
  } = profile

  const id = _profileId || 'unknown'
  const errors = []

  // 1. UA Chrome 版本 vs sec-ch-ua Chromium 版本
  if (userAgent && secChUa) {
    const uaChromeMatch = String(userAgent).match(/Chrome\/(\d+)/)
    const secChUaChromiumMatch = String(secChUa).match(/"Chromium";v="(\d+)"/)
    if (uaChromeMatch && secChUaChromiumMatch) {
      const uaVersion = uaChromeMatch[1]
      const secChUaVersion = secChUaChromiumMatch[1]
      if (uaVersion !== secChUaVersion) {
        errors.push(`Chrome version mismatch: UA Chrome/${uaVersion} vs sec-ch-ua Chromium ${secChUaVersion}`)
      }
    }
  }

  // 2. UA 平台 vs sec-ch-ua-platform
  if (userAgent && secChUaPlatform) {
    const ua = String(userAgent)
    let uaPlatform = null
    if (/Windows NT/.test(ua)) uaPlatform = 'Windows'
    else if (/Macintosh|Mac OS X/.test(ua)) uaPlatform = 'macOS'
    else if (/X11; Linux|Linux x86_64/.test(ua)) uaPlatform = 'Linux'

    // sec-ch-ua-platform 形如 '"Windows"'，去掉外层引号
    const secChUaPlatformValue = String(secChUaPlatform).replace(/^"|"$/g, '')
    if (uaPlatform && uaPlatform !== secChUaPlatformValue) {
      errors.push(`Platform mismatch: UA ${uaPlatform} vs sec-ch-ua-platform ${secChUaPlatformValue}`)
    }
  }

  // 3. Accept-Language 首语言 vs profile.locale
  if (acceptLanguage && locale) {
    // 形如 "zh-CN,zh;q=0.9,..." 的首语言标签为 "zh-CN"
    const firstLang = String(acceptLanguage).split(',')[0].trim().split(';')[0].trim()
    if (firstLang !== String(locale)) {
      errors.push(`Language mismatch: Accept-Language first tag ${firstLang} vs locale ${locale}`)
    }
  }

  // 4. 移动端标记 vs UA/平台
  if (userAgent && secChUaMobile !== undefined && secChUaMobile !== null) {
    const ua = String(userAgent)
    const uaHasMobile = /Mobile|Android|iPhone/i.test(ua)
    const expectsMobile = String(secChUaMobile) === '?1'
    if (uaHasMobile !== expectsMobile) {
      errors.push(`Mobile marker mismatch: UA mobile=${uaHasMobile} vs sec-ch-ua-mobile ${secChUaMobile}`)
    }
  }

  if (errors.length > 0) {
    throw new Error(`ClientProfile ${id} consistency check failed: ${errors.join('; ')}`)
  }
}

// ──────────────── Profile 分配 ────────────────

/**
 * 为账号分配固定的 clientProfile
 * 基于 email 的确定性哈希，同一账号始终获得相同 profile
 * @param {Object} account - 账号对象（会被原地修改，写入 account.clientProfile）
 */
function assignProfileToAccount(account) {
  if (!account || !account.email) return
  if (!isEnabled()) return

  const h = hashEmail(account.email)

  // I1 修复：必须用 >>>（无符号右移），不能用 >>。
  // hashEmail 返回值虽然经过 `>>> 0` 落在 [0, 2^32-1]，但 JS 位运算符会把操作数
  // 转回有符号 32 位。当 h >= 2^31 时，`h >> 4` 会因符号位扩展变成负数，
  // `% LANGUAGE_VARIANTS.length` 在 JS 里对负数取模仍返回负数，
  // 进而 `LANGUAGE_VARIANTS[-3]` 返回 undefined，profile 分配失败。
  // 改用 `>>>` 永远返回非负整数，索引一定落在 [0, length)。
  const uaIdx = h % UA_VARIANTS.length
  const langIdx = (h >>> 4) % LANGUAGE_VARIANTS.length
  const tzIdx = (h >>> 8) % TIMEZONE_VARIANTS.length

  const ua = UA_VARIANTS[uaIdx]
  const lang = LANGUAGE_VARIANTS[langIdx]
  const tz = TIMEZONE_VARIANTS[tzIdx]

  if (!ua || !lang || !tz) {
    logger.warn(`profile 分配失败: email=${account.email} h=${h} uaIdx=${uaIdx} langIdx=${langIdx} tzIdx=${tzIdx}`, 'PROFILE')
    return
  }

  // I2 修复：profile 中只保存 timezoneOffsetMinutes / timezoneFamily，
  // 不再缓存 buildTimezoneString 的返回值。否则 profile 在 assign 阶段被一次性
  // 写入字符串日期，后续每次请求都会复用同一个过期日期字符串（headers 上的
  // Timezone 会停留在进程启动时的那一刻）。
  // 调用方（如 headers.js）应在每次构建 headers 时动态调用：
  //   buildTimezoneString(profile.timezoneOffsetMinutes)
  const candidateProfile = {
    userAgent: ua.ua,
    secChUa: ua.secChUa,
    secChUaPlatform: ua.secChUaPlatform,
    // 当前 UA_VARIANTS 全部是桌面端 UA，移动端标记固定为 ?0
    secChUaMobile: '?0',
    acceptLanguage: lang.value,
    locale: lang.name,
    timezoneOffsetMinutes: tz.offset,
    timezoneFamily: tz.name,
    // 元数据（仅用于日志/调试）
    _profileId: `${ua.name}|${lang.name}|${tz.name}`
  }

  // I3 一致性校验：失败时记录错误日志并跳过该 profile（不 crash）。
  // 校验失败通常意味着 UA_VARIANTS / LANGUAGE_VARIANTS / TIMEZONE_VARIANTS
  // 池本身有 bug（如 UA 写 Chrome/130 但 sec-ch-ua 写 Chromium 131），属于
  // 静态配置错误，需要修变体池而非运行时绕过。这里跳过 profile 分配，
  // 让该账号回退到默认 headers 行为。
  try {
    validateProfileConsistency(candidateProfile)
  } catch (e) {
    logger.error(`profile 一致性校验失败，跳过该 profile: email=${account.email} ${e.message}`, 'PROFILE')
    return
  }

  account.clientProfile = candidateProfile
}

/**
 * 为所有已加载账号分配 profile
 * @param {Object} accountManager - 账号管理器实例
 */
function assignAllProfiles(accountManager) {
  if (!isEnabled()) return
  if (!accountManager || !Array.isArray(accountManager.accountTokens)) return

  let assigned = 0
  for (const account of accountManager.accountTokens) {
    if (!account || !account.email) continue
    assignProfileToAccount(account)
    assigned++
  }
  logger.info(`per-account client profile 已分配: ${assigned} 个账号`, 'PROFILE')
}

// ──────────────── 模式检测 ────────────────

/**
 * 是否启用 per-account profile 模式
 */
function isEnabled() {
  return config.qwenClientProfileMode === 'stable-per-account'
}

// 兼容旧 API
function getClientProfileConfig() {
  return {
    mode: config.qwenClientProfileMode || 'current',
    experiment: config.qwenClientProfileExperiment || false
  }
}

function isExperimentEnabled() {
  return isEnabled()
}

// ──────────────── 导出 ────────────────

module.exports = {
  assignProfileToAccount,
  assignAllProfiles,
  isEnabled,
  // I3：导出一致性校验供外部调用（如 headers.js 在每次构建 headers 时复用校验逻辑）
  validateProfileConsistency,
  // I2：导出动态 timezone 字符串生成函数，供 headers.js（后续任务）在每次
  // 构建 headers 时调用：buildTimezoneString(profile.timezoneOffsetMinutes)
  buildTimezoneString,
  // 兼容旧 API
  getClientProfileConfig,
  isExperimentEnabled,
  getAccountProfile: () => null // 不再使用，由 assignProfileToAccount 替代
}