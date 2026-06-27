import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type Session = {
  id: string
  title: string
  updatedAt: Date
  projectPath: string
}

// Claude Code stores sessions under ~/.claude/projects/<sanitized-cwd>/
// Each session is a JSONL file named <session-id>.jsonl
const PROJECTS_DIR = join(homedir(), '.claude', 'projects')

// Strict UUID v4 validation — session IDs from filesystem only, but validate anyway
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function isValidSessionId(id: string): boolean {
  return SESSION_ID_RE.test(id)
}

function extractTitle(lines: string[]): string {
  for (const line of lines) {
    try {
      const entry = JSON.parse(line)
      // First human turn is usually the session title
      if (entry.type === 'user' && typeof entry.message?.content === 'string') {
        const text = entry.message.content.trim().replace(/\n+/g, ' ')
        return text.length > 60 ? text.slice(0, 57) + '…' : text
      }
      if (Array.isArray(entry.message?.content)) {
        for (const block of entry.message.content) {
          if (block.type === 'text' && typeof block.text === 'string') {
            const text = block.text.trim().replace(/\n+/g, ' ')
            return text.length > 60 ? text.slice(0, 57) + '…' : text
          }
        }
      }
    } catch {
      // malformed line, skip
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
    return [] // no sessions yet
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
        const [fileStat, content] = await Promise.all([
          stat(filePath),
          readFile(filePath, 'utf8'),
        ])
        const lines = content.trim().split('\n').filter(Boolean)
        if (lines.length === 0) continue

        sessions.push({
          id,
          title: extractTitle(lines),
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

export function formatSessionList(sessions: Session[]): string {
  if (sessions.length === 0) return 'No sessions found.'
  return sessions
    .map((s, i) => {
      const age = formatAge(s.updatedAt)
      return `${i + 1}. [${age}] ${s.title}`
    })
    .join('\n')
}

function formatAge(date: Date): string {
  const diffMs = Date.now() - date.getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}
