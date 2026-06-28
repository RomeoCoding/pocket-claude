import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

type TagStore = Record<string, string[]>

const TAGS_FILE =
  process.env._PC_TAGS_FILE ?? join(homedir(), '.pocket-claude', 'tags.json')

function read(): TagStore {
  try { return JSON.parse(readFileSync(TAGS_FILE, 'utf8')) } catch { return {} }
}

function write(data: TagStore): void {
  mkdirSync(dirname(TAGS_FILE), { recursive: true })
  // Write via tmp+rename so readers never see a partial file
  const tmp = `${TAGS_FILE}.tmp.${process.pid}`
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  renameSync(tmp, TAGS_FILE)
}

function normalize(tags: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const tag of tags) {
    const t = tag.toLowerCase().trim()
    if (t && !seen.has(t)) {
      seen.add(t)
      result.push(t)
    }
  }
  return result
}

// Get all tags for a session (returns [] if none)
export function getSessionTags(sessionId: string): string[] {
  const data = read()
  return data[sessionId] ?? []
}

// Replace all tags for a session (empty array removes the entry)
// Normalizes tags: lowercase, trim, deduplicate, filter empty
export function setSessionTags(sessionId: string, tags: string[]): void {
  const data = read()
  const normalized = normalize(tags)
  if (normalized.length === 0) {
    delete data[sessionId]
  } else {
    data[sessionId] = normalized
  }
  write(data)
}

// Add a single tag (no-op if already present)
export function addSessionTag(sessionId: string, tag: string): void {
  const normalized = tag.toLowerCase().trim()
  if (!normalized) return
  const data = read()
  const existing = data[sessionId] ?? []
  if (existing.includes(normalized)) return
  data[sessionId] = [...existing, normalized]
  write(data)
}

// Remove a single tag (no-op if not present)
export function removeSessionTag(sessionId: string, tag: string): void {
  const normalized = tag.toLowerCase().trim()
  const data = read()
  const existing = data[sessionId]
  if (!existing) return
  const updated = existing.filter(t => t !== normalized)
  if (updated.length === existing.length) return // nothing changed
  if (updated.length === 0) {
    delete data[sessionId]
  } else {
    data[sessionId] = updated
  }
  write(data)
}

// Remove all tags for a session (called on session delete)
export function deleteSessionTags(sessionId: string): void {
  const data = read()
  if (!(sessionId in data)) return
  delete data[sessionId]
  write(data)
}

// Return all unique tags in use across all sessions, sorted alphabetically
export function getAllTags(): string[] {
  const data = read()
  const tags = new Set<string>()
  for (const sessionTags of Object.values(data)) {
    for (const tag of sessionTags) {
      tags.add(tag)
    }
  }
  return [...tags].sort()
}

// Return session IDs that have a specific tag
export function getSessionsWithTag(tag: string): string[] {
  const normalized = tag.toLowerCase().trim()
  const data = read()
  return Object.entries(data)
    .filter(([, tags]) => tags.includes(normalized))
    .map(([sessionId]) => sessionId)
}
