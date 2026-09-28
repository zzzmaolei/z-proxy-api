/**
 * OpenAI 兼容 chat controller（编排层）。
 *
 * 重构后职责单一：
 *  - 参数解析（stream / model / enable_thinking / has_tools / tool_choice）
 *  - profile 检测 + 日志节流
 *  - 账号预选 + sendChatRequest 调用
 *  - 分发到 backends/qwen/stream-handler.js 或 sync-handler.js
 *  - 错误兜底（OpenAI error envelope）
 *
 * 流式/同步响应处理逻辑已下沉到：
 *   - backends/qwen/stream-handler.js（handleStreamResponse）
 *   - backends/qwen/sync-handler.js（handleSyncResponse）
 *   - backends/qwen/stream-utils.js（共享辅助：心跳 / 错误写入 / 工具重试提示）
 *
 * 维护重点（同原文件）：
 *  - Qwen Web 上游始终按 SSE 流返回；本文件再按客户端要求转换成 OpenAI stream/non-stream。
 *  - tools 是通过提示词让 chat 后端输出 <tool_call>，由 handler 解析并改写成 OpenAI tool_calls。
 *  - 图片上传、主请求、controller 级 retry 都尽量复用同一个 Qwen 账号；
 *    只有网络/429/5xx 才由 sendChatRequest 串行换号。
 */
const { generateUUID } = require('../utils/tools.js');
const { sendChatRequest } = require('../backends/qwen/request.js');
const { formatOpenAIError } = require('../utils/openai-response.js');
const { logger } = require('../utils/logger');
const { setLatencyFields } = require('../utils/chat-latency-monitor.js');
const PROFILES_AGENTS = require('../agents/index.js');
const { handleStreamResponse } = require('../backends/qwen/stream-handler.js');
const { handleSyncResponse } = require('../backends/qwen/sync-handler.js');
const { writeOpenAIStreamErrorAndDone } = require('../backends/qwen/stream-utils.js');
// resolveQwenModel 仅用作防御性 fallback：当中间件未设置 req.modelResolution 时
//（例如绕过 processRequestBody 的直连调用），controller 自行解析以避免崩溃。
// 正常路径下解析已在 chat-middleware.js 中完成，结果存于 req.modelResolution。
const { resolveQwenModel } = require('../backends/qwen/model-resolver.js');

/**
 * 取出当前 OpenAI 路由的 client profile；没有则兜底 openai-compatible
 * @param {object} req
 * @returns {Object}
 */
const getOpenAIProfile = (req) => {
  const fromReq = req && req.clientProfile
  if (fromReq && fromReq.name) {
    const p = PROFILES_AGENTS.getProfile(fromReq.name)
    if (p) return p
  }
  return PROFILES_AGENTS.openaiCompatible
}

/**
 * 简易 throttle：同一种 debug summary 5 分钟内只打印一次
 * @type {Map<string, number>}
 */
const _openAIProfileNoticeLastLog = new Map()
const shouldLogOpenAIProfileNotice = (summary, throttleMs) => {
  const ttl = Number(throttleMs) || 0
  if (ttl <= 0) return true
  const now = Date.now()
  const last = _openAIProfileNoticeLastLog.get(summary) || 0
  if (now - last < ttl) return false
  _openAIProfileNoticeLastLog.set(summary, now)
  return true
}

/**
 * 设置响应头
 * @param {object} res - Express 响应对象
 * @param {boolean} stream - 是否流式响应
 */
const setResponseHeaders = (res, stream, options = {}) => {
    try {
        if (stream) {
            res.set({
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            })
            if (options.flush && typeof res.flushHeaders === 'function') {
                try { res.flushHeaders() } catch (_) {}
            }
        } else {
            res.set({
                'Content-Type': 'application/json',
            })
        }
    } catch (e) {
        logger.error('处理聊天请求时发生错误', 'CHAT', '', e)
    }
}

/**
 * 主要的聊天完成处理函数
 * @param {object} req - Express 请求对象
 * @param {object} res - Express 响应对象
 */
const handleChatCompletion = async (req, res) => {
    const { stream, model } = req.body

    // 防御性 fallback：中间件未设置 req.modelResolution 时（例如直连调用），
    // 在 controller 内自行解析。正常路径下中间件已设置。
    if (!req.modelResolution) {
        try {
            req.modelResolution = await resolveQwenModel(model, {
                reasoningEffort: req.body?.reasoning_effort,
                thinkingBudget: req.body?.thinking_budget,
                enableThinking: req.body?.enable_thinking,
            })
        } catch (e) {
            logger.warn(`[chat] resolveQwenModel fallback failed: ${e?.message || e}`, 'CHAT')
            req.modelResolution = {
                requestedModel: model,
                baseModel: model,
                upstreamModel: model,
                aliasMode: null,
                effectiveThinkingEnabled: false,
                effectiveThinkingBudget: null,
                effectiveReasoningEffort: null,
                capabilities: { vision: false, document: false, tool: false, maxContextLength: null, maxOutputTokens: null },
                maxContextLength: null,
                maxOutputTokens: null,
            }
        }
    }
    // requestedModel 用于日志/统计：保留客户端原始请求的模型名（含后缀别名）
    const requestedModel = req.modelResolution?.requestedModel || model

    const enable_thinking = req.enable_thinking
    const enable_web_search = req.enable_web_search

    // Profile controls OpenAI compatibility details for this request.
    const activeProfile = getOpenAIProfile(req)
    const profileName = (activeProfile && activeProfile.profile && activeProfile.profile.name) || 'openai-compatible'
    const hasTools = !!req.has_tools
    const requestId = (req && req.id) || generateUUID()
    if (req) req.id = requestId
    setLatencyFields(req?.chatLatency, {
        requestId,
        protocol: 'openai',
        route: '/v1/chat/completions',
        profile: profileName,
        model: requestedModel,
        hasTools,
        stream: !!stream
    })

    try {
        // Reuse the account selected before image upload whenever possible.
        const preSelectedAccount = (req && req.preSelectedAccount) || null
        const response_data = await sendChatRequest(req.body, req, { account: preSelectedAccount, latency: req?.chatLatency })

        if (!response_data.status || !response_data.response) {
            // 紧急救火：error 字段现在带有原因（如 no_available_account / account_manager_not_ready）
            // 区分 503（账号没准备好）和 500（其它失败）
            const errMsg = response_data && response_data.error
                ? String(response_data.error)
                : 'Request failed'
            const isAccountIssue = /no_available_account|account_manager_not_ready|no_accounts_loaded/.test(errMsg)
            const status = isAccountIssue ? 503 : 500
            const code = isAccountIssue
                ? 'no_available_account'
                : (response_data?.errorKind || 'request_failed')
            const payload = formatOpenAIError(
                errMsg,
                { type: 'api_error', code, status }
            )
            if (response_data?.punishUrl) {
                payload.error.punish_url = response_data.punishUrl
            }
            if (response_data?.upstreamStatus) {
                payload.error.upstream_status = response_data.upstreamStatus
            }
            res.status(status).json(payload)
            return
        }

        // Throttle profile logs by the request shape.
        if (shouldLogOpenAIProfileNotice(`profile:${profileName}:${requestedModel}:${hasTools}:${!!stream}`, 5 * 60 * 1000)) {
            logger.debug(
                `[chat] protocol=openai profile=${profileName} model=${requestedModel} hasTools=${hasTools} stream=${!!stream} requestId=${requestId}`,
                'PROFILE'
            )
        }

        if (stream) {
            setResponseHeaders(res, true, { flush: true })
            await handleStreamResponse({
                res,
                response: response_data.response,
                enable_thinking,
                enable_web_search,
                requestBody: req.body,
                has_tools: req.has_tools,
                tool_choice: req.tool_choice,
                currentAccount: response_data.currentAccount,
                req,
                clientProfile: activeProfile,
                requestId,
                latency: req?.chatLatency,
                chat_id: response_data.chat_id
            })
        } else {
            setResponseHeaders(res, false)
            await handleSyncResponse({
                res,
                response: response_data.response,
                enable_thinking,
                enable_web_search,
                model,
                requestBody: req.body,
                has_tools: req.has_tools,
                tool_choice: req.tool_choice,
                currentAccount: response_data.currentAccount,
                req,
                clientProfile: activeProfile,
                requestId,
                latency: req?.chatLatency
            })
        }

    } catch (error) {
        // 兜底释放 lease：handler 的 finally 可能未执行到（如 setResponseHeaders 抛异常）
        if (req.lease) {
            try { req.lease.release('failure'); } catch (_) { /* idempotent */ }
            req.lease = null;
        }
        const isClientAbort = error?.code === 'CLIENT_ABORTED' || error?.classification === 'client_aborted'
        if (!isClientAbort) {
            logger.error('聊天处理错误', 'CHAT', '', error)
        }
        try {
            if (stream && res.headersSent && !res.writableEnded) {
                writeOpenAIStreamErrorAndDone(res, error, {
                    code: 'chat_completion_error'
                })
                return
            }
            // 返回 OpenAI 兼容 error envelope，避免把内部错误结构直接暴露给客户端。
            res.status(500).json(formatOpenAIError(error, {
                type: 'api_error',
                code: 'chat_completion_error'
            }))
        } catch (_) { /* response already started */ }
    }
}

module.exports = {
    handleChatCompletion,
    setResponseHeaders
}
