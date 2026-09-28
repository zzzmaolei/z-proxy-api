/**
 * validate-request.js
 *
 * 运行时请求参数校验中间件（基于 joi）
 *
 * 为 /v1/chat/completions（OpenAI 协议）和 /v1/messages（Anthropic 协议）
 * 提供轻量级的必填字段校验。校验失败时返回 400 + 统一的 OpenAI / Anthropic 错误格式。
 *
 * 设计原则：
 *   - 只校验协议规定的必填字段（model、messages、Anthropic 的 max_tokens）
 *   - `.unknown(true)` 允许未知字段透传，避免拒绝合法请求
 *   - 不破坏现有功能，校验失败前不消费 request body
 */

const Joi = require('joi')
const {
    sendOpenAIError,
    sendAnthropicError,
    ErrorType,
} = require('../utils/provider-errors')

/**
 * Chat Completions 校验 schema（OpenAI 协议）
 *
 * 必填：model、messages（至少 1 条）
 * messages[].role 限定为 system/user/assistant/tool
 * 其他字段（tools、tool_choice、max_tokens、temperature 等）只做类型校验，允许透传
 */
const chatCompletionsSchema = Joi.object({
    model: Joi.string().required(),
    messages: Joi.array().items(Joi.object({
        role: Joi.string().valid('system', 'developer', 'user', 'assistant', 'tool').required(),
        content: Joi.alternatives().try(Joi.string().allow(''), Joi.array(), Joi.any().valid(null)),
        tool_calls: Joi.array().optional(),
        tool_call_id: Joi.string().allow('').optional(),
    }).unknown(true)).min(1).required(),
    stream: Joi.boolean().optional(),
    tools: Joi.array().optional(),
    tool_choice: Joi.alternatives().try(Joi.string(), Joi.object()).optional(),
    max_tokens: Joi.number().integer().positive().optional(),
    temperature: Joi.number().min(0).max(2).optional(),
}).unknown(true)

/**
 * Messages 校验 schema（Anthropic 协议）
 *
 * 必填：model、messages（至少 1 条）、max_tokens
 * messages[].role 允许 user/assistant/system：
 *   - Claude Code 某些版本会把 system 消息放到 messages 数组里（而非顶级 system 字段），
 *     反代层通过 extractSystemFromMessages 提取后合并到顶级 system，这里宽松放行。
 * messages[].content 允许 null：
 *   - Claude Code tools 多轮中 assistant 消息可能 content=null（只有 tool_calls），
 *     反代层 flattenAnthropicMessages 已能处理 null/缺省 content。
 * 其他字段（system、stream、tools 等）只做类型校验，允许透传
 */
const messagesSchema = Joi.object({
    model: Joi.string().required(),
    messages: Joi.array().items(Joi.object({
        role: Joi.string().valid('user', 'assistant', 'system').required(),
        content: Joi.alternatives().try(Joi.string().allow(''), Joi.array(), Joi.any().valid(null)).required(),
    }).unknown(true)).min(1).required(),
    max_tokens: Joi.number().integer().positive().required(),
    system: Joi.alternatives().try(Joi.string(), Joi.array()).optional(),
    stream: Joi.boolean().optional(),
    tools: Joi.array().optional(),
    tool_choice: Joi.alternatives().try(Joi.string(), Joi.object()).optional(),
}).unknown(true)

/**
 * 把 joi 校验错误详情格式化为单个 detail 字符串
 * @param {Joi.ValidationError} joiError
 * @returns {string}
 */
function formatJoiDetails(joiError) {
    if (!joiError || !Array.isArray(joiError.details) || joiError.details.length === 0) {
        return 'unknown validation error'
    }
    return joiError.details.map(d => d.message).join('; ')
}

/**
 * Claude Code may serialize a single Anthropic content block as an object
 * instead of the protocol's one-item content array.  Canonicalize that
 * wire-compatible shape before validation so the downstream Anthropic
 * flattener receives its expected array without losing a tool_result block.
 */
function normalizeAnthropicSingletonContentBlocks(body) {
    if (!body || !Array.isArray(body.messages)) return

    for (const message of body.messages) {
        if (!message || Array.isArray(message.content)) continue
        if (typeof message.content === 'object' && message.content !== null) {
            message.content = [message.content]
        }
    }
}

/**
 * OpenAI /v1/chat/completions 校验中间件
 */
function validateChatCompletions(req, res, next) {
    const { error } = chatCompletionsSchema.validate(req.body, { abortEarly: false })
    if (error) {
        try {
            console.error('[validateChatCompletions FAIL]', JSON.stringify(req.body.messages?.map(m => m && m.role)), 'error:', error.details?.map(d => d.message));
        } catch (_) {}
        const detail = formatJoiDetails(error)
        return sendOpenAIError(res, {
            type: ErrorType.INVALID_REQUEST,
            message: 'Invalid request: ' + detail,
            statusCode: 400,
            provider: 'validation',
            model: (req.body && req.body.model) || '',
        })
    }
    return next()
}

/**
 * Anthropic /v1/messages 校验中间件
 */
function validateMessages(req, res, next) {
    normalizeAnthropicSingletonContentBlocks(req.body)
    const { error } = messagesSchema.validate(req.body, { abortEarly: false })
    if (error) {
        const detail = formatJoiDetails(error)
        // 诊断日志：记录校验失败时的 messages role 列表，定位 Claude Code 等客户端的非标准请求
        try {
            const msgs = req.body && Array.isArray(req.body.messages) ? req.body.messages : []
            const roles = msgs.map(m => m && m.role)
            console.error(`[validateMessages] FAIL detail=${detail} roles=${JSON.stringify(roles)} model=${req.body && req.body.model}`)
        } catch (_) { /* ignore */ }
        return sendAnthropicError(res, {
            type: ErrorType.INVALID_REQUEST,
            message: 'Invalid request: ' + detail,
            statusCode: 400,
            provider: 'validation',
            model: (req.body && req.body.model) || '',
        })
    }
    return next()
}

module.exports = {
    validateChatCompletions,
    validateMessages,
    normalizeAnthropicSingletonContentBlocks,
    chatCompletionsSchema,
    messagesSchema,
}
