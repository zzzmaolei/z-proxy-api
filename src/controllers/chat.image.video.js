const { logger } = require('../utils/logger.js')
const { setResponseHeaders } = require('./chat.js')
const { generateUUID } = require('../utils/tools.js')
const {
    IMAGE_WHITELIST_KEYS,
    VIDEO_WHITELIST_KEYS,
    pickAllowedImageVideoParams,
    generateImageVideoResult,
    getSafeMediaAccount,
    logMediaEvent,
    sendUpstreamError,
    returnResponse
} = require('../backends/qwen/media-gen-helpers')
const { handleOpenAIImagesGeneration, handleOpenAIImagesEdit } = require('./openai-images')
const { handleOpenAIVideoGeneration } = require('./openai-video')

/**
 * 主要的聊天完成处理函数
 * @param {object} req - Express 请求对象
 * @param {object} res - Express 响应对象
 */
const handleImageVideoCompletion = async (req, res) => {
    const downstreamStream = req.body.stream === true
    const account = getSafeMediaAccount(req.preSelectedAccount)
    const mediaRequestId = generateUUID()
    let keepAliveTimer = null

    try {
        if (downstreamStream && req.body.chat_type === 't2v') {
            setResponseHeaders(res, true, { flush: true })
            keepAliveTimer = setInterval(() => {
                if (!res.writableEnded) {
                    res.write(`: keep-alive\n\n`)
                }
            }, 15000)
        }

        const optionSource = req.originalBody || req.body || {}
        const result = await generateImageVideoResult({
            ...req.body,
            originalBody: req.originalBody,
            account,
            mediaRequestId,
            route: '/v1/chat/completions',
            imageOptions: pickAllowedImageVideoParams(optionSource, IMAGE_WHITELIST_KEYS),
            videoOptions: pickAllowedImageVideoParams(optionSource, VIDEO_WHITELIST_KEYS)
        })

        if (keepAliveTimer) {
            clearInterval(keepAliveTimer)
        }

        return returnResponse(res, result.model, result.content, downstreamStream, result.ctx)
    } catch (error) {
        if (keepAliveTimer) {
            clearInterval(keepAliveTimer)
        }

        logger.error('图片视频资源处理错误', 'CHAT', '', error)
        logMediaEvent({ mediaRequestId, route: '/v1/chat/completions', chatType: req.body?.chat_type, model: req.body?.model, account }, 'error', {
            stage: error?.stage,
            reason: error?.reason,
            errorKind: error?.code || error?.status || error?.name || 'unknown',
            resolvedChatType: error?.resolvedChatType,
            lastUserContentType: error?.lastUserContentType,
            promptChars: error?.promptChars,
            explicitImageCount: error?.explicitImageCount,
            explicitVideoCount: error?.explicitVideoCount
        }, 'warn')

        if (downstreamStream) {
            return returnResponse(res, req.body.model, error?.error || error?.message || 'Service error, please try again later', true, { mediaRequestId, route: '/v1/chat/completions', chatType: req.body?.chat_type, model: req.body?.model, account })
        }

        return sendUpstreamError(res, error?.error ? error : {
            status: 500,
            error: error?.message || 'Service error, please try again later'
        })
    }
}

module.exports = {
    handleImageVideoCompletion,
    handleOpenAIImagesGeneration,
    handleOpenAIImagesEdit,
    handleOpenAIVideoGeneration
}
