/**
 * useToast — Toast 通知 composable
 */
import { ref } from 'vue'

export function useToast() {
  const toast = ref({ show: false, message: '', type: 'success' })
  let timer = null

  const showToast = (message, type = 'success', duration = 3000) => {
    if (timer) { clearTimeout(timer); timer = null }
    toast.value = { show: true, message, type }
    timer = setTimeout(() => { toast.value.show = false; timer = null }, duration)
  }

  return { toast, showToast }
}
