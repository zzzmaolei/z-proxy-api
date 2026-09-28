'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { accountLogId } = require('../src/utils/account-log-id')

test('accountLogId never returns the source email', () => {
  const email = 'agent@example.invalid'
  const id = accountLogId(email)
  assert.match(id, /^[0-9a-f]{12}$/)
  assert.notEqual(id, email)
  assert.equal(accountLogId({ email }), id)
  assert.equal(accountLogId({ accountId: 'stable-account-123' }), 'stable-account-1')
  assert.equal(accountLogId(null), 'unknown')
})
