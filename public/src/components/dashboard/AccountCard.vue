<template>
  <div class="token-card group relative overflow-hidden rounded-2xl transition-all duration-300 hover:shadow-2xl pt-4"
       :class="[
         { 'ring-2 ring-indigo-500 ring-opacity-75': isSelected },
         { 'opacity-60 grayscale': isOnCooldown }
       ]">
    <div class="absolute top-3 left-3 z-10">
      <label class="custom-checkbox cursor-pointer">
        <input type="checkbox"
               :checked="isSelected"
               @change="$emit('toggle-select', token.email)"
               class="sr-only peer">
        <div class="checkbox-icon w-6 h-6 bg-white/70 backdrop-blur-sm border-2 border-gray-300 rounded-lg peer-checked:bg-indigo-500 peer-checked:border-indigo-500 transition-all duration-300 flex items-center justify-center shadow-sm hover:shadow">
          <svg v-show="isSelected" class="w-4 h-4 text-white transform scale-0 peer-checked:scale-100 transition-transform duration-300" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
        </div>
      </label>
    </div>
    <div v-if="providerSupportsStats" class="absolute top-3 right-3 z-10 flex items-center gap-1 text-lg leading-none select-none"
         :title="statusTooltip">
      <span>{{ statusEmoji }}</span>
      <span v-if="isOnCooldown"
            class="text-sm font-mono text-gray-700">{{ countdown }}</span>
    </div>
    <div class="absolute inset-0 bg-white/30 backdrop-blur-md border border-white/30"></div>
    <div class="relative p-6 flex flex-col gap-4">
      <div class="flex flex-col space-y-3">
        <div class="relative flex items-center bg-blue-50/80 rounded-lg px-2 py-1">
          <div class="overflow-x-auto scrollbar-hide flex-1 flex items-center space-x-2">
            <span class="text-gray-700 min-w-[96px] text-left font-semibold">📧 Email:</span>
            <span class="font-medium whitespace-nowrap text-left">{{ token.email }}</span>
          </div>
          <button @click="$emit('copy', token.email)" class="absolute right-2 opacity-0 hover:opacity-100 transition-opacity bg-blue-200 hover:bg-blue-300 rounded px-2 py-1 text-base">📋</button>
        </div>
        <div class="relative flex items-center bg-blue-50/80 rounded-lg px-2 py-1">
          <div class="overflow-x-auto scrollbar-hide flex-1 flex items-center space-x-2">
            <span class="text-gray-700 min-w-[96px] text-left font-semibold">🔑 Passwd:</span>
            <span class="font-medium whitespace-nowrap text-left">{{ token.password }}</span>
          </div>
          <button @click="$emit('copy', token.password)" class="absolute right-2 opacity-0 hover:opacity-100 transition-opacity bg-blue-200 hover:bg-blue-300 rounded px-2 py-1 text-base">📋</button>
        </div>
        <div class="relative flex items-center bg-blue-50/80 rounded-lg px-2 py-1">
          <div class="overflow-x-auto scrollbar-hide flex-1 flex items-center space-x-2">
            <span class="text-gray-700 min-w-[96px] text-left font-semibold">🔐 Token:</span>
            <span class="font-medium whitespace-nowrap text-left text-sm">{{ token.token }}</span>
          </div>
          <button @click="$emit('copy', token.token)" class="absolute right-2 opacity-0 hover:opacity-100 transition-opacity bg-blue-200 hover:bg-blue-300 rounded px-2 py-1 text-base">📋</button>
        </div>
        <div class="relative flex items-center bg-blue-50/80 rounded-lg px-2 py-1">
          <div class="overflow-x-auto scrollbar-hide flex-1 flex items-center space-x-2">
            <span class="text-gray-700 min-w-[96px] text-left font-semibold">⏰ Expire:</span>
            <span class="font-medium whitespace-nowrap text-left" v-if="token.expires">{{ new Date(token.expires * 1000).toLocaleString() }}</span>
            <span v-else class="font-medium whitespace-nowrap text-left text-gray-400">—</span>
          </div>
          <button v-if="token.expires" @click="$emit('copy', new Date(token.expires * 1000).toLocaleString())" class="absolute right-2 opacity-0 hover:opacity-100 transition-opacity bg-blue-200 hover:bg-blue-300 rounded px-2 py-1 text-base">📋</button>
        </div>
        <div class="relative flex items-center bg-blue-50/80 rounded-lg px-2 py-1">
          <div class="overflow-x-auto scrollbar-hide flex-1 flex items-center space-x-2">
            <span class="text-gray-700 min-w-[96px] text-left font-semibold">🌐 Proxy:</span>
            <span class="font-medium whitespace-nowrap text-left text-sm" :title="token.proxy || ''">{{ token.proxy || '—' }}</span>
          </div>
          <button v-if="token.proxy" @click="$emit('copy', token.proxy)" class="absolute right-2 opacity-0 hover:opacity-100 transition-opacity bg-blue-200 hover:bg-blue-300 rounded px-2 py-1 text-base">📋</button>
        </div>
      </div>

      <div v-if="providerSupportsStats" class="bg-white/40 backdrop-blur-sm border border-white/40 rounded-2xl px-4 py-3 text-sm space-y-1 transition-all">
        <div class="flex items-baseline justify-between gap-2">
          <span class="text-gray-600">{{ t('dash.acct.chatToday') }}:</span>
          <span class="font-medium text-gray-800 text-xs md:text-sm">
            <span :title="String(stats.chat.input)">{{ formatCompact(stats.chat.input) }}</span>
            in /
            <span :title="String(stats.chat.output)">{{ formatCompact(stats.chat.output) }}</span>
            out
          </span>
        </div>
      </div>

      <div class="pt-4 mt-auto border-t border-gray-200/50">
        <div class="flex flex-row gap-2">
          <button v-if="providerSupportsProxy" @click="$emit('edit-proxy', token)"
                  class="flex-1 py-2 px-2 rounded-lg transition-all duration-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 text-xs md:text-sm">
            {{ t('dash.editProxy') }}
          </button>
          <button @click="$emit('refresh', token.email)"
                  :disabled="isRefreshing"
                  :class="[
                    'flex-1 py-2 px-2 rounded-lg transition-all duration-300 flex items-center justify-center gap-1 text-xs md:text-sm',
                    isRefreshing
                      ? 'bg-green-400 text-white refreshing-button-green cursor-not-allowed'
                      : 'macaron-green-button text-green-600 hover:bg-green-100 border border-green-200'
                  ]">
            <span v-if="isRefreshing" class="flex items-center gap-1">
              <svg class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="m4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              <span>{{ t('dash.refreshing') }}</span>
            </span>
            <span v-else>{{ t('dash.refreshToken') }}</span>
          </button>
          <button @click="$emit('delete', token.email)"
                  class="flex-1 py-2 px-2 rounded-lg border border-red-200 text-red-600 group-hover:bg-red-50 transition-all duration-300 hover:bg-red-100 text-xs md:text-sm">
            {{ t('dash.deleteAccount') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'
import { formatCompact as _formatCompact } from '../../utils/format.js'

const props = defineProps({
  token: { type: Object, required: true },
  isSelected: { type: Boolean, default: false },
  isOnCooldown: { type: Boolean, default: false },
  statusEmoji: { type: String, default: '' },
  statusTooltip: { type: String, default: '' },
  statusKind: { type: String, default: 'active' },
  countdown: { type: String, default: '' },
  stats: { type: Object, required: true },
  providerSupportsStats: { type: Boolean, default: false },
  providerSupportsProxy: { type: Boolean, default: false },
  isRefreshing: { type: Boolean, default: false },
})

defineEmits([
  'toggle-select', 'copy', 'refresh', 'delete', 'edit-proxy'
])

const { t } = useI18n()
const formatCompact = (n) => _formatCompact(n, { unitK: t('dash.acct.unitK'), unitM: t('dash.acct.unitM') })
</script>
