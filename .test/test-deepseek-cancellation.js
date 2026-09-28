const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')

const dpskPow = require('../src/backends/deepseek/dpsk-pow')
const { downloadHttpUrl } = require('../src/shared/media-downloader')

test('PoW rejects an already-aborted request before loading WASM', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    dpskPow.solvePow(null, controller.signal),
    error => error?.code === 'ABORT_ERR',
  )
})

test('media URL download forwards AbortSignal to axios', async () => {
  const server = http.createServer((_req, res) => {
    setTimeout(() => res.end('late'), 500).unref?.()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const controller = new AbortController()
  const pending = downloadHttpUrl(`http://127.0.0.1:${port}/slow`, { signal: controller.signal, timeout: 5000 })
  setTimeout(() => controller.abort(), 20).unref?.()
  await assert.rejects(pending, error => error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError')
  await new Promise(resolve => server.close(resolve))
})
