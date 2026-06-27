#!/usr/bin/env node
/**
 * pocket-claude session manager — MCP server
 *
 * Gives Claude Code tools to list and switch sessions, check daemon status,
 * and start fresh conversations — all triggerable from Telegram.
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
import { listSessions, formatSessionList, isValidSessionId } from './sessions.ts'

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
  // Check if a claude process is alive inside the tmux session
  const result = spawnSync(
    'tmux',
    ['list-panes', '-t', TMUX_SESSION, '-F', '#{pane_pid}'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: tmuxEnv },
  )
  if (result.status !== 0 || !result.stdout.trim()) return false

  const panePid = result.stdout.trim().split('\n')[0]
  const children = spawnSync('pgrep', ['-P', panePid, 'claude'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  return (children.stdout ?? '').trim().length > 0
}

// Switch sessions by restarting Claude in the tmux pane.
// session-manager cannot call "claude --resume" on itself —
// it sends the command to the tmux pane that owns the current session.
// That pane runs the watchdog start script which picks up the resume flag.
function switchSession(sessionId: string, isNew: boolean): void {
  // Safety: ID was already validated against filesystem — validate again anyway
  if (!isNew && !isValidSessionId(sessionId)) {
    throw new Error('Invalid session ID format')
  }

  const switchScript = join(homedir(), '.pocket-claude', 'switch.sh')
  if (!existsSync(switchScript)) {
    throw new Error('Switch script not found. Was pocket-claude installed correctly?')
  }

  // execFileSync with arg array — no shell, no injection possible
  execFileSync('bash', [switchScript, isNew ? '--new' : '--resume', ...(isNew ? [] : [sessionId])], {
    timeout: 5000,
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
  { name: 'pocket-claude-session-manager', version: '1.0.0' },
  { capabilities: { tools: {} } },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_sessions',
      description: 'List recent Claude Code sessions with index, title, and age. Use the index with resume_session.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Max sessions to return (default 20)',
          },
        },
      },
    },
    {
      name: 'resume_session',
      description: 'Switch to a previous Claude Code session by its index from list_sessions, or by exact session ID.',
      inputSchema: {
        type: 'object',
        properties: {
          index: {
            type: 'number',
            description: 'Session number from list_sessions (1-based)',
          },
          session_id: {
            type: 'string',
            description: 'Exact session UUID (alternative to index)',
          },
        },
      },
    },
    {
      name: 'new_session',
      description: 'Start a fresh Claude Code session, discarding current context.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_status',
      description: 'Check pocket-claude daemon health: tmux running, Claude process alive, uptime.',
      inputSchema: { type: 'object', properties: {} },
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
          // Validate against known sessions — never trust raw input
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
            text: `Switching to: "${session.title}"\nSession will restart in ~3 seconds. Continue the conversation there.`,
          }],
        }
      }

      case 'new_session': {
        switchSession('', true)
        return {
          content: [{ type: 'text', text: 'Starting fresh session in ~3 seconds.' }],
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

        const lines = [
          `tmux session: ${tmux ? '✓ running' : '✗ not found'}`,
          `claude process: ${claude ? '✓ alive' : '✗ not running'}`,
          uptime !== null ? `uptime: ${uptime}m` : 'uptime: unknown',
        ]
        return { content: [{ type: 'text', text: lines.join('\n') }] }
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

await mcp.connect(new StdioServerTransport())
