const { test } = require('node:test')
const assert = require('node:assert/strict')

const { shouldCompressToolHistory } = require('../src/backends/deepseek/history-policy')

test('tool history compression is disabled unless explicitly enabled', () => {
  assert.equal(shouldCompressToolHistory({}), false)
  assert.equal(shouldCompressToolHistory({ dpskEnableToolHistoryCompression: false }), false)
  assert.equal(shouldCompressToolHistory({ dpskEnableToolHistoryCompression: true }), true)
})
