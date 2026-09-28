/**
 * DeepSeek 模型列表控制器
 * 每次请求实时从 DeepSeek Web API 获取模型列表
 *
 * 与 Qwen 路线一致：失败时返回空数组，绝不返回硬编码兜底列表。
 */
const dpskClient = require('../backends/deepseek/dpsk-client');
const dpskAccount = require('../backends/deepseek/dpsk-account');
const { logger } = require('../utils/logger');
const { formatOpenAIModelList } = require('../utils/openai-response');

/**
 * GET /v1/dpsk/models
 * 实时从 DeepSeek Web API 获取模型列表，返回 OpenAI 兼容格式
 */
async function handleDpskModels(req, res) {
    let account = null;
    try {
        account = await dpskAccount.getAvailableAccount();
        const token = account?.token;

        let models = [];
        if (token) {
            models = await dpskClient.getModels(token, account);
        } else {
            logger.warn('[DPSK-Models] 无可用账号，返回空模型列表', 'DPSK_MODEL');
        }

        const formatted = models.map(m => ({
            id: m.id,
            object: 'model',
            created: 1745462400,
            owned_by: 'deepseek',
            name: m.name,
            upstream_id: m.id,
            display_name: m.name,
            model_type: m.model_type,
            thinking_enabled: m.thinking_enabled === true,
            capabilities: m.capabilities || undefined,
        }));

        res.json(formatOpenAIModelList(formatted));
    } catch (err) {
        logger.error('[DPSK-Models] 获取模型列表失败', 'DPSK_MODEL', '', err);
        // 失败时返回空列表，而不是 500 错误，避免客户端崩溃
        res.json(formatOpenAIModelList([]));
    } finally {
        if (account) {
            try { dpskAccount.releaseAccount(account.email); } catch (_) { /* ignore */ }
        }
    }
}

/**
 * 获取 DeepSeek 模型列表（供 /v1/models 合并使用）
 * 每次调用实时从 API 获取
 * @returns {Promise<Array>}
 */
async function getDpskModelsForMerge() {
    let account = null;
    try {
        account = await dpskAccount.getAvailableAccount();
        const token = account?.token;
        if (token) {
            return await dpskClient.getModels(token, account);
        }
        logger.warn('[DPSK-Models] getDpskModelsForMerge: 无可用账号，返回空列表', 'DPSK_MODEL');
    } catch (e) {
        logger.warn('[DPSK-Models] 获取模型列表用于合并失败', 'DPSK_MODEL', '', e.message);
    } finally {
        if (account) {
            try { dpskAccount.releaseAccount(account.email); } catch (_) { /* ignore */ }
        }
    }
    // 失败时返回空数组，与 Qwen 路线保持一致
    return [];
}

// ========== 默认模型缓存（TTL 5 分钟，与 Qwen 路线一致） ==========
let cachedDpskDefaultModel = null;
let cachedDpskDefaultModelAt = 0;
const { DPSK_DEFAULT_MODEL_TTL_MS } = require('../config');

/**
 * 获取 DeepSeek 默认模型 ID（第一个 enabled 模型）
 * 内部调用 getDpskModelsForMerge() 实时获取，带内存缓存（TTL 5 分钟）。
 * 失败时返回 null（让上层处理，不要硬编码兜底）。
 * @returns {Promise<string|null>}
 */
async function getDpskDefaultModel() {
    const now = Date.now();
    if (cachedDpskDefaultModel && (now - cachedDpskDefaultModelAt) < DPSK_DEFAULT_MODEL_TTL_MS) {
        return cachedDpskDefaultModel;
    }
    try {
        const models = await getDpskModelsForMerge();
        if (Array.isArray(models) && models.length > 0) {
            cachedDpskDefaultModel = models[0].id;
            cachedDpskDefaultModelAt = now;
            return cachedDpskDefaultModel;
        }
    } catch (err) {
        // 静默失败，返回 null
        logger.warn('[DPSK-Models] getDpskDefaultModel 失败', 'DPSK_MODEL', '', err?.message || err);
    }
    return null;
}

module.exports = {
    handleDpskModels,
    getDpskModelsForMerge,
    getDpskDefaultModel,
};
