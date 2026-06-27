import { readdir, stat, open } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type Session = {
  id: string
  title: string
  updatedAt: Date
  projectPath: string
}

const PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id)
}

// Read only the first N bytes — avoids OOM on large session files (can be 10MB+)
async function readHead(filePath: string, bytes = 8192): Promise<{ text: string; truncated: boolean }> {
  const fh = await open(filePath, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    const text = buf.slice(0, bytesRead).toString('utf8')
    const { size } = await fh.stat()
    return { text, truncated: size > bytes }
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
  // If truncated, last line may be partial JSON — skip it
  const lines = truncated ? allLines.slice(0, -1) : allLines

  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      if (entry.type !== 'user') continue
      const content = entry.message?.content
      if (typeof content === 'string') {
        const text = content.trim().replace(/\n+/g, ' ')
        if (text) return text.length > 60 ? text.slice(0, 57) + '…' : text
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            const text = block.text.trim().replace(/\n+/g, ' ')
            if (text) return text.length > 60 ? text.slice(0, 57) + '…' : text
          }
        }
      }
    } catch {
      // malformed line — skip
    }
  }
  return '(untitled)'
}

export async function listSessions(limit = 20): Promise<Session[]> {
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
    } catch {
      continue
    }

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
        })
      } catch {
        continue
      }
    }
  }

  return sessions
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    .slice(0, limit)
}

export async function findSessionFile(sessionId: string): Promise<string | null> {
  let projectDirs: string[]
  try {
    projectDirs = await readdir(PROJECTS_DIR)
  } catch {
    return null
  }
  for (const projectDir of projectDirs) {
    const candidate = join(PROJECTS_DIR, projectDir, `${sessionId}.jsonl`)
    try {
      await stat(candidate)
      return candidate
    } catch {
      // not in this project dir
    }
  }
  return null
}

export async function getSessionPreview(sessionId: string, messageCount = 3): Promise<string> {
  const filePath = await findSessionFile(sessionId)
  if (!filePath) return '(session file not found)'

  const tail = await readTail(filePath, 16384)
  const allLines = tail.split('\n').filter(Boolean)
  // Drop first line — may be truncated
  const lines = allLines.length > 1 ? allLines.slice(1) : allLines

  const messages: Array<{ role: string; text: string }> = []
  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      const role = entry.type === 'user' ? 'You' : entry.type === 'assistant' ? 'Claude' : null
      if (!role) continue
      const content = entry.message?.content
      let text = ''
      if (typeof content === 'string') {
        text = content.trim()
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') { text = (block.text ?? '').trim(); break }
        }
      }
      if (text) messages.push({ role, text })
    } catch {
      // skip malformed
    }
  }

  const last = messages.slice(-(messageCount * 2))
  if (last.length === 0) return '(no readable messages)'
  return last
    .map(m => `${m.role}: ${m.text.length > 200 ? m.text.slice(0, 200) + '…' : m.text}`)
    .join('\n\n')
}

export function formatSessionList(sessions: Session[], total?: number): string {
  if (sessions.length === 0) return 'No sessions found.'
  const header = total && total > sessions.length
    ? `Showing ${sessions.length} of ${total} sessions:\n`
    : ''
  return header + sessions
    .map((s, i) => {
      const age = formatAge(s.updatedAt)
      return `${i + 1}. [${age}] ${s.title}  (${s.projectPath})`
    })
    .join('\n')
}

export function getLocalLogs(lines = 30): string {
  const logFile = join(homedir(), '.pocket-claude', 'start.log')
  const wdLog = join(homedir(), '.pocket-claude', 'watchdog.log')
  const out: string[] = []
  for (const f of [logFile, wdLog]) {
    try {
      const content = readFileSync(f, 'utf8')
      const last = content.trim().split('\n').filter(Boolean).slice(-Math.floor(lines / 2))
      if (last.length) out.push(`--- ${f.split('/').pop()} ---`, ...last)
    } catch {
      // log file missing
    }
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
