import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), `seen-test-${Date.now()}`)
const SEEN_FILE = join(TEST_DIR, 'seen_users.json')

before(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  process.env._PC_SEEN_FILE = SEEN_FILE
})

beforeEach(() => {
  if (existsSync(SEEN_FILE)) unlinkSync(SEEN_FILE)
})

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  delete process.env._PC_SEEN_FILE
})

test('first contact returns needsWelcome: true', async () => {
  const { checkAndRecord } = await import('../seen_users.ts')
  const result = checkAndRecord('111')
  assert.equal(result.needsWelcome, true)
})

test('second contact before welcome returns needsWelcome: true', async () => {
  const { checkAndRecord } = await import('../seen_users.ts')
  checkAndRecord('111')
  const result = checkAndRecord('111')
  assert.equal(result.needsWelcome, true)
})

test('after markWelcomed, needsWelcome is false', async () => {
  const { checkAndRecord, markWelcomed } = await import('../seen_users.ts')
  checkAndRecord('111')
  markWelcomed('111')
  const result = checkAndRecord('111')
  assert.equal(result.needsWelcome, false)
})

test('different users are tracked independently', async () => {
  const { checkAndRecord, markWelcomed } = await import('../seen_users.ts')
  checkAndRecord('111')
  markWelcomed('111')
  const result = checkAndRecord('222')
  assert.equal(result.needsWelcome, true)
})
