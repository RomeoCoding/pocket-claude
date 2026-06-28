import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ENV_FILE =
  process.env._PC_ENV_FILE ?? join(homedir(), '.pocket-claude', '.env')
const ACCESS_FILE =
  process.env._PC_ACCESS_FILE ?? join(homedir(), '.pocket-claude', 'access.json')

// Minimum ms between consecutive Telegram sends — stays well under the 30 msg/sec limit
const SEND_INTERVAL_MS = 50

export function getBotToken(): string {
  try {
    for (const raw of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue // skip empty lines and comments
      const eq = line.indexOf('=')
      if (eq > 0 && line.slice(0, eq).trim() === 'TELEGRAM_TOKEN') {
        let value = line.slice(eq + 1).trim()
        // Strip surrounding single or double quotes if present
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }
        return value
      }
    }
  } catch { /* .env missing */ }
  return ''
}

export function getNotifyTargets(): string[] {
  try {
    const access = JSON.parse(readFileSync(ACCESS_FILE, 'utf8'))
    const users: string[] = Array.isArray(access.allowFrom) ? access.allowFrom : []
    const groups: string[] = access.groups ? Object.keys(access.groups) : []
    return [...new Set([...users, ...groups])]
  } catch { return [] }
}

export async function sendMessage(chatId: string, text: string): Promise<void> {
  const token = getBotToken()
  if (!token) throw new Error('TELEGRAM_TOKEN not found in .env')
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Telegram API ${res.status}: ${body}`)
  }
}

// Sends to all targets sequentially with a small inter-message delay to stay
// under Telegram's rate limits. Returns the list of chat IDs that failed.
export async function broadcast(text: string): Promise<{ failed: string[] }> {
  const targets = getNotifyTargets()
  const failed: string[] = []
  for (let i = 0; i < targets.length; i++) {
    try {
      await sendMessage(targets[i], text)
    } catch {
      failed.push(targets[i])
    }
    if (i < targets.length - 1) {
      await new Promise(r => setTimeout(r, SEND_INTERVAL_MS))
    }
  }
  return { failed }
}
