/**
 * Qwen compatibility export for the provider-neutral AccountScheduler.
 *
 * Qwen keeps its historical constructor names and config keys here. The
 * implementation lives in src/shared/account-scheduler.js so DeepSeek can
 * use the same queue and lease semantics without importing Qwen code.
 */

const config = require('../../config/index.js')
const { AccountScheduler } = require('../../shared/account-scheduler')

const normalizeQwenArgs = (accountRuntimes, cfg) => {
    if (accountRuntimes && typeof accountRuntimes === 'object' && !(accountRuntimes instanceof Map)) {
        cfg = accountRuntimes
        accountRuntimes = undefined
    }

    const input = cfg || {}
    return {
        accountRuntimes,
        config: {
            ...input,
            providerId: input.providerId || 'qwen',
            maxConcurrencyPerAccount: input.maxConcurrencyPerAccount
                ?? input.qwenMaxConcurrencyPerAccount
                ?? config.qwenMaxConcurrencyPerAccount,
            globalMaxConcurrency: input.globalMaxConcurrency
                ?? input.qwenGlobalMaxConcurrency
                ?? config.qwenGlobalMaxConcurrency,
            maxQueueSize: input.maxQueueSize
                ?? input.qwenMaxQueueSize
                ?? config.qwenMaxQueueSize,
            queueTimeoutMs: input.queueTimeoutMs
                ?? input.qwenQueueTimeoutMs
                ?? config.qwenQueueTimeoutMs,
        },
    }
}

class QwenScheduler extends AccountScheduler {
    constructor(accountRuntimes, cfg = {}) {
        const normalized = normalizeQwenArgs(accountRuntimes, cfg)
        super(normalized.accountRuntimes, normalized.config)
    }
}

module.exports = { QwenScheduler, AccountScheduler }
