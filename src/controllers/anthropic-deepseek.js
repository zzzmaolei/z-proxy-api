/**
 * DeepSeek Anthropic Messages 控制器（编排层）
 *
 * 接收 Anthropic /v1/messages 请求，做参数校验 + 账号轮换 + 流式/同步分发，
 * 具体处理逻辑下沉到 backends/deepseek/anthropic-{stream,sync}-handler.js。
 *
 * # 与 Qwen anthropic.js 的差异
 *   - DeepSeek 需要 PoW 认证 + Session 管理（chatSessionId / parentMessageId）
 *   - 使用 buildPrompt() 文本序列化（而非 structured messages）
 *   - 有 session 缓存机制（30 分钟 TTL，见 backends/deepseek/anthropic-utils.js）
 *   - 通过 resolveModelOptions 解析模型类型
 *
 * # 外部接口
 *   - 唯一导出：handleAnthropicDeepSeek(req, res)
 *   - 唯一外部消费者：routes/anthropic.js
 */

const { logger } = require('../utils/logger');
const config = require('../config');
const dpskAccount = require('../backends/deepseek/dpsk-account');
const dpskScheduler = require('../backends/deepseek/scheduler-singleton');
const { buildSessionKey } = require('../backends/deepseek/anthropic-utils');
const { handleAnthropicStream } = require('../backends/deepseek/anthropic-stream-handler.js');
const { handleAnthropicSync } = require('../backends/deepseek/anthropic-sync-handler.js');
const { normalizeLeaseOutcome } = require('../shared/lease-outcome');

/**
 * DeepSeek Anthropic /v1/messages 入口
 *
 * 编排职责：
 *   1. 参数解析与校验（messages 必填）
 *   2. 获取可用 DeepSeek 账号
 *   3. 按 stream 字段分发到流式/同步 handler
 *   4. finally 释放账号
 *
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
async function handleAnthropicDeepSeek(req, res) {
    const startTime = Date.now();
    try {
        const { model, messages, system, tools, tool_choice, stream, max_tokens, thinking, metadata } = req.body || {};

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({
                type: 'error',
                error: { type: 'invalid_request_error', message: 'messages is required' }
            });
        }

        const requestAbortController = new AbortController();
        const onRequestAbort = () => requestAbortController.abort();
        const cleanupRequestAbort = () => {
            req.removeListener?.('aborted', onRequestAbort);
        };
        // `close` also fires after a normally completed request body. Only
        // the `aborted` event represents a client abort before the response.
        req.once?.('aborted', onRequestAbort);
        res.once?.('finish', cleanupRequestAbort);
        res.once?.('close', cleanupRequestAbort);
        if (req.aborted) requestAbortController.abort();
        const sessionKey = buildSessionKey(req, messages, '');

        // === 账号轮换重试逻辑 ===
        // 与 dpsk-chat.js 同构但简化：仅账号轮换，不含上下文降级链。
        // 认证/限流/禁言错误时 push triedEmails 并换号重试；其它错误直接返回。
        const triedEmails = [];
        const maxRetries = 5;
        let lastError = null;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const excludeAccountIds = new Set();
            for (const email of triedEmails) {
                const accountId = dpskScheduler.getAccountIdByEmail(email);
                if (accountId) excludeAccountIds.add(accountId);
            }
            const schedulerForAttempt = dpskScheduler.getScheduler();
            if (!schedulerForAttempt || schedulerForAttempt.accounts.size === 0
                || (excludeAccountIds.size > 0
                    && excludeAccountIds.size >= schedulerForAttempt.accounts.size)) {
                break;
            }

            let lease;
            try {
                lease = await dpskScheduler.acquire({
                    requestedModel: model,
                    baseModel: model,
                    estimatedPromptBytes: Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8'),
                    sessionKey,
                    excludeAccountIds,
                    signal: requestAbortController.signal,
                    deadline: Date.now() + (config.dpskQueueTimeoutMs || 120000),
                });
            } catch (acquireErr) {
                if (acquireErr?.code === 'CLIENT_ABORTED') {
                    if (!res.headersSent) return res.status(499).json({ type: 'error', error: { type: 'client_aborted', message: 'Client disconnected' } });
                    try { res.end(); } catch (_) { /* ignore */ }
                    return;
                }
                const status = acquireErr?.status === 429 || acquireErr?.status === 503 ? acquireErr.status : 503;
                if (!res.headersSent) {
                    res.setHeader('Retry-After', acquireErr?.headers?.['Retry-After'] || '30');
                    return res.status(status).json({
                        type: 'error',
                        error: { type: 'api_error', message: acquireErr?.message || 'DeepSeek scheduler unavailable' },
                    });
                }
                try { res.end(); } catch (_) { /* ignore */ }
                return;
            }

            const account = lease?.account;
            let leaseOutcome = 'incomplete';
            if (!account || !account.token) {
                try { lease?.release('failure'); } catch (_) { /* idempotent */ }
                const msg = lastError
                    ? `No available DeepSeek account. Last error: ${lastError.message}`
                    : 'No available DeepSeek account';
                if (!res.headersSent) {
                    return res.status(503).json({
                        type: 'error',
                        error: { type: 'api_error', message: msg }
                    });
                }
                try { res.end(); } catch (_) { /* ignore */ }
                return;
            }

            try {
                const ctx = {
                    req, res, model, messages, system, tools, tool_choice, max_tokens,
                    thinking, metadata, account, startTime, lease,
                    requestSignal: requestAbortController.signal,
                };
                if (stream === true) {
                    const handlerResult = await handleAnthropicStream(ctx);
                    leaseOutcome = normalizeLeaseOutcome(handlerResult, {
                        requestSignal: requestAbortController.signal,
                        req,
                        res,
                    });
                    if (leaseOutcome === 'client_aborted' && !res.headersSent) {
                        return res.status(499).json({ type: 'error', error: { type: 'client_aborted', message: 'Client disconnected' } });
                    }
                } else {
                    const handlerResult = await handleAnthropicSync(ctx);
                    leaseOutcome = normalizeLeaseOutcome(handlerResult, {
                        requestSignal: requestAbortController.signal,
                        req,
                        res,
                    });
                    if (leaseOutcome === 'client_aborted' && !res.headersSent) {
                        return res.status(499).json({ type: 'error', error: { type: 'client_aborted', message: 'Client disconnected' } });
                    }
                }
                return; // 成功完成，退出循环
            } catch (err) {
                if (requestAbortController.signal.aborted || req.aborted || res.destroyed) {
                    leaseOutcome = 'client_aborted';
                    if (!res.headersSent) return res.status(499).json({ type: 'error', error: { type: 'client_aborted', message: 'Client disconnected' } });
                    try { res.end(); } catch (_) { /* ignore */ }
                    return;
                }
                // 响应已开始写入 → 无法换号重试，直接结束
                if (res.headersSent) {
                    leaseOutcome = 'failure';
                    logger.error('[Anthropic-DeepSeek] 响应已发送后出错，无法重试', 'ANTHROPIC_DPSK', '', err);
                    if (!res.writableEnded) {
                        try { res.end(); } catch (_) { /* ignore */ }
                    }
                    return;
                }

                // 账号被禁言：标记 + 换号
                if (err.bizCode === 5 || (err.bizData && err.bizData.is_muted)) {
                    leaseOutcome = 'upstream_error';
                    const muteUntil = err.bizData?.mute_until;
                    if (muteUntil) {
                        try { dpskAccount.markAccountMuted(account.email, muteUntil); } catch (_) { /* ignore */ }
                    }
                    triedEmails.push(account.email);
                    lastError = err;
                    logger.warn(`[Anthropic-DeepSeek] 账号 ${account.email} 被禁言，尝试下一个账号 (attempt ${attempt + 1})`, 'ANTHROPIC_DPSK');
                    continue;
                }

                // 限流：429 / rate limit
                const lowMsg = String(err.message || '').toLowerCase();
                if (lowMsg.includes('429') || lowMsg.includes('rate limit') || lowMsg.includes('too many')) {
                    leaseOutcome = 'upstream_error';
                    triedEmails.push(account.email);
                    lastError = err;
                    try { dpskAccount.markAccountFailed(account.email, 120 * 1000, '429/rate limit'); } catch (_) { /* ignore */ }
                    logger.warn(`[Anthropic-DeepSeek] 账号 ${account.email} 触发限流: ${err.message}，换号重试 (attempt ${attempt + 1})`, 'ANTHROPIC_DPSK');
                    continue;
                }

                // 认证错误（401/403/token）：排除当前账号并轮换，不触发运行时重登
                if (lowMsg.includes('401') || lowMsg.includes('403') || lowMsg.includes('token')) {
                    leaseOutcome = 'upstream_error';
                    triedEmails.push(account.email);
                    lastError = err;
                    logger.warn(`[Anthropic-DeepSeek] 账号 ${account.email} 认证失效: ${err.message}，换号重试 (attempt ${attempt + 1})`, 'ANTHROPIC_DPSK');
                    continue;
                }

                // 其它未分类错误：直接返回（不再重试）
                leaseOutcome = 'failure';
                logger.error('[Anthropic-DeepSeek] 处理失败', 'ANTHROPIC_DPSK', '', err);
                return res.status(500).json({
                    type: 'error',
                    error: { type: 'api_error', message: err.message || 'Internal error' }
                });
            } finally {
                try { lease.release(leaseOutcome); } catch (_) { /* idempotent */ }
            }
        }

        // 所有重试均失败
        if (!res.headersSent) {
            return res.status(503).json({
                type: 'error',
                error: {
                    type: 'api_error',
                    message: lastError
                        ? `All DeepSeek accounts exhausted. Last error: ${lastError.message}`
                        : 'No available DeepSeek account',
                }
            });
        }
        if (!res.writableEnded) {
            try { res.end(); } catch (_) { /* ignore */ }
        }
    } catch (error) {
        logger.error('[Anthropic-DeepSeek] 处理失败', 'ANTHROPIC_DPSK', '', error);
        if (!res.headersSent) {
            res.status(500).json({
                type: 'error',
                error: { type: 'api_error', message: error.message || 'Internal error' }
            });
        } else if (!res.writableEnded) {
            try { res.end(); } catch (_) { /* ignore */ }
        }
    }
}

module.exports = { handleAnthropicDeepSeek };
