'use strict'

function shouldCompressToolHistory(config = {}) {
  return config.dpskEnableToolHistoryCompression === true
}

module.exports = { shouldCompressToolHistory }
