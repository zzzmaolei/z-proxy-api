/**
 * normalizer.js
 *
 * 把 Qwen Web 上游响应宽松解析为内部标准格式。
 *
 * 设计目标：
 *  - 业务代码不再直接读 raw.data.data.id、raw.choices[0].delta.content
 *  - 上游小改动时只改本文件，不会触发全局崩溃
 *  - 解析不到时抛结构化 QwenWebError，便于上层分类 / 报警
 *
 * 边界：
 *  - 只解析已有 JSON/文本响应
 *  - 不动态执行 JS / HTML
 *  - 不做 JS Challenge 模拟
 */

const { createQwenError, isHtmlErrorPage, previewOf, ERROR_KINDS } = require('./errors')

/* ---------------- 内部工具 ---------------- */

const _isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x)

const _pickFromPaths = (root, paths) => {
  for (const path of paths) {
    let cur = root
    let ok = true
    for (const seg of path) {
      if (cur == null) { ok = false; break }
      cur = cur[seg]
    }
    if (ok && cur !== undefined && cur !== null && cur !== '') {
      return cur
    }
  }
  return undefined
}

/* ---------------- chat create ---------------- */

/**
 * 解析 createChat 响应
 * @param {*} raw
 * @returns {{ chatId: string, raw: any }}
 * @throws {Error} QwenWebError with kind=upstream_schema_changed
 */
const normalizeChatCreateResponse = (raw) => {
  if (isHtmlErrorPage(raw)) {
    throw createQwenError(ERROR_KINDS.UPSTREAM_HTML_ERROR, 'createChat 返回 HTML 错误页', {
      where: 'normalizeChatCreateResponse',
      rawPreview: previewOf(raw)
    })
  }

  // 兼容字段路径：
  //   data.id                       （当前实际）
  //   data.data.id                  （历史嵌套）
  //   id
  //   data.chat_id
  //   chat_id
  const chatId = _pickFromPaths(raw, [
    ['data', 'id'],
    ['data', 'data', 'id'],
    ['id'],
    ['data', 'chat_id'],
    ['chat_id']
  ])

  if (chatId === undefined || chatId === null || chatId === '') {
    throw createQwenError(ERROR_KINDS.UPSTREAM_SCHEMA_CHANGED,
      'createChat 响应里找不到 chat id', {
        where: 'normalizeChatCreateResponse',
        rawPreview: previewOf(raw)
      }
    )
  }

  return { chatId: String(chatId), raw }
}

module.exports = {
  normalizeChatCreateResponse
}
