/**
 * tls-sidecar-client.js
 *
 * Node.js 封装层：通过 TLS Sidecar (Go uTLS) 发送 HTTPS 请求。
 *
 * 工作原理：
 *   Node.js 发 HTTP 请求到 http://127.0.0.1:<port>，
 *   通过 X-Target-Url header 指定目标 URL，
 *   Go sidecar 用 Chrome 浏览器 TLS 指纹转发请求并将响应透传回来。
 *
 * 设计目标：
 *  - 对现有代码零侵入：提供与原生 https.request 兼容的接口
 *  - 自动 sidecar 健康检测：首次请求前检查 sidecar 是否存活
 *  - 失败自动 fallback：sidecar 不可用时回退到原生 https
 *  - 支持 SSE 流式响应
 *  - 支持上游代理（通过 X-Proxy-Url header）
 *
 * 使用方式：
 *   const { createTlsSidecarRequest, isTlsSidecarAvailable } = require('./tls-sidecar-client')
 *   if (isTlsSidecarAvailable()) {
 *     const res = await createTlsSidecarRequest({ url, method, headers, body, proxyUrl })
 *   }
 */

const http = require('http')
const https = require('https')
const { URL } = require('url')
const config = require('../config')
const { logger } = require('./logger')

// ──────────────── 配置 ────────────────

const SIDECAR_HOST = '127.0.0.1'
const getSidecarPort = () => config.tlsSidecarPort || 9091
const getSidecarBase = () => `http://${SIDECAR_HOST}:${getSidecarPort()}`

// 健康检查状态
let _sidecarAvailable = null
let _lastHealthCheck = 0
let _checkedPort = null
const HEALTH_CHECK_TTL = 30 * 1000 // 30 秒内不重复检查

// ──────────────── 健康检查 ────────────────

/**
 * 检查 TLS Sidecar 是否存活
 * @returns {Promise<boolean>}
 */
async function checkSidecarHealth() {
    const now = Date.now()
    const port = getSidecarPort()
    if (_sidecarAvailable !== null && _checkedPort === port && now - _lastHealthCheck < HEALTH_CHECK_TTL) {
        return _sidecarAvailable
    }

    try {
        await new Promise((resolve, reject) => {
            const req = http.request({
                hostname: SIDECAR_HOST,
                port,
                path: '/health',
                method: 'GET',
                timeout: 3000,
            }, (res) => {
                res.resume()
                resolve()
            })
            req.on('error', reject)
            req.on('timeout', () => {
                req.destroy()
                reject(new Error('timeout'))
            })
            req.end()
        })
        _sidecarAvailable = true
    } catch (_) {
        _sidecarAvailable = false
    }
    _lastHealthCheck = now
    _checkedPort = port
    return _sidecarAvailable
}

/**
 * 同步检查 sidecar 是否可用（使用缓存结果）
 * @returns {boolean}
 */
function isTlsSidecarAvailable() {
    if (!config.tlsSidecarEnabled) return false
    if (_sidecarAvailable === null) return false
    return _sidecarAvailable
}

/**
 * 强制刷新 sidecar 可用状态
 */
async function refreshSidecarStatus() {
    _sidecarAvailable = null
    _checkedPort = null
    return await checkSidecarHealth()
}

// ──────────────── 请求封装 ────────────────

/**
 * 通过 TLS Sidecar 发送 HTTPS 请求
 *
 * @param {Object} options
 * @param {string} options.url - 目标 URL（必填）
 * @param {string} [options.method='GET'] - HTTP 方法
 * @param {Object} [options.headers={}] - 请求头
 * @param {string|Buffer} [options.body] - 请求体
 * @param {string} [options.proxyUrl] - 上游代理 URL（可选）
 * @param {boolean} [options.streaming=false] - 是否流式响应（SSE）
 * @param {number} [options.timeout=120000] - 超时时间（毫秒）
 * @returns {Promise<{status: number, headers: Object, body: string, stream?: import('http').IncomingMessage}>}
 */
function createTlsSidecarRequest(options) {
    return new Promise((resolve, reject) => {
        const {
            url: targetUrl,
            method = 'GET',
            headers = {},
            body = null,
            proxyUrl = null,
            streaming = false,
            timeout = config.tlsSidecarTimeout || 120000,
        } = options

        if (!targetUrl) {
            reject(new Error('tls-sidecar: targetUrl is required'))
            return
        }

        const sidecarUrl = new URL(getSidecarBase())
        const reqOptions = {
            hostname: sidecarUrl.hostname,
            port: sidecarUrl.port,
            path: '/',
            method,
            headers: {
                ...headers,
                'X-Target-Url': targetUrl,
                'Host': sidecarUrl.host,
            },
            timeout,
        }

        if (proxyUrl) {
            reqOptions.headers['X-Proxy-Url'] = proxyUrl
        }

        if (body) {
            const bodyBuf = typeof body === 'string' ? Buffer.from(body) : body
            reqOptions.headers['Content-Length'] = bodyBuf.length
        }

        const req = http.request(reqOptions, (res) => {
            if (streaming) {
                // 流式：直接返回 IncomingMessage，让调用方自己 pipe
                resolve({
                    status: res.statusCode,
                    headers: res.headers,
                    stream: res,
                })
            } else {
                // 非流式：缓冲整段响应
                let data = ''
                res.on('data', (chunk) => { data += chunk })
                res.on('end', () => {
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: data,
                    })
                })
                res.on('error', (err) => {
                    reject(new Error(`tls-sidecar response error: ${err.message}`))
                })
            }
        })

        req.on('error', (err) => {
            // 标记 sidecar 不可用
            _sidecarAvailable = false
            _lastHealthCheck = Date.now()
            reject(new Error(`tls-sidecar request failed: ${err.message}`))
        })

        req.on('timeout', () => {
            req.destroy()
            reject(new Error('tls-sidecar request timeout'))
        })

        if (body) {
            req.write(typeof body === 'string' ? body : body)
        }
        req.end()
    })
}

// ──────────────── 启动时初始化 ────────────────

// 如果启用了 TLS Sidecar，启动时异步检查其可用性
if (config.tlsSidecarEnabled) {
    checkSidecarHealth().then((available) => {
        if (available) {
            logger.info(`[TLS-Sidecar] 可用，端口 ${getSidecarPort()}`, 'TLS_SIDECAR')
        } else {
            logger.warn(`[TLS-Sidecar] 未检测到 sidecar 进程 (端口 ${getSidecarPort()})，将回退到原生 HTTPS`, 'TLS_SIDECAR')
        }
    })
}

module.exports = {
    checkSidecarHealth,
    isTlsSidecarAvailable,
    refreshSidecarStatus,
    createTlsSidecarRequest,
    SIDECAR_HOST,
    getSidecarPort,
}
