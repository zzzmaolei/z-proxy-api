const dotenv = require('dotenv')

// Unit/integration tests must not read the developer's real .env by default.
// Live tests can opt in with ZPROXY_TEST_LOAD_ENV=true or by running outside
// the Node test runner. Production startup keeps the existing dotenv behavior.
const isNodeTestRunner = process.execArgv.some((arg) => arg === '--test' || arg.startsWith('--test='))
const isTestRuntime = process.env.NODE_ENV === 'test'
    || process.env.ZPROXY_TEST_MODE === '1'
    || !!process.env.NODE_TEST_CONTEXT
    || isNodeTestRunner
if (!isTestRuntime || String(process.env.ZPROXY_TEST_LOAD_ENV || '').toLowerCase() === 'true') {
    dotenv.config()
}

/**
 * 解析API_KEY环境变量，支持逗号分隔的多个key
 * @returns {Object} 包含apiKeys数组和adminKey的对象
 */
const parseApiKeys = () => {
    const apiKeyEnv = process.env.API_KEY
    if (!apiKeyEnv) {
        return { apiKeys: [], adminKey: null }
    }

    const keys = apiKeyEnv.split(',').map(key => key.trim()).filter(key => key.length > 0)
    return {
        apiKeys: keys,
        adminKey: keys.length > 0 ? keys[0] : null
    }
}

const { apiKeys, adminKey } = parseApiKeys()
// 用于 O(1) 查找；运行时若修改 config.apiKeys 需同步更新 apiKeySet
const apiKeySet = new Set(apiKeys)

const parseIntegerEnv = (name, defaultValue, options = {}) => {
    const raw = process.env[name]
    if (raw === undefined || raw === null || raw === '') return defaultValue
    const n = parseInt(raw, 10)
    if (Number.isNaN(n)) return defaultValue
    if (options.allowZero && n === 0) return 0
    if (n < (options.min ?? 1)) return defaultValue
    return n
}

const parseBooleanEnv = (name, defaultValue = false) => {
    const raw = process.env[name]
    if (raw === undefined || raw === null || raw === '') return defaultValue
    const normalized = String(raw).toLowerCase()
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false
    return defaultValue
}

const config = {
    dataSaveMode: process.env.DATA_SAVE_MODE || "none",
    apiKeys: apiKeys,
    apiKeySet: apiKeySet,
    adminKey: adminKey,
    batchLoginConcurrency: Math.max(1, parseInt(process.env.BATCH_LOGIN_CONCURRENCY, 10) || 5),
    simpleModelMap: process.env.SIMPLE_MODEL_MAP === 'true' ? true : false,
    listenAddress: process.env.LISTEN_ADDRESS || null,
    listenPort: process.env.SERVICE_PORT || 3000,
    searchInfoMode: process.env.SEARCH_INFO_MODE === 'table' ? "table" : "text",
    // 是否输出思考过程。
    // 默认 true：bridge 层需要看到 reasoning_content 才能正确管理 thinking block 状态机。
    // 设为 false 时 DeepSeek 的 thinking 内容被跳过，bridge 无法感知 thinking→text 切换，
    // 可能导致 Claude Code 在 thinking block 结束时收不到完整响应而显示截断。
    outThink: process.env.OUTPUT_THINK !== 'false',
    redisURL: process.env.REDIS_URL || null,
    autoRefresh: true,
    autoRefreshInterval: 6 * 60 * 60,
    cacheMode: process.env.CACHE_MODE || "default",
    logLevel: process.env.LOG_LEVEL || "INFO",
    enableFileLog: process.env.ENABLE_FILE_LOG === 'true',
    logDir: process.env.LOG_DIR || "./logs",
    maxLogFileSize: parseInt(process.env.MAX_LOG_FILE_SIZE, 10) || 10,
    maxLogFiles: parseInt(process.env.MAX_LOG_FILES, 10) || 5,
    // 自定义反代URL配置
    qwenChatProxyUrl: process.env.QWEN_CHAT_PROXY_URL || "https://chat.qwen.ai",
    // 代理配置
    proxyUrl: process.env.PROXY_URL || null,
    // chat 请求重试配置（运行时可被 web UI 覆盖，见 src/utils/data-persistence.js#loadSettings）
    chatRetryCount: parseIntegerEnv('CHAT_RETRY_COUNT', 1, { min: 0 }),
    chatRetryBackoffMs: Math.max(0, parseInt(process.env.CHAT_RETRY_BACKOFF_MS, 10) || 400),
    imageVideoHistoryMode: (() => {
        const raw = (process.env.IMAGE_VIDEO_HISTORY_MODE || 'latest_only').toLowerCase()
        return raw === 'full_history' ? 'full_history' : 'latest_only'
    })(),
    imageEditReuseLastImage: (() => {
        const raw = (process.env.IMAGE_EDIT_REUSE_LAST_IMAGE || 'false').toLowerCase()
        return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on'
    })(),
    // chat 多号池会话粘滞窗口（毫秒）
    sessionStickyMs: parseIntegerEnv('SESSION_STICKY_MS', 30 * 60 * 1000, { min: 0 }),
    // chat 长流稳定性配置
    //  - QWEN_STREAM_TIMEOUT_MS=0: 关闭 axios 总超时
    //  - QWEN_STREAM_IDLE_TIMEOUT_MS=0: 关闭上游 SSE idle abort
    //  - NONSTREAM_KEEPALIVE_INTERVAL_MS>0: 非流式响应完成前写入 JSON whitespace 保活
    qwenStreamTimeoutMs: parseIntegerEnv('QWEN_STREAM_TIMEOUT_MS', 2 * 60 * 60 * 1000, { allowZero: true, min: 1 }),
    qwenStreamIdleTimeoutMs: parseIntegerEnv('QWEN_STREAM_IDLE_TIMEOUT_MS', 2 * 60 * 60 * 1000, { allowZero: true, min: 1 }),
    // DeepSeek stream stability
    dpskStreamTimeoutMs: parseIntegerEnv('DPSK_STREAM_TIMEOUT_MS', 10 * 60 * 1000, { allowZero: true, min: 1 }),
    responsesStreamKeepAliveMs: parseIntegerEnv('RESPONSES_STREAM_KEEPALIVE_MS', 12 * 1000, { allowZero: true, min: 1 }),
    qwenStreamBootstrapRetries: parseIntegerEnv('QWEN_STREAM_BOOTSTRAP_RETRIES', 1, { allowZero: true, min: 1 }),
    qwenStreamKeepAlive: parseBooleanEnv('QWEN_STREAM_KEEP_ALIVE', true),
    nonStreamKeepaliveIntervalMs: parseIntegerEnv('NONSTREAM_KEEPALIVE_INTERVAL_MS', 0, { allowZero: true, min: 1 }),
    chatLatencyLog: parseBooleanEnv('CHAT_LATENCY_LOG', true),
    chatLatencySlowChatIdMs: parseIntegerEnv('CHAT_LATENCY_SLOW_CHAT_ID_MS', 800, { min: 1 }),
    chatLatencySlowUpstreamHeadersMs: parseIntegerEnv('CHAT_LATENCY_SLOW_UPSTREAM_HEADERS_MS', 3000, { min: 1 }),
    chatLatencySlowFirstEventMs: parseIntegerEnv('CHAT_LATENCY_SLOW_FIRST_EVENT_MS', 8000, { min: 1 }),
    chatIdPrewarm: parseBooleanEnv('CHAT_ID_PREWARM', true),
    chatIdPrewarmMode: (() => {
        const raw = (process.env.CHAT_ID_PREWARM_MODE || 'full').toLowerCase()
        return ['full', 'on_demand', 'off'].includes(raw) ? raw : 'full'
    })(),
    // Token 统计模式
    //   estimate: 轻量字符估算（默认，CPU 友好）
    //   precise : tiktoken 精准计数（一次 encoding 复用）
    //   auto    : 优先用上游 usage；没有则 0（不计算）
    tokenUsageMode: (() => {
        const raw = (process.env.TOKEN_USAGE_MODE || 'estimate').toLowerCase()
        return ['estimate', 'precise', 'auto'].includes(raw) ? raw : 'estimate'
    })(),
    // chat_id 池大小：每个 account+model 最多缓存几个预生成 chat_id
    chatIdPoolSize: Math.max(1, Math.min(6, parseInt(process.env.CHAT_ID_POOL_SIZE, 10) || 6)),
    // 模型列表 fallback 策略
    //  - MODEL_LIST_FALLBACK=true（默认）：上游 /api/models 失败时使用本地保守列表
    //  - MODEL_LIST_FALLBACK=false：上游失败直接 503/不返回
    modelListFallback: (() => {
        const raw = (process.env.MODEL_LIST_FALLBACK || 'true').toLowerCase()
        // 默认 true：上游临时不可用时仍给 OpenAI 兼容客户端一个保守模型列表。
        if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') return false
        return true
    })(),
    // 模型列表缓存 TTL（毫秒）
    //  - 默认 5 分钟；与上次成功缓存策略配合：TTL 内复用，TTL 外允许重新拉
    //  - 失败时绝不写入 cachedModels（保证空数组不会"永久缓存"）
    modelListCacheTtlMs: parseIntegerEnv('MODEL_LIST_CACHE_TTL_MS', 5 * 60 * 1000, { min: 0 }),
    // 紧急救火：账号加载 fallback（DATA_SAVE_MODE=redis 失败时使用）
    //   - none: 严格模式，不 fallback（默认）
    //   - file: Redis 失败或返回 0 账号时，从 data/qwen-data.json 加载
    //   - env : Redis 失败或返回 0 账号时，从 ACCOUNTS 环境变量加载
    accountLoadFallback: (() => {
        const raw = (process.env.ACCOUNT_LOAD_FALLBACK || 'none').toLowerCase()
        if (['none', 'file', 'env'].includes(raw)) return raw
        return 'none'
    })(),
    // GLM 路线已下线（chat.z.ai API 变更，不可用）。相关配置项已移除。
    // DeepSeek 默认 think effort（low/medium/high/max）
    // 当客户端未显式传 reasoning_effort / thinking 字段时，使用此默认值。
    // 由 Web UI 系统设置页持久化覆盖（见 src/routes/settings.js#setDpskThinkEffort）。
    //   - low   : 关闭思考（thinking_enabled=false）
    //   - medium: 开启思考
    //   - high  : 开启思考（默认，与 DeepSeek Web 客户端一致）
    //   - max   : 开启思考
    dpskThinkEffort: (() => {
        const raw = (process.env.DPSK_THINK_EFFORT || 'high').toLowerCase()
        return ['low', 'medium', 'high', 'max'].includes(raw) ? raw : 'high'
    })(),
    // Tool-result history compression is opt-in. The default preserves the
    // complete client-provided tool output; enabling it is a product choice.
    dpskEnableToolHistoryCompression: parseBooleanEnv('DPSK_ENABLE_TOOL_HISTORY_COMPRESSION', false),
    // DeepSeek Web sessions are stateful, but reusing chatSessionId/parent
    // across agent turns can make the Web model return a short or empty second
    // response. Keep requests isolated by default; opt in only after a client
    // has verified that it can preserve the Web session safely.
    // x-dpsk-session-continuity: 1 remains an explicit per-request opt-in.
    dpskEnableSessionContinuity: parseBooleanEnv('DPSK_ENABLE_SESSION_CONTINUITY', false),

    // ──────────────── TLS Sidecar 配置 ────────────────
    // TLS 指纹绕过：通过 Go uTLS sidecar 模拟 Chrome 浏览器 TLS 指纹发起 HTTPS 请求，
    // 用于绕过 Cloudflare / 反爬系统的 TLS 指纹检测。
    //
    // 工作原理：
    //   Node.js → http://127.0.0.1:<port> (X-Target-Url header) → Go uTLS sidecar → 目标服务器
    //
    // 使用前需要：
    //   1. 安装 Go 1.20+
    //   2. 运行 tls-sidecar/build.bat 编译 sidecar 二进制
    //   3. 启动 sidecar (tls-sidecar.exe) 或设置 TLS_SIDECAR_AUTO_START=true
    //
    // TLS_SIDECAR_ENABLED: 是否启用 TLS Sidecar（默认 false）
    //   - 全局开关；设为 true 后，所有走 HTTPS 的上游请求都通过 sidecar 代理
    //   - 也可设为 'dpsk' 仅对 DeepSeek 路线启用
    // TLS_SIDECAR_PORT: Go sidecar 监听端口（默认 9091）
    // TLS_SIDECAR_PROXY_URL: TLS Sidecar 自身使用的上游代理（可选）
    // TLS_SIDECAR_TIMEOUT: 请求超时毫秒数（默认 120000）
    // TLS_SIDECAR_AUTO_START: 是否在 Node.js 启动时自动启动 Go sidecar 进程（默认 false）
    tlsSidecarEnabled: (() => {
        const raw = process.env.TLS_SIDECAR_ENABLED || 'false'
        const lower = raw.toLowerCase()
        if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'on') return 'all'
        if (['dpsk', 'qwen'].includes(lower)) return lower
        return false
    })(),
    tlsSidecarPort: Math.max(1, Math.min(65535, parseInt(process.env.TLS_SIDECAR_PORT, 10) || 9091)),
    tlsSidecarProxyUrl: process.env.TLS_SIDECAR_PROXY_URL || null,
    tlsSidecarTimeout: Math.max(1000, parseInt(process.env.TLS_SIDECAR_TIMEOUT, 10) || 120000),
    tlsSidecarAutoStart: parseBooleanEnv('TLS_SIDECAR_AUTO_START', false),

    // ──────────────── 模型缓存 TTL ────────────────
    // DPSK_DEFAULT_MODEL_TTL_MS: Qwen 默认模型缓存 TTL（毫秒）
    // 与 Qwen 路线 getLatestModelsDetailed() 对齐，避免频繁请求上游
    DPSK_DEFAULT_MODEL_TTL_MS: 5 * 60 * 1000, // 5 分钟

    // ──────────────── Qwen 调度器 ────────────────
    // QWEN_SCHEDULER_BACKEND: 调度器后端（memory / redis）
    qwenSchedulerBackend: (() => {
        const raw = (process.env.QWEN_SCHEDULER_BACKEND || 'memory').toLowerCase()
        return ['memory', 'redis'].includes(raw) ? raw : 'memory'
    })(),
    // QWEN_MAX_CONCURRENCY_PER_ACCOUNT: 单账号最大并发请求数（硬信号量）
    qwenMaxConcurrencyPerAccount: parseIntegerEnv('QWEN_MAX_CONCURRENCY_PER_ACCOUNT', 1, { min: 1 }),
    // QWEN_GLOBAL_MAX_CONCURRENCY: 全局最大并发 Qwen 请求数
    qwenGlobalMaxConcurrency: parseIntegerEnv('QWEN_GLOBAL_MAX_CONCURRENCY', 20, { min: 1 }),
    // QWEN_MAX_QUEUE_SIZE: 等待队列最大深度
    qwenMaxQueueSize: parseIntegerEnv('QWEN_MAX_QUEUE_SIZE', 150, { min: 1 }),
    // QWEN_QUEUE_TIMEOUT_MS: 排队超时（毫秒）
    qwenQueueTimeoutMs: parseIntegerEnv('QWEN_QUEUE_TIMEOUT_MS', 120000, { min: 1000 }),
    // DeepSeek scheduler settings remain provider-scoped so its queue and
    // concurrency limits cannot affect Qwen.
    dpskSchedulerBackend: (() => {
        const raw = (process.env.DPSK_SCHEDULER_BACKEND || 'memory').toLowerCase()
        return ['memory', 'redis'].includes(raw) ? raw : 'memory'
    })(),
    dpskRoutingStrategy: (() => {
        const raw = (process.env.DPSK_ROUTING_STRATEGY || 'round-robin').toLowerCase()
        return ['round-robin', 'weighted', 'idle-first'].includes(raw) ? raw : 'round-robin'
    })(),
    dpskMaxConcurrencyPerAccount: parseIntegerEnv('DPSK_MAX_CONCURRENCY_PER_ACCOUNT', 1, { min: 1 }),
    dpskGlobalMaxConcurrency: parseIntegerEnv('DPSK_GLOBAL_MAX_CONCURRENCY', 50, { min: 1 }),
    dpskMaxQueueSize: parseIntegerEnv('DPSK_MAX_QUEUE_SIZE', 150, { min: 1 }),
    dpskQueueTimeoutMs: parseIntegerEnv('DPSK_QUEUE_TIMEOUT_MS', 120000, { min: 1000 }),
    // QWEN_MAX_ACCOUNT_ATTEMPTS: 单请求最多尝试不同账号数
    qwenMaxAccountAttempts: parseIntegerEnv('QWEN_MAX_ACCOUNT_ATTEMPTS', 3, { min: 1 }),
    // QWEN_MAX_TRANSPORT_RETRIES_PER_ACCOUNT: 单账号最多传输重试次数
    qwenMaxTransportRetriesPerAccount: parseIntegerEnv('QWEN_MAX_TRANSPORT_RETRIES_PER_ACCOUNT', 1, { allowZero: true, min: 1 }),

    // ──────────────── Qwen 媒体上传 ────────────────
    // QWEN_MEDIA_UPLOAD_CONCURRENCY: 单请求内媒体上传并发数
    qwenMediaUploadConcurrency: parseIntegerEnv('QWEN_MEDIA_UPLOAD_CONCURRENCY', 3, { min: 1 }),
    // QWEN_GLOBAL_UPLOAD_CONCURRENCY: 全局媒体上传并发数
    qwenGlobalUploadConcurrency: parseIntegerEnv('QWEN_GLOBAL_UPLOAD_CONCURRENCY', 12, { min: 1 }),
    // QWEN_MEDIA_DOWNLOAD_TIMEOUT_MS: 媒体下载超时（毫秒）
    qwenMediaDownloadTimeoutMs: parseIntegerEnv('QWEN_MEDIA_DOWNLOAD_TIMEOUT_MS', 30000, { min: 1000 }),
    // QWEN_MAX_MEDIA_BYTES: 单媒体文件最大字节数
    qwenMaxMediaBytes: parseIntegerEnv('QWEN_MAX_MEDIA_BYTES', 100 * 1024 * 1024, { min: 1 }),

    // ──────────────── Qwen Chat ID ────────────────
    // QWEN_CHAT_ID_SINGLEFLIGHT: 是否启用 singleflight 防惊群
    qwenChatIdSingleflight: parseBooleanEnv('QWEN_CHAT_ID_SINGLEFLIGHT', true),
    // QWEN_CHAT_ID_REFILL_CONCURRENCY: 全局 Chat ID refill 并发限制
    qwenChatIdRefillConcurrency: parseIntegerEnv('QWEN_CHAT_ID_REFILL_CONCURRENCY', 4, { min: 1 }),
    // QWEN_CHAT_ID_STARTUP_BUDGET: 启动时预生成 Chat ID 数量（0=不预热，正数=最大预热数量）
    qwenChatIdStartupBudget: parseIntegerEnv('QWEN_CHAT_ID_STARTUP_BUDGET', 25, { allowZero: true, min: 0 }),

    // ──────────────── Qwen 网络 ────────────────
    // QWEN_NETWORK_MODE: 网络模式（direct=当前公网出口）
    qwenNetworkMode: (() => {
        const raw = (process.env.QWEN_NETWORK_MODE || 'direct').toLowerCase()
        return ['direct', 'proxy'].includes(raw) ? raw : 'direct'
    })(),
    // QWEN_FINGERPRINT_MODE: 指纹模式（preserve=保持当前特征）
    qwenFingerprintMode: (() => {
        const raw = (process.env.QWEN_FINGERPRINT_MODE || 'preserve').toLowerCase()
        return ['preserve', 'stable'].includes(raw) ? raw : 'preserve'
    })(),

    // ──────────────── Qwen Client Profile ────────────────
    // QWEN_CLIENT_PROFILE_MODE: 客户端特征模式（current=保持当前 / stable-per-account=每账号固定）
    qwenClientProfileMode: (() => {
        const raw = (process.env.QWEN_CLIENT_PROFILE_MODE || 'current').toLowerCase()
        return ['current', 'stable-per-account'].includes(raw) ? raw : 'current'
    })(),
    // QWEN_CLIENT_PROFILE_EXPERIMENT: 是否启用 client profile 实验（默认关闭）
    qwenClientProfileExperiment: parseBooleanEnv('QWEN_CLIENT_PROFILE_EXPERIMENT', false),

    // ──────────────── Qwen Token 计数 ────────────────
    // QWEN_TOKEN_COUNT_MODE: token 计数模式（estimate=估算 / exact=精确）
    qwenTokenCountMode: (() => {
        const raw = (process.env.QWEN_TOKEN_COUNT_MODE || 'estimate').toLowerCase()
        return ['estimate', 'exact'].includes(raw) ? raw : 'estimate'
    })(),
    // DeepSeek 会话亲和性开关（高并发反代网页端推荐关闭，强制均匀打散至全池账号）
    dpskSessionAffinity: parseBooleanEnv('DPSK_SESSION_AFFINITY', false),
    // DeepSeek 单账号调用最小平滑呼吸间隔（毫秒）：0 为不限制；当账号池有其他就绪账号时，优先让刚调用完的账号呼吸休息，避免单号短时间内连续高密被判定为脚本
    dpskMinPacingIntervalMs: parseIntegerEnv('DPSK_MIN_PACING_INTERVAL_MS', 5000, { allowZero: true, min: 0 }),
}

// 自动加载独立的 config.json 覆盖持久化配置
try {
    const configManager = require('./config-manager')
    const persisted = configManager.readConfig()
    if (persisted && typeof persisted === 'object') {
        Object.assign(config, persisted)
        if (Array.isArray(persisted.apiKeys) && config.apiKeySet instanceof Set) {
            config.apiKeySet.clear()
            persisted.apiKeys.forEach(k => config.apiKeySet.add(k))
        }
    }
} catch (_) {}

module.exports = config
