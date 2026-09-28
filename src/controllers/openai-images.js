const { logger } = require('../utils/logger.js')
const { generateUUID } = require('../utils/tools.js')
const accountManager = require('../utils/account.js')
const {
    IMAGE_WHITELIST_KEYS,
    pickAllowedImageVideoParams,
    generateImageVideoResult,
    getSafeMediaAccount,
    sendOpenAIErrorResponse,
    resolveRequestedModel,
    normalizeOpenAIImageVideoSize,
    buildOpenAIImageResultItem,
    collectRequestMediaItems
} = require('../backends/qwen/media-gen-helpers')

/**
 * 判断是否为可重试的上游错误（额度耗尽 / 服务器错误）
 */
const isRetryableUpstreamError = (error) => {
    if (!error) return false
    const httpStatus = error.response?.status || error.status
    return error.code === 'Internal_Server_Error' ||
        error.code === 'RateLimited' ||
        error.code === 'Bad_Request' ||
        httpStatus === 429 ||
        httpStatus === 500 ||
        httpStatus === 502 ||
        (error.error && /internal error/i.test(String(error.error)))
}

/**
 * 账号轮询包装器：遍历可用账号，遇到可重试错误时自动切换
 * @param {object} req - Express 请求
 * @param {function} executeFn - 执行函数，接收 account 参数
 * @returns {Promise<any>}
 */
const withAccountRotation = async (req, executeFn) => {
    const allAccounts = accountManager.accountTokens || []
    const failedEmails = new Set()
    let lastError = null

    const maxAttempts = Math.max(allAccounts.filter(a => a && a.token).length, 1)
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        let account
        if (attempt === 0) {
            account = getSafeMediaAccount(req.preSelectedAccount)
        } else {
            const available = allAccounts.filter(a => a && a.token && !failedEmails.has(a.email))
            account = available.length > 0
                ? available[Math.floor(Math.random() * available.length)]
                : null
        }
        if (!account || !account.token) {
            if (attempt === 0) continue
            break
        }
        failedEmails.add(account.email)

        try {
            return await executeFn(account)
        } catch (error) {
            lastError = error
            if (!isRetryableUpstreamError(error)) throw error
            const nextAvailable = allAccounts.filter(a => a && a.token && !failedEmails.has(a.email)).length
            if (nextAvailable === 0) break
            logger.warn(`图片/视频生成账号 ${account.email} 失败（${error.code || error.status}），尝试下一个账号（剩余 ${nextAvailable} 个）`, 'CHAT')
        }
    }

    throw lastError || new Error('所有账号的图片/视频生成额度已用尽')
}

/**
 * 处理 OpenAI 风格的图片生成端点
 * @param {object} req - Express 请求对象
 * @param {object} res - Express 响应对象
 * @returns {Promise<void>}
 */
const handleOpenAIImagesGeneration = async (req, res) => {
    try {
        if (!req.body?.prompt) {
            return sendOpenAIErrorResponse(res, {
                status: 400,
                error: 'prompt 是必填参数'
            })
        }

        const mediaRequestId = generateUUID()
        const model = await resolveRequestedModel(req.body.model, 't2i')
        const imageOptions = pickAllowedImageVideoParams(req.body, IMAGE_WHITELIST_KEYS)
        const size = normalizeOpenAIImageVideoSize(req.body.size)

        const result = await withAccountRotation(req, async (account) => {
            return await generateImageVideoResult({
                model,
                messages: [{ role: 'user', content: req.body.prompt }],
                size,
                chat_type: 't2i',
                stream: false,
                account,
                mediaRequestId,
                route: '/v1/images/generations',
                imageOptions
            })
        })

        const contentUrls = (result.contentUrls && result.contentUrls.length > 0) ? result.contentUrls : [result.contentUrl].filter(Boolean)
        const imageData = await Promise.all(contentUrls.map(contentUrl => buildOpenAIImageResultItem(contentUrl, req.body.response_format, result.account || req.preSelectedAccount)))

        res.json({
            created: Math.floor(Date.now() / 1000),
            data: imageData
        })
    } catch (error) {
        logger.error('OpenAI 图片生成端点处理失败', 'CHAT', '', error)
        return sendOpenAIErrorResponse(res, error)
    }
}

/**
 * 处理 OpenAI 风格的图片编辑端点
 * @param {object} req - Express 请求对象
 * @param {object} res - Express 响应对象
 * @returns {Promise<void>}
 */
const handleOpenAIImagesEdit = async (req, res) => {
    try {
        const mediaRequestId = generateUUID()
        const model = await resolveRequestedModel(req.body.model, 't2i')
        const imageOptions = pickAllowedImageVideoParams(req.body, IMAGE_WHITELIST_KEYS)
        const size = normalizeOpenAIImageVideoSize(req.body.size)
        const prompt = req.body.prompt || '请基于上传图片完成编辑'

        const result = await withAccountRotation(req, async (account) => {
            const imageItems = await collectRequestMediaItems(req, 'image', 'image', account, {
                mediaRequestId,
                route: '/v1/images/edits',
                chatType: 't2i',
                model: req.body?.model || 'auto',
                account
            })
            if (imageItems.length === 0) {
                const err = new Error('image 是必填参数')
                err.status = 400
                err.code = 'MissingImage'
                throw err
            }

            return await generateImageVideoResult({
                model,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        ...imageItems
                    ]
                }],
                size,
                chat_type: 't2i',
                stream: false,
                account,
                mediaRequestId,
                route: '/v1/images/edits',
                imageOptions
            })
        })

        const contentUrls = (result.contentUrls && result.contentUrls.length > 0) ? result.contentUrls : [result.contentUrl].filter(Boolean)
        const imageData = await Promise.all(contentUrls.map(contentUrl => buildOpenAIImageResultItem(contentUrl, req.body.response_format, result.account || req.preSelectedAccount)))

        res.json({
            created: Math.floor(Date.now() / 1000),
            data: imageData
        })
    } catch (error) {
        logger.error('OpenAI 图片编辑端点处理失败', 'CHAT', '', error)
        return sendOpenAIErrorResponse(res, error)
    }
}

module.exports = {
    handleOpenAIImagesGeneration,
    handleOpenAIImagesEdit
}