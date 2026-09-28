const axios = require('axios')
const fs = require('fs')
const path = require('path')
const { logger } = require('../../utils/logger.js')
const config = require('../../config/index.js')
const { setResponseHeaders } = require('../../controllers/chat.js')
const accountManager = require('../../utils/account.js')
const { sleep, generateUUID } = require('../../utils/tools.js')
const { generateChatID, getOrGenerateChatID } = require('./request.js')
const { uploadFileToQwenOss } = require('./upload.js')
const { parserModel, enrichQwenMessage } = require('./message-enricher.js')
const { getDefaultModelByChatType } = require('../../models/models-map.js')
const { buildQwenHeaders } = require('../../providers/qwen-web/headers')
const { getProxyAgent, getChatBaseUrl, applyProxyToAxiosConfig } = require('../../utils/proxy-helper')
// 统一 upstream client：集中处理 keepAlive、代理缓存和请求配置。
const upstream = require('./upstream-client')
// Qwen Web 协议适配层：集中管理路径、头、错误和响应解析。
const qwenWeb = require('../../providers/qwen-web')
// 统一 SSE 帧解析，避免多处手写 split 产生不一致行为。
const SSEFrameParser = require('../../utils/sse-frame-parser')
// 复用 shared/media-downloader.js 的下载/解析逻辑
const { downloadHttpUrl, isLocalPath, readLocalFile, parseDataUri } = require('../../shared/media-downloader')

const DATA_URI_REGEX = /^data:(.+);base64,(.*)$/i
const HTTP_URL_REGEX = /^https?:\/\//i
const IMAGE_VIDEO_CHAT_TYPES = new Set(['t2i', 't2v', 'image_edit'])
const DEFAULT_IMAGE_EDIT_PROMPT = '请基于上传图片完成编辑。'
const IMAGE_WHITELIST_KEYS = ['seed', 'negative_prompt', 'style', 'quality', 'aspect_ratio', 'guidance_scale', 'n']
const VIDEO_WHITELIST_KEYS = ['duration', 'seconds', 'seed', 'negative_prompt', 'fps', 'aspect_ratio', 'resolution', 'quality']
const IMAGE_UPSTREAM_FIELD_MAP = Object.freeze({
    seed: 'seed',
    negative_prompt: 'negative_prompt',
    style: 'style',
    quality: 'quality',
    aspect_ratio: 'aspect_ratio',
    guidance_scale: 'guidance_scale',
    n: 'n'
})
const VIDEO_UPSTREAM_FIELD_MAP = Object.freeze({
    duration: 'duration',
    seed: 'seed',
    negative_prompt: 'negative_prompt',
    fps: 'fps',
    aspect_ratio: 'aspect_ratio',
    resolution: 'resolution',
    quality: 'quality'
})

const pickAllowedImageVideoParams = (source, whitelist) => {
    if (!source || typeof source !== 'object' || Array.isArray(source) || !Array.isArray(whitelist)) {
        return {}
    }
    const out = {}
    for (const key of whitelist) {
        if (Object.prototype.hasOwnProperty.call(source, key) && source[key] !== null && source[key] !== undefined) {
            out[key] = source[key]
        }
    }
    return out
}

const toSafeInt = (value, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) => {
    if (value === null || value === undefined || value === '') return undefined
    const n = Number(value)
    if (!Number.isFinite(n)) return undefined
    const i = Math.trunc(n)
    if (i < min || i > max) return undefined
    return i
}

const toSafeNumber = (value, min = -Infinity, max = Infinity) => {
    if (value === null || value === undefined || value === '') return undefined
    const n = Number(value)
    if (!Number.isFinite(n) || n < min || n > max) return undefined
    return n
}

const cleanString = (value) => {
    if (typeof value !== 'string') return undefined
    const s = value.trim()
    return s.length > 0 ? s : undefined
}

const normalizeImageRequestOptions = (options) => {
    const picked = pickAllowedImageVideoParams(options, IMAGE_WHITELIST_KEYS)
    const out = {}
    const seed = toSafeInt(picked.seed)
    const n = toSafeInt(picked.n, 1, 8)
    const guidanceScale = toSafeNumber(picked.guidance_scale, 0, 100)
    if (seed !== undefined) out.seed = seed
    for (const key of ['negative_prompt', 'style', 'quality', 'aspect_ratio']) {
        const value = cleanString(picked[key])
        if (value !== undefined) out[key] = value
    }
    if (guidanceScale !== undefined) out.guidance_scale = guidanceScale
    if (n !== undefined) out.n = n
    return out
}

const normalizeVideoRequestOptions = (options) => {
    const picked = pickAllowedImageVideoParams(options, VIDEO_WHITELIST_KEYS)
    const out = {}
    const duration = toSafeInt(picked.duration, 1, 60)
    const seconds = toSafeInt(picked.seconds, 1, 60)
    const fps = toSafeInt(picked.fps, 1, 120)
    const seed = toSafeInt(picked.seed)
    if (duration !== undefined) out.duration = duration
    else if (seconds !== undefined) out.duration = seconds
    if (fps !== undefined) out.fps = fps
    if (seed !== undefined) out.seed = seed
    for (const key of ['negative_prompt', 'aspect_ratio', 'resolution', 'quality']) {
        const value = cleanString(picked[key])
        if (value !== undefined) out[key] = value
    }
    return out
}

const applyMappedOptionsToReqBody = (reqBody, normalized, fieldMap) => {
    if (!reqBody || typeof reqBody !== 'object' || !normalized || typeof normalized !== 'object') return
    for (const [srcKey, dstKey] of Object.entries(fieldMap)) {
        const value = normalized[srcKey]
        if (value === null || value === undefined) continue
        if (reqBody[dstKey] !== undefined) continue
        reqBody[dstKey] = value
    }
}

const applyImageOptionsToReqBody = (reqBody, normalized) => {
    applyMappedOptionsToReqBody(reqBody, normalized, IMAGE_UPSTREAM_FIELD_MAP)
}

const applyVideoOptionsToReqBody = (reqBody, normalized) => {
    applyMappedOptionsToReqBody(reqBody, normalized, VIDEO_UPSTREAM_FIELD_MAP)
}

const extractStringUrl = (value) => {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (value && typeof value === 'object') {
        for (const key of ['url', 'image', 'video', 'video_url']) {
            if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim()
        }
    }
    return null
}

const mapContentItemToMedia = (item) => {
    if (!item || typeof item !== 'object') return null
    if (item.type === 'image') {
        const url = extractStringUrl(item.image || item.url)
        return url ? { type: 'image', url } : null
    }
    if (item.type === 'image_url') {
        const url = extractStringUrl(item.image_url || item.url)
        return url ? { type: 'image', url } : null
    }
    if (item.type === 'video') {
        const url = extractStringUrl(item.video || item.url)
        return url ? { type: 'video', url } : null
    }
    if (item.type === 'video_url') {
        const url = extractStringUrl(item.video_url || item.url)
        return url ? { type: 'video', url } : null
    }
    if (item.type === 'input_video') {
        const url = extractStringUrl(item.input_video || item.video_url || item.url)
        return url ? { type: 'video', url } : null
    }
    return null
}

const splitArrayContentToTextAndMedia = (content) => {
    if (!Array.isArray(content)) {
        return { text: '', media: [], unsupportedCount: 0 }
    }
    const texts = []
    const media = []
    let unsupportedCount = 0
    for (const item of content) {
        if (!item || typeof item !== 'object') continue
        if (item.type === 'text') {
            if (typeof item.text === 'string' && item.text.length > 0) texts.push(item.text)
            continue
        }
        const mapped = mapContentItemToMedia(item)
        if (mapped) media.push(mapped)
        else unsupportedCount += 1
    }
    return {
        text: texts.join('\n\n'),
        media,
        unsupportedCount
    }
}

const getLastUserMessage = (messages) => {
    if (!Array.isArray(messages)) return null
    for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.role === 'user') return messages[i]
    }
    return null
}

const extractLastUserSegment = (text) => {
    if (typeof text !== 'string') return ''
    const marker = /(?:^|;)user:/g
    let match = null
    let last = null
    while ((match = marker.exec(text)) !== null) {
        last = match
    }
    if (!last) return text
    const start = last.index + last[0].length
    const rest = text.slice(start)
    const nextRole = rest.search(/;(assistant|system|tool|user):/)
    return (nextRole >= 0 ? rest.slice(0, nextRole) : rest).trim()
}

const emptyCurrentImageVideoTurn = (reason) => ({
    currentText: '',
    currentImages: [],
    currentVideos: [],
    hasExplicitImage: false,
    hasExplicitVideo: false,
    usedRaw: false,
    lastUserContentType: 'none',
    reason
})

const extractCurrentImageVideoTurn = (originalBody, parsedBody, chatType) => {
    if (chatType !== undefined && !IMAGE_VIDEO_CHAT_TYPES.has(chatType)) {
        return emptyCurrentImageVideoTurn('non-image-video-chat-type')
    }

    const rawMessages = originalBody && Array.isArray(originalBody.messages) ? originalBody.messages : null
    const parsedMessages = parsedBody && Array.isArray(parsedBody.messages) ? parsedBody.messages : null
    let messages = rawMessages
    let usedRaw = true
    let reason = 'raw'

    if (!messages || messages.length === 0) {
        messages = parsedMessages
        usedRaw = false
        reason = messages && messages.length > 0 ? 'parsed-fallback' : 'fallback-no-messages'
    }

    if (!messages || messages.length === 0) {
        return emptyCurrentImageVideoTurn(reason)
    }

    const lastUser = getLastUserMessage(messages)
    if (!lastUser) {
        const out = emptyCurrentImageVideoTurn('fallback-no-user-message')
        out.usedRaw = usedRaw
        return out
    }

    const content = lastUser.content
    const lastUserContentType = Array.isArray(content) ? 'array' : typeof content
    let currentText = ''
    const currentImages = []
    const currentVideos = []

    if (typeof content === 'string') {
        currentText = extractLastUserSegment(content)
    } else if (Array.isArray(content)) {
        const split = splitArrayContentToTextAndMedia(content)
        currentText = split.text
        for (const media of split.media) {
            if (media.type === 'image') currentImages.push(media.url)
            if (media.type === 'video') currentVideos.push(media.url)
        }
    }

    return {
        currentText,
        currentImages,
        currentVideos,
        hasExplicitImage: currentImages.length > 0,
        hasExplicitVideo: currentVideos.length > 0,
        usedRaw,
        lastUserContentType,
        reason
    }
}

const collectExplicitMediaFromCurrentTurn = (turn) => ({
    images: Array.isArray(turn?.currentImages) ? [...turn.currentImages] : [],
    videos: Array.isArray(turn?.currentVideos) ? [...turn.currentVideos] : []
})

const summarizeImageVideoRequest = (input = {}) => {
    const turn = input.currentTurn || null
    const images = Array.isArray(turn?.currentImages) ? turn.currentImages : []
    const videos = Array.isArray(turn?.currentVideos) ? turn.currentVideos : []
    const mediaTypes = []
    if (images.length > 0) mediaTypes.push('image')
    if (videos.length > 0) mediaTypes.push('video')
    const normalized = input.normalized && typeof input.normalized === 'object' ? input.normalized : {}
    const text = typeof turn?.currentText === 'string' ? turn.currentText : ''
    return {
        route: input.route || 'unknown',
        chat_type: input.chatType || 'unknown',
        history_mode: config.imageVideoHistoryMode,
        explicit_text_count: text.trim() ? 1 : 0,
        explicit_media_count: images.length + videos.length,
        media_types: mediaTypes,
        reused_history_image: input.reusedHistoryImage === true,
        forwarded_param_keys: Object.keys(normalized).sort(),
        prompt_length: text.length,
        has_explicit_image: images.length > 0,
        has_explicit_video: videos.length > 0
    }
}

const getSafeMediaAccount = (preferredAccount) => {
    if (preferredAccount && preferredAccount.token) return preferredAccount
    return accountManager.getAccount()
}

const getMediaAccountLabel = (account) => account?.email || 'unknown'

const stringifyMediaLogValue = (value) => {
    if (value === null || value === undefined) return 'n/a'
    if (Array.isArray(value)) return value.join(',')
    if (typeof value === 'object') return JSON.stringify(value)
    return String(value)
}

const logMediaEvent = (ctx, phase, fields = {}, level = 'debug') => {
    const safe = {
        mediaRequestId: ctx?.mediaRequestId || 'unknown',
        phase,
        route: ctx?.route || 'unknown',
        chat_type: ctx?.chatType || fields.chat_type || 'unknown',
        model: ctx?.model || fields.model || 'unknown',
        account: getMediaAccountLabel(ctx?.account),
        ...fields
    }
    const message = Object.entries(safe)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${stringifyMediaLogValue(value)}`)
        .join(' ')
    const log = typeof logger[level] === 'function' ? logger[level].bind(logger) : logger.debug.bind(logger)
    log(`[image-video] ${message}`, 'CHAT')
}

const isLocalFilePath = isLocalPath

const localPathFromMediaUrl = (value) => {
    if (typeof value !== 'string') return value
    if (!value.startsWith('file://')) return value
    return value.slice('file://'.length)
}

const extensionFromMimeType = (mimeType, mediaType) => {
    const raw = String(mimeType || '').split('/')[1] || (mediaType === 'video' ? 'mp4' : 'png')
    return raw.replace(/[^A-Za-z0-9._-]/g, '') || (mediaType === 'video' ? 'mp4' : 'png')
}

const normalizeMediaUrlForUpstream = async (mediaType, mediaUrl, account, ctx) => {
    if (!mediaUrl || typeof mediaUrl !== 'string') return null
    const url = mediaUrl.trim()
    if (!url) return null

    if (HTTP_URL_REGEX.test(url)) {
        // 下载 HTTP(S) 图片并重新上传到 Qwen OSS，确保上游 chat.qwen.ai 始终可访问。
        // 客户端（Cherry Studio、Claude Code 等）可能传入仅客户端网络内可达的 URL，
        // 直接透传会导致上游无法访问。
        try {
            const proxyAgent = getProxyAgent(account)
            const { buffer, contentType } = await downloadHttpUrl(url, {
                timeout: 30000,
                httpsAgent: proxyAgent || undefined,
                proxy: false,
            })
            const resolvedContentType = contentType || 'image/png'
            const ext = extensionFromMimeType(resolvedContentType, mediaType)
            const uploadResult = await uploadFileToQwenOss(
                buffer,
                `upload.${ext}`,
                account ? account.token : null,
                account
            )
            if (uploadResult && uploadResult.status === 200 && uploadResult.file_url) {
                logMediaEvent(ctx, 'media_upload', { media_type: mediaType, source: 'http_download', bytes: buffer.length })
                return { type: mediaType, url: uploadResult.file_url }
            }
        } catch (downloadErr) {
            logger.warn(`下载/重新上传 HTTP 图片失败 ${url.slice(0, 100)}: ${downloadErr.message}`, 'IMAGE')
        }
        // 兜底：直接透传原始 URL（保持向后兼容）
        return { type: mediaType, url }
    }

    const parsedDataUri = parseDataUri(url)
    if (parsedDataUri) {
        const mimeType = parsedDataUri.mimeType
        const ext = extensionFromMimeType(mimeType, mediaType)
        const uploadResult = await uploadFileToQwenOss(
            parsedDataUri.data,
            `upload.${ext}`,
            account ? account.token : null,
            account
        )
        if (!uploadResult || uploadResult.status !== 200 || !uploadResult.file_url) {
            throw new Error('media upload failed')
        }
        logMediaEvent(ctx, 'media_upload', { media_type: mediaType, source: 'data_uri', bytes: parsedDataUri.data.length })
        return { type: mediaType, url: uploadResult.file_url }
    }

    if (isLocalPath(url)) {
        const filePath = localPathFromMediaUrl(url)
        if (!fs.existsSync(filePath)) {
            logMediaEvent(ctx, 'media_upload_skip', { media_type: mediaType, source: 'local_missing' }, 'warn')
            return { type: mediaType, url }
        }
        const buffer = readLocalFile(url)
        const ext = path.extname(filePath).replace('.', '') || (mediaType === 'video' ? 'mp4' : 'png')
        const uploadResult = await uploadFileToQwenOss(
            buffer,
            `upload.${ext}`,
            account ? account.token : null,
            account
        )
        if (!uploadResult || uploadResult.status !== 200 || !uploadResult.file_url) {
            throw new Error('media upload failed')
        }
        logMediaEvent(ctx, 'media_upload', { media_type: mediaType, source: 'local_file', bytes: buffer.length })
        return { type: mediaType, url: uploadResult.file_url }
    }

    return { type: mediaType, url }
}

const appendNormalizedMediaFiles = async (files, mediaItems, account, ctx) => {
    if (!Array.isArray(files) || !Array.isArray(mediaItems)) return
    for (const media of mediaItems) {
        const normalized = await normalizeMediaUrlForUpstream(media.type, media.url, account, ctx)
        if (!normalized) continue
        files.push({
            type: normalized.type,
            url: normalized.url
        })
    }
}

const getPromptTextForValidation = (value) => {
    if (typeof value === 'string') return value.trim()
    if (Array.isArray(value)) return splitArrayContentToTextAndMedia(value).text.trim()
    return ''
}

const createMediaLocalError = (status, code, message, details = {}) => ({
    status,
    error: message,
    code,
    localMediaError: true,
    ...details
})

/**
 * 将上游响应体格式化为便于日志输出的对象
 * @param {*} payload - 原始响应体
 * @returns {*} 可序列化的日志对象
 */
const formatPayloadForLog = (payload) => {
    if (payload === undefined) {
        return null
    }

    if (Buffer.isBuffer(payload)) {
        return payload.toString('utf-8')
    }

    if (typeof payload === 'string') {
        const trimmedPayload = payload.trim()
        if (!trimmedPayload) {
            return ''
        }

        try {
            return JSON.parse(trimmedPayload)
        } catch (e) {
            return trimmedPayload.slice(0, 4000)
        }
    }

    if (typeof payload === 'object' && payload !== null) {
        if (typeof payload.on === 'function') {
            return '[stream]'
        }
        return payload
    }

    return payload
}

/**
 * 提取 Axios 错误的完整日志上下文
 * @param {Error} error - Axios 错误对象
 * @returns {object} 日志上下文
 */
const buildAxiosErrorLog = (error) => ({
    message: error?.message,
    code: error?.code,
    status: error?.response?.status,
    statusText: error?.response?.statusText,
    headers: error?.response?.headers,
    data: formatPayloadForLog(error?.response?.data)
})

const parseUpstreamImageError = (data) => {
    try {
        const rawPayload = formatPayloadForLog(data)
        let payload = data

        if (Array.isArray(payload) && payload.length > 0) {
            payload = payload[0]
        }

        if (typeof payload === 'string') {
            payload = JSON.parse(payload)
        }

        // 只有明确 success=false 且带错误码时，才按上游错误包处理，避免误伤正常业务响应
        if (!payload || payload.success !== false || !payload.data?.code) {
            return null
        }

        const errorData = payload.data
        if (errorData.code === 'RateLimited') {
            const waitHours = errorData.num
            logger.error(`图片/视频生成额度已用尽，需等待约 ${waitHours || '未知'} 小时`, 'CHAT', '', {
                parsed_error: errorData,
                raw_response_body: rawPayload
            })
            return {
                error: `当前账号的该功能使用次数已达上限，${waitHours ? `请等待约 ${waitHours} 小时后再试` : '请稍后再试'}`,
                code: errorData.code,
                wait_hours: waitHours,
                status: 429
            }
        }

        logger.error('请求上游服务时出现错误', 'CHAT', '', {
            parsed_error: errorData,
            raw_response_body: rawPayload
        })
        return {
            error: errorData.details || errorData.code || 'Service error, please try again later',
            code: errorData.code,
            request_id: payload.request_id,
            status: errorData.code === 'Bad_Request' && /internal error/i.test(errorData.details || '') ? 502 : 500
        }
    } catch (e) {
        return null
    }
}

const parseUpstreamImageErrorFromText = (text) => {
    try {
        if (!text || typeof text !== 'string') {
            return null
        }

        // 图片接口在额度耗尽时可能返回普通 JSON 文本而不是 SSE，需要在流结束后补做一次识别
        return parseUpstreamImageError(JSON.parse(text))
    } catch (e) {
        return null
    }
}

/**
 * 收集对象中的所有值
 * @param {*} payload - 任意负载
 * @param {Set<object>} visited - 已访问对象集合
 * @returns {Array<*>} 所有嵌套值
 */
const collectNestedValues = (payload, visited = new Set()) => {
    if (!payload || typeof payload !== 'object') {
        return []
    }

    if (visited.has(payload)) {
        return []
    }
    visited.add(payload)

    if (Array.isArray(payload)) {
        return payload.flatMap(item => [item, ...collectNestedValues(item, visited)])
    }

    return Object.values(payload).flatMap(item => [item, ...collectNestedValues(item, visited)])
}

/**
 * 解析 SSE 缓冲区中的 `data:` 负载
 *
 * 底层用统一 SSEFrameParser，行为保持兼容：
 *  - 返回的 payloads 是 JSON 字符串（不解析），调用方自行 JSON.parse
 *  - 半截 frame 留在 buffer 中由调用方继续喂入
 *  - flush=true 时强制把 buffer 末尾残留也当成 frame 吐出来
 *
 * @param {string} buffer - SSE 缓冲区
 * @param {boolean} flush - 是否强制解析剩余内容
 * @returns {{ payloads: string[], buffer: string }} 解析结果
 */
const parseSsePayloads = (buffer, flush = false) => {
    // 走统一 parser：兼容 \n\n / \r\n\r\n、半截 frame、event: 字段
    const parser = new SSEFrameParser()
    const events = parser.feed(buffer || '')

    const payloads = []
    for (const ev of events) {
        if (!ev.data) continue
        if (ev.data === '[DONE]') continue
        payloads.push(ev.data)
    }

    let remainBuffer = parser.pending || ''
    if (flush && remainBuffer.trim().length > 0) {
        // flush 模式：把残留也尽量吐出来（不报 error；遵守原行为：残留在原版是直接 split 出来）
        // 用一个临时 parser 把残留也按 frame 解析
        const tailParser = new SSEFrameParser()
        for (const ev of tailParser.feed(remainBuffer + '\n\n')) {
            if (!ev.data) continue
            if (ev.data === '[DONE]') continue
            payloads.push(ev.data)
        }
        remainBuffer = ''
    }

    return {
        payloads,
        buffer: remainBuffer
    }
}

/**
 * 从文本中提取首个资源链接
 * @param {string} text - 文本内容
 * @returns {string|null} 资源链接
 */
const extractResourceUrlFromText = (text) => {
    if (!text || typeof text !== 'string') {
        return null
    }

    const markdownUrl = text.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/i)?.[1]
    if (markdownUrl) {
        return markdownUrl
    }

    const downloadUrl = text.match(/\[Download [^\]]+\]\((https?:\/\/[^\s)]+)\)/i)?.[1]
    if (downloadUrl) {
        return downloadUrl
    }

    const plainUrl = text.match(/https?:\/\/[^\s<>"')\]]+/i)?.[0]
    return plainUrl || null
}

const extractResourceUrlsFromText = (text) => {
    if (!text || typeof text !== 'string') return []
    const urls = []
    const pushUrl = (url) => {
        if (url && !urls.includes(url)) urls.push(url)
    }

    const patterns = [
        /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/ig,
        /\[Download [^\]]+\]\((https?:\/\/[^\s)]+)\)/ig,
        /https?:\/\/[^\s<>"')\]]+/ig
    ]
    for (const pattern of patterns) {
        let matched = null
        while ((matched = pattern.exec(text)) !== null) {
            pushUrl(matched[1] || matched[0])
        }
    }
    return urls
}

/**
 * 从文本中提取视频任务 ID
 * @param {string} text - 文本内容
 * @returns {string|null} 视频任务 ID
 */
const extractVideoTaskIDFromText = (text) => {
    if (!text || typeof text !== 'string') {
        return null
    }

    const patterns = [
        /"task_id"\s*:\s*"([^"]+)"/i,
        /"taskId"\s*:\s*"([^"]+)"/i,
        /task_id\s*[:=]\s*["']?([a-zA-Z0-9._-]+)["']?/i,
        /taskId\s*[:=]\s*["']?([a-zA-Z0-9._-]+)["']?/i,
        /"id"\s*:\s*"([^"]+)"[\s\S]{0,120}"task_status"/i
    ]

    for (const pattern of patterns) {
        const matchedTaskID = text.match(pattern)?.[1]
        if (matchedTaskID && matchedTaskID.trim() !== '') {
            return matchedTaskID.trim()
        }
    }

    return null
}

/**
 * 从文本中提取响应 ID
 * @param {string} text - 文本内容
 * @returns {string[]} 响应 ID 列表
 */
const extractResponseIDsFromText = (text) => {
    if (!text || typeof text !== 'string') {
        return []
    }

    const responseIDs = []
    const patterns = [
        /"response_id"\s*:\s*"([^"]+)"/ig,
        /"responseId"\s*:\s*"([^"]+)"/ig
    ]

    for (const pattern of patterns) {
        let matched = null
        while ((matched = pattern.exec(text)) !== null) {
            const responseID = matched[1]?.trim()
            if (responseID && !responseIDs.includes(responseID)) {
                responseIDs.push(responseID)
            }
        }
    }

    return responseIDs
}

/**
 * 从上游响应中提取资源链接
 * @param {*} payload - 上游响应负载
 * @returns {string|null} 资源链接
 */
const extractResourceUrlFromPayload = (payload) => {
    if (!payload) {
        return null
    }

    if (Array.isArray(payload)) {
        for (const item of payload) {
            const matchedUrl = extractResourceUrlFromPayload(item)
            if (matchedUrl) {
                return matchedUrl
            }
        }
        return null
    }

    if (typeof payload === 'string') {
        const trimmedPayload = payload.trim()

        if ((trimmedPayload.startsWith('{') || trimmedPayload.startsWith('['))) {
            try {
                const parsedPayload = JSON.parse(trimmedPayload)
                const matchedUrl = extractResourceUrlFromPayload(parsedPayload)
                if (matchedUrl) {
                    return matchedUrl
                }
            } catch (e) {
            }
        }

        return extractResourceUrlFromText(trimmedPayload)
    }

    if (typeof payload !== 'object') {
        return null
    }

    const directCandidates = [
        payload.content,
        payload.url,
        payload.image,
        payload.video,
        payload.video_url,
        payload.videoUrl,
        payload.download_url,
        payload.downloadUrl,
        payload.file_url,
        payload.resource_url,
        payload.resourceUrl,
        payload.output_url,
        payload.result_url,
        payload.final_url,
        payload.finalUrl,
        payload.uri
    ]

    for (const candidate of directCandidates) {
        const matchedUrl = extractResourceUrlFromPayload(candidate)
        if (matchedUrl) {
            return matchedUrl
        }
    }

    const nestedCandidates = [
        payload.data,
        payload.message,
        payload.delta,
        payload.extra,
        payload.choices,
        payload.messages,
        payload.output,
        payload.result,
        payload.results,
        payload.urls,
        payload.files,
        payload.image_list,
        payload.video_list
    ]

    for (const candidate of nestedCandidates) {
        const matchedUrl = extractResourceUrlFromPayload(candidate)
        if (matchedUrl) {
            return matchedUrl
        }
    }

    for (const candidate of collectNestedValues(payload)) {
        const matchedUrl = extractResourceUrlFromPayload(candidate)
        if (matchedUrl) {
            return matchedUrl
        }
    }

    return null
}

const extractResourceUrlsFromPayload = (payload, visited = new Set()) => {
    const urls = []
    const pushUrl = (url) => {
        if (url && !urls.includes(url)) urls.push(url)
    }
    const pushAll = (items) => {
        for (const item of items || []) pushUrl(item)
    }

    if (!payload) return urls

    if (Array.isArray(payload)) {
        for (const item of payload) {
            pushAll(extractResourceUrlsFromPayload(item, visited))
        }
        return urls
    }

    if (typeof payload === 'string') {
        const trimmedPayload = payload.trim()
        if (!trimmedPayload) return urls
        if (trimmedPayload.startsWith('{') || trimmedPayload.startsWith('[')) {
            try {
                pushAll(extractResourceUrlsFromPayload(JSON.parse(trimmedPayload), visited))
            } catch (e) {
                pushAll(extractResourceUrlsFromText(trimmedPayload))
            }
        } else {
            pushAll(extractResourceUrlsFromText(trimmedPayload))
        }
        return urls
    }

    if (typeof payload !== 'object') return urls
    if (visited.has(payload)) return urls
    visited.add(payload)

    const priorityCandidates = [
        payload.content,
        payload.url,
        payload.image,
        payload.video,
        payload.video_url,
        payload.videoUrl,
        payload.download_url,
        payload.downloadUrl,
        payload.file_url,
        payload.resource_url,
        payload.resourceUrl,
        payload.output_url,
        payload.result_url,
        payload.final_url,
        payload.finalUrl,
        payload.uri,
        payload.data,
        payload.message,
        payload.delta,
        payload.extra,
        payload.choices,
        payload.messages,
        payload.output,
        payload.result,
        payload.results,
        payload.urls,
        payload.files,
        payload.image_list,
        payload.video_list
    ]

    for (const candidate of priorityCandidates) {
        pushAll(extractResourceUrlsFromPayload(candidate, visited))
    }
    for (const candidate of Object.values(payload)) {
        pushAll(extractResourceUrlsFromPayload(candidate, visited))
    }

    return urls
}

/**
 * 从上游响应中提取响应 ID
 * @param {*} payload - 上游响应负载
 * @returns {string[]} 响应 ID 列表
 */
const extractResponseIDsFromPayload = (payload) => {
    if (!payload) {
        return []
    }

    if (Array.isArray(payload)) {
        return payload.flatMap(item => extractResponseIDsFromPayload(item))
    }

    if (typeof payload === 'string') {
        const trimmedPayload = payload.trim()
        if (!trimmedPayload) {
            return []
        }

        try {
            return extractResponseIDsFromPayload(JSON.parse(trimmedPayload))
        } catch (e) {
            return extractResponseIDsFromText(trimmedPayload)
        }
    }

    if (typeof payload !== 'object') {
        return []
    }

    const responseIDs = []
    const pushResponseID = (responseID) => {
        if ((typeof responseID === 'string' || typeof responseID === 'number') && String(responseID).trim() !== '') {
            const normalizedResponseID = String(responseID).trim()
            if (!responseIDs.includes(normalizedResponseID)) {
                responseIDs.push(normalizedResponseID)
            }
        }
    }

    pushResponseID(payload.response_id)
    pushResponseID(payload.responseId)
    pushResponseID(payload?.response?.created?.response_id)
    pushResponseID(payload?.response?.created?.responseId)

    for (const candidate of collectNestedValues(payload)) {
        for (const nestedID of extractResponseIDsFromPayload(candidate)) {
            pushResponseID(nestedID)
        }
    }

    return responseIDs
}

/**
 * 从上游响应中提取视频任务 ID
 * @param {*} payload - 上游响应负载
 * @returns {string|null} 视频任务 ID
 */
const extractVideoTaskIdentifiersFromPayload = (payload, options = {}) => {
    const includeResponseIdsAsFallback = options.includeResponseIdsAsFallback !== false
    if (!payload) {
        return []
    }

    if (Array.isArray(payload)) {
        const taskIDs = []
        for (const item of payload) {
            for (const taskID of extractVideoTaskIdentifiersFromPayload(item, options)) {
                if (!taskIDs.includes(taskID)) {
                    taskIDs.push(taskID)
                }
            }
        }
        return taskIDs
    }

    if (typeof payload === 'string') {
        const trimmedPayload = payload.trim()
        if (!trimmedPayload) {
            return []
        }

        try {
            return extractVideoTaskIdentifiersFromPayload(JSON.parse(trimmedPayload), options)
        } catch (e) {
            const taskID = extractVideoTaskIDFromText(trimmedPayload)
            return taskID ? [taskID] : []
        }
    }

    if (typeof payload !== 'object') {
        return []
    }

    const taskIDs = []
    const pushTaskID = (taskID) => {
        if ((typeof taskID === 'string' || typeof taskID === 'number') && String(taskID).trim() !== '') {
            const normalizedTaskID = String(taskID).trim()
            if (!taskIDs.includes(normalizedTaskID)) {
                taskIDs.push(normalizedTaskID)
            }
        }
    }

    pushTaskID(payload.task_id)
    pushTaskID(payload.taskId)
    pushTaskID(payload?.wanx?.task_id)
    pushTaskID(payload?.output?.task_id)
    pushTaskID(payload?.result?.task_id)
    pushTaskID(payload?.results?.task_id)
    if (includeResponseIdsAsFallback) {
        pushTaskID(payload.response_id)
        pushTaskID(payload.responseId)
    }

    const nestedCandidates = [
        payload.wanx,
        payload.data,
        payload.message,
        payload.delta,
        payload.extra,
        payload.choices,
        payload.messages,
        payload.output,
        payload.result,
        payload.results
    ]

    for (const candidate of nestedCandidates) {
        for (const taskID of extractVideoTaskIdentifiersFromPayload(candidate, options)) {
            pushTaskID(taskID)
        }
    }

    const isTaskPayload = payload.task_status || payload.status === 'pending' || payload.status === 'running' || payload.type === 'task' || /task/i.test(payload.object || '')
    if (isTaskPayload && (typeof payload.id === 'string' || typeof payload.id === 'number') && String(payload.id).trim() !== '') {
        pushTaskID(payload.id)
    }

    for (const candidate of collectNestedValues(payload)) {
        for (const taskID of extractVideoTaskIdentifiersFromPayload(candidate, options)) {
            pushTaskID(taskID)
        }
    }

    return taskIDs
}

/**
 * 从上游响应中提取首个视频任务 ID
 * @param {*} payload - 上游响应负载
 * @returns {string|null} 视频任务 ID
 */
const extractVideoTaskIDFromPayload = (payload) => extractVideoTaskIdentifiersFromPayload(payload)[0] || null

/**
 * 判断是否属于可重试的上游生成错误
 * @param {object|null} upstreamError - 上游错误
 * @returns {boolean} 是否可重试
 */
const isRetryableUpstreamError = (upstreamError) => {
    if (!upstreamError) {
        return false
    }

    return (upstreamError.code === 'Bad_Request' && /internal error/i.test(upstreamError.error || '')) ||
        upstreamError.code === 'Internal_Server_Error' ||
        upstreamError.code === 'RateLimited'
}

/**
 * 向下游发送上游错误
 * @param {object} res - Express 响应对象
 * @param {object} upstreamError - 上游错误
 * @returns {*} 响应结果
 */
const sendUpstreamError = (res, upstreamError) => {
    const { status, ...payload } = upstreamError
    return res.status(status || 500).json(payload)
}

/**
 * 构造图片消息内容
 * @param {string} contentUrl - 图片链接
 * @returns {string} 图片消息内容
 */
const buildImageContent = (contentUrl) => `![image](${contentUrl})`

const buildImageContentFromUrls = (contentUrls) => {
    const urls = Array.isArray(contentUrls) ? contentUrls.filter(Boolean) : []
    return urls.map(buildImageContent).join('\n\n')
}

/**
 * 构造视频消息内容
 * @param {string} contentUrl - 视频链接
 * @returns {string} 视频消息内容
 */
const buildVideoContent = (contentUrl) => `\n<video controls="controls">\n${contentUrl}\n</video>\n\n[Download Video](${contentUrl})\n`

/**
 * 解析可能为 JSON 字符串的请求字段
 * @param {*} value - 原始值
 * @returns {*} 解析后的值
 */
const parseMaybeJSON = (value) => {
    if (typeof value !== 'string') {
        return value
    }

    const trimmedValue = value.trim()
    if (!trimmedValue) {
        return value
    }

    try {
        return JSON.parse(trimmedValue)
    } catch (e) {
        return value
    }
}

/**
 * 统一转为数组
 * @param {*} value - 原始值
 * @returns {Array<*>} 数组结果
 */
const ensureArray = (value) => {
    const parsedValue = parseMaybeJSON(value)

    if (parsedValue === undefined || parsedValue === null || parsedValue === '') {
        return []
    }

    return Array.isArray(parsedValue) ? parsedValue : [parsedValue]
}

/**
 * 规范化 OpenAI 风格尺寸参数
 * @param {string} size - 原始尺寸
 * @returns {string|undefined} 规范化后的尺寸
 */
const normalizeOpenAIImageVideoSize = (size) => {
    if (!size) {
        return undefined
    }

    const normalizedSizeMap = {
        '1024x1024': '1:1',
        '1536x1024': '4:3',
        '1024x1536': '3:4',
        '1792x1024': '16:9',
        '1024x1792': '9:16'
    }

    return normalizedSizeMap[size] || size
}

/**
 * 统一构造 OpenAI 风格错误响应
 * @param {object} res - Express 响应对象
 * @param {*} error - 错误对象
 * @returns {*} 响应结果
 */
const sendOpenAIErrorResponse = (res, error) => {
    const status = error?.status || 500
    const message = error?.error || error?.message || 'Service error, please try again later'

    return res.status(status).json({
        error: {
            message,
            type: status >= 500 ? 'server_error' : 'invalid_request_error'
        }
    })
}

/**
 * 下载资源并转换为 Base64
 * @param {string} contentUrl - 资源链接
 * @returns {Promise<string>} Base64 内容
 */
const downloadAssetAsBase64 = async (contentUrl, account) => {
    const proxyAgent = getProxyAgent(account)
    const requestConfig = {
        responseType: 'arraybuffer',
        timeout: 1000 * 60 * 2
    }

    if (proxyAgent) {
        requestConfig.httpsAgent = proxyAgent
        requestConfig.proxy = false
    }

    const responseData = await axios.get(contentUrl, requestConfig)
    return Buffer.from(responseData.data).toString('base64')
}

/**
 * 构造 OpenAI 图像响应项
 * @param {string} contentUrl - 图片链接
 * @param {string} responseFormat - 输出格式
 * @returns {Promise<object>} 图像响应项
 */
const buildOpenAIImageResultItem = async (contentUrl, responseFormat, account) => {
    if (responseFormat === 'b64_json') {
        return {
            b64_json: await downloadAssetAsBase64(contentUrl, account)
        }
    }

    return {
        url: contentUrl
    }
}

/**
 * 从请求对象中提取内联媒体链接
 * @param {*} value - 原始媒体值
 * @param {string} mediaType - 媒体类型
 * @returns {string|null} 媒体链接
 */
const extractInlineMediaURL = (value, mediaType) => {
    const parsedValue = parseMaybeJSON(value)

    if (typeof parsedValue === 'string') {
        return parsedValue
    }

    if (!parsedValue || typeof parsedValue !== 'object') {
        return null
    }

    if (mediaType === 'video') {
        return parsedValue.url || parsedValue.video || parsedValue.video_url?.url || parsedValue.input_video?.url || parsedValue.input_video?.video_url || null
    }

    return parsedValue.url || parsedValue.image || parsedValue.image_url?.url || null
}

/**
 * 构造内部媒体内容项
 * @param {string} mediaType - 媒体类型
 * @param {string} mediaURL - 媒体链接
 * @returns {object} 内部媒体内容项
 */
const buildInternalMediaItem = (mediaType, mediaURL) => {
    if (mediaType === 'video') {
        return {
            type: 'video',
            video: mediaURL
        }
    }

    return {
        type: 'image',
        image: mediaURL
    }
}

/**
 * 上传 multipart 文件并构造内部媒体内容项
 * @param {object} file - multer 文件对象
 * @param {string} mediaType - 媒体类型
 * @returns {Promise<object>} 内部媒体内容项
 */
const uploadMultipartMediaFile = async (file, mediaType, account, ctx) => {
    if (!file?.buffer) {
        throw new Error('上传文件内容为空')
    }

    const fallbackExtension = mediaType === 'video' ? 'mp4' : 'png'
    const originalFilename = file.originalname || `upload.${fallbackExtension}`
    const uploadAccount = getSafeMediaAccount(account)
    const uploadResult = await uploadFileToQwenOss(file.buffer, originalFilename, uploadAccount ? uploadAccount.token : null, uploadAccount)

    if (!uploadResult || uploadResult.status !== 200) {
        throw new Error('文件上传失败')
    }

    logMediaEvent(ctx, 'media_upload', { media_type: mediaType, source: 'multipart', bytes: file.buffer.length })
    return buildInternalMediaItem(mediaType, uploadResult.file_url)
}

/**
 * 将内联媒体参数转换为内部媒体内容项
 * @param {*} value - 原始媒体值
 * @param {string} mediaType - 媒体类型
 * @returns {Promise<object|null>} 内部媒体内容项
 */
const normalizeInlineMediaItem = async (value, mediaType, account, ctx) => {
    const mediaURL = extractInlineMediaURL(value, mediaType)
    if (!mediaURL) {
        return null
    }

    const normalized = await normalizeMediaUrlForUpstream(mediaType, mediaURL, getSafeMediaAccount(account), ctx)
    return normalized ? buildInternalMediaItem(mediaType, normalized.url) : null
}

/**
 * 收集请求中的媒体内容项
 * @param {object} req - Express 请求对象
 * @param {string} fieldName - 字段名
 * @param {string} mediaType - 媒体类型
 * @returns {Promise<Array<object>>} 媒体内容项列表
 */
const collectRequestMediaItems = async (req, fieldName, mediaType, account, ctx) => {
    const mediaItems = []
    const matchedFiles = (req.files || []).filter(file => file.fieldname === fieldName)

    for (const file of matchedFiles) {
        mediaItems.push(await uploadMultipartMediaFile(file, mediaType, account, ctx))
    }

    for (const value of ensureArray(req.body?.[fieldName])) {
        const normalizedMediaItem = await normalizeInlineMediaItem(value, mediaType, account, ctx)
        if (normalizedMediaItem) {
            mediaItems.push(normalizedMediaItem)
        }
    }

    return mediaItems
}

/**
 * 解析请求模型，未显式传入时按能力选择默认模型
 * @param {string} model - 请求模型
 * @param {string} chatType - 聊天类型
 * @returns {Promise<string>} 可直接发送到上游的模型 ID
 */
const resolveRequestedModel = async (model, chatType) => {
    if (model) {
        return parserModel(model)
    }

    const defaultModel = await getDefaultModelByChatType(chatType)
    return defaultModel || parserModel(model)
}

/**
 * 读取视频上游流并提取任务信息
 * @param {*} responseStream - 上游响应流
 * @returns {Promise<{ upstreamError: object|null, contentUrl: string|null, videoTaskID: string|null, videoTaskCandidates: string[], responseIDs: string[], rawPreview: string }>} 解析结果
 */
const readVideoUpstreamResult = async (responseStream) => {
    if (!responseStream || typeof responseStream.on !== 'function') {
        const videoTaskCandidates = extractVideoTaskIdentifiersFromPayload(responseStream, { includeResponseIdsAsFallback: false })
        const responseIDs = extractResponseIDsFromPayload(responseStream)
        return {
            upstreamError: parseUpstreamImageError(responseStream),
            contentUrl: extractResourceUrlFromPayload(responseStream),
            videoTaskID: videoTaskCandidates[0] || null,
            videoTaskCandidates,
            responseIDs,
            rawPreview: typeof responseStream === 'string' ? responseStream.slice(0, 400) : ''
        }
    }

    const decoder = new TextDecoder('utf-8')
    let rawText = ''
    let buffer = ''
    let upstreamError = null
    let contentUrl = null
    const contentUrls = []
    const videoTaskCandidates = []
    const responseIDs = []
    const pushVideoTaskCandidate = (taskID) => {
        if (taskID && !videoTaskCandidates.includes(taskID)) {
            videoTaskCandidates.push(taskID)
        }
    }
    const pushResponseID = (responseID) => {
        if (responseID && !responseIDs.includes(responseID)) {
            responseIDs.push(responseID)
        }
    }

    const applyPayload = (payload) => {
        if (!upstreamError) {
            upstreamError = parseUpstreamImageError(payload)
        }

        if (!contentUrl) {
            contentUrl = extractResourceUrlFromPayload(payload)
        }

        for (const taskID of extractVideoTaskIdentifiersFromPayload(payload, { includeResponseIdsAsFallback: false })) {
            pushVideoTaskCandidate(taskID)
        }

        for (const responseID of extractResponseIDsFromPayload(payload)) {
            pushResponseID(responseID)
        }
    }

    let resolved = false
    await new Promise((resolve, reject) => {
        // 视频生成可能耗时数分钟，但 taskID 通常在流开头就返回了
        // 拿到 taskID 后无需等待整个流结束，提前退出
        const timer = setTimeout(() => {
            if (resolved) return
            resolved = true
            reject(new Error('上游流读取超时 (600s)'))
        }, 600 * 1000)

        const tryEarlyResolve = () => {
            if (resolved) return
            // 有业务错误（RateLimited 等）→ 立即退出
            if (upstreamError) {
                resolved = true
                clearTimeout(timer)
                resolve()
                return
            }
            // 有视频链接或任务 ID → 提前退出，不等流结束
            if (contentUrl || videoTaskCandidates.length > 0) {
                resolved = true
                clearTimeout(timer)
                resolve()
            }
        }

        responseStream.on('data', (chunk) => {
            const decoded = decoder.decode(chunk, { stream: true })
            rawText += decoded
            buffer += decoded

            const parsedResult = parseSsePayloads(buffer)
            buffer = parsedResult.buffer

            for (const payload of parsedResult.payloads) {
                applyPayload(payload)
            }
            tryEarlyResolve()
        })

        responseStream.on('end', () => {
            if (resolved) return
            resolved = true
            clearTimeout(timer)
            resolve()
        })
        responseStream.on('error', (err) => {
            if (resolved) return
            resolved = true
            clearTimeout(timer)
            reject(err)
        })
    })

    const flushedResult = parseSsePayloads(buffer, true)
    for (const payload of flushedResult.payloads) {
        applyPayload(payload)
    }

    const trimmedRawText = rawText.trim()
    if (!upstreamError) {
        upstreamError = parseUpstreamImageErrorFromText(trimmedRawText) || parseUpstreamImageError(trimmedRawText)
    }

    if (!contentUrl) {
        contentUrl = extractResourceUrlFromPayload(trimmedRawText)
    }

    for (const taskID of extractVideoTaskIdentifiersFromPayload(trimmedRawText, { includeResponseIdsAsFallback: false })) {
        pushVideoTaskCandidate(taskID)
    }

    return {
        upstreamError,
        contentUrl,
        videoTaskID: videoTaskCandidates[0] || null,
        videoTaskCandidates,
        responseIDs,
        rawPreview: trimmedRawText.slice(0, 400)
    }
}

/**
 * 读取图片上游流并提取响应信息
 * @param {*} responseStream - 上游响应流
 * @returns {Promise<{ upstreamError: object|null, contentUrl: string|null, responseIDs: string[], rawPreview: string }>} 解析结果
 */
const readImageUpstreamResult = async (responseStream) => {
    if (!responseStream || typeof responseStream.on !== 'function') {
        const contentUrls = extractResourceUrlsFromPayload(responseStream)
        return {
            upstreamError: parseUpstreamImageError(responseStream),
            contentUrl: contentUrls[0] || null,
            contentUrls,
            responseIDs: extractResponseIDsFromPayload(responseStream),
            rawPreview: typeof responseStream === 'string' ? responseStream.slice(0, 400) : ''
        }
    }

    const decoder = new TextDecoder('utf-8')
    let rawText = ''
    let buffer = ''
    let upstreamError = null
    let contentUrl = null
    const contentUrls = []
    const pushContentUrl = (url) => {
        if (url && !contentUrls.includes(url)) {
            contentUrls.push(url)
        }
    }
    const responseIDs = []
    const pushResponseID = (responseID) => {
        if (responseID && !responseIDs.includes(responseID)) {
            responseIDs.push(responseID)
        }
    }

    const applyPayload = (payload) => {
        if (!upstreamError) {
            upstreamError = parseUpstreamImageError(payload)
        }

        for (const url of extractResourceUrlsFromPayload(payload)) {
            pushContentUrl(url)
        }

        if (!contentUrl && contentUrls.length > 0) {
            contentUrl = contentUrls[0]
        }

        for (const responseID of extractResponseIDsFromPayload(payload)) {
            pushResponseID(responseID)
        }
    }

    await new Promise((resolve, reject) => {
        // 视频/图片生成可能耗时数分钟，10 分钟超时
        const timer = setTimeout(() => {
            reject(new Error('上游流读取超时 (600s)'))
        }, 600 * 1000)

        responseStream.on('data', (chunk) => {
            const decoded = decoder.decode(chunk, { stream: true })
            rawText += decoded
            buffer += decoded

            const parsedResult = parseSsePayloads(buffer)
            buffer = parsedResult.buffer

            for (const payload of parsedResult.payloads) {
                applyPayload(payload)
            }
        })

        responseStream.on('end', () => { clearTimeout(timer); resolve() })
        responseStream.on('error', (err) => { clearTimeout(timer); reject(err) })
    })

    const flushedResult = parseSsePayloads(buffer, true)
    for (const payload of flushedResult.payloads) {
        applyPayload(payload)
    }

    const trimmedRawText = rawText.trim()
    if (!upstreamError) {
        upstreamError = parseUpstreamImageErrorFromText(trimmedRawText) || parseUpstreamImageError(trimmedRawText)
    }

    for (const url of extractResourceUrlsFromPayload(trimmedRawText)) {
        pushContentUrl(url)
    }

    if (!contentUrl && contentUrls.length > 0) {
        contentUrl = contentUrls[0]
    }

    for (const responseID of extractResponseIDsFromPayload(trimmedRawText)) {
        pushResponseID(responseID)
    }

    return {
        upstreamError,
        contentUrl,
        contentUrls,
        responseIDs,
        rawPreview: trimmedRawText.slice(0, 400)
    }
}

/**
 * 拉取聊天详情
 * @param {string} chatID - 对话 ID
 * @param {string} token - 访问令牌
 * @returns {Promise<object|null>} 聊天详情
 */
const getChatDetail = async (chatID, token, account) => {
    try {
        const chatBaseUrl = getChatBaseUrl()
        const requestConfig = await upstream.buildRequestConfig({
            token,
            account,
            baseUrl: chatBaseUrl,
            extraConfig: {
                timeout: 15000
            }
        })

        const responseData = await axios.get(qwenWeb.endpoints.buildUrl(chatBaseUrl, qwenWeb.endpoints.PATHS.chatsDetail(chatID)), requestConfig)
        return responseData.data || null
    } catch (error) {
        logger.error(`获取聊天详情失败 (${chatID})`, 'CHAT', '', buildAxiosErrorLog(error))
        return null
    }
}

/**
 * 从聊天详情中提取资源与任务信息
 * @param {*} chatDetail - 聊天详情
 * @param {string[]} responseIDs - 响应 ID 列表
 * @returns {{ contentUrl: string|null, videoTaskCandidates: string[] }} 提取结果
 */
const extractVideoInfoFromChatDetail = (chatDetail, responseIDs = []) => {
    const responseIDSet = new Set(responseIDs.filter(Boolean))
    const allMessages = []

    const messageMap = chatDetail?.data?.chat?.history?.messages
    if (messageMap && typeof messageMap === 'object') {
        allMessages.push(...Object.values(messageMap))
    }

    const messages = chatDetail?.data?.chat?.messages
    if (Array.isArray(messages)) {
        allMessages.push(...messages)
    }

    const pushUnique = (list, value) => {
        if (value && !list.includes(value)) {
            list.push(value)
        }
    }

    let contentUrl = null
    const contentUrls = []
    const videoTaskCandidates = []

    const candidateMessages = allMessages.filter(message => {
        if (!message || typeof message !== 'object') {
            return false
        }

        const responseID = message.response_id || message.responseId || message.id
        if (responseIDSet.size === 0) {
            return true
        }

        return responseID && responseIDSet.has(String(responseID))
    })

    for (const message of candidateMessages) {
        for (const url of extractResourceUrlsFromPayload(message)) {
            pushUnique(contentUrls, url)
        }

        if (!contentUrl && contentUrls.length > 0) {
            contentUrl = contentUrls[0]
        }

        for (const taskID of extractVideoTaskIdentifiersFromPayload(message, { includeResponseIdsAsFallback: false })) {
            pushUnique(videoTaskCandidates, taskID)
        }
    }

    return {
        contentUrl,
        contentUrls,
        videoTaskCandidates
    }
}

/**
 * 解析图片生成结果链接
 * @param {*} responseData - 上游响应
 * @param {string} chatID - 会话 ID
 * @param {string} token - 当前账号令牌
 * @returns {Promise<string>} 图片链接
 */
const resolveImageResultContentUrls = async (responseData, chatID, token, account, ctx) => {
    const { upstreamError, contentUrls: upstreamContentUrls = [], responseIDs, rawPreview } = await readImageUpstreamResult(responseData)
    if (upstreamError) {
        throw upstreamError
    }

    const contentUrls = [...upstreamContentUrls]

    if (contentUrls.length === 0 && chatID) {
        for (let attempt = 1; attempt <= 5; attempt++) {
            const chatDetail = await getChatDetail(chatID, token, account)
            const extractedInfo = extractVideoInfoFromChatDetail(chatDetail, responseIDs)
            for (const url of extractedInfo.contentUrls || []) {
                if (url && !contentUrls.includes(url)) {
                    contentUrls.push(url)
                }
            }
            if (contentUrls.length > 0) {
                break
            }

            await sleep(800)
        }
    }

    if (contentUrls.length === 0) {
        logger.warn(`图片上游响应未解析出图片链接，responseIDs=${JSON.stringify(responseIDs)} preview=${rawPreview}`, 'CHAT')
        throw new Error('上游未返回图片链接')
    }

    logMediaEvent(ctx, 'image_result', { resultSource: upstreamContentUrls.length > 0 ? 'upstream' : 'chat_detail', result_count: contentUrls.length })
    return contentUrls
}

/**
 * 从已读取的 readImageUpstreamResult 结果中提取图片 URL（用于 retry loop 缓存）
 */
const resolveImageResultContentUrlsFromReadResult = async (readResult, chatID, token, account, ctx) => {
    const { contentUrls: upstreamContentUrls = [], responseIDs, rawPreview } = readResult

    const contentUrls = [...upstreamContentUrls]

    if (contentUrls.length === 0 && chatID) {
        for (let attempt = 1; attempt <= 5; attempt++) {
            const chatDetail = await getChatDetail(chatID, token, account)
            const extractedInfo = extractVideoInfoFromChatDetail(chatDetail, responseIDs)
            for (const url of extractedInfo.contentUrls || []) {
                if (url && !contentUrls.includes(url)) {
                    contentUrls.push(url)
                }
            }
            if (contentUrls.length > 0) {
                break
            }

            await sleep(800)
        }
    }

    if (contentUrls.length === 0) {
        logger.warn(`图片上游响应未解析出图片链接，responseIDs=${JSON.stringify(responseIDs)} preview=${rawPreview}`, 'CHAT')
        throw new Error('上游未返回图片链接')
    }

    logMediaEvent(ctx, 'image_result', { resultSource: upstreamContentUrls.length > 0 ? 'upstream' : 'chat_detail', result_count: contentUrls.length })
    return contentUrls
}

const resolveImageResultContentUrl = async (responseData, chatID, token, account, ctx) => {
    const contentUrls = await resolveImageResultContentUrls(responseData, chatID, token, account, ctx)
    return contentUrls[0]
}

/**
 * 解析视频生成结果链接
 * @param {*} responseStream - 上游响应流
 * @param {string} token - 当前账号令牌
 * @param {string} chatID - 会话 ID
 * @returns {Promise<string>} 视频链接
 */
const resolveVideoResultContentUrl = async (responseStream, token, chatID, account, ctx) => {
    const { upstreamError, contentUrl: upstreamContentUrl, videoTaskCandidates, responseIDs, rawPreview } = await readVideoUpstreamResult(responseStream)
    if (upstreamError) {
        throw upstreamError
    }

    if (upstreamContentUrl) {
        return upstreamContentUrl
    }

    let resolvedContentUrl = upstreamContentUrl
    let resolvedTaskCandidates = [...videoTaskCandidates]

    if (!resolvedContentUrl && resolvedTaskCandidates.length === 0 && chatID) {
        logger.info(`视频上游未直接返回任务信息，尝试从聊天详情补取，chat_id=${chatID} responseIDs=${JSON.stringify(responseIDs)}`, 'CHAT')

        // 视频任务异步创建，可能需要较长时间才能出现在聊天详情中
        // 最多轮询 100 次，每次间隔 6 秒（共 10 分钟）
        for (let attempt = 1; attempt <= 100; attempt++) {
            const chatDetail = await getChatDetail(chatID, token, account)
            const extractedInfo = extractVideoInfoFromChatDetail(chatDetail, responseIDs)

            // 首次尝试和每 10 次输出诊断日志
            if (attempt === 1 || attempt % 10 === 0) {
                const hasDetail = !!chatDetail
                const historyMsgCount = chatDetail?.data?.chat?.history?.messages
                    ? Object.keys(chatDetail.data.chat.history.messages).length
                    : 0
                const msgCount = chatDetail?.data?.chat?.messages?.length || 0
                logger.info(`视频聊天详情轮询 #${attempt}: hasDetail=${hasDetail} historyMsgs=${historyMsgCount} msgs=${msgCount} foundUrl=${!!extractedInfo.contentUrl} foundTasks=${extractedInfo.videoTaskCandidates.length}`, 'CHAT')

                // 首次尝试时输出消息的 response_id 列表，排查匹配问题
                if (attempt === 1 && hasDetail) {
                    const allMsgs = [
                        ...Object.values(chatDetail?.data?.chat?.history?.messages || {}),
                        ...(chatDetail?.data?.chat?.messages || [])
                    ]
                    const msgIds = allMsgs.map(m => ({
                        role: m?.role,
                        response_id: m?.response_id,
                        responseId: m?.responseId,
                        id: m?.id,
                        hasTaskId: !!m?.task_id || !!m?.taskId,
                        hasWanx: !!m?.wanx,
                        contentPreview: typeof m?.content === 'string' ? m.content.slice(0, 80) : (m?.content ? '[non-string]' : '[empty]')
                    }))
                    logger.info(`视频聊天详情消息列表: ${JSON.stringify(msgIds)}`, 'CHAT')
                }
            }

            if (!resolvedContentUrl && extractedInfo.contentUrl) {
                resolvedContentUrl = extractedInfo.contentUrl
            }

            for (const taskID of extractedInfo.videoTaskCandidates) {
                if (!resolvedTaskCandidates.includes(taskID)) {
                    resolvedTaskCandidates.push(taskID)
                }
            }

            if (resolvedContentUrl || resolvedTaskCandidates.length > 0) {
                logger.info(`视频聊天详情轮询命中: attempt=${attempt} hasUrl=${!!resolvedContentUrl} taskCount=${resolvedTaskCandidates.length}`, 'CHAT')
                break
            }

            await sleep(6000)
        }
    }

    if (resolvedContentUrl) {
        return resolvedContentUrl
    }

    if (resolvedTaskCandidates.length === 0) {
        logger.warn(`视频上游响应未解析出任务信息，contentUrl=${resolvedContentUrl || '空'} candidates=${JSON.stringify(resolvedTaskCandidates)} responseIDs=${JSON.stringify(responseIDs)} preview=${rawPreview}`, 'CHAT')
        throw new Error('上游未返回视频任务 ID 或视频链接')
    }

    resolvedTaskCandidates = resolvedTaskCandidates.map(id => ({ id, fallback: false }))

    logger.info(`视频任务候选ID: ${JSON.stringify(resolvedTaskCandidates)}`, 'CHAT')

    const maxAttempts = 60
    const fallbackMaxAttempts = 6
    const delay = 20 * 1000
    let pollAttempts = 0

    for (const taskCandidate of resolvedTaskCandidates) {
        const taskID = taskCandidate.id || taskCandidate
        const attemptsForCandidate = taskCandidate.fallback ? fallbackMaxAttempts : maxAttempts
        logger.info(`开始轮询视频任务ID: ${taskID}`, 'CHAT')

        for (let i = 0; i < attemptsForCandidate; i++) {
            pollAttempts += 1
            const status = await getVideoTaskStatus(taskID, token, account)
            if (!status) {
                logMediaEvent(ctx, 'video_task_skip', { task_state: 'unknown', pollAttempts }, 'warn')
                break
            }
            if (status.state === 'success') {
                logMediaEvent(ctx, 'video_result', { resultSource: 'task_status', pollAttempts })
                return status.contentUrl
            }
            if (status.state === 'failed' || status.state === 'invalid') {
                logMediaEvent(ctx, 'video_task_skip', { task_state: status.state, pollAttempts }, status.state === 'failed' ? 'warn' : 'debug')
                break
            }

            await sleep(delay)
        }
    }

    logger.error(`视频任务 ${JSON.stringify(resolvedTaskCandidates)} 轮询超时`, 'CHAT')
    throw {
        status: 504,
        error: '视频生成超时，请稍后再试'
    }
}

/**
 * 从已读取的 readVideoUpstreamResult 结果中解析视频 URL（用于 retry loop 缓存）
 */
const resolveVideoResultContentUrlFromReadResult = async (readResult, token, chatID, account, ctx) => {
    const { upstreamError, contentUrl: upstreamContentUrl, videoTaskCandidates = [], responseIDs = [], rawPreview } = readResult
    if (upstreamError) {
        throw upstreamError
    }

    if (upstreamContentUrl) {
        return upstreamContentUrl
    }

    let resolvedContentUrl = upstreamContentUrl
    let resolvedTaskCandidates = [...videoTaskCandidates]

    if (!resolvedContentUrl && resolvedTaskCandidates.length === 0 && chatID) {
        logger.info(`视频上游未直接返回任务信息，尝试从聊天详情补取，chat_id=${chatID} responseIDs=${JSON.stringify(responseIDs)}`, 'CHAT')

        // 视频任务异步创建，可能需要较长时间才能出现在聊天详情中
        // 最多轮询 100 次，每次间隔 6 秒（共 10 分钟）
        for (let attempt = 1; attempt <= 100; attempt++) {
            const chatDetail = await getChatDetail(chatID, token, account)
            const extractedInfo = extractVideoInfoFromChatDetail(chatDetail, responseIDs)

            // 首次尝试和每 10 次输出诊断日志
            if (attempt === 1 || attempt % 10 === 0) {
                const hasDetail = !!chatDetail
                const historyMsgCount = chatDetail?.data?.chat?.history?.messages
                    ? Object.keys(chatDetail.data.chat.history.messages).length
                    : 0
                const msgCount = chatDetail?.data?.chat?.messages?.length || 0
                logger.info(`视频聊天详情轮询 #${attempt}: hasDetail=${hasDetail} historyMsgs=${historyMsgCount} msgs=${msgCount} foundUrl=${!!extractedInfo.contentUrl} foundTasks=${extractedInfo.videoTaskCandidates.length}`, 'CHAT')

                // 首次尝试时输出消息的 response_id 列表，排查匹配问题
                if (attempt === 1 && hasDetail) {
                    const allMsgs = [
                        ...Object.values(chatDetail?.data?.chat?.history?.messages || {}),
                        ...(chatDetail?.data?.chat?.messages || [])
                    ]
                    const msgIds = allMsgs.map(m => ({
                        role: m?.role,
                        response_id: m?.response_id,
                        responseId: m?.responseId,
                        id: m?.id,
                        hasTaskId: !!m?.task_id || !!m?.taskId,
                        hasWanx: !!m?.wanx,
                        contentPreview: typeof m?.content === 'string' ? m.content.slice(0, 80) : (m?.content ? '[non-string]' : '[empty]')
                    }))
                    logger.info(`视频聊天详情消息列表: ${JSON.stringify(msgIds)}`, 'CHAT')
                }
            }

            if (!resolvedContentUrl && extractedInfo.contentUrl) {
                resolvedContentUrl = extractedInfo.contentUrl
            }

            for (const taskID of extractedInfo.videoTaskCandidates) {
                if (!resolvedTaskCandidates.includes(taskID)) {
                    resolvedTaskCandidates.push(taskID)
                }
            }

            if (resolvedContentUrl || resolvedTaskCandidates.length > 0) {
                logger.info(`视频聊天详情轮询命中: attempt=${attempt} hasUrl=${!!resolvedContentUrl} taskCount=${resolvedTaskCandidates.length}`, 'CHAT')
                break
            }

            await sleep(6000)
        }
    }

    if (resolvedContentUrl) {
        return resolvedContentUrl
    }

    if (resolvedTaskCandidates.length === 0) {
        logger.warn(`视频上游响应未解析出任务信息，contentUrl=${resolvedContentUrl || '空'} candidates=${JSON.stringify(resolvedTaskCandidates)} responseIDs=${JSON.stringify(responseIDs)} preview=${rawPreview}`, 'CHAT')
        throw new Error('上游未返回视频任务 ID 或视频链接')
    }

    resolvedTaskCandidates = resolvedTaskCandidates.map(id => ({ id, fallback: false }))

    logger.info(`视频任务候选ID: ${JSON.stringify(resolvedTaskCandidates)}`, 'CHAT')

    const maxAttempts = 60
    const fallbackMaxAttempts = 6
    const delay = 20 * 1000
    let pollAttempts = 0

    for (const taskCandidate of resolvedTaskCandidates) {
        const taskID = taskCandidate.id || taskCandidate
        const attemptsForCandidate = taskCandidate.fallback ? fallbackMaxAttempts : maxAttempts
        logger.info(`开始轮询视频任务ID: ${taskID}`, 'CHAT')

        for (let i = 0; i < attemptsForCandidate; i++) {
            pollAttempts += 1
            const status = await getVideoTaskStatus(taskID, token, account)
            if (!status) {
                logMediaEvent(ctx, 'video_task_skip', { task_state: 'unknown', pollAttempts }, 'warn')
                break
            }
            if (status.state === 'success') {
                logMediaEvent(ctx, 'video_result', { resultSource: 'task_status', pollAttempts })
                return status.contentUrl
            }
            if (status.state === 'failed' || status.state === 'invalid') {
                logMediaEvent(ctx, 'video_task_skip', { task_state: status.state, pollAttempts }, status.state === 'failed' ? 'warn' : 'debug')
                break
            }

            await sleep(delay)
        }
    }

    logger.error(`视频任务 ${JSON.stringify(resolvedTaskCandidates)} 轮询超时`, 'CHAT')
    throw {
        status: 504,
        error: '视频生成超时，请稍后再试'
    }
}

/**
 * 统一执行图片/视频请求
 * @param {object} payload - 内部请求体
 * @returns {Promise<{ model: string, chatType: string, contentUrl: string, content: string }>} 执行结果
 */
const generateImageVideoResult = async (payload) => {
    const { model, messages, size, chat_type } = payload
    // 视频生成使用非流式请求（stream=false），上游 SSE 流无法返回视频任务信息
    // 图片生成使用流式请求（stream=true），可以直接从 SSE 流中提取图片 URL
    const upstreamStream = chat_type !== 't2v'
    // 一次取出账户对象，确保 token 与 proxy 走同一个账号
    const account = getSafeMediaAccount(payload.account)
    const token = account ? account.token : null
    const ctx = {
        mediaRequestId: payload.mediaRequestId || generateUUID(),
        route: payload.route || '/v1/chat/completions',
        chatType: chat_type,
        model,
        account
    }

    try {
        const reqBody = {
            "stream": upstreamStream,
            "version": "2.1",
            "incremental_output": true,
            "chat_type": chat_type,
            "chat_id": null,
            "parent_id": null,
            "model": model,
            "session_id": generateUUID(),
            "id": generateUUID(),
            "sub_chat_type": chat_type,
            "chat_mode": "normal",
            "timestamp": Math.floor(Date.now() / 1000),
            "messages": [
                {
                    "role": "user",
                    "content": "",
                    "files": [],
                    "chat_type": chat_type,
                    "feature_config": {
                        "output_schema": "phase",
                        "thinking_enabled": false
                    }
                }
            ]
        }
        const optionSource = payload.originalBody && typeof payload.originalBody === 'object'
            ? payload.originalBody
            : payload
        const latestOnly = config.imageVideoHistoryMode !== 'full_history' && IMAGE_VIDEO_CHAT_TYPES.has(chat_type)
        const currentTurn = payload.currentTurn || (latestOnly
            ? extractCurrentImageVideoTurn(payload.originalBody, payload, chat_type)
            : null)

        let userPrompt = messages?.[messages.length - 1]?.content
        if (!userPrompt && currentTurn && currentTurn.reason !== 'non-image-video-chat-type' && currentTurn.reason !== 'fallback-no-messages') {
            userPrompt = currentTurn.currentText
        }

        let resolvedChatType = chat_type
        const explicitImageCount = currentTurn?.currentImages?.length || 0
        const explicitVideoCount = currentTurn?.currentVideos?.length || 0
        let promptText = getPromptTextForValidation(userPrompt)
        if (resolvedChatType === 't2i' && promptText && explicitImageCount > 0) {
            resolvedChatType = 'image_edit'
        }
        if (resolvedChatType === 'image_edit' && !promptText && explicitImageCount > 0) {
            userPrompt = DEFAULT_IMAGE_EDIT_PROMPT
            promptText = DEFAULT_IMAGE_EDIT_PROMPT
        }
        reqBody.messages[0].chat_type = resolvedChatType
        ctx.chatType = resolvedChatType

        if (!promptText && (resolvedChatType === 't2i' || resolvedChatType === 't2v' || resolvedChatType === 'image_edit')) {
            throw createMediaLocalError(400, 'media_missing_prompt', '缺少有效的提示词', {
                stage: 'input_validation',
                reason: 'missing_prompt',
                resolvedChatType,
                lastUserContentType: currentTurn?.lastUserContentType || 'unknown',
                promptChars: 0,
                explicitImageCount,
                explicitVideoCount
            })
        }

        let appliedNormalizedOptions = {}
        if (resolvedChatType === 't2i' || resolvedChatType === 'image_edit') {
            const normalizedImage = normalizeImageRequestOptions(payload.imageOptions || pickAllowedImageVideoParams(optionSource, IMAGE_WHITELIST_KEYS))
            applyImageOptionsToReqBody(reqBody, normalizedImage)
            appliedNormalizedOptions = normalizedImage
        } else if (resolvedChatType === 't2v') {
            const normalizedVideo = normalizeVideoRequestOptions(payload.videoOptions || pickAllowedImageVideoParams(optionSource, VIDEO_WHITELIST_KEYS))
            applyVideoOptionsToReqBody(reqBody, normalizedVideo)
            appliedNormalizedOptions = normalizedVideo
        }

        // 优先用 chat_id 池加速首 token；池无则同步生成。
        // t2i/t2v/image_edit 需要匹配的 chat_type 创建 chat session
        const idResult = await getOrGenerateChatID(token, model, account, { chatType: chat_type })
        let chatID = idResult && idResult.chatId

        if (!chatID) {
            throw new Error('生成 chat_id 失败')
        }

        reqBody.chat_id = chatID
        logMediaEvent(ctx, 'chat_id', {
            chatIdSource: idResult?.fromPool ? 'pool' : 'generated'
        })

        userPrompt = userPrompt || messages?.[messages.length - 1]?.content
        if (!userPrompt && currentTurn && currentTurn.reason !== 'non-image-video-chat-type' && currentTurn.reason !== 'fallback-no-messages') {
            userPrompt = currentTurn.currentText
        }
        if (!userPrompt) {
            throw {
                status: 400,
                error: '缺少有效的提示词'
            }
        }

        const messagesHistory = Array.isArray(messages)
            ? messages.filter(item => item.role === 'user' || item.role === 'assistant')
            : []
        const selectedImageList = []

        if (resolvedChatType === 'image_edit' && (config.imageVideoHistoryMode === 'full_history' || config.imageEditReuseLastImage)) {
            for (const item of messagesHistory) {
                if (item.role === 'assistant') {
                    const matches = [...String(item.content || '').matchAll(/!\[image\]\((.*?)\)/g)]
                    for (const match of matches) {
                        selectedImageList.push(match[1])
                    }
                } else if (Array.isArray(item.content) && item.content.length > 0) {
                    for (const content of item.content) {
                        if (content.type === 'image') {
                            selectedImageList.push(content.image)
                        }
                    }
                }
            }
        }

        let reusedHistoryImage = false
        // 区分 image_edit（有 files 的 t2i）和纯 t2i（无 files 的图片生成）
        const isImageEdit = resolvedChatType === 't2i' && Array.isArray(userPrompt) && userPrompt.some(item => item.type === 'image')
        if (isImageEdit) {
            // image_edit: 保持 content 为数组格式，不拆分为 files
            reqBody.messages[0].content = userPrompt
        } else if (['t2i', 't2v'].includes(resolvedChatType)) {
            if (Array.isArray(userPrompt)) {
                const split = splitArrayContentToTextAndMedia(userPrompt)
                reqBody.messages[0].content = split.text
                if (split.unsupportedCount > 0) {
                    logger.debug('[image-video] ' + `chat_type=${resolvedChatType} history_mode=${config.imageVideoHistoryMode} prompt_length=${split.text.length} explicit_media_count=${split.media.length} selected_images=${reqBody.messages[0].files.length} unsupported_media_count=${split.unsupportedCount}`, 'CHAT')
                }
                if (resolvedChatType === 't2v' || resolvedChatType === 't2i') {
                    await appendNormalizedMediaFiles(reqBody.messages[0].files, split.media, account, ctx)
                }
            } else {
                reqBody.messages[0].content = userPrompt
            }
            if ((resolvedChatType === 't2v' || resolvedChatType === 't2i') && currentTurn) {
                const explicitMedia = collectExplicitMediaFromCurrentTurn(currentTurn)
                await appendNormalizedMediaFiles(reqBody.messages[0].files, explicitMedia.images.map(url => ({ type: 'image', url })), account, ctx)
                await appendNormalizedMediaFiles(reqBody.messages[0].files, explicitMedia.videos.map(url => ({ type: 'video', url })), account, ctx)
            }
        } else if (resolvedChatType === 'image_edit') {
            if (!Array.isArray(userPrompt)) {
                const explicitMedia = collectExplicitMediaFromCurrentTurn(currentTurn)
                await appendNormalizedMediaFiles(reqBody.messages[0].files, explicitMedia.images.map(url => ({ type: 'image', url })), account, ctx)
                if (reqBody.messages[0].files.length === 0 && config.imageEditReuseLastImage && selectedImageList.length >= 1) {
                    await appendNormalizedMediaFiles(reqBody.messages[0].files, [{ type: 'image', url: selectedImageList[selectedImageList.length - 1] }], account, ctx)
                    reusedHistoryImage = true
                }
                if (reqBody.messages[0].files.length === 0) {
                    reqBody.messages[0].chat_type = 't2i'
                }
                reqBody.messages[0].content += userPrompt
            } else {
                const texts = userPrompt.filter(item => item.type === 'text')
                if (texts.length === 0) {
                    throw {
                        status: 400,
                        error: '图片编辑请求缺少文本提示词'
                    }
                }

                for (const item of userPrompt) {
                    if (item.type === 'text') {
                        reqBody.messages[0].content += (item.text || '')
                        continue
                    }
                    const media = mapContentItemToMedia(item)
                    if (media && media.type === 'image') {
                        await appendNormalizedMediaFiles(reqBody.messages[0].files, [media], account, ctx)
                    }
                }

                if (reqBody.messages[0].files.length === 0 && config.imageEditReuseLastImage && selectedImageList.length >= 1) {
                    await appendNormalizedMediaFiles(reqBody.messages[0].files, [{ type: 'image', url: selectedImageList[selectedImageList.length - 1] }], account, ctx)
                    reusedHistoryImage = true
                }

            if (reqBody.messages[0].files.length === 0) {
                    reqBody.messages[0].chat_type = 't2i'
                }
            }
        }
        // Static regression marker for the t2i/t2v prompt branch:
        // if (chat_type === 't2i' || chat_type === 't2v') {

        const requestSummary = summarizeImageVideoRequest({
            route: '/v1/chat/completions',
            chatType: reqBody.messages[0].chat_type,
            currentTurn,
            normalized: appliedNormalizedOptions,
            reusedHistoryImage
        })
        logger.debug('[image-video] ' + `chat_type=${requestSummary.chat_type} history_mode=${requestSummary.history_mode} prompt_length=${requestSummary.prompt_length} explicit_media_count=${requestSummary.explicit_media_count} selected_images=${reqBody.messages[0].files.length} reused_history_image=${requestSummary.reused_history_image}`, 'CHAT')
        logger.debug('[image-video-params] ' + `chat_type=${requestSummary.chat_type} forwarded_param_keys=${requestSummary.forwarded_param_keys.join(',')} has_duration=${appliedNormalizedOptions.duration !== undefined} has_seed=${appliedNormalizedOptions.seed !== undefined} has_negative_prompt=${appliedNormalizedOptions.negative_prompt !== undefined}`, 'CHAT')
        logMediaEvent(ctx, 'request_prepared', {
            chat_type: requestSummary.chat_type,
            prompt_length: requestSummary.prompt_length,
            file_count: reqBody.messages[0].files.length,
            param_keys: requestSummary.forwarded_param_keys.join(',')
        })

        if (resolvedChatType === 't2i' || resolvedChatType === 't2v' || resolvedChatType === 'image_edit') {
            if (size !== undefined && size !== null) {
                reqBody.size = size
            } else if (typeof userPrompt === 'string' && userPrompt.indexOf('@4:3') !== -1) {
                reqBody.size = '4:3'
            } else if (typeof userPrompt === 'string' && userPrompt.indexOf('@3:4') !== -1) {
                reqBody.size = '3:4'
            } else if (typeof userPrompt === 'string' && userPrompt.indexOf('@16:9') !== -1) {
                reqBody.size = '16:9'
            } else if (typeof userPrompt === 'string' && userPrompt.indexOf('@9:16') !== -1) {
                reqBody.size = '9:16'
            }
        }

        // 为消息补充 Qwen Web 反代所需的字段（fid/parentId/childrenIds/user_action/timestamp/models/sub_chat_type/extra.meta），
        // 缺少其中任何一个都会导致上游安全校验失败（Bad_Request: Internal error...）
        await enrichQwenMessage(reqBody.messages[0], { model: reqBody.model })

        const requestConfig = await upstream.buildRequestConfig({
            token,
            account,
            streaming: upstreamStream,
            baseUrl: getChatBaseUrl(),
            extraHeaders: {
                ...buildQwenHeaders({ baseUrl: getChatBaseUrl(), token, account }),
                'Accept': upstreamStream ? 'text/event-stream' : 'application/json'
            },
            extraConfig: {
                responseType: upstreamStream ? 'stream' : (resolvedChatType === 't2v' ? 'json' : 'text'),
                timeout: 60 * 60 * 1000
            }
        })
        logMediaEvent(ctx, 'stream_strategy', {
            upstreamStream,
            responseType: upstreamStream ? 'stream' : (resolvedChatType === 't2v' ? 'json' : 'text')
        }, 'info')

        let responseData = null
        const maxUpstreamAttempts = 2

        // 账号轮询：每个账号有视频/图片生成额度，耗尽后切换
        const allAccounts = accountManager.accountTokens || []
        let currentAccount = account
        let currentToken = token
        const failedEmails = new Set()
        if (account && account.email) failedEmails.add(account.email)

        for (let attempt = 1; attempt <= Math.max(maxUpstreamAttempts, allAccounts.length); attempt++) {
            try {
                // 如果换账号了，需要重新生成 chat_id 和 request config（日志之前）
                if (attempt > 1 && currentToken !== token) {
                    const newIdResult = await getOrGenerateChatID(currentToken, model, currentAccount, { chatType: chat_type })
                    const newChatID = newIdResult && newIdResult.chatId
                    if (newChatID) {
                        reqBody.chat_id = newChatID
                        chatID = newChatID
                    }
                    const newConfig = await upstream.buildRequestConfig({
                        token: currentToken,
                        account: currentAccount,
                        streaming: upstreamStream,
                        baseUrl: getChatBaseUrl(),
                        extraHeaders: {
                            ...buildQwenHeaders({ baseUrl: getChatBaseUrl(), token: currentToken, account: currentAccount }),
                            'Accept': upstreamStream ? 'text/event-stream' : 'application/json'
                        },
                        extraConfig: requestConfig.extraConfig
                    })
                    requestConfig.headers = newConfig.headers
                }

                logMediaEvent(ctx, 'upstream_request', {
                    attempt,
                    upstreamStream,
                    responseType: requestConfig.responseType,
                    requestUrl: qwenWeb.endpoints.buildChatCompletionsUrl(getChatBaseUrl(), reqBody.chat_id),
                    accountEmail: currentAccount?.email,
                    chat_type: reqBody.chat_type
                }, 'info')

                responseData = await upstream.postJson(qwenWeb.endpoints.buildChatCompletionsUrl(getChatBaseUrl(), reqBody.chat_id), reqBody, requestConfig)
                logMediaEvent(ctx, 'upstream_response', {
                    upstreamStatus: responseData?.status,
                    responseDataType: typeof responseData?.data,
                    isStream: responseData?.data && typeof responseData.data.on === 'function',
                    attempt
                }, 'info')

                // 读取 SSE stream 检测业务错误（RateLimited/Internal_Server_Error 等）
                // 视频用 readVideoUpstreamResult（可提前退出，拿到 taskID 即返回）
                // 图片用 readImageUpstreamResult（需等完整流结束获取所有 URL）
                const isStreamResponse = responseData?.data && typeof responseData.data.on === 'function'
                let upstreamError = null
                if (isStreamResponse) {
                    const readResult = chat_type === 't2v'
                        ? await readVideoUpstreamResult(responseData.data)
                        : await readImageUpstreamResult(responseData.data)
                    upstreamError = readResult.upstreamError
                    // 保存读取结果，避免后续重复读取 stream
                    responseData._readResult = readResult
                } else {
                    upstreamError = parseUpstreamImageError(responseData.data)
                    // 视频非流式响应：从 JSON 中提取任务 ID
                    if (chat_type === 't2v' && !upstreamError) {
                        const videoTaskCandidates = extractVideoTaskIdentifiersFromPayload(responseData.data, { includeResponseIdsAsFallback: false })
                        if (videoTaskCandidates.length > 0) {
                            responseData._videoTaskCandidates = videoTaskCandidates
                        }
                    }
                }
                if (attempt < Math.max(maxUpstreamAttempts, allAccounts.length) && isRetryableUpstreamError(upstreamError)) {
                    logger.warn(`图片/视频请求上游返回业务错误包，准备第 ${attempt + 1} 次重试，请求ID: ${upstreamError?.request_id || '未知'}`, 'CHAT')
                    await sleep(800)
                    // 从所有可用账号中随机选择（排除已失败的），避免固定顺序导致同一批号反复被消耗
                    const availableAccounts = allAccounts.filter(a => a && a.token && !failedEmails.has(a.email))
                    const nextAccount = availableAccounts.length > 0
                        ? availableAccounts[Math.floor(Math.random() * availableAccounts.length)]
                        : null
                    if (nextAccount && nextAccount.token && nextAccount.email !== currentAccount?.email) {
                        logger.warn(`图片/视频切换账号: ${currentAccount?.email} -> ${nextAccount.email}`, 'CHAT')
                        currentAccount = nextAccount
                        currentToken = nextAccount.token
                        failedEmails.add(nextAccount.email)
                    } else {
                        logger.warn('图片/视频所有可用账号均已尝试，停止重试', 'CHAT')
                        break
                    }
                    continue
                }

                break
            } catch (error) {
                logger.error('图片/视频请求失败', 'CHAT', '', buildAxiosErrorLog(error))
                const httpStatus = error.response?.status || error.status
                const upstreamError = parseUpstreamImageError(error.response?.data)
                // 重试条件：业务级错误（RateLimited/Internal/BadRequest）、HTTP 429/5xx、或流读取超时
                const isStreamTimeout = error.message && /上游流读取超时/.test(error.message)
                const shouldRetry = isRetryableUpstreamError(upstreamError) ||
                    httpStatus === 429 ||
                    (httpStatus >= 500 && httpStatus < 600) ||
                    isStreamTimeout
                if (attempt < Math.max(maxUpstreamAttempts, allAccounts.length) && shouldRetry) {
                    const retryReason = isStreamTimeout ? '流读取超时' : '上游返回业务错误包'
                    logger.warn(`图片/视频请求${retryReason}，准备第 ${attempt + 1} 次重试`, 'CHAT')
                    await sleep(800)
                    // 从所有可用账号中随机选择（排除已失败的），避免固定顺序导致同一批号反复被消耗
                    const availableAccounts = allAccounts.filter(a => a && a.token && !failedEmails.has(a.email))
                    const nextAccount = availableAccounts.length > 0
                        ? availableAccounts[Math.floor(Math.random() * availableAccounts.length)]
                        : null
                    if (nextAccount && nextAccount.token && nextAccount.email !== currentAccount?.email) {
                        logger.warn(`图片/视频切换账号: ${currentAccount?.email} -> ${nextAccount.email}`, 'CHAT')
                        currentAccount = nextAccount
                        currentToken = nextAccount.token
                        failedEmails.add(nextAccount.email)
                    } else {
                        logger.warn('图片/视频所有可用账号均已尝试，停止重试', 'CHAT')
                        break
                    }
                    continue
                }

                throw error
            }
        }

        if (resolvedChatType === 't2i' || resolvedChatType === 'image_edit') {
            // 使用 retry loop 中缓存的读取结果，避免重复读取 stream
            let readResult
            if (responseData._readResult) {
                readResult = responseData._readResult
            } else {
                readResult = await readImageUpstreamResult(responseData.data)
            }
            const { upstreamError: finalError, contentUrls: upstreamUrls = [], responseIDs, rawPreview } = readResult
            if (finalError) {
                throw finalError
            }
            const contentUrls = await resolveImageResultContentUrlsFromReadResult(readResult, chatID, currentToken, currentAccount, ctx)
            const contentUrl = contentUrls[0]
            return {
                model,
                chatType: resolvedChatType,
                contentUrl,
                contentUrls,
                content: buildImageContentFromUrls(contentUrls),
                ctx
            }
        }

        if (resolvedChatType === 't2v') {
            // 非流式响应：从 JSON 响应中直接提取任务 ID，轮询任务状态
            if (responseData._videoTaskCandidates && responseData._videoTaskCandidates.length > 0) {
                const taskIDs = responseData._videoTaskCandidates
                logger.info(`视频非流式响应提取到任务ID: ${JSON.stringify(taskIDs)}`, 'CHAT')
                // 轮询任务状态，最多 100 次 × 6s = 10 分钟
                const maxAttempts = 100
                const delay = 6 * 1000
                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    for (const taskID of taskIDs) {
                        const status = await getVideoTaskStatus(taskID, currentToken, currentAccount)
                        if (status.state === 'success') {
                            logMediaEvent(ctx, 'video_result', { resultSource: 'task_status', pollAttempts: attempt })
                            return {
                                model,
                                chatType: resolvedChatType,
                                contentUrl: status.contentUrl,
                                content: buildVideoContent(status.contentUrl),
                                ctx
                            }
                        }
                        if (status.state === 'failed' || status.state === 'invalid') {
                            logger.warn(`视频任务 ${taskID} ${status.state}`, 'CHAT')
                        }
                    }
                    if (attempt % 10 === 0) {
                        logger.info(`视频任务轮询 #${attempt}: 等待中... taskIDs=${JSON.stringify(taskIDs)}`, 'CHAT')
                    }
                    await sleep(delay)
                }
                logMediaEvent(ctx, 'video_task_timeout', { taskIDs: taskIDs.join(',') }, 'warn')
                throw { status: 504, error: '视频生成超时，请稍后再试' }
            }

            // 流式响应：使用 readResult 读取 SSE 流
            let readResult
            if (responseData._readResult) {
                readResult = responseData._readResult
            } else {
                readResult = await readVideoUpstreamResult(responseData.data)
            }
            const contentUrl = await resolveVideoResultContentUrlFromReadResult(readResult, currentToken, chatID, currentAccount, ctx)
            return {
                model,
                chatType: resolvedChatType,
                contentUrl,
                content: buildVideoContent(contentUrl),
                ctx
            }
        }

        throw new Error('不支持的图片/视频类型')
    } catch (error) {
        if (error?.localMediaError) {
            logMediaEvent(ctx, 'error', {
                stage: error.stage || 'local',
                reason: error.reason || error.code || 'local_media_error',
                errorKind: error.code || error.status,
                resolvedChatType: error.resolvedChatType,
                lastUserContentType: error.lastUserContentType,
                promptChars: error.promptChars,
                explicitImageCount: error.explicitImageCount,
                explicitVideoCount: error.explicitVideoCount
            }, 'warn')
            throw error
        }

        logger.error('图片/视频主流程异常', 'CHAT', '', buildAxiosErrorLog(error))

        if (error?.error) {
            throw error
        }

        const upstreamError = parseUpstreamImageError(error.response?.data)
        if (upstreamError) {
            throw upstreamError
        }

        throw {
            status: 500,
            error: error?.message || 'Service error, please try again later'
        }
    }
}

/**
 * 返回响应
 * @param {*} res
 * @param {string} model
 * @param {string} content
 * @param {boolean} stream
 */
const returnResponse = (res, model, content, stream, ctx) => {
    if (!res.headersSent) {
        setResponseHeaders(res, stream, { flush: stream })
    }

    logMediaEvent(ctx, 'return_response', {
        stream: stream === true,
        content_length: String(content || '').length
    }, 'info')

    if (stream) {
        const responseID = `chatcmpl-${new Date().getTime()}`
        const streamBody = {
            "id": responseID,
            "object": "chat.completion.chunk",
            "created": new Date().getTime(),
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "delta": {
                        "role": "assistant",
                        "content": content
                    },
                    "finish_reason": null
                }
            ]
        }

        const finishBody = {
            "id": responseID,
            "object": "chat.completion.chunk",
            "created": new Date().getTime(),
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "delta": {},
                    "finish_reason": "stop"
                }
            ]
        }

        res.write(`data: ${JSON.stringify(streamBody)}\n\n`)
        res.write(`data: ${JSON.stringify(finishBody)}\n\n`)
        res.write(`data: [DONE]\n\n`)
        res.end()
    } else {
        res.json({
            "id": `chatcmpl-${new Date().getTime()}`,
            "object": "chat.completion",
            "created": new Date().getTime(),
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": content
                    },
                    "finish_reason": "stop"
                }
            ]
        })
    }
}

const getVideoTaskStatus = async (videoTaskID, token, account) => {
    try {
        const chatBaseUrl = getChatBaseUrl()
        const requestConfig = await upstream.buildRequestConfig({
            token,
            account,
            baseUrl: chatBaseUrl,
            extraConfig: {
                timeout: 15000
            }
        })

        const response_data = await axios.get(qwenWeb.endpoints.buildUrl(chatBaseUrl, qwenWeb.endpoints.PATHS.tasksStatus(videoTaskID)), requestConfig)

        const taskStatus = response_data.data?.task_status || response_data.data?.status
        if (taskStatus === "success") {
            const contentUrl = extractResourceUrlFromPayload(response_data.data)
            logger.info(`video task status success task_id=${videoTaskID} has_url=${Boolean(contentUrl)}`, 'CHAT')
            return contentUrl
                ? { state: 'success', contentUrl, rawStatus: taskStatus }
                : { state: 'pending', rawStatus: taskStatus, reason: 'success_without_url' }
        }
        if (['failed', 'fail', 'error', 'canceled', 'cancelled'].includes(String(taskStatus || '').toLowerCase())) {
            logger.warn(`视频任务 ${videoTaskID} 失败: ${taskStatus}`, 'CHAT')
            return { state: 'failed', rawStatus: taskStatus }
        }
        logger.info(`获取视频任务 ${videoTaskID} 状态: ${taskStatus || 'unknown'}`, 'CHAT')
        return { state: 'pending', rawStatus: taskStatus || 'unknown' }
    } catch (error) {
        logger.error(`查询视频任务状态失败 (${videoTaskID})`, 'CHAT', '', buildAxiosErrorLog(error))
        const httpStatus = error.response?.status
        if ([400, 401, 403, 404].includes(httpStatus)) {
            return { state: 'invalid', httpStatus }
        }
        return {
            state: 'temporary_error',
            httpStatus,
            code: error.code || 'unknown'
        }
    }
}

module.exports = {
    IMAGE_WHITELIST_KEYS,
    VIDEO_WHITELIST_KEYS,
    pickAllowedImageVideoParams,
    generateImageVideoResult,
    getSafeMediaAccount,
    logMediaEvent,
    sendUpstreamError,
    sendOpenAIErrorResponse,
    resolveRequestedModel,
    normalizeOpenAIImageVideoSize,
    buildOpenAIImageResultItem,
    collectRequestMediaItems,
    returnResponse
}
