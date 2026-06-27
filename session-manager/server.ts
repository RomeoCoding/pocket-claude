#!/usr/bin/env node
/**
 * pocket-claude session manager — MCP server
 *
 * Tools: list_sessions, resume_session, preview_session, new_session,
 *        restart_session, get_status, what_am_i_working_on, get_logs,
 *        search_sessions, pin_session, unpin_session,
 *        delete_sessions, update_pocket_claude
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { spawnSync, execFileSync } from 'node:child_process'
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
import { getUserRole, requireAdmin, setUserRole } from './roles.ts'
import { sendMessage, broadcast } from './telegram.ts'
import { queueTask, listQueue, completeTask, formatQueue } from './queue.ts'
import { checkAndRecord, markWelcomed } from './seen_users.ts'

const TMUX_SESSION = process.env.POCKET_CLAUDE_TMUX ?? 'pocket-claude'
const STATE_FILE = join(homedir(), '.pocket-claude', 'state.json')
const TMUX_TMPDIR = join(homedir(), '.pocket-claude', 'tmux')
const INSTALL_DIR = '/opt/pocket-claude'
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

Drop a file here and I'll read it.
Send a voice note and I'll transcribe and act on it (if voice is enabled).

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
  // pane_pid IS the claude process when started with `tmux new-session -- claude`
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

const mcp = new Server(
  { name: 'pocket-claude-session-manager', version: '1.2.0' },
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
      i === 0 && c.type === 'text'
        ? { ...c, text: prefix + c.text }
        : c
    ),
  }
}

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_sessions',
      description: 'List recent Claude Code sessions (default 50). Pinned sessions appear first marked [P]. Use the index with resume_session or preview_session.',
      inputSchema: { type: 'object', properties: {
        limit: { type: 'number', description: 'Max sessions (default 50, max 50)' },
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
        index: { type: 'number', description: 'Session number from list_sessions (1-based)' },
      }, required: ['index'] },
    },
    {
      name: 'unpin_session',
      description: 'Remove a pin from a session.',
      inputSchema: { type: 'object', properties: {
        index: { type: 'number', description: 'Session number from list_sessions (1-based)' },
      }, required: ['index'] },
    },
    {
      name: 'new_session',
      description: 'Start a fresh Claude Code session. Pass confirmed: true to execute — without it, returns a warning first.',
      inputSchema: { type: 'object', properties: {
        confirmed: { type: 'boolean', description: 'Must be true to actually start the new session' },
      }},
    },
    {
      name: 'restart_session',
      description: 'Restart Claude in the current session — clears active context window but keeps session history.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'delete_sessions',
      description: 'Delete one session by index, or all sessions older than N days.',
      inputSchema: { type: 'object', properties: {
        index: { type: 'number', description: 'Session index to delete (1-based)' },
        older_than_days: { type: 'number', description: 'Delete all sessions older than N days' },
        confirmed: { type: 'boolean', description: 'Must be true to execute deletion' },
      }},
    },
    {
      name: 'get_status',
      description: 'Check daemon health: tmux, Claude process, uptime, current session.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'what_am_i_working_on',
      description: 'Quick summary: current session title, recent context, uptime. The fastest way to reorient after opening Telegram.',
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
      name: 'update_pocket_claude',
      description: 'Pull latest pocket-claude code from GitHub and restart the service.',
      inputSchema: { type: 'object', properties: {
        confirmed: { type: 'boolean', description: 'Must be true to execute the update' },
      }},
    },
    {
      name: 'set_user_role',
      description: 'Grant or revoke admin access for a Telegram user. Admin only. Pass caller_id (your own chat_id) and target_user_id (the user to change).',
      inputSchema: { type: 'object', properties: {
        target_user_id: { type: 'string', description: 'Telegram user ID to update' },
        role: { type: 'string', enum: ['admin', 'member'], description: 'Role to assign' },
        caller_id: { type: 'string', description: 'Your own Telegram chat_id (required for auth)' },
      }, required: ['target_user_id', 'role'] },
    },
    {
      name: 'handoff_summary',
      description: 'Generate a structured summary of current work, open tasks, and recent context — for handing off to a teammate.',
      inputSchema: { type: 'object', properties: {
        caller_id: { type: 'string', description: 'Your Telegram chat_id (optional, for onboarding tracking)' },
      }},
    },
    {
      name: 'notify_user',
      description: 'Send a Telegram message proactively — use this when a long task finishes so the user gets pinged without polling. Omit chat_id to broadcast to all users.',
      inputSchema: { type: 'object', properties: {
        message: { type: 'string', description: 'Message to send' },
        chat_id: { type: 'string', description: 'Specific Telegram chat_id to notify (omit to broadcast to all)' },
      }, required: ['message'] },
    },
    {
      name: 'queue_task',
      description: 'Add a task to the persistent queue. Claude will work through queued tasks and notify you when each is done.',
      inputSchema: { type: 'object', properties: {
        description: { type: 'string', description: 'What needs to be done' },
        priority: { type: 'string', enum: ['high', 'normal'], description: 'Priority (default: normal)' },
        caller_id: { type: 'string', description: 'Your Telegram chat_id (used to notify you on completion)' },
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
      name: 'complete_task',
      description: 'Mark a queued task as done. Automatically notifies the user who queued it.',
      inputSchema: { type: 'object', properties: {
        task_id: { type: 'string', description: 'Task ID from list_queue (full UUID or first 8 chars)' },
        note: { type: 'string', description: 'Optional completion note (e.g. "3 files changed")' },
        caller_id: { type: 'string', description: 'Your Telegram chat_id (optional)' },
      }, required: ['task_id'] },
    },
  ],
}))

async function handleTool(
  name: string,
  args: Record<string, unknown>,
  callerId: string | undefined,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  switch (name) {

      case 'list_sessions': {
        const limit = typeof args.limit === 'number' ? Math.min(args.limit, 50) : 50
        const sessions = await listSessions(limit)
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

      case 'preview_session': {
        const sessions = await listSessions(50)
        if (typeof args.index !== 'number') return { content: [{ type: 'text', text: 'Provide index.' }], isError: true }
        const idx = Math.floor(args.index) - 1
        if (idx < 0 || idx >= sessions.length) return { content: [{ type: 'text', text: `No session at index ${args.index}.` }], isError: true }
        const session = sessions[idx]
        const msgCount = typeof args.messages === 'number' ? Math.min(args.messages, 10) : 3
        const preview = await getSessionPreview(session.id, msgCount, session.filePath)
        const pin = session.pinned ? ' [P]' : ''
        return { content: [{ type: 'text', text: `Session ${args.index}${pin}: "${session.title}" [${formatAge(session.updatedAt)}]\n\n${preview}` }] }
      }

      case 'pin_session': {
        const sessions = await listSessions(50)
        if (typeof args.index !== 'number') return { content: [{ type: 'text', text: 'Provide index.' }], isError: true }
        const idx = Math.floor(args.index) - 1
        if (idx < 0 || idx >= sessions.length) return { content: [{ type: 'text', text: `No session at index ${args.index}.` }], isError: true }
        const session = sessions[idx]
        await pinSession(session.id)
        return { content: [{ type: 'text', text: `Pinned: "${session.title}" — it will appear at the top of list_sessions.` }] }
      }

      case 'unpin_session': {
        const sessions = await listSessions(50)
        if (typeof args.index !== 'number') return { content: [{ type: 'text', text: 'Provide index.' }], isError: true }
        const idx = Math.floor(args.index) - 1
        if (idx < 0 || idx >= sessions.length) return { content: [{ type: 'text', text: `No session at index ${args.index}.` }], isError: true }
        const session = sessions[idx]
        await unpinSession(session.id)
        return { content: [{ type: 'text', text: `Unpinned: "${session.title}".` }] }
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
        // Empty currentSessionId means a new/unnamed session — restart it as new
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
            return { content: [{ type: 'text', text: 'older_than_days must be at least 1 to prevent accidental deletion of all sessions.' }], isError: true }
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
          return { content: [{ type: 'text', text: `Deleted: "${session.title}".` }] }
        }
        return { content: [{ type: 'text', text: 'Provide index or older_than_days.' }], isError: true }
      }

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
          sessionLine = found ? `current session: "${found.title}"` : `current session: ${currentId.slice(0, 8)}… (title not found)`
        }

        return { content: [{ type: 'text', text: [
          `tmux session:    ${tmux ? 'running' : 'NOT FOUND'}`,
          `claude process:  ${claude ? 'alive' : 'NOT RUNNING'}`,
          `uptime:          ${uptime !== null ? `${uptime}m` : 'unknown'}`,
          sessionLine,
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
        const title = session ? session.title : '(unknown)'
        const matchedSession = sessions.find(s => s.id === currentId)
        const preview = await getSessionPreview(currentId, 2, matchedSession?.filePath)
        return { content: [{ type: 'text', text: [
          `Working on: "${title}"`,
          uptime !== null ? `Uptime: ${uptime}m` : '',
          '',
          preview,
        ].filter(Boolean).join('\n') }] }
      }

      case 'get_logs': {
        const n = typeof args.lines === 'number' ? Math.min(args.lines, 100) : 30
        return { content: [{ type: 'text', text: await getLocalLogs(n) }] }
      }

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

      case 'handoff_summary': {
        const state = readState()
        const currentId = typeof state.currentSessionId === 'string' ? state.currentSessionId : ''
        const sessions = await listSessions(50)
        const current = sessions.find(s => s.id === currentId)
        const preview = current
          ? await getSessionPreview(currentId, 2, current.filePath)
          : '(no active session)'
        const queue = listQueue().filter(t => t.status !== 'done')

        const lines = [
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
            : queue.map(t => `${t.priority === 'high' ? '🔴' : '⏳'} ${t.description} (queued by ${t.queued_by})`).join('\n'),
        ]
        return { content: [{ type: 'text', text: lines.join('\n') }] }
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
            await broadcast(message)
            return { content: [{ type: 'text', text: 'Broadcast sent to all users.' }] }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          return { content: [{ type: 'text', text: `Notification failed: ${msg}` }], isError: true }
        }
      }

      case 'queue_task': {
        const description = typeof args.description === 'string' ? args.description.trim() : ''
        if (!description) return { content: [{ type: 'text', text: 'Provide a task description.' }], isError: true }
        const priority = args.priority === 'high' ? 'high' as const : 'normal' as const
        const task = queueTask(description, priority, callerId ?? 'unknown')
        return { content: [{ type: 'text', text: `Task queued: #${task.id.slice(0, 8)} — "${task.description}" [${priority}]` }] }
      }

      case 'list_queue': {
        const tasks = listQueue()
        const pending = tasks.filter(t => t.status !== 'done')
        const recentDone = tasks.filter(t => t.status === 'done').slice(-5)
        const sections: string[] = []
        if (pending.length > 0) sections.push(`Pending/Active (${pending.length}):\n${formatQueue(pending)}`)
        if (recentDone.length > 0) sections.push(`Recently completed:\n${formatQueue(recentDone)}`)
        const text = sections.length > 0 ? sections.join('\n\n') : '(queue is empty)'
        return { content: [{ type: 'text', text }] }
      }

      case 'complete_task': {
        const taskId = typeof args.task_id === 'string' ? args.task_id.trim() : ''
        if (!taskId) return { content: [{ type: 'text', text: 'Provide task_id.' }], isError: true }
        const note = typeof args.note === 'string' ? args.note.trim() : undefined
        // Support both full UUID and 8-char prefix
        const allTasks = listQueue()
        const matchedId = allTasks.find(t => t.id === taskId || t.id.startsWith(taskId))?.id
        if (!matchedId) return { content: [{ type: 'text', text: `Task not found: ${taskId}` }], isError: true }
        const task = completeTask(matchedId, note)
        if (!task) return { content: [{ type: 'text', text: `Task not found: ${taskId}` }], isError: true }
        // Notify the user who queued it
        const notifyTarget = task.queued_by !== 'unknown' ? task.queued_by : null
        const notifyText = `✅ Task complete: "${task.description}"${note ? `\n${note}` : ''}`
        if (notifyTarget) {
          sendMessage(notifyTarget, notifyText).catch(() => { /* non-fatal */ })
        }
        return { content: [{ type: 'text', text: `Completed: "${task.description}"${note ? ` — ${note}` : ''}` }] }
      }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  }
}

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  const callerId = typeof args.caller_id === 'string' ? args.caller_id : undefined

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
