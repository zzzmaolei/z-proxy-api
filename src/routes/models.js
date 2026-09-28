/** 模型列表路由 — GET /v1/models 返回所有可用模型 */

const express = require('express')
const router = express.Router()
const { apiKeyVerify } = require('../middlewares/authorization')
const { handleGetModels } = require('../controllers/models.js')

// /v1/models should not fail just because the account pool is briefly warming
// up. handleGetModels owns the readiness/error response policy.
router.get('/v1/models', apiKeyVerify, handleGetModels)
router.get('/models', handleGetModels)


module.exports = router
