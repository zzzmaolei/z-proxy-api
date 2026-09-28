const { getLatestModels, getLatestModelsDetailed } = require('../models/models-map.js')
const config = require('../config/index.js')
// OpenAI /v1/models 兼容输出：过滤敏感字段并稳定 id 形态。
const { formatOpenAIModelList, formatOpenAIError } = require('../utils/openai-response.js')
const { logger } = require('../utils/logger.js')
const { getDpskModelsForMerge } = require('./dpsk-models.js')

/**
 * 构造对外暴露的模型信息
 * @param {object} model - 原始模型信息
 * @param {string} suffix - 变体后缀
 * @returns {object} 对外模型信息
 */
const buildPublicModelData = (model, suffix = '') => {
    // 容错：缺失字段时使用空字符串/默认
    const safeModel = (model && typeof model === 'object') ? model : {}
    const modelData = JSON.parse(JSON.stringify(safeModel))
    const upstreamModelID = String(safeModel?.id || '')
    const displayModelID = String(safeModel?.name || safeModel?.id || '')

    modelData.name = `${displayModelID}${suffix}`
    modelData.id = `${upstreamModelID}${suffix}`
    modelData.upstream_id = upstreamModelID
    modelData.display_name = displayModelID
    modelData.owned_by = 'qwen'

    return modelData
}

/**
 * 从 Qwen 上游获取模型列表
 * 失败时返回 { models: [], error }，不抛异常
 */
const fetchQwenModels = async () => {
    try {
        const result = await getLatestModelsDetailed()
        const ModelsMap = Array.isArray(result && result.models) ? result.models : []
        return {
            models: ModelsMap,
            source: (result && result.source) || 'unknown',
            error: result && result.error,
        }
    } catch (err) {
        logger.error('[DIAG] handleGetModels: getLatestModelsDetailed 抛错', 'MODEL', '', err)
        return { models: [], source: 'error', error: { code: 'EXCEPTION', message: err.message } }
    }
}

/**
 * 把 Qwen 模型数组展开成对外模型列表
 */
const expandQwenModels = (ModelsMap) => {
    const models = []
    if (!ModelsMap || ModelsMap.length === 0) return models

    for (const model of ModelsMap) {
        models.push(buildPublicModelData(model))

        if (config.simpleModelMap) {
            continue
        }

        const isThinking = model?.info?.meta?.abilities?.thinking
        const isSearch = model?.info?.meta?.chat_type?.includes('search')
        const isImage = model?.info?.meta?.chat_type?.includes('t2i')
        const isVideo = model?.info?.meta?.chat_type?.includes('t2v')
        const isImageEdit = model?.info?.meta?.chat_type?.includes('image_edit')
        const isDeepResearch = model?.info?.meta?.chat_type?.includes('deep_research')

        if (isThinking) {
            models.push(buildPublicModelData(model, '-thinking'))
        }

        if (isSearch) {
            models.push(buildPublicModelData(model, '-search'))
        }

        if (isThinking && isSearch) {
            models.push(buildPublicModelData(model, '-thinking-search'))
        }

        if (isImage) {
            models.push(buildPublicModelData(model, '-image'))
        }

        if (isVideo) {
            models.push(buildPublicModelData(model, '-video'))
        }

        if (isImageEdit) {
            models.push(buildPublicModelData(model, '-image-edit'))
        }

        // if (isDeepResearch) {
        //     models.push(buildPublicModelData(model, '-deep-research'))
        // }
    }

    return models
}

const handleGetModels = async (req, res) => {
    const models = []
    const diagnostics = {
        qwen: { source: 'unknown', count: 0, error: null },
        deepseek: { source: 'unknown', count: 0, error: null },
    }

    // 1) Qwen 模型
    const qwenResult = await fetchQwenModels()
    diagnostics.qwen.source = qwenResult.source
    diagnostics.qwen.error = qwenResult.error
    const qwenExpanded = expandQwenModels(qwenResult.models)
    models.push(...qwenExpanded)
    diagnostics.qwen.count = qwenExpanded.length

    // 2) DeepSeek 模型：失败不阻断其他来源
    try {
        const dpskModels = await getDpskModelsForMerge()
        if (dpskModels && dpskModels.length > 0) {
            for (const dm of dpskModels) {
                models.push({
                    id: dm.id,
                    object: 'model',
                    created: 1745462400,
                    owned_by: 'deepseek',
                    name: dm.name,
                    upstream_id: dm.id,
                    display_name: dm.name,
                    thinking_enabled: dm.thinking_enabled === true,
                    search_enabled: dm.search_enabled === true,
                })
            }
            diagnostics.deepseek.source = 'upstream'
            diagnostics.deepseek.count = dpskModels.length
            logger.info(`[MODEL] 已合并 ${dpskModels.length} 个 DeepSeek 模型`, 'MODEL')
        } else {
            diagnostics.deepseek.source = 'empty'
        }
    } catch (e) {
        diagnostics.deepseek.source = 'error'
        diagnostics.deepseek.error = e.message
        logger.warn(`[MODEL] 合并 DeepSeek 模型失败: ${e.message}`, 'MODEL')
    }

    // 把诊断信息通过响应头暴露
    try {
        res.set('x-models-qwen-source', String(diagnostics.qwen.source))
        res.set('x-models-qwen-count', String(diagnostics.qwen.count))
        if (diagnostics.qwen.error && diagnostics.qwen.error.code) {
            res.set('x-models-qwen-error', String(diagnostics.qwen.error.code))
        }
        res.set('x-models-deepseek-source', String(diagnostics.deepseek.source))
        res.set('x-models-deepseek-count', String(diagnostics.deepseek.count))
        if (diagnostics.deepseek.error) {
            res.set('x-models-deepseek-error', String(diagnostics.deepseek.error).slice(0, 100))
        }
    } catch (_) { /* ignore */ }

    // 只要有任意来源返回模型，就返回合并列表；只有全部为空/失败时才 503
    if (models.length === 0) {
        logger.error(
            `[DIAG] handleGetModels: 所有来源模型列表均为空 ` +
            `(qwen=${diagnostics.qwen.source}, deepseek=${diagnostics.deepseek.source})`,
            'MODEL'
        )
        return res.status(503).json(formatOpenAIError(
            'No models available: all upstreams failed',
            {
                type: 'api_error',
                code: 'no_models_available',
                status: 503
            }
        ))
    }

    // 统一走 OpenAI response helper，避免泄露上游内部字段。
    res.json(formatOpenAIModelList(models))
}

module.exports = {
    handleGetModels
}
