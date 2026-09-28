/**
 * 共用账号行解析器
 * 同时被 ENV ACCOUNTS 加载（utils/data-persistence.js）和
 * 后台批量添加（routes/accounts.js）复用，
 * 保证两条入口对账号格式与代理 URL 的解析行为完全一致。
 *
 * 支持的输入格式（向后兼容）：
 *   email:password                 — 旧格式
 *   email:password|proxy_url       — 新格式，附带账号级代理
 *
 * 注意：使用 indexOf 而非 split，避免密码中包含 ':' 时把后半截截断
 */

/**
 * 解析单行账号文本
 * @param {string} line - 单行原始文本
 * @returns {{ email: string, password: string, proxy: string|null } | null} 解析失败返回 null
 */
const parseAccountLine = (line) => {
  if (typeof line !== 'string') return null
  const trimmed = line.trim()
  if (!trimmed) return null

  // 先按第一个 '|' 切出可选 proxy（proxy 部分自身可能含有 '|'，例如 query 参数极少见，这里按首个分隔）
  const pipeIdx = trimmed.indexOf('|')
  const credentials = pipeIdx === -1 ? trimmed : trimmed.slice(0, pipeIdx)
  const proxyRaw = pipeIdx === -1 ? '' : trimmed.slice(pipeIdx + 1)
  const proxy = proxyRaw.trim() || null

  // credentials 部分按第一个 ':' 切分，保留密码中可能存在的 ':'
  const colonIdx = credentials.indexOf(':')
  if (colonIdx === -1) return null

  const email = credentials.slice(0, colonIdx).trim()
  const password = credentials.slice(colonIdx + 1).trim()

  if (!email || !password) return null

  return { email, password, proxy }
}

module.exports = {
  parseAccountLine
}
