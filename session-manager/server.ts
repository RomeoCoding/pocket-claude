#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { spawnSync, execFileSync, spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  listSessions,
  formatSessionList,
  isValidSessionId,
  getSessionPreview,
  getLocalLogs,
  searchSessions,
  pinSession,
  unpinSession,
  deleteSession,
  deleteOldSessions,
} from './sessions.ts'
import { requireAdmin, setUserRole } from './roles.ts'
import { getBotToken, sendMessage, broadcast } from './telegram.ts'
import { queueTask, listQueue, listDueTasks, completeTask, formatQueue } from './queue.ts'
import { checkAndRecord, markWelcomed } from './seen_users.ts'
import { claimTurn, releaseTurn, getTurnStatus } from './turn.ts'
import { logAudit, readAuditLog, formatAuditLog } from './audit.ts'
import {
  getSessionTags,
  addSessionTag,
  removeSessionTag,
  deleteSessionTags,
  getAllTags,
  getSessionsWithTag,
} from './tags.ts'

const TMUX_SESSION = process.env.POCKET_CLAUDE_TMUX ?? 'pocket-claude'
const STATE_FILE = join(homedir(), '.pocket-claude', 'state.json')
const WATCHER_FILE = join(homedir(), '.pocket-claude', 'watcher.json')
const TMUX_TMPDIR = join(homedir(), '.pocket-claude', 'tmux')
const INSTALL_DIR = '/opt/pocket-claude'
const WATCH_PANE_SCRIPT = join(INSTALL_DIR, 'daemon', 'watch-pane.ts')
const tmuxEnv = { ...process.env, TMUX_TMPDIR }

const WELCOME_MESSAGE = `👋 Welcome to pocket-claude

This is a full Claude Code instance running 24/7 on a VM — accessible from Telegram, no laptop needed.

What makes it different from API bots:
• Runs real code, edits files, uses all MCP tools — no sandboxing
• No API key needed — powered by your Claude Code subscription
• Works while your laptop is off
• Shared with your team — one instance, everyone connected

Things to try:
  "What are you working on?"
  "List my sessions"
  "Queue a task: <description>"

─────────────────────────────────`

process.on('unhandledRejection', err => {
  process.stderr.write(`session-manager: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`session-manager: uncaught exception: ${err}\n`)
})

function tmuxRunning(): boolean {
  return spawnSync('tmux', ['has-session', '-t', TMUX_SESSION], { stdio: 'ignore', env: tmuxEnv }).status === 0
}

function claudeRunning(): boolean {
  if (!tmuxRunning()) return false
  const result = spawnSync('tmux', ['list-panes', '-t', TMUX_SESSION, '-F', '#{pane_pid}'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: tmuxEnv,
  })
  if (result.status !== 0 || !result.stdout.trim()) return false
  const panePid = result.stdout.trim().split('\n')[0]
  const check = spawnSync('ps', ['-p', panePid, '-o', 'comm='], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  })
  return (check.stdout ?? '').trim() === 'claude'
}

function switchSession(sessionId: string, isNew: boolean): void {
  if (!isNew && !isValidSessionId(sessionId)) throw new Error('Invalid session ID format')
  const switchScript = join(homedir(), '.pocket-claude', 'switch.sh')
  if (!existsSync(switchScript)) throw new Error('Switch script not found. Was pocket-claude installed correctly?')
  execFileSync('bash', [switchScript, isNew ? '--new' : '--resume', ...(isNew ? [] : [sessionId])], {
    timeout: 8000, stdio: 'ignore', env: tmuxEnv,
  })
}

function readState(): Record<string, unknown> {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}

function formatAge(date: Date): string {
  const diffMs = Date.now() - date.getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

// Build compact audit args string — skip auth fields, truncate long values
function summarizeArgs(args: Record<string, unknown>): string {
  const skip = new Set(['caller_id', 'display_name', 'caller_name'])
  return Object.entries(args)
    .filter(([k]) => !skip.has(k))
    .map(([k, v]) => {
      const s = String(v)
      return `${k}=${s.length > 40 ? s.slice(0, 37) + '...' : s}`
    })
    .join(', ')
}

const mcp = new Server(
  { name: 'pocket-claude-session-manager', version: '1.3.0' },
  { capabilities: { tools: {} } },
)

function prependWelcome(
  result: { content: Array<{ type: string; text: string }>; isError?: boolean },
  prefix: string,
): typeof result {
  if (!prefix) return result
  return {
    ...result,
    content: result.content.map((c, i) =>
      i === 0 && c.type === 'text' ? { ...c, text: prefix + c.text } : c
    ),
  }
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    // ─── Sessions ────────────────────────────────────────────────────────
    {
      name: 'list_sessions',
      description: 'List recent Claude Code sessions (default 50). Pinned sessions first [P]. Optional tag filter.',
      inputSchema: { type: 'object', properties: {
        limit: { type: 'number', description: 'Max sessions (default 50, max 50)' },
        tag: { type: 'string', description: 'Filter to sessions with this tag only' },
      }},
    },
    {
      name: 'search_sessions',
      description: 'Find sessions by keyword — searches titles first, then first 16KB of content.',
      inputSchema: { type: 'object', properties: {
        query: { type: 'string', description: 'Keyword to search for' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      }, required: ['query'] },
    },
    {
      name: 'resume_session',
      description: 'Switch to a previous session by its index from list_sessions.',
      inputSchema: { type: 'object', properties: {
        index: { type: 'number', description: 'Session number from list_sessions (1-based)' },
        session_id: { type: 'string', description: 'Exact session UUID (alternative to index)' },
      }},
    },
    {
      name: 'smart_resume',
      description: 'Resume the most recent session matching a tag or keyword. Faster than list + resume.',
      inputSchema: { type: 'object', properties: {
        tag: { type: 'string', description: 'Resume most recent session with this tag' },
        query: { type: 'string', description: 'Resume most recent session matching this keyword' },
      }},
    },
    {
      name: 'preview_session',
      description: 'Show last few messages from a session to confirm it is the right one before resuming.',
      inputSchema: { type: 'object', properties: {
        index: { type: 'number', description: 'Session number from list_sessions (1-based)' },
        messages: { type: 'number', description: 'Message pairs to show (default 3)' },
      }, required: ['index'] },
    },
    {
      name: 'pin_session',
      description: 'Pin a session so it appears at the top of list_sessions regardless of recency.',
      inputSchema: { type: 'object', properties: {
        index: { type: 'number', description: 'Session number (1-based)' },
      }, required: ['index'] },
    },
    {
      name: 'unpin_session',
      description: 'Remove a pin from a session.',
      inputSchema: { type: 'object', properties: {
        index: { type: 'number', description: 'Session number (1-based)' },
      }, required: ['index'] },
    },
    {
      name: 'tag_session',
      description: 'Add a tag to a session for organisation and quick filtering.',
      inputSchema: { type: 'object', properties: {
        index: { type: 'number', description: 'Session number (1-based)' },
        tag: { type: 'string', description: 'Tag to add (e.g. "work", "client-xyz")' },
      }, required: ['index', 'tag'] },
    },
    {
      name: 'untag_session',
      description: 'Remove a tag from a session.',
      inputSchema: { type: 'object', properties: {
        index: { type: 'number', description: 'Session number (1-based)' },
        tag: { type: 'string', description: 'Tag to remove' },
      }, required: ['index', 'tag'] },
    },
    {
      name: 'list_tags',
      description: 'Show all tags in use and how many sessions each has.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'new_session',
      description: 'Start a fresh Claude Code session. Pass confirmed: true to execute.',
      inputSchema: { type: 'object', properties: {
        confirmed: { type: 'boolean', description: 'Must be true to start' },
      }},
    },
    {
      name: 'restart_session',
      description: 'Restart Claude in the current session — clears context window but keeps session history.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'delete_sessions',
      description: 'Delete one session by index, or all sessions older than N days.',
      inputSchema: { type: 'object', properties: {
        index: { type: 'number', description: 'Session index to delete (1-based)' },
        older_than_days: { type: 'number', description: 'Delete all sessions older than N days' },
        confirmed: { type: 'boolean', description: 'Must be true to execute' },
      }},
    },
    // ─── Status & Pane ───────────────────────────────────────────────────
    {
      name: 'get_status',
      description: 'Check daemon health: tmux, Claude process, uptime, current session, queue depth, turn holder.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'what_am_i_working_on',
      description: 'Quick summary: current session title, recent context, uptime.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_logs',
      description: 'Return recent daemon log lines for diagnosing issues without SSH.',
      inputSchema: { type: 'object', properties: {
        lines: { type: 'number', description: 'Lines per log file (default 30, max 100)' },
      }},
    },
    {
      name: 'get_pane_output',
      description: 'Capture the current tmux pane output — see exactly what Claude sees on screen.',
      inputSchema: { type: 'object', properties: {
        lines: { type: 'number', description: 'Lines to capture (default 30, max 100)' },
      }},
    },
    {
      name: 'watch_pane',
      description: 'Start live pane monitoring — edits a single Telegram message with updates. Use stop_watch to cancel.',
      inputSchema: { type: 'object', properties: {
        interval: { type: 'number', description: 'Seconds between updates (default 10, min 5)' },
        caller_id: { type: 'string', description: 'Your Telegram chat_id (required)' },
      }, required: ['caller_id'] },
    },
    {
      name: 'stop_watch',
      description: 'Stop the background pane watcher started by watch_pane.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'stop_claude',
      description: 'Send Ctrl+C to the Claude pane to interrupt the current operation. Admin only.',
      inputSchema: { type: 'object', properties: {
        caller_id: { type: 'string', description: 'Your Telegram chat_id (required for auth)' },
      }},
    },
    // ─── Admin ───────────────────────────────────────────────────────────
    {
      name: 'update_pocket_claude',
      description: 'Pull latest pocket-claude code from GitHub and restart the service. Admin only.',
      inputSchema: { type: 'object', properties: {
        confirmed: { type: 'boolean', description: 'Must be true to execute' },
      }},
    },
    {
      name: 'set_user_role',
      description: 'Grant or revoke admin access for a Telegram user. Admin only.',
      inputSchema: { type: 'object', properties: {
        target_user_id: { type: 'string', description: 'Telegram user ID to update' },
        role: { type: 'string', enum: ['admin', 'member'], description: 'Role to assign' },
        caller_id: { type: 'string', description: 'Your Telegram chat_id (required for auth)' },
      }, required: ['target_user_id', 'role'] },
    },
    {
      name: 'get_audit_log',
      description: 'View the tool call audit log — who called what and when. Admin only.',
      inputSchema: { type: 'object', properties: {
        limit: { type: 'number', description: 'Recent entries to show (default 20, max 100)' },
        caller_id: { type: 'string', description: 'Your Telegram chat_id (required for auth)' },
      }},
    },
    // ─── Tasks & Notifications ───────────────────────────────────────────
    {
      name: 'handoff_summary',
      description: 'Generate a structured summary of current work, open tasks, and recent context.',
      inputSchema: { type: 'object', properties: {
        caller_id: { type: 'string', description: 'Your Telegram chat_id (optional)' },
      }},
    },
    {
      name: 'notify_user',
      description: 'Send a Telegram message proactively. Omit chat_id to broadcast to all users.',
      inputSchema: { type: 'object', properties: {
        message: { type: 'string', description: 'Message to send' },
        chat_id: { type: 'string', description: 'Specific chat_id (omit to broadcast)' },
      }, required: ['message'] },
    },
    {
      name: 'relay_file',
      description: 'Send a file from the VM to a Telegram chat. Use after generating a report or artifact.',
      inputSchema: { type: 'object', properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to send' },
        chat_id: { type: 'string', description: 'Telegram chat_id to send to (defaults to caller_id)' },
        caller_id: { type: 'string', description: 'Your Telegram chat_id' },
      }, required: ['file_path'] },
    },
    {
      name: 'queue_task',
      description: 'Add a task to the persistent queue. Optionally schedule with run_after (ISO 8601).',
      inputSchema: { type: 'object', properties: {
        description: { type: 'string', description: 'What needs to be done' },
        priority: { type: 'string', enum: ['high', 'normal'], description: 'Priority (default: normal)' },
        run_after: { type: 'string', description: 'ISO 8601 timestamp to schedule for later' },
        caller_id: { type: 'string', description: 'Your Telegram chat_id' },
      }, required: ['description'] },
    },
    {
      name: 'list_queue',
      description: 'Show all tasks in the queue — pending, in progress, and recently completed.',
      inputSchema: { type: 'object', properties: {
        caller_id: { type: 'string', description: 'Your Telegram chat_id (optional)' },
      }},
    },
    {
      name: 'run_task',
      description: 'Get the next pending task to work on — due tasks first, then by priority.',
      inputSchema: { type: 'object', properties: {
        caller_id: { type: 'string', description: 'Your Telegram chat_id (optional)' },
      }},
    },
    {
      name: 'complete_task',
      description: 'Mark a queued task as done. Notifies the user who queued it.',
      inputSchema: { type: 'object', properties: {
        task_id: { type: 'string', description: 'Task ID from list_queue (full UUID or first 8 chars)' },
        note: { type: 'string', description: 'Optional completion note' },
        caller_id: { type: 'string', description: 'Your Telegram chat_id (optional)' },
      }, required: ['task_id'] },
    },
    // ─── Turn management ─────────────────────────────────────────────────
    {
      name: 'claim_turn',
      description: 'ALWAYS call this first before responding to any Telegram message. If ok:false, tell the user Claude is busy and stop.',
      inputSchema: { type: 'object', properties: {
        caller_id: { type: 'string', description: 'Telegram chat_id of the message sender' },
        display_name: { type: 'string', description: 'Display name of the sender' },
      }, required: ['caller_id'] },
    },
    {
      name: 'release_turn',
      description: 'Call after sending your final reply. Releases the turn lock.',
      inputSchema: { type: 'object', properties: {
        caller_id: { type: 'string', description: 'Telegram chat_id of the current turn holder' },
      }, required: ['caller_id'] },
    },
    // ─── Voice ───────────────────────────────────────────────────────────
    {
      name: 'transcribe_voice',
      description: 'Transcribe a voice message (.ogg file) to text using whisper.',
      inputSchema: { type: 'object', properties: {
        file_path: { type: 'string', description: 'Absolute path to the .ogg voice file on disk' },
        caller_id: { type: 'string', description: 'Your Telegram chat_id (optional)' },
      }, required: ['file_path'] },
    },
  ],
}))

// ─────────────────────────────────────────────────────────────────────────────

async function handleTool(
  name: string,
  args: Record<string, unknown>,
  callerId: string | undefined,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  switch (name) {

    // ─── Sessions ─────────────────────────────────────────────────────

    case 'list_sessions': {
      const limit = typeof args.limit === 'number' ? Math.min(args.limit, 50) : 50
      const tag = typeof args.tag === 'string' ? args.tag.trim().toLowerCase() : ''
      let sessions = await listSessions(limit)
      if (tag) {
        const taggedIds = new Set(getSessionsWithTag(tag))
        sessions = sessions.filter(s => taggedIds.has(s.id))
        if (sessions.length === 0) return { content: [{ type: 'text', text: `No sessions tagged #${tag}.` }] }
      }
      return { content: [{ type: 'text', text: formatSessionList(sessions) }] }
    }

    case 'search_sessions': {
      if (typeof args.query !== 'string' || !args.query.trim()) {
        return { content: [{ type: 'text', text: 'Provide a search query.' }], isError: true }
      }
      const limit = typeof args.limit === 'number' ? Math.min(args.limit, 20) : 10
      const results = await searchSessions(args.query.trim(), limit)
      if (results.length === 0) return { content: [{ type: 'text', text: `No sessions found matching "${args.query}".` }] }
      return { content: [{ type: 'text', text: `Found ${results.length} session(s):\n${formatSessionList(results)}` }] }
    }

    case 'resume_session': {
      const sessions = await listSessions(50)
      let targetId: string | undefined

      if (typeof args.index === 'number') {
        const idx = Math.floor(args.index) - 1
        if (idx < 0 || idx >= sessions.length) {
          return { content: [{ type: 'text', text: `No session at index ${args.index}. Run list_sessions first.` }], isError: true }
        }
        targetId = sessions[idx].id
      } else if (typeof args.session_id === 'string') {
        const found = sessions.find(s => s.id === args.session_id)
        if (!found) return { content: [{ type: 'text', text: 'Session not found.' }], isError: true }
        targetId = found.id
      } else {
        return { content: [{ type: 'text', text: 'Provide either index or session_id.' }], isError: true }
      }

      const session = sessions.find(s => s.id === targetId)!
      switchSession(targetId, false)
      return { content: [{ type: 'text', text: `Switching to: "${session.title}"\nRestarting in ~3 seconds.` }] }
    }

    case 'smart_resume': {
      const tag = typeof args.tag === 'string' ? args.tag.trim() : ''
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (!tag && !query) return { content: [{ type: 'text', text: 'Provide tag or query.' }], isError: true }

      let targetId: string
      let sessionTitle: string

      if (tag) {
        const taggedIds = getSessionsWithTag(tag)
        if (taggedIds.length === 0) return { content: [{ type: 'text', text: `No sessions tagged #${tag}.` }] }
        const sessions = await listSessions(50)
        const match = sessions.find(s => taggedIds.includes(s.id))
        if (!match) return { content: [{ type: 'text', text: 'Tagged sessions not found in recent history.' }] }
        targetId = match.id
        sessionTitle = match.title
      } else {
        const results = await searchSessions(query, 1)
        if (results.length === 0) return { content: [{ type: 'text', text: `No sessions matching "${query}".` }] }
        targetId = results[0].id
        sessionTitle = results[0].title
      }

      switchSession(targetId, false)
      return { content: [{ type: 'text', text: `Resuming: "${sessionTitle}"\nSwitching in ~3 seconds.` }] }
    }

    case 'preview_session': {
      const sessions = await listSessions(50)
      if (typeof args.index !== 'number') return { content: [{ type: 'text', text: 'Provide index.' }], isError: true }
      const idx = Math.floor(args.index) - 1
      if (idx < 0 || idx >= sessions.length) return { content: [{ type: 'text', text: `No session at index ${args.index}.` }], isError: true }
      const session = sessions[idx]
      const msgCount = typeof args.messages === 'number' ? Math.min(args.messages, 10) : 3
      const preview = await getSessionPreview(session.id, msgCount, session.filePath)
      const pin = session.pinned ? ' [P]' : ''
      const tags = getSessionTags(session.id)
      const tagLine = tags.length > 0 ? ` [${tags.map(t => `#${t}`).join(' ')}]` : ''
      return { content: [{ type: 'text', text: `Session ${args.index}${pin}${tagLine}: "${session.title}" [${formatAge(session.updatedAt)}]\n\n${preview}` }] }
    }

    case 'pin_session': {
      const sessions = await listSessions(50)
      if (typeof args.index !== 'number') return { content: [{ type: 'text', text: 'Provide index.' }], isError: true }
      const idx = Math.floor(args.index) - 1
      if (idx < 0 || idx >= sessions.length) return { content: [{ type: 'text', text: `No session at index ${args.index}.` }], isError: true }
      await pinSession(sessions[idx].id)
      return { content: [{ type: 'text', text: `Pinned: "${sessions[idx].title}"` }] }
    }

    case 'unpin_session': {
      const sessions = await listSessions(50)
      if (typeof args.index !== 'number') return { content: [{ type: 'text', text: 'Provide index.' }], isError: true }
      const idx = Math.floor(args.index) - 1
      if (idx < 0 || idx >= sessions.length) return { content: [{ type: 'text', text: `No session at index ${args.index}.` }], isError: true }
      await unpinSession(sessions[idx].id)
      return { content: [{ type: 'text', text: `Unpinned: "${sessions[idx].title}"` }] }
    }

    case 'tag_session': {
      const sessions = await listSessions(50)
      if (typeof args.index !== 'number') return { content: [{ type: 'text', text: 'Provide index.' }], isError: true }
      const idx = Math.floor(args.index) - 1
      if (idx < 0 || idx >= sessions.length) return { content: [{ type: 'text', text: `No session at index ${args.index}.` }], isError: true }
      const tag = typeof args.tag === 'string' ? args.tag.trim() : ''
      if (!tag) return { content: [{ type: 'text', text: 'Provide tag.' }], isError: true }
      const session = sessions[idx]
      addSessionTag(session.id, tag)
      const allTags = getSessionTags(session.id)
      return { content: [{ type: 'text', text: `Tagged "${session.title}" with #${tag.toLowerCase()}. Tags: ${allTags.map(t => `#${t}`).join(', ')}` }] }
    }

    case 'untag_session': {
      const sessions = await listSessions(50)
      if (typeof args.index !== 'number') return { content: [{ type: 'text', text: 'Provide index.' }], isError: true }
      const idx = Math.floor(args.index) - 1
      if (idx < 0 || idx >= sessions.length) return { content: [{ type: 'text', text: `No session at index ${args.index}.` }], isError: true }
      const tag = typeof args.tag === 'string' ? args.tag.trim() : ''
      if (!tag) return { content: [{ type: 'text', text: 'Provide tag.' }], isError: true }
      const session = sessions[idx]
      removeSessionTag(session.id, tag)
      const remaining = getSessionTags(session.id)
      const msg = remaining.length > 0
        ? `Removed #${tag} from "${session.title}". Remaining: ${remaining.map(t => `#${t}`).join(', ')}`
        : `Removed #${tag} from "${session.title}". No tags remaining.`
      return { content: [{ type: 'text', text: msg }] }
    }

    case 'list_tags': {
      const tags = getAllTags()
      if (tags.length === 0) return { content: [{ type: 'text', text: '(no tags in use)' }] }
      const lines = tags.map(tag => {
        const count = getSessionsWithTag(tag).length
        return `#${tag} — ${count} session${count !== 1 ? 's' : ''}`
      })
      return { content: [{ type: 'text', text: `Tags:\n${lines.join('\n')}` }] }
    }

    case 'new_session': {
      const roleCheck = requireAdmin(callerId)
      if (!roleCheck.ok) return { content: [{ type: 'text', text: roleCheck.error }], isError: true }
      if (args.confirmed !== true) {
        return { content: [{ type: 'text', text: 'This will discard your current context window (session history on disk stays safe).\nCall new_session again with confirmed: true to proceed.' }] }
      }
      switchSession('', true)
      return { content: [{ type: 'text', text: 'Starting fresh session in ~3 seconds.' }] }
    }

    case 'restart_session': {
      const roleCheck = requireAdmin(callerId)
      if (!roleCheck.ok) return { content: [{ type: 'text', text: roleCheck.error }], isError: true }
      const state = readState()
      const currentId = typeof state.currentSessionId === 'string' ? state.currentSessionId : ''
      if (currentId && isValidSessionId(currentId)) {
        switchSession(currentId, false)
        return { content: [{ type: 'text', text: 'Restarting in current session (~3 seconds). Fresh context, same history.' }] }
      }
      switchSession('', true)
      return { content: [{ type: 'text', text: 'Session is new (no history yet) — restarting fresh in ~3 seconds.' }] }
    }

    case 'delete_sessions': {
      const roleCheck = requireAdmin(callerId)
      if (!roleCheck.ok) return { content: [{ type: 'text', text: roleCheck.error }], isError: true }
      if (args.confirmed !== true) {
        const preview = typeof args.older_than_days === 'number'
          ? `Delete all sessions older than ${args.older_than_days} days?`
          : typeof args.index === 'number'
            ? `Delete session #${args.index}?`
            : 'Specify index or older_than_days.'
        return { content: [{ type: 'text', text: `${preview}\nCall again with confirmed: true to proceed.` }] }
      }
      if (typeof args.older_than_days === 'number') {
        if (args.older_than_days < 1) {
          return { content: [{ type: 'text', text: 'older_than_days must be at least 1.' }], isError: true }
        }
        const count = await deleteOldSessions(args.older_than_days)
        return { content: [{ type: 'text', text: `Deleted ${count} session(s) older than ${args.older_than_days} days.` }] }
      }
      if (typeof args.index === 'number') {
        const sessions = await listSessions(50)
        const idx = Math.floor(args.index) - 1
        if (idx < 0 || idx >= sessions.length) return { content: [{ type: 'text', text: `No session at index ${args.index}.` }], isError: true }
        const session = sessions[idx]
        await deleteSession(session.id)
        deleteSessionTags(session.id)
        return { content: [{ type: 'text', text: `Deleted: "${session.title}".` }] }
      }
      return { content: [{ type: 'text', text: 'Provide index or older_than_days.' }], isError: true }
    }

    // ─── Status & Pane ────────────────────────────────────────────────

    case 'get_status': {
      const tmux = tmuxRunning()
      const claude = claudeRunning()
      const state = readState()
      const startedAt = state.startedAt ? new Date(state.startedAt as string) : null
      const uptime = startedAt ? Math.floor((Date.now() - startedAt.getTime()) / 1000 / 60) : null
      const currentId = typeof state.currentSessionId === 'string' ? state.currentSessionId : ''
      let sessionLine = 'current session: new (no history yet)'
      if (currentId && isValidSessionId(currentId)) {
        const sessions = await listSessions(50)
        const found = sessions.find(s => s.id === currentId)
        sessionLine = found ? `current session: "${found.title}"` : `current session: ${currentId.slice(0, 8)}… (not found)`
      }
      const pending = listQueue().filter(t => t.status !== 'done')
      const turn = getTurnStatus()
      return { content: [{ type: 'text', text: [
        `tmux session:    ${tmux ? 'running' : 'NOT FOUND'}`,
        `claude process:  ${claude ? 'alive' : 'NOT RUNNING'}`,
        `uptime:          ${uptime !== null ? `${uptime}m` : 'unknown'}`,
        sessionLine,
        `queue depth:     ${pending.length} pending task${pending.length !== 1 ? 's' : ''}`,
        turn ? `turn holder:     ${turn.holder_name} (${turn.holder})` : 'turn holder:     none',
      ].join('\n') }] }
    }

    case 'what_am_i_working_on': {
      const state = readState()
      const startedAt = state.startedAt ? new Date(state.startedAt as string) : null
      const uptime = startedAt ? Math.floor((Date.now() - startedAt.getTime()) / 1000 / 60) : null
      const currentId = typeof state.currentSessionId === 'string' ? state.currentSessionId : ''
      if (!currentId || !isValidSessionId(currentId)) {
        const sessions = await listSessions(1)
        const latest = sessions[0]
        if (!latest) return { content: [{ type: 'text', text: 'No sessions found.' }] }
        const preview = await getSessionPreview(latest.id, 2, latest.filePath)
        return { content: [{ type: 'text', text: `Most recent: "${latest.title}" [${formatAge(latest.updatedAt)}]\n\n${preview}` }] }
      }
      const sessions = await listSessions(50)
      const session = sessions.find(s => s.id === currentId)
      const preview = await getSessionPreview(currentId, 2, session?.filePath)
      return { content: [{ type: 'text', text: [
        `Working on: "${session?.title ?? '(unknown)'}"`,
        uptime !== null ? `Uptime: ${uptime}m` : '',
        '',
        preview,
      ].filter(Boolean).join('\n') }] }
    }

    case 'get_logs': {
      const n = typeof args.lines === 'number' ? Math.min(args.lines, 100) : 30
      return { content: [{ type: 'text', text: await getLocalLogs(n) }] }
    }

    case 'get_pane_output': {
      if (!tmuxRunning()) return { content: [{ type: 'text', text: 'tmux session not running.' }], isError: true }
      const lines = typeof args.lines === 'number' ? Math.min(args.lines, 100) : 30
      const result = spawnSync(
        'tmux', ['capture-pane', '-t', TMUX_SESSION, '-p', '-S', String(-lines)],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: tmuxEnv },
      )
      return { content: [{ type: 'text', text: result.stdout?.trim() || '(pane is empty)' }] }
    }

    case 'watch_pane': {
      if (!callerId) return { content: [{ type: 'text', text: 'caller_id required.' }], isError: true }
      // Kill existing watcher if any
      if (existsSync(WATCHER_FILE)) {
        try {
          const existing = JSON.parse(readFileSync(WATCHER_FILE, 'utf8'))
          if (existing?.pid) process.kill(existing.pid, 'SIGTERM')
        } catch { /* already dead */ }
        await new Promise(r => setTimeout(r, 300))
      }
      const interval = typeof args.interval === 'number' ? Math.max(5, Math.floor(args.interval)) : 10
      const child = spawn(
        'node', ['--experimental-strip-types', WATCH_PANE_SCRIPT, callerId, String(interval)],
        { detached: true, stdio: 'ignore', env: { ...process.env, POCKET_CLAUDE_TMUX: TMUX_SESSION, TMUX_TMPDIR } },
      )
      child.unref()
      return { content: [{ type: 'text', text: `👁 Watching pane — updates every ${interval}s in your chat. Use stop_watch to cancel.` }] }
    }

    case 'stop_watch': {
      if (!existsSync(WATCHER_FILE)) return { content: [{ type: 'text', text: 'No active pane watcher.' }] }
      try {
        const watcher = JSON.parse(readFileSync(WATCHER_FILE, 'utf8'))
        if (!watcher?.pid) throw new Error('no pid in watcher.json')
        process.kill(watcher.pid, 'SIGTERM')
        return { content: [{ type: 'text', text: '👁 Watch stopped.' }] }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `Could not stop watcher: ${msg}` }] }
      }
    }

    case 'stop_claude': {
      const roleCheck = requireAdmin(callerId)
      if (!roleCheck.ok) return { content: [{ type: 'text', text: roleCheck.error }], isError: true }
      if (!tmuxRunning()) return { content: [{ type: 'text', text: 'tmux session not running.' }], isError: true }
      spawnSync('tmux', ['send-keys', '-t', TMUX_SESSION, 'C-c'], { stdio: 'ignore', env: tmuxEnv })
      return { content: [{ type: 'text', text: 'Sent interrupt (Ctrl+C) to Claude pane.' }] }
    }

    // ─── Admin ────────────────────────────────────────────────────────

    case 'update_pocket_claude': {
      const roleCheck = requireAdmin(callerId)
      if (!roleCheck.ok) return { content: [{ type: 'text', text: roleCheck.error }], isError: true }
      if (args.confirmed !== true) {
        return { content: [{ type: 'text', text: 'This will pull the latest code from GitHub and restart pocket-claude.\nCall again with confirmed: true to proceed.' }] }
      }
      try {
        const out = execFileSync('sudo', ['bash', `${INSTALL_DIR}/update.sh`], {
          encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
        })
        return { content: [{ type: 'text', text: out.trim() || 'Update complete.' }] }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const stderr = ((err as Record<string, unknown>).stderr as string | undefined) ?? ''
        const detail = stderr.trim() ? `\n${stderr.trim()}` : ''
        return { content: [{ type: 'text', text: `Update failed: ${msg}${detail}\n\nSSH in and run: sudo bash ${INSTALL_DIR}/update.sh` }], isError: true }
      }
    }

    case 'set_user_role': {
      const roleCheck = requireAdmin(callerId)
      if (!roleCheck.ok) return { content: [{ type: 'text', text: roleCheck.error }], isError: true }
      const targetId = typeof args.target_user_id === 'string' ? args.target_user_id.trim() : ''
      const role = args.role === 'admin' ? 'admin' as const : 'member' as const
      if (!targetId) return { content: [{ type: 'text', text: 'Provide target_user_id.' }], isError: true }
      setUserRole(targetId, role)
      return { content: [{ type: 'text', text: `User ${targetId} is now ${role}.` }] }
    }

    case 'get_audit_log': {
      const roleCheck = requireAdmin(callerId)
      if (!roleCheck.ok) return { content: [{ type: 'text', text: roleCheck.error }], isError: true }
      const limit = typeof args.limit === 'number' ? Math.min(args.limit, 100) : 20
      return { content: [{ type: 'text', text: formatAuditLog(readAuditLog(limit)) }] }
    }

    // ─── Tasks & Notifications ────────────────────────────────────────

    case 'handoff_summary': {
      const state = readState()
      const currentId = typeof state.currentSessionId === 'string' ? state.currentSessionId : ''
      const sessions = await listSessions(50)
      const current = sessions.find(s => s.id === currentId)
      const preview = current ? await getSessionPreview(currentId, 2, current.filePath) : '(no active session)'
      const queue = listQueue().filter(t => t.status !== 'done')
      return { content: [{ type: 'text', text: [
        `📋 Handoff Summary — ${new Date().toLocaleString()}`,
        '',
        `Session: "${current?.title ?? 'unknown'}"`,
        `Project: ${current?.projectPath ?? 'unknown'}`,
        `Last active: ${current ? formatAge(current.updatedAt) : 'unknown'}`,
        '',
        '--- Recent context ---',
        preview,
        '',
        `--- Task queue (${queue.length} pending) ---`,
        queue.length === 0
          ? '(no pending tasks)'
          : queue.map(t => `${t.priority === 'high' ? '🔴' : '⏳'} ${t.description} (by ${t.queued_by})`).join('\n'),
      ].join('\n') }] }
    }

    case 'notify_user': {
      const message = typeof args.message === 'string' ? args.message.trim() : ''
      if (!message) return { content: [{ type: 'text', text: 'Provide a message.' }], isError: true }
      const targetChatId = typeof args.chat_id === 'string' ? args.chat_id.trim() : null
      try {
        if (targetChatId) {
          await sendMessage(targetChatId, message)
          return { content: [{ type: 'text', text: `Notified ${targetChatId}.` }] }
        } else {
          const result = await broadcast(message)
          const failNote = result.failed.length > 0 ? ` (${result.failed.length} failed)` : ''
          return { content: [{ type: 'text', text: `Broadcast sent to all users${failNote}.` }] }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `Notification failed: ${msg}` }], isError: true }
      }
    }

    case 'relay_file': {
      const filePath = typeof args.file_path === 'string' ? args.file_path.trim() : ''
      const targetChatId = typeof args.chat_id === 'string' ? args.chat_id.trim() : callerId
      if (!filePath) return { content: [{ type: 'text', text: 'Provide file_path.' }], isError: true }
      if (!targetChatId) return { content: [{ type: 'text', text: 'Provide chat_id or include caller_id.' }], isError: true }
      if (!existsSync(filePath)) return { content: [{ type: 'text', text: `File not found: ${filePath}` }], isError: true }
      const token = getBotToken()
      if (!token) return { content: [{ type: 'text', text: 'TELEGRAM_BOT_TOKEN not configured.' }], isError: true }
      const result = spawnSync('curl', [
        '-sf', '-F', `chat_id=${targetChatId}`,
        '-F', `document=@${filePath}`,
        `https://api.telegram.org/bot${token}/sendDocument`,
      ], { encoding: 'utf8', timeout: 30000 })
      if (result.status !== 0) {
        return { content: [{ type: 'text', text: `Failed to relay file: ${result.stderr?.trim() ?? 'unknown error'}` }], isError: true }
      }
      const filename = filePath.split('/').pop() ?? filePath
      return { content: [{ type: 'text', text: `Sent ${filename} to chat ${targetChatId}.` }] }
    }

    case 'queue_task': {
      const description = typeof args.description === 'string' ? args.description.trim() : ''
      if (!description) return { content: [{ type: 'text', text: 'Provide a task description.' }], isError: true }
      const priority = args.priority === 'high' ? 'high' as const : 'normal' as const
      const runAfter = typeof args.run_after === 'string' ? args.run_after.trim() : undefined
      const task = queueTask(description, priority, callerId ?? 'unknown', runAfter)
      const schedNote = runAfter ? ` [scheduled for ${runAfter}]` : ''
      return { content: [{ type: 'text', text: `Task queued: #${task.id.slice(0, 8)} — "${task.description}" [${priority}]${schedNote}` }] }
    }

    case 'list_queue': {
      const tasks = listQueue()
      const pending = tasks.filter(t => t.status !== 'done')
      const recentDone = tasks.filter(t => t.status === 'done').slice(-5)
      const sections: string[] = []
      if (pending.length > 0) sections.push(`Pending/Active (${pending.length}):\n${formatQueue(pending)}`)
      if (recentDone.length > 0) sections.push(`Recently completed:\n${formatQueue(recentDone)}`)
      return { content: [{ type: 'text', text: sections.length > 0 ? sections.join('\n\n') : '(queue is empty)' }] }
    }

    case 'run_task': {
      const next = listDueTasks()[0] ?? listQueue().find(t => t.status === 'pending')
      if (!next) return { content: [{ type: 'text', text: '(no pending tasks in queue)' }] }
      return { content: [{ type: 'text', text: [
        `Next task: #${next.id.slice(0, 8)} [${next.priority}]`,
        next.description,
        `Queued by: ${next.queued_by}`,
        '',
        `When done, call: complete_task with task_id="${next.id}"`,
      ].join('\n') }] }
    }

    case 'complete_task': {
      const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
      if (!taskId) return { content: [{ type: 'text', text: 'Provide task_id.' }], isError: true }
      const note = typeof args.note === 'string' ? args.note.trim() : undefined
      const allTasks = listQueue()
      const matchedId = allTasks.find(t => t.id === taskId || t.id.startsWith(taskId))?.id
      if (!matchedId) return { content: [{ type: 'text', text: `Task not found: ${taskId}` }], isError: true }
      const task = completeTask(matchedId, note)
      if (!task) return { content: [{ type: 'text', text: `Task not found: ${taskId}` }], isError: true }
      if (task.queued_by !== 'unknown') {
        const notifyText = `✅ Task complete: "${task.description}"${note ? `\n${note}` : ''}`
        sendMessage(task.queued_by, notifyText).catch(() => { /* non-fatal */ })
      }
      return { content: [{ type: 'text', text: `Completed: "${task.description}"${note ? ` — ${note}` : ''}` }] }
    }

    // ─── Turn management ──────────────────────────────────────────────

    case 'claim_turn': {
      if (!callerId) return { content: [{ type: 'text', text: 'caller_id required.' }], isError: true }
      const displayName = typeof args.display_name === 'string' ? args.display_name : callerId
      return { content: [{ type: 'text', text: JSON.stringify(claimTurn(callerId, displayName)) }] }
    }

    case 'release_turn': {
      if (!callerId) return { content: [{ type: 'text', text: 'caller_id required.' }], isError: true }
      releaseTurn(callerId)
      return { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] }
    }

    // ─── Voice ────────────────────────────────────────────────────────

    case 'transcribe_voice': {
      const filePath = typeof args.file_path === 'string' ? args.file_path.trim() : ''
      if (!filePath) return { content: [{ type: 'text', text: 'Provide file_path.' }], isError: true }
      if (spawnSync('which', ['whisper'], { encoding: 'utf8' }).status !== 0) {
        return { content: [{ type: 'text', text: 'Voice transcription is not enabled.\nThe owner can run: bash /opt/pocket-claude/install.sh --with-voice' }], isError: true }
      }
      try {
        execFileSync('whisper', [filePath, '--output-format', 'txt', '--model', 'base', '--output-dir', '/tmp'], {
          encoding: 'utf8', timeout: 60000,
        })
        const txtPath = `/tmp/${filePath.split('/').pop()!.replace(/\.[^.]+$/, '.txt')}`
        return { content: [{ type: 'text', text: `[Voice transcript]: ${readFileSync(txtPath, 'utf8').trim()}` }] }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `Transcription failed: ${msg}` }], isError: true }
      }
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  const callerId = typeof args.caller_id === 'string' ? args.caller_id : undefined
  const callerName = typeof args.display_name === 'string' ? args.display_name : callerId ?? 'unknown'

  if (callerId) {
    logAudit({ caller_id: callerId, caller_name: callerName, tool: req.params.name, args_summary: summarizeArgs(args) })
  }

  let welcomePrefix = ''
  if (callerId) {
    const { needsWelcome } = checkAndRecord(callerId)
    if (needsWelcome) {
      markWelcomed(callerId)
      welcomePrefix = WELCOME_MESSAGE + '\n\n'
    }
  }

  try {
    const result = await handleTool(req.params.name, args, callerId)
    return prependWelcome(result, welcomePrefix)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }
  }
})

await mcp.connect(new StdioServerTransport())
