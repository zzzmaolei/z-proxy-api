const express = require('express')
const router = express.Router()
const { apiKeyVerify } = require('../middlewares/authorization.js')
const { validateMessages } = require('../middlewares/validate-request.js')
const { handleAnthropicMessages } = require('../controllers/anthropic.js')
const { routeByProviderAnthropic } = require('../providers/registry')
const { detectClientProfile } = require('../agents/index.js')
const { logger } = require('../utils/logger.js')

/**
 * POST /v1/messages — Anthropic Messages API
 *
 * Anthropic /v1/messages 按 model 名经 registry 分发：
 *   deepseek/dpsk -> controllers/anthropic-deepseek.js
 *   其余           -> controllers/anthropic.js (Qwen)
 *
 * 响应头:
 *   x-qwen-protocol       : 'anthropic'
 *   x-qwen-client-profile : 当前生效的 profile.name
 *   x-qwen-backend        : 'chat'
 */
router.post('/v1/messages',
  apiKeyVerify,
  validateMessages,
  (req, res, next) => {
    try {
      const detected = detectClientProfile(req, 'anthropic', { body: req.body })
      req.clientProfile = detected
      res.set('x-qwen-protocol', 'anthropic')
      res.set('x-qwen-client-profile', detected.name || 'unknown')

      if (detected.source === 'header_incompatible_fallback' || detected.source === 'header_unknown_fallback') {
        logger.debug(
          `[profile] anthropic 收到不兼容/未知 profile 头: ${detected.headerValue || '?'} → 回退 ${detected.name}`,
          'PROFILE'
        )
      } else {
        logger.debug(
          `[profile] anthropic protocol=${detected.protocol} profile=${detected.name} source=${detected.source}`,
          'PROFILE'
        )
      }
    } catch (e) {
      // 永不阻塞主流程：profile 识别失败就用默认
      req.clientProfile = { name: 'claude-code', source: 'detector_error', protocol: 'anthropic' }
      res.set('x-qwen-protocol', 'anthropic')
      res.set('x-qwen-client-profile', 'claude-code')
      logger.debug(`[profile] detector exception: ${e && e.message ? e.message : e}`, 'PROFILE')
    }

    res.set('x-qwen-backend', 'chat')
    return next()
  },
  routeByProviderAnthropic,
  handleAnthropicMessages
)

module.exports = router
