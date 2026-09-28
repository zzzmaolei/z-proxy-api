/**
 * 媒体内容下载与解析共享模块
 *
 * 统一 HTTP URL 下载 / 本地路径检测 / data URI 解析逻辑，
 * 消除 utils/chat-helpers.js、backends/deepseek/dpsk-client.js、
 * controllers/chat.image.video.js 三处的重复实现。
 *
 * # 设计原则
 *
 *   - 本模块只负责"获取 buffer / 检测类型"，不负责上传到 OSS
 *     （上传逻辑由调用方处理，因为 Qwen OSS 与 DeepSeek uploadFile 差异较大）
 *   - 原子函数（downloadHttpUrl / isLocalPath / readLocalFile / parseDataUri）
 *     供调用方组合使用；normalizeMediaContent 作为统一入口供简单场景使用
 *
 * # 依赖
 *
 *   - axios（HTTP 下载）
 *   - fs / path（本地文件读取）
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ===========================================================================
// 常量
// ===========================================================================

const HTTP_URL_REGEX = /^https?:\/\//i;
const DATA_URI_REGEX = /^data:(.+);base64,(.*)$/i;

// ===========================================================================
// 本地路径检测
// ===========================================================================

/**
 * 判断字符串是否为本地文件路径
 *
 * 支持：
 *   - `file://` 协议
 *   - Linux 绝对路径（`/...`，但不包含 `//`）
 *   - Windows 盘符路径（`C:\...` / `C:/...`）
 *
 * @param {string} str - 待检测字符串
 * @returns {boolean}
 */
function isLocalPath(str) {
    if (!str || typeof str !== 'string') return false;
    if (str.startsWith('file://')) return true;
    if (str.startsWith('/') && !str.startsWith('//')) return true;
    if (/^[A-Za-z]:[\\/]/.test(str)) return true;
    return false;
}

/**
 * 从 file:// URL 或路径中提取文件系统路径
 *
 * @param {string} value - 原始 URL 或路径
 * @returns {string} 文件系统路径（去除 file:// 前缀）
 */
function localPathFromUrl(value) {
    if (typeof value !== 'string') return value;
    if (!value.startsWith('file://')) return value;
    return value.slice('file://'.length);
}

// ===========================================================================
// HTTP 下载
// ===========================================================================

/**
 * 下载 HTTP(S) URL 并返回 buffer
 *
 * @param {string} url - HTTP(S) URL
 * @param {Object} [options]
 * @param {number} [options.timeout=30000] - 超时毫秒
 * @param {Object} [options.httpsAgent] - axios httpsAgent（代理）
 * @param {boolean} [options.proxy=false] - 是否启用 axios proxy（设为 false 以使用 httpsAgent）
 * @param {Object} [options.headers] - 自定义请求头（默认 { 'User-Agent': 'Mozilla/5.0' }）
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
async function downloadHttpUrl(url, options = {}) {
    const {
        timeout = 30000,
        httpsAgent,
        proxy = false,
        headers = { 'User-Agent': 'Mozilla/5.0' },
        signal = null,
    } = options;
    const downloadConfig = {
        responseType: 'arraybuffer',
        timeout,
        headers,
        signal: signal || undefined,
    };
    if (httpsAgent) {
        downloadConfig.httpsAgent = httpsAgent;
        downloadConfig.proxy = proxy;
    }
    const response = await axios.get(url, downloadConfig);
    return {
        buffer: Buffer.from(response.data),
        contentType: response.headers['content-type'] || '',
    };
}

// ===========================================================================
// 本地文件读取
// ===========================================================================

/**
 * 读取本地文件为 buffer
 *
 * 自动剥离 `file://` 前缀。调用方应先用 isLocalPath 判断。
 *
 * @param {string} filePath - 文件路径（支持 file:// 前缀）
 * @returns {Buffer} 文件内容
 */
function readLocalFile(filePath) {
    const p = localPathFromUrl(filePath);
    return fs.readFileSync(p);
}

// ===========================================================================
// data URI 解析
// ===========================================================================

/**
 * 解析 data URI 为 mimeType 和 buffer
 *
 * 匹配格式：`data:<mimeType>;base64,<base64Data>`
 *
 * @param {string} str - data URI 字符串
 * @returns {{mimeType: string, data: Buffer}|null} 解析结果，非 data URI 返回 null
 */
function parseDataUri(str) {
    if (typeof str !== 'string') return null;
    const match = str.match(DATA_URI_REGEX);
    if (!match) return null;
    return {
        mimeType: match[1],
        data: Buffer.from(match[2], 'base64'),
    };
}

// ===========================================================================
// MIME type <-> 扩展名映射
// ===========================================================================

const MIME_TO_EXT = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp',
    'video/mp4': 'mp4', 'video/avi': 'avi', 'video/quicktime': 'mov',
};

const EXT_TO_MIME = {
    'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
    'gif': 'image/gif', 'webp': 'image/webp', 'bmp': 'image/bmp',
    'mp4': 'video/mp4', 'avi': 'video/avi', 'mov': 'video/mov',
    'mp3': 'audio/mp3', 'wav': 'audio/wav', 'pdf': 'application/pdf',
    'txt': 'text/plain', 'js': 'text/javascript', 'py': 'text/x-python',
    'json': 'application/json', 'md': 'text/markdown', 'csv': 'text/csv',
    'html': 'text/html', 'css': 'text/css', 'xml': 'text/xml',
    'yaml': 'text/yaml', 'yml': 'text/yaml',
};

/**
 * 从 MIME type 推断扩展名（fallback 到 mediaType 默认值）
 */
function extFromMimeType(mimeType, mediaType = 'image') {
    return MIME_TO_EXT[mimeType] || (mediaType === 'video' ? 'mp4' : 'png');
}

/**
 * 从扩展名推断 MIME type（fallback 到 application/octet-stream）
 */
function mimeTypeFromExt(ext, mediaType = 'image') {
    const cleanExt = String(ext || '').toLowerCase().replace('.', '');
    return EXT_TO_MIME[cleanExt] || 'application/octet-stream';
}

module.exports = {
    // 常量
    HTTP_URL_REGEX,
    DATA_URI_REGEX,
    // 本地路径
    isLocalPath,
    localPathFromUrl,
    // 下载/读取/解析
    downloadHttpUrl,
    readLocalFile,
    parseDataUri,
    // 映射
    extFromMimeType,
    mimeTypeFromExt,
};
