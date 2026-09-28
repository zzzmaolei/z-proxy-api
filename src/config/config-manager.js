const fs = require('fs')
const path = require('path')
const { logger } = require('../utils/logger')

const CONFIG_FILE_PATH = path.resolve(process.cwd(), 'data', 'config.json')

class ConfigManager {
    constructor() {
        this.filePath = CONFIG_FILE_PATH
        this._ensureDataDir()
    }

    _ensureDataDir() {
        const dir = path.dirname(this.filePath)
        if (!fs.existsSync(dir)) {
            try {
                fs.mkdirSync(dir, { recursive: true })
            } catch (err) {
                logger.error?.('[ConfigManager] 无法创建配置目录', 'CONFIG', '', err)
            }
        }
    }

    readConfig() {
        this._ensureDataDir()
        if (!fs.existsSync(this.filePath)) {
            return {}
        }
        try {
            const raw = fs.readFileSync(this.filePath, 'utf-8')
            return JSON.parse(raw)
        } catch (err) {
            logger.error?.('[ConfigManager] 读取 config.json 失败', 'CONFIG', '', err)
            return {}
        }
    }

    saveConfig(updates, liveConfig = null) {
        this._ensureDataDir()
        const current = this.readConfig()
        const merged = { ...current, ...updates }

        const tmpPath = `${this.filePath}.${Date.now()}.tmp`
        try {
            fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), 'utf-8')
            fs.renameSync(tmpPath, this.filePath)
            logger.info?.(`[ConfigManager] 配置成功持久化至 ${this.filePath}`, 'CONFIG')

            // 原地热同步 liveConfig 单例
            if (liveConfig && typeof liveConfig === 'object') {
                for (const [k, v] of Object.entries(updates)) {
                    liveConfig[k] = v
                    if (k === 'apiKeys' && Array.isArray(v) && liveConfig.apiKeySet instanceof Set) {
                        liveConfig.apiKeySet.clear()
                        v.forEach(key => liveConfig.apiKeySet.add(key))
                    }
                }
            }
            return { success: true, config: merged }
        } catch (err) {
            try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath) } catch (_) {}
            logger.error?.('[ConfigManager] 保存 config.json 失败', 'CONFIG', '', err)
            throw err
        }
    }
}

module.exports = new ConfigManager()
