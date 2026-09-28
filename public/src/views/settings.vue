<template>
    <div class="settings-page w-full min-h-screen">
        <div class="settings-shell container mx-auto">
            <div class="settings-header flex flex-col md:flex-row justify-between items-center mb-6 space-y-4 md:space-y-0">
                <h1 class="text-3xl font-bold">{{ t('settings.title') }}</h1>
                <div class="flex items-center space-x-3">
                    <router-link to="/"
                        class="action-button font-bold border border-blue-200 bg-blue-50 text-blue-900 px-4 py-2 rounded-xl shadow-sm hover:bg-blue-100 hover:border-blue-400 transition-all duration-300 transform hover:-translate-y-1 active:translate-y-0 text-center">
                        {{ t('settings.backToDash') }}
                    </router-link>
                    <LangSwitcher />
                </div>
            </div>
            <div class="settings-status" :class="{ 'settings-status--volatile': settings.persistenceMode === 'none' }">
                <span class="settings-status__dot"></span>
                {{ settings.persistenceMode === 'none' ? t('settings.persistenceNone') : t('settings.persistenceSaved') }}
            </div>
            <div class="grid grid-cols-1 gap-6 p-4">
                <!-- ============ 统一设置区（同时生效于 Qwen / DeepSeek） ============ -->
                <div class="section-header">
                    <h2 class="text-xl font-bold text-gray-800">{{ t('settings.sectionUnified') }}</h2>
                    <p class="text-sm text-gray-500 mt-1">{{ t('settings.sectionUnifiedHint') }}</p>
                </div>

                <!-- API Key 管理 -->
                <div class="setting-card relative overflow-hidden rounded-2xl p-6 flex flex-col gap-4">
                    <div class="absolute inset-0 bg-white/30 backdrop-blur-md border border-white/30 rounded-2xl"></div>
                    <div class="relative flex flex-col gap-4">
                        <label class="text-gray-700 font-semibold text-lg">{{ t('settings.apiKeyTitle') }}</label>

                        <!-- 管理员密钥 -->
                        <div class="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                            <div class="flex items-center gap-2 mb-2">
                                <span class="text-yellow-600 font-semibold">{{ t('settings.adminKey') }}</span>
                                <span class="text-xs bg-yellow-200 text-yellow-800 px-2 py-1 rounded">{{ t('settings.adminReadonly') }}</span>
                            </div>
                            <input :value="settings.adminKey" type="text" readonly
                                class="w-full rounded-lg border-gray-300 bg-gray-100 shadow-sm h-10 text-sm px-3 cursor-not-allowed">
                        </div>

                        <!-- 普通密钥列表 -->
                        <div class="space-y-2">
                            <div class="flex items-center justify-between">
                                <span class="text-gray-700 font-semibold">{{ t('settings.regularKeys') }}</span>
                                <button @click="showAddKeyModal = true"
                                    class="bg-green-500 text-white px-3 py-1 rounded-lg text-sm hover:bg-green-600 transition-all">
                                    {{ t('settings.addKey') }}
                                </button>
                            </div>

                            <div v-if="settings.regularKeys.length === 0" class="text-gray-500 text-center py-4">
                                {{ t('settings.noKeys') }}
                            </div>

                            <div v-for="(key, index) in settings.regularKeys" :key="index"
                                class="flex items-center gap-2 bg-gray-50 border border-gray-200 rounded-lg p-3">
                                <input :value="key" type="text" readonly
                                    class="flex-1 rounded-lg border-gray-300 bg-white shadow-sm h-8 text-sm px-3">
                                <button @click="deleteRegularKey(index)"
                                    class="bg-red-500 text-white px-3 py-1 rounded-lg text-sm hover:bg-red-600 transition-all">
                                    {{ t('settings.delete') }}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 统一设置项网格 -->
                <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <!-- CPA 统一配置中枢热生效控制条 -->
                    <div class="setting-card relative overflow-hidden rounded-2xl p-6 flex flex-col md:flex-row items-center justify-between gap-4 border border-cyan-500/30 bg-gradient-to-r from-slate-900/90 to-slate-950/95 text-slate-100 shadow-xl">
                        <div class="flex items-center space-x-3">
                            <span class="flex h-3 w-3 relative">
                                <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
                                <span class="relative inline-flex rounded-full h-3 w-3 bg-cyan-500"></span>
                            </span>
                            <div>
                                <h3 class="font-bold text-base text-slate-100">CPA 级统一配置中枢 (Hot-Sync Engine)</h3>
                                <p class="text-xs text-slate-400">修改后点击一键热同步，配置将原子落盘至 data/config.json 并立即内存热重载，无需重启服务</p>
                            </div>
                        </div>
                        <button @click="saveAllConfigHotSync" :disabled="isSavingAll"
                            class="px-5 py-2.5 rounded-xl font-bold bg-gradient-to-r from-cyan-600 to-blue-600 text-white shadow-lg hover:from-cyan-500 hover:to-blue-500 transition-all flex items-center gap-2">
                            <span v-if="isSavingAll" class="animate-spin">⟳</span>
                            <span>{{ isSavingAll ? '正在原子同步...' : '⚡ 一键热同步全部配置' }}</span>
                        </button>
                    </div>

                    <!-- 自动刷新 -->
                    <div class="setting-card relative overflow-hidden rounded-2xl p-6 flex flex-col gap-4">
                        <div class="absolute inset-0 bg-white/30 backdrop-blur-md border border-white/30 rounded-2xl">
                        </div>
                        <div class="relative flex flex-col gap-2">
                            <label class="text-gray-700 font-semibold">{{ t('settings.autoRefresh') }}</label>
                            <div class="flex items-center gap-2">
                                <input v-model="settings.autoRefresh" type="checkbox"
                                    class="h-5 w-5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500">
                                <span>{{ t('settings.enableAutoRefresh') }}</span>
                            </div>
                            <label class="text-gray-700">{{ t('settings.refreshInterval') }}</label>
                            <input v-model.number="settings.autoRefreshInterval" type="number"
                                class="mt-1 block w-full rounded-xl border-gray-300 bg-white/60 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all duration-300 h-12 text-base px-4">
                            <button @click="saveAutoRefresh"
                                class="w-full mt-2 bg-black text-white rounded-lg py-2 hover:bg-white hover:text-black border border-black transition-all duration-300">{{ t('settings.save') }}</button>
                        </div>
                    </div>
                    <!-- 批量登录并发数 -->
                    <div class="setting-card relative overflow-hidden rounded-2xl p-6 flex flex-col gap-4">
                        <div class="absolute inset-0 bg-white/30 backdrop-blur-md border border-white/30 rounded-2xl">
                        </div>
                        <div class="relative flex flex-col gap-2">
                            <label class="text-gray-700 font-semibold">{{ t('settings.batchConcurrency') }}</label>
                            <label class="text-gray-700">{{ t('settings.batchConcurrencyDesc') }}</label>
                            <input v-model.number="settings.batchLoginConcurrency" type="number" min="1" max="20"
                                class="mt-1 block w-full rounded-xl border-gray-300 bg-white/60 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all duration-300 h-12 text-base px-4">
                            <span class="text-xs text-gray-500">{{ t('settings.batchConcurrencyHint') }}</span>
                            <button @click="saveBatchLoginConcurrency"
                                class="w-full mt-2 bg-black text-white rounded-lg py-2 hover:bg-white hover:text-black border border-black transition-all duration-300">{{ t('settings.save') }}</button>
                        </div>
                    </div>
                    <!-- 思考输出 -->
                    <div class="setting-card relative overflow-hidden rounded-2xl p-6 flex flex-col gap-4">
                        <div class="absolute inset-0 bg-white/30 backdrop-blur-md border border-white/30 rounded-2xl">
                        </div>
                        <div class="relative flex flex-col gap-2">
                            <label class="text-gray-700 font-semibold">{{ t('settings.thinkOutput') }}</label>
                            <div class="flex items-center gap-2">
                                <input v-model="settings.outThink" type="checkbox"
                                    class="h-5 w-5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500">
                                <span>{{ t('settings.enableThinkOutput') }}</span>
                            </div>
                            <button @click="saveOutThink"
                                class="w-full mt-2 bg-black text-white rounded-lg py-2 hover:bg-white hover:text-black border border-black transition-all duration-300">{{ t('settings.save') }}</button>
                        </div>
                    </div>
                    <!-- 搜索信息模式 -->
                    <div class="setting-card relative overflow-hidden rounded-2xl p-6 flex flex-col gap-4">
                        <div class="absolute inset-0 bg-white/30 backdrop-blur-md border border-white/30 rounded-2xl">
                        </div>
                        <div class="relative flex flex-col gap-2">
                            <label class="text-gray-700 font-semibold">{{ t('settings.searchMode') }}</label>
                            <select v-model="settings.searchInfoMode"
                                class="mt-1 block w-full rounded-xl border-gray-300 bg-white/60 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all duration-300 h-12 text-base px-4">
                                <option value="table">{{ t('settings.searchTable') }}</option>
                                <option value="text">{{ t('settings.searchText') }}</option>
                            </select>
                            <button @click="saveSearchInfoMode"
                                class="w-full mt-2 bg-black text-white rounded-lg py-2 hover:bg-white hover:text-black border border-black transition-all duration-300">{{ t('settings.save') }}</button>
                        </div>
                    </div>
                    <!-- 聊天请求 retry 配置 -->
                    <div class="setting-card relative overflow-hidden rounded-2xl p-6 flex flex-col gap-4">
                        <div class="absolute inset-0 bg-white/30 backdrop-blur-md border border-white/30 rounded-2xl">
                        </div>
                        <div class="relative flex flex-col gap-2">
                            <label class="text-gray-700 font-semibold">{{ t('settings.retryTitle') }}</label>
                            <label class="text-gray-700">{{ t('settings.retryCountLabel') }}</label>
                            <input v-model.number="settings.chatRetryCount" type="number" min="0" max="10"
                                class="mt-1 block w-full rounded-xl border-gray-300 bg-white/60 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all duration-300 h-12 text-base px-4">
                            <label class="text-gray-700">{{ t('settings.retryBackoffLabel') }}</label>
                            <input v-model.number="settings.chatRetryBackoffMs" type="number" min="0" max="60000"
                                class="mt-1 block w-full rounded-xl border-gray-300 bg-white/60 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all duration-300 h-12 text-base px-4">
                            <span class="text-xs text-gray-500">{{ t('settings.retryHint') }}</span>
                            <button @click="saveRetryConfig"
                                class="w-full mt-2 bg-black text-white rounded-lg py-2 hover:bg-white hover:text-black border border-black transition-all duration-300">{{ t('settings.save') }}</button>
                        </div>
                    </div>
                </div>

                <!-- ============ DeepSeek 独有设置区 ============ -->
                <div class="section-header">
                    <h2 class="text-xl font-bold text-gray-800">{{ t('settings.sectionDpsk') }}</h2>
                    <p class="text-sm text-gray-500 mt-1">{{ t('settings.sectionDpskHint') }}</p>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <!-- DeepSeek think effort 默认值 -->
                    <div class="setting-card relative overflow-hidden rounded-2xl p-6 flex flex-col gap-4">
                        <div class="absolute inset-0 bg-white/30 backdrop-blur-md border border-white/30 rounded-2xl">
                        </div>
                        <div class="relative flex flex-col gap-2">
                            <label class="text-gray-700 font-semibold">{{ t('settings.dpskThinkEffortTitle') }}</label>
                            <label class="text-gray-700 text-sm">{{ t('settings.dpskThinkEffortDesc') }}</label>
                            <select v-model="settings.dpskThinkEffort"
                                class="mt-1 block w-full rounded-xl border-gray-300 bg-white/60 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all duration-300 h-12 text-base px-4">
                                <option value="low">{{ t('settings.dpskThinkEffortLow') }}</option>
                                <option value="medium">{{ t('settings.dpskThinkEffortMedium') }}</option>
                                <option value="high">{{ t('settings.dpskThinkEffortHigh') }}</option>
                                <option value="max">{{ t('settings.dpskThinkEffortMax') }}</option>
                            </select>
                            <span class="text-xs text-gray-500">{{ t('settings.dpskThinkEffortHint') }}</span>
                            <button @click="saveDpskThinkEffort"
                                class="w-full mt-2 bg-black text-white rounded-lg py-2 hover:bg-white hover:text-black border border-black transition-all duration-300">{{ t('settings.save') }}</button>
                        </div>
                    </div>
                </div>

                <!-- ============ TLS Sidecar 设置区 ============ -->
                <div class="section-header">
                    <h2 class="text-xl font-bold text-gray-800">{{ t('settings.sectionTlsSidecar') }}</h2>
                    <p class="text-sm text-gray-500 mt-1">{{ t('settings.sectionTlsSidecarHint') }}</p>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <!-- TLS Sidecar 启用模式 -->
                    <div class="setting-card relative overflow-hidden rounded-2xl p-6 flex flex-col gap-4">
                        <div class="absolute inset-0 bg-white/30 backdrop-blur-md border border-white/30 rounded-2xl">
                        </div>
                        <div class="relative flex flex-col gap-2">
                            <label class="text-gray-700 font-semibold">{{ t('settings.tlsSidecarEnabledTitle') }}</label>
                            <label class="text-gray-700 text-sm">{{ t('settings.tlsSidecarEnabledDesc') }}</label>
                            <select v-model="settings.tlsSidecarMode"
                                class="mt-1 block w-full rounded-xl border-gray-300 bg-white/60 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all duration-300 h-12 text-base px-4">
                                <option value="false">{{ t('settings.tlsSidecarDisabled') }}</option>
                                <option value="all">{{ t('settings.tlsSidecarAll') }}</option>
                                <option value="dpsk">{{ t('settings.tlsSidecarDpsk') }}</option>
                                <option value="qwen">{{ t('settings.tlsSidecarQwen') }}</option>
                            </select>
                            <span class="text-xs text-gray-500">{{ t('settings.tlsSidecarEnabledHint') }}</span>
                            <button @click="saveTlsSidecar"
                                class="w-full mt-2 bg-black text-white rounded-lg py-2 hover:bg-white hover:text-black border border-black transition-all duration-300">{{ t('settings.save') }}</button>
                        </div>
                    </div>
                    <!-- TLS Sidecar 端口 -->
                    <div class="setting-card relative overflow-hidden rounded-2xl p-6 flex flex-col gap-4">
                        <div class="absolute inset-0 bg-white/30 backdrop-blur-md border border-white/30 rounded-2xl">
                        </div>
                        <div class="relative flex flex-col gap-2">
                            <label class="text-gray-700 font-semibold">{{ t('settings.tlsSidecarPortTitle') }}</label>
                            <label class="text-gray-700 text-sm">{{ t('settings.tlsSidecarPortDesc') }}</label>
                            <input v-model.number="settings.tlsSidecarPort" type="number" min="1" max="65535"
                                class="mt-1 block w-full rounded-xl border-gray-300 bg-white/60 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all duration-300 h-12 text-base px-4">
                            <span class="text-xs text-gray-500">{{ t('settings.tlsSidecarPortHint') }}</span>
                            <button @click="saveTlsSidecar"
                                class="w-full mt-2 bg-black text-white rounded-lg py-2 hover:bg-white hover:text-black border border-black transition-all duration-300">{{ t('settings.save') }}</button>
                        </div>
                    </div>
                </div>

                <!-- ============ Qwen 独有设置区 ============ -->
                <div class="section-header">
                    <h2 class="text-xl font-bold text-gray-800">{{ t('settings.sectionQwen') }}</h2>
                    <p class="text-sm text-gray-500 mt-1">{{ t('settings.sectionQwenHint') }}</p>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <!-- 简化模型映射 -->
                    <div class="setting-card relative overflow-hidden rounded-2xl p-6 flex flex-col gap-4">
                        <div class="absolute inset-0 bg-white/30 backdrop-blur-md border border-white/30 rounded-2xl">
                        </div>
                        <div class="relative flex flex-col gap-2">
                            <label class="text-gray-700 font-semibold">{{ t('settings.simpleModelMap') }}</label>
                            <div class="flex items-center gap-2">
                                <input v-model="settings.simpleModelMap" type="checkbox"
                                    class="h-5 w-5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-500">
                                <span>{{ t('settings.simpleModelMapDesc') }}</span>
                            </div>
                            <button @click="saveSimpleModelMap"
                                class="w-full mt-2 bg-black text-white rounded-lg py-2 hover:bg-white hover:text-black border border-black transition-all duration-300">{{ t('settings.save') }}</button>
                        </div>
                    </div>
                </div>
            </div>

            <!-- 添加API Key模态框 -->
            <div v-if="showAddKeyModal"
                class="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
                <div class="bg-white rounded-lg p-6 w-96 max-w-90vw">
                    <h3 class="text-lg font-semibold mb-4">{{ t('settings.addKeyTitle') }}</h3>
                    <input v-model="newApiKey" type="text" :placeholder="t('settings.addKeyPlaceholder')"
                        class="w-full rounded-lg border-gray-300 shadow-sm h-10 text-sm px-3 mb-4">
                    <div class="flex gap-2 justify-end">
                        <button @click="showAddKeyModal = false"
                            class="px-4 py-2 bg-gray-300 text-gray-700 rounded-lg hover:bg-gray-400 transition-all">
                            {{ t('settings.cancel') }}
                        </button>
                        <button @click="addRegularKey"
                            class="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-all">
                            {{ t('settings.add') }}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <!-- Toast 通知 -->
    <ToastNotification :toast="toast" />
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import axios from 'axios'
import LangSwitcher from '../components/LangSwitcher.vue'
import { getApiKey, getAuthHeaders } from '../utils/auth.js'
import { useToast } from '../composables/useToast.js'
import ToastNotification from '../components/ToastNotification.vue'

const { toast, showToast } = useToast()

const { t } = useI18n()

const settings = ref({
    apiKey: getApiKey(),
    adminKey: '',
    regularKeys: [],
    autoRefresh: false,
    autoRefreshInterval: 21600,
    batchLoginConcurrency: 5,
    outThink: false,
    searchInfoMode: 'table',
    simpleModelMap: false,
    chatRetryCount: 1,
    chatRetryBackoffMs: 400,
    // 两家路线独有设置
    dpskThinkEffort: 'high',   // DeepSeek 默认 think effort (low/medium/high/max)
    // TLS Sidecar 设置
    tlsSidecarMode: 'false',   // 启用模式 (false/all/dpsk/qwen)
    tlsSidecarPort: 9091,      // Sidecar 监听端口
    persistenceMode: 'file',
})

const showAddKeyModal = ref(false)
const newApiKey = ref('')

const loadSettings = async () => {
    try {
        const res = await axios.get('/api/settings', {
        headers: getAuthHeaders()
    })
    settings.value.apiKey = res.data.apiKey
    settings.value.adminKey = res.data.adminKey || ''
    settings.value.regularKeys = res.data.regularKeys || []
    settings.value.autoRefresh = res.data.autoRefresh
    settings.value.autoRefreshInterval = res.data.autoRefreshInterval
    settings.value.batchLoginConcurrency = res.data.batchLoginConcurrency
    settings.value.outThink = res.data.outThink
    settings.value.searchInfoMode = res.data.searchInfoMode
    settings.value.simpleModelMap = res.data.simpleModelMap
    if (res.data.chatRetryCount !== undefined) settings.value.chatRetryCount = res.data.chatRetryCount
    if (res.data.chatRetryBackoffMs !== undefined) settings.value.chatRetryBackoffMs = res.data.chatRetryBackoffMs
        // 两家路线独有设置
        if (res.data.dpskThinkEffort && ['low', 'medium', 'high', 'max'].includes(res.data.dpskThinkEffort)) {
            settings.value.dpskThinkEffort = res.data.dpskThinkEffort
        }
        // TLS Sidecar 设置
        if (res.data.tlsSidecarEnabled !== undefined) {
            settings.value.tlsSidecarMode = String(res.data.tlsSidecarEnabled)
        }
        if (res.data.tlsSidecarPort !== undefined) {
    settings.value.tlsSidecarPort = res.data.tlsSidecarPort
    settings.value.persistenceMode = res.data.persistenceMode || 'none'
        }
    } catch (error) {
        console.error('loadSettings error:', error)
    }
}

const saveAutoRefresh = async () => {
    try {
        await axios.post('/api/setAutoRefresh', {
            autoRefresh: settings.value.autoRefresh,
            autoRefreshInterval: settings.value.autoRefreshInterval
        }, {
            headers: getAuthHeaders()
        })
        showToast(t('smsg.autoRefreshSaved'))
    } catch (error) {
        showToast(t('smsg.autoRefreshFailed') + error.message, 'error')
    }
}
const saveBatchLoginConcurrency = async () => {
    try {
        await axios.post('/api/setBatchLoginConcurrency', {
            batchLoginConcurrency: settings.value.batchLoginConcurrency
        }, {
            headers: getAuthHeaders()
        })
        showToast(t('smsg.batchSaved'))
    } catch (error) {
        showToast(t('smsg.batchFailed') + error.message, 'error')
    }
}
const saveOutThink = async () => {
    try {
        await axios.post('/api/setOutThink', { outThink: settings.value.outThink }, {
            headers: getAuthHeaders()
        })
        showToast(t('smsg.thinkSaved'))
    } catch (error) {
        showToast(t('smsg.thinkFailed') + error.message, 'error')
    }
}
const saveSearchInfoMode = async () => {
    try {
        await axios.post('/api/search-info-mode', { searchInfoMode: settings.value.searchInfoMode }, {
            headers: getAuthHeaders()
        })
        showToast(t('smsg.searchModeSaved'))
    } catch (error) {
        showToast(t('smsg.searchModeFailed') + error.message, 'error')
    }
}
const saveSimpleModelMap = async () => {
    try {
        await axios.post('/api/simple-model-map', { simpleModelMap: settings.value.simpleModelMap }, {
            headers: getAuthHeaders()
        })
        showToast(t('smsg.simpleMapSaved'))
    } catch (error) {
        showToast(t('smsg.simpleMapFailed') + error.message, 'error')
    }
}
const saveRetryConfig = async () => {
    try {
        await axios.post('/api/setRetryConfig', {
            chatRetryCount: settings.value.chatRetryCount,
            chatRetryBackoffMs: settings.value.chatRetryBackoffMs
        }, {
            headers: getAuthHeaders()
        })
        showToast(t('smsg.retrySaved'))
    } catch (error) {
        showToast(t('smsg.retryFailed') + (error.response?.data?.error || error.message), 'error')
    }
}
// DeepSeek 默认 think effort 保存
const saveDpskThinkEffort = async () => {
    try {
        await axios.post('/api/setDpskThinkEffort', {
            dpskThinkEffort: settings.value.dpskThinkEffort
        }, {
            headers: getAuthHeaders()
        })
        showToast(t('smsg.dpskThinkEffortSaved'))
    } catch (error) {
        showToast(t('smsg.dpskThinkEffortFailed') + (error.response?.data?.error || error.message), 'error')
    }
}
// TLS Sidecar 配置保存
const saveTlsSidecar = async () => {
    try {
        const tlsSidecarEnabled = settings.value.tlsSidecarMode === 'false' ? false : settings.value.tlsSidecarMode
        await axios.post('/api/setTlsSidecar', {
            tlsSidecarEnabled,
            tlsSidecarPort: settings.value.tlsSidecarPort
        }, {
            headers: getAuthHeaders()
        })
        showToast(t('smsg.tlsSidecarSaved'))
    } catch (error) {
        showToast(t('smsg.tlsSidecarFailed') + (error.response?.data?.error || error.message), 'error')
    }
}

const isSavingAll = ref(false)
const saveAllConfigHotSync = async () => {
    isSavingAll.value = true
    try {
        const payload = {
            dpskThinkEffort: settings.value.dpskThinkEffort,
            chatRetryCount: settings.value.chatRetryCount,
            chatRetryBackoffMs: settings.value.chatRetryBackoffMs,
            outThink: settings.value.outThink,
            simpleModelMap: settings.value.simpleModelMap,
            searchInfoMode: settings.value.searchInfoMode,
            autoRefresh: settings.value.autoRefresh,
            autoRefreshInterval: settings.value.autoRefreshInterval,
            batchLoginConcurrency: settings.value.batchLoginConcurrency,
            tlsSidecarEnabled: settings.value.tlsSidecarMode === 'false' ? false : settings.value.tlsSidecarMode,
            tlsSidecarPort: settings.value.tlsSidecarPort,
            dpskRoutingStrategy: 'round-robin',
            dpskSessionAffinity: false
        }
        const res = await axios.post('/api/config', payload, {
            headers: getAuthHeaders()
        })
        showToast('⚡ CPA 统一配置已原子落盘并实时原地热生效！')
        await loadSettings()
    } catch (err) {
        showToast('热同步失败: ' + (err.response?.data?.error || err.message), 'error')
    } finally {
        isSavingAll.value = false
    }
}

// API Key 管理相关函数
const addRegularKey = async () => {
    if (!newApiKey.value.trim()) {
        showToast(t('smsg.enterKey'))
        return
    }

    try {
        await axios.post('/api/addRegularKey', { apiKey: newApiKey.value.trim() }, {
            headers: getAuthHeaders()
        })
        showToast(t('smsg.keyAdded'))
        newApiKey.value = ''
        showAddKeyModal.value = false
        await loadSettings()
    } catch (error) {
        showToast(t('smsg.keyAddFailed') + error.message, 'error')
    }
}

const deleteRegularKey = async (index) => {
    if (!confirm(t('smsg.confirmDeleteKey'))) return

    const keyToDelete = settings.value.regularKeys[index]
    try {
        await axios.post('/api/deleteRegularKey', { apiKey: keyToDelete }, {
            headers: getAuthHeaders()
        })
        showToast(t('smsg.keyDeleted'))
        await loadSettings()
    } catch (error) {
        showToast(t('smsg.keyDeleteFailed') + error.message, 'error')
    }
}

onMounted(() => {
    loadSettings()
})
</script>

<style lang="css" scoped>
.setting-card {
    background: rgba(255, 255, 255, 0.48);
    backdrop-filter: blur(28px) saturate(190%);
    -webkit-backdrop-filter: blur(28px) saturate(190%);
    border: 1px solid rgba(255, 255, 255, 0.85);
    border-radius: 20px;
    box-shadow: 0 16px 36px rgba(31, 38, 135, 0.07), inset 0 1px 1px rgba(255, 255, 255, 0.95);
    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}
.setting-card:hover {
    transform: translateY(-2px);
    box-shadow: 0 20px 42px rgba(31, 38, 135, 0.12), inset 0 1px 1px rgba(255, 255, 255, 1);
}

.setting-card:hover {
    background: rgba(255, 255, 255, 0.60);
    box-shadow: 0 24px 55px rgba(61, 77, 135, 0.16), inset 0 1px rgba(255,255,255,.95);
    transform: translateY(-3px);
}

.action-button {
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
}

/* 分区标题样式 */
.section-header {
    padding: .4rem .25rem .2rem 1rem;
    margin-top: 1.1rem;
    border-left: 3px solid #6979e8;
    text-wrap: balance;
}
.settings-page { position: relative; z-index: 1; color: #1c2a44; }.settings-shell { max-width: 1440px; padding: 1.75rem clamp(1rem, 3vw, 3rem) 3rem; }.settings-header h1 { letter-spacing: -.045em; }.settings-header .action-button { background: rgba(255,255,255,.64); border-color: rgba(111,124,197,.18); color: #36456b; }.settings-status { display: inline-flex; align-items: center; gap: .5rem; margin: 0 1rem 1rem; border: 1px solid rgba(76, 160, 129, .2); border-radius: 999px; padding: .45rem .7rem; background: rgba(239, 255, 248, .55); color: #368264; font-size: .78rem; font-weight: 650; }.settings-status__dot { width: .46rem; height: .46rem; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 4px rgba(54,130,100,.12); }.settings-status--volatile { border-color: rgba(204,113,69,.2); background: rgba(255,244,234,.6); color: #b76537; }.setting-card :deep(input), .setting-card :deep(select) { border-color: rgba(104,119,170,.16); box-shadow: inset 0 1px rgba(255,255,255,.75); }.setting-card :deep(button.bg-black) { background: #24314e; border-color: #24314e; border-radius: .75rem; }.setting-card :deep(button.bg-black:hover) { background: #35466e; color: #fff; }@media (max-width: 640px) { .settings-shell { padding: 1rem .75rem 2rem; }.settings-status { margin-left: 0; }.setting-card { padding: 1.1rem; } }
</style>
