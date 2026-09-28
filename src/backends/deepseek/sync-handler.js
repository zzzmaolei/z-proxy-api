/**
 * DeepSeek 同步响应处理器
 *
 * 从 src/controllers/dpsk-chat.js 提取，独立为可复用的同步处理模块。
 *
 * ctx 对象必须包含以下字段：
 *   res, token, account, chatSessionId, prompt, model, chatOptions,
 *   startTime, hasTools, toolChoice, tools, clientProfile,
 *   cachedSession, sessionKey
 */

const dpskClient = require('./dpsk-client');
const { logger } = require('../../utils/logger');
const config = require('../../config');
const claudeCodeProfile = require('../../agents/claude-code-profile');
const {
    parseLooseToolCallsFromText,
    canonicalizeToolCalls,
} = require('../../utils/tool-prompt');
const { attributeChatUsage } = require('../../utils/usage-tracker');
const { countTokens } = require('../../utils/precise-tokenizer');
const {
    createDeepSeekAttemptCoordinator,
    createFreshRetryGenerator,
    isRetryBudgetError,
    isRetryableTransportError,
} = require('./retry-context');
const {
    shouldRetrySemantic,
    hasRequiredToolCall,
    createToolCallRequiredError,
} = require('./tool-retry-policy');
const {
    requiresToolCall,
    buildRequiredRetryHint,
    buildEmptyResponseRetryHint,
    buildGenericNoToolCallHint,
} = require('../../shared/tool-injection');
const { normalizeError, sendOpenAIError } = require('../../utils/provider-errors');
const { buildRetryPrompt, createPromptTooLargeError } = require('./prompt-budget');
const { commitSessionTurn, invalidateSession } = require('./anthropic-utils');

async function handleSyncResponse(ctx) {
    const { res, token, chatSessionId, prompt, model, chatOptions, startTime, hasTools, toolChoice, tools, clientProfile, cachedSession, sessionKey, account } = ctx;
    const promptBudget = ctx.promptBudget || null;
    const promptBudgetOptions = ctx.promptBudgetOptions || {};
    const sessionContinuity = ctx.sessionContinuity === true;
    const sessionMessages = ctx.sessionMessages;
    const sessionContextFingerprint = ctx.sessionContextFingerprint || '';
    const requestSignal = ctx.requestSignal || ctx.req?._dpskAbortSignal || null;
    const retryCoordinator = createDeepSeekAttemptCoordinator();
    const baseChatOptions = { ...chatOptions, parentMessageId: null, signal: requestSignal || chatOptions?.signal || null };
    const initialChatOptions = { ...chatOptions, signal: requestSignal || chatOptions?.signal || null };
    const isDisconnected = () => !!(
        requestSignal?.aborted || ctx.req?.aborted || res.destroyed || res.writableEnded
    );
    const freshRetryGenerator = async (retryPrompt, retryReason, retryKind = 'semantic') => {
        const retry = await createFreshRetryGenerator({
            token, account, chatOptions: baseChatOptions, prompt: retryPrompt, retryReason, retryKind,
            coordinator: retryCoordinator, isDisconnected,
        });
        if (sessionContinuity && cachedSession && retry.chatSessionId) {
            cachedSession.chatSessionId = retry.chatSessionId;
            cachedSession.lastMessageId = null;
        }
        return retry;
    };

    try {
        let fullText = '';
        let thinkingText = '';
        let retryBudgetBlocked = null;
        let detectedMessageId = null;

        const collectResponse = async (generator) => {
            let text = '';
            let thinking = '';
            let messageId = null;
            for await (const chunk of generator) {
                if (chunk.type === 'text') {
                    text += chunk.content;
                } else if (chunk.type === 'thinking') {
                    thinking += chunk.content;
                } else if (chunk.type === 'message_id' && chunk.content) {
                    // message_id 仅用于诊断；后续请求不会复用此 Web session。
                    messageId = chunk.content;
                }
            }
            return { text, thinking, messageId };
        };
        let collected;
        try {
            collected = await collectResponse(dpskClient.sendChatMessage(token, chatSessionId, prompt, initialChatOptions));
        } catch (initialError) {
            if (!isRetryableTransportError(initialError)) throw initialError;
            const retry = await freshRetryGenerator(prompt, 'transport', 'transport');
            collected = await collectResponse(retry.generator);
        }
        fullText = collected.text;
        thinkingText = collected.thinking;
        detectedMessageId = collected.messageId;

        // 解析工具调用
        let toolCalls = [];
        let cleanedText = fullText;
        // parseLooseToolCallsFromText 支持 XML/fence/裸JSON 三段式 + resolveToolName 工具名过滤，
        // 替代 parseToolCallsFromText（后者在无 <tool_call> 标签时 early return 漏掉裸 JSON/fence）。
        const reparseTools = Array.isArray(tools) ? tools : [];
        if (hasTools) {
            const parsed = parseLooseToolCallsFromText(fullText, reparseTools);
            // 按 OpenCode schema 对齐参数键（file_path → filePath 等）
            toolCalls = canonicalizeToolCalls(parsed.toolCalls, Array.isArray(tools) ? tools : []);
            cleanedText = parsed.cleanedText;
            if (toolCalls.length === 0 && fullText && fullText.trim() && requiresToolCall(toolChoice)) {
                logger.warn(`[DPSK-PROBLEM] tool_call 解析失败（同步）：有 tools 但 fullText 中未识别到 <tool_call>/fence/裸JSON 块 (responseChars=${String(fullText).length})`, 'DPSK');
            }
        }

        // Claude Code 专用：同步模式下丢弃过程话术
        const isClaudeCodeSync = clientProfile && clientProfile.name === 'claude-code';
        if (isClaudeCodeSync && hasTools && toolCalls.length === 0 && fullText && !claudeCodeProfile.looksLikeFinalReport(fullText) && claudeCodeProfile.looksLikeIntendsToCallTool(fullText)) {
            cleanedText = '';
            logger.info('[DPSK] 同步模式丢弃过程话术', 'DPSK');
        }

        // Hermes Agent 专用：preferToolCallsOnly — 有 tool_call 时清空文本
        const isHermesSync = clientProfile && clientProfile.name === 'hermes-agent';
        if (isHermesSync && hasTools && toolCalls.length > 0 && cleanedText) {
            cleanedText = '';
            logger.info('[DPSK] Hermes 同步模式: tool_call 命中，剥离前置文本', 'DPSK');
        }

        // tool_choice=required 渐进式重试
        const MAX_SYNC_REQUIRED_RETRIES = 1;
        if (hasTools && toolCalls.length === 0 && requiresToolCall(toolChoice)
                && shouldRetrySemantic({ toolChoice, hasTools, reason: 'required' })) {
            for (let retryIdx = 0; retryIdx < MAX_SYNC_REQUIRED_RETRIES; retryIdx++) {
                logger.warning?.(`[DPSK] tool_choice=required 首次未触发工具调用（非流式），第 ${retryIdx + 1} 次重试`, 'DPSK');
                const retryHint = buildRequiredRetryHint(toolChoice, retryIdx, { provider: 'deepseek', tools });
                const retryPlan = buildRetryPrompt(prompt, retryHint, {
                    toolCount: Array.isArray(tools) ? tools.length : 0,
                }, promptBudgetOptions);
                if (!retryPlan.allowed) {
                    retryBudgetBlocked = createPromptTooLargeError(retryPlan.budget);
                    logger.warning?.(`[DPSK] required retry skipped: prompt=${retryPlan.budget.bytes}B hard=${retryPlan.budget.hardLimit}B`, 'DPSK');
                    break;
                }
                const retryPrompt = retryPlan.prompt;

                let retryText = '';
                try {
                    const retry = await freshRetryGenerator(retryPrompt, 'required');
                    for await (const chunk of retry.generator) {
                        if (chunk.type === 'text') retryText += chunk.content;
                        else if (chunk.type === 'message_id' && chunk.content) detectedMessageId = chunk.content;
                    }
                } catch (retryError) {
                    if (isRetryBudgetError(retryError)) break;
                    throw retryError;
                }

                const retryParsed = parseLooseToolCallsFromText(retryText, reparseTools);
                if (retryParsed.toolCalls.length > 0) {
                    toolCalls = retryParsed.toolCalls;
                    cleanedText = retryParsed.cleanedText;
                    break;
                }
                cleanedText = retryParsed.cleanedText || cleanedText;
            }
        }

        // Claude Code 通用纠偏重试（intent-only narration, 非流式）：
        //   模型输出纯 narration 但没发出 <tool_call> 时，CC sync 丢弃过程话术已把 cleanedText 置空，
        //   但 fullText 仍有内容。用 buildGenericNoToolCallHint 强约束重试一次，引导模型调工具。
        //   对齐 Qwen shouldGenericRetry + 流式 handleStreamResponse 同款重试。
        if (retryBudgetBlocked && requiresToolCall(toolChoice) && !hasRequiredToolCall(toolCalls, toolChoice)) {
            throw retryBudgetBlocked;
        }

        if (requiresToolCall(toolChoice) && !hasRequiredToolCall(toolCalls, toolChoice)) {
            throw createToolCallRequiredError(toolChoice);
        }

        const syncLooksLikeFinal = isClaudeCodeSync && fullText && claudeCodeProfile.looksLikeFinalReport(fullText);
        if (isClaudeCodeSync && hasTools && toolCalls.length === 0 && fullText && fullText.trim()
                && !syncLooksLikeFinal && toolChoice !== 'none' && !requiresToolCall(toolChoice)) {
            const explicitToolIntent = claudeCodeProfile.looksLikeIntendsToCallTool(fullText);
            if (!shouldRetrySemantic({
                toolChoice,
                hasTools,
                reason: 'generic',
                responseText: fullText,
                explicitToolIntent,
            })) {
                // Normal final text must pass through unchanged.
            } else {
            const genericHint = buildGenericNoToolCallHint({ provider: 'deepseek', tools });
            logger.warning?.('[DPSK] Claude Code 通用纠偏重试 (intent-only narration, 非流式)', 'DPSK');
            const retryPlan = buildRetryPrompt(prompt, genericHint, {
                toolCount: Array.isArray(tools) ? tools.length : 0,
            }, promptBudgetOptions);
            if (!retryPlan.allowed) {
                logger.warning?.(`[DPSK] generic retry skipped: prompt=${retryPlan.budget.bytes}B hard=${retryPlan.budget.hardLimit}B`, 'DPSK');
            } else {
            const retryPrompt = retryPlan.prompt;
            let retryText = '';
            try {
                const retry = await freshRetryGenerator(retryPrompt, 'generic');
                for await (const chunk of retry.generator) {
                    if (chunk.type === 'text') retryText += chunk.content;
                    else if (chunk.type === 'message_id' && chunk.content) detectedMessageId = chunk.content;
                }
            } catch (retryError) {
                if (!isRetryBudgetError(retryError)) throw retryError;
            }
            const retryParsed = parseLooseToolCallsFromText(retryText, reparseTools);
            if (retryParsed.toolCalls.length > 0) {
                toolCalls = retryParsed.toolCalls;
                cleanedText = retryParsed.cleanedText;
                logger.info('[DPSK] Claude Code 通用纠偏重试成功 (非流式): 解析到工具调用', 'DPSK');
            }
            }
            }
        }

        // 空响应渐进式重试
        // prompt 过大（>200KB ≈ 50K tokens）时上游必然返回空响应，重试只会让 prompt 更大，跳过
        const MAX_SYNC_EMPTY_RETRIES = 1;
        if (hasTools && !cleanedText.trim() && toolCalls.length === 0 && toolChoice !== 'none'
            && (promptBudget ? promptBudget.status === 'ok' : Buffer.byteLength(String(prompt || ''), 'utf8') < 200000)
            && shouldRetrySemantic({
                toolChoice,
                hasTools,
                reason: 'empty',
                responseText: fullText,
                thinkingText,
            })) {
            for (let retryIdx = 0; retryIdx < MAX_SYNC_EMPTY_RETRIES; retryIdx++) {
                logger.warning?.(`[DPSK] 模型返回空响应（非流式），第 ${retryIdx + 1} 次重试`, 'DPSK');
                const emptyRetryHint = buildEmptyResponseRetryHint(retryIdx, { provider: 'deepseek', tools });
                const retryPlan = buildRetryPrompt(prompt, emptyRetryHint, {
                    toolCount: Array.isArray(tools) ? tools.length : 0,
                }, promptBudgetOptions);
                if (!retryPlan.allowed) {
                    retryBudgetBlocked = createPromptTooLargeError(retryPlan.budget);
                    logger.warning?.(`[DPSK] empty retry skipped: prompt=${retryPlan.budget.bytes}B hard=${retryPlan.budget.hardLimit}B`, 'DPSK');
                    break;
                }
                const retryPrompt = retryPlan.prompt;

                let retryText = '';
                try {
                const retry = await freshRetryGenerator(retryPrompt, 'empty');
                for await (const chunk of retry.generator) {
                    if (chunk.type === 'text') retryText += chunk.content;
                    else if (chunk.type === 'message_id' && chunk.content) detectedMessageId = chunk.content;
                    }
                } catch (retryError) {
                    if (isRetryBudgetError(retryError)) break;
                    throw retryError;
                }

                const retryParsed = parseLooseToolCallsFromText(retryText, reparseTools);
                if (retryParsed.toolCalls.length > 0) {
                    toolCalls = retryParsed.toolCalls;
                    cleanedText = retryParsed.cleanedText;
                    break;
                }
                if (retryParsed.cleanedText.trim()) {
                    cleanedText = retryParsed.cleanedText;
                    break;
                }
            }
        }

        if (!cleanedText.trim() && toolCalls.length === 0) {
            if (retryBudgetBlocked) throw retryBudgetBlocked;
            const emptyError = new Error(thinkingText.trim()
                ? 'DeepSeek upstream emitted reasoning without a final answer or tool call'
                : 'DeepSeek upstream returned an empty response after retry budget was exhausted');
            emptyError.code = thinkingText.trim() ? 'dpsk_reasoning_only' : 'upstream_empty_response';
            throw emptyError;
        }

        // 构建响应
        const finishReason = toolCalls.length > 0 ? 'tool_calls' : 'stop';
        const message = {
            role: 'assistant',
            content: cleanedText || null,
        };
        // Keep DeepSeek's thinking channel visible to OpenAI-compatible
        // clients, matching the Qwen sync handler. Without this field the
        // upstream can spend time reasoning successfully while the client
        // receives only the short final answer.
        if (thinkingText && config.outThink !== false) {
            message.reasoning_content = thinkingText;
        }
        if (toolCalls.length > 0) {
            message.tool_calls = toolCalls;
        }

        // 计算真实 token 数（同时用于响应 usage 和统计）
        const inputTokens = countTokens(prompt || '', model);
        const answerTokens = countTokens(fullText || '', model);
        const reasoningTokens = countTokens(thinkingText || '', model);
        const outputTokens = answerTokens + reasoningTokens;

        const response = {
            id: `dpsk-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
                index: 0,
                message,
                finish_reason: finishReason,
            }],
            usage: {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
                completion_tokens_details: {
                    reasoning_tokens: reasoningTokens,
                },
            },
        };

        if (requestSignal?.aborted || ctx.req?.aborted || res.destroyed) {
            return 'client_aborted';
        }
        res.json(response);
        logger.info(`[DPSK] 同步响应完成 (${Date.now() - startTime}ms, answerChars=${fullText.length}, reasoningChars=${thinkingText.length}, tool_calls=${toolCalls.length})`, 'DPSK');

        // 统计 token 使用量
        if (ctx.account && ctx.account.email) {
            attributeChatUsage(ctx.account, {
                prompt_tokens: inputTokens,
                completion_tokens: outputTokens,
                total_tokens: inputTokens + outputTokens,
                estimated: true,
            }, {
                usageSource: 'estimated',
                provider: 'deepseek',
                model: model || '',
            });
        }
        if (sessionContinuity && cachedSession) {
            const committed = commitSessionTurn(sessionKey, cachedSession, sessionMessages, {
                messageId: detectedMessageId,
                toolCalls,
                contextFingerprint: sessionContextFingerprint,
                continuityEnabled: true,
            });
            if (!committed) logger.warn('[DPSK] 完整响应缺少上游 message_id，下一轮将重新建立 session', 'DPSK');
        }
        return 'success';
    } catch (err) {
        if (err.bizCode !== undefined && !res.headersSent) {
            throw err;
        }
        if (sessionContinuity) invalidateSession(sessionKey, 'sync handler exception', cachedSession);
        logger.error('[DPSK] 同步响应失败', 'DPSK', '', err);
        if (!res.headersSent) {
            sendOpenAIError(res, normalizeError(err, { provider: 'dpsk', model, accountEmail: account?.email }));
        } else {
            try { res.end(); } catch (_) { /* ignore */ }
        }
        const isClientAbort = err?.code === 'CLIENT_ABORTED'
            || err?.classification === 'client_aborted'
            || err?.code === 'client_disconnected'
            || ctx.req?.aborted
            || requestSignal?.aborted
            || res.destroyed;
        return isClientAbort ? 'client_aborted' : 'failure';
    }
}

module.exports = { handleSyncResponse };
