<template>
  <div v-if="show"
       class="fixed inset-0 z-50 overflow-y-auto bg-black/60 px-4 py-6 backdrop-blur-sm"
       @click.self="$emit('close')">
    <div :class="[
          'relative mx-auto flex max-h-[calc(100vh-3rem)] w-full flex-col overflow-hidden rounded-2xl bg-white/80 p-6 backdrop-blur-lg transform transition-all duration-300 scale-100 opacity-100',
          addMode === 'batch' ? 'max-w-3xl' : 'max-w-md'
        ]">
      <div class="mb-6 flex shrink-0 border-b border-gray-200">
        <button :class="['flex-1 py-2 font-bold transition-all rounded-t-xl duration-300', addMode==='single' ? 'text-gray-600 border-b-2 border-gray-500 bg-gray-50/60' : 'text-gray-500 bg-transparent', isBatchAdding ? 'opacity-50 cursor-not-allowed' : '']" @click="!isBatchAdding && $emit('switch-mode', 'single')">{{ t('dash.singleAdd') }}</button>
        <button v-if="providerSupportsBatch" :class="['flex-1 py-2 font-bold transition-all rounded-t-xl duration-300', addMode==='batch' ? 'text-gray-600 border-b-2 border-gray-500 bg-gray-50/60' : 'text-gray-500 bg-transparent', isBatchAdding ? 'opacity-50 cursor-not-allowed' : '']" @click="!isBatchAdding && $emit('switch-mode', 'batch')">{{ t('dash.batchAdd') }}</button>
      </div>
      <div class="modal-scroll min-h-0 flex-1 overflow-y-auto pr-2">
      <transition name="fade" mode="out-in">
        <div v-if="addMode==='single'" key="single" class="pr-1">
          <h2 class="text-xl font-bold mb-4">{{ t('dash.addTitle') }}</h2>
          <div class="space-y-4">
            <div>
              <label class="block text-sm font-medium text-gray-700">Email</label>
              <input v-model="newAccount.email" type="email"
                     class="mt-1 block w-full rounded-xl border-gray-300 bg-white/50 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all duration-300 h-12 text-base px-4">
            </div>
            <div>
              <label class="block text-sm font-medium text-gray-700">Password</label>
              <input v-model="newAccount.password" type="password"
                     class="mt-1 block w-full rounded-xl border-gray-300 bg-white/50 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all duration-300 h-12 text-base px-4">
            </div>
            <div v-if="providerSupportsProxy">
              <label class="block text-sm font-medium text-gray-700">{{ t('dash.proxyLabel') }}</label>
              <input v-model="newAccount.proxy" type="text" :placeholder="t('dash.proxyPlaceholder')"
                     :class="[
                       'mt-1 block w-full rounded-xl bg-white/50 shadow-sm transition-all duration-300 h-12 text-base px-4',
                       newAccountProxyValid
                         ? 'border-gray-300 focus:border-indigo-500 focus:ring-indigo-500'
                         : 'border-red-400 focus:border-red-500 focus:ring-red-500'
                     ]">
              <p v-if="!newAccountProxyValid" class="mt-1 text-sm text-red-600">{{ t('msg.proxyInvalid') }}</p>
            </div>
            <div class="flex justify-end space-x-4 pt-4">
              <button @click="$emit('close')"
                      class="px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 transition-all duration-300">
                {{ t('dash.cancel') }}
              </button>
              <button @click="$emit('add')"
                      :disabled="!newAccountProxyValid"
                      class="px-4 py-2 rounded-xl bg-black text-white hover:bg-white hover:text-black transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed">
                {{ t('dash.add') }}
              </button>
            </div>
          </div>
        </div>
        <div v-else key="batch" class="pr-1">
          <h2 class="text-xl font-bold mb-4 px-4">{{ t('dash.batchTitle') }}</h2>
          <div class="space-y-4">
            <div>
              <label class="block text-sm font-medium text-gray-700 px-4 pb-2">{{ t('dash.batchLabel') }}</label>
              <textarea v-model="batchAccounts"
                        :disabled="isBatchAdding"
                        rows="6"
                        class="mt-1 block w-full rounded-xl border-gray-300 bg-white/50 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all duration-300 h-36 text-base px-4 py-3 resize-none disabled:opacity-70"></textarea>
            </div>
            <div v-if="batchTask" class="mx-4 rounded-2xl border border-slate-200 bg-white/70 p-5 shadow-sm">
              <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <div class="text-sm text-slate-500">{{ t('dash.taskStatus') }}</div>
                  <div class="mt-1 flex items-center gap-3">
                    <span :class="['inline-flex rounded-full px-3 py-1 text-xs font-semibold', batchTaskStatusClass]">
                      {{ batchTaskStatusText }}
                    </span>
                    <span class="text-sm text-slate-600">{{ batchTask.message }}</span>
                  </div>
                </div>
                <div class="text-sm text-slate-500">
                  {{ t('dash.taskId') }} <span class="font-mono text-slate-700">{{ batchTask.taskId }}</span>
                </div>
              </div>

              <div class="mt-4">
                <div class="mb-2 flex items-center justify-between text-sm text-slate-600">
                  <span>{{ t('dash.progress') }}</span>
                  <span>{{ batchTask.completed }}/{{ batchTask.total }} · {{ batchTask.progress.toFixed(0) }}%</span>
                </div>
                <div class="h-3 overflow-hidden rounded-full bg-slate-200">
                  <div class="h-full rounded-full bg-gradient-to-r from-sky-500 via-cyan-500 to-emerald-500 transition-all duration-500" :style="batchTaskProgressStyle"></div>
                </div>
              </div>

              <div class="mt-4 grid grid-cols-2 gap-3 md:grid-cols-5">
                <div class="rounded-xl bg-slate-50 px-4 py-3">
                  <div class="text-xs text-slate-500">{{ t('dash.total') }}</div>
                  <div class="mt-1 text-lg font-semibold text-slate-800">{{ batchTask.total }}</div>
                </div>
                <div class="rounded-xl bg-emerald-50 px-4 py-3">
                  <div class="text-xs text-emerald-600">{{ t('dash.success') }}</div>
                  <div class="mt-1 text-lg font-semibold text-emerald-700">{{ batchTask.success }}</div>
                </div>
                <div class="rounded-xl bg-rose-50 px-4 py-3">
                  <div class="text-xs text-rose-600">{{ t('dash.failed') }}</div>
                  <div class="mt-1 text-lg font-semibold text-rose-700">{{ batchTask.failed }}</div>
                </div>
                <div class="rounded-xl bg-amber-50 px-4 py-3">
                  <div class="text-xs text-amber-600">{{ t('dash.skipped') }}</div>
                  <div class="mt-1 text-lg font-semibold text-amber-700">{{ batchTask.skipped }}</div>
                </div>
                <div class="rounded-xl bg-violet-50 px-4 py-3">
                  <div class="text-xs text-violet-600">{{ t('dash.invalid') }}</div>
                  <div class="mt-1 text-lg font-semibold text-violet-700">{{ batchTask.invalid }}</div>
                </div>
              </div>

              <div v-if="batchTask.activeEmails?.length" class="mt-4 rounded-xl bg-sky-50 px-4 py-3">
                <div class="text-sm font-medium text-sky-700">{{ t('dash.processing') }}</div>
                <div class="mt-2 flex flex-wrap gap-2">
                  <span v-for="email in batchTask.activeEmails" :key="email" class="rounded-full bg-white px-3 py-1 text-xs text-sky-700 shadow-sm">
                    {{ email }}
                  </span>
                </div>
              </div>

              <div v-if="batchTask.recentResults?.length" class="mt-4">
                <div class="mb-2 text-sm font-medium text-slate-700">{{ t('dash.recentResults') }}</div>
                <div class="max-h-52 space-y-2 overflow-y-auto pr-1">
                  <div v-for="item in batchTask.recentResults" :key="`${item.email}-${item.status}-${item.message}`" class="flex items-start justify-between rounded-xl border border-slate-200 bg-white px-4 py-3">
                    <div class="min-w-0 pr-4">
                      <div class="truncate text-sm font-medium text-slate-800">{{ item.email }}</div>
                      <div class="mt-1 text-xs text-slate-500">{{ item.message }}</div>
                    </div>
                    <span :class="['inline-flex shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold', item.status === 'success' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700']">
                      {{ item.status === 'success' ? t('dash.success') : t('dash.failed') }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
            <div class="flex justify-end space-x-4 pt-4">
              <button @click="$emit('close')"
                      class="px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 transition-all duration-300 disabled:opacity-50">
                {{ isBatchAdding ? t('dash.continueBackground') : t('dash.close') }}
              </button>
              <button @click="$emit('add-batch')"
                      :disabled="isBatchAdding"
                      class="px-4 py-2 rounded-xl bg-black text-white hover:bg-white hover:text-black transition-all duration-300 disabled:opacity-50">
                {{ isBatchAdding ? t('dash.batchRunning') : t('dash.batchStart') }}
              </button>
            </div>
          </div>
        </div>
      </transition>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

defineProps({
  show: { type: Boolean, default: false },
  addMode: { type: String, default: 'single' },
  newAccount: { type: Object, required: true },
  newAccountProxyValid: { type: Boolean, default: true },
  providerSupportsProxy: { type: Boolean, default: false },
  providerSupportsBatch: { type: Boolean, default: false },
  isBatchAdding: { type: Boolean, default: false },
  batchAccounts: { type: String, default: '' },
  batchTask: { type: Object, default: null },
  batchTaskStatusText: { type: String, default: '' },
  batchTaskStatusClass: { type: String, default: '' },
  batchTaskProgressStyle: { type: Object, default: () => ({}) },
})

defineEmits(['close', 'add', 'add-batch', 'switch-mode'])

const { t } = useI18n()
</script>
