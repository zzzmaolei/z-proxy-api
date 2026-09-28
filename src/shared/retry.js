/**
 * 共享重试模块
 *
 * 从 dpsk-chat.js 中提取的通用重试包装器，供所有 provider controller 复用。
 */

const config = require('../config');
const { logger } = require('../utils/logger');

/**
 * 通用异步重试包装
 *
 * @param {Function} fn - 要重试的异步函数
 * @param {Object} [options]
 * @param {string} [options.label='request'] - 重试标签，用于日志
 * @param {string} [options.logTag='RETRY'] - 日志标签前缀
 * @returns {Promise<any>}
 */
async function withRetry(fn, { label = 'request', logTag = 'RETRY' } = {}) {
    const maxRetries = Math.max(0, parseInt(config.chatRetryCount, 10) || 0);
    const backoffMs = Math.max(0, parseInt(config.chatRetryBackoffMs, 10) || 0);
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            const isNetworkError = err.code || err.message?.includes('network') || err.message?.includes('timeout') || err.message?.includes('ECONN');
            const isRetryable = isNetworkError || /\b(500|502|503|504)\b/.test(err.message || '');
            if (attempt < maxRetries && isRetryable) {
                logger.warn(`[${logTag}] ${label} 失败，${backoffMs}ms 后重试 (${attempt + 1}/${maxRetries})`, logTag);
                if (backoffMs > 0) await new Promise(r => setTimeout(r, backoffMs));
                continue;
            }
            throw err;
        }
    }
    throw lastError;
}

module.exports = { withRetry };
