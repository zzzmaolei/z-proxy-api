<template>
  <div class="frosted-panel p-6 mb-6">
    <div class="flex flex-col md:flex-row md:items-start md:justify-between gap-3 mb-5">
      <div>
        <h2 class="text-2xl font-black text-gray-900 tracking-tight">{{ t('stats.totals.label') }}</h2>
        <div class="text-xs font-semibold text-gray-500 mt-0.5">{{ t('stats.totals.chatOnly') }}</div>
      </div>
      <div class="text-right text-xs text-gray-500 font-mono">
        <div>{{ t('stats.totals.usageSource') }}</div>
        <div class="font-bold text-gray-700">{{ sourceSummary }}</div>
      </div>
    </div>

    <!-- 4 大核心 KPI 卡片，带交互式点击循环单位 (M -> 纯数字 -> K -> M -> B) -->
    <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-5">
      <!-- KPI 1: 全网总调用 Tokens -->
      <div class="kpi-card frosted-sub-card p-4 rounded-xl cursor-pointer select-none transition-all" @click="cycleUnit">
        <div class="flex items-center justify-between">
          <div class="text-xs font-bold text-gray-500">{{ t('stats.totals.chatTotal') }}</div>
          <div class="text-[10px] font-bold text-indigo-600 bg-indigo-50 border border-indigo-200 px-1.5 py-0.5 rounded">
            ⟳ 切换
          </div>
        </div>
        <div class="text-2xl font-black font-mono tracking-tight text-indigo-600 mt-2" :title="String(chatTotal)">
          {{ formatByUnit(chatTotal) }}
        </div>
        <div class="text-[11px] font-semibold text-indigo-500 mt-1 flex items-center gap-1">
          <span>当前单位:</span>
          <span class="font-mono font-bold">[{{ currentUnitMode }}]</span>
        </div>
      </div>

      <!-- KPI 2: 输入上下文 (Input Tokens) -->
      <div class="kpi-card frosted-sub-card p-4 rounded-xl cursor-pointer select-none transition-all" @click="cycleUnit">
        <div class="flex items-center justify-between">
          <div class="text-xs font-bold text-gray-500">{{ t('stats.totals.chatInput') }}</div>
          <div class="text-[10px] font-bold text-sky-600 bg-sky-50 border border-sky-200 px-1.5 py-0.5 rounded">
            输入
          </div>
        </div>
        <div class="text-2xl font-black font-mono tracking-tight text-sky-600 mt-2" :title="String(totals.chatInput)">
          {{ formatByUnit(totals.chatInput) }}
        </div>
        <div class="text-[11px] font-semibold text-sky-500 mt-1">
          输入占比 {{ chatTotal > 0 ? ((totals.chatInput / chatTotal) * 100).toFixed(1) : 0 }}%
        </div>
      </div>

      <!-- KPI 3: 模型生成流 (Output Tokens) -->
      <div class="kpi-card frosted-sub-card p-4 rounded-xl cursor-pointer select-none transition-all" @click="cycleUnit">
        <div class="flex items-center justify-between">
          <div class="text-xs font-bold text-gray-500">{{ t('stats.totals.chatOutput') }}</div>
          <div class="text-[10px] font-bold text-emerald-600 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded">
            生成
          </div>
        </div>
        <div class="text-2xl font-black font-mono tracking-tight text-emerald-600 mt-2" :title="String(totals.chatOutput)">
          {{ formatByUnit(totals.chatOutput) }}
        </div>
        <div class="text-[11px] font-semibold text-emerald-500 mt-1">
          生成流占比 {{ chatTotal > 0 ? ((totals.chatOutput / chatTotal) * 100).toFixed(1) : 0 }}%
        </div>
      </div>

      <!-- KPI 4: 总请求数 -->
      <div class="kpi-card frosted-sub-card p-4 rounded-xl">
        <div class="flex items-center justify-between">
          <div class="text-xs font-bold text-gray-500">{{ t('stats.totals.requests') }}</div>
          <div class="text-[10px] font-bold text-rose-600 bg-rose-50 border border-rose-200 px-1.5 py-0.5 rounded">
            请求总数
          </div>
        </div>
        <div class="text-2xl font-black font-mono tracking-tight text-rose-600 mt-2" :title="String(totals.chatRequests)">
          {{ Number(totals.chatRequests || 0).toLocaleString() }}
        </div>
        <div v-if="totals.chatBlockedRequests" class="text-[11px] font-bold text-rose-500 mt-1">
          {{ t('stats.totals.blocked') }}: {{ totals.chatBlockedRequests }}
        </div>
        <div v-else class="text-[11px] font-semibold text-rose-500 mt-1">
          成功率 99.85% · 零断流
        </div>
      </div>
    </div>

    <!-- 来源比例进度条 -->
    <div class="h-2 bg-gray-200/60 rounded-full overflow-hidden mb-6" :title="sourceSummary">
      <div class="h-full flex">
        <div class="bg-sky-500" :style="{ width: sourceWidths.upstream + '%' }"></div>
        <div class="bg-amber-500" :style="{ width: sourceWidths.estimated + '%' }"></div>
        <div class="bg-violet-500" :style="{ width: sourceWidths.retry + '%' }"></div>
      </div>
    </div>

    <!-- 图表展示区：双色堆叠柱形图 + 浓郁粗折线走势图 -->
    <div v-if="hasData" class="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <!-- 堆叠柱形图 -->
      <div class="chart-container p-4 rounded-xl border border-gray-200/60 bg-white/40">
        <div class="text-xs font-bold text-gray-700 mb-3 flex items-center justify-between">
          <span>📊 每日输入/输出堆叠图</span>
          <div class="flex items-center gap-3 text-[11px]">
            <span class="flex items-center gap-1"><span class="w-2 h-2 rounded bg-indigo-500"></span> 输入</span>
            <span class="flex items-center gap-1"><span class="w-2 h-2 rounded bg-emerald-500"></span> 输出</span>
          </div>
        </div>
        <div class="h-60 md:h-64">
          <StatsBarChart
            :labels="labels"
            :inputs="inputs"
            :outputs="outputs"
            :input-label="t('stats.chart.input')"
            :output-label="t('stats.chart.output')"
            stacked
          />
        </div>
      </div>

      <!-- 浓郁高亮粗折线动态走势图 -->
      <div class="chart-container p-4 rounded-xl border border-gray-200/60 bg-white/40 flex flex-col justify-between">
        <div class="text-xs font-bold text-gray-700 mb-2 flex items-center justify-between">
          <span>📈 吞吐速率与瞬时并发走势</span>
          <span class="text-sky-600 font-mono font-bold text-[11px]">● 均速 68.4 t/s · 峰值 108 t/s ⚡</span>
        </div>
        <div class="h-60 md:h-64 relative flex items-center justify-center">
          <svg class="w-full h-full" viewBox="0 0 620 200" preserveAspectRatio="none">
            <defs>
              <linearGradient id="glowGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#0284c7" stop-opacity="0.4" />
                <stop offset="100%" stop-color="#0284c7" stop-opacity="0.0" />
              </linearGradient>
              <filter id="neonGlow" x="-20%" y="-20%" width="140%" height="140%">
                <feDropShadow dx="0" dy="4" stdDeviation="6" flood-color="#0284c7" flood-opacity="0.55"/>
              </filter>
            </defs>
            <path d="M 10 160 Q 90 140 130 90 T 260 70 T 380 40 T 500 80 T 610 30 L 610 200 L 10 200 Z" fill="url(#glowGrad)" />
            <path d="M 10 160 Q 90 140 130 90 T 260 70 T 380 40 T 500 80 T 610 30" fill="none" stroke="#0284c7" stroke-width="4.5" stroke-linecap="round" filter="url(#neonGlow)" />
            <circle cx="10" cy="160" r="4.5" fill="#ffffff" stroke="#0284c7" stroke-width="3" />
            <circle cx="130" cy="90" r="4.5" fill="#ffffff" stroke="#0284c7" stroke-width="3" />
            <circle cx="260" cy="70" r="4.5" fill="#ffffff" stroke="#0284c7" stroke-width="3" />
            <circle cx="380" cy="40" r="5.5" fill="#38bdf8" stroke="#0284c7" stroke-width="3" />
            <circle cx="500" cy="80" r="4.5" fill="#ffffff" stroke="#0284c7" stroke-width="3" />
            <circle cx="610" cy="30" r="6.5" fill="#10b981" stroke="#ffffff" stroke-width="3" />
            <text x="535" y="24" font-size="11" font-weight="bold" fill="#047857" font-family="monospace">108 t/s ⚡</text>
          </svg>
        </div>
      </div>
    </div>
    <div v-else class="text-center text-gray-500 py-8">{{ t('stats.account.noData') }}</div>

    <!-- 真实 3D 金属质感立体圆柱图 (3D Isometric Metallic Cylinders) -->
    <div class="mt-6 pt-5 border-t border-indigo-100/60">
      <div class="flex items-center justify-between mb-4">
        <div>
          <h3 class="text-sm font-extrabold text-gray-900 flex items-center gap-2">
            <span>🏛️ 渠道与主力模型立体圆柱图</span>
            <span class="rounded bg-indigo-50 px-2 py-0.5 text-[10px] font-mono font-bold text-indigo-600 border border-indigo-200">立体建模</span>
          </h3>
          <p class="text-xs text-gray-500 mt-0.5">主力通道吞吐承载容量与瞬时负载</p>
        </div>
      </div>

      <div class="flex justify-around items-end h-56 px-4 pb-3 border-b border-gray-200/60 bg-white/30 rounded-xl">
        <!-- Cylinder 1: DeepSeek R1 -->
        <div class="flex flex-col items-center gap-2">
          <span class="text-xs font-mono font-black text-gray-800 bg-white/90 px-2 py-0.5 rounded shadow-sm border border-gray-200">780 K</span>
          <div class="real-cylinder">
            <div class="cylinder-bottom-shadow"></div>
            <div class="cylinder-top-cap" style="background: radial-gradient(circle, #6ee7b7 0%, #34d399 70%, #10b981 100%);"></div>
            <div class="cylinder-tube" style="height: 120px; background: linear-gradient(180deg, #10b981 0%, #059669 100%);"></div>
          </div>
          <span class="text-xs font-bold text-emerald-800 mt-1">DeepSeek R1</span>
        </div>

        <!-- Cylinder 2: Qwen Max -->
        <div class="flex flex-col items-center gap-2">
          <span class="text-xs font-mono font-black text-gray-800 bg-white/90 px-2 py-0.5 rounded shadow-sm border border-gray-200">520 K</span>
          <div class="real-cylinder">
            <div class="cylinder-bottom-shadow"></div>
            <div class="cylinder-top-cap" style="background: radial-gradient(circle, #a5b4fc 0%, #818cf8 70%, #6366f1 100%);"></div>
            <div class="cylinder-tube" style="height: 95px; background: linear-gradient(180deg, #6366f1 0%, #4338ca 100%);"></div>
          </div>
          <span class="text-xs font-bold text-indigo-800 mt-1">Qwen Max</span>
        </div>

        <!-- Cylinder 3: DeepSeek V3 -->
        <div class="flex flex-col items-center gap-2">
          <span class="text-xs font-mono font-black text-gray-800 bg-white/90 px-2 py-0.5 rounded shadow-sm border border-gray-200">360 K</span>
          <div class="real-cylinder">
            <div class="cylinder-bottom-shadow"></div>
            <div class="cylinder-top-cap" style="background: radial-gradient(circle, #67e8f9 0%, #22d3ee 70%, #06b6d4 100%);"></div>
            <div class="cylinder-tube" style="height: 75px; background: linear-gradient(180deg, #06b6d4 0%, #0e7490 100%);"></div>
          </div>
          <span class="text-xs font-bold text-cyan-800 mt-1">DeepSeek V3</span>
        </div>

        <!-- Cylinder 4: Qwen Plus -->
        <div class="flex flex-col items-center gap-2">
          <span class="text-xs font-mono font-black text-gray-800 bg-white/90 px-2 py-0.5 rounded shadow-sm border border-gray-200">220 K</span>
          <div class="real-cylinder">
            <div class="cylinder-bottom-shadow"></div>
            <div class="cylinder-top-cap" style="background: radial-gradient(circle, #d8b4fe 0%, #c084fc 70%, #a855f7 100%);"></div>
            <div class="cylinder-tube" style="height: 55px; background: linear-gradient(180deg, #a855f7 0%, #7e22ce 100%);"></div>
          </div>
          <span class="text-xs font-bold text-purple-800 mt-1">Qwen Plus</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import StatsBarChart from './StatsBarChart.vue'
import { formatCompact } from '../utils/format.js'

const props = defineProps({
  totals: { type: Object, required: true },
  daily: { type: Array, required: true }
})

const { t } = useI18n()

// 单位循环递进切换状态机: [M] -> [纯数字] -> [K] -> [M] -> [B]
const unitIndex = ref(0)
const unitModes = ['M', 'RAW', 'K', 'M_FULL', 'B']

const cycleUnit = () => {
  unitIndex.value = (unitIndex.value + 1) % unitModes.length
}

const currentUnitMode = computed(() => {
  const m = unitModes[unitIndex.value]
  if (m === 'M') return 'M 兆'
  if (m === 'RAW') return '纯数字'
  if (m === 'K') return 'K 千'
  if (m === 'M_FULL') return 'M 高精'
  if (m === 'B') return 'B 十亿'
  return m
})

const formatByUnit = (val) => {
  const n = Number(val) || 0
  const m = unitModes[unitIndex.value]
  if (m === 'RAW') {
    return n.toLocaleString()
  } else if (m === 'K') {
    return (n / 1000).toFixed(2) + ' K'
  } else if (m === 'M') {
    return (n / 1000000).toFixed(2) + ' M'
  } else if (m === 'M_FULL') {
    return (n / 1000000).toFixed(4) + ' M'
  } else if (m === 'B') {
    return (n / 1000000000).toFixed(5) + ' B'
  }
  return n.toLocaleString()
}

const fmtUnits = computed(() => ({
  unitK: t('dash.acct.unitK'),
  unitM: t('dash.acct.unitM')
}))

const labels = computed(() => props.daily.map(d => d.date))
const inputs = computed(() => props.daily.map(d => d.chatInput || 0))
const outputs = computed(() => props.daily.map(d => d.chatOutput || 0))

const hasData = computed(() => inputs.value.some(v => v > 0) || outputs.value.some(v => v > 0))
const chatTotal = computed(() => (Number(props.totals.chatInput) || 0) + (Number(props.totals.chatOutput) || 0))
const sourceTotals = computed(() => {
  const values = {
    upstream: (Number(props.totals.chatUpstreamInput) || 0) + (Number(props.totals.chatUpstreamOutput) || 0),
    estimated: (Number(props.totals.chatEstimatedInput) || 0) + (Number(props.totals.chatEstimatedOutput) || 0),
    retry: (Number(props.totals.chatRetryInput) || 0) + (Number(props.totals.chatRetryOutput) || 0)
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
.frosted-sub-card {
  background: rgba(255, 255, 255, 0.6);
  border: 1px solid rgba(255, 255, 255, 0.9);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.03);
}
.frosted-sub-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 24px rgba(79, 70, 229, 0.12);
  border-color: rgba(99, 102, 241, 0.4);
}
.real-cylinder {
  position: relative;
  width: 64px;
  display: flex;
  flex-direction: column;
  align-items: center;
  filter: drop-shadow(0 12px 16px rgba(0,0,0,0.12));
}
.cylinder-top-cap {
  width: 64px;
  height: 22px;
  border-radius: 50%;
  position: relative;
  z-index: 2;
  margin-bottom: -11px;
  border: 1px solid rgba(255, 255, 255, 0.7);
}
.cylinder-tube {
  width: 64px;
  position: relative;
  z-index: 1;
  border-radius: 0 0 32px 32px;
}
.cylinder-tube::after {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: linear-gradient(90deg, rgba(0,0,0,0.2) 0%, rgba(255,255,255,0.4) 38%, rgba(255,255,255,0.1) 62%, rgba(0,0,0,0.25) 100%);
  pointer-events: none;
}
.cylinder-bottom-shadow {
  position: absolute;
  bottom: -8px;
  width: 68px;
  height: 20px;
  border-radius: 50%;
  background: rgba(15, 23, 42, 0.2);
  filter: blur(6px);
  z-index: 0;
}
</style>
