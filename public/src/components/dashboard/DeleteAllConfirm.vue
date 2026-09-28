<template>
  <div v-if="show"
       class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
       @click.self="$emit('close')">
    <div class="relative bg-white/90 backdrop-blur-lg rounded-2xl p-6 w-11/12 max-w-md transform transition-all duration-300 scale-100 opacity-100">
      <h2 class="text-2xl font-bold text-red-600 mb-4">{{ t('dash.dangerTitle') }}</h2>
      <p class="text-gray-700 mb-6">{{ t('dash.dangerText', { n: totalItems }) }}</p>
      <div class="flex justify-end space-x-4">
        <button @click="$emit('close')"
                class="px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 transition-all duration-300">
          {{ t('dash.cancel') }}
        </button>
        <button @click="$emit('confirm')"
                class="px-4 py-2 rounded-xl bg-red-600 text-white hover:bg-red-700 transition-all duration-300">
          {{ t('dash.confirmDelete') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from 'vue-i18n'

defineProps({
  show: { type: Boolean, default: false },
  totalItems: { type: Number, default: 0 },
})

defineEmits(['close', 'confirm'])

const { t } = useI18n()
</script>
