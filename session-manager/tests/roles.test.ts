import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), `roles-test-${Date.now()}`)
const ACCESS_FILE = join(TEST_DIR, 'access.json')

before(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  process.env._PC_ACCESS_FILE = ACCESS_FILE
})

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  delete process.env._PC_ACCESS_FILE
})

function writeAccess(data: Record<string, unknown>) {
  writeFileSync(ACCESS_FILE, JSON.stringify(data))
}

test('getUserRole returns member for unknown user', async () => {
  const { getUserRole } = await import('../roles.ts')
  writeAccess({ allowFrom: ['111'] })
  assert.equal(getUserRole('999'), 'member')
})

test('getUserRole returns admin when set', async () => {
  const { getUserRole } = await import('../roles.ts')
  writeAccess({ allowFrom: ['111'], roles: { '111': 'admin' } })
  assert.equal(getUserRole('111'), 'admin')
})

test('getUserRole returns member when role is member', async () => {
  const { getUserRole } = await import('../roles.ts')
  writeAccess({ roles: { '222': 'member' } })
  assert.equal(getUserRole('222'), 'member')
})

test('setUserRole writes role to access.json', async () => {
  const { setUserRole, getUserRole } = await import('../roles.ts')
  writeAccess({ allowFrom: ['333'] })
  await setUserRole('333', 'admin')
  assert.equal(getUserRole('333'), 'admin')
})

test('requireAdmin returns ok for admin', async () => {
  const { requireAdmin } = await import('../roles.ts')
  writeAccess({ roles: { '111': 'admin' } })
  const result = requireAdmin('111')
  assert.equal(result.ok, true)
})

test('requireAdmin returns error for member', async () => {
  const { requireAdmin, ERR_ADMIN_REQUIRED } = await import('../roles.ts')
  writeAccess({ roles: { '222': 'member' } })
  const result = requireAdmin('222')
  assert.equal(result.ok, false)
  assert.equal((result as { ok: false; error: string }).error, ERR_ADMIN_REQUIRED)
})

test('requireAdmin returns error when callerId is undefined', async () => {
  const { requireAdmin, ERR_CALLER_ID_MISSING } = await import('../roles.ts')
  const result = requireAdmin(undefined)
  assert.equal(result.ok, false)
  assert.equal((result as { ok: false; error: string }).error, ERR_CALLER_ID_MISSING)
})
