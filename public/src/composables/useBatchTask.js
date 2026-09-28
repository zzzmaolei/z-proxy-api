/**
 * useBatchTask — 批量任务轮询
 *
 * 依赖：axios, getAuthHeaders, useToast, useI18n
 * 需要外部传入 getTokens（来自 useAccounts）用于任务完成后刷新账号列表。
 * 通过 setCloseAddModalHook 注入到 useAccounts 的 closeAddModal，
 * 当用户关闭模态框且批量任务已完成时清理状态。
 */
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import axios from 'axios'
import { getAuthHeaders } from '../utils/auth.js'
import { useToast } from './useToast.js'

export function useBatchTask({ getTokens, setCloseAddModalHook }) {
  const { t } = useI18n()
  const { showToast } = useToast()

  const batchAccounts = ref('')
  const isBatchAdding = ref(false)
  const batchTask = ref(null)
  const batchTaskPollTimer = ref(null)
  const batchTaskNotified = ref(false)

  const batchTaskStatusText = computed(() => {
    const status = batchTask.value?.status
    if (status === 'completed') return t('dash.statusCompleted')
    if (status === 'failed') return t('dash.statusFailed')
    if (status === 'running') return t('dash.statusRunning')
    if (status === 'pending') return t('dash.statusPending')
    return t('dash.statusNotStarted')
  })
  const batchTaskStatusClass = computed(() => {
    const status = batchTask.value?.status
    if (status === 'completed') return 'bg-emerald-100 text-emerald-700'
    if (status === 'failed') return 'bg-rose-100 text-rose-700'
    if (status === 'running') return 'bg-sky-100 text-sky-700'
    if (status === 'pending') return 'bg-amber-100 text-amber-700'
    return 'bg-slate-100 text-slate-700'
  })
  const batchTaskProgressStyle = computed(() => ({
    width: `${Math.max(0, Math.min(100, Number(batchTask.value?.progress || 0)))}%`,
  }))

  const clearBatchTaskPolling = () => {
    if (batchTaskPollTimer.value) {
      clearTimeout(batchTaskPollTimer.value)
      batchTaskPollTimer.value = null
    }
  }

  const resetBatchTaskState = (clearInput = false) => {
    clearBatchTaskPolling()
    batchTask.value = null
    batchTaskNotified.value = false
    isBatchAdding.value = false
    if (clearInput) {
      batchAccounts.value = ''
    }
  }

  const buildBatchTaskMessage = (task) => {
    let message = t('msg.batchComplete', { n: task.success })
    if (task.failed > 0) message += ', ' + t('msg.batchFailed', { n: task.failed })
    if (task.skipped > 0) message += ', ' + t('msg.batchSkipped', { n: task.skipped })
    if (task.invalid > 0) message += ', ' + t('msg.batchInvalid', { n: task.invalid })
    if (task.failedEmails?.length > 0) {
      message += '\n' + t('msg.failedAccounts') + ' ' + task.failedEmails.slice(0, 10).join(', ')
    }
    return message
  }

  const finalizeBatchTask = async (task) => {
    clearBatchTaskPolling()
    batchTask.value = task
    isBatchAdding.value = false

    if (task.success > 0) {
      await getTokens('qwen')
    }

    if (!batchTaskNotified.value) {
      batchTaskNotified.value = true
      showToast(
        buildBatchTaskMessage(task),
        task.failed > 0 || task.invalid > 0 ? 'warning' : 'success'
      )
    }
  }

  const pollBatchTask = async (taskId) => {
    clearBatchTaskPolling()

    try {
      const res = await axios.get(`/api/batchTasks/${taskId}`, { headers: getAuthHeaders() })
      batchTask.value = res.data

      if (res.data.status === 'completed' || res.data.status === 'failed') {
        await finalizeBatchTask(res.data)
        return
      }

      batchTaskPollTimer.value = setTimeout(() => {
        pollBatchTask(taskId)
      }, 800)
    } catch (error) {
      console.error('pollBatchTask error:', error)

      if (batchTask.value) {
        batchTask.value = {
          ...batchTask.value,
          message: t('msg.progressRetry'),
        }
      }

      batchTaskPollTimer.value = setTimeout(() => {
        pollBatchTask(taskId)
      }, 1500)
    }
  }

  const addBatchTokens = async (showAddModal, addMode) => {
    if (isBatchAdding.value) return
    if (!batchAccounts.value.trim()) {
      showToast(t('msg.enterAccounts'), 'error')
      return
    }

    batchTaskNotified.value = false
    clearBatchTaskPolling()
    isBatchAdding.value = true

    try {
      const res = await axios.post('/api/setAccounts', {
        accounts: batchAccounts.value,
        async: true,
      }, { headers: getAuthHeaders() })

      batchTask.value = res.data
      addMode.value = 'batch'
      showAddModal.value = true

      if (res.data.status === 'completed' || res.data.status === 'failed') {
        await finalizeBatchTask(res.data)
        return
      }

      pollBatchTask(res.data.taskId)
    } catch (error) {
      console.error('addBatchTokens error:', error)
      showToast(t('msg.batchAddFailed') + error.message, 'error')
      isBatchAdding.value = false
    }
  }

  // 注入到 useAccounts.closeAddModal：当用户关闭模态框且批量任务已完成时，
  // 清理 batch 状态（失败/无效为 0 时同时清空输入）。
  if (typeof setCloseAddModalHook === 'function') {
    setCloseAddModalHook(() => {
      if (!isBatchAdding.value && batchTask.value?.status === 'completed') {
        resetBatchTaskState(batchTask.value.failed === 0 && batchTask.value.invalid === 0)
      }
    })
  }

  return {
    batchAccounts,
    isBatchAdding,
    batchTask,
    batchTaskStatusText,
    batchTaskStatusClass,
    batchTaskProgressStyle,
    clearBatchTaskPolling,
    resetBatchTaskState,
    addBatchTokens,
  }
}
