const express = require('express')
const multer = require('multer')
const router = express.Router()
const { apiKeyVerify } = require('../middlewares/authorization.js')
const { processRequestBody } = require('../middlewares/chat-middleware.js')
const { validateChatCompletions } = require('../middlewares/validate-request.js')
const { handleChatCompletion } = require('../controllers/chat.js')
const {
    handleImageVideoCompletion,
    handleOpenAIImagesGeneration,
    handleOpenAIImagesEdit,
    handleOpenAIVideoGeneration
} = require('../controllers/chat.image.video.js')
const { detectClientProfile } = require('../agents/index.js')
const { logger } = require('../utils/logger.js')
const { routeByProvider } = require('../providers/registry.js')

const upload = multer({
    storage: multer.memoryStorage(),
    limits: {
        fileSize: 100 * 1024 * 1024
    }
})

const selectChatCompletion = (req, res, next) => {
    const ChatCompletionMap = {
        't2t': handleChatCompletion,
        'search': handleChatCompletion,
        't2i': handleImageVideoCompletion,
        't2v': handleImageVideoCompletion,
        'image_edit': handleImageVideoCompletion,
        //   'deep_research': handleDeepResearchCompletion
    }

    const chatType = req.body.chat_type
    const chatCompletion = ChatCompletionMap[chatType]
    if (chatCompletion) {
        chatCompletion(req, res, next)
    } else {
        // 未知 chat_type：回退到默认 t2t
        logger.warn(`[ROUTE] 未知 chat_type=${req.body.chat_type}，回退到 t2t 处理`, 'ROUTE')
        handleChatCompletion(req, res, next)
    }
}

/**
 * Detect the OpenAI-compatible client profile before request normalization.
 * This only attaches req.clientProfile and response headers.
 */
const detectOpenAIProfile = (req, res, next) => {
    try {
        const detected = detectClientProfile(req, 'openai', { body: req.body })
        req.clientProfile = detected
        res.set('x-qwen-protocol', 'openai')
        res.set('x-qwen-client-profile', detected.name || 'unknown')
        if (detected.source === 'header_incompatible_fallback' || detected.source === 'header_unknown_fallback') {
            logger.debug(
                `[profile] openai 收到不兼容/未知 profile 头: ${detected.headerValue || '?'} → 回退 ${detected.name}`,
                'PROFILE'
            )
        } else {
            logger.debug(
                `[profile] openai protocol=${detected.protocol} profile=${detected.name} source=${detected.source}`,
                'PROFILE'
            )
        }
    } catch (e) {
        // 永不阻塞主流程：profile 识别失败就用默认
        req.clientProfile = { name: 'openai-compatible', source: 'detector_error', protocol: 'openai' }
        res.set('x-qwen-protocol', 'openai')
        res.set('x-qwen-client-profile', 'openai-compatible')
        logger.debug(`[profile] detector exception: ${e && e.message ? e.message : e}`, 'PROFILE')
    }
    return next()
}

// 检测并按 provider 注册表（src/providers/registry.js）转发到 dpsk 等内部路线；
// 未命中规则的 model 走默认 Qwen 路线（next 进入 detectOpenAIProfile / processRequestBody）
// 新增 provider 只需在 registry.js 里加一条，不再每加一家就在这里多挂一个 middleware。

router.post('/v1/chat/completions',
    apiKeyVerify,
    validateChatCompletions,
    routeByProvider,
    detectOpenAIProfile,
    processRequestBody,
    selectChatCompletion
)

router.post('/v1/images/generations',
    apiKeyVerify,
    handleOpenAIImagesGeneration
)

router.post('/v1/images/edits',
    apiKeyVerify,
    upload.any(),
    handleOpenAIImagesEdit
)

router.post('/v1/videos',
    apiKeyVerify,
    upload.any(),
    handleOpenAIVideoGeneration
)


module.exports = router
