/**
 * DeepSeek Chat 路由
 * 提供 OpenAI 兼容的 /v1/dpsk/chat/completions 和 /v1/dpsk/models 接口
 */
const express = require('express');
const router = express.Router();
const { apiKeyVerify } = require('../middlewares/authorization');
const { chatCompletions } = require('../controllers/dpsk-chat');
const { handleDpskModels } = require('../controllers/dpsk-models');

// POST /v1/dpsk/chat/completions — OpenAI 兼容
router.post('/v1/dpsk/chat/completions', apiKeyVerify, chatCompletions);

// GET /v1/dpsk/models — 模型列表
router.get('/v1/dpsk/models', apiKeyVerify, handleDpskModels);

module.exports = router;