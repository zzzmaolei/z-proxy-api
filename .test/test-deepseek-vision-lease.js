const { test, describe, after } = require('node:test')
const assert = require('node:assert/strict')

const config = require('../src/config')
const dpskAccount = require('../src/backends/deepseek/dpsk-account')
const dpskClient = require('../src/backends/deepseek/dpsk-client')
const dpskScheduler = require('../src/backends/deepseek/scheduler-singleton')
const { detectImagesAndDescribe } = require('../src/backends/deepseek/anthropic-utils')

const PRIMARY = {
    accountId: 'vision-primary',
    email: 'vision-primary@example.invalid',
    token: 'primary-token',
    enabled: true,
}
const VISION = {
    accountId: 'vision-secondary',
    email: 'vision-secondary@example.invalid',
    token: 'vision-token',
    enabled: true,
}

const original = {
    getSchedulerAccounts: dpskAccount.getSchedulerAccounts,
    getAvailableAccount: dpskAccount.getAvailableAccount,
    uploadFilesFromMessages: dpskClient.uploadFilesFromMessages,
    pollFileStatus: dpskClient.pollFileStatus,
    describeImageWithVision: dpskClient.describeImageWithVision,
    queueTimeoutMs: config.dpskQueueTimeoutMs,
}

function prepare() {
    config.dpskQueueTimeoutMs = 1000
    dpskScheduler.resetForTests()
    dpskAccount.getSchedulerAccounts = () => [{ ...PRIMARY }, { ...VISION }]
    dpskAccount.getAvailableAccount = () => {
        throw new Error('legacy getAvailableAccount must not be used by Anthropic Vision')
    }
    const scheduler = dpskScheduler.syncAccounts([{ ...PRIMARY }, { ...VISION }])
    return scheduler
}

function imageMessages() {
    return [{
        role: 'user',
        content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
            { type: 'text', text: 'Please inspect this image.' },
        ],
    }]
}

after(() => {
    dpskScheduler.resetForTests()
    dpskAccount.getSchedulerAccounts = original.getSchedulerAccounts
    dpskAccount.getAvailableAccount = original.getAvailableAccount
    dpskClient.uploadFilesFromMessages = original.uploadFilesFromMessages
    dpskClient.pollFileStatus = original.pollFileStatus
    dpskClient.describeImageWithVision = original.describeImageWithVision
    config.dpskQueueTimeoutMs = original.queueTimeoutMs
})

describe('DeepSeek Anthropic Vision scheduler lease', () => {
    test('uses a separate scheduler lease and releases it on success', async () => {
        const scheduler = prepare()
        let uploadToken = null
        dpskClient.uploadFilesFromMessages = async token => {
            uploadToken = token
            return ['file-1']
        }
        dpskClient.pollFileStatus = async () => ({ status: 'SUCCESS' })
        dpskClient.describeImageWithVision = async () => 'a described image'

        const result = await detectImagesAndDescribe(imageMessages(), {
            account: { ...PRIMARY },
            modelType: 'default',
            proxyUrl: null,
            fingerprint: null,
            requestId: 'vision-success',
        })

        assert.match(result[0].content[0].text, /a described image/)
        assert.equal(uploadToken, VISION.token)
        assert.equal(scheduler.getSnapshot().globalInFlight, 0)
        assert.equal(scheduler.getSnapshot().queueDepth, 0)
    })

    test('releases the lease when image upload fails', async () => {
        const scheduler = prepare()
        dpskClient.uploadFilesFromMessages = async () => {
            throw new Error('upload failed')
        }

        await assert.rejects(
            detectImagesAndDescribe(imageMessages(), {
                account: { ...PRIMARY },
                modelType: 'default',
                proxyUrl: null,
                fingerprint: null,
                requestId: 'vision-failure',
            }),
            /upload failed/,
        )
        assert.equal(scheduler.getSnapshot().globalInFlight, 0)
        assert.equal(scheduler.getSnapshot().queueDepth, 0)
    })

    test('does not acquire a lease after client abort', async () => {
        const scheduler = prepare()
        const controller = new AbortController()
        controller.abort()

        await assert.rejects(
            detectImagesAndDescribe(imageMessages(), {
                account: { ...PRIMARY },
                modelType: 'default',
                proxyUrl: null,
                fingerprint: null,
                requestId: 'vision-abort',
                signal: controller.signal,
            }),
            error => error.code === 'CLIENT_ABORTED' && error.status === 499,
        )
        assert.equal(scheduler.getSnapshot().globalInFlight, 0)
        assert.equal(scheduler.getSnapshot().queueDepth, 0)
    })
})
