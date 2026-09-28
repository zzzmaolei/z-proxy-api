<template>
  <main class="chat-page">
    <header class="chat-header">
      <router-link to="/" class="back-link">← {{ t('chat.backToDashboard') }}</router-link>
      <div class="chat-brand">
        <span class="eyebrow">z.proxy.api / playground</span>
        <h1>{{ t('chat.title') }}</h1>
      </div>
      <span class="model-chip">{{ currentModelLabel || t('chat.loadingModels') }}</span>
    </header>

    <section ref="messagePanel" class="message-panel" aria-live="polite">
      <div v-if="state.messages.length === 0" class="empty-state">
        <div class="empty-orb">✦</div>
        <h2>{{ t('chat.emptyTitle') }}</h2>
        <p>{{ t('chat.emptyHint') }}</p>
      </div>

      <article
        v-for="(message, index) in state.messages"
        :key="index"
        :class="['message-row', `role-${message.role}`]"
      >
        <span class="message-label">{{ message.role === 'user' ? t('chat.you') : t('chat.assistant') }}</span>
        <details v-if="message.role === 'assistant' && message.thinking" class="thinking-block">
          <summary>✦ {{ t('chat.thinking') }}</summary>
          <p>{{ message.thinking }}</p>
        </details>
        <div class="message-content">{{ message.content || (message.role === 'assistant' && state.isSending ? t('chat.waiting') : '') }}</div>
        <p v-if="message.role === 'assistant' && message.error" class="message-error">{{ message.error }}</p>
      </article>

      <div v-if="state.isSending" class="stream-indicator"><i></i><i></i><i></i>{{ t('chat.sending') }}</div>
    </section>

    <form class="composer" @submit.prevent="send">
      <label class="composer-label" for="chat-prompt">{{ t('chat.promptLabel') }}</label>
      <textarea
        id="chat-prompt"
        v-model="state.prompt"
        :placeholder="t('chat.placeholder')"
        :disabled="state.isSending"
        rows="3"
        @keydown.enter.exact.prevent="send"
        @keydown.shift.enter.exact="$event.stopPropagation()"
      ></textarea>
      <div class="composer-actions">
        <select v-model="state.model" :disabled="state.isSending" aria-label="Model">
          <option v-if="state.models.length === 0" value="" disabled>{{ t('chat.loadingModels') }}</option>
          <option v-for="opt in state.models" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
        <span class="shortcut">Enter ↵ 发送 · Shift+Enter 换行</span>
        <button type="submit" :disabled="state.isSending || !state.prompt.trim() || !state.model">
          {{ state.isSending ? t('chat.sending') : t('chat.send') }} <span>↗</span>
        </button>
      </div>
    </form>

    <ToastNotification :toast="toast" />
  </main>
</template>

<script setup>
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { getAuthHeaders } from '../utils/auth.js'
import { useToast } from '../composables/useToast.js'
import ToastNotification from '../components/ToastNotification.vue'

defineOptions({ name: 'Chat' })

const { t } = useI18n()
const { toast, showToast } = useToast()
const messagePanel = ref(null)
const state = reactive({ models: [], messages: [], prompt: '', model: '', isSending: false })

const currentModelLabel = computed(() => state.models.find(m => m.value === state.model)?.label || state.model || '')

const scrollToBottom = async () => {
  await nextTick()
  if (messagePanel.value) messagePanel.value.scrollTop = messagePanel.value.scrollHeight
}

function buildRequestBody(messages, model) {
  return { model, messages: messages.map(m => ({ role: m.role, content: m.content })), stream: true }
}

function consumeChunkText(payload) {
  const choice = payload?.choices?.[0]
  const delta = choice?.delta || {}
  return {
    text: typeof delta.content === 'string' ? delta.content : (payload?.type === 'content_block_delta' && payload.delta?.type === 'text_delta' ? payload.delta.text || '' : ''),
    thinking: typeof delta.reasoning_content === 'string' ? delta.reasoning_content : ''
  }
}

function readSseData(block) {
  return block.split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trim())
    .filter(value => value && value !== '[DONE]')
}

async function streamChat(messages, model) {
  const response = await fetch('/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
    body: JSON.stringify(buildRequestBody(messages, model))
  })
  if (!response.ok) {
    const details = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status}${details ? `: ${details}` : ''}`)
  }
  if (!response.body) throw new Error(t('chat.emptyResponse'))

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  let receivedContent = false
  const applyBlock = async block => {
    for (const data of readSseData(block)) {
      try {
        const { text, thinking } = consumeChunkText(JSON.parse(data))
        const last = state.messages[state.messages.length - 1]
        if (!last || last.role !== 'assistant') continue
        if (text) { last.content += text; receivedContent = true }
        if (thinking) { last.thinking = (last.thinking || '') + thinking; receivedContent = true }
      } catch { /* ignore non-JSON SSE events */ }
    }
    await scrollToBottom()
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    pending += decoder.decode(value, { stream: true })
    let match
    while ((match = /\r?\n\r?\n/.exec(pending))) {
      const block = pending.slice(0, match.index)
      pending = pending.slice(match.index + match[0].length)
      await applyBlock(block)
    }
  }
  pending += decoder.decode()
  if (pending.trim()) await applyBlock(pending)
  if (!receivedContent) throw new Error(t('chat.emptyResponse'))
}

async function send() {
  const prompt = state.prompt.trim()
  if (!prompt || !state.model || state.isSending) return
  state.messages.push({ role: 'user', content: prompt, thinking: '', error: '' })
  state.messages.push({ role: 'assistant', content: '', thinking: '', error: '' })
  state.prompt = ''
  state.isSending = true
  await scrollToBottom()
  try {
    await streamChat(state.messages.slice(0, -1), state.model)
  } catch (error) {
    const last = state.messages[state.messages.length - 1]
    if (last?.role === 'assistant') last.error = error.message || String(error)
    showToast(`${t('chat.sendFailed')}: ${error.message || error}`, 'error', 5000)
  } finally {
    state.isSending = false
    await scrollToBottom()
  }
}

onMounted(async () => {
  try {
    const response = await fetch('/v1/models', { headers: getAuthHeaders() })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    const list = Array.isArray(body) ? body : (body?.data || body?.models || [])
    state.models = list.filter(item => item?.id || item?.name).map(item => ({ label: item.name || item.id, value: item.id || item.name }))
    if (state.models.length) state.model = state.models[0].value
  } catch (error) {
    showToast(`${t('chat.modelsLoadFailed')}: ${error.message || error}`, 'error', 5000)
  }
})
</script>

<style scoped>
.chat-page { position: relative; z-index: 1; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; min-height: 100dvh; max-width: 1440px; margin: auto; padding: 1.4rem clamp(1rem, 3vw, 3rem); color: #18233a; }
.chat-header { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 1rem; padding-bottom: 1.25rem; }
.back-link, .model-chip, .composer, .message-panel { border: 1px solid rgba(255,255,255,.85); background: rgba(255,255,255,.48); box-shadow: 0 16px 36px rgba(31, 38, 135, .08), inset 0 1px 1px rgba(255,255,255,.95); backdrop-filter: blur(28px) saturate(190%); -webkit-backdrop-filter: blur(28px) saturate(190%); border-radius: 20px; }
.back-link { width: fit-content; padding: .7rem 1rem; border-radius: 999px; color: #263959; font-weight: 650; text-decoration: none; transition: transform .2s ease, background .2s ease; }
.back-link:hover { background: rgba(255,255,255,.82); transform: translateX(-2px); }
.chat-brand { text-align: center; }.eyebrow { display: block; color: #71809e; font-size: .69rem; font-weight: 700; letter-spacing: .13em; text-transform: uppercase; }.chat-brand h1 { margin: .12rem 0 0; font-size: clamp(1.15rem, 2vw, 1.65rem); letter-spacing: -.04em; }
.model-chip { justify-self: end; max-width: 15rem; overflow: hidden; padding: .58rem .85rem; border-radius: .85rem; color: #52617d; font-size: .82rem; text-overflow: ellipsis; white-space: nowrap; }
.message-panel { min-height: 0; overflow-y: auto; border-radius: 1.55rem; padding: clamp(1rem, 3vw, 2.2rem); }
.empty-state { display: grid; place-items: center; min-height: 100%; text-align: center; }.empty-orb { display: grid; width: 4rem; height: 4rem; place-items: center; border-radius: 1.35rem; background: linear-gradient(135deg, #cad3ff, #f5d5ff); box-shadow: 0 12px 28px rgba(104, 85, 192, .24); color: #5d54ba; font-size: 1.6rem; }.empty-state h2 { margin: 1rem 0 .25rem; font-size: 1.25rem; }.empty-state p { max-width: 30rem; margin: 0; color: #687793; }
.message-row { display: flex; flex-direction: column; max-width: min(85%, 48rem); margin: .8rem 0; }.role-user { align-items: flex-end; margin-left: auto; }.role-assistant { align-items: flex-start; }.message-label { margin: 0 .25rem .3rem; color: #6f7d97; font-size: .7rem; font-weight: 750; letter-spacing: .09em; text-transform: uppercase; }.message-content { border-radius: 1.1rem; padding: .8rem 1rem; line-height: 1.65; white-space: pre-wrap; word-break: break-word; }.role-user .message-content { border-bottom-right-radius: .28rem; background: linear-gradient(135deg, #5e65d8, #8274d9); box-shadow: 0 10px 24px rgba(91, 88, 191, .22); color: #fff; }.role-assistant .message-content { border: 1px solid rgba(255,255,255,.8); border-bottom-left-radius: .28rem; background: rgba(255,255,255,.72); }.thinking-block { width: 100%; margin-bottom: .45rem; border: 1px solid rgba(224,181,78,.32); border-radius: .9rem; background: rgba(255,249,219,.68); color: #705a19; }.thinking-block summary { cursor: pointer; padding: .55rem .75rem; font-size: .8rem; font-weight: 650; }.thinking-block p { margin: 0; padding: 0 .75rem .7rem; white-space: pre-wrap; font-size: .82rem; line-height: 1.55; }.message-error { margin: .35rem .2rem 0; color: #c2415c; font-size: .8rem; }.stream-indicator { display: flex; align-items: center; gap: .3rem; padding: .75rem; color: #64738e; font-size: .8rem; }.stream-indicator i { width: .38rem; height: .38rem; border-radius: 50%; background: #7769dc; animation: pulse 1s infinite alternate; }.stream-indicator i:nth-child(2) { animation-delay: .18s; }.stream-indicator i:nth-child(3) { animation-delay: .36s; }
.composer { margin-top: 1rem; border-radius: 1.35rem; padding: .9rem; }.composer-label { display: block; margin: .1rem .35rem .5rem; color: #72809a; font-size: .73rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }.composer textarea { box-sizing: border-box; width: 100%; border: 0; outline: 0; resize: vertical; background: transparent; color: #18233a; font: inherit; line-height: 1.5; }.composer textarea::placeholder { color: #9aa6ba; }.composer-actions { display: flex; align-items: center; gap: .65rem; margin-top: .7rem; }.composer select { min-width: 0; flex: 1; border: 1px solid rgba(91,104,159,.2); border-radius: .75rem; padding: .65rem .75rem; background: rgba(255,255,255,.7); color: #26344e; }.shortcut { color: #8894a8; font-size: .75rem; white-space: nowrap; }.composer button { border: 0; border-radius: .78rem; padding: .68rem 1rem; background: #202b45; color: #fff; font: inherit; font-weight: 700; cursor: pointer; transition: transform .18s ease, box-shadow .18s ease; }.composer button:hover:not(:disabled) { box-shadow: 0 9px 20px rgba(32,43,69,.26); transform: translateY(-1px); }.composer button:active:not(:disabled) { transform: scale(.98); }.composer button:disabled { cursor: not-allowed; opacity: .45; }
@keyframes pulse { to { opacity: .25; transform: translateY(-2px); } }
@media (max-width: 680px) { .chat-header { grid-template-columns: 1fr auto; }.chat-brand { grid-column: 1 / -1; grid-row: 1; text-align: left; }.back-link { grid-row: 2; }.model-chip { grid-row: 2; }.message-row { max-width: 94%; }.shortcut { display: none; } }
</style>
