/**
 * headers.js
 *
 * Qwen Web chat 反代请求 header 集合。
 *
 * 设计目标：
 *  - 唯一来源（single source of truth）：request.js / chat.image.video.js
 *    都通过 buildQwenHeaders() 拿 header，不再各自硬编码
 *  - Timezone 改为运行时生成（每次调用取当前时间），不再写死固定日期
 *  - User-Agent / bx-v / Version 保持现有值，不动态抓取
 *  - 不引入反风控绕过、TLS 指纹、浏览器自动化
 *
 * 调用方式：
 *   const { buildQwenHeaders } = require('./headers')
 *   const headers = buildQwenHeaders({ token, baseUrl, extra })
 */

const { getSsxmodItna, getSsxmodItna2 } = require('../../backends/qwen/ssxmod-manager')
const { getChatBaseUrl } = require('../../utils/proxy-helper')
const { buildWarmupCookieHeader } = require('../../backends/qwen/qwen-homepage-warmup')
const { getBaxiaHeaders, BAXIA_V } = require('../../backends/qwen/baxia-umid')
const { randomUUID } = require('crypto')

const DEFAULT_QWEN_VERSION = '0.2.81'
const DEFAULT_EDGE_MAJOR = '151'
const DEFAULT_CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ` +
  `(KHTML, like Gecko) Chrome/${DEFAULT_EDGE_MAJOR}.0.0.0 Safari/537.36 Edg/${DEFAULT_EDGE_MAJOR}.0.0.0`
// 与当前浏览器真实请求对齐（chat.qwen.ai Edge 151，sec-ch-ua v=99 新格式）
const DEFAULT_SEC_CH_UA = `"Not=A?Brand";v="99", "Chromium";v="${DEFAULT_EDGE_MAJOR}", "Microsoft Edge";v="${DEFAULT_EDGE_MAJOR}"`

/**
 * 运行时生成一个 Qwen Web 风格的 timezone 字符串
 *
 * 输出格式（与历史硬编码一致，只是每次取当前时间）：
 *   "Mon Dec 08 2025 17:28:55 GMT+0800"
 *
 * 注意：getTimezoneOffset() 返回 UTC - 本地，符号相反。
 * 例如 UTC+8 的时区，getTimezoneOffset() === -480，这里输出 +0800。
 */
const buildTimezoneString = (date) => {
  const d = date instanceof Date ? date : new Date()
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const dayName = days[d.getDay()]
  const monName = months[d.getMonth()]
  const pad = (n) => String(n).padStart(2, '0')

  const tzOffsetMin = -d.getTimezoneOffset() // 0 = UTC，与 GMT+0 表达一致
  const tzSign = tzOffsetMin >= 0 ? '+' : '-'
  const tzAbs = Math.abs(tzOffsetMin)
  const tzH = pad(Math.floor(tzAbs / 60))
  const tzM = pad(tzAbs % 60)

  return `${dayName} ${monName} ${pad(d.getDate())} ${d.getFullYear()} ` +
         `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ` +
         `GMT${tzSign}${tzH}${tzM}`
}

/**
 * Cookie 头：组装 ssxmod_itna / ssxmod_itna2
 * - 取不到 ssxmod 时返回空串（axios 仍允许空 Cookie）
 */
const buildCookieHeader = (options) => {
  const opts = options || {}
  const token = opts.token
  const includeTokenCookie = opts.includeTokenCookie !== false
  const includeWarmupCookies = opts.includeWarmupCookies !== false
  const warmupAccount = opts.account
  const itna = getSsxmodItna()
  const itna2 = getSsxmodItna2()
  const warmupCookieHeader = includeWarmupCookies ? buildWarmupCookieHeader(warmupAccount) : ''
  const parts = []
  if (includeTokenCookie && typeof token === 'string' && token) parts.push(`token=${token}`)
  if (itna) parts.push(`ssxmod_itna=${itna}`)
  if (itna2) parts.push(`ssxmod_itna2=${itna2}`)
  if (warmupCookieHeader) parts.push(warmupCookieHeader)
  return parts.join('; ')
}

const buildReferer = (baseUrl, chatId, options = {}) => {
  if (chatId) return `${baseUrl}/c/${encodeURIComponent(chatId)}`
  // 创建新会话时浏览器使用 /c/new-chat，/c/guest 已被风控标记
  if (options.forNewChat) return `${baseUrl}/c/new-chat`
  return `${baseUrl}/c/guest`
}

/**
 * 构造 Qwen Web 请求 header 集合。
 *
 * @param {Object}  [options]
 * @param {string}  [options.baseUrl]   覆盖 chat base URL（默认 getChatBaseUrl()）
 * @param {string}  [options.token]     Bearer token
 * @param {Object}  [options.account]   账号对象（用于 warmup cookie 作用域）
 * @param {Object}  [options.extra]     额外 header（会覆盖默认；调用方负责谨慎使用）
 * @param {boolean} [options.includeCookie] 是否包含 Cookie 头（默认 true）
 * @param {boolean} [options.includeTokenCookie] 是否在 Cookie 中包含 token=（默认 true）
 * @param {boolean} [options.includeWarmupCookies] 是否拼接首页 warmup cookies（默认 true）
 * @param {boolean} [options.includeAuthHeader] 是否包含 Authorization Bearer 头（默认 true）
 *   浏览器对 source=web 的请求不发送 Authorization，仅用 Cookie: token=<jwt> 鉴权。
 *   同时发送 Authorization + Cookie: token 会触发 RGV587_ERROR 风控。
 * @returns {Object} headers
 */
const buildQwenHeaders = (options) => {
  const opts = options || {}
  const baseUrl = opts.baseUrl || getChatBaseUrl()
  const token = opts.token
  const includeCookie = opts.includeCookie !== false
  const includeAuthHeader = opts.includeAuthHeader !== false
  const tz = buildTimezoneString()
  const referer = buildReferer(baseUrl, opts.chatId)
  const requestId = opts.requestId || randomUUID()
  const source = 'web'

  const headers = {
    'User-Agent': DEFAULT_CHROME_UA,
    'Connection': 'keep-alive',
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Content-Type': 'application/json',
    'Timezone': tz,
    'sec-ch-ua': DEFAULT_SEC_CH_UA,
    'Sec-Ch-Ua': DEFAULT_SEC_CH_UA,
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'source': source,
    'Version': DEFAULT_QWEN_VERSION,
    'Origin': baseUrl,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'Referer': referer,
    'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    'X-Request-Id': requestId,
    'x-request-id': requestId,
    'X-Accel-Buffering': 'no'
  }

  if (includeAuthHeader && token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  // Baxia 安全头（反爬虫验证，缺少会触发 RGV587_ERROR）
  // bx-v: Baxia 版本号，从 JS bundle 中提取，目前为 2.5.36
  // bx-umidtoken: 设备指纹 token，由浏览器 WebUMID 模块生成
  //   从 data/baxia-umid.json 读取，使用 agent-browser 定期刷新
  // bx-ua: 浏览器端指纹，格式为 231!<base64>，由 AWSC JS SDK 生成
  //   该值每次请求变化，包含设备指纹、时间戳等加密信息
  const baxiaHeaders = getBaxiaHeaders()
  if (baxiaHeaders && baxiaHeaders.umidtoken) {
    headers['bx-v'] = baxiaHeaders.bxv || BAXIA_V
    headers['bx-umidtoken'] = baxiaHeaders.umidtoken
    if (baxiaHeaders.bxua) {
      headers['bx-ua'] = baxiaHeaders.bxua
    }
  } else {
    // 即使没有 umidtoken，也发送 bx-v 以降低风控概率
    headers['bx-v'] = BAXIA_V
  }

  if (includeCookie) {
    const cookie = buildCookieHeader({
      token,
      account: opts.account,
      includeTokenCookie: opts.includeTokenCookie,
      includeWarmupCookies: opts.includeWarmupCookies
    })
    if (cookie) headers['Cookie'] = cookie

    // ⚠️ 关键风控规避：
    // 浏览器对 source=web 的请求只发 Cookie: token=，不发 Authorization header。
    // 同时发送 Authorization + Cookie: token 会被 Qwen 风控系统标记为非浏览器请求，
    // 触发 RGV587_ERROR / FAIL_SYS_USER_VALIDATE 验证码。
    // 如果 Cookie 里已经包含 token=，自动禁用 Authorization header 以模拟浏览器行为。
    if (cookie && cookie.includes('token=') && headers['Authorization']) {
      delete headers['Authorization']
    }
  }

  if (opts.extra && typeof opts.extra === 'object') {
    for (const k of Object.keys(opts.extra)) {
      headers[k] = opts.extra[k]
    }
  }

  // 清掉 undefined（axios 允许 undefined header，但留着会污染日志）
  for (const k of Object.keys(headers)) {
    if (headers[k] === undefined) delete headers[k]
  }

  return headers
}

module.exports = {
  buildQwenHeaders
}
