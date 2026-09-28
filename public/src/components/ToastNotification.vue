<template>
  <div v-if="toast.show"
       :class="[
         'fixed top-4 right-4 z-50 px-6 py-4 rounded-xl shadow-lg transform transition-all duration-300 max-w-md',
         toast.type === 'success' ? 'bg-emerald-500 text-white' :
         toast.type === 'warning' ? 'bg-amber-500 text-white' : 'bg-red-500 text-white'
       ]">
    <span class="whitespace-pre-line">{{ toast.message }}</span>
  </div>
</template>

<script setup>
defineProps({
  toast: {
    type: Object,
    required: true
  }
})
</script>
