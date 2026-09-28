/**
 * Qwen 模型统一解析器
 *
 * 职责：将客户端传入的模型名（可能带后缀别名）解析为标准化的内部结构，
 * 包括 base model、上游模型名、别名模式、reasoning effort、模型能力等。
 *
 * 设计原则：
 *   - 后缀别名（-thinking, -search 等）是反代层的语法糖，不发送给上游
 *   - 上游模型名永远是 base model（去后缀后的真实模型 ID）
 *   - 模型能力从上游元数据动态读取，不硬编码
 *   - 未知模型名尽量返回 best-effort 结果，不抛异常
 *
 * 使用方式：
 *   const { resolveQwenModel } = require('./backends/qwen/model-resolver')
 *   const resolved = await resolveQwenModel('qwen3.8-max-preview-thinking', { reasoning_effort: 'medium' })
 */

const { logger } = require('../../utils/logger');
const { getLatestModelsArray } = require('../../models/models-map.js');

/**
 * 模型后缀列表（按长度降序，确保长后缀优先匹配）
 * 这是项目内唯一的 `MODEL_SUFFIXES` 定义；`message-enricher.js` 等其他模块
 * 应通过 `resolveQwenModel()` 或导入本模块的 `splitModelSuffix` 复用，不再自行定义。
 */
const MODEL_SUFFIXES = [
    '-thinking-search',
    '-image-edit',
    '-deep-research',
    '-thinking',
    '-search',
    '-video',
    '-image',
];

/**
 * 默认 reasoning effort 映射
 *   fast 模式 → null（不发送 thinking 字段，快速回答，无需深度思考）
 *   thinking 模式 → xhigh（深度思考模式）
 *
 * 注意：fast 模式必须为 null，不能是 'low'。'low' 会让上游误以为要发起 thinking，
 * 与"不发送 thinking 字段"的语义冲突。规则 1：qwen3.8-max-preview → effectiveReasoningEffort=null。
 */
const DEFAULT_REASONING_EFFORT = {
    fast: null,
    thinking: 'xhigh',
};

/**
 * 默认 thinking budget（思考模式启用但用户未显式指定时的兜底值）
 * 默认值 32768，待 A/B 实验最终确认。
 *
 * 规则 4：用户显式 thinking_budget 优先于默认值，resolver 阶段不做强制覆盖。
 * 旧约束（message-enricher.js 的 isThinkingEnabled < 38912 限制）会在 thinking_config
 * 构建阶段生效，resolver 阶段只负责"原始值透传 + 默认值兜底"。
 */
const DEFAULT_THINKING_BUDGET = 32768;

/**
 * 上下文长度保守默认值（fallback）
 * 当上游元数据无 max_context_length 字段时使用。
 * 注意：不写死 512K，因为不同模型上下文窗口差异较大，
 * 保守默认值避免向上游发送超出能力的请求。
 */
const DEFAULT_MAX_CONTEXT_LENGTH = 128000;

/**
 * 最大输出 token 保守默认值（fallback）
 * 当上游元数据无 max_output_tokens / max_summary_generation_length 字段时使用。
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;


/**
 * 拆分模型后缀
 * @param {string} model - 原始模型名称
 * @returns {{ baseModel: string, suffix: string }}
 */
function splitModelSuffix(model) {
    const modelName = String(model || '');
    for (const suffix of MODEL_SUFFIXES) {
        if (modelName.endsWith(suffix)) {
            return {
                baseModel: modelName.slice(0, -suffix.length),
                suffix,
            };
        }
    }
    return { baseModel: modelName, suffix: '' };
}

/**
 * 在模型列表中查找匹配的模型（按 id / name / display_name / upstream_id 匹配）
 * @param {Array<object>} models - 上游模型元数据数组
 * @param {string} modelName - 要匹配的模型名
 * @returns {object|undefined} 命中的模型元数据
 */
function findMatchedModel(models, modelName) {
    const normalizedModelName = String(modelName || '').trim().toLowerCase();
    if (!normalizedModelName) return undefined;

    return models.find(model => {
        const aliases = [
            model?.id,
            model?.name,
            model?.display_name,
            model?.upstream_id,
        ];
        return aliases
            .filter(Boolean)
            .some(alias => String(alias).trim().toLowerCase() === normalizedModelName);
    });
}

/**
 * 从模型元数据中提取能力信息
 *
 * 规则 5/6/7：vision/document/tool/thinking capabilities 与 maxContextLength/maxOutputTokens
 * 全部从上游元数据动态读取，绝不硬编码。元数据缺失时回退到保守默认值。
 *
 * @param {object|undefined} matchedModel - 匹配到的模型元数据
 * @returns {{ vision: boolean, document: boolean, tool: boolean, thinking: boolean, maxContextLength: number, maxOutputTokens: number }}
 */
function extractCapabilities(matchedModel) {
    const meta = matchedModel?.info?.meta;
    if (!meta) {
        // 元数据缺失：所有能力置 false，长度/token 回退到保守默认值
        return {
            vision: false,
            document: false,
            tool: false,
            thinking: false,
            maxContextLength: DEFAULT_MAX_CONTEXT_LENGTH,
            maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        };
    }

    const caps = meta.capabilities || {};

    // thinking 能力：优先取 capabilities.thinking（boolean），
    // 否则检查 abilities.thinking（数值 > 0 表示支持），
    // 最后检查 max_thinking_generation_length（存在即支持思考）。
    const thinkingCapable = !!caps.thinking
        || (typeof meta.abilities?.thinking === 'number' && meta.abilities.thinking > 0)
        || (typeof meta.max_thinking_generation_length === 'number' && meta.max_thinking_generation_length > 0);

    return {
        vision: !!caps.vision,
        document: !!caps.document,
        // tool 能力：优先取 capabilities.tool，否则以 chat_type 包含 t2t 作为 fallback
        tool: typeof caps.tool === 'boolean' ? caps.tool : !!(meta.chat_type && meta.chat_type.includes('t2t')),
        thinking: thinkingCapable,
        // 模型是否支持关闭思考（快速模式）。think_skip.enable=false 表示模型是 thinking-only，
        // 不支持 fast 模式。如果 think_skip 字段不存在，默认支持 fast 模式（向后兼容）。
        supportsFastMode: meta.think_skip?.enable !== false,
        // maxContextLength：从上游元数据读取，缺失时回退到保守默认值（不写死 512K）
        maxContextLength: typeof meta.max_context_length === 'number'
            ? meta.max_context_length
            : DEFAULT_MAX_CONTEXT_LENGTH,
        // maxOutputTokens：优先 max_output_tokens，其次 max_summary_generation_length，
        // 最后回退到保守默认值
        maxOutputTokens: typeof meta.max_output_tokens === 'number'
            ? meta.max_output_tokens
            : (typeof meta.max_summary_generation_length === 'number'
                ? meta.max_summary_generation_length
                : DEFAULT_MAX_OUTPUT_TOKENS),
    };
}

/**
 * 解析 Qwen 模型名，返回标准化的模型解析结果
 *
 * @param {string} requestedModel - 客户端请求的模型名（可能带后缀别名）
 * @param {object} [requestOptions={}] - 请求选项
 * @param {string} [requestOptions.reasoningEffort] - 用户显式指定的 reasoning effort（OpenAI/Anthropic 协议）
 * @param {string} [requestOptions.reasoning_effort] - 同上，snake_case 别名（兼容）
 * @param {number} [requestOptions.thinkingBudget] - 用户显式指定的 thinking budget（思考 token 上限）
 * @param {number} [requestOptions.thinking_budget] - 同上，snake_case 别名（兼容）
 * @param {boolean} [requestOptions.enableThinking] - 用户显式启用思考（OpenAI 风格 enable_thinking）
 * @param {boolean} [requestOptions.enable_thinking] - 同上，snake_case 别名（兼容）
 * @returns {Promise<{
 *   requestedModel: string,
 *   baseModel: string,
 *   upstreamModel: string,
 *   aliasMode: 'fast'|'thinking'|'none',
 *   suffix: string,
 *   effectiveThinkingEnabled: boolean,
 *   effectiveThinkingBudget: number|null,
 *   effectiveReasoningEffort: 'low'|'medium'|'high'|'xhigh'|null,
 *   capabilities: { vision: boolean, document: boolean, tool: boolean, thinking: boolean, maxContextLength: number, maxOutputTokens: number },
 *   maxContextLength: number,
 *   maxOutputTokens: number,
 *   hasOverriddenReasoning: boolean,
 *   hasOverriddenThinkingBudget: boolean,
 * }>}
 */
async function resolveQwenModel(requestedModel, requestOptions = {}) {
    const model = String(requestedModel || '').trim();

    // 兼容 camelCase / snake_case 两种风格
    const userReasoningEffort = requestOptions.reasoningEffort || requestOptions.reasoning_effort || null;
    const userThinkingBudget = requestOptions.thinkingBudget != null
        ? Number(requestOptions.thinkingBudget)
        : (requestOptions.thinking_budget != null ? Number(requestOptions.thinking_budget) : null);
    const userEnableThinking = requestOptions.enableThinking === true || requestOptions.enable_thinking === true;

    // 1) 拆分后缀
    const { baseModel, suffix } = splitModelSuffix(model);

    // 2) 确定 aliasMode：
    //    - -thinking / -thinking-search → 'thinking'（深度思考模式）
    //    - 无后缀 → 'fast'（默认快速模式，不发送 thinking 字段）
    //    - 其他后缀（-search, -image, -video, -image-edit, -deep-research）→ 'none'
    //      （非思考类特殊模式，effectiveReasoningEffort 保持 null）
    let aliasMode;
    if (suffix === '-thinking' || suffix === '-thinking-search') {
        aliasMode = 'thinking';
    } else if (suffix === '') {
        aliasMode = 'fast';
    } else {
        aliasMode = 'none';
    }

    // 3) 从上游元数据中提取模型能力 + 查找 canonical id
    //    upstreamModel 必须是上游真实模型 ID：优先取 matchedModel.id（与 parserModel 行为一致），
    //    否则回退到 baseModel。绝不发送带后缀的虚构模型 ID 给上游。
    let capabilities = null;
    let matchedModelId = null;
    try {
        const models = await getLatestModelsArray();
        let matched = findMatchedModel(models, baseModel);
        if (matched) {
            matchedModelId = matched.id || null;
            capabilities = extractCapabilities(matched);
            logger.debug(
                `resolveQwenModel: ${model} → base=${baseModel} upstream=${matchedModelId || baseModel} mode=${aliasMode}`,
                'MODEL',
            );
        } else {
            logger.debug(
                `resolveQwenModel: ${model} → base=${baseModel} (not found in upstream model list, using best-effort defaults)`,
                'MODEL',
            );
        }
    } catch (e) {
        logger.debug(
            `resolveQwenModel: failed to fetch model metadata for ${baseModel}: ${e?.message || e}`,
            'MODEL',
        );
    }

    if (!capabilities) {
        // 元数据缺失：所有能力置 false，长度/token 回退到保守默认值
        capabilities = {
            vision: false,
            document: false,
            tool: false,
            thinking: false,
            maxContextLength: DEFAULT_MAX_CONTEXT_LENGTH,
            maxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
        };
    }

    // 4) 上游模型名 = matchedModel.id || baseModel（绝不发送虚构后缀模型给上游）
    const upstreamModel = matchedModelId || baseModel || model;

    // 4.5) thinking-only 模型强制启用 thinking 模式
    // 当模型 think_skip.enable=false 时，不支持 fast 模式（关闭思考）。
    // 此时即使没有 -thinking 后缀，也必须强制 aliasMode='thinking'，
    // 否则 upstream 会返回 invalid_input。
    if (aliasMode === 'fast' && capabilities && !capabilities.supportsFastMode) {
        aliasMode = 'thinking';
        logger.debug(
            `resolveQwenModel: ${model} is thinking-only (think_skip.enable=false), forcing aliasMode='thinking'`,
            'MODEL',
        );
    }

    // 5) effectiveThinkingEnabled：aliasMode='thinking' 或 用户显式 enable_thinking=true
    const effectiveThinkingEnabled = aliasMode === 'thinking' || userEnableThinking;

    // 6) effectiveReasoningEffort：用户显式 > aliasMode 默认
    //    fast 模式默认 null（不发送 thinking 字段，规则 1）
    //    thinking 模式默认 'xhigh'（规则 2）
    //    none 模式默认 null
    const hasOverriddenReasoning = !!userReasoningEffort;
    let effectiveReasoningEffort = null;
    if (userReasoningEffort) {
        effectiveReasoningEffort = userReasoningEffort;
    } else if (aliasMode === 'thinking') {
        effectiveReasoningEffort = DEFAULT_REASONING_EFFORT.thinking;
    } else if (aliasMode === 'fast') {
        effectiveReasoningEffort = DEFAULT_REASONING_EFFORT.fast;
    }
    // aliasMode === 'none' → effectiveReasoningEffort 保持 null

    // 7) effectiveThinkingBudget：用户显式 > 默认（启用思考时） > null
    //    重要：用户显式 thinking_budget 直接采用，不再施加 < 38912 的旧约束。
    //    旧约束（message-enricher.js 的 isThinkingEnabled）会在 thinking_config 构建阶段生效，
    //    resolver 阶段只负责"原始值透传 + 默认值兜底"。
    const hasOverriddenThinkingBudget = userThinkingBudget != null
        && !Number.isNaN(userThinkingBudget)
        && userThinkingBudget > 0;
    let effectiveThinkingBudget = null;
    if (hasOverriddenThinkingBudget) {
        effectiveThinkingBudget = userThinkingBudget;
    } else if (effectiveThinkingEnabled) {
        effectiveThinkingBudget = DEFAULT_THINKING_BUDGET;
    }

    return {
        requestedModel: model,
        baseModel,
        upstreamModel,
        aliasMode,
        suffix,
        effectiveThinkingEnabled,
        effectiveThinkingBudget,
        effectiveReasoningEffort,
        capabilities,
        // 顶层冗余字段：方便调用方直接读取，无需穿透 capabilities
        maxContextLength: capabilities.maxContextLength,
        maxOutputTokens: capabilities.maxOutputTokens,
        // 向后兼容字段（可选，未来 Phase 可移除）
        hasOverriddenReasoning,
        hasOverriddenThinkingBudget,
    };
}

module.exports = {
    resolveQwenModel,
    // 导出 splitModelSuffix / MODEL_SUFFIXES / findMatchedModel 供 legacy 调用方复用，
    // 避免在 message-enricher.js 等模块中重复定义（项目内唯一定义点）。
    splitModelSuffix,
    MODEL_SUFFIXES,
    findMatchedModel,
};
