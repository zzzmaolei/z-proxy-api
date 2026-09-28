const axios = require('axios')
const OSS = require('ali-oss')
const mimetypes = require('mime-types')
const { logger } = require('../../utils/logger')
const { generateUUID } = require('../../utils/tools.js')
const { getProxyAgent, getChatBaseUrl, applyProxyToAxiosConfig } = require('../../utils/proxy-helper')
const { buildQwenHeaders } = require('../../providers/qwen-web/headers')

// 配置常量
const UPLOAD_CONFIG = {
    get stsTokenUrl() {
        return `${getChatBaseUrl()}/api/v1/files/getstsToken`
    },
    maxRetries: 3,
    timeout: 60000,
    maxFileSize: 100 * 1024 * 1024, // 100MB
    retryDelay: 1000
}

// 支持的文件类型
const SUPPORTED_TYPES = {
    image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp'],
    video: ['video/mp4', 'video/avi', 'video/mov', 'video/wmv', 'video/flv'],
    audio: ['audio/mp3', 'audio/wav', 'audio/aac', 'audio/ogg'],
    document: ['application/pdf', 'text/plain', 'application/msword']
}

/**
 * 验证文件大小
 * @param {number} fileSize - 文件大小（字节）
 * @returns {boolean} 是否符合大小限制
 */
const validateFileSize = (fileSize) => {
    return fileSize > 0 && fileSize <= UPLOAD_CONFIG.maxFileSize
}



/**
 * 从完整MIME类型获取简化的文件类型
 * @param {string} mimeType - 完整的MIME类型
 * @returns {string} 简化文件类型
 */
const getSimpleFileType = (mimeType) => {
    if (!mimeType) return 'file'

    const mainType = mimeType.split('/')[0].toLowerCase()

    // 检查是否为支持的主要类型
    if (Object.keys(SUPPORTED_TYPES).includes(mainType)) {
        return mainType
    }

    return 'file'
}

/**
 * 延迟函数
 * @param {number} ms - 延迟毫秒数
 */
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))

const STS_EXPIRED_ERROR_CODES = new Set([
    'SignatureDoesNotMatch',
    'InvalidAccessKeyId',
    'SecurityTokenExpired',
    'InvalidSecurityToken',
    'AccessDenied'
])

let lastBuildOssClientDebugAt = 0

/**
 * 判断 OSS 报错是否像 STS 凭证过期 / 失效。
 * @param {*} error
 * @returns {boolean}
 */
const isStsExpiredError = (error) => {
    if (!error || typeof error !== 'object') return false

    const code = error.code || error.name
    if (code && STS_EXPIRED_ERROR_CODES.has(String(code))) return true

    const status = error.status || error.statusCode || error.response?.status
    if (status === 403) return true

    const message = String(error.message || error.toString?.() || '')
    return /sts|security.?token|signature|access.?key/i.test(message)
        && /expired|invalid|forbidden|mismatch|denied/i.test(message)
}

const toAliOssSts = (stsCredentials) => ({
    accessKeyId: stsCredentials.access_key_id,
    accessKeySecret: stsCredentials.access_key_secret,
    stsToken: stsCredentials.security_token
})

/**
 * 构造 OSS client。
 * ali-oss 在 STS 模式下会检查 refreshSTSToken；这里提供一个安全兜底，
 * 真正的过期恢复由 uploadFileToQwenOss 外层重新获取 STS 后重试一次完成。
 * @param {Object} stsCredentials
 * @param {Object} ossInfo
 * @param {Object} [account]
 * @returns {Object}
 */
const buildOssClient = (stsCredentials, ossInfo, account) => {
    if (!stsCredentials || !ossInfo) {
        throw new Error('缺少必要的OSS客户端参数')
    }
    if (!stsCredentials.access_key_id || !stsCredentials.access_key_secret || !stsCredentials.security_token) {
        throw new Error('缺少必要的STS凭证')
    }
    if (!ossInfo.bucket || !ossInfo.endpoint) {
        throw new Error('缺少必要的OSS信息')
    }

    const ossConfig = {
        ...toAliOssSts(stsCredentials),
        bucket: ossInfo.bucket,
        endpoint: ossInfo.endpoint,
        secure: true,
        timeout: UPLOAD_CONFIG.timeout,
        refreshSTSToken: async () => toAliOssSts(stsCredentials),
        // Use a very large interval so the SDK does not auto-refresh stale credentials
        // without the original Qwen auth context. The caller refreshes explicitly.
        refreshSTSTokenInterval: 24 * 60 * 60 * 1000 * 365
    }

    const proxyAgent = getProxyAgent(account)
    if (proxyAgent) {
        ossConfig.agent = proxyAgent
    }

    const now = Date.now()
    if (now - lastBuildOssClientDebugAt > 5 * 60 * 1000) {
        lastBuildOssClientDebugAt = now
        logger.debug('构造OSS客户端', 'UPLOAD')
    }

    return new OSS(ossConfig)
}

/**
 * 请求STS Token（带重试机制）
 * @param {string} filename - 文件名
 * @param {number} filesize - 文件大小（字节）
 * @param {string} filetypeSimple - 简化文件类型
 * @param {string} authToken - 认证Token
 * @param {number} retryCount - 重试次数
 * @param {Object} [account] - 账户对象（用于解析账号级代理）
 * @returns {Promise<Object>} STS Token响应数据
 */
const requestStsToken = async (filename, filesize, filetypeSimple, authToken, retryCount = 0, account) => {
    try {
        // 参数验证
        if (!filename || !authToken) {
            logger.error('文件名和认证Token不能为空', 'UPLOAD')
            throw new Error('文件名和认证Token不能为空')
        }

        if (!validateFileSize(filesize)) {
            logger.error(`文件大小超出限制，最大允许 ${UPLOAD_CONFIG.maxFileSize / 1024 / 1024}MB`, 'UPLOAD')
            throw new Error(`文件大小超出限制，最大允许 ${UPLOAD_CONFIG.maxFileSize / 1024 / 1024}MB`)
        }

        const requestId = generateUUID()
        const bearerToken = authToken.startsWith('Bearer ') ? authToken : `Bearer ${authToken}`
        const proxyAgent = getProxyAgent(account)

        const headers = {
            ...buildQwenHeaders({
                baseUrl: getChatBaseUrl(),
                token: authToken,
                account,
                requestId,
                includeTokenCookie: false
            }),
            'Authorization': bearerToken,
            'Content-Type': 'application/json',
            'x-request-id': requestId
        }

        const payload = {
            filename,
            filesize,
            filetype: filetypeSimple
        }

        const requestConfig = {
            headers,
            timeout: UPLOAD_CONFIG.timeout
        }

        // 添加代理配置
        if (proxyAgent) {
            requestConfig.httpsAgent = proxyAgent
            requestConfig.proxy = false
        }

        // Normal uploads are high-volume; keep routine STS details at debug.
        // 失败仍走 error；只在 LOG_LEVEL=DEBUG 时可见
        logger.debug(`请求STS Token: ${filename} (${filesize} bytes, ${filetypeSimple})`, 'UPLOAD', '🎫')

        const response = await axios.post(UPLOAD_CONFIG.stsTokenUrl, payload, requestConfig)

        if (response.status === 200 && response.data) {
            const stsData = response.data

            // 验证响应数据完整性
            const credentials = {
                access_key_id: stsData.access_key_id,
                access_key_secret: stsData.access_key_secret,
                security_token: stsData.security_token
            }

            const fileInfo = {
                url: stsData.file_url,
                path: stsData.file_path,
                bucket: stsData.bucketname,
                endpoint: stsData.region + '.aliyuncs.com',
                id: stsData.file_id
            }

            // 检查必要字段
            const requiredCredentials = ['access_key_id', 'access_key_secret', 'security_token']
            const requiredFileInfo = ['url', 'path', 'bucket', 'endpoint', 'id']

            const missingCredentials = requiredCredentials.filter(key => !credentials[key])
            const missingFileInfo = requiredFileInfo.filter(key => !fileInfo[key])

            if (missingCredentials.length > 0 || missingFileInfo.length > 0) {
                logger.error(`STS响应数据不完整: 缺少 ${[...missingCredentials, ...missingFileInfo].join(', ')}`, 'UPLOAD')
                throw new Error(`STS响应数据不完整: 缺少 ${[...missingCredentials, ...missingFileInfo].join(', ')}`)
            }

            // STS success is routine; keep it at debug level.
            // 避免正常上传流程 1 张图打 5 行 info（STS / OSS 上传 / OSS 成功 / 文件流程等）
            logger.debug('STS Token获取成功', 'UPLOAD')
            return { credentials, file_info: fileInfo }
        } else {
            logger.error(`获取STS Token失败，状态码: ${response.status}`, 'UPLOAD')
            throw new Error(`获取STS Token失败，状态码: ${response.status}`)
        }
    } catch (error) {
        logger.error(`请求STS Token失败 (重试: ${retryCount})`, 'UPLOAD', '', error)

        // 403错误特殊处理
        if (error.response?.status === 403) {
            logger.error('403 Forbidden错误，可能是Token权限问题', 'UPLOAD')
            logger.error('认证失败，请检查Token权限', 'UPLOAD')
            throw new Error('认证失败，请检查Token权限')
        }

        // 重试逻辑
        if (retryCount < UPLOAD_CONFIG.maxRetries &&
            (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' ||
                error.response?.status >= 500)) {

            const delayMs = UPLOAD_CONFIG.retryDelay * Math.pow(2, retryCount)
            logger.warn(`等待 ${delayMs}ms 后重试...`, 'UPLOAD', '⏳')
            await delay(delayMs)

            return requestStsToken(filename, filesize, filetypeSimple, authToken, retryCount + 1, account)
        }

        throw error
    }
}

/**
 * 使用STS凭证将文件Buffer上传到阿里云OSS（带重试机制）
 * @param {Buffer} fileBuffer - 文件内容的Buffer
 * @param {Object} stsCredentials - STS凭证
 * @param {Object} ossInfo - OSS信息
 * @param {string} fileContentTypeFull - 文件的完整MIME类型
 * @param {Object} [account] - 账户对象（用于解析账号级代理）
 * @param {number} retryCount - 重试次数
 * @returns {Promise<Object>} 上传结果
 */
const uploadToOssWithSts = async (fileBuffer, stsCredentials, ossInfo, fileContentTypeFull, account, retryCount = 0) => {
    try {
        // 参数验证
        if (!fileBuffer || !stsCredentials || !ossInfo) {
            logger.error('缺少必要的上传参数', 'UPLOAD')
            throw new Error('缺少必要的上传参数')
        }

        const client = buildOssClient(stsCredentials, ossInfo, account)

        // OSS path and size are useful for diagnostics but too noisy for info.
        // 注意：file_url/file_path 是临时签名 URL，不入日志（避免敏感签名泄漏）
        logger.debug(`上传文件到OSS: ${ossInfo.path} (${fileBuffer.length} bytes)`, 'UPLOAD', '📤')

        const result = await client.put(ossInfo.path, fileBuffer, {
            headers: {
                'Content-Type': fileContentTypeFull || 'application/octet-stream'
            }
        })

        if (result.res && result.res.status === 200) {
            // Successful upload is routine; keep it at debug level.
            logger.debug('文件上传到OSS成功', 'UPLOAD')
            return { success: true, result }
        } else {
            logger.error(`OSS上传失败，状态码: ${result.res?.status || 'unknown'}`, 'UPLOAD')
            throw new Error(`OSS上传失败，状态码: ${result.res?.status || 'unknown'}`)
        }
    } catch (error) {
        logger.error(`OSS上传失败 (重试: ${retryCount})`, 'UPLOAD', '', error)
        if (isStsExpiredError(error)) {
            error.stsExpiredError = true
            throw error
        }

        // 重试逻辑
        if (retryCount < UPLOAD_CONFIG.maxRetries) {
            const delayMs = UPLOAD_CONFIG.retryDelay * Math.pow(2, retryCount)
            logger.warn(`等待 ${delayMs}ms 后重试OSS上传...`, 'UPLOAD', '⏳')
            await delay(delayMs)

            return uploadToOssWithSts(fileBuffer, stsCredentials, ossInfo, fileContentTypeFull, account, retryCount + 1)
        }

        throw error
    }
}

/**
 * 完整的文件上传流程：获取STS Token -> 上传到OSS。
 * @param {Buffer} fileBuffer - 图片文件的Buffer。
 * @param {string} originalFilename - 原始文件名 (例如 "image.png")。
 * @param {string} authToken - 通义千问认证Token (纯token，不含Bearer)。
 * @param {Object} [account] - 账户对象（用于解析账号级代理）
 * @returns {Promise<{file_url: string, file_id: string, message: string}>} 包含上传后的URL、文件ID和成功消息。
 * @throws {Error} 如果任何步骤失败。
 */
const uploadFileToQwenOss = async (fileBuffer, originalFilename, authToken, account) => {
    try {
        // 参数验证
        if (!fileBuffer || !originalFilename || !authToken) {
            logger.error('缺少必要的上传参数', 'UPLOAD')
            throw new Error('缺少必要的上传参数')
        }

        const filesize = fileBuffer.length
        const mimeType = mimetypes.lookup(originalFilename) || 'application/octet-stream'
        const filetypeSimple = getSimpleFileType(mimeType)

        // 文件大小验证
        if (!validateFileSize(filesize)) {
            logger.error(`文件大小超出限制，最大允许 ${UPLOAD_CONFIG.maxFileSize / 1024 / 1024}MB`, 'UPLOAD')
            throw new Error(`文件大小超出限制，最大允许 ${UPLOAD_CONFIG.maxFileSize / 1024 / 1024}MB`)
        }

        // Do not log tokens, cookies, or full sensitive URLs.
        logger.debug(`开始上传文件: ${originalFilename} (${filesize} bytes, ${mimeType})`, 'UPLOAD', '📤')

        // 第一步：获取STS Token
        const { credentials, file_info } = await requestStsToken(
            originalFilename,
            filesize,
            filetypeSimple,
            authToken,
            0,
            account
        )

        // 第二步：上传到OSS。STS/签名类 403 偶发时重新获取一次 STS 后重试。
        try {
            await uploadToOssWithSts(fileBuffer, credentials, file_info, mimeType, account)
        } catch (uploadError) {
            if (!isStsExpiredError(uploadError)) {
                throw uploadError
            }

            logger.warn('OSS STS凭证疑似过期，重新获取STS后重试上传', 'UPLOAD')
            const refreshed = await requestStsToken(
                originalFilename,
                filesize,
                filetypeSimple,
                authToken,
                0,
                account
            )
            await uploadToOssWithSts(fileBuffer, refreshed.credentials, refreshed.file_info, mimeType, account)
            credentials.access_key_id = refreshed.credentials.access_key_id
            credentials.access_key_secret = refreshed.credentials.access_key_secret
            credentials.security_token = refreshed.credentials.security_token
            file_info.url = refreshed.file_info.url
            file_info.path = refreshed.file_info.path
            file_info.bucket = refreshed.file_info.bucket
            file_info.endpoint = refreshed.file_info.endpoint
            file_info.id = refreshed.file_info.id
        }

        // Completion details stay at debug to avoid noisy normal traffic logs.
        // 不打 file_url/file_id（OSS 签名 URL 算敏感数据）
        logger.debug('文件上传流程完成', 'UPLOAD')

        return {
            status: 200,
            file_url: file_info.url,
            file_id: file_info.id,
            message: '文件上传成功'
        }
    } catch (error) {
        logger.error('文件上传流程失败', 'UPLOAD', '', error)
        throw error
    }
}



module.exports = {
    uploadFileToQwenOss,
    isStsExpiredError,
    buildOssClient
}
