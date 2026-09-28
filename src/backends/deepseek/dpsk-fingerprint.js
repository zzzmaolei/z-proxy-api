/**
 * dpsk-fingerprint.js
 *
 * DeepSeek 账号指纹池 — 确定性分配，每个账号获得不同的浏览器指纹。
 *
 * 设计原则：
 *  - 不依赖外部服务，纯内置指纹库
 *  - 通过 email hash 确定性分配（同一账号始终拿到同一指纹）
 *  - 12 组真实浏览器指纹，覆盖 Chrome/Edge/Firefox × Windows/macOS/Linux
 *  - 每个指纹包含：userAgent / acceptLanguage / secChUa / platform
 *  - 指纹由 IP + UA + header 组合生效，配合 per-account proxy 效果更佳
 *
 * 使用方式：
 *   const { getFingerprint } = require('./dpsk-fingerprint')
 *   const fp = getFingerprint('user@mail.com')  // 始终返回同一指纹
 *   // fp → { userAgent, acceptLanguage, secChUa, platform }
 */

// ---------------------------------------------------------------------------
// 指纹库 — 12 组真实浏览器指纹
// ---------------------------------------------------------------------------

const FINGERPRINTS = Object.freeze([
  // 0: Chrome 120 Windows zh-CN
  {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
    secChUa: '"Google Chrome";v="120", "Not?A_Brand";v="8"',
    platform: 'Windows',
  },
  // 1: Chrome 120 Windows en-US
  {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    acceptLanguage: 'en-US,en;q=0.9',
    secChUa: '"Google Chrome";v="120", "Not?A_Brand";v="8"',
    platform: 'Windows',
  },
  // 2: Chrome 120 macOS zh-CN
  {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
    secChUa: '"Google Chrome";v="120", "Not?A_Brand";v="8"',
    platform: 'macOS',
  },
  // 3: Chrome 120 macOS en-US
  {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    acceptLanguage: 'en-US,en;q=0.9,zh;q=0.8',
    secChUa: '"Google Chrome";v="120", "Not?A_Brand";v="8"',
    platform: 'macOS',
  },
  // 4: Edge 120 Windows zh-CN
  {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.7',
    secChUa: '"Microsoft Edge";v="120", "Chromium";v="120", "Not?A_Brand";v="8"',
    platform: 'Windows',
  },
  // 5: Edge 120 Windows en-US
  {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    acceptLanguage: 'en-US,en;q=0.9',
    secChUa: '"Microsoft Edge";v="120", "Chromium";v="120", "Not?A_Brand";v="8"',
    platform: 'Windows',
  },
  // 6: Firefox 121 Windows zh-CN
  {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
    acceptLanguage: 'zh-CN,zh;q=0.9,en-US;q=0.7,en;q=0.6',
    secChUa: undefined, // Firefox 不发送 sec-ch-ua
    platform: 'Windows',
  },
  // 7: Firefox 121 macOS en-US
  {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.2; rv:121.0) Gecko/20100101 Firefox/121.0',
    acceptLanguage: 'en-US,en;q=0.9',
    secChUa: undefined,
    platform: 'macOS',
  },
  // 8: Chrome 119 Linux en-US
  {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    acceptLanguage: 'en-US,en;q=0.9',
    secChUa: '"Google Chrome";v="119", "Not?A_Brand";v="8"',
    platform: 'Linux',
  },
  // 9: Chrome 120 Windows ja-JP
  {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    acceptLanguage: 'ja-JP,ja;q=0.9,en;q=0.7',
    secChUa: '"Google Chrome";v="120", "Not?A_Brand";v="8"',
    platform: 'Windows',
  },
  // 10: Edge 120 macOS zh-CN
  {
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0',
    acceptLanguage: 'zh-CN,zh;q=0.9,en;q=0.8',
    secChUa: '"Microsoft Edge";v="120", "Chromium";v="120", "Not?A_Brand";v="8"',
    platform: 'macOS',
  },
  // 11: Firefox 121 Linux en-US
  {
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
    acceptLanguage: 'en-US,en;q=0.9',
    secChUa: undefined,
    platform: 'Linux',
  },
]);

// ---------------------------------------------------------------------------
// Hash 工具
// ---------------------------------------------------------------------------

/**
 * 简单字符串 hash → [0, range) 范围内的整数
 * 用 DJB2 算法，确定性的，进程无关
 */
function hashEmail(email) {
  if (!email) return 0;
  const s = String(email).trim().toLowerCase();
  let hash = 5381;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) + hash) + s.charCodeAt(i);
    hash = hash & 0x7fffffff; // keep positive
  }
  return hash;
}

// ---------------------------------------------------------------------------
// 导出的函数
// ---------------------------------------------------------------------------

/**
 * 根据 email 获取确定性指纹
 * 同一 email 在同一进程/不同进程间始终返回同一指纹
 *
 * @param {string} email - 账号邮箱
 * @returns {{ userAgent: string, acceptLanguage: string, secChUa: string|undefined, platform: string }}
 */
function getFingerprint(email) {
  const idx = hashEmail(email) % FINGERPRINTS.length;
  const fp = FINGERPRINTS[idx];
  return {
    userAgent: fp.userAgent,
    acceptLanguage: fp.acceptLanguage,
    secChUa: fp.secChUa,
    platform: fp.platform,
  };
}

/**
 * 获取指纹库中所有可用指纹的元数据（用于调试 / dashboard）
 * @returns {Array<{index: number, platform: string, browser: string}>}
 */
function getFingerprintMeta() {
  const browsers = ['Chrome', 'Chrome', 'Chrome', 'Chrome', 'Edge', 'Edge', 'Firefox', 'Firefox', 'Chrome', 'Chrome', 'Edge', 'Firefox'];
  return FINGERPRINTS.map((fp, i) => ({
    index: i,
    platform: fp.platform,
    browser: browsers[i] || 'Unknown',
    acceptLanguage: fp.acceptLanguage?.split(',')[0] || 'unknown',
  }));
}

module.exports = {
  getFingerprint,
  getFingerprintMeta,
  FINGERPRINTS,
};
