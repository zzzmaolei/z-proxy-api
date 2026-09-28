/**
 * 共享工具注入模块
 *
 * 从 dpsk-chat.js 中提取的通用工具注入函数，供所有 provider controller 复用。
 * buildGenericNoToolCallHint 从 anthropic.js 移入，不再由 dpsk-chat 跨 controller 导入。
 */
const { getToolDialect, buildToolExample } = require('../utils/tool-prompt')

/**
 * 将工具系统提示词作为前缀注入到最后一条 user 消息内容中
 *
 * 基于 dpsk-chat.js 的实现：
 * - 基础逻辑一致（从后向前找最后一条 user 消息，前缀注入 toolSystemPrompt）
 * - 新增 dpsk 的 createIfEmpty 守卫：当 messages 为空但 toolSystemPrompt 有效时，自动创建一条 user 消息
 *
 * @param {Array<Object>} messages - 消息数组
 * @param {string} toolSystemPrompt - 工具系统提示词
 * @returns {Array<Object>} 修改后的消息数组（原地修改，同时返回引用）
 */
function injectToolPromptToLastUser(messages, toolSystemPrompt) {
    // dpsk 的 createIfEmpty 守卫：空数组 + 有效 prompt → 创建一条 user 消息
    if (!toolSystemPrompt || !Array.isArray(messages) || messages.length === 0) {
        if (toolSystemPrompt && Array.isArray(messages) && messages.length === 0) {
            messages.push({ role: 'user', content: toolSystemPrompt });
        }
        return messages;
    }
    const trimmedPrompt = String(toolSystemPrompt).trim();
    for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (i === 0 && (!msg || msg.role !== 'user')) {
            // 到达数组开头仍未找到 user 消息，插入新 user 消息
            messages.unshift({ role: 'user', content: toolSystemPrompt });
            return messages;
        }
        if (!msg) continue;
        if (msg.role === 'user') {
            if (typeof msg.content === 'string') {
                // 幂等性守卫：避免重试或多轮调用时重复累积注入同一段或相同类型的工具提示词
                const current = msg.content.trim();
                if (
                    current.startsWith(trimmedPrompt) ||
                    (trimmedPrompt.includes('# Tools (compact multi-turn)') && current.includes('# Tools (compact multi-turn)')) ||
                    (trimmedPrompt.includes('ZPROXY_DEEPSEEK_TOOLS_CONTINUE_V1') && current.includes('ZPROXY_DEEPSEEK_TOOLS_CONTINUE_V1'))
                ) {
                    break;
                }
                msg.content = `${toolSystemPrompt}\n\n${msg.content}`;
            } else if (Array.isArray(msg.content)) {
                const textIdx = msg.content.findIndex(c => c && c.type === 'text');
                if (textIdx >= 0) {
                    const existingText = String(msg.content[textIdx].text || '').trim();
                    if (
                        existingText.startsWith(trimmedPrompt) ||
                        (trimmedPrompt.includes('# Tools (compact multi-turn)') && existingText.includes('# Tools (compact multi-turn)')) ||
                        (trimmedPrompt.includes('ZPROXY_DEEPSEEK_TOOLS_CONTINUE_V1') && existingText.includes('ZPROXY_DEEPSEEK_TOOLS_CONTINUE_V1'))
                    ) {
                        break;
                    }
                    msg.content[textIdx].text = `${toolSystemPrompt}\n\n${msg.content[textIdx].text || ''}`;
                } else {
                    msg.content.unshift({ type: 'text', text: toolSystemPrompt });
                }
            } else {
                msg.content = `${toolSystemPrompt}`;
            }
            break;
        }
    }
    return messages;
}

/**
 * 判断 tool_choice 是否要求强制调用工具
 *
 * @param {string|Object} toolChoice - OpenAI tool_choice
 * @returns {boolean}
 */
const requiresToolCall = (toolChoice) => {
    if (toolChoice === 'required') return true;
    if (toolChoice && typeof toolChoice === 'object' && toolChoice.type === 'function' && toolChoice.function?.name) {
        return true;
    }
    return false;
};

/**
 * 构建 tool_choice=required 重试时追加的强约束提示
 *
 * 基于 dpsk-chat.js（支持 retryCount 渐进增强）的实现。
 *
 * @param {string|Object} toolChoice - OpenAI tool_choice
 * @param {number} [retryCount=0] - 当前是第几次重试（0-based），用于渐进式增强提示
 * @returns {string} 提示文本
 */
const buildRequiredRetryHint = (toolChoice, retryCount = 0, options = {}) => {
    const isUrgent = retryCount >= 1;
    const prefix = isUrgent
        ? '【严重警告】你已经连续多次没有调用工具。这是最后一次机会！'
        : '你之前的回复没有调用任何工具。';

    const dialect = getToolDialect(options.provider)
    const requestedName = toolChoice && typeof toolChoice === 'object' && toolChoice.function?.name
    const selectedTool = (options.tools || []).find(tool => (tool?.name || tool?.function?.name) === requestedName)
        || (options.tools || [])[0]
    const example = buildToolExample(selectedTool, { name: requestedName || 'tool' })
    if (requestedName) {
        return [
            `${prefix}你必须立即使用 ${dialect.open} 格式调用工具 \`${requestedName}\`，不要输出任何其他内容。`,
            '',
            '格式示例：',
            dialect.open,
            example,
            dialect.close,
            '',
            `禁止输出自然语言、解释、道歉或前置说明。直接输出 ${dialect.open} 块。`,
            isUrgent ? `如果再次失败，整个对话将被终止。立即输出 ${dialect.open}！` : ''
        ].filter(Boolean).join('\n');
    }
    return [
        `${prefix}你必须立即使用 ${dialect.open} 格式调用一个工具，不要输出任何其他内容。`,
        '',
        '格式示例：',
        dialect.open,
        example,
        dialect.close,
        '',
        `禁止输出自然语言、解释、道歉或前置说明。直接输出 ${dialect.open} 块。`,
        isUrgent ? `如果再次失败，整个对话将被终止。立即输出 ${dialect.open}！` : ''
    ].filter(Boolean).join('\n');
};

/**
 * 构建空响应重试提示
 *
 * 当模型返回空内容且无工具调用时，要求模型要么调用工具，要么给出明确答案。
 * 以 dpsk-chat.js 的版本为基准（支持 retryCount 渐进增强）。
 *
 * @param {number} [retryCount=0] - 当前是第几次重试（0-based）
 * @returns {string} 提示文本
 */
const buildEmptyResponseRetryHint = (retryCount = 0, options = {}) => {
    const isUrgent = retryCount >= 1;
    const prefix = isUrgent
        ? '【严重警告】你已经连续多次返回空响应。这是最后一次机会！'
        : '你之前的回复为空。';

    const dialect = getToolDialect(options.provider)
    const example = buildToolExample((options.tools || [])[0], { name: 'tool' })
    return [
        `${prefix}你必须立即选择以下一种方式响应：`,
        '',
        '方式 1：调用工具（如果当前任务需要工具才能完成）',
        dialect.open,
        example,
        dialect.close,
        '',
        '方式 2：给出明确的最终答案（用自然语言）',
        '',
        '禁止返回空响应。选择一种方式并立即响应。',
        isUrgent ? '如果再次返回空响应，整个对话将被终止。立即响应！' : ''
    ].filter(Boolean).join('\n');
};

/**
 * 构建"未调用任何工具"通用纠偏重试提示
 *
 * 用于 tool_choice=auto 但模型没调用工具的场景。
 * 从 anthropic.js 移入，供 dpsk-chat 等 controller 直接导入而无需跨 controller 依赖。
 *
 * @returns {string} 提示文本
 */
const buildGenericNoToolCallHint = (options = {}) => {
    const dialect = getToolDialect(options.provider)
    const example = buildToolExample((options.tools || [])[0], { name: 'tool' })
    return [
        'Your previous reply did not call any tool. The user expects you to use a tool when one is needed.',
        `Call exactly one tool using ${dialect.open}${example}${dialect.close}.`,
        'Do NOT explain, do NOT promise, do NOT output natural language, do NOT say "I will look at..." or "Let me check...".',
        `Output ONLY the ${dialect.open} block. Nothing else.`
    ].join(' ');
};

/**
 * 构建"调用了未知工具"的重试提示
 *
 * 当模型尝试调用不在 availableTools 列表中的工具（如 code_interpreter、python 等
 * 凭空发明的工具）时，构造纠偏提示把模型拉回客户端提供的工具集。
 * 从 qwen/anthropic-utils.js 提升到 shared 层，供其他 provider 复用。
 *
 * @param {string} rawBuffer - 模型原始输出 buffer
 * @param {Set<string>|Array<string>} toolNames - 当前 availableTools 名称集合
 * @returns {string} 提示文本
 */
const buildUnknownToolCallHint = (rawBuffer, toolNames) => {
    const list = Array.isArray(toolNames) ? toolNames : Array.from(toolNames || [])
    const names = list
        .map(n => (n && typeof n === 'string') ? `\`${n}\`` : '')
        .filter(Boolean)
        .join(', ')
    // 试着从 buffer 里抓出模型乱用的工具名
    let detected = ''
    try {
        if (typeof rawBuffer === 'string') {
            // 优先从 <tool_call> 块里抓
            const m = rawBuffer.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/)
            const target = m ? m[1] : rawBuffer
            const nm = target.match(/["'](?:name|tool|function)["']\s*:\s*["']([^"']+)["']/i)
            if (nm) detected = ` (you attempted to call \`${nm[1]}\` which is not in the available list)`
        }
    } catch (_) { /* ignore */ }

    return [
        `Your previous reply attempted a tool call${detected} that is NOT in the available tools list.`,
        names
            ? `You may ONLY call these tools: ${names}.`
            : 'No tools are available in this turn.',
        'If the user asks for something the available tools cannot do (e.g. Python execution, OCR, web browsing), do NOT invent a tool. Either answer from your own knowledge or say it is not possible.',
    ].join(' ')
};

module.exports = {
    injectToolPromptToLastUser,
    requiresToolCall,
    buildRequiredRetryHint,
    buildEmptyResponseRetryHint,
    buildGenericNoToolCallHint,
    buildUnknownToolCallHint,
};
