import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), `turn-test-${Date.now()}`)
const TURN_FILE = join(TEST_DIR, 'turn.lock')

before(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  process.env._PC_TURN_FILE = TURN_FILE
})

beforeEach(() => {
  if (existsSync(TURN_FILE)) unlinkSync(TURN_FILE)
})

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  delete process.env._PC_TURN_FILE
})

test('claimTurn succeeds when no lock exists', async () => {
  const { claimTurn } = await import('../turn.ts')
  const result = claimTurn('111', 'Alice')
  assert.equal(result.ok, true)
})

test('claimTurn blocks a different caller when lock is active', async () => {
  const { claimTurn } = await import('../turn.ts')
  claimTurn('111', 'Alice')
  const result = claimTurn('222', 'Bob')
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.holder, '111')
    assert.equal(result.holder_name, 'Alice')
    assert.ok(result.wait_min > 0)
  }
})

test('claimTurn allows same caller to extend their turn', async () => {
  const { claimTurn } = await import('../turn.ts')
  claimTurn('111', 'Alice')
  const result = claimTurn('111', 'Alice')
  assert.equal(result.ok, true)
})

test('claimTurn overwrites an expired lock', async () => {
  const { claimTurn } = await import('../turn.ts')
  // Write an already-expired lock manually
  const { writeFileSync } = await import('node:fs')
  const expired = {
    holder: '111', holder_name: 'Alice',
    claimed_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    expires_at: new Date(Date.now() - 10 * 60_000).toISOString(),
  }
  writeFileSync(TURN_FILE, JSON.stringify(expired))
  const result = claimTurn('222', 'Bob')
  assert.equal(result.ok, true)
})

test('releaseTurn clears the lock for the holder', async () => {
  const { claimTurn, releaseTurn, getTurnStatus } = await import('../turn.ts')
  claimTurn('111', 'Alice')
  releaseTurn('111')
  assert.equal(getTurnStatus(), null)
})

test('releaseTurn does nothing for non-holder', async () => {
  const { claimTurn, releaseTurn, getTurnStatus } = await import('../turn.ts')
  claimTurn('111', 'Alice')
  releaseTurn('222')
  assert.notEqual(getTurnStatus(), null)
})

test('getTurnStatus returns null when no lock', async () => {
  const { getTurnStatus } = await import('../turn.ts')
  assert.equal(getTurnStatus(), null)
})
