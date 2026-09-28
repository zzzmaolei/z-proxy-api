/**
 * endpoints.js
 *
 * 集中定义 Qwen Web chat 反代所需的所有上游 path。
 *
 * 原则：
 *  - 业务代码（request.js、chat.image.video.js、anthropic.js 等）
 *    不得再硬编码 /api/v2/chats/new、/api/v2/chat/completions 等
 *  - 任何上游 path 变更只改本文件
 *  - path 是相对 path，绝对 URL 由调用方基于 baseUrl 拼装
 *
 * 模块边界：
 *  - 只维护静态 path
 *  - 不做动态抓取或浏览器自动化
 */

const PATHS = Object.freeze({
  // 创建会话（generateChatID 用）
  // JS bundle 中虽未直接出现 /api/v2/chats/new（可能模板拼接），但实测旧路径仍可用
  chatsNew: '/api/v2/chats/new',

  // 聊天补全（chat / 流式 / 图像 / 视频）
  chatCompletions: '/api/v2/chat/completions',

  // 模型列表
  models: '/api/models',

  // 拉取聊天详情（图片/视频补取用）
  chatsDetail: (chatID) => `/api/v2/chats/${encodeURIComponent(chatID)}`,

  // 视频任务状态轮询
  tasksStatus: (taskID) => `/api/v1/tasks/status/${encodeURIComponent(taskID)}`
})

/**
 * 把 path 与 baseUrl 拼成完整 URL。
 * - baseUrl 不带尾斜杠；path 一定以 / 开头
 * @param {string} baseUrl
 * @param {string} path
 * @returns {string}
 */
const buildUrl = (baseUrl, path) => {
  if (!baseUrl) throw new Error('[qwen-web] buildUrl 需要 baseUrl')
  if (!path) throw new Error('[qwen-web] buildUrl 需要 path')
  const b = String(baseUrl).replace(/\/+$/, '')
  const p = String(path).startsWith('/') ? path : `/${path}`
  return `${b}${p}`
}

/**
 * chat completions 完整 URL：含 chat_id 查询参数
 * @param {string} baseUrl
 * @param {string} chatId
 * @returns {string}
 */
const buildChatCompletionsUrl = (baseUrl, chatId) => {
  const id = encodeURIComponent(chatId || '')
  return `${buildUrl(baseUrl, PATHS.chatCompletions)}?chat_id=${id}`
}

module.exports = {
  PATHS,
  buildUrl,
  buildChatCompletionsUrl
}
