'use strict'

class SafeSseWriter {
  constructor(res, options = {}) {
    this.res = res
    this.closed = false
    this.ended = false
    this.drainWaitMs = 0
    this._writeRaw = options.write || res.write.bind(res)
    this._endRaw = options.end || res.end.bind(res)
    this._queue = Promise.resolve()
    this._endPromise = null
    this._onClose = () => { this.closed = true }
    this._onError = () => { this.closed = true }
    res.once?.('close', this._onClose)
    res.once?.('error', this._onError)
  }

  _enqueue(operation) {
    this._queue = this._queue.then(operation, operation)
    return this._queue
  }

  write(frame) {
    if (this.closed || this.ended) return false
    this._enqueue(async () => {
      if (this.closed || this.ended || this.res.destroyed || this.res.writableEnded) return
      const writable = this._writeRaw(frame)
      if (writable !== false) return
      const started = Date.now()
      await new Promise(resolve => {
        const done = () => {
          this.res.off?.('drain', onDrain)
          this.res.off?.('close', onClose)
          this.res.off?.('error', onClose)
          resolve()
        }
        const onDrain = () => done()
        const onClose = () => { this.closed = true; done() }
        this.res.once?.('drain', onDrain)
        this.res.once?.('close', onClose)
        this.res.once?.('error', onClose)
      })
      this.drainWaitMs += Date.now() - started
    })
    return true
  }

  end(...args) {
    if (this._endPromise) return this._endPromise
    this._endPromise = this._enqueue(async () => {
      if (!this.closed && !this.ended && !this.res.destroyed && !this.res.writableEnded) {
        this._endRaw(...args)
      }
      this.ended = true
      this._cleanup()
    })
    return this._endPromise
  }

  abort() {
    this.closed = true
    this._cleanup()
  }

  async idle() {
    await this._queue
  }

  _cleanup() {
    this.res.off?.('close', this._onClose)
    this.res.off?.('error', this._onError)
  }
}

module.exports = { SafeSseWriter }
