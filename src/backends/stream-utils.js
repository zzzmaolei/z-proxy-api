/**
 * Stream Handler 公共工具 — SSE 心跳 / delta 写入 / 请求 ID 生成
 * DeepSeek stream-handler 共享
 */

/**
 * 创建 SSE 心跳定时器
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 * @param {number} [intervalMs=12000] - 心跳间隔（毫秒），默认 12 秒
 * @returns {{ stop: () => void }}
 */
function createHeartbeat(res, intervalMs = 12000) {
    const heartbeat = setInterval(() => {
        try {
            if (!res.writableEnded && !res.destroyed) {
                res.write(`: ping\n\n`);
            }
        } catch (_) { /* ignore */ }
    }, intervalMs);
    return {
        stop: () => clearInterval(heartbeat),
    };
}

/**
 * 写入 content delta chunk
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 * @param {string} requestId - 请求 ID
 * @param {string} model - 模型名称
 * @param {string} text - 文本内容
 */
function writeContentDelta(res, requestId, model, text, created = Math.floor(Date.now() / 1000)) {
    if (!text) return;
    const delta = {
        id: requestId,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{
            index: 0,
            delta: { content: text },
            finish_reason: null,
        }],
    };
    res.write(`data: ${JSON.stringify(delta)}\n\n`);
}

/**
 * 写入 tool_calls delta chunks（含 header chunk + 参数分片）
 * @param {import('http').ServerResponse} res - HTTP 响应对象
 * @param {string} requestId - 请求 ID
 * @param {string} model - 模型名称
 * @param {Array<{index: number, id: string, function: {name: string, arguments: string}}>} calls - 工具调用数组
 * @param {number} [argChunkSize=32] - 参数分片大小
 */
function writeToolCallsDelta(res, requestId, model, calls, argChunkSize = 32, created = Math.floor(Date.now() / 1000)) {
    if (!calls || calls.length === 0) return;
    for (let i = 0; i < calls.length; i++) {
        const call = calls[i];
        const callIndex = (typeof call.index === 'number') ? call.index : i;
        const headerDelta = {
            id: requestId,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [{
                index: 0,
                delta: {
                    tool_calls: [{
                        index: callIndex,
                        id: call.id,
                        type: 'function',
                        function: { name: call.function.name, arguments: '' },
                    }],
                },
                finish_reason: null,
            }],
        };
        res.write(`data: ${JSON.stringify(headerDelta)}\n\n`);

        const argsString = call.function.arguments || '';
        for (let offset = 0; offset < argsString.length; offset += argChunkSize) {
            const piece = argsString.slice(offset, offset + argChunkSize);
            const argDelta = {
                id: requestId,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [{
                    index: 0,
                    delta: {
                        tool_calls: [{
                            index: callIndex,
                            function: { arguments: piece },
                        }],
                    },
                    finish_reason: null,
                }],
            };
            res.write(`data: ${JSON.stringify(argDelta)}\n\n`);
        }
    }
}

/**
 * 生成请求 ID
 * @param {string} [prefix='chatcmpl'] - ID 前缀
 * @returns {string}
 */
function generateRequestId(prefix = 'chatcmpl') {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

module.exports = {
    createHeartbeat,
    writeContentDelta,
    writeToolCallsDelta,
    generateRequestId,
};
