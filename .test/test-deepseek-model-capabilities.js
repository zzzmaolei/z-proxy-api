const { test, after } = require('node:test')
const assert = require('node:assert/strict')

const dpskClient = require('../src/backends/deepseek/dpsk-client')

after(() => {
  dpskClient._setModelCapabilitiesForTest([])
})

test('settings capabilities take precedence over model-name heuristics', () => {
  dpskClient._setModelCapabilitiesForTest([
    {
      id: 'deepseek-lab-r2',
      model_type: 'lab-r2',
      thinking_enabled: true,
      capabilities: {
        model_type: 'lab-r2',
        thinking_supported: true,
        thinking_enabled: true,
        context_window: 32768,
        max_output_tokens: 4096,
      },
    },
    {
      id: 'deepseek-lab-r2-flash',
      model_type: 'lab-r2',
      thinking_enabled: false,
      capabilities: {
        model_type: 'lab-r2',
        thinking_supported: true,
        thinking_enabled: false,
      },
    },
  ])

  const resolved = dpskClient.resolveModelOptions('deepseek-lab-r2')
  assert.equal(resolved.modelType, 'lab-r2')
  assert.equal(resolved.thinkingEnabled, true)
  assert.equal(resolved.capabilitySource, 'settings')
  assert.equal(resolved.capabilities.context_window, 32768)

  const flash = dpskClient.resolveModelOptions('deepseek-lab-r2-flash')
  assert.equal(flash.modelType, 'lab-r2')
  assert.equal(flash.thinkingEnabled, false)
})

test('unsupported thinking capability is never advertised as enabled', () => {
  dpskClient._setModelCapabilitiesForTest([
    {
      id: 'deepseek-fast-basic',
      model_type: 'fast-basic',
      thinking_enabled: false,
      capabilities: {
        model_type: 'fast-basic',
        thinking_supported: false,
        thinking_enabled: false,
      },
    },
  ])

  const resolved = dpskClient.resolveModelOptions('deepseek-fast-basic', { reasoningEffort: 'max' })
  assert.equal(resolved.thinkingEnabled, false)
  assert.equal(resolved.capabilities.thinking_supported, false)
})

test('feature metadata with an explicit false flag is not treated as enabled', () => {
  assert.equal(dpskClient._featureEnabledForTest({ vision: false }), false)
  assert.equal(dpskClient._featureEnabledForTest({ vision: false, type: 'file' }), false)
  assert.equal(dpskClient._featureEnabledForTest({ type: 'thinking' }), true)
})

test('empty feature metadata stays unknown and does not disable thinking', () => {
  assert.equal(dpskClient._featureStateForTest({}), null)
  assert.equal(dpskClient._featureStateForTest({ enabled: {} }), null)
  dpskClient._setModelCapabilitiesForTest([
    {
      id: 'deepseek-settings-unknown',
      model_type: 'settings-unknown',
      thinking_enabled: true,
      capabilities: {
        model_type: 'settings-unknown',
        thinking_supported: null,
        thinking_enabled: true,
        input_character_limit: 2621440,
      },
    },
  ])
  const resolved = dpskClient.resolveModelOptions('deepseek-settings-unknown', { reasoningEffort: 'high' })
  assert.equal(resolved.thinkingEnabled, true)
  assert.equal(resolved.capabilities.thinking_supported, null)
  assert.equal(resolved.capabilities.input_character_limit, 2621440)
  assert.equal(resolved.capabilitySource, 'settings-unknown')
})

test('unknown model types are preserved instead of silently routed to default', () => {
  dpskClient._setModelCapabilitiesForTest([])
  const resolved = dpskClient.resolveModelOptions('deepseek-lab-r2')
  assert.equal(resolved.modelType, 'lab-r2')
  assert.equal(resolved.capabilitySource, 'heuristic')
})

test('display suffixes are ignored and flash variants default to thinking off', () => {
  dpskClient._setModelCapabilitiesForTest([
    {
      id: 'deepseek-expert',
      model_type: 'expert',
      thinking_enabled: true,
      capabilities: {
        model_type: 'expert',
        thinking_supported: true,
        thinking_enabled: true,
      },
    },
    {
      id: 'deepseek-default',
      model_type: 'default',
      thinking_enabled: true,
      capabilities: {
        model_type: 'default',
        thinking_supported: true,
        thinking_enabled: true,
      },
    },
  ])

  const claude = dpskClient.resolveModelOptions('deepseek-expert[1M]')
  assert.equal(claude.modelType, 'expert')
  assert.equal(claude.modelVariant, 'base')
  assert.equal(claude.thinkingEnabled, true)

  const flash = dpskClient.resolveModelOptions('deepseek-default-flash')
  assert.equal(flash.modelType, 'default')
  assert.equal(flash.modelVariant, 'flash')
  assert.equal(flash.thinkingEnabled, false)

  const explicitOn = dpskClient.resolveModelOptions('deepseek-default-flash', { reasoningEffort: 'high' })
  assert.equal(explicitOn.thinkingEnabled, true)
})
