import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), `queue-test-${Date.now()}`)
const QUEUE_FILE = join(TEST_DIR, 'queue.jsonl')

before(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  process.env._PC_QUEUE_FILE = QUEUE_FILE
})

beforeEach(() => {
  if (existsSync(QUEUE_FILE)) unlinkSync(QUEUE_FILE)
})

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  delete process.env._PC_QUEUE_FILE
})

test('queueTask creates a task with correct fields', async () => {
  const { queueTask } = await import('../queue.ts')
  const task = queueTask('fix the login bug', 'high', '12345')
  assert.equal(task.description, 'fix the login bug')
  assert.equal(task.priority, 'high')
  assert.equal(task.queued_by, '12345')
  assert.equal(task.status, 'pending')
  assert.ok(task.id.length > 0)
  assert.equal(task.completed_at, null)
  assert.equal(task.note, null)
})

test('listQueue returns tasks sorted high priority first', async () => {
  const { queueTask, listQueue } = await import('../queue.ts')
  queueTask('normal task', 'normal', 'u1')
  queueTask('urgent task', 'high', 'u1')
  const tasks = listQueue()
  assert.equal(tasks[0].priority, 'high')
  assert.equal(tasks[1].priority, 'normal')
})

test('completeTask marks task done and sets note', async () => {
  const { queueTask, completeTask } = await import('../queue.ts')
  const task = queueTask('write tests', 'normal', 'u1')
  const done = completeTask(task.id, '42 tests written')
  assert.ok(done !== null)
  assert.equal(done!.status, 'done')
  assert.equal(done!.note, '42 tests written')
  assert.ok(done!.completed_at !== null)
})

test('completeTask returns null for unknown id', async () => {
  const { completeTask } = await import('../queue.ts')
  assert.equal(completeTask('nonexistent-id'), null)
})

test('getTask finds task by id', async () => {
  const { queueTask, getTask } = await import('../queue.ts')
  const task = queueTask('find me', 'normal', 'u1')
  const found = getTask(task.id)
  assert.ok(found !== null)
  assert.equal(found!.description, 'find me')
})

test('listQueue returns empty array when queue is empty', async () => {
  const { listQueue } = await import('../queue.ts')
  assert.deepEqual(listQueue(), [])
})

test('formatQueue returns empty message for empty list', async () => {
  const { formatQueue } = await import('../queue.ts')
  assert.equal(formatQueue([]), '(queue is empty)')
})
