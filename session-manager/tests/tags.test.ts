import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), `tags-test-${Date.now()}`)
const TAGS_FILE = join(TEST_DIR, 'tags.json')

before(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  process.env._PC_TAGS_FILE = TAGS_FILE
})

beforeEach(() => {
  if (existsSync(TAGS_FILE)) unlinkSync(TAGS_FILE)
})

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  delete process.env._PC_TAGS_FILE
})

test('getSessionTags returns [] for unknown session', async () => {
  const { getSessionTags } = await import('../tags.ts')
  const result = getSessionTags('nonexistent-session')
  assert.deepEqual(result, [])
})

test('setSessionTags stores tags and getSessionTags retrieves them', async () => {
  const { setSessionTags, getSessionTags } = await import('../tags.ts')
  setSessionTags('session-1', ['bug', 'auth'])
  const result = getSessionTags('session-1')
  assert.deepEqual(result, ['bug', 'auth'])
})

test('setSessionTags normalizes to lowercase and trims whitespace', async () => {
  const { setSessionTags, getSessionTags } = await import('../tags.ts')
  setSessionTags('session-1', ['  BUG  ', 'Auth', ' FEATURE'])
  const result = getSessionTags('session-1')
  assert.deepEqual(result, ['bug', 'auth', 'feature'])
})

test('setSessionTags with empty array removes the session entry', async () => {
  const { setSessionTags, getSessionTags } = await import('../tags.ts')
  setSessionTags('session-1', ['bug'])
  setSessionTags('session-1', [])
  const result = getSessionTags('session-1')
  assert.deepEqual(result, [])
})

test('addSessionTag adds a new tag', async () => {
  const { setSessionTags, addSessionTag, getSessionTags } = await import('../tags.ts')
  setSessionTags('session-1', ['bug'])
  addSessionTag('session-1', 'feature')
  const result = getSessionTags('session-1')
  assert.deepEqual(result, ['bug', 'feature'])
})

test('addSessionTag is a no-op if tag already exists', async () => {
  const { setSessionTags, addSessionTag, getSessionTags } = await import('../tags.ts')
  setSessionTags('session-1', ['bug', 'auth'])
  addSessionTag('session-1', 'bug')
  const result = getSessionTags('session-1')
  assert.deepEqual(result, ['bug', 'auth'])
})

test('removeSessionTag removes a tag', async () => {
  const { setSessionTags, removeSessionTag, getSessionTags } = await import('../tags.ts')
  setSessionTags('session-1', ['bug', 'auth', 'feature'])
  removeSessionTag('session-1', 'auth')
  const result = getSessionTags('session-1')
  assert.deepEqual(result, ['bug', 'feature'])
})

test('removeSessionTag is a no-op if tag does not exist', async () => {
  const { setSessionTags, removeSessionTag, getSessionTags } = await import('../tags.ts')
  setSessionTags('session-1', ['bug', 'auth'])
  removeSessionTag('session-1', 'nonexistent')
  const result = getSessionTags('session-1')
  assert.deepEqual(result, ['bug', 'auth'])
})

test('deleteSessionTags removes all tags for a session but leaves others intact', async () => {
  const { setSessionTags, deleteSessionTags, getSessionTags } = await import('../tags.ts')
  setSessionTags('session-1', ['bug', 'auth'])
  setSessionTags('session-2', ['feature'])
  deleteSessionTags('session-1')
  assert.deepEqual(getSessionTags('session-1'), [])
  assert.deepEqual(getSessionTags('session-2'), ['feature'])
})

test('getAllTags returns all unique tags sorted alphabetically', async () => {
  const { setSessionTags, getAllTags } = await import('../tags.ts')
  setSessionTags('session-1', ['bug', 'auth'])
  setSessionTags('session-2', ['feature', 'bug'])
  setSessionTags('session-3', ['auth', 'refactor'])
  const result = getAllTags()
  assert.deepEqual(result, ['auth', 'bug', 'feature', 'refactor'])
})

test('getSessionsWithTag returns session IDs with that tag', async () => {
  const { setSessionTags, getSessionsWithTag } = await import('../tags.ts')
  setSessionTags('session-1', ['bug', 'auth'])
  setSessionTags('session-2', ['feature'])
  setSessionTags('session-3', ['bug'])
  const result = getSessionsWithTag('bug')
  assert.deepEqual(result.sort(), ['session-1', 'session-3'])
})

test('getSessionsWithTag is case-insensitive (finds "Bug" when stored as "bug")', async () => {
  const { setSessionTags, getSessionsWithTag } = await import('../tags.ts')
  setSessionTags('session-1', ['bug'])
  setSessionTags('session-2', ['feature'])
  const result = getSessionsWithTag('Bug')
  assert.deepEqual(result, ['session-1'])
})
