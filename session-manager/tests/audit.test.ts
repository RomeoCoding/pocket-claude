import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), `audit-test-${Date.now()}`)
const AUDIT_FILE = join(TEST_DIR, 'audit.jsonl')

before(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  process.env._PC_AUDIT_FILE = AUDIT_FILE
})

beforeEach(() => {
  if (existsSync(AUDIT_FILE)) unlinkSync(AUDIT_FILE)
})

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  delete process.env._PC_AUDIT_FILE
})

test('logAudit creates the file and appends an entry with correct fields', async () => {
  const { logAudit, readAuditLog } = await import('../audit.ts')
  logAudit({ caller_id: '123', caller_name: 'Romeo', tool: 'list_sessions', args_summary: 'limit=50' })
  assert.ok(existsSync(AUDIT_FILE), 'audit file should be created')
  const entries = readAuditLog()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].caller_id, '123')
  assert.equal(entries[0].caller_name, 'Romeo')
  assert.equal(entries[0].tool, 'list_sessions')
  assert.equal(entries[0].args_summary, 'limit=50')
  assert.ok(entries[0].ts, 'ts should be set automatically')
  // Verify ts is a valid ISO 8601 date
  assert.ok(!isNaN(Date.parse(entries[0].ts)), 'ts should be a valid ISO date')
})

test('logAudit appends multiple entries and file grows', async () => {
  const { logAudit, readAuditLog } = await import('../audit.ts')
  logAudit({ caller_id: '1', caller_name: 'Alice', tool: 'get_session', args_summary: 'id=abc' })
  logAudit({ caller_id: '2', caller_name: 'Bob', tool: 'list_sessions', args_summary: 'limit=10' })
  logAudit({ caller_id: '3', caller_name: 'Carol', tool: 'delete_session', args_summary: 'id=xyz' })
  const entries = readAuditLog()
  assert.equal(entries.length, 3)
})

test('readAuditLog returns entries newest-first', async () => {
  const { logAudit, readAuditLog } = await import('../audit.ts')
  logAudit({ caller_id: '1', caller_name: 'First', tool: 'tool_a', args_summary: '' })
  logAudit({ caller_id: '2', caller_name: 'Second', tool: 'tool_b', args_summary: '' })
  logAudit({ caller_id: '3', caller_name: 'Third', tool: 'tool_c', args_summary: '' })
  const entries = readAuditLog()
  // Newest-first: Third, Second, First
  assert.equal(entries[0].caller_name, 'Third')
  assert.equal(entries[1].caller_name, 'Second')
  assert.equal(entries[2].caller_name, 'First')
})

test('readAuditLog respects the limit param', async () => {
  const { logAudit, readAuditLog } = await import('../audit.ts')
  for (let i = 1; i <= 5; i++) {
    logAudit({ caller_id: String(i), caller_name: `User${i}`, tool: 'tool', args_summary: '' })
  }
  const entries = readAuditLog(2)
  assert.equal(entries.length, 2)
  // Should be the last 2 logged (5 and 4), returned newest-first
  assert.equal(entries[0].caller_id, '5')
  assert.equal(entries[1].caller_id, '4')
})

test('readAuditLog returns [] when file is missing', async () => {
  const { readAuditLog } = await import('../audit.ts')
  // beforeEach ensures file doesn't exist
  const entries = readAuditLog()
  assert.deepEqual(entries, [])
})

test('readAuditLog skips malformed lines without crashing', async () => {
  const { logAudit, readAuditLog } = await import('../audit.ts')
  const { appendFileSync } = await import('node:fs')
  logAudit({ caller_id: '1', caller_name: 'Good', tool: 'tool_a', args_summary: '' })
  appendFileSync(AUDIT_FILE, 'THIS IS NOT JSON\n')
  logAudit({ caller_id: '2', caller_name: 'Also Good', tool: 'tool_b', args_summary: '' })
  const entries = readAuditLog()
  // Only 2 valid entries should be returned
  assert.equal(entries.length, 2)
  assert.equal(entries[0].caller_name, 'Also Good')
  assert.equal(entries[1].caller_name, 'Good')
})

test('formatAuditLog returns (no audit entries) for empty array', async () => {
  const { formatAuditLog } = await import('../audit.ts')
  assert.equal(formatAuditLog([]), '(no audit entries)')
})

test('formatAuditLog formats a real entry correctly', async () => {
  const { logAudit, readAuditLog, formatAuditLog } = await import('../audit.ts')
  logAudit({ caller_id: '123', caller_name: 'Romeo', tool: 'list_sessions', args_summary: 'limit=50' })
  const entries = readAuditLog()
  const formatted = formatAuditLog(entries)
  assert.ok(formatted.includes('Romeo'), 'should contain caller name')
  assert.ok(formatted.includes('123'), 'should contain caller id')
  assert.ok(formatted.includes('list_sessions'), 'should contain tool name')
  assert.ok(formatted.includes('limit=50'), 'should contain args summary')
  assert.ok(formatted.includes('UTC'), 'should contain UTC marker')
  // Check format: [YYYY-MM-DD HH:mm:ss UTC] Name (id) → tool(args)
  assert.match(formatted, /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC\]/)
})
