/**
 * auth — apiKey 读取工具（纯函数，无 Vue 响应式依赖，router 守卫中可直接使用）
 */
export function getApiKey() {
  return localStorage.getItem('apiKey') || ''
}

export function getAuthHeaders() {
  return { 'Authorization': getApiKey() }
}
