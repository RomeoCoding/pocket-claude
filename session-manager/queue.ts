import { readFileSync, writeFileSync, existsSync, appendFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export type TaskStatus = 'pending' | 'in_progress' | 'done'
export type TaskPriority = 'high' | 'normal'

export type Task = {
  id: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  queued_by: string
  queued_at: string
  completed_at: string | null
  note: string | null
}

const QUEUE_FILE =
  process.env._PC_QUEUE_FILE ?? join(homedir(), '.pocket-claude', 'queue.jsonl')

function readAllTasks(): Task[] {
  if (!existsSync(QUEUE_FILE)) return []
  return readFileSync(QUEUE_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try { return [JSON.parse(line) as Task] } catch { return [] }
    })
}

function writeAllTasks(tasks: Task[]): void {
  mkdirSync(dirname(QUEUE_FILE), { recursive: true })
  // Write via tmp+rename so a crash mid-write never leaves a partially-written file
  const tmp = `${QUEUE_FILE}.tmp.${process.pid}`
  writeFileSync(tmp, tasks.map(t => JSON.stringify(t)).join('\n') + '\n', { mode: 0o600 })
  renameSync(tmp, QUEUE_FILE)
}

export function queueTask(
  description: string,
  priority: TaskPriority = 'normal',
  queuedBy = 'unknown',
): Task {
  const task: Task = {
    id: randomUUID(),
    description,
    status: 'pending',
    priority,
    queued_by: queuedBy,
    queued_at: new Date().toISOString(),
    completed_at: null,
    note: null,
  }
  // appendFileSync is atomic for small payloads on Linux — safe to use for enqueue
  appendFileSync(QUEUE_FILE, JSON.stringify(task) + '\n', { mode: 0o600 })
  return task
}

export function listQueue(): Task[] {
  return readAllTasks().sort((a, b) => {
    // High priority first, then by queue order (oldest first)
    if (a.priority !== b.priority) return a.priority === 'high' ? -1 : 1
    return new Date(a.queued_at).getTime() - new Date(b.queued_at).getTime()
  })
}

export function completeTask(taskId: string, note?: string): Task | null {
  const tasks = readAllTasks()
  const idx = tasks.findIndex(t => t.id === taskId)
  if (idx === -1) return null
  tasks[idx] = {
    ...tasks[idx],
    status: 'done',
    completed_at: new Date().toISOString(),
    note: note ?? null,
  }
  writeAllTasks(tasks)
  return tasks[idx]
}

export function getTask(taskId: string): Task | null {
  return readAllTasks().find(t => t.id === taskId) ?? null
}

export function formatQueue(tasks: Task[]): string {
  if (tasks.length === 0) return '(queue is empty)'
  const statusEmoji = (s: TaskStatus) =>
    s === 'done' ? '✅' : s === 'in_progress' ? '🔄' : '⏳'
  const priorityTag = (p: TaskPriority) => p === 'high' ? ' 🔴' : ''
  return tasks
    .map((t, i) => {
      const age = Math.floor((Date.now() - new Date(t.queued_at).getTime()) / 60_000)
      const ageStr = age < 60 ? `${age}m` : `${Math.floor(age / 60)}h`
      return `${i + 1}. ${statusEmoji(t.status)}${priorityTag(t.priority)} ${t.description} [${ageStr} ago, by ${t.queued_by}]${t.note ? `\n   → ${t.note}` : ''}`
    })
    .join('\n')
}
