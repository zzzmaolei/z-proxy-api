const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')

const config = require('../src/config')
const TEST_ADMIN_KEY = 'sk-test-admin-cpa'
config.adminKey = TEST_ADMIN_KEY
config.apiKeys = [TEST_ADMIN_KEY]
config.apiKeySet.add(TEST_ADMIN_KEY)

const settingsRouter = require('../src/routes/settings')

describe('Unified CPA Config & Telemetry API', () => {
    let server
    let baseUrl

    before(async () => {
        const app = express()
        app.use(express.json())
        app.use('/api', settingsRouter)
        await new Promise((resolve) => {
            server = app.listen(0, '127.0.0.1', () => {
                const port = server.address().port
                baseUrl = `http://127.0.0.1:${port}`
                resolve()
            })
        })
    })

    after(async () => {
        if (server) {
            await new Promise((resolve) => server.close(resolve))
        }
    })

    it('GET /api/config returns categorized configuration with masked secrets', async () => {
        const res = await fetch(`${baseUrl}/api/config`, {
            headers: { 'Authorization': `Bearer ${TEST_ADMIN_KEY}` }
        })
        const body = await res.json()

        assert.equal(res.status, 200)
        assert.equal(body.status, true)
        assert.ok(body.data.system)
        assert.ok(body.data.security)
        assert.ok(body.data.scheduler)
        assert.ok(body.data.provider_deepseek)
        assert.ok(body.data.stream_and_retry)
        assert.ok(body.data.logging_and_sidecar)
        assert.ok(body.meta.isSecretsMasked)
    })

    it('POST /api/config atomically updates and hot-syncs configuration', async () => {
        const res = await fetch(`${baseUrl}/api/config`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${TEST_ADMIN_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                stream_and_retry: {
                    chatRetryCount: 3
                },
                scheduler: {
                    dpskRoutingStrategy: 'round-robin'
                }
            })
        })
        const body = await res.json()

        assert.equal(res.status, 200)
        assert.equal(body.status, true)
        assert.ok(body.updatedKeys.includes('chatRetryCount'))
        assert.ok(body.updatedKeys.includes('dpskRoutingStrategy'))
        assert.equal(config.chatRetryCount, 3)
        assert.equal(config.dpskRoutingStrategy, 'round-robin')
    })

    it('GET /api/scheduler-status aggregates metrics across providers', async () => {
        const res = await fetch(`${baseUrl}/api/scheduler-status`, {
            headers: { 'Authorization': `Bearer ${TEST_ADMIN_KEY}` }
        })
        const body = await res.json()

        assert.equal(res.status, 200)
        assert.equal(body.status, true)
        assert.ok(body.summary)
        assert.ok(typeof body.summary.totalAccounts === 'number')
        assert.ok(typeof body.summary.totalInFlight === 'number')
        assert.ok(body.summary.byStatus)
    })
})
