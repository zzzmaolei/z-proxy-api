/**
 * useAccountStats — Per-account 统计 + cooldown 倒计时
 *
 * 暴露 init()/destroy() 由 dashboard.vue 在 onMounted/onBeforeUnmount 调用，
 * 避免 composable 内部直接依赖 lifecycle 钩子。
 *
 * 所有 getter 使用 (provider, email) 签名，内部用 `provider:email` 复合 key。
 * fetchAccountStats 同时调用 /api/accountStats（Qwen）和 /api/dpsk/stats（DeepSeek），
 * 合并到同一个 map 中。
 */
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import axios from 'axios'
import { getAuthHeaders } from '../utils/auth.js'

const DEFAULT_STATS = Object.freeze({
  chat: { input: 0, output: 0 }
})

const STATUS_EMOJI = Object.freeze({
  active: '🟢',
  warn: '🟡',
  cooldown: '🔴',
  token_expiring: '🪫'
})

function compoundKey(provider, email) {
  return `${provider}:${email}`
}

export function useAccountStats() {
  const { t } = useI18n()

  const accountStats = ref({})
  const statsInterval = ref(null)
  const nowTick = ref(Date.now())
  let tickInterval = null
  // Map<compoundKey, cooldownEndsAt> — per-account refetch suppression.
  const cooldownRefetched = new Map()

  const getAccountStats = (provider, email) => {
    return accountStats.value[compoundKey(provider, email)]?.stats || DEFAULT_STATS
  }

  const getStatusKind = (provider, email) =>
    accountStats.value[compoundKey(provider, email)]?.status?.kind || 'active'
  const getStatusEmoji = (provider, email) =>
    STATUS_EMOJI[getStatusKind(provider, email)] || STATUS_EMOJI.active
  const isOnCooldown = (provider, email) => {
    const s = accountStats.value[compoundKey(provider, email)]?.status
    return s?.kind === 'cooldown' && typeof s?.cooldownEndsAt === 'number'
  }

  const formatAgo = (ms) => {
    const sec = Math.max(0, Math.floor(ms / 1000))
    if (sec < 60) return `${sec} ${t('dash.acct.status.unitSec')}`
    return `${Math.floor(sec / 60)} ${t('dash.acct.status.unitMin')}`
  }

  const formatCountdown = (ms) => {
    const sec = Math.max(0, Math.floor(ms / 1000))
    const mm = String(Math.floor(sec / 60)).padStart(2, '0')
    const ss = String(sec % 60).padStart(2, '0')
    return `${mm}:${ss}`
  }

  const getCountdown = (provider, email) => {
    const s = accountStats.value[compoundKey(provider, email)]?.status
    if (s?.kind !== 'cooldown' || typeof s?.cooldownEndsAt !== 'number') return ''
    return formatCountdown(s.cooldownEndsAt - nowTick.value)
  }

  const getStatusTooltip = (provider, email) => {
    const s = accountStats.value[compoundKey(provider, email)]?.status
    const kind = s?.kind || 'active'
    if (kind === 'cooldown' && typeof s?.cooldownEndsAt === 'number') {
      return t('dash.acct.status.cooldown', { until: formatCountdown(s.cooldownEndsAt - nowTick.value) })
    }
    if (kind === 'warn') {
      const ago = typeof s?.lastErrorAt === 'number' ? formatAgo(nowTick.value - s.lastErrorAt) : ''
      if (s?.lastErrorCode !== null && s?.lastErrorCode !== undefined && s?.lastErrorCode !== '') {
        return t('dash.acct.status.warn', { code: s.lastErrorCode, ago })
      }
      return t('dash.acct.status.warnNoCode', { ago })
    }
    if (kind === 'token_expiring') {
      return t('dash.acct.status.tokenExpiring')
    }
    return t('dash.acct.status.active')
  }

  const fetchAccountStats = async () => {
    try {
      const map = {}

      // Qwen 路线 per-account stats
      try {
        const qwenRes = await axios.get('/api/accountStats', {
          headers: getAuthHeaders()
        })
        for (const entry of qwenRes.data?.accounts || []) {
          if (entry?.email) map[compoundKey('qwen', entry.email)] = entry
        }
      } catch (e) {
        console.error('fetchAccountStats qwen error:', e)
      }

      // DeepSeek 路线 per-account stats
      try {
        const dpskRes = await axios.get('/api/dpsk/stats', {
          headers: getAuthHeaders()
        })
        for (const entry of dpskRes.data?.accounts || []) {
          if (entry?.email) map[compoundKey('dpsk', entry.email)] = entry
        }
      } catch (e) {
        console.error('fetchAccountStats dpsk error:', e)
      }

      accountStats.value = map
      // Drop suppression entries where account is no longer in cooldown OR
      // cooldownEndsAt changed (new cooldown cycle → must allow refetch again).
      for (const [key, cachedEndsAt] of cooldownRefetched) {
        const s = accountStats.value[key]?.status
        if (s?.kind !== 'cooldown' || s?.cooldownEndsAt !== cachedEndsAt) {
          cooldownRefetched.delete(key)
        }
      }
    } catch (error) {
      console.error('fetchAccountStats error:', error)
    }
  }

  // Auto-refetch when any account's cooldown expires (per-account suppression via Map).
  watch([nowTick, accountStats], () => {
    const stats = accountStats.value
    let shouldRefetch = false
    for (const key of Object.keys(stats)) {
      const s = stats[key]?.status
      if (s?.kind !== 'cooldown' || typeof s?.cooldownEndsAt !== 'number') continue
      if (nowTick.value >= s.cooldownEndsAt && cooldownRefetched.get(key) !== s.cooldownEndsAt) {
        cooldownRefetched.set(key, s.cooldownEndsAt)
        shouldRefetch = true
      }
    }
    if (shouldRefetch) fetchAccountStats()
  })

  const init = () => {
    fetchAccountStats()
    statsInterval.value = setInterval(fetchAccountStats, 30000)
    // 1s tick drives countdown rerender and cooldown-expiry watcher.
    tickInterval = setInterval(() => { nowTick.value = Date.now() }, 1000)
  }

  const destroy = () => {
    if (statsInterval.value) {
      clearInterval(statsInterval.value)
      statsInterval.value = null
    }
    if (tickInterval) {
      clearInterval(tickInterval)
      tickInterval = null
    }
  }

  return {
    accountStats,
    DEFAULT_STATS,
    getAccountStats,
    getStatusKind,
    getStatusEmoji,
    isOnCooldown,
    getCountdown,
    getStatusTooltip,
    fetchAccountStats,
    init,
    destroy,
  }
}
