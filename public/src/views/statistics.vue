<template>
  <div class="statistics-page dashboard-scroll w-screen min-h-screen overflow-y-auto">
    <div class="statistics-shell container mx-auto">
      <div class="stats-topbar flex flex-col md:flex-row justify-between items-start md:items-center mb-6 space-y-4 md:space-y-0">
        <div class="flex items-center gap-3">
          <router-link
            to="/"
            class="action-button font-bold border border-gray-200 bg-white/60 text-gray-800 px-3 py-2 rounded-xl shadow-sm hover:bg-white/90 transition-all duration-300"
          >
            ← {{ t('stats.backToDashboard') }}
          </router-link>
          <h1 class="text-3xl md:text-4xl font-bold">{{ t('stats.title') }}</h1>
        </div>
        <LangSwitcher />
      </div>

      <div class="stats-period mb-6 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div class="inline-flex flex-wrap gap-2 bg-white/50 backdrop-blur-sm border border-white/40 rounded-2xl p-2 shadow">
          <button
            v-for="opt in periodOptions"
            :key="opt.value"
            @click="period = opt.value"
            :class="[
              'px-4 py-2 rounded-xl text-sm font-medium transition-all duration-200',
              period === opt.value
                ? 'bg-indigo-100 text-indigo-800 border border-indigo-300'
                : 'bg-transparent text-gray-700 hover:bg-white/70 border border-transparent'
            ]"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>

      <div v-if="loading" class="text-center py-12 text-gray-500">
        <svg class="animate-spin h-6 w-6 mx-auto mb-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
          <path class="opacity-75" fill="currentColor" d="m4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
        </svg>
        {{ t('stats.loading') }}
      </div>

      <div v-else>
        <StatsTotals :totals="aggregateTotals" :daily="aggregateDaily" />

        <section class="insight-grid" :aria-label="t('stats.provider.title')">
          <article v-for="provider in providerSummaries" :key="provider.id" class="provider-card" :class="`provider-${provider.id}`">
            <div class="provider-card__head">
              <span class="provider-dot"></span>
              <span>{{ provider.label }}</span>
              <span class="provider-requests">{{ formatCompact(provider.requests, fmtUnits) }} {{ t('stats.totals.requests') }}</span>
            </div>
            <strong :title="String(provider.total)">{{ formatCompact(provider.total, fmtUnits) }}</strong>
            <span>{{ t('stats.provider.tokens') }}</span>
            <div class="provider-meter"><i :style="{ width: `${provider.share}%` }"></i></div>
          </article>
        </section>

        <section class="model-panel">
          <div class="model-panel__head">
            <div>
              <span class="section-kicker">provider × model</span>
              <h2>{{ t('stats.model.title') }}</h2>
              <p>{{ t('stats.model.hint') }}</p>
            </div>
            <span class="model-count">{{ modelSummaries.length }}</span>
          </div>
          <div v-if="modelSummaries.length" class="model-list">
            <article v-for="item in modelSummaries" :key="item.model" class="model-row">
              <div class="model-row__name"><span :class="`mini-dot ${item.provider}`"></span><code>{{ item.model }}</code></div>
              <div class="model-row__bar"><i :style="{ width: `${item.share}%` }"></i></div>
              <div class="model-row__values"><span>{{ formatCompact(item.input, fmtUnits) }} in</span><span>{{ formatCompact(item.output, fmtUnits) }} out</span><b>{{ formatCompact(item.total, fmtUnits) }}</b></div>
            </article>
          </div>
          <p v-else class="model-empty">{{ t('stats.model.empty') }}</p>
        </section>

        <StatsAccountRanking :accounts="accountSummaries" />

        <div class="text-lg font-semibold mb-3">{{ t('stats.account.label') }}</div>
        <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <StatsAccountCard
            v-for="acc in accountSummaries"
            :key="acc.email"
            :account="acc"
            :range="dateRange"
            :summary="acc"
            :max-sparkline="maxAccountDailyTotal"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import axios from 'axios'
import { getAuthHeaders } from '../utils/auth.js'
import LangSwitcher from '../components/LangSwitcher.vue'
import StatsTotals from '../components/StatsTotals.vue'
import StatsAccountCard from '../components/StatsAccountCard.vue'
import StatsAccountRanking from '../components/StatsAccountRanking.vue'
import { formatCompact } from '../utils/format.js'

const { t } = useI18n()
const fmtUnits = computed(() => ({ unitK: t('dash.acct.unitK'), unitM: t('dash.acct.unitM') }))

const loading = ref(true)
const accounts = ref([])
// Server-side date — anchor for every period range. Paired with the
// _getYesterdayKey helper used by the archival routine; do not switch this
// to new Date() in the browser — differing browser/container TZs would
// shift month boundaries.
const serverToday = ref(new Date().toISOString().slice(0, 10))

const period = ref('currentMonth')
const periodOptions = computed(() => [
  { value: 'last5h', label: '⚡ 近 5 小时 (实时分时)' },
  { value: 'last7d', label: '📅 近一周 (7 Days)' },
  { value: 'currentMonth', label: '🗓️ 近一个月 (30 Days)' },
  { value: 'prevMonth', label: t('stats.filter.prevMonth') },
  { value: 'last90', label: t('stats.filter.last90') }
])

// Parse YYYY-MM-DD as a local date.
function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}
function formatDateKey(date) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}
function daysInMonth(year, monthIndex0) {
  return new Date(year, monthIndex0 + 1, 0).getDate()
}

// dateRange — array of YYYY-MM-DD keys in chronological order, anchored to serverToday.
const dateRange = computed(() => {
  const today = parseDateKey(serverToday.value)
  const result = []
  if (period.value === 'last5h') {
    // 过去5小时分时，按当前日期聚合
    return [formatDateKey(today)]
  } else if (period.value === 'last7d') {
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(d.getDate() - i)
      result.push(formatDateKey(d))
    }
    return result
  } else if (period.value === 'last90') {
    for (let i = 89; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(d.getDate() - i)
      result.push(formatDateKey(d))
    }
  } else if (period.value === 'currentMonth') {
    const year = today.getFullYear()
    const m0 = today.getMonth()
    const last = daysInMonth(year, m0)
    for (let day = 1; day <= last; day++) {
      result.push(formatDateKey(new Date(year, m0, day)))
    }
  } else if (period.value === 'prevMonth') {
    const prev = new Date(today.getFullYear(), today.getMonth() - 1, 1)
    const year = prev.getFullYear()
    const m0 = prev.getMonth()
    const last = daysInMonth(year, m0)
    for (let day = 1; day <= last; day++) {
      result.push(formatDateKey(new Date(year, m0, day)))
    }
  }
  return result
})

const emptyTotals = () => ({
  chatInput: 0,
  chatOutput: 0,
  chatRequests: 0,
  chatBlockedRequests: 0,
  chatUpstreamInput: 0,
  chatUpstreamOutput: 0,
  chatEstimatedInput: 0,
  chatEstimatedOutput: 0,
  chatRetryInput: 0,
  chatRetryOutput: 0
})

const addDay = (acc, d) => ({
  chatInput: acc.chatInput + d.chatInput,
  chatOutput: acc.chatOutput + d.chatOutput,
  chatRequests: acc.chatRequests + d.chatRequests,
  chatBlockedRequests: acc.chatBlockedRequests + d.chatBlockedRequests,
  chatUpstreamInput: acc.chatUpstreamInput + d.chatUpstreamInput,
  chatUpstreamOutput: acc.chatUpstreamOutput + d.chatUpstreamOutput,
  chatEstimatedInput: acc.chatEstimatedInput + d.chatEstimatedInput,
  chatEstimatedOutput: acc.chatEstimatedOutput + d.chatEstimatedOutput,
  chatRetryInput: acc.chatRetryInput + d.chatRetryInput,
  chatRetryOutput: acc.chatRetryOutput + d.chatRetryOutput
})

const dayFromEntry = (date, entry = {}) => {
  const chat = entry.chat || {}
  return {
    date,
    chatInput: Number(chat.input) || 0,
    chatOutput: Number(chat.output) || 0,
    chatRequests: Number(chat.requests) || 0,
    chatBlockedRequests: Number(chat.blockedRequests) || 0,
    chatUpstreamInput: Number(chat.upstreamInput) || 0,
    chatUpstreamOutput: Number(chat.upstreamOutput) || 0,
    chatEstimatedInput: Number(chat.estimatedInput) || 0,
    chatEstimatedOutput: Number(chat.estimatedOutput) || 0,
    chatRetryInput: Number(chat.retryInput) || 0,
    chatRetryOutput: Number(chat.retryOutput) || 0
  }
}

const accountSummaries = computed(() => accounts.value.map(account => {
  const history = account.history || {}
  const days = dateRange.value.map(date => dayFromEntry(date, history[date]))
  const totals = days.reduce(addDay, emptyTotals())
  return {
    email: account.email,
    history,
    days,
    totals,
    dailyTotals: days.map(d => d.chatInput + d.chatOutput)
  }
}).sort((a, b) => {
  const at = a.totals.chatInput + a.totals.chatOutput
  const bt = b.totals.chatInput + b.totals.chatOutput
  return bt - at
}))

// Daily aggregate across all accounts — feeds the summary bar chart.
const aggregateDaily = computed(() => dateRange.value.map(date => {
  const day = accounts.value.reduce((acc, account) => {
    const entry = (account.history || {})[date]
    return addDay(acc, dayFromEntry(date, entry))
  }, emptyTotals())
  return { date, ...day }
}))

const aggregateTotals = computed(() => aggregateDaily.value.reduce(addDay, emptyTotals()))

const providerLabels = { qwen: 'Qwen', dpsk: 'DeepSeek' }
const providerSummaries = computed(() => {
  const totals = { qwen: { input: 0, output: 0, requests: 0 }, dpsk: { input: 0, output: 0, requests: 0 } }
  for (const account of accounts.value) {
    for (const date of dateRange.value) {
      const chat = account.history?.[date]?.chat || {}
      const breakdown = chat.byProvider && Object.keys(chat.byProvider).length ? chat.byProvider : null
      if (breakdown) {
        for (const [provider, value] of Object.entries(breakdown)) {
          const bucket = totals[provider === 'deepseek' ? 'dpsk' : provider] ||= { input: 0, output: 0, requests: 0 }
          bucket.input += Number(value?.input) || 0; bucket.output += Number(value?.output) || 0; bucket.requests += Number(value?.requests) || 0
        }
      } else {
        const bucket = totals[account.provider === 'dpsk' ? 'dpsk' : 'qwen']
        bucket.input += Number(chat.input) || 0; bucket.output += Number(chat.output) || 0; bucket.requests += Number(chat.requests) || 0
      }
    }
  }
  const grandTotal = Math.max(1, Object.values(totals).reduce((sum, item) => sum + item.input + item.output, 0))
  return Object.entries(totals).map(([id, item]) => ({ id, label: providerLabels[id] || id, ...item, total: item.input + item.output, share: (item.input + item.output) / grandTotal * 100 }))
})

const modelSummaries = computed(() => {
  const models = {}
  for (const account of accounts.value) {
    for (const date of dateRange.value) {
      const byModel = account.history?.[date]?.chat?.byModel || {}
      for (const [model, value] of Object.entries(byModel)) {
        const bucket = models[model] ||= { model, provider: value?.provider === 'deepseek' ? 'dpsk' : (value?.provider || account.provider || 'qwen'), input: 0, output: 0, requests: 0 }
        bucket.input += Number(value?.input) || 0; bucket.output += Number(value?.output) || 0; bucket.requests += Number(value?.requests) || 0
      }
    }
  }
  const ranked = Object.values(models).map(item => ({ ...item, total: item.input + item.output })).sort((a, b) => b.total - a.total).slice(0, 16)
  const max = Math.max(1, ...ranked.map(item => item.total))
  return ranked.map(item => ({ ...item, share: Math.max(2, item.total / max * 100) }))
})

const maxAccountDailyTotal = computed(() => Math.max(0, ...accountSummaries.value.flatMap(acc => acc.dailyTotals)))

// Strictly validate `today` before using it to build dateRange — without this,
// a malformed '2026-13-99' would slip through new Date(y, m-1, d) (JS would
// roll the date over) and the UI would render the wrong window.
const DATE_KEY_REGEX = /^\d{4}-\d{2}-\d{2}$/

onMounted(async () => {
  try {
    const response = await axios.get('/api/statsHistory', {
      headers: getAuthHeaders()
    })
    const apiToday = response.data?.today
    if (typeof apiToday === 'string' && DATE_KEY_REGEX.test(apiToday)) {
      serverToday.value = apiToday
    }
    accounts.value = response.data?.accounts || []
  } catch (error) {
    console.error('Failed to load statsHistory', error)
    alert(t('stats.loadFailed') + (error?.message || ''))
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.statistics-page { position: relative; z-index: 1; color: #17243b; }.statistics-shell { max-width: 1440px; padding: 1.75rem clamp(1rem, 3vw, 3rem) 3rem; }.stats-topbar { padding: .3rem 0 1rem; }.stats-period { padding-bottom: .4rem; }.insight-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; margin: 1rem 0; }.provider-card, .model-panel { border: 1px solid rgba(255,255,255,.85); background: rgba(255,255,255,.48); box-shadow: 0 16px 36px rgba(31,38,135,.07), inset 0 1px 1px rgba(255,255,255,.95); backdrop-filter: blur(28px) saturate(190%); -webkit-backdrop-filter: blur(28px) saturate(190%); border-radius: 20px; transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); }.provider-card { position: relative; overflow: hidden; border-radius: 1.25rem; padding: 1.1rem; }.provider-card::after { position: absolute; content: ''; width: 9rem; height: 9rem; border-radius: 50%; right: -3.8rem; top: -5.5rem; opacity: .35; filter: blur(8px); }.provider-qwen::after { background: #9aa7ff; }.provider-dpsk::after { background: #78dac9; }.provider-card__head { display: flex; align-items: center; gap: .45rem; color: #51617d; font-size: .82rem; font-weight: 700; }.provider-dot { width: .6rem; height: .6rem; border-radius: 50%; background: #7684ef; box-shadow: 0 0 0 4px rgba(118,132,239,.14); }.provider-dpsk .provider-dot, .mini-dot.dpsk { background: #20aa91; box-shadow: 0 0 0 4px rgba(32,170,145,.13); }.provider-requests { margin-left: auto; color: #8290a9; font-size: .7rem; font-weight: 600; }.provider-card strong { display: block; margin-top: .7rem; font-size: 2rem; letter-spacing: -.06em; }.provider-card > span { color: #7b89a2; font-size: .75rem; }.provider-meter, .model-row__bar { overflow: hidden; height: .35rem; margin-top: .85rem; border-radius: 99px; background: rgba(105,119,164,.12); }.provider-meter i, .model-row__bar i { display: block; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #6c78e7, #99a9ff); }.provider-dpsk .provider-meter i { background: linear-gradient(90deg, #16a28b, #71d4bd); }.model-panel { margin: 1rem 0 1.5rem; border-radius: 1.4rem; padding: clamp(1rem, 2.5vw, 1.6rem); }.model-panel__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: .9rem; }.section-kicker { color: #7483a4; font-size: .67rem; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }.model-panel h2 { margin: .15rem 0; font-size: 1.2rem; letter-spacing: -.03em; }.model-panel p { margin: 0; color: #71809a; font-size: .83rem; }.model-count { display: grid; min-width: 2.1rem; height: 2.1rem; place-items: center; border-radius: .7rem; background: rgba(111,123,222,.12); color: #5866ce; font-size: .85rem; font-weight: 800; }.model-list { display: grid; gap: .6rem; }.model-row { display: grid; grid-template-columns: minmax(10rem, 1.1fr) 2fr minmax(12rem, 1fr); gap: .75rem; align-items: center; border-radius: .8rem; padding: .55rem .7rem; background: rgba(255,255,255,.42); }.model-row__name { display: flex; align-items: center; gap: .5rem; overflow: hidden; }.model-row code { overflow: hidden; color: #33435f; font-size: .8rem; text-overflow: ellipsis; white-space: nowrap; }.mini-dot { flex: 0 0 auto; width: .42rem; height: .42rem; border-radius: 50%; background: #7483e8; box-shadow: 0 0 0 3px rgba(116,131,232,.13); }.model-row__values { display: flex; justify-content: flex-end; gap: .55rem; color: #71809a; font-size: .72rem; font-variant-numeric: tabular-nums; white-space: nowrap; }.model-row__values b { color: #314260; }.model-empty { padding: 1rem 0; text-align: center; }.model-row__bar i { background: linear-gradient(90deg, #7b75db, #76cfe1); }@media (max-width: 720px) { .insight-grid { grid-template-columns: 1fr; }.model-row { grid-template-columns: 1fr; gap: .4rem; }.model-row__values { justify-content: flex-start; }.statistics-shell { padding-top: 1rem; } }
</style>
