'use strict';

const upstream = require('./upstream-client');
const { getChatBaseUrl } = require('../../utils/proxy-helper');
const { buildQwenHeaders } = require('../../providers/qwen-web/headers');
const qwenWeb = require('../../providers/qwen-web');
const { logger } = require('../../utils/logger');

/**
 * 生成一个新的 chat_id（调用上游 /api/v2/chats/new）
 *
 * 独立模块，避免 request.js 和 chat-id-pool.js 之间的循环依赖
 *
 * @param {string} currentToken
 * @param {string} model
 * @param {Object} [account] - 当前账户对象（用于解析账号级代理）
 * @param {Object} [options]
 * @param {boolean} [options.logFailures=true] - 后台预热可关闭 warning，主请求保持可观测。
 * @returns {Promise<string|null>} 返回生成的 chat_id，如果失败则返回 null
 */
const generateChatID = async (currentToken, model, account, options = {}) => {
    const logFailures = options.logFailures !== false;
    const chatType = options.chatType || 't2t';
    try {
        const chatBaseUrl = getChatBaseUrl();

        const newChatHeaders = buildQwenHeaders({
            baseUrl: chatBaseUrl,
            token: currentToken,
            account,
            includeAuthHeader: false,
            extra: { Referer: `${chatBaseUrl}/c/new-chat` }
        })
        const newChatRequestConfig = await upstream.buildRequestConfig({
            token: currentToken,
            account,
            baseUrl: chatBaseUrl,
            extraHeaders: newChatHeaders
        });

        const response_data = await upstream.postJson(
            qwenWeb.endpoints.buildUrl(chatBaseUrl, qwenWeb.endpoints.PATHS.chatsNew),
            // 对齐浏览器抓包：chatId:"" + project_id:"" 取代旧 title 字段
            { "chatId": "", "models": [model], "project_id": "", "timestamp": new Date().getTime(), "chat_type": chatType, "chat_mode": "normal" },
            newChatRequestConfig
        );

        if (response_data.status === 200 && response_data.data && response_data.data.data && response_data.data.data.id) {
            return response_data.data.data.id;
        }
        if (logFailures) {
            logger.warn(`生成 chat_id 失败：status=${response_data.status} data=${JSON.stringify(response_data.data || {}).slice(0, 200)}`, 'REQUEST');
        } else {
            logger.debug(`chat_id prewarm failed: status=${response_data.status}`, 'POOL');
        }
        return null;
    } catch (error) {
        if (logFailures) {
            logger.warn(`生成 chat_id 异常：${error.message}`, 'REQUEST');
        } else {
            logger.debug(`chat_id prewarm exception: ${error.message}`, 'POOL');
        }
        return null;
    }
};

module.exports = { generateChatID };
