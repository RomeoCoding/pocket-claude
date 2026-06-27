import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), `telegram-test-${Date.now()}`)
const ENV_FILE = join(TEST_DIR, '.env')
const ACCESS_FILE = join(TEST_DIR, 'access.json')

before(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  process.env._PC_ENV_FILE = ENV_FILE
  process.env._PC_ACCESS_FILE = ACCESS_FILE
})

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  delete process.env._PC_ENV_FILE
  delete process.env._PC_ACCESS_FILE
})

test('getBotToken reads token from .env', async () => {
  const { getBotToken } = await import('../telegram.ts')
  writeFileSync(ENV_FILE, 'TELEGRAM_TOKEN=abc123\nOTHER=value\n')
  assert.equal(getBotToken(), 'abc123')
})

test('getBotToken handles token with = in value', async () => {
  const { getBotToken } = await import('../telegram.ts')
  writeFileSync(ENV_FILE, 'TELEGRAM_TOKEN=abc=def==\n')
  assert.equal(getBotToken(), 'abc=def==')
})

test('getBotToken returns empty string when .env missing', async () => {
  const { getBotToken } = await import('../telegram.ts')
  rmSync(ENV_FILE, { force: true })
  assert.equal(getBotToken(), '')
  writeFileSync(ENV_FILE, '')
})

test('getNotifyTargets returns users and group IDs', async () => {
  const { getNotifyTargets } = await import('../telegram.ts')
  writeFileSync(ACCESS_FILE, JSON.stringify({
    allowFrom: ['111', '222'],
    groups: { '-100abc': 'mygroup' },
  }))
  const targets = getNotifyTargets()
  assert.ok(targets.includes('111'))
  assert.ok(targets.includes('222'))
  assert.ok(targets.includes('-100abc'))
  assert.equal(targets.length, 3)
})

test('getNotifyTargets returns empty array when access.json missing', async () => {
  const { getNotifyTargets } = await import('../telegram.ts')
  rmSync(ACCESS_FILE, { force: true })
  assert.deepEqual(getNotifyTargets(), [])
  writeFileSync(ACCESS_FILE, '{}')
})
