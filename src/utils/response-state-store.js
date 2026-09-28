'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const config = require('../config')
const { detectRuntimeTopology } = require('./runtime-topology')

const DEFAULT_TTL_MS = 60 * 60 * 1000
const DEFAULT_MAX_ENTRY_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_ENTRIES = 1000
const KEY_PREFIX = 'zproxy:responses:'

function stateError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function hashResponseId(responseId) {
  return crypto.createHash('sha256').update(String(responseId || '')).digest('hex')
}

function serializeEntry(state, ttlMs, now, maxEntryBytes) {
  const entry = { state, createdAt: now, expiresAt: now + ttlMs }
  const serialized = JSON.stringify(entry)
  const bytes = Buffer.byteLength(serialized)
  if (bytes > maxEntryBytes) {
    throw stateError('response_state_too_large', `Response continuation state exceeds ${maxEntryBytes} bytes`)
  }
  return { entry, serialized }
}

function createResponseStateStore(options = {}) {
  const mode = options.mode || config.dataSaveMode || 'none'
  const topology = options.topology || detectRuntimeTopology()
  const now = options.now || (() => Date.now())
  const ttlMs = options.ttlMs || DEFAULT_TTL_MS
  const maxEntryBytes = options.maxEntryBytes || DEFAULT_MAX_ENTRY_BYTES
  const maxEntries = options.maxEntries || DEFAULT_MAX_ENTRIES
  const baseDir = options.baseDir || path.join(__dirname, '../../data/response-state')
  const redis = options.redisClient === undefined
    ? (mode === 'redis' ? require('./redis') : null)
    : options.redisClient
  const memory = options.memory || new Map()
  const effectiveMode = mode === 'redis' ? 'redis' : (mode === 'file' ? 'file' : 'memory')
  const available = !(effectiveMode === 'memory' && topology.isActualMultiWorker)

  const ensureAvailable = () => {
    if (!available) {
      throw stateError(
        'response_state_unavailable',
        `Responses continuation requires shared storage in ${topology.detectedRuntime} multi-worker mode`
      )
    }
  }

  const filePathFor = (responseId) => path.join(baseDir, `${hashResponseId(responseId)}.json`)
  const redisKeyFor = (responseId) => `${KEY_PREFIX}${hashResponseId(responseId)}`

  async function cleanupMemory() {
    const current = now()
    for (const [key, value] of memory) {
      if (!value || value.expiresAt <= current) memory.delete(key)
    }
    while (memory.size > maxEntries) memory.delete(memory.keys().next().value)
  }

  async function cleanupFiles() {
    await fs.mkdir(baseDir, { recursive: true })
    const names = (await fs.readdir(baseDir)).filter(name => /^[a-f0-9]{64}\.json$/.test(name))
    const current = now()
    const live = []
    for (const name of names) {
      const target = path.join(baseDir, name)
      try {
        const raw = await fs.readFile(target, 'utf8')
        const entry = JSON.parse(raw)
        if (!entry || entry.expiresAt <= current) await fs.unlink(target).catch(() => {})
        else live.push({ target, createdAt: entry.createdAt || 0 })
      } catch (_) {
        await fs.unlink(target).catch(() => {})
      }
    }
    live.sort((a, b) => a.createdAt - b.createdAt)
    for (let i = 0; i < Math.max(0, live.length - maxEntries); i++) {
      await fs.unlink(live[i].target).catch(() => {})
    }
  }

  return {
    mode: effectiveMode,
    available,
    topology,
    async get(responseId) {
      ensureAvailable()
      if (!responseId) return null
      const current = now()
      if (effectiveMode === 'redis') {
        if (!redis) throw stateError('response_state_unavailable', 'Redis continuation storage is not available')
        const raw = await redis.get(redisKeyFor(responseId))
        if (!raw) return null
        const entry = JSON.parse(raw)
        return entry.expiresAt > current ? entry.state : null
      }
      if (effectiveMode === 'file') {
        try {
          const target = filePathFor(responseId)
          const entry = JSON.parse(await fs.readFile(target, 'utf8'))
          if (entry.expiresAt <= current) {
            await fs.unlink(target).catch(() => {})
            return null
          }
          return entry.state
        } catch (error) {
          if (error.code === 'ENOENT') return null
          throw error
        }
      }
      const entry = memory.get(String(responseId))
      if (!entry || entry.expiresAt <= current) {
        memory.delete(String(responseId))
        return null
      }
      memory.delete(String(responseId))
      memory.set(String(responseId), entry)
      return entry.state
    },
    async set(responseId, state, customTtlMs = ttlMs) {
      ensureAvailable()
      if (!responseId) throw stateError('invalid_response_id', 'Response ID is required')
      const current = now()
      const packed = serializeEntry(state, customTtlMs, current, maxEntryBytes)
      if (effectiveMode === 'redis') {
        if (!redis) throw stateError('response_state_unavailable', 'Redis continuation storage is not available')
        await redis.psetex(redisKeyFor(responseId), customTtlMs, packed.serialized)
        return
      }
      if (effectiveMode === 'file') {
        await fs.mkdir(baseDir, { recursive: true })
        const target = filePathFor(responseId)
        const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
        await fs.writeFile(temp, packed.serialized, { encoding: 'utf8', flag: 'wx' })
        try {
          await fs.rename(temp, target)
        } finally {
          await fs.unlink(temp).catch(() => {})
        }
        const names = await fs.readdir(baseDir)
        if (names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).length > maxEntries) {
          await cleanupFiles()
        }
        return
      }
      memory.delete(String(responseId))
      memory.set(String(responseId), packed.entry)
      await cleanupMemory()
    },
    async delete(responseId) {
      ensureAvailable()
      if (effectiveMode === 'redis') {
        if (redis) await redis.del(redisKeyFor(responseId))
      } else if (effectiveMode === 'file') {
        await fs.unlink(filePathFor(responseId)).catch(error => {
          if (error.code !== 'ENOENT') throw error
        })
      } else {
        memory.delete(String(responseId))
      }
    },
    async cleanup() {
      ensureAvailable()
      if (effectiveMode === 'file') await cleanupFiles()
      else if (effectiveMode === 'memory') await cleanupMemory()
    },
    _filePathFor: filePathFor,
  }
}

module.exports = {
  createResponseStateStore,
  hashResponseId,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_ENTRY_BYTES,
  DEFAULT_MAX_ENTRIES,
}
