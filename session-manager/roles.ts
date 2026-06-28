import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'

export type Role = 'admin' | 'member'

const ACCESS_FILE =
  process.env._PC_ACCESS_FILE ?? join(homedir(), '.pocket-claude', 'access.json')

// passthrough() preserves extra fields (allowFrom, groups) that other modules write
const AccessSchema = z.object({
  roles: z.record(z.enum(['admin', 'member'])).default({}),
}).passthrough()

type AccessData = z.infer<typeof AccessSchema>

// Constants so callers can assert exact error messages in tests
export const ERR_CALLER_ID_MISSING =
  'caller_id not provided. Claude should pass the Telegram chat_id as caller_id for this tool.'
export const ERR_ADMIN_REQUIRED =
  'This action requires admin role. Ask the pocket-claude owner to grant you access via set_user_role.'

function readAccess(): AccessData {
  try {
    const raw = JSON.parse(readFileSync(ACCESS_FILE, 'utf8'))
    return AccessSchema.parse(raw)
  } catch {
    return AccessSchema.parse({})
  }
}

function writeAccess(data: AccessData): void {
  mkdirSync(dirname(ACCESS_FILE), { recursive: true })
  writeFileSync(ACCESS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 })
}

export function getUserRole(userId: string): Role {
  if (!userId) return 'member'
  const access = readAccess()
  return access.roles[userId] === 'admin' ? 'admin' : 'member'
}

export function setUserRole(userId: string, role: Role): void {
  const access = readAccess()
  access.roles[userId] = role
  writeAccess(access)
}

export function requireAdmin(callerId: string | undefined): { ok: true } | { ok: false; error: string } {
  if (!callerId) {
    return { ok: false, error: ERR_CALLER_ID_MISSING }
  }
  if (getUserRole(callerId) !== 'admin') {
    return { ok: false, error: ERR_ADMIN_REQUIRED }
  }
  return { ok: true }
}
