/**
 * DeepSeek 账号管理路由
 * 挂载在 /api/dpsk 下
 */
const express = require('express');
const router = express.Router();
const { adminKeyVerify } = require('../middlewares/authorization');
const dpskAccount = require('../backends/deepseek/dpsk-account');
const { logger } = require('../utils/logger');

/**
 * GET /api/dpsk/accounts
 * 获取所有 DeepSeek 账号
 */
router.get('/dpsk/accounts', adminKeyVerify, async (req, res) => {
    try {
        const accounts = dpskAccount.getAllAccounts(true); // 返回密码
        res.json({ data: accounts });
    } catch (error) {
        logger.error('获取 DeepSeek 账号列表失败', 'DPSK_ACCOUNT', '', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/dpsk/accounts
 * 添加 DeepSeek 账号
 * 参考 Qwen 路线的 /api/setAccount：自动登录获取 token
 */
router.post('/dpsk/accounts', adminKeyVerify, async (req, res) => {
    try {
        const { email, password, token, proxy } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: '邮箱和密码不能为空' });
        }

        let finalToken = token || null;

        // 如果未提供 token，自动登录获取
        if (!finalToken) {
            try {
                const dpskClient = require('../backends/deepseek/dpsk-client');
                const loginResult = await dpskClient.login(email, password);
                finalToken = loginResult.token;
            } catch (loginErr) {
                logger.error(`DeepSeek 账号 ${email} 自动登录失败`, 'DPSK_ACCOUNT', '', loginErr);
                return res.status(400).json({ error: `自动登录失败: ${loginErr.message}` });
            }
        }

        const account = dpskAccount.addAccount(email, password, finalToken, proxy || null);
        res.json({ message: '账号添加成功', account });
    } catch (error) {
        logger.error('添加 DeepSeek 账号失败', 'DPSK_ACCOUNT', '', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/dpsk/accounts/toggle
 * 启用/停用指定账号
 */
router.post('/dpsk/accounts/toggle', adminKeyVerify, async (req, res) => {
    try {
        const { email, enabled } = req.body;
        if (!email) {
            return res.status(400).json({ error: '邮箱不能为空' });
        }

        const acc = dpskAccount.getAccountByEmail(email);
        if (!acc) {
            return res.status(404).json({ error: '账号不存在' });
        }

        const targetEnabled = typeof enabled === 'boolean' ? enabled : !(acc.enabled !== false);
        const updated = dpskAccount.updateAccount(email, { enabled: targetEnabled });
        logger.info(`[DPSK-Account] 账号 ${email} 状态变更为: ${targetEnabled ? '已启用' : '已停用'}`, 'DPSK_ACCOUNT');

        res.json({
            message: targetEnabled ? '账号已启用' : '账号已停用',
            enabled: targetEnabled,
            account: updated
        });
    } catch (error) {
        logger.error('修改 DeepSeek 账号状态失败', 'DPSK_ACCOUNT', '', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * DELETE /api/dpsk/accounts
 * 删除 DeepSeek 账号
 */
router.delete('/dpsk/accounts', adminKeyVerify, async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({ error: '邮箱不能为空' });
        }

        const success = dpskAccount.deleteAccount(email);
        if (success) {
            res.json({ message: '账号删除成功' });
        } else {
            res.status(404).json({ error: '账号不存在' });
        }
    } catch (error) {
        logger.error('删除 DeepSeek 账号失败', 'DPSK_ACCOUNT', '', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * POST /api/dpsk/accounts/refresh
 * 刷新指定账号的 token
 */
router.post('/dpsk/accounts/refresh', adminKeyVerify, async (req, res) => {
    try {
        const { email } = req.body;
        if (email) {
            const account = await dpskAccount.refreshToken(email);
            res.json({ message: 'Token 刷新成功', account });
        } else {
            // 刷新所有账号
            const accounts = dpskAccount.getAllAccounts(true);
            let refreshedCount = 0;
            for (const acc of accounts) {
                try {
                    await dpskAccount.refreshToken(acc.email);
                    refreshedCount++;
                } catch (e) {
                    logger.error(`刷新 DeepSeek 账号 ${acc.email} 失败`, 'DPSK_ACCOUNT', '', e);
                }
            }
            res.json({ message: '批量刷新完成', refreshedCount });
        }
    } catch (error) {
        logger.error('刷新 DeepSeek 账号失败', 'DPSK_ACCOUNT', '', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/dpsk/stats
 * 获取 DeepSeek 账号的详细 token 统计
 */
router.get('/dpsk/stats', adminKeyVerify, async (req, res) => {
    try {
        const stats = dpskAccount.getAllAccountStats();
        res.json({
            accounts: stats,
        });
    } catch (error) {
        logger.error('获取 DeepSeek 账号统计失败', 'DPSK_ACCOUNT', '', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /api/dpsk/statsHistory
 * 获取 DeepSeek 账号最近 30 天的 chat 统计历史数据
 */
router.get('/dpsk/statsHistory', adminKeyVerify, async (req, res) => {
    try {
        const today = dpskAccount.getTodayKey();

        const copyChatStats = (chat) => {
            if (!chat || typeof chat !== 'object') return { input: 0, output: 0 };
            return { input: Number(chat.input) || 0, output: Number(chat.output) || 0 };
        };

        const accounts = dpskAccount.getAllAccountKeys().map(account => {
            const history = {};
            const src = account.statsHistory || {};
            for (const key of Object.keys(src)) {
                const entry = src[key] || {};
                const chat = entry.chat || {};
                history[key] = { chat: copyChatStats(chat) };
            }

            const s = account.stats || { chat: copyChatStats() };
            history[today] = { chat: copyChatStats(s.chat) };

            return { email: account.email, history };
        });

        res.json({ today, accounts });
    } catch (error) {
        logger.error('获取 DeepSeek statsHistory 失败', 'DPSK_ACCOUNT', '', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;