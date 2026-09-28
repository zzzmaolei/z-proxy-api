'use strict'

/** Baxia UMID 自动刷新：leader-only、跨进程 lease、last-known-good。 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')
const { logger: defaultLogger } = require('../../utils/logger')
const config = require('../../config')
const { detectRuntimeTopology } = require('../../utils/runtime-topology')

const BAXIA_UMID_PATH = path.join(__dirname, '..', '..', '..', 'data', 'baxia-umid.json')
const BAXIA_V = '2.5.37'
const REFRESH_INTERVAL_SEC = 24 * 60 * 60
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const MEMORY_CACHE_TTL_MS = 5 * 60 * 1000
const LEASE_TTL_MS = 90 * 1000
const BASE_FAILURE_COOLDOWN_MS = 60 * 1000
const MAX_FAILURE_COOLDOWN_MS = 60 * 60 * 1000

const validProxyUrl = value => /^(https?|socks5):\/\/[^\s]+$/i.test(String(value || '').trim())

function resolveAgentBrowserExecutable(options = {}) {
  const env = options.env || process.env
  const platform = options.platform || process.platform
  const exists = options.exists || fs.existsSync
  if (env.AGENT_BROWSER_BIN) return env.AGENT_BROWSER_BIN
  if (platform === 'win32' && env.APPDATA) {
    const executable = path.join(
      env.APPDATA,
      'npm',
      'node_modules',
      'agent-browser',
      'bin',
      'agent-browser-win32-x64.exe'
    )
    if (exists(executable)) return executable
  }
  return 'agent-browser'
}

const defaultRunner = (args, options = {}) => new Promise((resolve, reject) => {
  execFile(resolveAgentBrowserExecutable({ env: options.env }), args, {
    timeout: 60000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    env: options.env || process.env,
  }, (error, stdout, stderr) => {
    if (error) {
      error.stderr = stderr
      reject(error)
      return
    }
    resolve(String(stdout || ''))
  })
})

function parseBrowserResult(stdout) {
  const lines = String(stdout || '').split(/\r?\n/).filter(line => line.trim())
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim()
    if (!line.startsWith('{')) continue
    try {
      const parsed = JSON.parse(line)
      return typeof parsed === 'string' ? JSON.parse(parsed) : parsed
    } catch (_) { /* keep scanning */ }
  }
  return null
}

function createBaxiaManager(options = {}) {
  const fsApi = options.fs || fs
  const tokenPath = options.tokenPath || BAXIA_UMID_PATH
  const leasePath = options.leasePath || `${tokenPath}.refresh.lock`
  const log = options.logger || defaultLogger
  const topology = options.topology || detectRuntimeTopology()
  const runner = options.runner || defaultRunner
  const now = options.now || Date.now
  const proxyUrl = options.proxyUrl === undefined ? config.proxyUrl : options.proxyUrl
  const baseCooldownMs = options.baseCooldownMs || BASE_FAILURE_COOLDOWN_MS
  const maxCooldownMs = options.maxCooldownMs || MAX_FAILURE_COOLDOWN_MS
  const leaseTtlMs = options.leaseTtlMs || LEASE_TTL_MS
  const checkIntervalMs = options.checkIntervalMs || CHECK_INTERVAL_MS

  let cachedUmid = null
  let cacheTime = 0
  let refreshTimer = null
  let refreshPromise = null
  let failureCount = 0
  let nextRefreshAt = 0
  let proxyDiagnosticLogged = false

  const writeLog = (level, event, details = '') => {
    const method = level === 'warn' ? (log.warn || log.warning) : log[level]
    method?.call(log, `[baxia-umid] ${event}${details ? ` ${details}` : ''}`, 'BAXIA')
  }

  const loadFromFile = () => {
    try {
      if (!fsApi.existsSync(tokenPath)) return null
      const data = JSON.parse(fsApi.readFileSync(tokenPath, 'utf8'))
      if (!data.umidtoken || typeof data.umidtoken !== 'string') return null
      return { umidtoken: data.umidtoken, bxv: data.bxv || BAXIA_V, updatedAt: Number(data.updatedAt) || 0 }
    } catch (error) {
      writeLog('warn', 'token_read_failed', `reason=${error.message}`)
      return null
    }
  }

  const needsRefresh = data => !data || (Math.floor(now() / 1000) - data.updatedAt) > REFRESH_INTERVAL_SEC

  const updateUmidtoken = umidtoken => {
    const data = { umidtoken, bxv: BAXIA_V, updatedAt: Math.floor(now() / 1000) }
    try {
      fsApi.mkdirSync(path.dirname(tokenPath), { recursive: true })
      const tempPath = `${tokenPath}.${process.pid}.${crypto.randomUUID()}.tmp`
      fsApi.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8')
      fsApi.renameSync(tempPath, tokenPath)
      cachedUmid = { umidtoken, bxv: BAXIA_V }
      cacheTime = now()
      writeLog('info', 'refresh_succeeded')
      return true
    } catch (error) {
      writeLog('error', 'token_write_failed', `reason=${error.message}`)
      return false
    }
  }

  const acquireLease = () => {
    fsApi.mkdirSync(path.dirname(leasePath), { recursive: true })
    const leaseId = crypto.randomUUID()
    const payload = { pid: process.pid, leaseId, expiresAt: now() + leaseTtlMs }
    const attempt = () => {
      const fd = fsApi.openSync(leasePath, 'wx')
      try { fsApi.writeFileSync(fd, JSON.stringify(payload), 'utf8') } finally { fsApi.closeSync(fd) }
      return {
        release() {
          try {
            const current = JSON.parse(fsApi.readFileSync(leasePath, 'utf8'))
            if (current.leaseId === leaseId) fsApi.unlinkSync(leasePath)
          } catch (_) { /* expired/replaced */ }
        }
      }
    }
    try {
      return attempt()
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        const existing = JSON.parse(fsApi.readFileSync(leasePath, 'utf8'))
        if (Number(existing.expiresAt) <= now()) {
          fsApi.unlinkSync(leasePath)
          return attempt()
        }
      } catch (_) { /* another worker owns or repairs it */ }
      return null
    }
  }

  const browserEnv = () => {
    if (!proxyUrl) {
      if (!proxyDiagnosticLogged) {
        proxyDiagnosticLogged = true
        writeLog('warn', 'refresh_proxy_unconfigured', 'mode=direct')
      }
      const env = { ...process.env }
      for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
        delete env[key]
      }
      return env
    }
    if (!validProxyUrl(proxyUrl)) return null
    return { ...process.env, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl }
  }

  const executeBrowserRefresh = async () => {
    const env = browserEnv()
    if (!env) {
      const error = new Error('configured proxy URL is invalid')
      error.code = 'BAXIA_PROXY_INVALID'
      throw error
    }
    const extractJs = `(function(){var r={};try{if(window.__baxia__&&window.__baxia__.getFYModule)r.umidtoken=window.__baxia__.getFYModule.getUidToken()}catch(e){r.error=e.message}return JSON.stringify(r)})()`
    const encoded = Buffer.from(extractJs).toString('base64')
    await runner(['open', 'https://chat.qwen.ai'], { env })
    await runner(['wait', '--load', 'networkidle'], { env })
    const stdout = await runner(['eval', '-b', encoded], { env })
    const result = parseBrowserResult(stdout)
    if (!result?.umidtoken) {
      const error = new Error(result?.error || 'browser output did not contain umidtoken')
      error.code = 'BAXIA_BROWSER_RESULT_INVALID'
      throw error
    }
    if (!updateUmidtoken(result.umidtoken)) throw new Error('failed to persist refreshed token')
  }

  const refreshFromBrowser = async (reason = 'refresh_needed') => {
    if (!topology.isLeader) {
      writeLog('debug', 'refresh_skipped_not_leader', `worker=${topology.actualWorkerId ?? 'n/a'}`)
      return { status: 'skipped_not_leader' }
    }
    if (refreshPromise) return refreshPromise
    if (now() < nextRefreshAt) {
      writeLog('debug', 'refresh_skipped_cooldown', `retryInMs=${nextRefreshAt - now()}`)
      return { status: 'cooldown' }
    }
    let lease
    try {
      lease = acquireLease()
    } catch (error) {
      writeLog('warn', 'refresh_lease_failed', `reason=${error.message}`)
      return { status: 'lease_failed' }
    }
    if (!lease) {
      writeLog('debug', 'refresh_skipped_lease_held')
      return { status: 'lease_held' }
    }

    refreshPromise = (async () => {
      writeLog('info', 'refresh_started', `reason=${reason} proxy=${proxyUrl ? 'configured' : 'direct'}`)
      try {
        await executeBrowserRefresh()
        failureCount = 0
        nextRefreshAt = 0
        return { status: 'succeeded' }
      } catch (error) {
        failureCount += 1
        nextRefreshAt = now() + Math.min(maxCooldownMs, baseCooldownMs * (2 ** (failureCount - 1)))
        const errorText = `${error.message || ''} ${error.stderr || ''}`
        const proxyFailure = error.code === 'BAXIA_PROXY_INVALID' || /proxy|ERR_PROXY/i.test(errorText)
        const diagnosticCode = errorText.match(/ERR_[A-Z_]+/)?.[0] || error.code || 'browser_error'
        writeLog('warn', proxyFailure ? 'refresh_failed_proxy' : 'refresh_failed_browser', `reason=${diagnosticCode} cooldownMs=${nextRefreshAt - now()}`)
        const stale = loadFromFile()
        writeLog(stale ? 'warn' : 'error', stale ? 'stale_token_still_available' : 'no_token_available')
        return { status: proxyFailure ? 'failed_proxy' : 'failed_browser' }
      } finally {
        lease.release()
        refreshPromise = null
      }
    })()
    return refreshPromise
  }

  const getBaxiaHeaders = () => {
    if (cachedUmid && now() - cacheTime < MEMORY_CACHE_TTL_MS) return cachedUmid
    const loaded = loadFromFile()
    if (loaded) {
      cachedUmid = { umidtoken: loaded.umidtoken, bxv: loaded.bxv }
      cacheTime = now()
      if (needsRefresh(loaded)) void refreshFromBrowser('refresh_needed')
      return cachedUmid
    }
    writeLog('warn', 'refresh_needed', 'reason=no_token_file')
    void refreshFromBrowser('no_token_available')
    return null
  }

  const refreshCache = () => { cachedUmid = null; cacheTime = 0 }

  const startAutoRefresh = () => {
    if (!topology.isLeader) {
      writeLog('debug', 'refresh_skipped_not_leader', `worker=${topology.actualWorkerId ?? 'n/a'}`)
      return
    }
    if (refreshTimer) return
    const loaded = loadFromFile()
    if (needsRefresh(loaded)) void refreshFromBrowser('startup_check')
    refreshTimer = setInterval(() => {
      const current = loadFromFile()
      if (needsRefresh(current)) void refreshFromBrowser('scheduled_check')
    }, checkIntervalMs)
    refreshTimer.unref?.()
  }

  const stopAutoRefresh = () => {
    if (refreshTimer) clearInterval(refreshTimer)
    refreshTimer = null
  }

  return {
    getBaxiaHeaders,
    refreshCache,
    updateUmidtoken,
    refreshFromBrowser,
    startAutoRefresh,
    stopAutoRefresh,
    loadFromFile,
  }
}

const manager = createBaxiaManager()

module.exports = {
  ...manager,
  createBaxiaManager,
  parseBrowserResult,
  resolveAgentBrowserExecutable,
  BAXIA_V,
}
