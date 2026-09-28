/**
 * Qwen Web 消息处理专属逻辑
 *
 * 从 src/utils/chat-helpers.js 抽离，避免 utils 通用层反向依赖 Qwen 后端
 * （uploadFileToQwenOss / qwen-models-cache / models-map 等均为 Qwen 专属）。
 *
 * 外部消费者（Qwen 路线）应从此模块导入：
 *   isChatType / isThinkingEnabled / parserModel / parserMessages /
 *   normalizeMediaContentItem / buildNormalizedMediaItem / getMediaDescriptor /
 *   enrichQwenMessage / getDefaultT2tModel / isMediaContentItem
 *
 * 通用消费者（DeepSeek 路线）继续用 utils/chat-helpers.js：
 *   extractFileContentFromContentArray / hasFilesInMessages
 */
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { logger } = require('../../utils/logger')
const { sha256Encrypt, generateUUID } = require('../../utils/tools.js')
const { uploadFileToQwenOss } = require('./upload.js')
const { getProxyAgent } = require('../../utils/proxy-helper')
const config = require('../../config')
const { serializePromptMessageRecord } = require('../../utils/tool-prompt')
const { downloadHttpUrl, isLocalPath, readLocalFile, parseDataUri, extFromMimeType } = require('../../shared/media-downloader')

/**
 * 有界并行 Promise 池：同时最多运行 concurrency 个任务，保持结果顺序。
 * @param {Array} items - 输入数组
 * @param {Function} fn - 异步处理函数 (item, index) => result
 * @param {number} concurrency - 最大并发数
 * @param {AbortSignal} [signal] - 取消信号
 * @returns {Promise<Array>} 按原始顺序的结果数组
 */
async function promisePool(items, fn, concurrency, signal) {
  if (!items || items.length === 0) return []
  const results = new Array(items.length)
  let cursor = 0

  const worker = async () => {
    while (cursor < items.length) {
      if (signal && signal.aborted) throw new Error('Aborted')
      const idx = cursor++
      try {
        results[idx] = await fn(items[idx], idx)
      } catch (err) {
        results[idx] = { error: err }
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  await Promise.all(workers)
  return results
}

/**
 * 从磁盘缓存的模型列表中获取默认的 t2t 模型
 * 只在首次调用时读磁盘，之后内存缓存。
 * 磁盘缓存由 models-map.js 定期刷新（上游获取成功时写入）。
 * 无缓存时返回 null（由调用方决定 fallback 行为）。
 */
let _defaultT2tModel = null
async function getDefaultT2tModel() {
  if (_defaultT2tModel) return _defaultT2tModel
  // 1) 优先读磁盘缓存
  try {
    const cacheFile = path.resolve(config.dataDir || './data', 'qwen-models-cache.json')
    if (fs.existsSync(cacheFile)) {
      const raw = fs.readFileSync(cacheFile, 'utf-8')
      const data = JSON.parse(raw)
      if (Array.isArray(data)) {
        const t2t = data.find(m => m?.info?.meta?.chat_type?.includes('t2t'))
        if (t2t?.id) {
          _defaultT2tModel = t2t.id
          return _defaultT2tModel
        }
      }
    }
  } catch (e) {
    logger.debug(`getDefaultT2tModel disk cache failed: ${e?.message || e}`, 'PARSER')
  }
  // 2) 磁盘缓存失败 → 实时从 API 获取
  try {
    const models = await getLatestModelsArray()
    if (Array.isArray(models)) {
      const t2t = models.find(m => m?.info?.meta?.chat_type?.includes('t2t'))
      if (t2t?.id) {
        _defaultT2tModel = t2t.id
        return _defaultT2tModel
      }
    }
  } catch (e) {
    logger.debug(`getDefaultT2tModel API fetch failed: ${e?.message || e}`, 'PARSER')
  }
  return null
}

/**
 * 为消息添加 Qwen Web 反代所需的字段，避免触发 RGV587_ERROR 风控。
 * 浏览器端每条消息都包含这些字段，缺少其中任何一个都会导致上游安全校验失败。
 *
 * @param {Object} message - 已构建的消息对象（会被原地修改）
 * @param {Object} [options]
 * @param {string} [options.model] - 模型名，用于填充 models 数组
 * @returns {Object} 修改后的消息对象
 */
const enrichQwenMessage = async (message, options = {}) => {
  if (!message || typeof message !== 'object') return message
  const now = Math.floor(Date.now() / 1000)
  message.fid = message.fid || generateUUID()
  message.parentId = message.parentId || null
  message.childrenIds = message.childrenIds || []
  message.user_action = message.user_action || 'chat'
  message.files = message.files || []
  message.timestamp = message.timestamp || now
  if (!message.models) {
    let model = options.model
    if (!model) model = await getDefaultT2tModel()
    if (!model) {
      const models = await getLatestModelsArray()
      model = models[0]?.id || null
    }
    if (!model) {
      throw new Error('No available model: could not resolve default model for enrichQwenMessage')
    }
    message.models = [model]
  }
  message.sub_chat_type = message.sub_chat_type || message.chat_type || 't2t'
  // extra 字段必须包含 meta.subChatType，否则触发 RGV587_ERROR
  if (!message.extra || !message.extra.meta) {
    message.extra = { meta: { subChatType: message.sub_chat_type || 't2t' } }
  }
  return message
}
// 紧急救火：兼容 getLatestModels() 现在返回 {models, source, error} 包装
//  - parserModel 只关心模型数组，所以统一用 getLatestModelsArray()
//  - 内部错误 / fallback 已经在 models-map.js 内处理（不再静默）
const { getLatestModels: _getLatestModelsRaw, getLatestModelsArray } = require('../../models/models-map.js')
const accountManager = require('../../utils/account.js')
// splitModelSuffix / resolveQwenModel 由 model-resolver.js 唯一定义。
// 本模块不再自行定义并行解析逻辑（消除 MODEL_SUFFIXES / findMatchedModel 重复）。
// 主链调用方（chat-middleware / controllers/anthropic）通过 req.modelResolution
// 把解析结果传入 isChatType / isThinkingEnabled，避免重复 splitModelSuffix 调用。
// 仅 legacy 调用方（如 media-gen-helpers.resolveRequestedModel）走 parserModel
// 的 thin wrapper，内部委托给 resolveQwenModel。
const { splitModelSuffix, resolveQwenModel } = require('./model-resolver.js')
/**
 * 内联图片缓存（替代已删除的 src/utils/img-caches.js）
 * 基于内存 Map 的简单图片 URL 缓存，键为 SHA256 签名。
 */
class CacheManager {
    constructor(maxSize = 5000) {
        this.cacheMap = new Map()
        this.maxSize = maxSize
    }
    cacheIsExist(signature) { return this.cacheMap.has(signature) }
    addCache(signature, url, fileId = null) {
        if (this.cacheMap.has(signature)) return false
        if (this.cacheMap.size >= this.maxSize) {
            const firstKey = this.cacheMap.keys().next().value
            this.cacheMap.delete(firstKey)
        }
        this.cacheMap.set(signature, { url, fileId })
        return true
    }
    getCache(signature) {
        if (!this.cacheMap.has(signature)) return { status: 404, url: null, file_id: null }
        const entry = this.cacheMap.get(signature)
        return { status: 200, url: entry.url, file_id: entry.fileId }
    }
}

// 暴露一个数组形态的 getLatestModels()，保持老调用方（chat-helpers.parserModel）的兼容
const getLatestModels = async (force = false) => {
    // 1) 优先用包装后的接口（带 source / error）
    try {
        const r = await _getLatestModelsRaw(force)
        if (r && Array.isArray(r.models)) return r.models
    } catch (_) { /* fallthrough */ }
    // 2) 兜底：直接拿数组
    return await getLatestModelsArray(force)
}

const DATA_URI_REGEX = /^data:(.+);base64,(.*)$/i
const HTTP_URL_REGEX = /^https?:\/\//i

/**
 * 判断是否为媒体内容项
 * @param {object} item - 内容项
 * @returns {boolean} 是否为媒体内容项
 */
const isMediaContentItem = (item) => ['image', 'image_url', 'video', 'video_url', 'input_video', 'file'].includes(item?.type)

/**
 * 提取媒体信息
 * @param {object} item - 内容项
 * @returns {{ mediaType: string, url: string|null }|null} 媒体信息
 */
const getMediaDescriptor = (item) => {
    if (!item) {
        return null
    }

    if (item.type === 'image' || item.type === 'image_url') {
        return {
            mediaType: 'image',
            url: item.image || item.url || item.image_url?.url || null
        }
    }

    if (item.type === 'video' || item.type === 'video_url') {
        return {
            mediaType: 'video',
            url: item.video || item.url || item.video_url?.url || null
        }
    }

    if (item.type === 'input_video') {
        return {
            mediaType: 'video',
            url: item.input_video?.url || item.input_video?.video_url || item.video_url?.url || null
        }
    }

    if (item.type === 'file') {
        return {
            mediaType: 'file',
            url: null,
            fileData: item.file_data,
            mimeType: item.media_type
        }
    }

    return null
}

/**
 * 构造规范化媒体内容项
 * @param {string} mediaType - 媒体类型
 * @param {string} url - 媒体链接
 * @returns {object} 规范化后的内容项
 */
const buildNormalizedMediaItem = (mediaType, url, fileId = null) => {
    const item = mediaType === 'video'
        ? { type: 'video', video: url }
        : { type: 'image', image: url }
    if (fileId) {
        item.file_id = fileId
    }
    return item
}

/**
 * 解析并上传媒体内容项
 *
 * If options.uploadAccount is provided, media upload uses that account's token
 * and proxy so uploads match the final chat request account. Without it, the
 * legacy accountManager.getAccount() fallback is preserved.
 * @param {object} item - 原始内容项
 * @param {object} imgCacheManager - 图片缓存管理器
 * @param {object} [options] - 选项
 * @param {object} [options.uploadAccount] - 预选上传账号（含 token / proxy / email）
 * @returns {Promise<object|null>} 规范化后的媒体内容项
 */
const normalizeMediaContentItem = async (item, imgCacheManager, options = {}) => {
    const mediaDescriptor = getMediaDescriptor(item)
    logger.debug(`normalizeMediaContentItem: item=${JSON.stringify(item).slice(0,100)}, descriptor=${JSON.stringify(mediaDescriptor)}`, 'PARSER')
    // Handle file type: base64 decode + upload to Qwen OSS
    if (mediaDescriptor?.mediaType === 'file') {
        const { fileData, mimeType } = mediaDescriptor
        if (!fileData) {
            logger.debug('normalizeMediaContentItem: file type but no file_data, returning null', 'PARSER')
            return null
        }
        try {
            const buffer = Buffer.from(fileData, 'base64')
            const contentHash = crypto.createHash('sha256').update(buffer).digest('hex')
            if (imgCacheManager.cacheIsExist(contentHash)) {
                const cached = imgCacheManager.getCache(contentHash)
                return { type: 'file', file_url: cached.url, file_id: cached.file_id }
            }
            const mimeToExt = {
                'application/pdf': 'pdf',
                'text/plain': 'txt',
                'application/msword': 'doc',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
                'text/csv': 'csv',
                'application/json': 'json',
            }
            const ext = mimeToExt[mimeType] || 'bin'
            const filename = `upload.${ext}`
            const uploadAccount = (options && options.uploadAccount && options.uploadAccount.token)
                ? options.uploadAccount
                : accountManager.getAccount()
            const uploadResult = await uploadFileToQwenOss(buffer, filename, uploadAccount ? uploadAccount.token : null, uploadAccount)
            if (!uploadResult || uploadResult.status !== 200) {
                logger.error('文件上传 OSS 失败', 'UPLOAD')
                return null
            }
            imgCacheManager.addCache(contentHash, uploadResult.file_url, uploadResult.file_id)
            logger.debug(`文件上传 OSS 成功: ${filename}`, 'UPLOAD')
            return { type: 'file', file_url: uploadResult.file_url, file_id: uploadResult.file_id }
        } catch (err) {
            logger.error('文件上传失败', 'UPLOAD', '', err)
            return null
        }
    }

    if (!mediaDescriptor?.url) {
        logger.debug('normalizeMediaContentItem: no URL found, returning null', 'PARSER')
        return null
    }

    const { mediaType, url } = mediaDescriptor
    if (HTTP_URL_REGEX.test(url)) {
        try {
            const uploadAccountForDownload = (options && options.uploadAccount && options.uploadAccount.token)
                ? options.uploadAccount
                : accountManager.getAccount()
            const proxyAgent = getProxyAgent(uploadAccountForDownload)
            const { buffer, contentType } = await downloadHttpUrl(url, {
                timeout: 30000,
                httpsAgent: proxyAgent || undefined,
                proxy: false,
            })
            const contentHash = crypto.createHash('sha256').update(buffer).digest('hex')
            if (imgCacheManager.cacheIsExist(contentHash)) {
                const cached = imgCacheManager.getCache(contentHash)
                return buildNormalizedMediaItem(mediaType, cached.url, cached.file_id)
            }
            const resolvedContentType = contentType || (mediaType === 'video' ? 'video/mp4' : 'image/png')
            const ext = extFromMimeType(resolvedContentType, mediaType)
            const uploadResult = await uploadFileToQwenOss(
                buffer,
                `upload.${ext}`,
                uploadAccountForDownload ? uploadAccountForDownload.token : null,
                uploadAccountForDownload
            )
            if (uploadResult && uploadResult.status === 200 && uploadResult.file_url) {
                imgCacheManager.addCache(contentHash, uploadResult.file_url, uploadResult.file_id)
                logger.debug(`HTTP 图片/视频下载并上传到 Qwen OSS 成功`, 'UPLOAD')
                return buildNormalizedMediaItem(mediaType, uploadResult.file_url, uploadResult.file_id)
            }
        } catch (downloadErr) {
            logger.warn(`下载/重新上传 HTTP 媒体失败 ${url.slice(0, 100)}: ${downloadErr.message}`, 'UPLOAD')
        }
        return buildNormalizedMediaItem(mediaType, url)
    }

    // 检测是否为本地文件路径（支持 Linux /mnt/...、Windows C:\...、file:// 协议）
    if (isLocalPath(url)) {
        try {
            const filePath = url.startsWith('file://') ? url.slice(7) : url
            // Windows 路径在 WSL 中可能需要转换 /mnt/c/... 或直接可用
            if (!fs.existsSync(filePath)) {
                logger.warn(`本地文件不存在: ${filePath}`, 'UPLOAD')
                return buildNormalizedMediaItem(mediaType, url)
            }
            const buffer = readLocalFile(url)
            const contentHash = crypto.createHash('sha256').update(buffer).digest('hex')
            if (imgCacheManager.cacheIsExist(contentHash)) {
                const cached = imgCacheManager.getCache(contentHash)
                return buildNormalizedMediaItem(mediaType, cached.url, cached.file_id)
            }
            const ext = path.extname(filePath).toLowerCase().replace('.', '') || 'png'
            const mimeTypeMap = {
                'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
                'gif': 'image/gif', 'webp': 'image/webp', 'bmp': 'image/bmp',
                'mp4': 'video/mp4', 'avi': 'video/avi', 'mov': 'video/mov',
                'mp3': 'audio/mp3', 'wav': 'audio/wav', 'pdf': 'application/pdf'
            }
            const mimeType = mimeTypeMap[ext] || 'application/octet-stream'
            const filename = `upload.${ext}`

            logger.debug(`检测到本地文件路径，读取并上传: ${filePath} (${buffer.length} bytes)`, 'UPLOAD')

            const uploadAccount = (options && options.uploadAccount && options.uploadAccount.token)
                ? options.uploadAccount
                : accountManager.getAccount()
            const uploadResult = await uploadFileToQwenOss(buffer, filename, uploadAccount ? uploadAccount.token : null, uploadAccount)

            if (!uploadResult || uploadResult.status !== 200) {
                logger.error('本地文件上传 OSS 失败', 'UPLOAD')
                return null
            }

            imgCacheManager.addCache(contentHash, uploadResult.file_url, uploadResult.file_id)
            logger.debug(`本地文件上传 OSS 成功`, 'UPLOAD')
            return buildNormalizedMediaItem(mediaType, uploadResult.file_url, uploadResult.file_id)
        } catch (err) {
            logger.error('读取或上传本地文件失败', 'UPLOAD', '', err)
            return buildNormalizedMediaItem(mediaType, url)
        }
    }

    const parsedDataUri = parseDataUri(url)
    logger.debug(`normalizeMediaContentItem: DATA_URI match result: ${parsedDataUri ? 'MATCHED' : 'NO MATCH'}, regex=${DATA_URI_REGEX}`, 'PARSER')
    if (!parsedDataUri) {
        logger.debug(`normalizeMediaContentItem: not a data URI, returning as-is`, 'PARSER')
        return buildNormalizedMediaItem(mediaType, url)
    }

    const mimeType = parsedDataUri.mimeType
    const base64Content = url.match(DATA_URI_REGEX)[2]
    const fileExtension = extFromMimeType(mimeType, mediaType)
    const filename = `upload.${fileExtension}`
    const signature = sha256Encrypt(base64Content)

    try {
        if (mediaType === 'image' && imgCacheManager.cacheIsExist(signature)) {
            const cached = imgCacheManager.getCache(signature)
            return buildNormalizedMediaItem(mediaType, cached.url, cached.file_id)
        }

        const buffer = parsedDataUri.data
        // Hash-based content dedup (alongside existing signature-based cache)
        const contentHash = crypto.createHash('sha256').update(buffer).digest('hex')
        if (imgCacheManager.cacheIsExist(contentHash)) {
            const cached = imgCacheManager.getCache(contentHash)
            return buildNormalizedMediaItem(mediaType, cached.url, cached.file_id)
        }
        // Prefer the preselected account; fall back to the legacy account picker.
        const uploadAccount = (options && options.uploadAccount && options.uploadAccount.token)
            ? options.uploadAccount
            : accountManager.getAccount()
        const uploadResult = await uploadFileToQwenOss(buffer, filename, uploadAccount ? uploadAccount.token : null, uploadAccount)

        if (!uploadResult || uploadResult.status !== 200) {
            return null
        }

        if (mediaType === 'image') {
            imgCacheManager.addCache(signature, uploadResult.file_url, uploadResult.file_id)
        }
        imgCacheManager.addCache(contentHash, uploadResult.file_url, uploadResult.file_id)

        const normalized = buildNormalizedMediaItem(mediaType, uploadResult.file_url, uploadResult.file_id)
        return normalized
    } catch (error) {
        logger.error(`${mediaType === 'video' ? '视频' : '图片'}上传失败`, 'UPLOAD', '', error)
        return null
    }
}

/**
 * 判断聊天类型
 *
 * 优先从 modelResolution 读取 suffix（避免在主链中重复调用 splitModelSuffix）。
 * 当 modelResolution 缺失时（legacy callers），回退到 splitModelSuffix(model)。
 *
 * @param {string} model - 模型名称
 * @param {string} [explicitChatType] - 显式聊天类型
 * @param {object} [modelResolution] - resolveQwenModel() 的解析结果（主链调用方应传入）
 * @returns {string} 聊天类型 ('search' | 't2t' | 't2i' | 't2v' | 'image_edit' | 'deep_research')
 */
const EXPLICIT_CHAT_TYPES = new Set(['t2t', 'search', 't2i', 't2v', 'image_edit', 'deep_research'])

const normalizeExplicitChatType = (chatType) => {
    if (typeof chatType !== 'string') return null
    const normalized = chatType.trim().toLowerCase()
    return EXPLICIT_CHAT_TYPES.has(normalized) ? normalized : null
}

const isChatType = (model, explicitChatType, modelResolution) => {
    const requestedChatType = normalizeExplicitChatType(explicitChatType)
    if (requestedChatType) return requestedChatType

    if (!model) return 't2t'
    // 主链已通过 resolveQwenModel 解析出 suffix，直接复用避免并行 splitModelSuffix 调用。
    // 仅 legacy 调用方（无 modelResolution）走 splitModelSuffix 回退路径。
    const suffix = (modelResolution && typeof modelResolution.suffix === 'string')
        ? modelResolution.suffix
        : splitModelSuffix(model).suffix
    if (suffix === '-search' || suffix === '-thinking-search') {
        return 'search'
    } else if (suffix === '-image-edit') {
        return 'image_edit'
    } else if (suffix === '-image') {
        return 't2i'
    } else if (suffix === '-video') {
        return 't2v'
    } else if (suffix === '-deep-research') {
        return 'deep_research'
    } else {
        return 't2t'
    }
}

/**
 * 判断是否启用思考模式
 *
 * 优先使用 modelResolution 的解析结果（避免并行 model.includes('-thinking') 检测）。
 * 当 modelResolution 缺失时（legacy callers），回退到原逻辑。
 *
 * budget 处理：
 *   - modelResolution 可用时，使用其 effectiveThinkingBudget（已应用"0/null→默认，
 *     正数→尊重用户"的修复）
 *   - 否则回退到 thinking_budget 参数（保留旧 < 38912 约束，向后兼容）
 *
 * @param {string} model - 模型名称
 * @param {boolean} enable_thinking - 是否启用思考
 * @param {number} thinking_budget - 思考预算
 * @param {object} [modelResolution] - resolveQwenModel() 的解析结果（主链调用方应传入）
 * @returns {object} 思考配置对象
 */
const isThinkingEnabled = (model, enable_thinking, thinking_budget, modelResolution) => {
    const thinking_config = {
        "output_schema": "phase",
        "thinking_enabled": false,
        // 对齐浏览器默认：普通对话自动开启联网搜索（抓包 feature_config 含 auto_search:true）
        "auto_search": true,
    }

    // 主链已通过 resolveQwenModel 解析出 effectiveThinkingEnabled，直接复用。
    // 仅 legacy 调用方（无 modelResolution）走 model.includes / enable_thinking 回退路径。
    const isThinking = modelResolution
        ? !!modelResolution.effectiveThinkingEnabled
        : !!(model && (model.includes('-thinking') || enable_thinking))

    if (isThinking) {
        thinking_config.thinking_enabled = true
        thinking_config.thinking_budget = 81920
        thinking_config.research_mode = "normal"
        thinking_config.auto_thinking = false
        thinking_config.thinking_mode = "Thinking"
        thinking_config.thinking_format = "summary"
    }

    // 用户显式 budget：优先使用 modelResolution 的 effectiveThinkingBudget
    // （已应用修复：0/null→默认，正数→尊重用户），不再施加 < 38912 的旧约束。
    // 仅 legacy 调用方走 thinking_budget 参数的旧约束路径。
    if (isThinking) {
        const budgetFromResolution = modelResolution && modelResolution.effectiveThinkingBudget
        if (typeof budgetFromResolution === 'number' && budgetFromResolution > 0) {
            thinking_config.thinking_budget = budgetFromResolution
        } else if (thinking_budget && !Number.isNaN(Number(thinking_budget)) && Number(thinking_budget) > 0 && Number(thinking_budget) < 38912) {
            thinking_config.thinking_budget = Number(thinking_budget)
        }
    }

    return thinking_config
}

/**
 * 解析模型名称,移除特殊后缀
 *
 * Thin wrapper over resolveQwenModel() —— 主链已统一通过 req.modelResolution 获取完整
 * 解析结果，此函数仅保留给 legacy 调用方（如 media-gen-helpers.resolveRequestedModel）
 * 以字符串形式获取上游模型 ID。彻底消除并行 splitModelSuffix / findMatchedModel 路径。
 *
 * @param {string} model - 原始模型名称
 * @returns {Promise<string>} 上游真实模型 ID（不带 -thinking 等后缀）
 */
const parserModel = async (model) => {
    if (!model) {
        const t2t = await getDefaultT2tModel()
        if (t2t) return t2t
        const models = await getLatestModelsArray()
        const first = models[0]?.id
        if (first) return first
        throw new Error('No available model: could not resolve default model')
    }
    // 委托给 resolveQwenModel —— 内部已封装 splitModelSuffix + findMatchedModel +
    // 上游模型查找逻辑，并保证绝不发送虚构后缀模型 ID 给上游。
    const resolution = await resolveQwenModel(model)
    return resolution.upstreamModel
}

/**
 * 解析消息格式,处理图片上传和消息结构
 *
 * Multi-message conversations may contain user images before the last turn
 * (for example Anthropic tool_result images). Those media items are uploaded
 * and merged into the final Qwen-visible user content instead of being dropped.
 *
 * options.uploadAccount keeps media upload and the final chat request on the
 * same Qwen account whenever the controller has already selected one.
 *
 * options.lease (when present) takes precedence over options.uploadAccount:
 * the lease carries the account selected by the scheduler for the whole
 * request lifecycle, so media upload must reuse lease.account instead of
 * picking another one. Media upload stage never re-selects an account.
 * @param {Array} messages - 原始消息数组
 * @param {object} thinking_config - 思考配置
 * @param {string} chat_type - 聊天类型
 * @param {object} [options] - 选项
 * @param {object} [options.uploadAccount] - 预选上传账号
 * @param {object} [options.lease] - 调度器签发的 lease（含 account / accountRuntime）
 * @param {string} [options.model] - 模型名称
 * @param {boolean} [options.canonicalEnvelope] - 是否使用规范消息信封
 * @param {AbortSignal} [options.signal] - 取消信号，用于在客户端断开时取消上传
 * @returns {Promise<Array>} 解析后的消息数组
 */
const parserMessages = async (messages, thinking_config, chat_type, options = {}) => {
    // Pre-compute resolveModel before try block so it's available in catch too
    let resolveModel = options && options.model || null
    if (!resolveModel) {
        resolveModel = await getDefaultT2tModel()
    }
    if (!resolveModel) {
        const models = await getLatestModelsArray()
        resolveModel = models[0]?.id || null
    }
    if (!resolveModel) {
        throw new Error('No available model: could not resolve default model')
    }

    try {
        logger.debug(`parserMessages called: ${messages.length} messages, first msg content type: ${typeof messages[0]?.content}, isArray: ${Array.isArray(messages[0]?.content)}`, 'PARSER')
        if (Array.isArray(messages[0]?.content)) {
            logger.debug(`First message content items: ${messages[0].content.map(i => i.type).join(', ')}`, 'PARSER')
        }
        const feature_config = thinking_config
        const imgCacheManager = new CacheManager()
        // lease.account 优先：调度器已经为整个请求选好账号，媒体上传直接复用，
        // 不再重新选号。lease 缺失时回退到 uploadAccount（向后兼容）。
        const leaseAccount = (options && options.lease && options.lease.account && options.lease.account.token)
            ? options.lease.account
            : null
        const uploadAccount = leaseAccount || (options && options.uploadAccount && options.uploadAccount.token
            ? options.uploadAccount
            : null)
        const canonicalEnvelope = !!options.canonicalEnvelope

        // 如果只有一条消息,使用原有逻辑处理（不标注角色）
        if (messages.length <= 1) {
            // 降级为 DEBUG：日常请求每次都打会刷屏；debug 模式可见
            logger.debug('单条消息，使用原格式处理', 'PARSER')
            const result = await processOriginalLogic(messages, thinking_config, chat_type, imgCacheManager, { uploadAccount, model: resolveModel, signal: options.signal })
            return result
        }

        // 多条消息的情况: 收集所有媒体项后并行上传
        logger.debug('多条消息，格式化处理并标注角色', 'PARSER')
        const allMediaItems = []
        const allMediaFiles = []
        const formattedParts = []
        let lastMessageText = ''
        let lastMessageRole = 'user'
        const lastMessageIndex = messages.length - 1

        // 收集所有媒体上传任务
        const mediaUploadTasks = []

        for (let i = 0; i < messages.length; i++) {
            const msg = messages[i]
            if (!msg || typeof msg !== 'object') continue

            let text = ''
            if (typeof msg.content === 'string') {
                text = msg.content
            } else if (Array.isArray(msg.content)) {
                for (const item of msg.content) {
                    if (item && item.type === 'text' && typeof item.text === 'string') {
                        text += item.text
                    } else if (isMediaContentItem(item)) {
                        mediaUploadTasks.push(item)
                    }
                }
            }

            // Format history text (all except last message)
            if (i < lastMessageIndex && text && (canonicalEnvelope || text.trim())) {
                formattedParts.push(canonicalEnvelope
                    ? serializePromptMessageRecord({ index: i, role: msg.role, content: text })
                    : `${msg.role}:${text.trim()}`)
            }

            // Last message text
            if (i === lastMessageIndex) {
                lastMessageText = text
                lastMessageRole = msg.role
            }
        }

        // 并行上传所有媒体项
        if (mediaUploadTasks.length > 0) {
            const signal = options.signal || null
            const uploadResults = await promisePool(
                mediaUploadTasks,
                (item) => normalizeMediaContentItem(item, imgCacheManager, { uploadAccount }),
                config.qwenMediaUploadConcurrency || 3,
                signal
            )
            for (const result of uploadResults) {
                if (result && !result.error) {
                    allMediaItems.push(result)
                    const mediaUrl = result.image || result.video || result.file_url || null
                    if (mediaUrl) {
                        const fileEntry = { type: result.type, url: mediaUrl }
                        if (result.file_id) {
                            fileEntry.file_id = result.file_id
                        }
                        allMediaFiles.push(fileEntry)
                    }
                }
            }
        }

        const historyText = formattedParts.join(canonicalEnvelope ? '\n' : '\n---\n')
        const finalContent = allMediaItems

        // 组合最终内容:历史文本 + 当前消息（带角色标注）
        let combinedText = ''
        if (historyText) {
            combinedText = (canonicalEnvelope ? 'ZPROXY_MESSAGE_ENVELOPE_V1\n' : '') + historyText + (canonicalEnvelope ? '\n' : '\n---\n')
        }
        // 添加最后一条消息，带角色标注
        if (lastMessageText.trim()) {
            combinedText += canonicalEnvelope
                ? serializePromptMessageRecord({ index: lastMessageIndex, role: lastMessageRole, content: lastMessageText })
                : `${lastMessageRole}:${lastMessageText}`
        }

        // 如果有图片，使用纯文本 content + files 数组格式（Qwen vision API 格式）
        if (allMediaFiles.length > 0) {
            const msgEnvelope = {
                "role": "user",
                "content": combinedText || '请描述这张图片',
                "files": allMediaFiles,
                "chat_type": chat_type,
                "extra": {},
                "feature_config": feature_config
            }

            return [
                await enrichQwenMessage(msgEnvelope, { model: resolveModel })
            ]
        } else if (finalContent.length > 0) {
            // 修复：content 数组元素不应该包含 chat_type 和 feature_config
            // 这些字段应该只在消息级别，不在 content 元素级别
            finalContent.unshift({
                type: 'text',
                text: combinedText
            })

            const msgEnvelope = {
                "role": "user",
                "content": finalContent,
                "chat_type": chat_type,
                "extra": {},
                "feature_config": feature_config
            }

            return [
                await enrichQwenMessage(msgEnvelope, { model: resolveModel })
            ]
        } else {
            // 纯文本情况
            return [
                await enrichQwenMessage({
                    "role": "user",
                    "content": combinedText,
                    "chat_type": chat_type,
                    "extra": {},
                    "feature_config": feature_config
                }, { model: resolveModel })
            ]
        }

    } catch (e) {
        logger.error('消息解析失败', 'PARSER', '', e)
        return [
            await enrichQwenMessage({
                "role": "user",
                "content": "直接返回字符串: '聊天历史处理有误...'",
                "chat_type": "t2t",
                "extra": {},
                "feature_config": {
                    "output_schema": "phase",
                    "enabled": false,
                }
            }, { model: resolveModel })
        ]
    }
}

/**
 * 原有的单条消息处理逻辑
 * @param {Array} messages - 消息数组
 * @param {object} thinking_config - 思考配置
 * @param {string} chat_type - 聊天类型
 * @param {object} imgCacheManager - 图片缓存管理器
 * @param {object} [options] - 选项
 * @param {object} [options.uploadAccount] - 预选上传账号
 * @param {string} [options.model] - 模型名称
 * @param {AbortSignal} [options.signal] - 取消信号
 * @returns {Promise<Array>} 处理后的消息数组
 */
const processOriginalLogic = async (messages, thinking_config, chat_type, imgCacheManager, options = {}) => {
    const feature_config = thinking_config
    const uploadAccount = (options && options.uploadAccount && options.uploadAccount.token)
        ? options.uploadAccount
        : null
    let resolveModel = options && options.model || null
    if (!resolveModel) {
        resolveModel = await getDefaultT2tModel()
    }
    if (!resolveModel) {
        const models = await getLatestModelsArray()
        resolveModel = models[0]?.id || null
    }
    if (!resolveModel) {
        throw new Error('No available model: could not resolve default model')
    }

    for (let message of messages) {
        if (message.role === 'user' || message.role === 'assistant') {
            message.chat_type = "t2t"
            message.extra = {}
            message.feature_config = {
                "output_schema": "phase",
                "thinking_enabled": feature_config?.thinking_enabled ?? false,
            }

            if (!Array.isArray(message.content)) {
                logger.debug(`[VISION-DEBUG-PARSER] content is not array, skipping. role=${message.role}, contentType=${typeof message.content}`, 'PARSER')
                continue
            }

            logger.debug(`[VISION-DEBUG-PARSER] processing array content with ${message.content.length} items`, 'PARSER')
            let textContent = ''
            const mediaFiles = []
            let hasMedia = false

            // 收集媒体上传任务
            const mediaUploadTasks = []
            for (let item of message.content) {
                const isMedia = isMediaContentItem(item)
                logger.debug(`[VISION-DEBUG-PARSER] item type=${item?.type}, isMedia=${isMedia}`, 'PARSER')
                if (isMedia) {
                    hasMedia = true
                    mediaUploadTasks.push(item)
                } else if (item.type === 'text') {
                    textContent += (item.text || '')
                }
            }

            // 并行上传所有媒体项
            if (mediaUploadTasks.length > 0) {
                logger.debug(`[VISION-DEBUG-PARSER] uploading ${mediaUploadTasks.length} media items in parallel`, 'PARSER')
                const signal = options.signal || null
                const uploadResults = await promisePool(
                    mediaUploadTasks,
                    (item) => normalizeMediaContentItem(item, imgCacheManager, { uploadAccount }),
                    config.qwenMediaUploadConcurrency || 3,
                    signal
                )
                for (const result of uploadResults) {
                    logger.debug(`[VISION-DEBUG-PARSER] normalizeMediaContentItem returned: ${result && !result.error ? 'success' : 'null'}`, 'PARSER')
                    if (result && !result.error) {
                        const mediaUrl = result.image || result.video || result.file_url || null
                        const mediaType = result.type === 'video' ? 'video' : (result.type === 'file' ? 'file' : 'image')
                        logger.debug(`[VISION-DEBUG-PARSER] mediaUrl length: ${mediaUrl ? mediaUrl.length : 0}`, 'PARSER')
                        if (mediaUrl) {
                            mediaFiles.push({ type: mediaType, url: mediaUrl })
                        }
                    } else {
                        textContent += '[Image upload failed — the image referenced in this message could not be uploaded and is not visible.]\n'
                    }
                }
            }

            logger.debug(`[VISION-DEBUG-PARSER] hasMedia=${hasMedia}, mediaFiles count=${mediaFiles.length}, textContent length=${textContent.length}`, 'PARSER')
            if (hasMedia) {
                message.content = textContent || '请描述这张图片'
                message.files = mediaFiles
                logger.debug(`[VISION-DEBUG-PARSER] set content as string, files count=${message.files.length}`, 'PARSER')
            } else {
                message.content = textContent ? [{ type: 'text', text: textContent }] : []
                logger.debug(`[VISION-DEBUG-PARSER] set content as array with ${message.content.length} items`, 'PARSER')
            }
        } else {
            if (Array.isArray(message.content)) {
                let system_prompt = ''
                for (const item of message.content) {
                    if (item.type === 'text') {
                        system_prompt += item.text
                    }
                }
                if (system_prompt) {
                    message.content = system_prompt
                }
            }
        }
    }

    messages[messages.length - 1].feature_config = feature_config
    messages[messages.length - 1].chat_type = chat_type

    // 只为最后一条消息补充 Qwen Web 反代所需的字段（只有最后一条消息会被发送到 Qwen）
    if (messages.length > 0) {
        await enrichQwenMessage(messages[messages.length - 1], { model: resolveModel })
    }

    return messages
}

module.exports = {
    isChatType,
    isThinkingEnabled,
    parserModel,
    parserMessages,
    normalizeMediaContentItem,
    buildNormalizedMediaItem,
    getMediaDescriptor,
    isMediaContentItem,
    enrichQwenMessage,
    getDefaultT2tModel,
}
