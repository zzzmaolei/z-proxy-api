/**
 * DeepSeek Anthropic 协议同步处理器
 *
 * 处理 Anthropic /v1/messages 非流式响应（stream === false），收集 DeepSeek 上游
 * generator 完整输出后一次性返回 JSON 响应。
 *
 * # 处理流程（20 步）
 *   1.  Client profile 检测
 *   2.  Normalize tools & messages
 *   3.  Flatten & fold
 *   4.  Build tool system prompt
 *   5.  Resolve model type
 *   6.  Session（缓存复用）
 *   7.  Context compression + buildPrompt
 *   8.  Setup chat options
 *   9.  Collect response（withRetry 包裹，重试时重置累积变量）
 *   10. Parse tool calls（loose 模式）
 *   11. Claude Code 同步：丢弃过程话术
 *   12. Retry: tool_choice=required
 *   13. Retry: Claude Code generic correction
 *   14. Retry: empty response
 *   15. Build content blocks
 *   16. Stop reason
 *   17. Usage
 *   18. Write JSON response
 *   19. Update session cache
 *   20. Usage attribution
 *
 * # 入参
 *   ctx: { res, req, model, messages, system, tools, tool_choice, max_tokens,
 *          thinking, account, startTime }
 */

const { logger } = require('../../utils/logger');
const dpskClient = require('./dpsk-client');
const config = require('../../config');
const claudeCodeProfile = require('../../agents/claude-code-profile');
const { generateUUID } = require('../../utils/tools');
const {
    buildToolSystemPrompt,
    buildDeepSeekToolSignature,
    foldToolMessages,
    parseLooseToolCallsFromText,
    canonicalizeToolCalls,
} = require('../../utils/tool-prompt');
const { countTokens } = require('../../utils/precise-tokenizer');
const {
    requiresToolCall,
    buildRequiredRetryHint,
    buildEmptyResponseRetryHint,
    buildGenericNoToolCallHint,
    injectToolPromptToLastUser,
} = require('../../shared/tool-injection');
const { detectProfileSafe } = require('../../shared/client-detection');
const { resolveProxyUrl } = require('../../utils/proxy-helper');
const dpskFingerprint = require('./dpsk-fingerprint');
const {
    flattenAnthropicMessages,
    extractSystemFromMessages,
    normalizeAnthropicTools,
    normalizeAnthropicToolChoice,
    hasAnthropicRequestImage,
    shouldRequireStopReasonToolUse,
    getAnthropicProfile,
} = require('../../shared/anthropic-helpers');
const { attributeAnthropicUsage } = require('../../shared/anthropic-base');
const {
    buildSessionKey,
    shouldUseDeepSeekSession,
    getCachedSession,
    prepareIncrementalMessages,
    commitSessionTurn,
    invalidateSession,
    createRequestSession,
    detectImagesAndDescribe,
    buildPrompt,
} = require('./anthropic-utils.js');
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
    measurePromptBudget,
    buildRetryPrompt,
    createPromptTooLargeError,
} = require('./prompt-budget');

function buildCompactDeepSeekToolPrompt(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return '';
    return [
        'ZPROXY_DEEPSEEK_TOOLS_CONTINUE_V1',
        ...tools.map(buildDeepSeekToolSignature),
        'Use <tool_call>{"name":"TOOL","arguments":{...}}</tool_call> with exact names and keys when a tool is needed.',
        'If no tool is needed, answer normally.',
    ].join('\n');
}

// ===========================================================================
// 同步处理器
// ===========================================================================

/**
 * DeepSeek Anthropic 同步处理器入口
 *
 * @param {Object} ctx - 上下文对象（与 handleAnthropicStream 相同）
 */
async function handleAnthropicSync(ctx) {
    const {
        res, req, model, messages, system, tools, tool_choice, max_tokens,
        thinking, account, startTime,
    } = ctx;
    const requestSignal = ctx.requestSignal || req?._dpskAbortSignal || null;
    const isRequestAborted = () => !!(
        requestSignal?.aborted || req?.aborted || res.destroyed
    );
    const outcomeForError = (error) => (
        error?.code === 'CLIENT_ABORTED'
        || error?.classification === 'client_aborted'
        || error?.code === 'client_disconnected'
        || isRequestAborted()
            ? 'client_aborted'
            : 'failure'
    );

    const messageId = `msg_${generateUUID().replace(/-/g, '').slice(0, 24)}`;

    // ---- 1. Client profile ----
    const clientProfile = req.clientProfile || detectProfileSafe(req);
    const isClaudeCode = clientProfile && clientProfile.name === 'claude-code';
    const activeProfile = getAnthropicProfile(req);

    // ---- 2. Normalize ----
    const normalizedTools = normalizeAnthropicTools(tools);
    const hasTools = normalizedTools.length > 0 && tool_choice !== 'none';
    const toolChoice = normalizeAnthropicToolChoice(tool_choice) || 'auto';
    const hasUserImage = hasAnthropicRequestImage(messages);

    // ---- 3. Flatten & fold ----
    // Claude Code 某些版本会把 system 消息放到 messages 数组里，这里先提取出来
    // 合并到顶级 system 字段（在 step 7 的 prefixParts 里使用）。
    const { messages: pureMessages, systemText: extractedSystem } = extractSystemFromMessages(messages);
    let flatMessages = flattenAnthropicMessages(pureMessages);
    // 用 XML 版折叠，与 buildToolSystemPrompt 教的 tool_response 格式一致（见 stream-handler 注释）。
    flatMessages = foldToolMessages(flatMessages);

    // ---- 4. Tool system prompt ----
    let toolSystemPrompt = '';
    if (hasTools) {
        toolSystemPrompt = buildToolSystemPrompt(normalizedTools, {
            tool_choice: toolChoice,
            hasUserImage,
            claudeCodeProfile: isClaudeCode,
            provider: 'deepseek',
        });
    }

    // ---- 5. Resolve model type ----
    const modelOptions = dpskClient.resolveModelOptions(model, {
        thinking: thinking || undefined,
    });
    const promptBudgetOptions = {
        modelCapabilities: modelOptions.capabilities,
    };
    const modelType = modelOptions.modelType;
    const requestedMaxTokens = (typeof max_tokens === 'number' && max_tokens > 0) ? max_tokens : null;
    const declaredMaxOutputTokens = Number(modelOptions.capabilities?.max_output_tokens);
    const maxOutputCap = Number.isFinite(declaredMaxOutputTokens) && declaredMaxOutputTokens > 0
        ? declaredMaxOutputTokens
        : null;
    const appliedMaxTokens = Math.min(requestedMaxTokens || 65536, maxOutputCap || Number.MAX_SAFE_INTEGER);
    const thinkingEnabled = modelOptions.capabilities?.thinking_supported === false
        ? false
        : modelOptions.thinkingEnabled;
    res.set?.('x-dpsk-capability-source', String(modelOptions.capabilitySource || 'heuristic'));
    const thinkingSupport = modelOptions.capabilities?.thinking_supported;
    res.set?.('x-dpsk-model-type', String(modelType));
    res.set?.('x-dpsk-thinking-enabled', String(thinkingEnabled));
    res.set?.('x-dpsk-thinking-supported', thinkingSupport == null ? 'unknown' : String(thinkingSupport));
    if (modelOptions.capabilities?.context_window) {
        res.set?.('x-dpsk-context-window', String(modelOptions.capabilities.context_window));
    }
    if (modelOptions.capabilities?.max_output_tokens) {
        res.set?.('x-dpsk-max-output-tokens', String(modelOptions.capabilities.max_output_tokens));
    }
    if (modelOptions.capabilities?.input_character_limit) {
        res.set?.('x-dpsk-input-character-limit', String(modelOptions.capabilities.input_character_limit));
    }
    res.set?.('x-dpsk-requested-max-tokens', requestedMaxTokens == null ? 'unset' : String(requestedMaxTokens));
    res.set?.('x-dpsk-applied-max-tokens', String(appliedMaxTokens));

    // ---- 5.5 Vision→Pro 图片代理：检测图片并调 vision 模型描述注入 ----
    // 与 OpenAI 路线 dpsk-chat.js:287-377 一致；与 stream-handler 对称。
    const proxyUrlSync = resolveProxyUrl(account);
    const fingerprintSync = dpskFingerprint.getFingerprint(account?.email || '');
    try {
        flatMessages = await detectImagesAndDescribe(flatMessages, {
            account, modelType, proxyUrl: proxyUrlSync, fingerprint: fingerprintSync,
            requestId: messageId,
            signal: requestSignal,
        });
    } catch (visionErr) {
        logger.warn(`[DPSK-Anth] 同步 Vision→Pro 代理失败: ${visionErr.message}`, 'DPSK');
        res.status(400).json({
            type: 'error',
            error: { type: 'invalid_request_error', message: `Image processing failed: ${visionErr.message}` },
        });
        return outcomeForError(visionErr);
    }

    // ---- 6. Prompt/session selection ----
    const sessionKey = buildSessionKey(req, messages, account?.email);
    const continuityEnabled = shouldUseDeepSeekSession(req, { clientProfile });
    let cachedSession = continuityEnabled
        ? getCachedSession(sessionKey, {
            accountEmail: account?.email,
            modelType,
            continuityEnabled,
        })
        : null;
    const fullSystem = [system || '', extractedSystem].filter(Boolean).join('\n\n');
    let selection = continuityEnabled
        ? prepareIncrementalMessages(flatMessages, cachedSession, fullSystem)
        : { messages: flatMessages, isFull: true, reset: false, reason: 'continuity-disabled' };
    if (selection.reset && cachedSession) {
        invalidateSession(sessionKey, `history reset (${selection.reason})`, cachedSession);
        cachedSession = null;
        selection = { messages: flatMessages, isFull: true, reset: false, reason: 'reset-to-full' };
    }

    let prompt;
    {
        const promptMessages = selection.messages.map(message => ({
            ...message,
            content: Array.isArray(message?.content)
                ? message.content.map(block => ({ ...block }))
                : message?.content,
            tool_calls: Array.isArray(message?.tool_calls)
                ? message.tool_calls.map(call => ({ ...call, function: call?.function ? { ...call.function } : call?.function }))
                : message?.tool_calls,
        }));
        const effectiveToolPrompt = selection.isFull
            ? toolSystemPrompt
            : buildCompactDeepSeekToolPrompt(normalizedTools);
        const prefixParts = selection.isFull
            ? [fullSystem, effectiveToolPrompt].filter(Boolean)
            : [effectiveToolPrompt].filter(Boolean);
        if (prefixParts.length > 0) {
            injectToolPromptToLastUser(promptMessages, prefixParts.join('\n\n---\n\n'));
        }
        prompt = buildPrompt(promptMessages, { canonicalEnvelope: hasTools });
    }

    if (!prompt || !prompt.trim()) {
        res.status(400).json({
            type: 'error',
            error: { type: 'invalid_request_error', message: 'Empty prompt after message conversion' },
        });
        return outcomeForError(null);
    }

    const promptBudget = measurePromptBudget(prompt, {
        messageCount: selection.messages.length,
        toolCount: hasTools ? normalizedTools.length : 0,
        hasToolHistory: flatMessages.some((message) => message?.role === 'tool' || message?.tool_calls?.length),
    }, promptBudgetOptions);
    if (promptBudget.status === 'hard_limit') {
        const error = new Error(
            `DeepSeek Web context too large (${promptBudget.bytes} bytes >= ${promptBudget.hardLimit} bytes)`,
        );
        error.code = 'dpsk_prompt_too_large';
        res.status(413).json({
            type: 'error',
            error: {
                type: 'invalid_request_error',
                code: error.code,
                message: error.message,
                prompt_bytes: promptBudget.bytes,
                hard_limit_bytes: promptBudget.hardLimit,
            },
        });
        return outcomeForError(error);
    }

    // ---- 7. Session ----
    try {
        cachedSession = await createRequestSession(
            sessionKey,
            account?.token,
            flatMessages,
            modelType,
            account?.email,
            proxyUrlSync,
            fingerprintSync,
            requestSignal,
            { continuityEnabled },
        );
    } catch (sessionErr) {
        logger.error('[DPSK-Anth] 同步模式 session 失败', 'DPSK', '', sessionErr);
        res.status(500).json({
            type: 'error',
            error: { type: 'api_error', message: `Session failed: ${sessionErr.message}` },
        });
        return outcomeForError(sessionErr);
    }

    // ---- 8. Setup chat options ----
    const chatOptions = {
        modelType,
        thinkingEnabled,
        maxTokens: appliedMaxTokens,
        proxyUrl: proxyUrlSync,
        fingerprint: fingerprintSync,
        searchEnabled: false,  // 禁用 Web 端自带联网搜索，由 harness 工具接管
        parentMessageId: continuityEnabled && !selection.isFull
            ? cachedSession.lastMessageId
            : null,
        signal: requestSignal,
    };
    const retryCoordinator = createDeepSeekAttemptCoordinator();
    const isDisconnected = () => !!(
        requestSignal?.aborted || req.aborted || res.destroyed || res.writableEnded
    );
    const freshRetryGenerator = async (retryPrompt, retryReason, retryKind = 'semantic') => {
        const retry = await createFreshRetryGenerator({
            token: account?.token, account, chatOptions, prompt: retryPrompt, retryReason, retryKind,
            coordinator: retryCoordinator, isDisconnected,
        });
        if (continuityEnabled && cachedSession && retry.chatSessionId) {
            // A retry starts a clean Web session. The next client turn must
            // continue from this replacement session, not the failed one.
            cachedSession.chatSessionId = retry.chatSessionId;
            cachedSession.lastMessageId = null;
        }
        return retry;
    };
    const collectRetryText = async (retryPrompt, retryReason) => {
        const retry = await freshRetryGenerator(retryPrompt, retryReason);
        let retryText = '';
        let retryThinking = '';
        let retryMessageId = null;
        for await (const chunk of retry.generator) {
            if (chunk?.type === 'text') retryText += chunk.content;
            else if (chunk?.type === 'thinking') retryThinking += chunk.content;
            else if (chunk?.type === 'message_id' && chunk.content) retryMessageId = chunk.content;
        }
        return { text: retryText, thinking: retryThinking, messageId: retryMessageId };
    };

    // ---- 9. Collect response ----
    let fullText = '';
    let thinkingText = '';
    let retryBudgetBlocked = null;
    let detectedMessageId = null;

    try {
        const collectResponse = async (generator) => {
            fullText = '';
            thinkingText = '';
            detectedMessageId = null;
            for await (const chunk of generator) {
                if (!chunk) continue;
                if (chunk.type === 'text') fullText += chunk.content;
                else if (chunk.type === 'thinking') thinkingText += chunk.content;
                else if (chunk.type === 'message_id' && chunk.content) detectedMessageId = chunk.content;
            }
        };
        try {
            await collectResponse(dpskClient.sendChatMessage(account?.token, cachedSession.chatSessionId, prompt, chatOptions));
        } catch (initialError) {
            if (!isRetryableTransportError(initialError)) throw initialError;
            const retry = await freshRetryGenerator(prompt, 'transport', 'transport');
            await collectResponse(retry.generator);
        }
    } catch (collectErr) {
        logger.error('[DPSK-Anth] 同步收集失败', 'DPSK', '', collectErr);
        if (continuityEnabled) invalidateSession(sessionKey, 'incomplete Anthropic sync response', cachedSession);
        res.status(500).json({
            type: 'error',
            error: { type: 'api_error', message: collectErr.message },
        });
        return outcomeForError(collectErr);
    }

    // ---- 10. Parse tool calls ----
    let toolCalls = [];
    let cleanedText = fullText;
    const reparseTools = Array.isArray(tools) ? tools : [];
    if (hasTools) {
        const parsed = parseLooseToolCallsFromText(fullText, reparseTools);
        toolCalls = canonicalizeToolCalls(parsed.toolCalls, Array.isArray(tools) ? tools : []);
        cleanedText = parsed.cleanedText;
    }

    // ---- 11. Claude Code sync: drop preamble ----
    if (isClaudeCode && hasTools && toolCalls.length === 0 && fullText
        && !claudeCodeProfile.looksLikeFinalReport(fullText)
        && claudeCodeProfile.looksLikeIntendsToCallTool(fullText)) {
        cleanedText = '';
        logger.info('[DPSK-Anth] 同步模式丢弃过程话术', 'DPSK');
    }

    const looksLikeFinalSync = isClaudeCode && fullText && claudeCodeProfile.looksLikeFinalReport(fullText);

    // ---- 12. Retry: tool_choice=required ----
    const MAX_SYNC_REQUIRED_RETRIES = 1;
    if (hasTools && toolCalls.length === 0 && requiresToolCall(toolChoice)
        && shouldRetrySemantic({ toolChoice, hasTools, reason: 'required' })) {
        for (let retryIdx = 0; retryIdx < MAX_SYNC_REQUIRED_RETRIES; retryIdx++) {
            logger.warning?.(`[DPSK-Anth] tool_choice=required 同步第 ${retryIdx + 1} 次重试`, 'DPSK');
            const retryHint = buildRequiredRetryHint(toolChoice, retryIdx, { provider: 'deepseek', tools: normalizedTools });
            const retryPlan = buildRetryPrompt(prompt, retryHint, {
                toolCount: Array.isArray(normalizedTools) ? normalizedTools.length : 0,
            }, promptBudgetOptions);
            if (!retryPlan.allowed) {
                retryBudgetBlocked = createPromptTooLargeError(retryPlan.budget);
                logger.warning?.(`[DPSK-Anth] required retry skipped: prompt=${retryPlan.budget.bytes}B hard=${retryPlan.budget.hardLimit}B`, 'DPSK');
                break;
            }
            const retryPrompt = retryPlan.prompt;
            try {
                const retryResult = await collectRetryText(retryPrompt, 'required');
                const retryText = retryResult.text;
                if (retryResult.thinking) thinkingText = retryResult.thinking;
                if (retryResult.messageId !== null) detectedMessageId = retryResult.messageId;
                const retryParsed = parseLooseToolCallsFromText(retryText, reparseTools);
                if (retryParsed.toolCalls.length > 0) {
                    toolCalls = canonicalizeToolCalls(retryParsed.toolCalls, Array.isArray(tools) ? tools : []);
                    cleanedText = retryParsed.cleanedText;
                    fullText = retryText;
                    break;
                }
                cleanedText = retryParsed.cleanedText || cleanedText;
                fullText = retryText;
            } catch (retryErr) {
                if (isRetryBudgetError(retryErr)) break;
                logger.error(`[DPSK-Anth] required 同步第 ${retryIdx + 1} 次重试失败`, 'DPSK', '', retryErr);
                continue;
            }
        }
    }

    // ---- 13. Retry: Claude Code generic correction ----
    if (isClaudeCode && hasTools && toolCalls.length === 0 && fullText && fullText.trim()
        && !looksLikeFinalSync && toolChoice !== 'none' && !requiresToolCall(toolChoice)
        && claudeCodeProfile.looksLikeIntendsToCallTool(fullText)
        && shouldRetrySemantic({
            toolChoice,
            hasTools,
            reason: 'generic',
            responseText: fullText,
            explicitToolIntent: true,
        })) {
        const genericHint = buildGenericNoToolCallHint({ provider: 'deepseek', tools: normalizedTools });
        logger.warning?.('[DPSK-Anth] Claude Code 同步通用纠偏', 'DPSK');
        const retryPlan = buildRetryPrompt(prompt, genericHint, {
            toolCount: Array.isArray(normalizedTools) ? normalizedTools.length : 0,
        }, promptBudgetOptions);
        if (!retryPlan.allowed) {
            logger.warning?.(`[DPSK-Anth] generic retry skipped: prompt=${retryPlan.budget.bytes}B hard=${retryPlan.budget.hardLimit}B`, 'DPSK');
        } else {
        const retryPrompt = retryPlan.prompt;
        try {
            const retryResult = await collectRetryText(retryPrompt, 'generic');
            const retryText = retryResult.text;
            if (retryResult.thinking) thinkingText = retryResult.thinking;
            if (retryResult.messageId !== null) detectedMessageId = retryResult.messageId;
            const retryParsed = parseLooseToolCallsFromText(retryText, reparseTools);
            if (retryParsed.toolCalls.length > 0) {
                toolCalls = canonicalizeToolCalls(retryParsed.toolCalls, Array.isArray(tools) ? tools : []);
                cleanedText = retryParsed.cleanedText;
                fullText = retryText;
                logger.info('[DPSK-Anth] 同步通用纠偏成功', 'DPSK');
            }
        } catch (retryErr) {
            if (!isRetryBudgetError(retryErr)) logger.error('[DPSK-Anth] 同步通用纠偏失败', 'DPSK', '', retryErr);
        }
        }
    }

    // ---- 14. Retry: empty response ----
    // prompt 过大（>200KB ≈ 50K tokens）时上游必然返回空响应，重试只会让 prompt 更大，跳过
    const MAX_SYNC_EMPTY_RETRIES = 1;
    if (hasTools && !cleanedText.trim() && toolCalls.length === 0 && toolChoice !== 'none'
        && promptBudget.status === 'ok'
        && shouldRetrySemantic({
            toolChoice,
            hasTools,
            reason: 'empty',
            responseText: fullText,
            thinkingText,
        })) {
        for (let retryIdx = 0; retryIdx < MAX_SYNC_EMPTY_RETRIES; retryIdx++) {
            logger.warning?.(`[DPSK-Anth] 同步空响应第 ${retryIdx + 1} 次重试`, 'DPSK');
            const emptyRetryHint = buildEmptyResponseRetryHint(retryIdx, { provider: 'deepseek', tools: normalizedTools });
            const retryPlan = buildRetryPrompt(prompt, emptyRetryHint, {
                toolCount: Array.isArray(normalizedTools) ? normalizedTools.length : 0,
            }, promptBudgetOptions);
            if (!retryPlan.allowed) {
                retryBudgetBlocked = createPromptTooLargeError(retryPlan.budget);
                logger.warning?.(`[DPSK-Anth] empty retry skipped: prompt=${retryPlan.budget.bytes}B hard=${retryPlan.budget.hardLimit}B`, 'DPSK');
                break;
            }
            const retryPrompt = retryPlan.prompt;
            try {
                const retryResult = await collectRetryText(retryPrompt, 'empty');
                const retryText = retryResult.text;
                if (retryResult.thinking) thinkingText = retryResult.thinking;
                if (retryResult.messageId !== null) detectedMessageId = retryResult.messageId;
                const retryParsed = parseLooseToolCallsFromText(retryText, reparseTools);
                if (retryParsed.toolCalls.length > 0) {
                    toolCalls = canonicalizeToolCalls(retryParsed.toolCalls, Array.isArray(tools) ? tools : []);
                    cleanedText = retryParsed.cleanedText;
                    fullText = retryText;
                    break;
                }
                if (retryParsed.cleanedText.trim()) {
                    cleanedText = retryParsed.cleanedText;
                    fullText = retryText;
                    break;
                }
                fullText = retryText;
            } catch (retryErr) {
                if (isRetryBudgetError(retryErr)) break;
                logger.error(`[DPSK-Anth] 同步空响应第 ${retryIdx + 1} 次重试失败`, 'DPSK', '', retryErr);
                continue;
            }
        }
    }

    if (retryBudgetBlocked && (requiresToolCall(toolChoice)
        || (!cleanedText.trim() && !thinkingText.trim() && toolCalls.length === 0))) {
        if (continuityEnabled) invalidateSession(sessionKey, 'Anthropic sync retry budget exceeded', cachedSession);
        res.status(413).json({
            type: 'error',
            error: {
                type: 'invalid_request_error',
                code: retryBudgetBlocked.code,
                message: retryBudgetBlocked.message,
                prompt_bytes: retryBudgetBlocked.budget?.bytes,
                hard_limit_bytes: retryBudgetBlocked.budget?.hardLimit,
            },
        });
        return outcomeForError(retryBudgetBlocked);
    }

    if (requiresToolCall(toolChoice) && !hasRequiredToolCall(toolCalls, toolChoice)) {
        const error = createToolCallRequiredError(toolChoice);
        if (continuityEnabled) invalidateSession(sessionKey, 'Anthropic sync required tool call missing', cachedSession);
        res.status(error.statusCode || 422).json({
            type: 'error',
            error: {
                type: 'invalid_request_error',
                code: error.code,
                message: error.message,
            },
        });
        return outcomeForError(error);
    }

    // ---- 15. Build content blocks ----
    const contentBlocks = [];
    // DeepSeek Web does not provide Anthropic's signed thinking blocks. The
    // streaming writer already suppresses them; keep sync responses aligned
    // so Claude Code never receives an unverifiable `thinking` block.
    if (toolCalls.length === 0 && cleanedText && cleanedText.trim()) {
        contentBlocks.push({ type: 'text', text: cleanedText });
    } else if (toolCalls.length === 0 && (!cleanedText || !cleanedText.trim())) {
        if (fullText && fullText.trim()) {
            contentBlocks.push({ type: 'text', text: fullText });
        }
    }

    for (const call of toolCalls) {
        let input = {};
        try { input = JSON.parse(call.function.arguments || '{}'); } catch (_) { input = {}; }
        contentBlocks.push({
            type: 'tool_use',
            id: call.id,
            name: call.function.name,
            input,
        });
    }

    const hasToolUseBlock = contentBlocks.some(b => b && b.type === 'tool_use');

    if (contentBlocks.length === 0) {
        if (continuityEnabled) invalidateSession(sessionKey, 'Anthropic sync returned empty content', cachedSession);
        res.status(502).json({
            type: 'error',
            error: { type: 'api_error', message: 'DeepSeek upstream returned an empty response after retry budget was exhausted' },
        });
        return outcomeForError(null);
    }

    // ---- 16. Stop reason ----
    const stopReason = hasToolUseBlock
        ? (shouldRequireStopReasonToolUse(activeProfile) ? 'tool_use' : 'end_turn')
        : 'end_turn';

    // ---- 17. Usage ----
    const inputTokens = countTokens(prompt || '', model);
    const outputTokens = countTokens(fullText || '', model);

    // ---- 18. Write JSON response ----
    if (isRequestAborted()) {
        if (continuityEnabled) invalidateSession(sessionKey, 'Anthropic sync client aborted before response', cachedSession);
        return 'client_aborted';
    }
    res.json({
        id: messageId,
        type: 'message',
        role: 'assistant',
        model,
        content: contentBlocks,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    });

    if (continuityEnabled && cachedSession) {
        const committed = commitSessionTurn(sessionKey, cachedSession, flatMessages, {
            messageId: detectedMessageId,
            toolCalls,
            contextFingerprint: fullSystem,
            continuityEnabled: true,
        });
        if (!committed) {
            logger.warn('[DPSK-Anth] 完整同步响应缺少上游 message_id，下一轮将重新建立 session', 'DPSK');
        }
    }

    // ---- 20. Usage attribution ----
    attributeAnthropicUsage({
        account, inputTokens, outputTokens, provider: 'deepseek', model,
        hasOutput: !!(fullText && fullText.trim() || hasToolUseBlock),
    });

    logger.info(
        `[DPSK-Anth] 同步完成 (${Date.now() - startTime}ms, chars=${fullText.length}, ` +
        `tool_calls=${toolCalls.length}, model=${model})`,
        'DPSK',
    );
    return isRequestAborted() ? 'client_aborted' : 'success';
}

module.exports = { handleAnthropicSync };
