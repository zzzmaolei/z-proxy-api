<template>
  <div class="bg-white/40 backdrop-blur-md border border-white/30 rounded-2xl shadow-md p-4">
    <div class="flex flex-col md:flex-row md:items-center md:justify-between gap-2 mb-3">
      <div class="font-semibold text-gray-800 break-all">{{ account.email }}</div>
      <div class="flex flex-wrap gap-2 text-xs">
        <span class="px-2 py-1 rounded-lg bg-sky-50 border border-sky-100 text-sky-700" :title="String(chatTotal)">
          {{ t('stats.totals.chatTotal') }}: {{ formatCompact(chatTotal, fmtUnits) }}
        </span>
        <span class="px-2 py-1 rounded-lg bg-indigo-50 border border-indigo-100 text-indigo-700" :title="String(totals.chatInput)">
          {{ t('stats.totals.chatInput') }}: {{ formatCompact(totals.chatInput, fmtUnits) }}
        </span>
        <span class="px-2 py-1 rounded-lg bg-emerald-50 border border-emerald-100 text-emerald-700" :title="String(totals.chatOutput)">
          {{ t('stats.totals.chatOutput') }}: {{ formatCompact(totals.chatOutput, fmtUnits) }}
        </span>
        <span class="px-2 py-1 rounded-lg bg-rose-50 border border-rose-100 text-rose-700" :title="String(totals.chatRequests)">
          {{ t('stats.totals.requests') }}: {{ formatCompact(totals.chatRequests, fmtUnits) }}
        </span>
      </div>
    </div>

    <div v-if="hasData" class="space-y-3">
      <div>
        <div class="flex justify-between text-xs text-gray-600 mb-1">
          <span>{{ t('stats.account.ioRatio') }}</span>
          <span>{{ ioRatioLabel }}</span>
        </div>
        <div class="h-2 bg-gray-100 rounded-full overflow-hidden">
          <div class="h-full flex">
            <div class="bg-indigo-500" :style="{ width: ioWidths.input + '%' }"></div>
            <div class="bg-emerald-500" :style="{ width: ioWidths.output + '%' }"></div>
          </div>
        </div>
      </div>

      <div>
        <div class="flex justify-between text-xs text-gray-600 mb-1">
          <span>{{ t('stats.totals.usageSource') }}</span>
          <span>{{ sourceSummary }}</span>
        </div>
        <div class="h-2 bg-gray-100 rounded-full overflow-hidden">
          <div class="h-full flex">
            <div class="bg-sky-500" :style="{ width: sourceWidths.upstream + '%' }"></div>
            <div class="bg-amber-500" :style="{ width: sourceWidths.estimated + '%' }"></div>
            <div class="bg-violet-500" :style="{ width: sourceWidths.retry + '%' }"></div>
          </div>
        </div>
      </div>

      <div class="bg-white/60 rounded-lg p-2">
        <div class="flex justify-between text-xs text-gray-600 mb-1">
          <span>{{ t('stats.account.trend') }}</span>
          <span>{{ t('stats.account.sharedScale') }}</span>
        </div>
        <SvgSparkline :values="dailyTotals" :max-value="maxSparkline" color="#0284c7" />
      </div>
    </div>
    <div v-else class="text-center text-gray-400 text-sm py-3">{{ t('stats.account.noData') }}</div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import SvgSparkline from './SvgSparkline.vue'
import { formatCompact } from '../utils/format.js'

const props = defineProps({
  account: { type: Object, required: true }, // { email, history }
  range: { type: Array, required: true },     // ['YYYY-MM-DD', ...] in chronological order
  summary: { type: Object, default: null },
  maxSparkline: { type: Number, default: 0 }
})

const { t } = useI18n()

const fmtUnits = computed(() => ({
  unitK: t('dash.acct.unitK'),
  unitM: t('dash.acct.unitM')
}))

const days = computed(() => {
  if (props.summary?.days) return props.summary.days
  const history = props.account.history || {}
  return props.range.map(date => {
    const entry = history[date] || { chat: {} }
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
  })
})

const totals = computed(() => days.value.reduce((acc, d) => ({
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
}), {
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
}))

const dailyTotals = computed(() => days.value.map(d => d.chatInput + d.chatOutput))
const chatTotal = computed(() => totals.value.chatInput + totals.value.chatOutput)
const ioWidths = computed(() => {
  const total = Math.max(1, chatTotal.value)
  return {
    input: totals.value.chatInput / total * 100,
    output: totals.value.chatOutput / total * 100
  }
})
const ioRatioLabel = computed(() => `${Math.round(ioWidths.value.input)}% / ${Math.round(ioWidths.value.output)}%`)

const sourceTotals = computed(() => {
  const values = {
    upstream: totals.value.chatUpstreamInput + totals.value.chatUpstreamOutput,
    estimated: totals.value.chatEstimatedInput + totals.value.chatEstimatedOutput,
    retry: totals.value.chatRetryInput + totals.value.chatRetryOutput
  }
  if (values.upstream + values.estimated + values.retry === 0 && chatTotal.value > 0) {
    values.estimated = chatTotal.value
  }
  return values
})
const sourceWidths = computed(() => {
  const total = Math.max(1, sourceTotals.value.upstream + sourceTotals.value.estimated + sourceTotals.value.retry)
  return {
    upstream: sourceTotals.value.upstream / total * 100,
    estimated: sourceTotals.value.estimated / total * 100,
    retry: sourceTotals.value.retry / total * 100
  }
})
const sourceSummary = computed(() => [
  `${t('stats.source.upstream')} ${formatCompact(sourceTotals.value.upstream, fmtUnits.value)}`,
  `${t('stats.source.estimated')} ${formatCompact(sourceTotals.value.estimated, fmtUnits.value)}`,
  `${t('stats.source.retry')} ${formatCompact(sourceTotals.value.retry, fmtUnits.value)}`
].join(' / '))

const hasData = computed(() => dailyTotals.value.some(v => v > 0) || totals.value.chatRequests > 0)
</script>
