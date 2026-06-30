import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export type Role = 'admin' | 'member'

const ACCESS_FILE =
  process.env._PC_ACCESS_FILE ?? join(homedir(), '.claude', 'channels', 'telegram', 'access.json')

function readAccess(): Record<string, unknown> {
  try { return JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) } catch { return {} }
}

function writeAccess(data: Record<string, unknown>): void {
  mkdirSync(dirname(ACCESS_FILE), { recursive: true })
  writeFileSync(ACCESS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 })
}

export function getUserRole(userId: string): Role {
  if (!userId) return 'member'
  const access = readAccess()
  const roles = (access.roles ?? {}) as Record<string, string>
  return roles[userId] === 'admin' ? 'admin' : 'member'
}

export function setUserRole(userId: string, role: Role): void {
  const access = readAccess()
  const roles = (access.roles ?? {}) as Record<string, string>
  roles[userId] = role
  writeAccess({ ...access, roles })
}

export function requireAdmin(callerId: string | undefined): { ok: true } | { ok: false; error: string } {
  if (!callerId) {
    return { ok: false, error: 'caller_id not provided. Claude should pass the Telegram chat_id as caller_id for this tool.' }
  }
  if (getUserRole(callerId) !== 'admin') {
    return { ok: false, error: 'This action requires admin role. Ask the pocket-claude owner to grant you access via set_user_role.' }
  }
  return { ok: true }
}
