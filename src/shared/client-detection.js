/** 客户端 profile 安全检测包装器 — 捕获异常返回默认 profile */

const { detectClientProfile } = require('../agents/index.js');

function detectProfileSafe(req, protocol = 'openai') {
    const defaultProfile = protocol === 'anthropic'
        ? { name: 'claude-code', source: 'detector_error', protocol }
        : { name: 'openai-compatible', source: 'detector_error', protocol };
    try {
        const detected = detectClientProfile(req, protocol, { body: req.body });
        return detected || defaultProfile;
    } catch (_) {
        return defaultProfile;
    }
}

module.exports = { detectProfileSafe };
