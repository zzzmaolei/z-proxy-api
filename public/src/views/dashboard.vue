<template>
  <div class="dashboard-page dashboard-scroll w-screen min-h-screen overflow-y-auto">
    <div class="dashboard-shell container mx-auto">
      <!-- 顶部全局标题栏：仅保留导航与语言切换 -->
      <div class="dashboard-topbar flex flex-col md:flex-row justify-between items-start md:items-center mb-6 space-y-4 md:space-y-0">
        <h1 class="text-4xl font-bold text-gray-900">{{ t('dash.title') }}</h1>
        <div class="flex flex-col md:flex-row md:items-center w-full md:w-auto gap-3">
          <!-- 导航按钮 -->
          <div class="flex gap-2">
          <router-link to="/statistics"
                       class="action-button font-bold border border-indigo-200 bg-indigo-50 text-indigo-900 px-4 py-2 rounded-xl shadow-sm hover:bg-indigo-100 hover:border-indigo-400 transition-all duration-300 transform hover:-translate-y-1 active:translate-y-0 text-center">
            {{ t('dash.statistics') }}
          </router-link>
          <router-link to="/settings"
                       class="action-button font-bold border border-blue-200 bg-blue-50 text-blue-900 px-4 py-2 rounded-xl shadow-sm hover:bg-blue-100 hover:border-blue-400 transition-all duration-300 transform hover:-translate-y-1 active:translate-y-0 text-center">
            {{ t('dash.settings') }}
          </router-link>
          <router-link to="/chat"
                       class="action-button font-bold border border-blue-200 bg-blue-50 text-blue-900 px-4 py-2 rounded-xl shadow-sm hover:bg-blue-100 hover:border-blue-400 transition-all duration-300 transform hover:-translate-y-1 active:translate-y-0 text-center">
            {{ t('dash.chat') }}
          </router-link>
          </div>
          <LangSwitcher class="self-center md:self-auto" />
        </div>
      </div>

      <!-- 顶部实时调度与流式遥测驾驶舱 (液态高透磨砂态) -->
      <TelemetryCockpit />

      <!-- 两大类分类呈现：DeepSeek → Qwen -->
      <div v-for="cat in categories" :key="cat.value" class="mb-8 px-4">
        <!-- 大类标题栏 -->
        <div class="flex flex-wrap items-center justify-between gap-3 mb-4 p-4 rounded-2xl bg-white/60 backdrop-blur-sm border shadow-sm"
             :class="categoryBorderClass(cat.value)">
          <div class="flex items-center gap-3">
            <!-- collapse/expand 按钮 -->
            <button @click="toggleCategoryCollapse(cat.value)"
                    class="text-xl w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/80 transition-all duration-200 select-none"
                    :title="collapsed[cat.value] ? t('dash.expand') : t('dash.collapse')">
              <span class="inline-block transition-transform duration-200" :class="{ 'rotate-90': collapsed[cat.value] }">▼</span>
            </button>
            <h2 class="text-2xl font-bold" :class="categoryTextClass(cat.value)">
              {{ t(cat.labelKey) }}
            </h2>
            <span class="text-sm text-gray-500">
              {{ t('dash.accountCount', { n: providerStates[cat.value].totalItems }) }}
            </span>
          </div>
          <!-- 每个大类独立的操作按钮 -->
          <div class="flex flex-wrap gap-2">
            <button @click="openAddModal(cat.value)"
                    class="action-button font-bold border border-green-200 bg-green-50 text-green-900 px-3 py-1.5 rounded-xl shadow-sm hover:bg-green-100 hover:border-green-400 transition-all duration-300 transform hover:-translate-y-1 active:translate-y-0 text-center text-sm">
              {{ t('dash.addAccount') }}
            </button>
            <button @click="refreshAllAccounts(cat.value)"
                    :disabled="providerStates[cat.value].isRefreshingAll"
                    :class="[
                      'action-button font-bold px-3 py-1.5 rounded-xl shadow-sm transition-all duration-300 transform active:translate-y-0 text-sm',
                      providerStates[cat.value].isRefreshingAll
                        ? 'bg-purple-400 text-white border-purple-400 refreshing-button-purple cursor-not-allowed transform-none'
                        : 'macaron-purple-button text-purple-800 hover:-translate-y-1'
                    ]">
              <span v-if="providerStates[cat.value].isRefreshingAll" class="flex items-center space-x-1">
                <svg class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="m4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span>{{ t('dash.refreshing') }}</span>
              </span>
              <span v-else>{{ t('dash.refreshAll') }}</span>
            </button>
            <button @click="forceRefreshAllAccounts(cat.value)"
                    :disabled="providerStates[cat.value].isForceRefreshingAll"
                    :class="[
                      'action-button font-bold px-3 py-1.5 rounded-xl shadow-sm transition-all duration-300 transform active:translate-y-0 text-sm',
                      providerStates[cat.value].isForceRefreshingAll
                        ? 'bg-pink-400 text-white border-pink-400 refreshing-button-pink cursor-not-allowed transform-none'
                        : 'macaron-pink-button text-pink-800 hover:-translate-y-1'
                    ]">
              <span v-if="providerStates[cat.value].isForceRefreshingAll" class="flex items-center space-x-1">
                <svg class="animate-spin h-4 w-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                  <path class="opacity-75" fill="currentColor" d="m4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <span>{{ t('dash.forceRefreshing') }}</span>
              </span>
              <span v-else>{{ t('dash.forceRefresh') }}</span>
            </button>
            <button @click="exportAccounts(cat.value)"
                    class="action-button font-bold border border-yellow-200 bg-yellow-50 text-yellow-900 px-3 py-1.5 rounded-xl shadow-sm hover:bg-yellow-100 hover:border-yellow-400 transition-all duration-300 transform hover:-translate-y-1 active:translate-y-0 text-center text-sm">
              {{ t('dash.export') }}
            </button>
            <button @click="confirmDeleteAll(cat.value)"
                    class="action-button font-bold border border-red-300 bg-red-50 text-red-700 px-3 py-1.5 rounded-xl shadow-sm hover:bg-red-100 hover:border-red-400 transition-all duration-300 transform hover:-translate-y-1 active:translate-y-0 text-center text-sm">
              {{ t('dash.deleteAll') }}
            </button>
          </div>
        </div>

        <!-- 大类内容区（可折叠） -->
        <div v-show="!collapsed[cat.value]">
          <!-- 多选操作区 -->
          <div class="flex justify-between items-center mb-4">
            <div class="flex items-center space-x-3">
              <label class="inline-flex items-center cursor-pointer group">
                <div class="relative">
                  <input type="checkbox"
                        v-model="providerStates[cat.value].selectAll"
                        @change="toggleSelectAll(cat.value)"
                        class="sr-only peer">
                  <div class="w-6 h-6 bg-white border-2 border-gray-300 rounded-lg peer-checked:bg-indigo-500 peer-checked:border-indigo-500 transition-all duration-300 flex items-center justify-center">
                    <svg v-show="providerStates[cat.value].selectAll" class="w-4 h-4 text-white" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                  </div>
                </div>
                <span class="ml-2 text-gray-700 group-hover:text-indigo-700 transition-colors duration-200">{{ t('dash.selectAll') }}</span>
              </label>
              <button
                @click="deleteSelected(cat.value)"
                :disabled="providerStates[cat.value].selectedTokens.length === 0"
                :class="[
                  'px-4 py-1.5 rounded-lg transition-all duration-300 border flex items-center space-x-1',
                  providerStates[cat.value].selectedTokens.length === 0 ? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed' : 'bg-red-50 text-red-600 border-red-200 hover:bg-red-100'
                ]"
              >
                <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                  <path fill-rule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clip-rule="evenodd" />
                </svg>
                <span>{{ t('dash.deleteSelected', { n: providerStates[cat.value].selectedTokens.length }) }}</span>
              </button>
            </div>
          </div>

          <!-- 分页控制区（仅 qwen 支持） -->
          <div v-if="providerSupportsPagination(cat.value)" class="flex justify-between items-center mb-4">
            <div class="flex items-center space-x-2">
              <span class="text-gray-700">{{ t('dash.perPage') }}</span>
              <select v-model="providerStates[cat.value].pageSize" @change="changePageSize(cat.value)" class="rounded-lg border-gray-300 bg-white/50 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 transition-all duration-300">
                <option :value="10">10</option>
                <option :value="20">20</option>
                <option :value="50">50</option>
                <option :value="100">100</option>
                <option :value="200">200</option>
              </select>
            </div>
            <div class="flex space-x-2 items-center">
              <span class="text-gray-700">{{ t('dash.totalItems', { n: providerStates[cat.value].totalItems }) }}</span>
              <button
                @click="changePage(cat.value, providerStates[cat.value].currentPage - 1)"
                :disabled="providerStates[cat.value].currentPage === 1"
                :class="[
                  'px-3 py-1 rounded-lg transition-all duration-300',
                  providerStates[cat.value].currentPage === 1 ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-blue-50 text-blue-700 hover:bg-blue-100'
                ]"
              >
                {{ t('dash.prevPage') }}
              </button>
              <span class="text-gray-700">{{ providerStates[cat.value].currentPage }}/{{ totalPages(cat.value) }}</span>
              <button
                @click="changePage(cat.value, providerStates[cat.value].currentPage + 1)"
                :disabled="providerStates[cat.value].currentPage === totalPages(cat.value) || totalPages(cat.value) === 0"
                :class="[
                  'px-3 py-1 rounded-lg transition-all duration-300',
                  providerStates[cat.value].currentPage === totalPages(cat.value) || totalPages(cat.value) === 0 ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : 'bg-blue-50 text-blue-700 hover:bg-blue-100'
                ]"
              >
                {{ t('dash.nextPage') }}
              </button>
            </div>
          </div>

          <!-- Token列表 (一行3个账号卡片高密度栅格) -->
          <div class="max-h-[calc(75vh)] overflow-y-auto pr-2 scrollbar-hidden">
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 p-2">
              <div v-for="token in providerStates[cat.value].tokens"
                   :key="token.email"
                   class="token-card group relative overflow-hidden rounded-2xl transition-all duration-300 hover:shadow-2xl pt-4"
                   :class="[
                     { 'ring-2 ring-indigo-500 ring-opacity-75': isSelected(cat.value, token.email) }
                   ]">
                <div class="absolute top-3 left-3 z-10">
                  <label class="custom-checkbox cursor-pointer">
                    <input type="checkbox"
                           :checked="isSelected(cat.value, token.email)"
                           @change="toggleSelect(cat.value, token.email)"
                           class="sr-only peer">
                    <div class="checkbox-icon w-6 h-6 bg-white/70 backdrop-blur-sm border-2 border-gray-300 rounded-lg peer-checked:bg-indigo-500 peer-checked:border-indigo-500 transition-all duration-300 flex items-center justify-center shadow-sm hover:shadow">
                      <svg v-show="isSelected(cat.value, token.email)" class="w-4 h-4 text-white transform scale-0 peer-checked:scale-100 transition-transform duration-300" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12"></polyline>
                      </svg>
                    </div>
                  </label>
                </div>
                <div v-if="token.enabled === false" class="absolute top-3 right-3 z-10 flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded-full bg-red-50 border border-red-200 text-red-700">
                  <span class="inline-block w-2 h-2 rounded-full bg-red-500"></span>
                  <span>已停用</span>
                </div>
                <div v-else-if="providerSupportsStats(cat.value)" class="absolute top-3 right-3 z-10 flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700">
                  <span class="inline-block w-2 h-2 rounded-full bg-emerald-500"></span>
                  <span>正常可用</span>
                </div>
                <div class="absolute inset-0 bg-white/30 backdrop-blur-md border border-white/30"></div>
                <div class="relative p-5 flex flex-col gap-3.5" :class="{ 'opacity-85': token.enabled === false }">
                  <div class="flex flex-col space-y-2.5">
                    <div class="relative flex items-center bg-blue-50/80 rounded-lg px-2 py-1">
                      <div class="overflow-x-auto scrollbar-hide flex-1 flex items-center space-x-2">
                        <span class="text-gray-700 min-w-[72px] text-left font-semibold text-xs">📧 账号邮箱:</span>
                        <span class="font-medium whitespace-nowrap text-left text-xs">{{ token.email }}</span>
                      </div>
                      <button @click="copyToClipboard(token.email)" class="absolute right-2 opacity-0 hover:opacity-100 transition-opacity bg-blue-200 hover:bg-blue-300 rounded px-1.5 py-0.5 text-xs">📋</button>
                    </div>
                    <div class="relative flex items-center bg-blue-50/80 rounded-lg px-2 py-1">
                      <div class="overflow-x-auto scrollbar-hide flex-1 flex items-center space-x-2">
                        <span class="text-gray-700 min-w-[72px] text-left font-semibold text-xs">🔑 登录密码:</span>
                        <span class="font-medium whitespace-nowrap text-left text-xs">{{ token.password }}</span>
                      </div>
                      <button @click="copyToClipboard(token.password)" class="absolute right-2 opacity-0 hover:opacity-100 transition-opacity bg-blue-200 hover:bg-blue-300 rounded px-1.5 py-0.5 text-xs">📋</button>
                    </div>
                    <div class="relative flex items-center bg-blue-50/80 rounded-lg px-2 py-1">
                      <div class="overflow-x-auto scrollbar-hide flex-1 flex items-center space-x-2">
                        <span class="text-gray-700 min-w-[72px] text-left font-semibold text-xs">🔐 访问令牌:</span>
                        <span class="font-medium whitespace-nowrap text-left text-xs">{{ token.token }}</span>
                      </div>
                      <button @click="copyToClipboard(token.token)" class="absolute right-2 opacity-0 hover:opacity-100 transition-opacity bg-blue-200 hover:bg-blue-300 rounded px-1.5 py-0.5 text-xs">📋</button>
                    </div>
                    <div class="relative flex items-center bg-blue-50/80 rounded-lg px-2 py-1">
                      <div class="overflow-x-auto scrollbar-hide flex-1 flex items-center space-x-2">
                        <span class="text-gray-700 min-w-[72px] text-left font-semibold text-xs">⏰ 有效期限:</span>
                        <span class="font-medium whitespace-nowrap text-left text-xs" v-if="token.expires">{{ new Date(token.expires * 1000).toLocaleString() }}</span>
                        <span v-else class="font-medium whitespace-nowrap text-left text-gray-400 text-xs">—</span>
                      </div>
                      <button v-if="token.expires" @click="copyToClipboard(new Date(token.expires * 1000).toLocaleString())" class="absolute right-2 opacity-0 hover:opacity-100 transition-opacity bg-blue-200 hover:bg-blue-300 rounded px-1.5 py-0.5 text-xs">📋</button>
                    </div>
                    <div class="relative flex items-center bg-blue-50/80 rounded-lg px-2 py-1">
                      <div class="overflow-x-auto scrollbar-hide flex-1 flex items-center space-x-2">
                        <span class="text-gray-700 min-w-[72px] text-left font-semibold text-xs">🌐 独立代理:</span>
                        <span class="font-medium whitespace-nowrap text-left text-xs" :title="token.proxy || ''">{{ token.proxy || '—' }}</span>
                      </div>
                      <button v-if="token.proxy" @click="copyToClipboard(token.proxy)" class="absolute right-2 opacity-0 hover:opacity-100 transition-opacity bg-blue-200 hover:bg-blue-300 rounded px-1.5 py-0.5 text-xs">📋</button>
                    </div>
                  </div>

                  <div v-if="providerSupportsStats(cat.value)" class="bg-white/40 backdrop-blur-sm border border-white/40 rounded-xl px-3 py-2 text-xs space-y-1 transition-all">
                    <div class="flex items-baseline justify-between gap-2">
                      <span class="text-gray-600 font-semibold">{{ t('dash.acct.chatToday') }}:</span>
                      <span class="font-bold text-gray-800 font-mono">
                        <span :title="String(getAccountStats(cat.value, token.email).chat.input)">{{ formatCompact(getAccountStats(cat.value, token.email).chat.input) }}</span>
                        输入 /
                        <span :title="String(getAccountStats(cat.value, token.email).chat.output)">{{ formatCompact(getAccountStats(cat.value, token.email).chat.output) }}</span>
                        输出
                      </span>
                    </div>
                  </div>

                  <div class="pt-3 mt-auto border-t border-gray-200/50">
                    <div class="grid grid-cols-4 gap-1.5">
                      <!-- 停用/启用按钮 -->
                      <button @click="toggleAccount(cat.value, token)"
                              :class="[
                                'py-1.5 px-1 rounded-lg transition-all duration-300 text-xs font-bold text-center border',
                                token.enabled === false
                                  ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border-emerald-300'
                                  : 'bg-amber-50 text-amber-700 hover:bg-amber-100 border-amber-300'
                              ]"
                              :title="token.enabled === false ? '点击重新启用该账号' : '点击暂停调度该账号'">
                        {{ token.enabled === false ? '启用' : '停用' }}
                      </button>

                      <button v-if="providerSupportsProxy(cat.value)" @click="openEditProxy(cat.value, token)"
                              class="py-1.5 px-1 rounded-lg transition-all duration-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 border border-indigo-200 text-xs font-semibold text-center truncate">
                        {{ t('dash.editProxy') }}
                      </button>
                      <button @click="refreshToken(cat.value, token.email)"
                              :disabled="providerStates[cat.value].refreshingTokens.includes(token.email)"
                              :class="[
                                'py-1.5 px-1 rounded-lg transition-all duration-300 flex items-center justify-center gap-1 text-xs font-semibold text-center',
                                providerStates[cat.value].refreshingTokens.includes(token.email)
                                  ? 'bg-green-400 text-white refreshing-button-green cursor-not-allowed'
                                  : 'macaron-green-button text-green-600 hover:bg-green-100 border border-green-200'
                              ]">
                        <span v-if="providerStates[cat.value].refreshingTokens.includes(token.email)" class="flex items-center gap-1">
                          <svg class="animate-spin h-3 w-3" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                            <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                            <path class="opacity-75" fill="currentColor" d="m4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                          </svg>
                        </span>
                        <span v-else>{{ t('dash.refreshToken') }}</span>
                      </button>
                      <button @click="deleteToken(cat.value, token.email)"
                              class="py-1.5 px-1 rounded-lg border border-red-200 text-red-600 group-hover:bg-red-50 transition-all duration-300 hover:bg-red-100 text-xs font-semibold text-center">
                        {{ t('dash.deleteAccount') }}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 删除全部确认对话框 -->
    <div v-if="showDeleteAllConfirm"
         class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
         @click.self="showDeleteAllConfirm = false">
      <div class="relative bg-white/90 backdrop-blur-lg rounded-2xl p-6 w-11/12 max-w-md transform transition-all duration-300 scale-100 opacity-100">
        <h2 class="text-2xl font-bold text-red-600 mb-4">{{ t('dash.dangerTitle') }}</h2>
        <p class="text-gray-700 mb-6">{{ t('dash.dangerText', { n: providerStates[deleteAllProvider].totalItems }) }}</p>
        <div class="flex justify-end space-x-4">
          <button @click="showDeleteAllConfirm = false"
                  class="px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 transition-all duration-300">
            {{ t('dash.cancel') }}
          </button>
          <button @click="deleteAllAccounts"
                  class="px-4 py-2 rounded-xl bg-red-600 text-white hover:bg-red-700 transition-all duration-300">
            {{ t('dash.confirmDelete') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 添加账号模态框 -->
    <div v-if="showAddModal"
         class="fixed inset-0 z-50 overflow-y-auto bg-black/60 px-4 py-6 backdrop-blur-sm"
          @click.self="closeAddModal">
      <div :class="[
            'relative mx-auto flex max-h-[calc(100vh-3rem)] w-full flex-col overflow-hidden rounded-2xl bg-white/80 p-6 backdrop-blur-lg transform transition-all duration-300 scale-100 opacity-100',
            addMode === 'batch' ? 'max-w-3xl' : 'max-w-md'
          ]">
        <div class="mb-6 flex shrink-0 border-b border-gray-200">
          <button :class="['flex-1 py-2 font-bold transition-all rounded-t-xl duration-300', addMode==='single' ? 'text-gray-600 border-b-2 border-gray-500 bg-gray-50/60' : 'text-gray-500 bg-transparent', isBatchAdding ? 'opacity-50 cursor-not-allowed' : '']" @click="!isBatchAdding && (addMode='single')">{{ t('dash.singleAdd') }}</button>
          <button v-if="providerSupportsBatch(modalProvider)" :class="['flex-1 py-2 font-bold transition-all rounded-t-xl duration-300', addMode==='batch' ? 'text-gray-600 border-b-2 border-gray-500 bg-gray-50/60' : 'text-gray-500 bg-transparent', isBatchAdding ? 'opacity-50 cursor-not-allowed' : '']" @click="!isBatchAdding && (addMode='batch')">{{ t('dash.batchAdd') }}</button>
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
              <div v-if="providerSupportsProxy(modalProvider)">
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
                <button @click="closeAddModal"
                        class="px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 transition-all duration-300">
                  {{ t('dash.cancel') }}
                </button>
                <button @click="addToken"
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
                <button @click="closeAddModal"
                        class="px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 transition-all duration-300 disabled:opacity-50">
                  {{ isBatchAdding ? t('dash.continueBackground') : t('dash.close') }}
                </button>
                <button @click="addBatchTokens"
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

    <!-- 修改代理模态框 -->
    <div v-if="showEditProxyModal"
         class="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
         @click.self="closeEditProxyModal">
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
            <button @click="closeEditProxyModal"
                    :disabled="isSavingProxy"
                    class="px-4 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 transition-all duration-300 disabled:opacity-50">
              {{ t('dash.cancel') }}
            </button>
            <button @click="clearProxy"
                    :disabled="isSavingProxy"
                    class="px-4 py-2 rounded-xl bg-amber-50 text-amber-700 border border-amber-200 hover:bg-amber-100 transition-all duration-300 disabled:opacity-50">
              {{ t('dash.clearProxy') }}
            </button>
            <button @click="saveProxy"
                    :disabled="isSavingProxy || !editProxyValid"
                    class="px-4 py-2 rounded-xl bg-black text-white hover:bg-white hover:text-black border border-black transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed">
              {{ t('dash.save') }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Toast 通知 -->
    <ToastNotification :toast="toast" />
  </div>
</template>

<script setup>
import { ref, reactive, onMounted, onBeforeUnmount, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import axios from 'axios'
import LangSwitcher from '../components/LangSwitcher.vue'
import TelemetryCockpit from '../components/TelemetryCockpit.vue'
import ToastNotification from '../components/ToastNotification.vue'
import { formatCompact as _formatCompact } from '../utils/format.js'
import { getAuthHeaders } from '../utils/auth.js'
import { useToast } from '../composables/useToast.js'
import { getApiEndpoints, providerSupportsProxy, providerSupportsBatch, providerSupportsStats, providerSupportsPagination } from '../utils/provider-endpoints.js'
import { useAccountStats } from '../composables/useAccountStats.js'

const { toast, showToast } = useToast()

const { t } = useI18n()

// 两大类固定顺序：DeepSeek → Qwen（从上到下分类呈现）
const categories = [
  { value: 'dpsk', labelKey: 'dash.categoryDeepseek', color: 'emerald' },
  { value: 'qwen', labelKey: 'dash.categoryQwen',     color: 'indigo' },
]

// 各大类标题颜色辅助函数
const categoryTextClass = (p) => {
  if (p === 'dpsk') return 'text-emerald-600'
  return 'text-indigo-600'
}
const categoryBorderClass = (p) => {
  if (p === 'dpsk') return 'border-emerald-200'
  return 'border-indigo-200'
}

// 折叠状态持久化到 localStorage
const COLLAPSE_KEY = 'z-free-api-dashboard-collapse'
const collapsed = ref({ dpsk: false, qwen: false })
try {
  const saved = JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}')
  collapsed.value = { dpsk: !!saved.dpsk, qwen: !!saved.qwen }
} catch (_) { /* 忽略解析错误 */ }
const toggleCategoryCollapse = (provider) => {
  collapsed.value[provider] = !collapsed.value[provider]
  localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed.value))
}

// 每个 provider 独立的状态对象（账号列表、分页、多选、刷新等）
const createProviderState = () => ({
  tokens: [],
  currentPage: 1,
  pageSize: 10,
  totalItems: 0,
  selectedTokens: [],
  selectAll: false,
  isRefreshingAll: false,
  isForceRefreshingAll: false,
  refreshingTokens: [],
})
const providerStates = reactive({
  dpsk: createProviderState(),
  qwen: createProviderState(),
})

// 模态框状态
const showAddModal = ref(false)
const addMode = ref('single')
const modalProvider = ref('qwen')  // 当前模态框作用的 provider
const newAccount = ref({
  email: '',
  password: '',
  proxy: ''
})
const showEditProxyModal = ref(false)
const editProxy = ref({ email: '', proxy: '', provider: 'qwen' })
const isSavingProxy = ref(false)
const showDeleteAllConfirm = ref(false)
const deleteAllProvider = ref('qwen')  // 删除全部确认框作用的 provider

// 与后端 src/utils/proxy-helper.js#PROXY_URL_REGEX 保持一致
const PROXY_URL_REGEX = /^(https?|socks5):\/\/[^\s]+$/i
const isValidProxy = (value) => {
  if (!value) return true
  const trimmed = String(value).trim()
  if (!trimmed) return true
  return PROXY_URL_REGEX.test(trimmed)
}
const newAccountProxyValid = computed(() => isValidProxy(newAccount.value.proxy))
const editProxyValid = computed(() => isValidProxy(editProxy.value.proxy))

const batchAccounts = ref('')
const isBatchAdding = ref(false)
const batchTask = ref(null)
const batchTaskPollTimer = ref(null)
const batchTaskNotified = ref(false)

// Per-account stats — 由 useAccountStats composable 统一管理
const {
  accountStats,
  DEFAULT_STATS,
  getAccountStats,
  getStatusKind,
  getStatusEmoji,
  isOnCooldown,
  getCountdown,
  getStatusTooltip,
  init: initStats,
  destroy: destroyStats,
} = useAccountStats()

// Compact number formatting (Qwen2API-j7x): 415575 → '415k', 1500 → '1.5k', 1500000 → '1.5M'.
// Implementation moved to ../utils/format.js (shared with /statistics).
const formatCompact = (n) => _formatCompact(n, { unitK: t('dash.acct.unitK'), unitM: t('dash.acct.unitM') })

const batchTaskStatusText = computed(() => {
  const status = batchTask.value?.status
  if (status === 'completed') return t('dash.statusCompleted')
  if (status === 'failed') return t('dash.statusFailed')
  if (status === 'running') return t('dash.statusRunning')
  if (status === 'pending') return t('dash.statusPending')
  return t('dash.statusNotStarted')
})
const batchTaskStatusClass = computed(() => {
  const status = batchTask.value?.status
  if (status === 'completed') return 'bg-emerald-100 text-emerald-700'
  if (status === 'failed') return 'bg-rose-100 text-rose-700'
  if (status === 'running') return 'bg-sky-100 text-sky-700'
  if (status === 'pending') return 'bg-amber-100 text-amber-700'
  return 'bg-slate-100 text-slate-700'
})
const batchTaskProgressStyle = computed(() => ({
  width: `${Math.max(0, Math.min(100, Number(batchTask.value?.progress || 0)))}%`
}))

const clearBatchTaskPolling = () => {
  if (batchTaskPollTimer.value) {
    clearTimeout(batchTaskPollTimer.value)
    batchTaskPollTimer.value = null
  }
}

const resetBatchTaskState = (clearInput = false) => {
  clearBatchTaskPolling()
  batchTask.value = null
  batchTaskNotified.value = false
  isBatchAdding.value = false

  if (clearInput) {
    batchAccounts.value = ''
  }
}

const buildBatchTaskMessage = (task) => {
  let message = t('msg.batchComplete', { n: task.success })
  if (task.failed > 0) message += ', ' + t('msg.batchFailed', { n: task.failed })
  if (task.skipped > 0) message += ', ' + t('msg.batchSkipped', { n: task.skipped })
  if (task.invalid > 0) message += ', ' + t('msg.batchInvalid', { n: task.invalid })
  if (task.failedEmails?.length > 0) {
    message += '\n' + t('msg.failedAccounts') + ' ' + task.failedEmails.slice(0, 10).join(', ')
  }
  return message
}

const finalizeBatchTask = async (task) => {
  clearBatchTaskPolling()
  batchTask.value = task
  isBatchAdding.value = false

  if (task.success > 0) {
    await getTokens('qwen')
  }

  if (!batchTaskNotified.value) {
    batchTaskNotified.value = true
    showToast(
      buildBatchTaskMessage(task),
      task.failed > 0 || task.invalid > 0 ? 'warning' : 'success'
    )
  }
}

const pollBatchTask = async (taskId) => {
  clearBatchTaskPolling()

  try {
    const res = await axios.get(`/api/batchTasks/${taskId}`, {
      headers: getAuthHeaders()
    })

    batchTask.value = res.data

    if (res.data.status === 'completed' || res.data.status === 'failed') {
      await finalizeBatchTask(res.data)
      return
    }

    batchTaskPollTimer.value = setTimeout(() => {
      pollBatchTask(taskId)
    }, 800)
  } catch (error) {
    console.error('pollBatchTask error:', error)

    if (batchTask.value) {
      batchTask.value = {
        ...batchTask.value,
        message: t('msg.progressRetry')
      }
    }

    batchTaskPollTimer.value = setTimeout(() => {
      pollBatchTask(taskId)
    }, 1500)
  }
}

const closeAddModal = () => {
  showAddModal.value = false

  if (!isBatchAdding.value && addMode.value === 'batch' && batchTask.value?.status === 'completed') {
    resetBatchTaskState(batchTask.value.failed === 0 && batchTask.value.invalid === 0)
  }
}

// 打开添加账号模态框，绑定到指定 provider
const openAddModal = (p) => {
  modalProvider.value = p
  addMode.value = 'single'
  showAddModal.value = true
}

const isSelected = (p, email) => {
  return providerStates[p].selectedTokens.includes(email)
}

const toggleSelect = (p, email) => {
  const state = providerStates[p]
  const index = state.selectedTokens.indexOf(email)
  if (index === -1) {
    state.selectedTokens.push(email)
  } else {
    state.selectedTokens.splice(index, 1)
  }
  state.selectAll = state.selectedTokens.length === state.tokens.length
}

const toggleSelectAll = (p) => {
  const state = providerStates[p]
  if (state.selectAll) {
    state.selectedTokens = state.tokens.map(token => token.email)
  } else {
    state.selectedTokens = []
  }
}

const deleteSelected = async (p) => {
  const state = providerStates[p]
  if (state.selectedTokens.length === 0) return

  if (!confirm(t('msg.deleteConfirm', { n: state.selectedTokens.length }))) return

  try {
    const endpoints = getApiEndpoints(p)
    const deletePromises = state.selectedTokens.map(email =>
      axios.delete(endpoints.delete, {
        data: { email },
        headers: getAuthHeaders()
      })
    )

    await Promise.all(deletePromises)
    await getTokens(p)
    state.selectedTokens = []
    state.selectAll = false
    showToast(t('msg.deleteSuccess'))
  } catch (error) {
    console.error('deleteSelected error:', error)
    showToast(t('msg.deleteFailed') + error.message, 'error')
  }
}

// 打开删除全部确认框，绑定到指定 provider
const confirmDeleteAll = (p) => {
  deleteAllProvider.value = p
  showDeleteAllConfirm.value = true
}

const deleteAllAccounts = async () => {
  const p = deleteAllProvider.value
  const state = providerStates[p]
  try {
    const endpoints = getApiEndpoints(p)
    // For dpsk, delete all accounts one by one (no bulk delete endpoint)
    if (!endpoints.supportsBatch) {
      for (const token of state.tokens) {
        await axios.delete(endpoints.deleteAll, { data: { email: token.email }, headers: getAuthHeaders() })
      }
    } else {
      await axios.delete(endpoints.deleteAll, { headers: getAuthHeaders() })
    }

    showDeleteAllConfirm.value = false
    state.currentPage = 1
    await getTokens(p)
    state.selectedTokens = []
    state.selectAll = false
    showToast(t('msg.allDeleted'))
  } catch (error) {
    console.error('deleteAllAccounts error:', error)
    showToast(t('msg.allDeleteFailed') + error.message, 'error')
  }
}

const totalPages = (p) => {
  const state = providerStates[p]
  return Math.max(1, Math.ceil(state.totalItems / state.pageSize))
}

const changePage = async (p, page) => {
  const state = providerStates[p]
  const tp = totalPages(p)
  if (page >= 1 && page <= tp) {
    state.currentPage = page
    state.selectedTokens = []
    state.selectAll = false
    await getTokens(p)
  }
}

const changePageSize = async (p) => {
  const state = providerStates[p]
  state.currentPage = 1
  state.selectedTokens = []
  state.selectAll = false
  await getTokens(p)
}

const copyToClipboard = async (text) => {
  try {
    await navigator.clipboard.writeText(text)
    showToast(t('dash.copiedToClipboard'))
  } catch (err) {
    console.error('copyToClipboard error:', err)
    showToast(t('msg.copyFailed'), 'error')
  }
}

// 获取指定 provider 的账号列表
const getTokens = async (p) => {
  const state = providerStates[p]
  const endpoints = getApiEndpoints(p)
  try {
    if (endpoints.supportsPagination) {
      const res = await axios.get(endpoints.list, {
        params: {
          page: state.currentPage,
          pageSize: state.pageSize
        },
        headers: getAuthHeaders()
      })
      state.tokens = res.data.data
      state.totalItems = res.data.total
    } else {
      // dpsk: 一次性返回全部，前端不分页
      const res = await axios.get(endpoints.list, {
        headers: getAuthHeaders()
      })
      state.tokens = res.data.data || []
      state.totalItems = state.tokens.length
    }

    if (state.currentPage > totalPages(p) && totalPages(p) > 0) {
      state.currentPage = 1
      await getTokens(p)
      return
    }

    state.selectedTokens = []
    state.selectAll = false

  } catch (error) {
    console.error(`getTokens(${p}) error:`, error)
    showToast(t('msg.fetchFailed') + error.message, 'error')
  }
}

// 获取所有 provider 的账号列表
const getAllTokens = async () => {
  await Promise.all(categories.map(c => getTokens(c.value)))
}

const addToken = async () => {
  const p = modalProvider.value
  try {
    const endpoints = getApiEndpoints(p)
    const payload = {
      email: newAccount.value.email,
      password: newAccount.value.password,
      proxy: endpoints.supportsProxy ? (newAccount.value.proxy?.trim() || null) : null
    }
    await axios.post(endpoints.create, payload, {
      headers: getAuthHeaders()
    })
    closeAddModal()
    newAccount.value = { email: '', password: '', proxy: '' }
    await getTokens(p)
    showToast(t('msg.addSuccess'))
  } catch (error) {
    console.error('addToken error:', error)
    showToast(t('msg.addFailed') + error.message, 'error')
  }
}

const openEditProxy = (p, token) => {
  editProxy.value = { email: token.email, proxy: token.proxy || '', provider: p }
  showEditProxyModal.value = true
}

const closeEditProxyModal = () => {
  if (isSavingProxy.value) return
  showEditProxyModal.value = false
}

const clearProxy = () => {
  editProxy.value.proxy = ''
}

const saveProxy = async () => {
  if (isSavingProxy.value) return
  const p = editProxy.value.provider
  const endpoints = getApiEndpoints(p)
  if (!endpoints.supportsProxy) {
    showToast(t('dash.proxyUnsupported', { provider: p.toUpperCase() }), 'warning')
    return
  }
  isSavingProxy.value = true
  try {
    await axios.post('/api/updateAccountProxy', {
      email: editProxy.value.email,
      proxy: editProxy.value.proxy.trim() || null
    }, {
      headers: getAuthHeaders()
    })
    showEditProxyModal.value = false
    await getTokens(p)
    showToast(t('msg.proxyUpdateSuccess'))
  } catch (error) {
    console.error('saveProxy error:', error)
    showToast(t('msg.proxyUpdateFailed') + error.message, 'error')
  } finally {
    isSavingProxy.value = false
  }
}

const addBatchTokens = async () => {
  if (isBatchAdding.value) return
  if (!batchAccounts.value.trim()) {
    showToast(t('msg.enterAccounts'), 'error')
    return
  }

  batchTaskNotified.value = false
  clearBatchTaskPolling()
  isBatchAdding.value = true

  try {
    const res = await axios.post('/api/setAccounts', {
      accounts: batchAccounts.value,
      async: true
    }, {
      headers: getAuthHeaders()
    })

    batchTask.value = res.data
    addMode.value = 'batch'
    showAddModal.value = true

    if (res.data.status === 'completed' || res.data.status === 'failed') {
      await finalizeBatchTask(res.data)
      return
    }

    pollBatchTask(res.data.taskId)
  } catch (error) {
    console.error('addBatchTokens error:', error)
    showToast(t('msg.batchAddFailed') + error.message, 'error')
    isBatchAdding.value = false
  }
}

const refreshToken = async (p, email) => {
  const state = providerStates[p]
  if (state.refreshingTokens.includes(email)) return

  state.refreshingTokens.push(email)

  try {
    const endpoints = getApiEndpoints(p)
    await axios.post(endpoints.refresh, { email }, {
      headers: getAuthHeaders()
    })

    await getTokens(p)
    showToast(t('msg.refreshSuccess', { email }))
  } catch (error) {
    console.error('refreshToken error:', error)
    showToast(t('msg.refreshFailed') + error.message, 'error')
  } finally {
    const index = state.refreshingTokens.indexOf(email)
    if (index > -1) {
      state.refreshingTokens.splice(index, 1)
    }
  }
}

const refreshAllAccounts = async (p) => {
  const state = providerStates[p]
  if (state.isRefreshingAll) return

  if (!confirm(t('msg.refreshAllConfirm'))) return

  state.isRefreshingAll = true

  try {
    const endpoints = getApiEndpoints(p)
    const payload = endpoints.supportsPagination ? { thresholdHours: 24 } : {}
    const response = await axios.post(endpoints.refreshAll, payload, {
      headers: getAuthHeaders()
    })

    await getTokens(p)
    showToast(t('msg.refreshAllComplete', { n: response.data?.refreshedCount || 0 }))
  } catch (error) {
    console.error('refreshAllAccounts error:', error)
    showToast(t('msg.refreshAllFailed') + error.message, 'error')
  } finally {
    state.isRefreshingAll = false
  }
}

const forceRefreshAllAccounts = async (p) => {
  const state = providerStates[p]
  if (state.isForceRefreshingAll) return

  if (!confirm(t('msg.forceRefreshAllConfirm'))) return

  state.isForceRefreshingAll = true

  try {
    const endpoints = getApiEndpoints(p)
    const response = await axios.post(endpoints.forceRefresh, {}, {
      headers: getAuthHeaders()
    })

    await getTokens(p)
    showToast(t('msg.forceRefreshAllComplete', { n: response.data?.refreshedCount || 0 }))
  } catch (error) {
    console.error('forceRefreshAllAccounts error:', error)
    showToast(t('msg.forceRefreshAllFailed') + error.message, 'error')
  } finally {
    state.isForceRefreshingAll = false
  }
}

const deleteToken = async (p, email) => {
  if (!confirm(t('msg.deleteAccountConfirm'))) return

  try {
    const endpoints = getApiEndpoints(p)
    await axios.delete(endpoints.delete, {
      data: { email },
      headers: getAuthHeaders()
    })
    await getTokens(p)
    showToast(t('msg.deleteAccountSuccess'))
  } catch (error) {
    console.error('deleteToken error:', error)
    showToast(t('msg.deleteAccountFailed') + error.message, 'error')
  }
}

// 切换账号停用/启用状态
const toggleAccount = async (p, token) => {
  const email = token.email
  const currentEnabled = token.enabled !== false
  const targetEnabled = !currentEnabled
  const actionText = targetEnabled ? t('dash.enableAccount') : t('dash.disableAccount')
  
  if (!token._toggling) {
    token._toggling = true
  }

  try {
    const endpoints = getApiEndpoints(p)
    const res = await axios.post(endpoints.toggle, {
      email,
      enabled: targetEnabled
    }, {
      headers: getAuthHeaders()
    })

    token.enabled = targetEnabled
    showToast(`账号 ${email} 已成功${actionText}`, 'success')
    await getTokens(p)
  } catch (error) {
    console.error('toggleAccount error:', error)
    showToast(`账号${actionText}失败: ` + (error.response?.data?.error || error.message), 'error')
  } finally {
    token._toggling = false
  }
}

const exportAccounts = async (p) => {
  try {
    const endpoints = getApiEndpoints(p)
    let allAccounts = []
    if (endpoints.supportsPagination) {
      const res = await axios.get(endpoints.list, {
        params: { page: 1, pageSize: 10000 },
        headers: getAuthHeaders()
      })
      allAccounts = res.data.data
    } else {
      const res = await axios.get(endpoints.list, {
        headers: getAuthHeaders()
      })
      allAccounts = res.data.data || []
    }

    if (allAccounts.length === 0) {
      showToast(t('msg.exportEmpty'), 'error')
      return
    }

    const content = allAccounts.map(token => `${token.email}:${token.password}`).join('\n')

    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })

    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    const suffix = p === 'dpsk' ? 'dpsk' : 'qwen'
    link.download = `${suffix}_accounts.txt`
    document.body.appendChild(link)
    link.click()

    setTimeout(() => {
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    }, 100)

    showToast(t('msg.exportSuccess'))
  } catch (error) {
    console.error('exportAccounts error:', error)
    showToast(t('msg.exportFailed') + error.message, 'error')
  }
}

onMounted(() => {
  getAllTokens()
  initStats()
})

onBeforeUnmount(() => {
  clearBatchTaskPolling()
  destroyStats()
})
</script>

<style lang="css" scoped>
@media (max-width: 640px) {
  .container {
    padding: 0;
  }
}

.dashboard-scroll {
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.38) rgba(255, 255, 255, 0.08);
}

.modal-scroll {
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.32) rgba(255, 255, 255, 0.06);
}

.dashboard-scroll::-webkit-scrollbar {
  width: 8px;
}

.modal-scroll::-webkit-scrollbar {
  width: 6px;
}

.dashboard-scroll::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.06);
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.04);
}

.modal-scroll::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 999px;
}

.dashboard-scroll::-webkit-scrollbar-thumb {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.42), rgba(255, 255, 255, 0.2));
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.28);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.24), 0 2px 10px rgba(15, 23, 42, 0.12);
  background-clip: padding-box;
}

.modal-scroll::-webkit-scrollbar-thumb {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.34), rgba(255, 255, 255, 0.18));
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.18);
}

.dashboard-scroll::-webkit-scrollbar-thumb:hover {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.56), rgba(255, 255, 255, 0.28));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.28), 0 4px 14px rgba(15, 23, 42, 0.16);
}

.modal-scroll::-webkit-scrollbar-thumb:hover {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.46), rgba(255, 255, 255, 0.24));
}

.dashboard-scroll::-webkit-scrollbar-thumb:active {
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.62), rgba(255, 255, 255, 0.34));
}

.dashboard-scroll::-webkit-scrollbar-corner {
  background: transparent;
}

.fade-enter-active, .fade-leave-active {
  transition: opacity 0.3s, transform 0.3s;
}
.fade-enter-from, .fade-leave-to {
  opacity: 0;
  transform: translateY(10px);
}
.fade-enter-to, .fade-leave-from {
  opacity: 1;
  transform: translateY(0);
}

.token-card {
  background: linear-gradient(135deg, rgba(255, 255, 255, 0.7), rgba(255, 255, 255, 0.3));
  box-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.15);
  transform: translateY(0);
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.token-card:hover {
  transform: translateY(-5px);
}

.scrollbar-hide {
  -ms-overflow-style: none;
  scrollbar-width: none;
}

.scrollbar-hide::-webkit-scrollbar {
  display: none;
}

@keyframes slideIn {
  from {
    transform: translateY(20px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.token-card {
  animation: slideIn 0.5s ease-out;
  animation-fill-mode: both;
}

.token-card:nth-child(3n+1) { animation-delay: 0.1s; }
.token-card:nth-child(3n+2) { animation-delay: 0.2s; }
.token-card:nth-child(3n+3) { animation-delay: 0.3s; }

.overflow-x-auto {
  position: relative;
  cursor: pointer;
}

.overflow-x-auto::after {
  content: '';
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  width: 24px;
  background: linear-gradient(to right, transparent, rgba(255, 255, 255, 0.8));
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.3s;
}

.overflow-x-auto:hover::after {
  opacity: 1;
}

/* 隐藏滚动条样式 */
.scrollbar-hidden {
  -ms-overflow-style: none;  /* IE and Edge */
  scrollbar-width: none;  /* Firefox */
}

.scrollbar-hidden::-webkit-scrollbar {
  display: none;  /* Chrome, Safari and Opera */
}

/* 自定义滚动条样式（备用） */
.max-h-\[calc\(100vh-200px\)\]::-webkit-scrollbar {
  width: 6px;
}

.max-h-\[calc\(100vh-200px\)\]::-webkit-scrollbar-track {
  background: rgba(0, 0, 0, 0.05);
  border-radius: 8px;
}

.max-h-\[calc\(100vh-200px\)\]::-webkit-scrollbar-thumb {
  background-color: rgba(0, 0, 0, 0.1);
  border-radius: 8px;
}

.max-h-\[calc\(100vh-200px\)\]::-webkit-scrollbar-thumb:hover {
  background-color: rgba(0, 0, 0, 0.2);
}

/* 自定义复选框样式 */
.custom-checkbox .checkbox-icon {
  position: relative;
  overflow: hidden;
}

.custom-checkbox .checkbox-icon:before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 0;
  height: 100%;
  background: rgba(99, 102, 241, 0.1);
  transition: width 0.3s ease;
}

.custom-checkbox:hover .checkbox-icon:before {
  width: 100%;
}

.custom-checkbox input:checked + .checkbox-icon svg {
  animation: check-animation 0.5s cubic-bezier(0.17, 0.67, 0.83, 0.67);
  transform: scale(1);
}

@keyframes check-animation {
  0% {
    transform: scale(0);
  }
  50% {
    transform: scale(1.2);
  }
  100% {
    transform: scale(1);
  }
}

/* 给选中的卡片添加动画效果 */
.token-card.ring-2 {
  animation: selected-pulse 2s infinite;
}

@keyframes selected-pulse {
  0% {
    box-shadow: 0 0 0 0 rgba(99, 102, 241, 0.4);
  }
  70% {
    box-shadow: 0 0 0 6px rgba(99, 102, 241, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(99, 102, 241, 0);
  }
}

/* 马卡龙紫色刷新按钮动画 */
@keyframes refresh-pulse-purple {
  0% {
    box-shadow: 0 0 0 0 rgba(168, 85, 247, 0.4);
  }
  70% {
    box-shadow: 0 0 0 6px rgba(168, 85, 247, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(168, 85, 247, 0);
  }
}

/* 马卡龙绿色刷新按钮动画 */
@keyframes refresh-pulse-green {
  0% {
    box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.4);
  }
  70% {
    box-shadow: 0 0 0 6px rgba(74, 222, 128, 0);
  }
  100% {
    box-shadow: 0 0 0 6px rgba(74, 222, 128, 0);
  }
}

/* 马卡龙粉色刷新按钮动画 */
@keyframes refresh-pulse-pink {
  0% {
    box-shadow: 0 0 0 0 rgba(236, 72, 153, 0.4);
  }
  70% {
    box-shadow: 0 0 0 6px rgba(236, 72, 153, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(236, 72, 153, 0);
  }
}

.action-button:hover {
  animation: refresh-pulse-purple 1.5s infinite;
}

/* 刷新中的按钮样式 - 马卡龙紫色 */
.refreshing-button-purple {
  background: linear-gradient(45deg, #c084fc, #a855f7);
  color: white;
  animation: refresh-pulse-purple 1.5s infinite;
  box-shadow: 0 4px 15px rgba(168, 85, 247, 0.3);
}

/* 刷新中的按钮样式 - 马卡龙绿色 */
.refreshing-button-green {
  background: linear-gradient(45deg, #86efac, #4ade80);
  color: white;
  animation: refresh-pulse-green 1.5s infinite;
  box-shadow: 0 4px 15px rgba(74, 222, 128, 0.3);
}

/* 刷新中的按钮样式 - 马卡龙粉色 */
.refreshing-button-pink {
  background: linear-gradient(45deg, #f472b6, #ec4899);
  color: white;
  animation: refresh-pulse-pink 1.5s infinite;
  box-shadow: 0 4px 15px rgba(236, 72, 153, 0.3);
}

/* 马卡龙色系按钮增强效果 */
.action-button {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  backdrop-filter: blur(10px);
}

.action-button:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
}

.dashboard-page { position: relative; z-index: 1; color: #1c2a44; }.dashboard-shell { max-width: 1440px; padding: 1.75rem clamp(1rem, 3vw, 3rem) 3rem; }.dashboard-topbar h1 { letter-spacing: -.055em; text-wrap: balance; }.dashboard-page .action-button { border-color: rgba(111,124,197,.18); background: rgba(255,255,255,.58); color: #36456b; box-shadow: 0 12px 28px rgba(61,77,135,.10), inset 0 1px rgba(255,255,255,.8); }.dashboard-page .action-button:hover { animation: none; transform: translateY(-2px); background: rgba(255,255,255,.82); box-shadow: 0 17px 32px rgba(61,77,135,.16); }.dashboard-page .token-card { border: 1px solid rgba(255,255,255,.85); border-radius: 20px; background: rgba(255,255,255,.48); backdrop-filter: blur(28px) saturate(190%); -webkit-backdrop-filter: blur(28px) saturate(190%); box-shadow: 0 16px 36px rgba(31,38,135,.07), inset 0 1px 1px rgba(255,255,255,.95); transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1); }.dashboard-page .token-card:hover { transform: translateY(-4px) scale(1.008); box-shadow: 0 20px 42px rgba(31,38,135,.13), inset 0 1px 1px rgba(255,255,255,1); border-color: rgba(99,102,241,.35); }.dashboard-page .token-card > .absolute.inset-0 { background: rgba(255,255,255,.15); border-color: rgba(255,255,255,.64); }.dashboard-page .token-card .bg-blue-50\/80 { background: rgba(239,244,255,.58); }.dashboard-page .category-divider { border-color: rgba(255,255,255,.66); }@media (max-width: 640px) { .dashboard-shell { padding: 1rem .75rem 2rem; }.dashboard-page .dashboard-topbar { padding: 0 .25rem; } }
</style>
