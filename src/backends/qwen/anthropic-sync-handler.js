/**
 * Qwen 路线 Anthropic 协议同步（非流式）响应处理器
 *
 * 从 src/controllers/anthropic.js 提取，独立为可复用的同步处理模块。
 *
 * # 职责
 *
 * 上游 SSE 全量缓冲 → 工具调用离线解析 → 一次性写出 Anthropic message JSON。
 *
 * # 入参 ctx
 *
 * handleAnthropicSync(ctx) 中 ctx 必须包含：
 *   res, upstream, message_id, model, hasTools, toolChoice, requestBody, toolNames,
 *   rawTools, rawMessages, requestId, currentAccount, clientProfile, retryCount,
 *   latency, req
 */
const { sendChatRequest } = require('./request.js');
const accountManager = require('../../utils/account.js');
const { createUsageObject } = require('../../utils/precise-tokenizer.js');
const { logger } = require('../../utils/logger');
const { buildGenericNoToolCallHint } = require('../../shared/tool-injection');
const { attributeChatUsage } = require('../../utils/usage-tracker.js');
const { logInterruption, logAnomaly } = require('../../utils/chat-interruption-monitor.js');
const {
    markFirstUpstreamEvent,
    setLatencyFields
} = require('../../utils/chat-latency-monitor.js');
const strictToolMode = require('../../utils/strict-tool-mode.js');
const claudeCodeProfile = require('../../agents/claude-code-profile.js');
const { shouldRequireStopReasonToolUse } = require('../../shared/anthropic-helpers.js');
const {
    shouldDropToolPreamble,
    isStrictToolUse,
    isStrictToolModeActive,
    resolveToolCallsWithStrictMode,
    appendRetryHint,
    requiresToolCall,
    buildRequiredRetryHint,
    buildUnknownToolCallHint,
    looksLikeToolCallAttempt,
    looksLikeIntendsToCallTool,
    looksLikeFinalReport,
    isTextEssentiallyEmpty,
    extractToolCallsFromBuffer,
    consumeUpstream
} = require('./anthropic-utils.js');
const {
    isThinkingPhase,
    extractThinkingSummaryDelta
} = require('./stream-utils');

// ===========================================================================
// 同步专用辅助
// ===========================================================================

/**
 * 非流式长任务保活：定期写 JSON whitespace，避免客户端超时
 * 最终完整 JSON 仍由 writeAnthropicJsonPayload 输出。
 * @param {object} res - Express 响应
 * @returns {() => void} stop 函数
 */
const startAnthropicNonStreamKeepalive = (res) => {
    const appConfig = require('../../config/index.js');
    const intervalMs = Number(appConfig.nonStreamKeepaliveIntervalMs) || 0;
    if (intervalMs <= 0) return () => {};
    try {
        if (!res.headersSent) {
            res.set({ 'Content-Type': 'application/json' });
        }
    } catch (_) {}
    const timer = setInterval(() => {
        try {
            if (!res.writableEnded && !res.destroyed) {
                res.write('\n');
            }
        } catch (_) { /* client disconnected */ }
    }, intervalMs);
    const stop = () => clearInterval(timer);
    try { res.once?.('close', stop); } catch (_) {}
    return stop;
};

/**
 * 写入完整的 Anthropic JSON 响应（兼容 headersSent 情况）
 * @param {object} res - Express 响应
 * @param {Object} payload - JSON payload
 */
const writeAnthropicJsonPayload = (res, payload) => {
    const body = JSON.stringify(payload);
    if (res.headersSent) {
        res.end(body);
    } else {
        res.json(payload);
    }
};

// ===========================================================================
// 主流程
// ===========================================================================

/**
 * 处理非流式 Anthropic 响应
 * @param {Object} ctx - 处理上下文（单参 ctx，与 DeepSeek backends 对齐）
 * @param {object} ctx.res - Express 响应
 * @param {object} ctx.upstream - 上游 axios 响应
 * @returns {Promise<void>} 完成 Promise
 */
const handleAnthropicSync = async (ctx) => {
    const { res, upstream } = ctx;
    const { message_id, model, hasTools, toolChoice, requestBody, toolNames, rawTools, rawMessages, requestId } = ctx;
    const latency = ctx.latency || ctx.req?.chatLatency || null;
    setLatencyFields(latency, { requestId });
    const activeProfile = ctx.clientProfile || claudeCodeProfile;
    const dropPreamble = shouldDropToolPreamble(activeProfile);
    const requireToolUseStopReason = shouldRequireStopReasonToolUse(activeProfile);
    const strictToolUse = isStrictToolUse(activeProfile);
    const strictModeEnabled = isStrictToolModeActive(hasTools, toolChoice, activeProfile);
    const profileMaxRetry = Number((activeProfile && activeProfile.profile && activeProfile.profile.maxCorrectionRetry) || 0);
    const stopNonStreamKeepalive = startAnthropicNonStreamKeepalive(res);

    let thinkingContent = '';
    let answerContent = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let webSearchInfo = null;
    let usageSource = 'upstream';
    // thinking_summary 阶段去重:与 stream handler 对齐,跳过连续重复的 summary 内容
    let lastThinkingSummaryContent = '';
    let strictRetryPromptTokens = 0;
    let strictRetryCompletionTokens = 0;
    let strictBlocked = false;
    let strictRetryUsed = false;
    let strictFallbackUsed = false;
    let strictDecisionKind = '';
    // 与 handleAnthropicStream 对齐，声明上游事件统计变量（避免隐式全局污染）
    let upstreamEvents = 0;
    let upstreamParseErrors = 0;
    let answerChars = 0;
    let thinkingChars = 0;
    // 调度器租约 outcome 跟踪：在各出口点释放 lease，确保 inFlight 计数器递减
    let syncOutcome = 'incomplete'
    const releaseLease = () => {
        try {
            if (ctx && ctx.req && ctx.req.lease && typeof ctx.req.lease.release === 'function') {
                ctx.req.lease.release(syncOutcome)
            }
        } catch (_e) { /* 幂等，忽略 */ }
    }

    /**
     * 处理一个上游 delta JSON
     * @param {Object} json - 上游 SSE delta
     */
    const onUpstreamDelta = async (json) => {
        if (!json.choices || json.choices.length === 0) return;
        if (json.usage) {
            promptTokens = json.usage.prompt_tokens || promptTokens;
            completionTokens = json.usage.completion_tokens || completionTokens;
        }
        const delta = json.choices[0].delta;
        // thinking_summary 事件：从 extra.summary_thought.content 提取 thinking 增量
        // （content 字段为空，真实文本在累积数组里，只取最后一个元素作为本次增量）
        extractThinkingSummaryDelta(delta);
        if (delta && delta.name === 'web_search') {
            webSearchInfo = delta.extra?.web_search_info;
        }
        if (!delta || !delta.content || (!isThinkingPhase(delta.phase) && delta.phase !== 'answer')) return;
        const content = delta.content;
        // thinking_summary 阶段去重:跳过与上次相同的 summary 内容,避免累积重复文本
        if (delta.phase === 'thinking_summary' && content === lastThinkingSummaryContent) return;
        if (delta.phase === 'thinking_summary') lastThinkingSummaryContent = content;
        if (isThinkingPhase(delta.phase)) thinkingChars += content.length;
        if (delta.phase === 'answer') answerChars += content.length;
        if (isThinkingPhase(delta.phase)) {
            thinkingContent += content;
        } else if (delta.phase === 'answer') {
            answerContent += content;
        }
    };

    const consumeRetryAnswer = async (retryUpstream) => {
        // 非流式 retry 同样使用独立 answer buffer。
        // retry 无有效 tool_use 时保留首轮结果，避免重复拼接自然语言。
        let retryAnswer = '';
        let retryPromptTokens = 0;
        let retryCompletionTokens = 0;
        await consumeUpstream(retryUpstream, async (json) => {
            if (json?.usage) {
                retryPromptTokens = json.usage.prompt_tokens || retryPromptTokens;
                retryCompletionTokens = json.usage.completion_tokens || retryCompletionTokens;
            }
            if (!json?.choices || json.choices.length === 0) return;
            const delta = json.choices[0].delta;
            if (!delta || !delta.content || delta.phase !== 'answer') return;
            retryAnswer += delta.content;
        });
        return {
            answer: retryAnswer,
            promptTokens: retryPromptTokens,
            completionTokens: retryCompletionTokens
        };
    };

    const resetAccumulatedState = () => {
        thinkingContent = '';
        answerContent = '';
        promptTokens = 0;
        completionTokens = 0;
        webSearchInfo = null;
        usageSource = 'upstream';
        lastThinkingSummaryContent = '';
        strictRetryPromptTokens = 0;
        strictRetryCompletionTokens = 0;
        strictBlocked = false;
        strictRetryUsed = false;
        strictFallbackUsed = false;
        strictDecisionKind = '';
        upstreamEvents = 0;
        upstreamParseErrors = 0;
        answerChars = 0;
        thinkingChars = 0;
    };

    let activeUpstream = upstream;
    let bootstrapRetriesLeft = Math.max(0, Number(require('../../config/index.js').qwenStreamBootstrapRetries) || 0);
    while (true) {
        try {
            await consumeUpstream(activeUpstream, async (json) => {
                upstreamEvents += 1;
                if (upstreamEvents === 1) {
                    ctx?.req?.lifecycleRecorder?.record('upstream_started');
                    ctx?.req?.lifecycleRecorder?.record('first_upstream_byte');
                }
                markFirstUpstreamEvent(latency, logger, {
                    upstreamEvents
                });
                await onUpstreamDelta(json);
            }, (rawEvent) => {
                upstreamParseErrors += 1;
                logAnomaly(logger, {
                    tag: 'ANTHROPIC',
                    protocol: 'anthropic',
                    route: '/v1/messages',
                    requestId,
                    profile: activeProfile?.profile?.name,
                    model,
                    stream: false,
                    stage: 'anthropic_nonstream_sse_parse',
                    classification: 'parser_error',
                    reason: 'upstream_sse_json_parse_error',
                    account: ctx.currentAccount?.email,
                    hasTools,
                    toolChoice,
                    upstreamEvents,
                    upstreamParseErrors,
                    answerChars,
                    thinkingChars,
                    completionChars: answerContent.length,
                    errorMessage: rawEvent?.error?.message || rawEvent?.data
                });
            });
            break;
        } catch (upstreamErr) {
            logInterruption(logger, {
                tag: 'ANTHROPIC',
                protocol: 'anthropic',
                route: '/v1/messages',
                requestId,
                profile: activeProfile?.profile?.name,
                model,
                stream: false,
                stage: 'anthropic_nonstream_upstream',
                account: ctx.currentAccount?.email,
                hasTools,
                toolChoice,
                upstreamEvents,
                upstreamParseErrors,
                answerChars,
                thinkingChars,
                completionChars: answerContent.length,
                bootstrapRetriesLeft,
                canBootstrapRetry: !res.writableEnded && !res.destroyed && bootstrapRetriesLeft > 0,
                writableEnded: res.writableEnded,
                destroyed: res.destroyed
            }, upstreamErr);
            logger.error('上游流读取错误 (非流式)', 'ANTHROPIC', '', upstreamErr);
            if (!res.writableEnded && !res.destroyed && bootstrapRetriesLeft > 0) {
                bootstrapRetriesLeft -= 1;
                try {
                    logger.warning?.(`Anthropic non-stream 上游完成前断开，丢弃未完成响应并重试一次 (remaining=${bootstrapRetriesLeft})`, 'ANTHROPIC');
                    const retryResp = await sendChatRequest(requestBody, ctx.req || null, { account: ctx.currentAccount });
                    if (retryResp.status && retryResp.response) {
                        activeUpstream = retryResp.response;
                        ctx.currentAccount = retryResp.currentAccount || ctx.currentAccount;
                        resetAccumulatedState();
                        continue;
                    }
                } catch (retryErr) {
                    logger.error('Anthropic non-stream bootstrap 重试失败', 'ANTHROPIC', '', retryErr);
                }
            }
            stopNonStreamKeepalive();
            const payload = {
                type: 'error',
                error: { type: 'api_error', message: upstreamErr.message || 'Upstream error' }
            };
            if (!res.headersSent) {
                res.status(500).json(payload);
            } else {
                try { writeAnthropicJsonPayload(res, payload); } catch (_) {}
            }
            syncOutcome = 'failure';
            releaseLease();
            ctx?.req?.lifecycleRecorder?.record('lease_released');
            ctx?.req?.lifecycleRecorder?.record('request_finished');
            return;
        }
    }

    if (webSearchInfo) {
        const config = require('../../config/index.js');
        try {
            const searchTable = await accountManager.generateMarkdownTable(webSearchInfo, config.searchInfoMode);
            if (thinkingContent) {
                thinkingContent = searchTable + '\n\n' + thinkingContent;
            } else {
                answerContent = searchTable + '\n\n' + answerContent;
            }
        } catch (_) {}
    }

    let cleanedText = answerContent
    let toolCalls = []
    let toolCallsFromRetry = false
    if (hasTools) {
        const parsed = extractToolCallsFromBuffer(answerContent, toolNames, { strictToolUse })
        cleanedText = parsed.cleanedText
        toolCalls = parsed.toolCalls
    }

    if (strictModeEnabled) {
        const strictResult = await resolveToolCallsWithStrictMode({
            rawAnswer: answerContent,
            requestBody,
            toolNames,
            rawTools,
            rawMessages,
            currentAccount: ctx.currentAccount,
            consumeRetryAnswer,
            maxRetries: profileMaxRetry,
            requestId
        })
        ctx.currentAccount = strictResult.currentAccount || ctx.currentAccount
        answerContent = strictResult.rawAnswer || answerContent
        cleanedText = strictResult.parsed?.cleanedText || ''
        toolCalls = strictResult.parsed?.toolCalls || []
        toolCallsFromRetry = !!(strictResult.retryUsed || strictResult.fallbackUsed)
        strictRetryUsed = !!strictResult.retryUsed
        strictFallbackUsed = !!strictResult.fallbackUsed
        strictBlocked = !!strictResult.blocked
        strictDecisionKind = strictResult.decision?.kind || ''
        strictRetryPromptTokens = Number(strictResult.retryPromptTokens) || 0
        strictRetryCompletionTokens = Number(strictResult.retryCompletionTokens) || 0
        thinkingContent = ''
        promptTokens += strictRetryPromptTokens
        completionTokens += strictRetryCompletionTokens
    } else {

        // 1) required 重试: tool_choice=any / 指定 tool_name 但模型未触发。
        // 只有 retry 解析出工具调用才替换首轮 answer；否则 retry 文本会被丢弃。
        if (hasTools && toolCalls.length === 0 && requiresToolCall(toolChoice) && toolChoice !== 'none') {
            logger.warning?.('Anthropic 非流式: tool_choice=required 首次未触发，重试一次', 'ANTHROPIC');
            try {
                const retryResp = await sendChatRequest(appendRetryHint(requestBody, buildRequiredRetryHint(toolChoice, 0, { provider: 'qwen', tools: rawTools })), null, { account: ctx.currentAccount });
                if (retryResp.status && retryResp.response) {
                    const retryResult = await consumeRetryAnswer(retryResp.response);
                    const { toolCalls: retryCalls, cleanedText: retryCleaned } = extractToolCallsFromBuffer(retryResult.answer, toolNames, { strictToolUse });
                    if (retryCalls.length > 0) {
                        toolCalls = retryCalls;
                        toolCallsFromRetry = true;
                        thinkingContent = '';
                        answerContent = retryResult.answer;
                        cleanedText = retryCleaned;
                        promptTokens = retryResult.promptTokens || promptTokens;
                        completionTokens = retryResult.completionTokens || completionTokens;
                    }
                }
            } catch (e) {
                logger.error('Anthropic 非流式重试失败', 'ANTHROPIC', '', e);
            }
        }

        // Generic profile retry mirrors the streaming branch: retry only when the
        // answer looks like tool intent, empty output, or an unavailable-tool attempt.
        const firstAnswerForIntent = answerContent
        const looksLikeIntentNonStream = looksLikeIntendsToCallTool(firstAnswerForIntent)
        const emptyAnswerNonStream = isTextEssentiallyEmpty(firstAnswerForIntent)
        const looksLikeUnknownToolNonStream = looksLikeToolCallAttempt(firstAnswerForIntent)
        const looksLikeFinalNonStream = looksLikeFinalReport(firstAnswerForIntent)
        const canRetryNonStream = ctx.retryCount < profileMaxRetry
        // Final reports skip retry and go straight to response assembly.
        const shouldGenericRetryNonStream = hasTools
            && toolCalls.length === 0
            && !requiresToolCall(toolChoice)
            && toolChoice !== 'none'
            && canRetryNonStream
            && !looksLikeFinalNonStream
            && (looksLikeIntentNonStream || emptyAnswerNonStream || looksLikeUnknownToolNonStream)
        if (shouldGenericRetryNonStream) {
            ctx.retryCount = (ctx.retryCount || 0) + 1
            // Choose the correction hint based on the observed failure mode.
            const hint = looksLikeUnknownToolNonStream
                ? buildUnknownToolCallHint(firstAnswerForIntent, toolNames)
                : buildGenericNoToolCallHint({ provider: 'qwen', tools: rawTools })
            logger.warning?.(`Anthropic 非流式: 通用纠偏重试一次 (${looksLikeUnknownToolNonStream ? 'unknown-tool' : 'intent-only'})`, 'ANTHROPIC');
            try {
                const retryResp = await sendChatRequest(appendRetryHint(requestBody, hint), null, { account: ctx.currentAccount });
                if (retryResp.status && retryResp.response) {
                    const retryResult = await consumeRetryAnswer(retryResp.response);
                    const { toolCalls: retryCalls, cleanedText: retryCleaned } = extractToolCallsFromBuffer(retryResult.answer, toolNames, { strictToolUse });
                    if (retryCalls.length > 0) {
                        toolCalls = retryCalls;
                        toolCallsFromRetry = true;
                        thinkingContent = '';
                        answerContent = retryResult.answer;
                        cleanedText = retryCleaned;
                        promptTokens = retryResult.promptTokens || promptTokens;
                        completionTokens = retryResult.completionTokens || completionTokens;
                    }
                }
            } catch (e) {
                logger.error('Anthropic 非流式通用纠偏重试失败', 'ANTHROPIC', '', e);
            }
        }
    }

    if (promptTokens === 0 && completionTokens === 0) {
        const usage = createUsageObject(requestBody?.messages || '', thinkingContent + answerContent, null);
        promptTokens = usage.prompt_tokens || 0;
        completionTokens = usage.completion_tokens || 0;
        usageSource = 'estimated';
    }

    const contentBlocks = [];
    if (thinkingContent && thinkingContent.trim()) {
        contentBlocks.push({ type: 'thinking', thinking: thinkingContent });
    }
    // 模型没输出工具调用就如实返回文本，反代层不构造 fallback
    if (toolCalls.length === 0 && cleanedText && cleanedText.trim()) {
        contentBlocks.push({ type: 'text', text: cleanedText });
    } else if (toolCalls.length > 0 && !dropPreamble && !toolCallsFromRetry && cleanedText && cleanedText.trim()) {
        contentBlocks.push({ type: 'text', text: cleanedText });
    }
    for (const call of toolCalls) {
        let input = {};
        try { input = JSON.parse(call.function.arguments || '{}'); } catch (_) { input = {}; }
        contentBlocks.push({
            type: 'tool_use',
            id: call.id,
            name: call.function.name,
            input
        });
    }

    // Attribute the request to the final account selected for this upstream call.
    attributeChatUsage(ctx.currentAccount, promptTokens, completionTokens, {
        usageSource,
        requests: 1,
        blocked: strictBlocked,
        retryPromptTokens: strictRetryPromptTokens,
        retryCompletionTokens: strictRetryCompletionTokens,
        provider: 'qwen',
        model: model || ''
    });

    // Claude Code expects stop_reason=tool_use whenever a tool block is emitted.
    const hasToolUseBlock = contentBlocks.some(block => block && block.type === 'tool_use')
    const finalStopReason = hasToolUseBlock
        ? (requireToolUseStopReason ? 'tool_use' : 'end_turn')
        : 'end_turn';

    if (upstreamEvents === 0 || (hasTools && !hasToolUseBlock && contentBlocks.length === 0)) {
        logAnomaly(logger, {
            tag: 'ANTHROPIC',
            protocol: 'anthropic',
            route: '/v1/messages',
            requestId,
            profile: activeProfile?.profile?.name,
            model,
            stream: false,
            stage: 'anthropic_nonstream_finish',
            reason: upstreamEvents === 0 ? 'upstream_finished_without_events' : 'tool_workflow_finished_without_tool_or_text',
            account: ctx.currentAccount?.email,
            hasTools,
            toolChoice,
            upstreamEvents,
            upstreamParseErrors,
            answerChars,
            thinkingChars,
            completionChars: answerContent.length,
            toolCalls: contentBlocks.filter(block => block && block.type === 'tool_use').length,
            retryUsed: strictRetryUsed,
            fallbackUsed: strictFallbackUsed,
            stopReason: finalStopReason,
            usageSource
        });
    }

    if (strictModeEnabled) {
        logger.debug(
            `[anthropic strict] requestId=${requestId || '-'} profile=${activeProfile?.profile?.name || '-'} ` +
            `hasTools=${hasTools} classification=${strictDecisionKind || '-'} retryUsed=${strictRetryUsed} ` +
            `fallbackUsed=${strictFallbackUsed} blocked=${strictBlocked} stopReason=${finalStopReason} ` +
            `account=${ctx.currentAccount?.email || '-'} upstreamCloseKind=completed usageSource=${usageSource}`,
            'ANTHROPIC'
        );
    }

    stopNonStreamKeepalive();
    res.set({ 'Content-Type': 'application/json' });
    writeAnthropicJsonPayload(res, {
        id: message_id,
        type: 'message',
        role: 'assistant',
        model,
        content: contentBlocks,
        stop_reason: finalStopReason,
        stop_sequence: null,
        usage: { input_tokens: promptTokens, output_tokens: completionTokens }
    });
    ctx?.req?.lifecycleRecorder?.record('stream_terminal');
    syncOutcome = 'success';
    releaseLease();
    ctx?.req?.lifecycleRecorder?.record('lease_released');
    ctx?.req?.lifecycleRecorder?.record('request_finished');
}

module.exports = {
    handleAnthropicSync,
}
