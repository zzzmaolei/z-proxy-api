/**
 * provider-registry.js
 *
 * 声明式 provider 注册表 —— 对齐 OpenAI Codex CLI 的 model_providers 抽象。
 *
 * Codex CLI 通过 config.toml 的 [model_providers.X] 块定义上游：
 *   name / base_url / env_key / wire_api ("chat"|"responses") / http_headers
 * 本项目作为网关，对外暴露统一的 OpenAI 兼容 /v1/chat/completions，按 model 名
 * 分发到内部 provider（qwen / deepseek）。这里把「model → provider」的匹配
 * 规则与对应控制器集中成一张声明式表，替代散落在路由里的硬编码 middleware。
 *
 * 新增 provider 只需往 PROVIDERS 里加一项，无需改路由。
 * 未命中的 model 一律落到默认 Qwen 路线（由调用方 next() 处理）。
 */
const { logger } = require('../utils/logger')

/**
 * @typedef {Object} Provider
 * @property {string} name - provider 标识（deepseek / ...）
 * @property {'chat'} wireApi - 对外协议（本项目统一 OpenAI chat completions）
 * @property {(model: string) => boolean} match - model 名匹配规则
 * @property {(req: any, res: any, next: any) => void} controller - OpenAI 兼容控制器
 */

/** @type {Provider[]} */
const PROVIDERS = [
    {
        name: 'deepseek',
        wireApi: 'chat',
        match: (model) => {
            const l = String(model || '').toLowerCase().trim()
            return l.includes('deepseek') || l.includes('dpsk')
        },
        // OpenAI /v1/chat/completions 控制器：getter 延迟 require 避免分层违规
        // (providers 不应在模块顶部直接依赖 controllers)
        get controller() {
            const { chatCompletions } = require('../controllers/dpsk-chat')
            return chatCompletions
        },
        // Anthropic /v1/messages 控制器：用 getter 延迟 require 避免循环依赖
        // (controllers/anthropic-deepseek.js 间接依赖链可能回溯到 registry)
        get anthropicController() {
            const { handleAnthropicDeepSeek } = require('../controllers/anthropic-deepseek')
            return handleAnthropicDeepSeek
        },
    },
]

/**
 * 按 model 名分发到对应 provider 控制器；未命中则 next() 走默认 Qwen 路线。
 * 挂在 /v1/chat/completions 上，位于 apiKeyVerify 之后、detectOpenAIProfile 之前。
 */
function routeByProvider(req, res, next) {
    const model = req.body?.model || ''
    for (const p of PROVIDERS) {
        if (p.match(model)) {
            logger.info(`[ROUTE] ${p.name} 模型请求转发: ${model}`, p.name.toUpperCase())
            return p.controller(req, res, next)
        }
    }
    logger.debug('[ROUTE] model "' + model + '" 匹配 Qwen provider', 'ROUTE')
    next()
}

/**
 * 查询 model 命中的 provider（供 /v1/models 聚合、诊断等使用）
 * @param {string} model
 * @returns {Provider|null}
 */
function getProviderForModel(model) {
    return PROVIDERS.find(p => p.match(model)) || null
}

/**
 * 按模型名分发到对应 provider 的 Anthropic 控制器（数据驱动）
 * - 命中 provider 且声明了 anthropicController → 调用之
 * - 其他                                      → 继续走 Qwen 控制器
 */
function routeByProviderAnthropic(req, res, next) {
    const model = (req.body && req.body.model) || ''
    const provider = getProviderForModel(model)
    if (provider && typeof provider.anthropicController === 'function') {
        return provider.anthropicController(req, res)
    }
    logger.debug('[ROUTE] model "' + model + '" 匹配 Qwen provider', 'ROUTE')
    return next()
}

module.exports = {
    PROVIDERS,
    routeByProvider,
    routeByProviderAnthropic,
    getProviderForModel,
}
