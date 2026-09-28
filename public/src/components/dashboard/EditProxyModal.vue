<template>
  <div v-if="show"
       class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
       @click.self="$emit('close')">
    <div class="relative bg-white/90 backdrop-blur-lg rounded-2xl p-6 w-11/12 max-w-md transform transition-all duration-300 scale-100 opacity-100">
      <h2 class="text-xl font-bold mb-2">{{ t('dash.editProxyTitle') }}</h2>
      <p class="text-sm text-gray-600 mb-4">{{ t('dash.editProxyHint') }}</p>
      <div class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700">Email</label>
          <div class="mt-1 px-4 py-2 rounded-xl bg-gray-100 text-gray-700">{{ editProxy.email }}</div>
        </div>
        <div>
          <label class="block text-sm font-medium text-gray-700">{{ t('dash.proxyLabel') }}</label>
          <input v-model="editProxy.proxy" type="text" :placeholder="t('dash.proxyPlaceholder')"
                 :disabled="isSavingProxy"
                 :class="[
                   'mt-1 block w-full rounded-xl bg-white/50 shadow-sm transition-all duration-300 h-12 text-base px-4 disabled:opacity-70',
                   editProxyValid
                     ? 'border-gray-300 focus:border-indigo-500 focus:ring-indigo-500'
                     : 'border-red-400 focus:border-red-500 focus:ring-red-500'
                 ]">
          <p v-if="!editProxyValid" class="mt-1 text-sm text-red-600">{{ t('msg.proxyInvalid') }}</p>
        </div>
        <div class="flex justify-end space-x-3 pt-2">
          <button @click="$emit('close')"
                  :disabled="isSavingProxy"
                  class="px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 transition-all duration-300 disabled:opacity-50">
            {{ t('dash.cancel') }}
          </button>
          <button @click="$emit('clear')"
                  :disabled="isSavingProxy"
                  class="px-4 py-2 rounded-xl bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 transition-all duration-300 disabled:opacity-50">
            {{ t('dash.clearProxy') }}
          </button>
          <button @click="$emit('save')"
                  :disabled="isSavingProxy || !editProxyValid"
                  class="px-4 py-2 rounded-xl bg-black text-white hover:bg-white hover:text-black border border-black transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed">
            {{ t('dash.save') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

defineProps({
  show: { type: Boolean, default: false },
  editProxy: { type: Object, required: true },
  isSavingProxy: { type: Boolean, default: false },
  editProxyValid: { type: Boolean, default: true },
})

defineEmits(['close', 'clear', 'save'])

const { t } = useI18n()
</script>
