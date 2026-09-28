/**
 * DeepSeek PoW (Proof of Work) 求解器 — 纯 Node.js WASM 方案
 * 使用 chat.deepseek.com 的 sha3_wasm_bg.wasm 模块中的 wasm_solve 函数
 *
 * 参考: Fly143/deepseek-free-api (pow_solver.js)
 *
 * PoW 算法:
 *   1. prefix = salt_expire_at_
 *   2. wasm_solve(retptr, challenge, prefix, difficulty) → answer
 *   3. 构建 base64 JSON 作为 x-ds-pow-response header
 */
const fs = require('fs');
const path = require('path');
const { logger } = require('../../utils/logger');

const WASM_FILENAME = 'dpsk-sha3.wasm';

let wasmInstance = null;
let wasmExports = null;
// wasm-bindgen free 函数（释放 writeString 分配的内存，避免 wasm 线性内存持续 grow）
// 不同 wasm-bindgen 版本导出名不同（__wbindgen_free 或 __wbindgen_export_2），loadWasm 时探测
let wasmFreeFn = null;
// Promise 单例：保证并发首次调用共享同一份编译/实例化结果
// 之前只缓存 wasmInstance（结果），两个并发请求会各自 await compile+instantiate，
// 第二次的 exports 会覆盖第一次的，导致 writeString 与 wasm_solve 看到不同 memory，
// 求解失败/读到垃圾数据。
let wasmReady = null;

/**
 * 加载 WASM 模块（promise 单例）
 */
function loadWasm() {
    if (wasmReady) return wasmReady;

    wasmReady = (async () => {
        const wasmPath = path.join(__dirname, '..', '..', '..', WASM_FILENAME);
        if (!fs.existsSync(wasmPath)) {
            throw new Error(`WASM 文件不存在: ${wasmPath}`);
        }

        try {
            const wasmBuffer = fs.readFileSync(wasmPath);
            const wasmModule = await WebAssembly.compile(wasmBuffer);
            wasmInstance = await WebAssembly.instantiate(wasmModule, {});
            wasmExports = wasmInstance.exports;
            // 探测 free 函数；缺失则跳过释放（仅影响 wasm 线性内存增长，不致 crash）
            wasmFreeFn = wasmExports.__wbindgen_free || wasmExports.__wbindgen_export_2 || null;
            if (!wasmFreeFn) {
                logger.warn('[DPSK-PoW] 未找到 wasm free 函数（__wbindgen_free/__wbindgen_export_2），PoW 内存将逐次泄漏', 'DPSK_POW');
            }
            logger.info('[DPSK-PoW] WASM 模块加载成功', 'DPSK_POW');
            return wasmInstance;
        } catch (err) {
            throw err;
        }
    })().catch(err => {
        // 加载失败后才重置 wasmReady，允许下次重试；
        // 加载期间并发请求共享同一 promise，不会触发多次加载
        wasmReady = null;
        throw err;
    });

    return wasmReady;
}

// PoW 答案缓存：challenge 字符串 → { answer, expireAt }
// 同一 challenge 在 expire_at 前可复用，避免重复 WASM 求解（TTL 通常 5-10 分钟）
const powAnswerCache = new Map();

/**
 * 解析 challenge.expire_at 为毫秒时间戳
 * expire_at 可能是秒（10位）或毫秒（13位）级 Unix 时间戳
 * @param {object} challenge
 * @returns {number} 毫秒时间戳
 */
const parseExpireAt = (challenge) => {
    const expire = challenge && typeof challenge.expire_at !== 'undefined' ? challenge.expire_at : 0
    if (!expire) return Date.now() + 5 * 60 * 1000 // 兜底 5 分钟
    // 10 位数字 = 秒级 Unix 时间戳；13 位 = 毫秒级
    return expire > 1e12 ? expire : expire * 1000
}

/**
 * 惰性清理过期缓存条目（在 cache miss 时触发，避免 Map 无限增长）
 */
const _cleanupExpiredCache = () => {
    if (powAnswerCache.size < 50) return
    const now = Date.now()
    for (const [k, v] of powAnswerCache) {
        if (now >= v.expireAt) powAnswerCache.delete(k)
    }
}

/**
 * 求解 PoW 挑战
 * @param {object} challenge - PoW 挑战数据 (包含 challenge, salt, difficulty, expire_at, signature, target_path, algorithm)
 * @returns {string} base64 编码的 PoW 响应 (用于 x-ds-pow-response header)
 */
function createAbortError() {
    const error = new Error('The operation was aborted')
    error.name = 'AbortError'
    error.code = 'ABORT_ERR'
    return error
}

async function solvePow(challenge, signal = null) {
    if (signal?.aborted) throw createAbortError()

    // 查缓存：同一 challenge 在 expire_at 前可复用答案，跳过 WASM 求解
    const cacheKey = challenge && typeof challenge.challenge === 'string' ? challenge.challenge : null
    if (cacheKey) {
        const cached = powAnswerCache.get(cacheKey)
        if (cached && Date.now() < cached.expireAt) {
            logger.debug('[DPSK-PoW] cache hit', 'DPSK_POW')
            return cached.answer
        }
        _cleanupExpiredCache()
    }

    await loadWasm();
    if (signal?.aborted) throw createAbortError()

    // 前置校验：challenge 核心字段缺失时给出明确错误，避免 writeString(undefined) 抛
    // 难以调试的 TypeError，或 malloc 返回 0 时写穿 wasm 模块自身内存。
    // （algorithm 不强制：上游历史上一律返回该字段，但保留 'DeepSeekHashV1' 兜底以防万一；
    //  若未来上游升级算法且不带 algorithm，应在联调时改强校验，而非现在贸然中断主流程。）
    if (!challenge ||
        typeof challenge.challenge !== 'string' ||
        typeof challenge.salt !== 'string' ||
        typeof challenge.expire_at === 'undefined' ||
        typeof challenge.difficulty !== 'number' ||
        typeof challenge.signature !== 'string') {
        throw new Error('PoW challenge 字段缺失或格式错误: ' + JSON.stringify(challenge));
    }

    const { memory, wasm_solve, __wbindgen_add_to_stack_pointer, __wbindgen_export_0 } = wasmExports;
    const malloc = __wbindgen_export_0;

    // 写入字符串到 WASM 内存
    function writeString(str) {
        const encoded = Buffer.from(str, 'utf-8');
        const ptr = malloc(encoded.length, 1);
        if (!ptr) {
            throw new Error('wasm malloc 失败（返回 0），无法写入 PoW 输入');
        }
        new Uint8Array(memory.buffer, ptr, encoded.length).set(encoded);
        return { ptr, length: encoded.length };
    }

    const prefix = `${challenge.salt}_${challenge.expire_at}_`;
    const retptr = __wbindgen_add_to_stack_pointer(-16);

    let answer = null;
    let chInfo = null;
    let pfxInfo = null;
    try {
        chInfo = writeString(challenge.challenge);
        pfxInfo = writeString(prefix);

        wasm_solve(retptr, chInfo.ptr, chInfo.length, pfxInfo.ptr, pfxInfo.length, challenge.difficulty);
        if (signal?.aborted) throw createAbortError()

        const intView = new Int32Array(memory.buffer);
        const status = intView[retptr / 4];

        if (status !== 0) {
            const floatView = new Float64Array(memory.buffer);
            answer = Math.floor(floatView[(retptr + 8) / 8]);
        }
    } finally {
        __wbindgen_add_to_stack_pointer(16);
        // 释放 wasm 内存，避免每次 solvePow 泄漏两段字节导致线性内存持续 grow
        if (wasmFreeFn) {
            try {
                if (chInfo) wasmFreeFn(chInfo.ptr, chInfo.length, 1);
                if (pfxInfo) wasmFreeFn(pfxInfo.ptr, pfxInfo.length, 1);
            } catch (_) { /* free 失败不影响主流程 */ }
        }
    }

    if (answer === null) {
        throw new Error('PoW 求解失败 — wasm_solve 返回 0');
    }

    const result = {
        algorithm: challenge.algorithm || 'DeepSeekHashV1',
        challenge: challenge.challenge,
        salt: challenge.salt,
        answer: answer,
        signature: challenge.signature,
        target_path: challenge.target_path || '/api/v0/chat/completion',
    };

    const powResponse = Buffer.from(JSON.stringify(result)).toString('base64');

    // 写缓存：在 expire_at 前可复用，避免同 challenge 重复 WASM 求解
    if (cacheKey) {
        powAnswerCache.set(cacheKey, {
            answer: powResponse,
            expireAt: parseExpireAt(challenge)
        })
        logger.debug('[DPSK-PoW] cache miss (solved and cached)', 'DPSK_POW')
    }

    return powResponse;
}

module.exports = {
    loadWasm,
    solvePow,
};
