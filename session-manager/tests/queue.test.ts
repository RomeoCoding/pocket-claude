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

test('queueTask with run_after stores the field correctly', async () => {
  const { queueTask, getTask } = await import('../queue.ts')
  const runAfter = new Date(Date.now() + 60_000).toISOString()
  const task = queueTask('future task', 'normal', 'u1', runAfter)
  assert.equal(task.run_after, runAfter)
  const found = getTask(task.id)
  assert.equal(found!.run_after, runAfter)
})

test('listDueTasks returns tasks with run_after in the past', async () => {
  const { queueTask, listDueTasks } = await import('../queue.ts')
  const pastTime = new Date(Date.now() - 60_000).toISOString()
  queueTask('past task', 'normal', 'u1', pastTime)
  const due = listDueTasks()
  assert.equal(due.length, 1)
  assert.equal(due[0].description, 'past task')
})

test('listDueTasks does not return tasks with future run_after', async () => {
  const { queueTask, listDueTasks } = await import('../queue.ts')
  const futureTime = new Date(Date.now() + 60_000).toISOString()
  queueTask('future task', 'normal', 'u1', futureTime)
  const due = listDueTasks()
  assert.equal(due.length, 0)
})

test('listDueTasks does not return already-notified tasks', async () => {
  const { queueTask, listDueTasks, markTaskNotified } = await import('../queue.ts')
  const pastTime = new Date(Date.now() - 60_000).toISOString()
  const task = queueTask('already notified', 'normal', 'u1', pastTime)
  markTaskNotified(task.id)
  const due = listDueTasks()
  assert.equal(due.length, 0)
})

test('listDueTasks returns tasks with no run_after set', async () => {
  const { queueTask, listDueTasks } = await import('../queue.ts')
  queueTask('immediate task', 'normal', 'u1')
  const due = listDueTasks()
  assert.equal(due.length, 1)
  assert.equal(due[0].description, 'immediate task')
})

test('markTaskNotified sets notified_at on the correct task', async () => {
  const { queueTask, markTaskNotified, getTask } = await import('../queue.ts')
  const task = queueTask('to be notified', 'normal', 'u1')
  assert.equal(task.notified_at, undefined)
  markTaskNotified(task.id)
  const found = getTask(task.id)
  assert.ok(found!.notified_at !== undefined)
  assert.ok(new Date(found!.notified_at!).getTime() <= Date.now())
})

test('formatQueue shows [⏰ DUE] for overdue tasks', async () => {
  const { queueTask, formatQueue } = await import('../queue.ts')
  const pastTime = new Date(Date.now() - 60_000).toISOString()
  const task = queueTask('overdue task', 'normal', 'u1', pastTime)
  const output = formatQueue([task])
  assert.ok(output.includes('[⏰ DUE]'))
})

test('formatQueue shows [scheduled: HH:MM UTC] for future tasks', async () => {
  const { queueTask, formatQueue } = await import('../queue.ts')
  const futureTime = new Date(Date.now() + 3_600_000).toISOString()
  const task = queueTask('future task', 'normal', 'u1', futureTime)
  const output = formatQueue([task])
  assert.ok(output.includes('[scheduled:'))
  assert.ok(output.includes('UTC]'))
})
