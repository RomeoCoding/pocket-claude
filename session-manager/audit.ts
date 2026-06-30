import { appendFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export type AuditEntry = {
  ts: string           // ISO 8601, auto-set by logAudit
  caller_id: string
  caller_name: string
  tool: string
  args_summary: string
}

const AUDIT_FILE =
  process.env._PC_AUDIT_FILE ?? join(homedir(), '.pocket-claude', 'audit.jsonl')

// Append one entry to audit.jsonl (atomic appendFileSync for small payloads)
export function logAudit(entry: Omit<AuditEntry, 'ts'>): void {
  const full: AuditEntry = { ts: new Date().toISOString(), ...entry }
  mkdirSync(dirname(AUDIT_FILE), { recursive: true })
  appendFileSync(AUDIT_FILE, JSON.stringify(full) + '\n', { mode: 0o600 })
}

// Read last `limit` entries, returns most-recent-first
export function readAuditLog(limit?: number): AuditEntry[] {
  let raw: string
  try {
    raw = readFileSync(AUDIT_FILE, 'utf8')
  } catch {
    return []
  }

  const lines = raw.split('\n').filter(line => line.trim() !== '')
  const tail = limit !== undefined ? lines.slice(-limit) : lines

  const entries: AuditEntry[] = []
  for (const line of tail) {
    try {
      entries.push(JSON.parse(line) as AuditEntry)
    } catch {
      // skip malformed lines
    }
  }

  // Return newest-first
  return entries.reverse()
}

// Human-readable format: "[2026-06-28 10:00:00 UTC] Romeo (123) → list_sessions(limit=50)"
export function formatAuditLog(entries: AuditEntry[]): string {
  if (entries.length === 0) return '(no audit entries)'

  return entries.map(e => {
    const d = new Date(e.ts)
    const pad = (n: number) => String(n).padStart(2, '0')
    const datePart = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
    const timePart = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
    return `[${datePart} ${timePart} UTC] ${e.caller_name} (${e.caller_id}) → ${e.tool}(${e.args_summary})`
  }).join('\n')
}
