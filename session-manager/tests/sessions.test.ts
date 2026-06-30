import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// sessions.ts reads PROJECTS_DIR and PINNED_FILE at module evaluation time.
// We set the env vars before any import so the module picks up test paths.
// NOTE: Node ESM module cache means the env vars must be set in `before()`,
// which runs before the first dynamic import in any test.

const TEST_DIR = join(tmpdir(), `sessions-test-${Date.now()}`)
const PROJECTS_DIR = join(TEST_DIR, 'projects')
const PINNED_FILE = join(TEST_DIR, 'pinned.json')

// Valid UUID v4s for test sessions
const SESSION_A = '550e8400-e29b-41d4-a716-446655440000'
const SESSION_B = '6ba7b810-9dad-41d1-80b4-00c04fd430c8'
const SESSION_C = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

function makeSession(
  project: string,
  id: string,
  messages: Array<{ type: string; content: string }>,
): string {
  const dir = join(PROJECTS_DIR, project)
  mkdirSync(dir, { recursive: true })
  const lines = messages.map(m =>
    JSON.stringify({ type: m.type, message: { content: m.content } })
  )
  const filePath = join(dir, `${id}.jsonl`)
  writeFileSync(filePath, lines.join('\n') + '\n', { mode: 0o600 })
  return filePath
}

before(() => {
  mkdirSync(PROJECTS_DIR, { recursive: true })
  process.env._PC_PROJECTS_DIR = PROJECTS_DIR
  process.env._PC_PINNED_FILE = PINNED_FILE
})

beforeEach(() => {
  rmSync(PROJECTS_DIR, { recursive: true, force: true })
  rmSync(PINNED_FILE, { force: true })
  mkdirSync(PROJECTS_DIR, { recursive: true })
})

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  delete process.env._PC_PROJECTS_DIR
  delete process.env._PC_PINNED_FILE
})

test('listSessions returns empty array when no sessions exist', async () => {
  const { listSessions } = await import('../sessions.ts')
  assert.deepEqual(await listSessions(), [])
})

test('listSessions returns all sessions', async () => {
  const { listSessions } = await import('../sessions.ts')
  makeSession('proj-a', SESSION_A, [{ type: 'user', content: 'Fix login bug' }])
  makeSession('proj-b', SESSION_B, [{ type: 'user', content: 'Add dark mode' }])
  const sessions = await listSessions()
  assert.equal(sessions.length, 2)
  const ids = sessions.map(s => s.id)
  assert.ok(ids.includes(SESSION_A))
  assert.ok(ids.includes(SESSION_B))
})

test('listSessions sorts pinned sessions first', async () => {
  const { listSessions, pinSession } = await import('../sessions.ts')
  const pathA = makeSession('proj-a', SESSION_A, [{ type: 'user', content: 'Alpha' }])
  makeSession('proj-b', SESSION_B, [{ type: 'user', content: 'Beta' }])
  // Make SESSION_A older so without pinning it would sort last
  const old = new Date(Date.now() - 60_000)
  utimesSync(pathA, old, old)
  await pinSession(SESSION_A)
  const sessions = await listSessions()
  assert.equal(sessions[0].id, SESSION_A)
  assert.ok(sessions[0].pinned)
})

test('listSessions extracts title from first user message', async () => {
  const { listSessions } = await import('../sessions.ts')
  makeSession('proj', SESSION_A, [{ type: 'user', content: 'Debug the payment flow' }])
  const sessions = await listSessions()
  assert.equal(sessions[0].title, 'Debug the payment flow')
})

test('listSessions truncates long titles with ellipsis when over 60 chars', async () => {
  const { listSessions } = await import('../sessions.ts')
  makeSession('proj', SESSION_A, [{ type: 'user', content: 'A'.repeat(80) }])
  const sessions = await listSessions()
  assert.ok(sessions[0].title.length <= 60)
  assert.ok(sessions[0].title.endsWith('…'))
})

test('listSessions skips files that are not UUID v4', async () => {
  const { listSessions } = await import('../sessions.ts')
  const dir = join(PROJECTS_DIR, 'proj')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'not-a-uuid.jsonl'), JSON.stringify({ type: 'user', message: { content: 'hi' } }))
  makeSession('proj', SESSION_A, [{ type: 'user', content: 'Valid session' }])
  const sessions = await listSessions()
  assert.equal(sessions.length, 1)
  assert.equal(sessions[0].id, SESSION_A)
})

test('findSessionFile locates a session by ID', async () => {
  const { findSessionFile } = await import('../sessions.ts')
  const created = makeSession('proj', SESSION_A, [{ type: 'user', content: 'Hello' }])
  const found = await findSessionFile(SESSION_A)
  assert.equal(found, created)
})

test('findSessionFile returns null for nonexistent session', async () => {
  const { findSessionFile } = await import('../sessions.ts')
  assert.equal(await findSessionFile(SESSION_B), null)
})

test('searchSessions finds sessions by title keyword', async () => {
  const { searchSessions } = await import('../sessions.ts')
  makeSession('proj-a', SESSION_A, [{ type: 'user', content: 'Fix the payment bug' }])
  makeSession('proj-b', SESSION_B, [{ type: 'user', content: 'Refactor auth module' }])
  const results = await searchSessions('payment')
  assert.equal(results.length, 1)
  assert.equal(results[0].id, SESSION_A)
})

test('searchSessions returns empty array when nothing matches', async () => {
  const { searchSessions } = await import('../sessions.ts')
  makeSession('proj', SESSION_A, [{ type: 'user', content: 'Hello world' }])
  assert.deepEqual(await searchSessions('xyzzy-no-match'), [])
})

test('searchSessions is case-insensitive', async () => {
  const { searchSessions } = await import('../sessions.ts')
  makeSession('proj', SESSION_A, [{ type: 'user', content: 'Fix Payment Bug' }])
  const results = await searchSessions('payment')
  assert.equal(results.length, 1)
})

test('deleteSession removes the file', async () => {
  const { deleteSession, findSessionFile } = await import('../sessions.ts')
  makeSession('proj', SESSION_A, [{ type: 'user', content: 'Hello' }])
  await deleteSession(SESSION_A)
  assert.equal(await findSessionFile(SESSION_A), null)
})

test('deleteSession unpins a deleted session', async () => {
  const { deleteSession, listSessions, pinSession } = await import('../sessions.ts')
  makeSession('proj', SESSION_A, [{ type: 'user', content: 'Hello' }])
  makeSession('proj', SESSION_B, [{ type: 'user', content: 'World' }])
  await pinSession(SESSION_A)
  await deleteSession(SESSION_A)
  const sessions = await listSessions()
  const ids = sessions.map(s => s.id)
  assert.ok(!ids.includes(SESSION_A))
  assert.ok(!sessions.some(s => s.pinned && s.id === SESSION_A))
})

test('deleteSession throws for nonexistent session', async () => {
  const { deleteSession } = await import('../sessions.ts')
  await assert.rejects(() => deleteSession(SESSION_C), /not found/)
})

test('getSessionPreview returns formatted messages', async () => {
  const { getSessionPreview } = await import('../sessions.ts')
  const filePath = makeSession('proj', SESSION_A, [
    { type: 'user', content: 'What is 2+2?' },
    { type: 'assistant', content: '4.' },
  ])
  const preview = await getSessionPreview(SESSION_A, 3, filePath)
  assert.ok(preview.includes('You:') || preview.includes('Claude:'))
  assert.ok(!preview.includes('(no readable messages)'))
})

test('getSessionPreview returns placeholder for nonexistent session', async () => {
  const { getSessionPreview } = await import('../sessions.ts')
  const preview = await getSessionPreview(SESSION_C, 3)
  assert.equal(preview, '(session file not found)')
})

test('pinSession and unpinSession round-trip correctly', async () => {
  const { pinSession, unpinSession, listSessions } = await import('../sessions.ts')
  makeSession('proj', SESSION_A, [{ type: 'user', content: 'Hello' }])
  await pinSession(SESSION_A)
  const pinned = await listSessions()
  assert.ok(pinned[0].pinned)
  await unpinSession(SESSION_A)
  const unpinned = await listSessions()
  assert.ok(!unpinned[0].pinned)
})
