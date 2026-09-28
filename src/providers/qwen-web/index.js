/**
 * index.js
 *
 * Qwen Web provider 统一出口。
 *
 * 业务代码应使用本文件导出，不要再直接引用子文件。
 * 这样后续做"Qwen Web 协议变更"时，只在 provider 内部改。
 *
 * 子模块：
 *  - endpoints   路径常量 + URL 构造
 *  - headers     header 构造（Timezone 运行时生成）
 *  - errors      结构化错误
 *  - normalizer  宽松响应解析
 *  - client      createChat / sendChatCompletion
 */

const endpoints = require('./endpoints')
const headers = require('./headers')
const errors = require('./errors')
const normalizer = require('./normalizer')
const client = require('./client')

module.exports = {
  endpoints,
  headers,
  errors,
  normalizer,
  client
}
