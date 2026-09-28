const { generateUUID } = require('../utils/tools.js')
const { isChatType, isThinkingEnabled, parserMessages } = require('../backends/qwen/message-enricher.js')
const { resolveQwenModel } = require('../backends/qwen/model-resolver.js')
const { buildToolSystemPrompt, buildHermesToolSystemPrompt, buildToolFormatReminder, foldToolMessagesForChatBackend, buildQwenFirstMessageWarning } = require('../utils/tool-prompt.js')
const accountManager = require('../utils/account.js')
const { pickAccountWithSticky } = require('../backends/qwen/request.js')
const { logger } = require('../utils/logger')
const {
  createChatLatencyTracker,
  markLatency,
  setLatencyFields,
  messageStats
} = require('../utils/chat-latency-monitor.js')
const { createLifecycleRecorder } = require('../backends/qwen/lifecycle.js')

/**
 * 处理聊天请求体的中间件
 * 解析和转换请求参数为内部格式
 *
 * Account consistency: pick the account before parserMessages uploads images,
 * then reuse it in sendChatRequest. This keeps uploaded resources and the final
 * Qwen request on the same account whenever possible.
 */
const processRequestBody = async (req, res, next) => {
  try {
    req.chatLatency = req.chatLatency || createChatLatencyTracker({
      protocol: 'openai',
      route: '/v1/chat/completions',
      profile: req.clientProfile?.name,
      stream: !!req.body?.stream
    })
    // Lifecycle recorder：跟踪 12 个生命周期事件（middleware 负责 6 个，stream handler 负责 6 个）
    // 确保 req.id 在 lifecycle recorder 创建前已设置（controller 稍后会复用此 id）
    if (!req.id) req.id = generateUUID()
    if (!req.lifecycleRecorder) {
      req.lifecycleRecorder = createLifecycleRecorder(req.id, {
        model: req.body?.model,
        stream: req.body?.stream,
        messageCount: Array.isArray(req.body?.messages) ? req.body.messages.length : 0
      })
      req.lifecycleRecorder.record('request_accepted')
      req.lifecycleRecorder.record('body_parsed')
    }
    // 实验：per-account client profile header 覆盖
    // 通过 X-Qwen-Profile-* 请求头注入不同设备指纹/语言/时区
    // 不设置时不改变任何行为
    if (req.headers['x-qwen-profile-ua'] || req.headers['x-qwen-profile-timezone'] || req.headers['x-qwen-profile-accept-language']) {
      req.qwenProfileOverride = {}
      if (req.headers['x-qwen-profile-ua']) {
        req.qwenProfileOverride.userAgent = req.headers['x-qwen-profile-ua']
      }
      if (req.headers['x-qwen-profile-sec-ch-ua']) {
        req.qwenProfileOverride.secChUa = req.headers['x-qwen-profile-sec-ch-ua']
      }
      if (req.headers['x-qwen-profile-sec-ch-ua-platform']) {
        req.qwenProfileOverride.secChUaPlatform = req.headers['x-qwen-profile-sec-ch-ua-platform']
      }
      if (req.headers['x-qwen-profile-accept-language']) {
        req.qwenProfileOverride.acceptLanguage = req.headers['x-qwen-profile-accept-language']
      }
      if (req.headers['x-qwen-profile-timezone']) {
        req.qwenProfileOverride.timezone = req.headers['x-qwen-profile-timezone']
      }
    }
    // 路由快照：仅保存路由所需字段，避免完整 body 深拷贝（500K 上下文下 ~1.5MB 额外分配）
    const _messages = req.body?.messages
    req.routeSnapshot = {
      model: req.body?.model,
      stream: req.body?.stream !== false,
      hasTools: !!(req.body?.tools && req.body.tools.length > 0),
      toolChoice: req.body?.tool_choice || null,
      messageCount: Array.isArray(_messages) ? _messages.length : 0,
      estimatedBytes: typeof req.body === 'object' ? Buffer.byteLength(JSON.stringify(req.body)) : 0
    }
    req.originalBody = req.body

    // 构建请求体
    const body = {
      "stream": true,
      "version": "2.1",
      "incremental_output": true,
      "chat_type": "t2t",
      "model": null,
      "messages": [],
      "session_id": generateUUID(),
      "id": generateUUID(),
      "sub_chat_type": "t2t",
      "chat_mode": "normal",
      "timestamp": Math.floor(Date.now() / 1000),
      // 尝试协议层禁用 Qwen Studio 原生工具拦截（speculative，上游不支持则忽略）
      "disable_tools": true,
      "tool_choice": "none"
    }

    // 获取请求体原始数据
    let {
      messages,            // 消息历史
      model,               // 模型
      stream,              // 流式输出
      enable_thinking,     // 是否启用思考
      thinking_budget,      // 思考预算
      size,                  //图片尺寸
      tools,                // 工具列表（OpenAI function calling）
      tool_choice           // 工具调用控制
    } = req.body

    // Debug: 记录请求入口信息
    logger.warn(`[MIDDLEWARE-REQ] profile=${req.clientProfile?.name || 'unknown'} model=${model} stream=${stream} tools=${tools?.length || 0} messages=${messages?.length} rawBodySize=${JSON.stringify(req.body).length}`, 'ROUTE')

    // 处理 stream 参数
    if (stream === true || stream === 'true') {
      body.stream = true
    } else {
      body.stream = false
    }

    // 处理 model 参数 : 模型（必须在 isChatType / isThinkingEnabled 之前调用，
    // 因为它们的 suffix / effectiveThinkingEnabled 等字段从 req.modelResolution 复用）。
    // 通过 resolveQwenModel 统一解析模型名（带后缀别名）→ 上游真实模型 ID。
    // req.modelResolution 保存完整的解析结果（requestedModel / baseModel / upstreamModel /
    // aliasMode / effectiveThinkingEnabled 等），供下游 controller 和 handler 读取。
    // 注意：body.model 是发送给 Qwen 上游的真实模型 ID（不带 -thinking 等后缀），
    // 原始 requestedModel 保留在 req.modelResolution.requestedModel 中供日志/统计使用。
    req.modelResolution = await resolveQwenModel(model, {
      reasoningEffort: req.body?.reasoning_effort,
      thinkingBudget: req.body?.thinking_budget,
      enableThinking: req.body?.enable_thinking,
    })
    body.model = req.modelResolution.upstreamModel
    logger.warn(`[MODEL-RESOLVE] requested=${model} upstream=${req.modelResolution.upstreamModel} aliasMode=${req.modelResolution.aliasMode} thinking=${req.modelResolution.effectiveThinkingEnabled} reasoningEffort=${req.modelResolution.effectiveReasoningEffort}`, 'ROUTE')
    if (req.lifecycleRecorder) {
      req.lifecycleRecorder.record('model_resolved', { baseModel: req.modelResolution?.baseModel })
    }

    // 处理 chat_type 参数 : 聊天类型（从 req.modelResolution.suffix 复用解析结果）
    body.chat_type = isChatType(model, req.body?.chat_type, req.modelResolution)

    req.enable_web_search = body.chat_type === 'search' ? true : false

    // 处理 enable_thinking 参数 : 是否启用思考（从 req.modelResolution 复用解析结果）
    // 必须在 tool prompt 注入之前计算，因为注入到新 text block 时需要 feature_config.thinking_enabled
    req.enable_thinking = isThinkingEnabled(model, enable_thinking, thinking_budget, req.modelResolution).thinking_enabled

    // 处理 tools 参数 : 通过提示词为网页版模型注入工具调用能力
    const hasTools = Array.isArray(tools) && tools.length > 0 && body.chat_type === 't2t'
    let preparedMessages = messages
    let toolSystemPrompt = ''
    if (hasTools) {
      const _clientProfileName = req.clientProfile && req.clientProfile.name
      const _isClaudeCode = _clientProfileName === 'claude-code'
      const _isHermes = _clientProfileName === 'hermes-agent'
      const _hasUserImage = Array.isArray(messages) && messages.some(m => {
        if (!m || !Array.isArray(m.content)) return false
        return m.content.some(c => c && (c.type === 'image_url' || c.type === 'image'))
      })
      if (_isHermes) {
        toolSystemPrompt = buildHermesToolSystemPrompt(tools, { tool_choice, disableParallelToolUse: false, provider: 'qwen' })
      } else {
        toolSystemPrompt = buildToolSystemPrompt(tools, { tool_choice, claudeCodeProfile: _isClaudeCode, hasUserImage: _hasUserImage, provider: 'qwen' })
      }
      // 仅折叠 assistant.tool_calls / role=tool 历史，不在此插入 system 消息，
      // 避免被下游 parserMessages 折叠成 "system:<提示词>;user:..." 干扰模型理解。
      preparedMessages = foldToolMessagesForChatBackend(messages || [])

      // 在 preparedMessages 最前面插入 Qwen 路由第一条警告消息
      if (preparedMessages && preparedMessages.length > 0) {
          preparedMessages.unshift({ role: 'user', content: buildQwenFirstMessageWarning() })
      }

      req.has_tools = true
      req.tool_choice = tool_choice || 'auto'
      // [DIAG] 不传 tools 字段给上游，避免激活上游原生 function_call 机制
      // body.tools = tools
      // if (tool_choice) body.tool_choice = tool_choice
    } else {
      req.has_tools = false
    }

    // Pick before image upload; later account failover can still use the
    // uploaded OSS file_url without re-uploading.
    // Create AbortController early so it can be passed to scheduler.acquire.
    const abortController = new AbortController()
    req.on('close', () => abortController.abort())

    // QwenScheduler 接入：优先从 scheduler 获取 lease；失败时回退到旧的
    // pickAccountWithSticky 路径，保持向后兼容。
    let preSelectedAccount = null
    let schedulerAcquired = false
    try {
      const scheduler = require('../backends/qwen/scheduler-singleton')
      const sched = scheduler.getScheduler()
      if (sched) {
        if (req.lifecycleRecorder) {
          req.lifecycleRecorder.record('scheduler_enqueued')
        }
        const lease = await sched.acquire({
          requestedModel: req.modelResolution.requestedModel,
          baseModel: req.modelResolution.baseModel,
          aliasMode: req.modelResolution.aliasMode,
          estimatedPromptBytes: Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8'),
          mediaBytes: 0,
          sessionKey: req.headers['x-session-key'] || null,
          signal: abortController.signal,
          deadline: Date.now() + 120000
        })
        req.lease = lease
        preSelectedAccount = lease.account
        schedulerAcquired = true
        if (req.lifecycleRecorder) {
          req.lifecycleRecorder.record('scheduler_admitted')
          req.lifecycleRecorder.record('account_leased', { accountId: lease?.account?.accountId })
        }
      } else {
        // scheduler 未初始化（账号未加载等）— 回退到旧路径
        logger.warn('QwenScheduler not initialized, falling back to pickAccountWithSticky', 'MIDDLEWARE')
      }
    } catch (e) {
      // 队列满 / 超时 / deadline 超出 — 返回 429 + Retry-After
      if (e && e.status === 429) {
        const retryAfter = (e.headers && e.headers['Retry-After']) || '30'
        res.setHeader('Retry-After', retryAfter)
        return res.status(429).json({
          status: 429,
          message: 'Service busy, please retry later',
          code: e.code || 'QUEUE_FULL'
        })
      }
      // scheduler 正在关闭 — 返回 503
      if (e && e.status === 503) {
        res.setHeader('Retry-After', '30')
        return res.status(503).json({
          status: 503,
          message: 'Scheduler unavailable, please retry later',
          code: e.code || 'SCHEDULER_UNAVAILABLE'
        })
      }
      // 其他未知错误 — 回退到旧路径
      logger.warn(`QwenScheduler acquire failed, falling back to pickAccountWithSticky: ${e && e.message}`, 'MIDDLEWARE')
    }

    // Fallback: scheduler 未初始化或 acquire 抛出未知错误
    if (!schedulerAcquired) {
      try {
        preSelectedAccount = await pickAccountWithSticky(accountManager, req)
      } catch (e) {
        // 预选失败不阻塞主流程，回退到 sendChatRequest 内部选择
        logger.debug('OpenAI 路由预选账号失败，回退到 sendChatRequest 内部选择', 'PARSER')
        preSelectedAccount = null
      }
    }

    req.preSelectedAccount = preSelectedAccount
    markLatency(req.chatLatency, 'accountSelected', {
      account: preSelectedAccount?.email
    })

    // 处理 messages 参数 : 消息历史
    body.messages = await parserMessages(
      preparedMessages,
      isThinkingEnabled(model, enable_thinking, thinking_budget, req.modelResolution),
      body.chat_type,
      {
        uploadAccount: preSelectedAccount,
        lease: req.lease,
        model: body.model,
        canonicalEnvelope: hasTools,
        signal: abortController.signal
      }
    )

    // 工具提示词在 parserMessages 折叠完成后，作为前缀拼接到最终用户消息内容上，
    // 这样既不会被角色前缀污染，也能让模型在每一轮都看到完整工具说明。
    if (hasTools && toolSystemPrompt && Array.isArray(body.messages) && body.messages.length > 0) {
      const last = body.messages[body.messages.length - 1]
      const reminder = buildToolFormatReminder(tools, { provider: 'qwen' })
      // 调试：输出工具系统提示词大小
      const toolPromptLen = typeof toolSystemPrompt === 'string' ? toolSystemPrompt.length : 0
      const reminderLen = typeof reminder === 'string' ? reminder.length : 0
      const userContentLen = typeof last.content === 'string' ? last.content.length : (Array.isArray(last.content) ? last.content.reduce((s, c) => s + (c?.text?.length || 0), 0) : 0)
      logger.warn(`[TOOL-PROMPT-SIZE] toolPrompt=${toolPromptLen}B reminder=${reminderLen}B userContent=${userContentLen}B total=${toolPromptLen + reminderLen + userContentLen}B tools=${tools.length}`, 'ROUTE')
      if (typeof last.content === 'string') {
        last.content = `${toolSystemPrompt}\n\n${last.content}\n\n${reminder}`
      } else if (Array.isArray(last.content)) {
        const textIdx = last.content.findIndex(c => c?.type === 'text')
        if (textIdx >= 0) {
          last.content[textIdx].text = `${toolSystemPrompt}\n\n${last.content[textIdx].text || ''}\n\n${reminder}`
        } else {
          last.content.unshift({
            type: 'text',
            text: `${toolSystemPrompt}\n\n${reminder}`,
            chat_type: 't2t',
            feature_config: { output_schema: 'phase', thinking_enabled: req.enable_thinking }
          })
        }
      }
    }

    // 处理 sub_chat_type 参数 : 子聊天类型
    body.sub_chat_type = body.chat_type

    // 处理图片尺寸
    if (size) {
      body.size = size
    }

    // 处理请求体,将body赋值给req.body
    req.body = body
    const finalPayloadSize = Buffer.byteLength(JSON.stringify(body), 'utf8')
    logger.warn(`[MIDDLEWARE-FINAL] model=${body.model} stream=${body.stream} messages=${body.messages?.length} hasTools=${req.has_tools} thinking=${req.enable_thinking} payloadSize=${finalPayloadSize}B`, 'ROUTE')
    setLatencyFields(req.chatLatency, {
      model: body.model,
      stream: !!body.stream,
      hasTools: req.has_tools,
      toolChoice: req.tool_choice,
      ...messageStats(body.messages)
    })
    markLatency(req.chatLatency, 'bodyNormalized')

    next()
  } catch (e) {
    // 如果已获取 lease 但在 parserMessages 或后续步骤抛错，需要在此释放，
    // 否则账号槽位会泄漏。（成功路径由 stream-handler.js 在流结束时释放。）
    if (req.lease && typeof req.lease.release === 'function') {
      try { req.lease.release('failure') } catch (_) {}
    }
    logger.error('处理请求体时发生错误', 'MIDDLEWARE', '', e)
    res.status(500)
      .json({
        status: 500,
        message: "在处理请求体时发生错误 ~ ~ ~"
      })
  }
}

module.exports = {
  processRequestBody
}
