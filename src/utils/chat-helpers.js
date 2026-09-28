const { logger } = require('./logger')

/**
 * 从消息中提取文本内容
 * @param {string|Array} content - 消息内容
 * @returns {string} 提取的文本
 */
const extractTextFromContent = (content) => {
    if (typeof content === 'string') {
        return content
    } else if (Array.isArray(content)) {
        const textParts = content
            .filter(item => item.type === 'text')
            .map(item => item.text || '')
        return textParts.join(' ')
    }
    return ''
}

/**
 * 格式化消息为文本（包含角色标注）
 * @param {object} message - 单条消息
 * @returns {string} 格式化后的消息文本
 */
const formatSingleMessage = (message) => {
    const role = message.role
    const content = extractTextFromContent(message.content)
    return content.trim() ? `${role}:${content}` : ''
}

/**
 * 格式化历史消息为文本前缀
 * @param {Array} messages - 消息数组(不包含最后一条)
 * @returns {string} 格式化后的历史消息
 */
const formatHistoryMessages = (messages) => {
    const formattedParts = []

    for (let message of messages) {
        const formatted = formatSingleMessage(message)
        if (formatted) {
            formattedParts.push(formatted)
        }
    }

    return formattedParts.length > 0 ? formattedParts.join('\n---\n') : ''
}

/**
 * 从消息对象中提取纯文本（string content 或 array content 中的 text 项）
 * @param {Object} msg - 消息对象
 * @returns {string}
 */
const extractText = (msg) => {
    if (!msg) return ''
    if (typeof msg.content === 'string') return msg.content
    if (Array.isArray(msg.content)) {
        return msg.content
            .filter(c => c && (c.type === 'text' || typeof c.text === 'string'))
            .map(c => c.text || '')
            .join('\n')
    }
    return ''
}

/**
 * 找最后一条 user 消息的索引
 * @param {Array} messages
 * @returns {number}
 */
const findLastUserIndex = (messages) => {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i] && messages[i].role === 'user') return i
    }
    return -1
}

/**
 * 找到两个字符串的最长公共前缀长度
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
const findCommonPrefix = (a, b) => {
    const minLen = Math.min(a.length, b.length)
    let i = 0
    while (i < minLen && a[i] === b[i]) i++
    return i
}

/**
 * 移除 msg content 的前 skipChars 字符（用于剥离注入的 prompt 前缀）
 *   - string content: 直接 slice
 *   - array content: 只处理第一个 text 项，slice 其 text
 *   - 其他: 原样返回
 * @param {Object} msg
 * @param {number} skipChars - 要移除的前缀字符数
 * @returns {Object}
 */
const sliceMessageContent = (msg, skipChars) => {
    if (skipChars <= 0) return msg
    if (typeof msg.content === 'string') {
        return { ...msg, content: msg.content.slice(skipChars) }
    }
    if (Array.isArray(msg.content)) {
        let remaining = skipChars
        const newContent = msg.content.map((item) => {
            if (item && (item.type === 'text' || typeof item.text === 'string') && remaining > 0) {
                const t = item.text || ''
                if (t.length <= remaining) {
                    remaining -= t.length
                    return null
                }
                const sliced = { ...item, text: t.slice(remaining) }
                remaining = 0
                return sliced
            }
            return item
        }).filter(Boolean)
        return { ...msg, content: newContent }
    }
    return msg
}

/**
 * 移除历史 user 消息中的 tool/system prompt 前缀
 *
 * 问题：Qwen 和 DeepSeek 路线都通过 injectToolPromptToLastUser 把 system/tool prompt
 * 注入到最后一条 user 消息的 content 前缀。多轮对话中，历史消息里的 user content 仍然
 * 包含当时注入的 prompt 副本，导致 context 线性膨胀。
 *
 * 策略：找到所有 user 消息中重复出现的前缀（通常就是 toolSystemPrompt 文本），
 * 只在最后一条 user 消息中保留，历史 user 消息中移除。
 *
 * @param {Array} messages - 消息数组
 * @param {string} [knownPrefix] - 已知的 tool system prompt（用于精确匹配），不传则启发式检测
 * @returns {Array} 修改后的消息数组
 */
const stripDuplicateUserPrefixes = (messages, knownPrefix) => {
    if (!Array.isArray(messages) || messages.length <= 1) return messages

    const lastUserIdx = findLastUserIndex(messages)
    if (lastUserIdx < 0) return messages

    const lastUserMsg = messages[lastUserIdx]
    const lastContent = extractText(lastUserMsg)

    let prefix = knownPrefix || ''
    if (!prefix && lastContent) {
        prefix = lastContent.slice(0, 2000)
    }
    if (!prefix || prefix.length < 50) return messages

    const result = messages.slice()
    for (let i = 0; i < lastUserIdx; i++) {
        const msg = result[i]
        if (!msg || msg.role !== 'user') continue
        const text = extractText(msg)
        if (!text) continue

        const overlapLen = findCommonPrefix(text, prefix)
        if (overlapLen >= Math.min(100, prefix.length * 0.5)) {
            result[i] = sliceMessageContent(msg, overlapLen)
        }
    }
    return result
}

/**
 * 解码 base64 data URI 为文本内容
 *
 * @param {string} dataUri - 形如 `data:text/plain;base64,SGVsbG8=` 的 data URI
 * @returns {{ text: string, mimeType: string, isValid: boolean }|null}
 *   - text: 解码后的文本内容
 *   - mimeType: MIME 类型（如 text/plain）
 *   - isValid: 是否为有效文本（非二进制）
 */
function decodeBase64FileContent(dataUri) {
    if (!dataUri || !dataUri.startsWith('data:')) return null;

    const match = dataUri.match(/^data:([^;]+);base64,(.+)$/i);
    if (!match) return null;

    try {
        const mimeType = match[1].toLowerCase();
        const decoded = Buffer.from(match[2], 'base64').toString('utf-8');

        // 检查是否为有效文本（不含大量替换字符 U+FFFD）
        const nullCharCount = (decoded.match(/\ufffd/g) || []).length;
        const isValid = decoded.length > 0 && nullCharCount < decoded.length * 0.1;

        return { text: decoded, mimeType, isValid };
    } catch (_) {
        return null;
    }
}

/**
 * 从 OpenAI content 数组格式中提取文件内容
 *
 * 处理以下内容类型：
 * - type: 'text' → 直接返回文本
 * - type: 'image_url' / 'image' → 返回占位符
 * - type: 'file_url' / 'file' / url 字段 → 尝试解码 base64 或返回 URL 引用
 *
 * @param {Array<Object>} contentArray - 消息 content 数组
 * @param {Object} [options]
 * @param {boolean} [options.includeImages=true] - 是否包含图片占位符
 * @param {boolean} [options.decodeBase64=true] - 是否尝试解码 base64 数据
 * @returns {string} 提取的文本内容
 */
function extractFileContentFromContentArray(contentArray, options = {}) {
    const { includeImages = true, decodeBase64 = true } = options;

    if (!Array.isArray(contentArray)) return '';

    const parts = [];
    for (const c of contentArray) {
        if (!c) continue;

        // 纯文本
        if (c.type === 'text' && c.text) {
            parts.push(c.text);
            continue;
        }

        // 图片
        if (c.type === 'image_url' || c.type === 'image') {
            if (!includeImages) continue;
            const url = c.image_url?.url || c.image || c.url || '';
            if (url && !url.startsWith('data:')) {
                parts.push(`[Image URL: ${url}]`);
            } else {
                parts.push('[Image attached]');
            }
            continue;
        }

        // 文件 URL（非图片）
        const fileUrl = c.file_url?.url || c.file?.url || c.url || '';
        const fileName = c.file_url?.filename || c.file?.filename || c.filename || '';

        if (fileUrl) {
            // base64 data URI 解码
            if (decodeBase64 && fileUrl.startsWith('data:')) {
                const decoded = decodeBase64FileContent(fileUrl);
                if (decoded && decoded.isValid) {
                    const label = fileName
                        ? `[File: ${fileName} (${decoded.mimeType})]`
                        : `[File content (${decoded.mimeType}):]`;
                    parts.push(`${label}\n${decoded.text}\n[End of file]`);
                } else {
                    parts.push(`[Binary file${fileName ? ': ' + fileName : ''}]`);
                }
                continue;
            }

            // HTTP URL
            if (fileUrl.startsWith('http://') || fileUrl.startsWith('https://')) {
                parts.push(`[File URL${fileName ? ': ' + fileName : ''}: ${fileUrl}]`);
                continue;
            }

            // 其他格式
            parts.push(`[File${fileName ? ': ' + fileName : ''}: ${fileUrl}]`);
            continue;
        }

        // 兜底：提取 text 字段
        if (c.text) {
            parts.push(c.text);
        }
    }

    return parts.join('\n');
}

/**
 * 检查消息数组中是否包含文件附件（非图片）
 *
 * @param {Array<Object>} messages - 消息数组
 * @returns {boolean} 是否包含文件
 */
function hasFilesInMessages(messages) {
    if (!Array.isArray(messages)) return false;
    return messages.some(m => {
        if (!m || !Array.isArray(m.content)) return false;
        return m.content.some(c => {
            if (!c) return false;
            if (c.type === 'text' || c.type === 'image_url' || c.type === 'image') return false;
            return !!(c.file_url?.url || c.file?.url || c.url);
        });
    });
}

module.exports = {
    // 通用文本处理
    extractTextFromContent,
    formatSingleMessage,
    formatHistoryMessages,
    stripDuplicateUserPrefixes,
    // 通用文件/内容处理
    decodeBase64FileContent,
    extractFileContentFromContentArray,
    hasFilesInMessages,
}
