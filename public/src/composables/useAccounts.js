/**
 * useAccounts — 账号管理逻辑
 *
 * 包含 providerStates、分页、多选、CRUD、刷新、模态框状态等。
 * 依赖：axios, getAuthHeaders, getApiEndpoints, providerSupports*, useToast
 */
import { ref, reactive, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import axios from 'axios'
import { getAuthHeaders } from '../utils/auth.js'
import {
  getApiEndpoints,
  providerSupportsProxy,
  providerSupportsBatch,
  providerSupportsPagination,
} from '../utils/provider-endpoints.js'
import { useToast } from './useToast.js'

// 与后端 src/utils/proxy-helper.js#PROXY_URL_REGEX 保持一致
const PROXY_URL_REGEX = /^(https?|socks5):\/\/[^\s]+$/i
const isValidProxy = (value) => {
  if (!value) return true
  const trimmed = String(value).trim()
  if (!trimmed) return true
  return PROXY_URL_REGEX.test(trimmed)
}

const createProviderState = () => ({
  tokens: [],
  currentPage: 1,
  pageSize: 10,
  totalItems: 0,
  selectedTokens: [],
  selectAll: false,
  isRefreshingAll: false,
  isForceRefreshingAll: false,
  refreshingTokens: [],
})

export function useAccounts(categories) {
  const { t } = useI18n()
  const { showToast } = useToast()

  const providerStates = reactive({
    dpsk: createProviderState(),
    qwen: createProviderState(),
  })

  // 模态框状态
  const showAddModal = ref(false)
  const addMode = ref('single')
  const modalProvider = ref('qwen')
  const newAccount = ref({ email: '', password: '', proxy: '' })
  const showEditProxyModal = ref(false)
  const editProxy = ref({ email: '', proxy: '', provider: 'qwen' })
  const isSavingProxy = ref(false)
  const showDeleteAllConfirm = ref(false)
  const deleteAllProvider = ref('qwen')

  const newAccountProxyValid = computed(() => isValidProxy(newAccount.value.proxy))
  const editProxyValid = computed(() => isValidProxy(editProxy.value.proxy))

  // ---- 列表获取 ----
  const totalPages = (p) => {
    const state = providerStates[p]
    return Math.max(1, Math.ceil(state.totalItems / state.pageSize))
  }

  const getTokens = async (p) => {
    const state = providerStates[p]
    const endpoints = getApiEndpoints(p)
    try {
      if (endpoints.supportsPagination) {
        const res = await axios.get(endpoints.list, {
          params: { page: state.currentPage, pageSize: state.pageSize },
          headers: getAuthHeaders(),
        })
        state.tokens = res.data.data
        state.totalItems = res.data.total
      } else {
        const res = await axios.get(endpoints.list, { headers: getAuthHeaders() })
        state.tokens = res.data.data || []
        state.totalItems = state.tokens.length
      }

      if (state.currentPage > totalPages(p) && totalPages(p) > 0) {
        state.currentPage = 1
        await getTokens(p)
        return
      }

      state.selectedTokens = []
      state.selectAll = false
    } catch (error) {
      console.error(`getTokens(${p}) error:`, error)
      showToast(t('msg.fetchFailed') + error.message, 'error')
    }
  }

  const getAllTokens = async () => {
    await Promise.all(categories.map(c => getTokens(c.value)))
  }

  // ---- 多选 ----
  const isSelected = (p, email) => providerStates[p].selectedTokens.includes(email)

  const toggleSelect = (p, email) => {
    const state = providerStates[p]
    const index = state.selectedTokens.indexOf(email)
    if (index === -1) {
      state.selectedTokens.push(email)
    } else {
      state.selectedTokens.splice(index, 1)
    }
    state.selectAll = state.selectedTokens.length === state.tokens.length
  }

  const toggleSelectAll = (p) => {
    const state = providerStates[p]
    if (state.selectAll) {
      state.selectedTokens = state.tokens.map(token => token.email)
    } else {
      state.selectedTokens = []
    }
  }

  // ---- 分页 ----
  const changePage = async (p, page) => {
    const state = providerStates[p]
    const tp = totalPages(p)
    if (page >= 1 && page <= tp) {
      state.currentPage = page
      state.selectedTokens = []
      state.selectAll = false
      await getTokens(p)
    }
  }

  const changePageSize = async (p) => {
    const state = providerStates[p]
    state.currentPage = 1
    state.selectedTokens = []
    state.selectAll = false
    await getTokens(p)
  }

  // ---- 删除 ----
  const deleteToken = async (p, email) => {
    if (!confirm(t('msg.deleteAccountConfirm'))) return
    try {
      const endpoints = getApiEndpoints(p)
      await axios.delete(endpoints.delete, { data: { email }, headers: getAuthHeaders() })
      await getTokens(p)
      showToast(t('msg.deleteAccountSuccess'))
    } catch (error) {
      console.error('deleteToken error:', error)
      showToast(t('msg.deleteAccountFailed') + error.message, 'error')
    }
  }

  const deleteSelected = async (p) => {
    const state = providerStates[p]
    if (state.selectedTokens.length === 0) return
    if (!confirm(t('msg.deleteConfirm', { n: state.selectedTokens.length }))) return
    try {
      const endpoints = getApiEndpoints(p)
      const deletePromises = state.selectedTokens.map(email =>
        axios.delete(endpoints.delete, { data: { email }, headers: getAuthHeaders() })
      )
      await Promise.all(deletePromises)
      await getTokens(p)
      state.selectedTokens = []
      state.selectAll = false
      showToast(t('msg.deleteSuccess'))
    } catch (error) {
      console.error('deleteSelected error:', error)
      showToast(t('msg.deleteFailed') + error.message, 'error')
    }
  }

  const confirmDeleteAll = (p) => {
    deleteAllProvider.value = p
    showDeleteAllConfirm.value = true
  }

  const deleteAllAccounts = async () => {
    const p = deleteAllProvider.value
    const state = providerStates[p]
    try {
      const endpoints = getApiEndpoints(p)
      if (!endpoints.supportsBatch) {
        for (const token of state.tokens) {
          await axios.delete(endpoints.deleteAll, { data: { email: token.email }, headers: getAuthHeaders() })
        }
      } else {
        await axios.delete(endpoints.deleteAll, { headers: getAuthHeaders() })
      }
      showDeleteAllConfirm.value = false
      state.currentPage = 1
      await getTokens(p)
      state.selectedTokens = []
      state.selectAll = false
      showToast(t('msg.allDeleted'))
    } catch (error) {
      console.error('deleteAllAccounts error:', error)
      showToast(t('msg.allDeleteFailed') + error.message, 'error')
    }
  }

  // ---- 添加账号模态框 ----
  const openAddModal = (p) => {
    modalProvider.value = p
    addMode.value = 'single'
    showAddModal.value = true
  }

  const closeAddModal = () => {
    showAddModal.value = false
    // batch 模式的清理由 useBatchTask 通过回调处理，这里保留钩子
    if (typeof onCloseAddModal === 'function') onCloseAddModal()
  }

  // 由 useBatchTask 注入的关闭回调（见 useBatchTask.js 调用方）
  let onCloseAddModal = null
  const setCloseAddModalHook = (fn) => { onCloseAddModal = fn }

  const addToken = async () => {
    const p = modalProvider.value
    try {
      const endpoints = getApiEndpoints(p)
      const payload = {
        email: newAccount.value.email,
        password: newAccount.value.password,
        proxy: endpoints.supportsProxy ? (newAccount.value.proxy?.trim() || null) : null,
      }
      await axios.post(endpoints.create, payload, { headers: getAuthHeaders() })
      closeAddModal()
      newAccount.value = { email: '', password: '', proxy: '' }
      await getTokens(p)
      showToast(t('msg.addSuccess'))
    } catch (error) {
      console.error('addToken error:', error)
      showToast(t('msg.addFailed') + error.message, 'error')
    }
  }

  // ---- 编辑代理 ----
  const openEditProxy = (p, token) => {
    editProxy.value = { email: token.email, proxy: token.proxy || '', provider: p }
    showEditProxyModal.value = true
  }

  const closeEditProxyModal = () => {
    if (isSavingProxy.value) return
    showEditProxyModal.value = false
  }

  const clearProxy = () => {
    editProxy.value.proxy = ''
  }

  const saveProxy = async () => {
    if (isSavingProxy.value) return
    const p = editProxy.value.provider
    const endpoints = getApiEndpoints(p)
    if (!endpoints.supportsProxy) {
      showToast(t('dash.proxyUnsupported', { provider: p.toUpperCase() }), 'warning')
      return
    }
    isSavingProxy.value = true
    try {
      await axios.post('/api/updateAccountProxy', {
        email: editProxy.value.email,
        proxy: editProxy.value.proxy.trim() || null,
      }, { headers: getAuthHeaders() })
      showEditProxyModal.value = false
      await getTokens(p)
      showToast(t('msg.proxyUpdateSuccess'))
    } catch (error) {
      console.error('saveProxy error:', error)
      showToast(t('msg.proxyUpdateFailed') + error.message, 'error')
    } finally {
      isSavingProxy.value = false
    }
  }

  // ---- 刷新 ----
  const refreshToken = async (p, email) => {
    const state = providerStates[p]
    if (state.refreshingTokens.includes(email)) return
    state.refreshingTokens.push(email)
    try {
      const endpoints = getApiEndpoints(p)
      await axios.post(endpoints.refresh, { email }, { headers: getAuthHeaders() })
      await getTokens(p)
      showToast(t('msg.refreshSuccess', { email }))
    } catch (error) {
      console.error('refreshToken error:', error)
      showToast(t('msg.refreshFailed') + error.message, 'error')
    } finally {
      const index = state.refreshingTokens.indexOf(email)
      if (index > -1) state.refreshingTokens.splice(index, 1)
    }
  }

  const refreshAllAccounts = async (p) => {
    const state = providerStates[p]
    if (state.isRefreshingAll) return
    if (!confirm(t('msg.refreshAllConfirm'))) return
    state.isRefreshingAll = true
    try {
      const endpoints = getApiEndpoints(p)
      const payload = endpoints.supportsPagination ? { thresholdHours: 24 } : {}
      const response = await axios.post(endpoints.refreshAll, payload, { headers: getAuthHeaders() })
      await getTokens(p)
      showToast(t('msg.refreshAllComplete', { n: response.data?.refreshedCount || 0 }))
    } catch (error) {
      console.error('refreshAllAccounts error:', error)
      showToast(t('msg.refreshAllFailed') + error.message, 'error')
    } finally {
      state.isRefreshingAll = false
    }
  }

  const forceRefreshAllAccounts = async (p) => {
    const state = providerStates[p]
    if (state.isForceRefreshingAll) return
    if (!confirm(t('msg.forceRefreshAllConfirm'))) return
    state.isForceRefreshingAll = true
    try {
      const endpoints = getApiEndpoints(p)
      const response = await axios.post(endpoints.forceRefresh, {}, { headers: getAuthHeaders() })
      await getTokens(p)
      showToast(t('msg.forceRefreshAllComplete', { n: response.data?.refreshedCount || 0 }))
    } catch (error) {
      console.error('forceRefreshAllAccounts error:', error)
      showToast(t('msg.forceRefreshAllFailed') + error.message, 'error')
    } finally {
      state.isForceRefreshingAll = false
    }
  }

  // ---- 导出 ----
  const exportAccounts = async (p) => {
    try {
      const endpoints = getApiEndpoints(p)
      let allAccounts = []
      if (endpoints.supportsPagination) {
        const res = await axios.get(endpoints.list, {
          params: { page: 1, pageSize: 10000 },
          headers: getAuthHeaders(),
        })
        allAccounts = res.data.data
      } else {
        const res = await axios.get(endpoints.list, { headers: getAuthHeaders() })
        allAccounts = res.data.data || []
      }

      if (allAccounts.length === 0) {
        showToast(t('msg.exportEmpty'), 'error')
        return
      }

      const content = allAccounts.map(token => `${token.email}:${token.password}`).join('\n')
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      const suffix = p === 'dpsk' ? 'dpsk' : 'qwen'
      link.download = `${suffix}_accounts.txt`
      document.body.appendChild(link)
      link.click()
      setTimeout(() => {
        document.body.removeChild(link)
        URL.revokeObjectURL(url)
      }, 100)
      showToast(t('msg.exportSuccess'))
    } catch (error) {
      console.error('exportAccounts error:', error)
      showToast(t('msg.exportFailed') + error.message, 'error')
    }
  }

  // ---- 剪贴板 ----
  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text)
      showToast(t('dash.copiedToClipboard'))
    } catch (err) {
      console.error('copyToClipboard error:', err)
      showToast(t('msg.copyFailed'), 'error')
    }
  }

  return {
    providerStates,
    showAddModal, addMode, modalProvider, newAccount,
    showEditProxyModal, editProxy, isSavingProxy, editProxyValid,
    showDeleteAllConfirm, deleteAllProvider,
    newAccountProxyValid,
    getTokens, getAllTokens,
    totalPages, changePage, changePageSize,
    isSelected, toggleSelect, toggleSelectAll,
    deleteToken, deleteSelected, deleteAllAccounts, confirmDeleteAll,
    openAddModal, closeAddModal, addToken,
    openEditProxy, closeEditProxyModal, clearProxy, saveProxy,
    refreshToken, refreshAllAccounts, forceRefreshAllAccounts,
    exportAccounts, copyToClipboard,
    setCloseAddModalHook,
  }
}
