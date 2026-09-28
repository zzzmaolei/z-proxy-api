<template>
  <div class="frosted-panel p-5 mb-6">
    <div class="flex flex-col md:flex-row md:items-end md:justify-between gap-2 mb-4">
      <div>
        <h2 class="text-xl font-black text-gray-900 flex items-center gap-2">
          <span>🏆 {{ t('stats.ranking.title') }}</span>
          <span class="rounded bg-indigo-50 px-2 py-0.5 text-[10px] font-mono font-bold text-indigo-600 border border-indigo-200">消耗排行</span>
        </h2>
        <div class="text-xs font-semibold text-gray-500 mt-0.5">{{ t('stats.ranking.subtitle') }}</div>
      </div>
      <div class="text-xs font-mono font-bold text-gray-500">
        <span class="text-indigo-600">■ 输入</span> / <span class="text-emerald-600">■ 输出</span>
      </div>
    </div>

    <div v-if="ranked.length" class="space-y-2.5">
      <div v-for="item in ranked" :key="item.email" class="grid grid-cols-1 md:grid-cols-[minmax(180px,280px)_1fr_auto] gap-3 md:items-center p-2 rounded-xl bg-white/40 border border-white/60 shadow-sm">
        <div class="text-xs font-bold font-mono text-gray-800 break-all truncate">{{ item.email }}</div>
        <div class="h-4 bg-gray-200/60 rounded-full overflow-hidden border border-gray-300/40">
          <div class="h-full flex" :style="{ width: barWidth(item.total) + '%' }">
            <div class="bg-indigo-500 shadow-sm" :style="{ width: segmentWidth(item.input, item.total) + '%' }"></div>
            <div class="bg-emerald-500 shadow-sm" :style="{ width: segmentWidth(item.output, item.total) + '%' }"></div>
          </div>
        </div>
        <div class="text-xs font-mono font-extrabold text-gray-800 md:text-right" :title="String(item.total)">
          {{ formatCompact(item.total, fmtUnits) }}
        </div>
      </div>
    </div>
    <div v-else class="text-center text-gray-500 py-6">{{ t('stats.account.noData') }}</div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { formatCompact } from '../utils/format.js'

const props = defineProps({
  accounts: { type: Array, required: true }
})

const { t } = useI18n()

const fmtUnits = computed(() => ({
  unitK: t('dash.acct.unitK'),
  unitM: t('dash.acct.unitM')
}))

const ranked = computed(() => props.accounts
  .map(item => ({
    email: item.email,
    input: Number(item.totals?.chatInput) || 0,
    output: Number(item.totals?.chatOutput) || 0,
    total: (Number(item.totals?.chatInput) || 0) + (Number(item.totals?.chatOutput) || 0)
  }))
  .filter(item => item.total > 0)
  .sort((a, b) => b.total - a.total)
  .slice(0, 12))

// Rank bars use one shared max so different accounts can be compared directly.
const maxTotal = computed(() => Math.max(1, ...ranked.value.map(item => item.total)))
const barWidth = total => Math.max(2, (Number(total) || 0) / maxTotal.value * 100)
const segmentWidth = (value, total) => total > 0 ? (Number(value) || 0) / total * 100 : 0
</script>

<style scoped>
.frosted-panel {
  background: rgba(255, 255, 255, 0.48);
  backdrop-filter: blur(28px) saturate(190%);
  -webkit-backdrop-filter: blur(28px) saturate(190%);
  border: 1px solid rgba(255, 255, 255, 0.85);
  border-radius: 20px;
  box-shadow: 0 16px 36px rgba(31, 38, 135, 0.07), inset 0 1px 1px rgba(255, 255, 255, 0.95);
}
</style>
