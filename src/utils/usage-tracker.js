/**
 * Centralized chat usage attribution.
 *
 * `stats.chat.input/output` remain the compatibility totals. Optional
 * breakdown fields distinguish upstream-reported usage from local estimates
 * and correction-retry overhead. Stats failures are intentionally swallowed so
 * accounting never interrupts the API response path.
 */

const accountManager = require('./account.js')

/**
 * Accepts both controller call signatures:
 *   attributeChatUsage(account, { prompt_tokens, completion_tokens }, meta)
 *   attributeChatUsage(account, promptTokens, completionTokens, meta)
 *
 * @param {Object|null|undefined} account
 * @param {Object|number|null|undefined} usageOrPrompt
 * @param {number|Object} [completionTokens] - 当第二参是数字时使用；也可作为 meta
 * @param {Object} [meta]
 * @returns {void}
 */
const attributeChatUsage = (account, usageOrPrompt, completionTokens, meta) => {
    if (!account || !account.email) return

    let input = 0
    let output = 0
    let options = (meta && typeof meta === 'object') ? meta : {}
    if (completionTokens && typeof completionTokens === 'object') {
        options = completionTokens
    }

    if (typeof usageOrPrompt === 'object' && usageOrPrompt !== null) {
        input = Number(usageOrPrompt.prompt_tokens ?? usageOrPrompt.input_tokens ?? usageOrPrompt.input) || 0
        output = Number(usageOrPrompt.completion_tokens ?? usageOrPrompt.output_tokens ?? usageOrPrompt.output) || 0
        if (!options.usageSource && usageOrPrompt.estimated) {
            options = { ...options, usageSource: 'estimated' }
        }
    } else {
        input = Number(usageOrPrompt) || 0
        output = Number(completionTokens) || 0
    }

    const requests = options.requests === undefined ? 1 : (Number(options.requests) || 0)
    const blockedRequests = options.blocked
        ? (Number(options.blockedRequests) || 1)
        : (Number(options.blockedRequests) || 0)
    const retryInput = Number(options.retryInput ?? options.retryPromptTokens) || 0
    const retryOutput = Number(options.retryOutput ?? options.retryCompletionTokens) || 0
    const usageSource = options.usageSource === 'estimated' ? 'estimated' : 'upstream'
    // Provider / model 维度（按 base model 聚合，-thinking/-search/-image 等归一化
    // 在 account.accumulateStats 内部完成；此处只透传）。
    const provider = options.provider || ''
    const model = options.model || ''

    const delta = {
        input,
        output,
        requests,
        blockedRequests,
        retryInput,
        retryOutput,
        provider,
        model
    }

    if (usageSource === 'estimated') {
        delta.estimatedInput = input
        delta.estimatedOutput = output
    } else {
        delta.upstreamInput = input
        delta.upstreamOutput = output
    }

    // Usage accounting must not break the user-visible response path.
    // Route attribution to the matching account manager:
    //   - 'dpsk' / 'deepseek' → dpskAccount (instance backed by dpsk-data.json)
    //   - everything else     → Qwen accountManager
    // DeepSeek accounts are stored in a separate data file and are
    // intentionally NOT merged into accountManager.accountTokens.
    try {
        const providerTag = (options.provider || '').toLowerCase()
        if (providerTag === 'dpsk' || providerTag === 'deepseek') {
            try {
                const dpskAccount = require('../backends/deepseek/dpsk-account.js')
                if (dpskAccount && typeof dpskAccount.accumulateStats === 'function') {
                    dpskAccount.accumulateStats(account.email, 'chat', delta)
                    return
                }
            } catch (_) {
                // dpsk module unavailable — fall through to Qwen manager (best-effort)
            }
        }
        accountManager.accumulateStats(account.email, 'chat', delta)
    } catch (_) {
        /* ignore */
    }
}

module.exports = {
    attributeChatUsage
}
