import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const ENV_FILE =
  process.env._PC_ENV_FILE ?? join(homedir(), '.pocket-claude', '.env')
const ACCESS_FILE =
  process.env._PC_ACCESS_FILE ?? join(homedir(), '.pocket-claude', 'access.json')

export function getBotToken(): string {
  try {
    for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0 && line.slice(0, eq).trim() === 'TELEGRAM_TOKEN') {
        return line.slice(eq + 1).trim()
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

export async function broadcast(text: string): Promise<void> {
  const targets = getNotifyTargets()
  await Promise.all(
    targets.map(id => sendMessage(id, text).catch(() => { /* skip failed target */ }))
  )
}
