#!/usr/bin/env node
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const STATE_DIR = join(homedir(), '.pocket-claude')
const ENV_FILE = process.env._PC_ENV_FILE ?? join(STATE_DIR, '.env')
const WATCHER_FILE = join(STATE_DIR, 'watcher.json')
const TMUX_TMPDIR = join(STATE_DIR, 'tmux')
const TMUX_SESSION = process.env.POCKET_CLAUDE_TMUX ?? 'pocket-claude'

const TG_API = (token: string, method: string) =>
  `https://api.telegram.org/bot${token}/${method}`

const MAX_MSG_LEN = 4096
const MAX_PANE_CHARS = 3800
const PANE_LINES = 30
const DEFAULT_INTERVAL_SECS = 10
const MIN_INTERVAL_SECS = 5

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const [, , chatIdArg, intervalArg] = process.argv

if (!chatIdArg) {
  console.error('Usage: watch-pane.ts <chat_id> [interval_secs]')
  process.exit(1)
}

const chatId = chatIdArg
const intervalMs =
  Math.max(MIN_INTERVAL_SECS, parseInt(intervalArg ?? String(DEFAULT_INTERVAL_SECS), 10)) * 1000

// ---------------------------------------------------------------------------
// Token parsing — mirrors session-manager/telegram.ts for consistency
// ---------------------------------------------------------------------------
function getBotToken(): string {
  try {
    for (const raw of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      const eq = line.indexOf('=')
      if (eq > 0 && line.slice(0, eq).trim() === 'TELEGRAM_TOKEN') {
        let value = line.slice(eq + 1).trim()
        // Strip surrounding single or double quotes if present
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1)
        }
        return value
      }
    }
  } catch {
    /* .env missing — fall through */
  }
  return ''
}

// ---------------------------------------------------------------------------
// Telegram helpers
// ---------------------------------------------------------------------------
async function sendMessage(token: string, text: string): Promise<number> {
  const res = await fetch(TG_API(token, 'sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`sendMessage HTTP ${res.status}: ${body}`)
  }
  const data = (await res.json()) as { result: { message_id: number } }
  return data.result.message_id
}

// Never throws — logs failures to stderr and continues so the loop doesn't crash.
async function editMessage(token: string, messageId: number, text: string): Promise<void> {
  try {
    const res = await fetch(TG_API(token, 'editMessageText'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.error(`[watch-pane] editMessageText HTTP ${res.status}: ${body}`)
    }
  } catch (err) {
    console.error('[watch-pane] editMessageText network error:', err)
  }
}

// ---------------------------------------------------------------------------
// Pane capture
// ---------------------------------------------------------------------------
function capturePaneOutput(): string {
  try {
    const result = spawnSync('tmux', ['capture-pane', '-t', TMUX_SESSION, '-p'], {
      encoding: 'utf8',
      env: { ...process.env, TMUX_TMPDIR },
    })
    if (result.error || result.status !== 0) {
      return '(tmux not available)'
    }
    const lines = (result.stdout ?? '').split('\n')
    // Take the last PANE_LINES lines (tmux capture-pane may include trailing blanks)
    const tail = lines.slice(-PANE_LINES).join('\n')
    // Truncate to MAX_PANE_CHARS from the tail end to preserve the most recent output
    return tail.length > MAX_PANE_CHARS ? tail.slice(tail.length - MAX_PANE_CHARS) : tail
  } catch {
    return '(tmux not available)'
  }
}

// ---------------------------------------------------------------------------
// Message builder
// ---------------------------------------------------------------------------
function buildMessage(paneOutput: string): string {
  const now = new Date()
  const hh = now.getUTCHours().toString().padStart(2, '0')
  const mm = now.getUTCMinutes().toString().padStart(2, '0')
  const ss = now.getUTCSeconds().toString().padStart(2, '0')
  const header = `👁 ${hh}:${mm}:${ss} UTC\n\n`
  const full = header + paneOutput
  // Hard cap at Telegram's 4096-char limit
  return full.length > MAX_MSG_LEN ? full.slice(0, MAX_MSG_LEN) : full
}

// ---------------------------------------------------------------------------
// watcher.json — advertises PID + message_id so stop_watch MCP tool can act
// ---------------------------------------------------------------------------
function writeWatcherJson(messageId: number): void {
  mkdirSync(STATE_DIR, { recursive: true })
  const payload = JSON.stringify({
    pid: process.pid,
    chat_id: chatId,
    message_id: messageId,
    started_at: new Date().toISOString(),
  })
  writeFileSync(WATCHER_FILE, payload, { mode: 0o600 })
}

// ---------------------------------------------------------------------------
// Main — top-level await (ESM)
// ---------------------------------------------------------------------------
const token = getBotToken()
if (!token) {
  console.error(`[watch-pane] TELEGRAM_TOKEN not found in ${ENV_FILE}`)
  process.exit(1)
}

// Send the initial placeholder — if this fails there's nothing to edit, so exit.
let messageId: number
try {
  messageId = await sendMessage(token, '👁 Starting watch...')
} catch (err) {
  console.error('[watch-pane] Failed to send initial message:', err)
  process.exit(1)
}

writeWatcherJson(messageId)

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
let stopping = false

async function cleanup(): Promise<void> {
  if (stopping) return
  stopping = true
  await editMessage(token, messageId, '👁 Watch stopped.')
  try { unlinkSync(WATCHER_FILE) } catch { /* already gone */ }
  process.exit(0)
}

process.on('SIGTERM', () => { cleanup().catch(err => console.error('[watch-pane] cleanup error:', err)) })
process.on('SIGINT',  () => { cleanup().catch(err => console.error('[watch-pane] cleanup error:', err)) })

// ---------------------------------------------------------------------------
// Poll loop
// ---------------------------------------------------------------------------
while (!stopping) {
  // Wait first, then capture — gives the tmux session a moment to start
  await new Promise<void>(resolve => setTimeout(resolve, intervalMs))
  if (stopping) break

  const pane = capturePaneOutput()
  const text = buildMessage(pane)
  await editMessage(token, messageId, text)
}
