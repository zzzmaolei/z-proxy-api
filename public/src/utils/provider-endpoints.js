/**
 * provider-endpoints — Provider API 端点映射（纯函数，无 Vue 响应式依赖）
 */
export function getApiEndpoints(p) {
  if (p === 'dpsk') {
    return {
      list: '/api/dpsk/accounts', create: '/api/dpsk/accounts',
      delete: '/api/dpsk/accounts', deleteAll: '/api/dpsk/accounts',
      refresh: '/api/dpsk/accounts/refresh', refreshAll: '/api/dpsk/accounts/refresh',
      forceRefresh: '/api/dpsk/accounts/refresh', stats: '/api/dpsk/stats',
      toggle: '/api/dpsk/accounts/toggle',
      supportsProxy: true, supportsPagination: false, supportsBatch: false,
    }
  }
  return {
    list: '/api/getAllAccounts', create: '/api/setAccount',
    delete: '/api/deleteAccount', deleteAll: '/api/deleteAllAccounts',
    refresh: '/api/refreshAccount', refreshAll: '/api/refreshAllAccounts',
    forceRefresh: '/api/forceRefreshAllAccounts', stats: '/api/accountStats',
    toggle: '/api/toggleAccount',
    supportsProxy: true, supportsPagination: true, supportsBatch: true,
  }
}

export function providerSupportsProxy(p) { return p === 'qwen' || p === 'dpsk' }
export function providerSupportsBatch(p) { return p === 'qwen' }
export function providerSupportsStats() { return true }
export function providerSupportsPagination(p) { return p === 'qwen' }
