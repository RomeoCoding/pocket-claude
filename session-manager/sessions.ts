import { readdir, stat, open, unlink, readFile, writeFile } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type Session = {
  id: string
  title: string
  updatedAt: Date
  projectPath: string
  pinned: boolean
}

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const PINNED_FILE = join(homedir(), '.pocket-claude', 'pinned.json')
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id)
}

function getPinnedIds(): string[] {
  try {
    return JSON.parse(readFileSync(PINNED_FILE, 'utf8'))
  } catch {
    return []
  }
}

async function savePinnedIds(ids: string[]): Promise<void> {
  await writeFile(PINNED_FILE, JSON.stringify(ids), { mode: 0o600 })
}

export async function pinSession(sessionId: string): Promise<void> {
  const ids = getPinnedIds()
  if (!ids.includes(sessionId)) ids.unshift(sessionId)
  await savePinnedIds(ids)
}

export async function unpinSession(sessionId: string): Promise<void> {
  await savePinnedIds(getPinnedIds().filter(id => id !== sessionId))
}

// Read only the first N bytes — avoids OOM on large session files (can be 10MB+)
async function readHead(filePath: string, bytes = 8192): Promise<{ text: string; truncated: boolean }> {
  const fh = await open(filePath, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    const { size } = await fh.stat()
    return { text: buf.slice(0, bytesRead).toString('utf8'), truncated: size > bytes }
  } finally {
    await fh.close()
  }
}

// Read only the last N bytes — for preview (recent messages)
async function readTail(filePath: string, bytes = 16384): Promise<string> {
  const fh = await open(filePath, 'r')
  try {
    const { size } = await fh.stat()
    const offset = Math.max(0, size - bytes)
    const readLen = Math.min(bytes, size)
    const buf = Buffer.alloc(readLen)
    const { bytesRead } = await fh.read(buf, 0, readLen, offset)
    return buf.slice(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

function extractTitle(text: string, truncated: boolean): string {
  const allLines = text.split('\n').filter(Boolean)
  const lines = truncated ? allLines.slice(0, -1) : allLines
  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      if (entry.type !== 'user') continue
      const content = entry.message?.content
      if (typeof content === 'string') {
        const t = content.trim().replace(/\n+/g, ' ')
        if (t) return t.length > 60 ? t.slice(0, 57) + '…' : t
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            const t = block.text.trim().replace(/\n+/g, ' ')
            if (t) return t.length > 60 ? t.slice(0, 57) + '…' : t
          }
        }
      }
    } catch { /* malformed line */ }
  }
  return '(untitled)'
}

export async function listSessions(limit = 50): Promise<Session[]> {
  const pinnedIds = getPinnedIds()
  const pinnedSet = new Set(pinnedIds)
  const sessions: Session[] = []

  let projectDirs: string[]
  try {
    projectDirs = await readdir(PROJECTS_DIR)
  } catch {
    return []
  }

  for (const projectDir of projectDirs) {
    const projectPath = join(PROJECTS_DIR, projectDir)
    let files: string[]
    try {
      files = await readdir(projectPath)
    } catch { continue }

    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const id = file.slice(0, -6)
      if (!isValidSessionId(id)) continue
      const filePath = join(projectPath, file)
      try {
        const [fileStat, { text, truncated }] = await Promise.all([
          stat(filePath),
          readHead(filePath, 8192),
        ])
        if (!text.trim()) continue
        sessions.push({
          id,
          title: extractTitle(text, truncated),
          updatedAt: fileStat.mtime,
          projectPath: decodeURIComponent(projectDir.replace(/^[^-]+-/, '')),
          pinned: pinnedSet.has(id),
        })
      } catch { continue }
    }
  }

  const byRecency = sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
  // Pinned sessions surface first in their pinned order, then the rest by recency
  const pinned = pinnedIds.map(id => byRecency.find(s => s.id === id)).filter((s): s is Session => !!s)
  const rest = byRecency.filter(s => !pinnedSet.has(s.id))
  return [...pinned, ...rest].slice(0, limit)
}

export async function findSessionFile(sessionId: string): Promise<string | null> {
  let projectDirs: string[]
  try {
    projectDirs = await readdir(PROJECTS_DIR)
  } catch { return null }
  for (const projectDir of projectDirs) {
    const candidate = join(PROJECTS_DIR, projectDir, `${sessionId}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

export async function deleteSession(sessionId: string): Promise<void> {
  const filePath = await findSessionFile(sessionId)
  if (!filePath) throw new Error('Session file not found')
  await unlink(filePath)
  await savePinnedIds(getPinnedIds().filter(id => id !== sessionId))
}

export async function deleteOldSessions(daysOld: number): Promise<number> {
  const sessions = await listSessions(200)
  const cutoff = Date.now() - daysOld * 24 * 60 * 60 * 1000
  let count = 0
  for (const session of sessions) {
    if (session.updatedAt.getTime() < cutoff) {
      try { await deleteSession(session.id); count++ } catch { /* skip */ }
    }
  }
  return count
}

export async function searchSessions(query: string, limit = 10): Promise<Session[]> {
  const all = await listSessions(100)
  const q = query.toLowerCase()

  // Title matches first (instant)
  const titleMatches = all.filter(s => s.title.toLowerCase().includes(q))
  if (titleMatches.length >= limit) return titleMatches.slice(0, limit)

  // Then scan content of remaining sessions (first 16KB each)
  const titleMatchIds = new Set(titleMatches.map(s => s.id))
  const contentMatches: Session[] = []
  for (const session of all.filter(s => !titleMatchIds.has(s.id))) {
    if (titleMatches.length + contentMatches.length >= limit) break
    try {
      const filePath = await findSessionFile(session.id)
      if (!filePath) continue
      const { text } = await readHead(filePath, 16384)
      if (text.toLowerCase().includes(q)) contentMatches.push(session)
    } catch { /* skip */ }
  }

  return [...titleMatches, ...contentMatches].slice(0, limit)
}

export async function getSessionPreview(sessionId: string, messageCount = 3): Promise<string> {
  const filePath = await findSessionFile(sessionId)
  if (!filePath) return '(session file not found)'

  const tail = await readTail(filePath, 16384)
  const allLines = tail.split('\n').filter(Boolean)
  const lines = allLines.length > 1 ? allLines.slice(1) : allLines

  const messages: Array<{ role: string; text: string }> = []
  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      const role = entry.type === 'user' ? 'You' : entry.type === 'assistant' ? 'Claude' : null
      if (!role) continue
      const content = entry.message?.content
      let text = ''
      if (typeof content === 'string') text = content.trim()
      else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') { text = (block.text ?? '').trim(); break }
        }
      }
      if (text) messages.push({ role, text })
    } catch { /* skip */ }
  }

  const last = messages.slice(-(messageCount * 2))
  if (last.length === 0) return '(no readable messages)'
  return last.map(m => `${m.role}: ${m.text.length > 200 ? m.text.slice(0, 200) + '…' : m.text}`).join('\n\n')
}

export function formatSessionList(sessions: Session[]): string {
  if (sessions.length === 0) return 'No sessions found.'
  return sessions
    .map((s, i) => {
      const age = formatAge(s.updatedAt)
      const pin = s.pinned ? '[P] ' : ''
      return `${i + 1}. ${pin}[${age}] ${s.title}  (${s.projectPath})`
    })
    .join('\n')
}

// Async — reads up to N lines from log files without blocking the event loop
export async function getLocalLogs(lines = 30): Promise<string> {
  const logFile = join(homedir(), '.pocket-claude', 'start.log')
  const wdLog = join(homedir(), '.pocket-claude', 'watchdog.log')
  const out: string[] = []
  for (const f of [logFile, wdLog]) {
    try {
      const content = await readFile(f, 'utf8')
      const all = content.trim().split('\n').filter(Boolean)
      // Take up to `lines` entries from each file that has content
      const take = all.slice(-lines)
      if (take.length) out.push(`--- ${f.split('/').pop()} ---`, ...take)
    } catch { /* log file missing */ }
  }
  return out.length ? out.join('\n') : '(no local logs found)'
}

function formatAge(date: Date): string {
  const diffMs = Date.now() - date.getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
