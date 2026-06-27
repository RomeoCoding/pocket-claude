import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'

type UserRecord = { first_seen: string; welcomed: boolean }
type SeenUsers = Record<string, UserRecord>

const SEEN_FILE =
  process.env._PC_SEEN_FILE ?? join(homedir(), '.pocket-claude', 'seen_users.json')

function read(): SeenUsers {
  try { return JSON.parse(readFileSync(SEEN_FILE, 'utf8')) } catch { return {} }
}

function write(data: SeenUsers): void {
  mkdirSync(dirname(SEEN_FILE), { recursive: true })
  writeFileSync(SEEN_FILE, JSON.stringify(data, null, 2), { mode: 0o600 })
}

// Returns true if this user has not been welcomed yet.
export function checkAndRecord(userId: string): { needsWelcome: boolean } {
  const data = read()
  if (!data[userId]) {
    data[userId] = { first_seen: new Date().toISOString(), welcomed: false }
    write(data)
    return { needsWelcome: true }
  }
  return { needsWelcome: !data[userId].welcomed }
}

export function markWelcomed(userId: string): void {
  const data = read()
  if (data[userId]) {
    data[userId].welcomed = true
    write(data)
  }
}
