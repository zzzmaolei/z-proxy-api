const { logger } = require('../utils/logger.js')
const { generateUUID } = require('../utils/tools.js')
const accountManager = require('../utils/account.js')
const {
    VIDEO_WHITELIST_KEYS,
    pickAllowedImageVideoParams,
    generateImageVideoResult,
    getSafeMediaAccount,
    sendOpenAIErrorResponse,
    resolveRequestedModel,
    normalizeOpenAIImageVideoSize
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
            logger.warn(`视频生成账号 ${account.email} 失败（${error.code || error.status}），尝试下一个账号（剩余 ${nextAvailable} 个）`, 'CHAT')
        }
    }

    throw lastError || new Error('所有账号的视频生成额度已用尽')
}

/**
 * 处理 OpenAI 风格的视频生成端点
 * 每个账号有视频生成额度，耗尽后自动轮询下一个账号
 * @param {object} req - Express 请求对象
 * @param {object} res - Express 响应对象
 * @returns {Promise<void>}
 */
const handleOpenAIVideoGeneration = async (req, res) => {
    try {
        if (!req.body?.prompt) {
            return sendOpenAIErrorResponse(res, {
                status: 400,
                error: 'prompt 是必填参数'
            })
        }

        const mediaRequestId = generateUUID()
        const model = await resolveRequestedModel(req.body.model, 't2v')
        const videoOptions = pickAllowedImageVideoParams(req.body, VIDEO_WHITELIST_KEYS)
        const size = normalizeOpenAIImageVideoSize(req.body.size)

        const result = await withAccountRotation(req, async (account) => {
            return await generateImageVideoResult({
                model,
                messages: [{ role: 'user', content: req.body.prompt }],
                size,
                chat_type: 't2v',
                stream: false,
                account,
                mediaRequestId,
                route: '/v1/videos',
                videoOptions
            })
        })

        res.json({
            id: `video_${new Date().getTime()}`,
            object: 'video',
            created: Math.floor(Date.now() / 1000),
            model,
            status: 'completed',
            data: [{ url: result.contentUrl }]
        })
    } catch (error) {
        logger.error('OpenAI 视频生成端点处理失败', 'CHAT', '', error)
        return sendOpenAIErrorResponse(res, error)
    }
}

module.exports = {
    handleOpenAIVideoGeneration
}