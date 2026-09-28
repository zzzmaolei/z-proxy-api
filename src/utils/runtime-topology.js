'use strict'

const cluster = require('node:cluster')

function parseConfiguredInstances(value) {
  if (String(value || '').toLowerCase() === 'max') return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

function detectRuntimeTopology(options = {}) {
  const env = options.env || process.env
  const clusterModule = options.clusterModule || cluster
  const configuredInstances = parseConfiguredInstances(env.PM2_INSTANCES)
  const pm2IdRaw = env.NODE_APP_INSTANCE ?? env.pm_id
  const hasPm2WorkerMarker = pm2IdRaw !== undefined && pm2IdRaw !== null && pm2IdRaw !== ''
  const pm2Id = hasPm2WorkerMarker ? Number.parseInt(pm2IdRaw, 10) : null
  const isClusterWorker = !!clusterModule.isWorker

  let detectedRuntime = 'node'
  let actualWorkerId = null
  let isActualMultiWorker = false

  if (hasPm2WorkerMarker) {
    detectedRuntime = 'pm2'
    actualWorkerId = Number.isFinite(pm2Id) ? pm2Id : String(pm2IdRaw)
    isActualMultiWorker = configuredInstances === null || configuredInstances > 1 || (Number.isFinite(pm2Id) && pm2Id > 0)
  } else if (isClusterWorker) {
    detectedRuntime = 'cluster'
    actualWorkerId = clusterModule.worker?.id ?? null
    isActualMultiWorker = true
  }

  const isLeader = !isActualMultiWorker ||
    (detectedRuntime === 'pm2' && (actualWorkerId === 0 || actualWorkerId === '0')) ||
    (detectedRuntime === 'cluster' && actualWorkerId === 1)
  return { detectedRuntime, actualWorkerId, configuredInstances, isActualMultiWorker, isLeader }
}

function buildFileModeRuntimeDiagnostic(dataSaveMode, topology = detectRuntimeTopology()) {
  return {
    shouldWarn: dataSaveMode === 'file' && topology.isActualMultiWorker,
    detectedRuntime: topology.detectedRuntime,
    actualWorkerId: topology.actualWorkerId,
    configuredInstances: topology.configuredInstances,
    dataSaveMode,
    isLeader: topology.isLeader,
  }
}

module.exports = { detectRuntimeTopology, parseConfiguredInstances, buildFileModeRuntimeDiagnostic }
