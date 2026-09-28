'use strict'

const crypto = require('node:crypto')

/**
 * Return a stable, non-reversible account identifier for diagnostics.
 * Never put credentials or email addresses in ordinary logs.
 */
function accountLogId(accountOrEmail) {
  if (accountOrEmail && typeof accountOrEmail === 'object') {
    if (accountOrEmail.accountId) return String(accountOrEmail.accountId).slice(0, 16)
    accountOrEmail = accountOrEmail.email || accountOrEmail.credentials?.email || ''
  }
  const value = String(accountOrEmail || '').trim().toLowerCase()
  if (!value) return 'unknown'
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12)
}

module.exports = { accountLogId }
