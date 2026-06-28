import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

type TurnLock = {
  holder: string
  holder_name: string
  claimed_at: string
  expires_at: string
}

const TURN_FILE = process.env._PC_TURN_FILE ?? join(homedir(), '.pocket-claude', 'turn.lock')
const TURN_TTL_MS = 10 * 60 * 1000

function readLock(): TurnLock | null {
  try { return JSON.parse(readFileSync(TURN_FILE, 'utf8')) } catch { return null }
}

function writeLock(lock: TurnLock): void {
  mkdirSync(dirname(TURN_FILE), { recursive: true })
  writeFileSync(TURN_FILE, JSON.stringify(lock, null, 2), { mode: 0o600 })
}

function clearLock(): void {
  try { unlinkSync(TURN_FILE) } catch { /* already gone */ }
}

export type ClaimResult =
  | { ok: true }
  | { ok: false; holder: string; holder_name: string; wait_min: number }

export function claimTurn(callerId: string, displayName = 'unknown'): ClaimResult {
  const lock = readLock()
  if (lock) {
    const expired = Date.now() > new Date(lock.expires_at).getTime()
    if (!expired && lock.holder !== callerId) {
      const waitMin = Math.ceil((new Date(lock.expires_at).getTime() - Date.now()) / 60_000)
      return { ok: false, holder: lock.holder, holder_name: lock.holder_name, wait_min: waitMin }
    }
  }
  // No lock, expired lock, or same caller extending their turn
  writeLock({
    holder: callerId,
    holder_name: displayName,
    claimed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + TURN_TTL_MS).toISOString(),
  })
  return { ok: true }
}

export function releaseTurn(callerId: string): void {
  const lock = readLock()
  if (!lock) return
  const expired = Date.now() > new Date(lock.expires_at).getTime()
  if (lock.holder === callerId || expired) clearLock()
}

export function getTurnStatus(): TurnLock | null {
  const lock = readLock()
  if (!lock) return null
  if (Date.now() > new Date(lock.expires_at).getTime()) {
    clearLock()
    return null
  }
  return lock
}
