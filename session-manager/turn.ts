import { readFileSync, writeFileSync, unlinkSync, mkdirSync, openSync, closeSync } from 'node:fs'
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

// Atomically creates the lock file via O_CREAT|O_EXCL so only one process wins
// when multiple callers race simultaneously. Returns true if this process won.
function tryAtomicCreate(): boolean {
  try {
    mkdirSync(dirname(TURN_FILE), { recursive: true })
    const fd = openSync(TURN_FILE, 'wx') // fails if file already exists
    closeSync(fd)
    return true
  } catch {
    return false
  }
}

export type ClaimResult =
  | { ok: true }
  | { ok: false; holder: string; holder_name: string; wait_min: number }

export function claimTurn(callerId: string, displayName = 'unknown'): ClaimResult {
  const lock = readLock()

  if (lock) {
    const expired = Date.now() > new Date(lock.expires_at).getTime()
    if (!expired) {
      if (lock.holder === callerId) {
        // We already own the lock — just refresh the expiry
        writeLock({
          ...lock,
          holder_name: displayName,
          expires_at: new Date(Date.now() + TURN_TTL_MS).toISOString(),
        })
        return { ok: true }
      }
      const waitMin = Math.ceil((new Date(lock.expires_at).getTime() - Date.now()) / 60_000)
      return { ok: false, holder: lock.holder, holder_name: lock.holder_name, wait_min: waitMin }
    }
    // Expired: remove before atomic create. If two processes race here, only
    // one wins the tryAtomicCreate below — the other returns a safe failure.
    clearLock()
  }

  if (!tryAtomicCreate()) {
    // Lost the race — another process just claimed the slot
    const winner = readLock()
    if (winner) {
      const waitMin = Math.max(1, Math.ceil((new Date(winner.expires_at).getTime() - Date.now()) / 60_000))
      return { ok: false, holder: winner.holder, holder_name: winner.holder_name, wait_min: waitMin }
    }
    // winner is null: lock was released in the instant between our failed create
    // and our read (extremely rare). Return a conservative transient failure.
    return { ok: false, holder: 'unknown', holder_name: 'another user', wait_min: 1 }
  }

  // We won the slot. If writeLock fails (e.g. disk full), release the empty
  // placeholder so it doesn't block all future claims permanently.
  try {
    writeLock({
      holder: callerId,
      holder_name: displayName,
      claimed_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + TURN_TTL_MS).toISOString(),
    })
  } catch (err) {
    clearLock()
    throw err
  }
  return { ok: true }
}

export function releaseTurn(callerId: string): void {
  const lock = readLock()
  if (!lock) return
  const expired = Date.now() > new Date(lock.expires_at).getTime()
  if (lock.holder === callerId || expired) clearLock()
}

// Pure read — does not modify the lock file. Cleanup of expired locks happens
// lazily inside claimTurn so this function has no observable side effects.
export function getTurnStatus(): TurnLock | null {
  const lock = readLock()
  if (!lock) return null
  if (Date.now() > new Date(lock.expires_at).getTime()) return null
  return lock
}
