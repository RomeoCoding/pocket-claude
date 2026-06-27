#!/usr/bin/env node
/**
 * pocket-claude session manager — MCP server
 *
 * Tools: list_sessions, resume_session, new_session, get_status,
 *        what_am_i_working_on, preview_session, get_logs, restart_session
 *
 * Security: all session IDs are validated against the filesystem before any
 * shell interaction. No user input is ever interpolated into shell strings.
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
} from './sessions.ts'

const TMUX_SESSION = process.env.POCKET_CLAUDE_TMUX ?? 'pocket-claude'
const STATE_FILE = join(homedir(), '.pocket-claude', 'state.json')
const TMUX_TMPDIR = join(homedir(), '.pocket-claude', 'tmux')
const tmuxEnv = { ...process.env, TMUX_TMPDIR }

process.on('unhandledRejection', err => {
  process.stderr.write(`session-manager: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', err => {
  process.stderr.write(`session-manager: uncaught exception: ${err}\n`)
})

function tmuxRunning(): boolean {
  const result = spawnSync('tmux', ['has-session', '-t', TMUX_SESSION], {
    stdio: 'ignore',
    env: tmuxEnv,
  })
  return result.status === 0
}

function claudeRunning(): boolean {
  if (!tmuxRunning()) return false
  const result = spawnSync(
    'tmux',
    ['list-panes', '-t', TMUX_SESSION, '-F', '#{pane_pid}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: tmuxEnv },
  )
  if (result.status !== 0 || !result.stdout.trim()) return false

  const panePid = result.stdout.trim().split('\n')[0]
  // pane_pid IS the claude process when started with `tmux new-session -- claude`
  const check = spawnSync('ps', ['-p', panePid, '-o', 'comm='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return (check.stdout ?? '').trim() === 'claude'
}

function switchSession(sessionId: string, isNew: boolean): void {
  if (!isNew && !isValidSessionId(sessionId)) {
    throw new Error('Invalid session ID format')
  }

  const switchScript = join(homedir(), '.pocket-claude', 'switch.sh')
  if (!existsSync(switchScript)) {
    throw new Error('Switch script not found. Was pocket-claude installed correctly?')
  }

  execFileSync('bash', [switchScript, isNew ? '--new' : '--resume', ...(isNew ? [] : [sessionId])], {
    timeout: 8000,
    stdio: 'ignore',
    env: tmuxEnv,
  })
}

function readState(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

const mcp = new Server(
  { name: 'pocket-claude-session-manager', version: '1.1.0' },
  { capabilities: { tools: {} } },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_sessions',
      description: 'List recent Claude Code sessions with index, title, age, and project path. Use the index with resume_session or preview_session.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max sessions to return (default 20, max 50)' },
        },
      },
    },
    {
      name: 'resume_session',
      description: 'Switch to a previous Claude Code session by its index from list_sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          index: { type: 'number', description: 'Session number from list_sessions (1-based)' },
          session_id: { type: 'string', description: 'Exact session UUID (alternative to index)' },
        },
      },
    },
    {
      name: 'preview_session',
      description: 'Show the last few messages from a session before resuming, to confirm it is the right one.',
      inputSchema: {
        type: 'object',
        properties: {
          index: { type: 'number', description: 'Session number from list_sessions (1-based)' },
          messages: { type: 'number', description: 'How many message pairs to show (default 3)' },
        },
        required: ['index'],
      },
    },
    {
      name: 'new_session',
      description: 'Start a fresh Claude Code session. WARNING: current context will not be preserved (session history on disk is safe).',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'restart_session',
      description: 'Restart Claude in the current session — clears the active context window but keeps you in the same session history.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_status',
      description: 'Check pocket-claude daemon health: tmux, Claude process, uptime, and current session.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'what_am_i_working_on',
      description: 'Single call to get current session title, recent context, and uptime — the quickest way to reorient after opening Telegram.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_logs',
      description: 'Return recent daemon log lines for diagnosing issues without needing SSH.',
      inputSchema: {
        type: 'object',
        properties: {
          lines: { type: 'number', description: 'Number of lines to return (default 30, max 100)' },
        },
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  try {
    switch (req.params.name) {
      case 'list_sessions': {
        const limit = typeof args.limit === 'number' ? Math.min(args.limit, 50) : 20
        const sessions = await listSessions(limit)
        return {
          content: [{ type: 'text', text: formatSessionList(sessions) }],
        }
      }

      case 'resume_session': {
        // Use same limit as list_sessions default so indexes always match
        const sessions = await listSessions(50)

        let targetId: string | undefined

        if (typeof args.index === 'number') {
          const idx = Math.floor(args.index) - 1
          if (idx < 0 || idx >= sessions.length) {
            return {
              content: [{ type: 'text', text: `No session at index ${args.index}. Run list_sessions first.` }],
              isError: true,
            }
          }
          targetId = sessions[idx].id
        } else if (typeof args.session_id === 'string') {
          const found = sessions.find(s => s.id === args.session_id)
          if (!found) {
            return {
              content: [{ type: 'text', text: 'Session not found. It may have expired or the ID is wrong.' }],
              isError: true,
            }
          }
          targetId = found.id
        } else {
          return {
            content: [{ type: 'text', text: 'Provide either index or session_id.' }],
            isError: true,
          }
        }

        const session = sessions.find(s => s.id === targetId)!
        switchSession(targetId, false)
        return {
          content: [{
            type: 'text',
            text: `Switching to: "${session.title}"\nRestarting in ~3 seconds. Pick up the conversation there.`,
          }],
        }
      }

      case 'preview_session': {
        const sessions = await listSessions(50)
        if (typeof args.index !== 'number') {
          return { content: [{ type: 'text', text: 'Provide index (from list_sessions).' }], isError: true }
        }
        const idx = Math.floor(args.index) - 1
        if (idx < 0 || idx >= sessions.length) {
          return { content: [{ type: 'text', text: `No session at index ${args.index}.` }], isError: true }
        }
        const session = sessions[idx]
        const msgCount = typeof args.messages === 'number' ? Math.min(args.messages, 10) : 3
        const preview = await getSessionPreview(session.id, msgCount)
        return {
          content: [{
            type: 'text',
            text: `Session ${args.index}: "${session.title}" [${formatAge(session.updatedAt)}]\n\n${preview}`,
          }],
        }
      }

      case 'new_session': {
        switchSession('', true)
        return {
          content: [{ type: 'text', text: 'Starting fresh session in ~3 seconds.' }],
        }
      }

      case 'restart_session': {
        const state = readState()
        const currentId = typeof state.currentSessionId === 'string' ? state.currentSessionId : ''
        if (currentId && isValidSessionId(currentId)) {
          // Resume same session — fresh context window, same history
          switchSession(currentId, false)
          return {
            content: [{ type: 'text', text: 'Restarting in current session (~3 seconds). Same history, fresh context.' }],
          }
        }
        // Unknown current session — just restart fresh
        switchSession('', true)
        return {
          content: [{ type: 'text', text: 'Current session unknown — starting fresh in ~3 seconds.' }],
        }
      }

      case 'get_status': {
        const tmux = tmuxRunning()
        const claude = claudeRunning()
        const state = readState()
        const startedAt = state.startedAt ? new Date(state.startedAt as string) : null
        const uptime = startedAt
          ? Math.floor((Date.now() - startedAt.getTime()) / 1000 / 60)
          : null
        const currentId = typeof state.currentSessionId === 'string' ? state.currentSessionId : ''

        let sessionLine = 'current session: unknown'
        if (currentId) {
          const sessions = await listSessions(50)
          const found = sessions.find(s => s.id === currentId)
          sessionLine = found
            ? `current session: "${found.title}"`
            : `current session: ${currentId.slice(0, 8)}… (title not found)`
        }

        const lines = [
          `tmux session:    ${tmux ? '✓ running' : '✗ not found'}`,
          `claude process:  ${claude ? '✓ alive' : '✗ not running'}`,
          `uptime:          ${uptime !== null ? `${uptime}m` : 'unknown'}`,
          sessionLine,
        ]
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }

      case 'what_am_i_working_on': {
        const state = readState()
        const startedAt = state.startedAt ? new Date(state.startedAt as string) : null
        const uptime = startedAt
          ? Math.floor((Date.now() - startedAt.getTime()) / 1000 / 60)
          : null
        const currentId = typeof state.currentSessionId === 'string' ? state.currentSessionId : ''

        if (!currentId || !isValidSessionId(currentId)) {
          const sessions = await listSessions(1)
          const latest = sessions[0]
          if (!latest) return { content: [{ type: 'text', text: 'No sessions found.' }] }
          const preview = await getSessionPreview(latest.id, 2)
          return {
            content: [{
              type: 'text',
              text: `Most recent session: "${latest.title}" [${formatAge(latest.updatedAt)}]\n\n${preview}`,
            }],
          }
        }

        const sessions = await listSessions(50)
        const session = sessions.find(s => s.id === currentId)
        const title = session ? session.title : '(unknown session)'
        const preview = await getSessionPreview(currentId, 2)

        return {
          content: [{
            type: 'text',
            text: [
              `Working on: "${title}"`,
              uptime !== null ? `Uptime: ${uptime}m` : '',
              '',
              preview,
            ].filter(Boolean).join('\n'),
          }],
        }
      }

      case 'get_logs': {
        const n = typeof args.lines === 'number' ? Math.min(args.lines, 100) : 30
        return { content: [{ type: 'text', text: getLocalLogs(n) }] }
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true }
  }
})

function formatAge(date: Date): string {
  const diffMs = Date.now() - date.getTime()
  const mins = Math.floor(diffMs / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

await mcp.connect(new StdioServerTransport())
