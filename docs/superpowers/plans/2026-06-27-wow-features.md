# pocket-claude WOW Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add team roles, async task notifications, a task queue, user onboarding, and optional voice transcription to make pocket-claude a compelling shareable product.

**Architecture:** Three new helper modules (`roles.ts`, `telegram.ts`, `queue.ts`, `seen_users.ts`) keep business logic out of server.ts. The MCP server reads an optional `caller_id` arg (Telegram chat_id) from every tool call to enforce roles and track onboarding — Claude is instructed to pass it via CLAUDE.md on the VM. All file paths are overridable via env vars for testing.

**Tech Stack:** Node 22 (--experimental-strip-types), TypeScript 5.8, ESM modules, node:test + node:assert/strict for tests, Telegram Bot API (fetch, no extra lib).

**Spec:** `docs/superpowers/specs/2026-06-27-wow-features-design.md`

**Implementation order:** Phase 1 (roles) → Phase 2 (notifications + queue) → Phase 3 (onboarding + voice). Each phase is independently testable.

---

## File Map

| File | Action | Responsibility |
|---|---|---|
| `session-manager/roles.ts` | Create | Read/write/check user roles from access.json |
| `session-manager/telegram.ts` | Create | Send Telegram messages via Bot API |
| `session-manager/queue.ts` | Create | Task queue CRUD (JSONL storage) |
| `session-manager/seen_users.ts` | Create | First-contact tracking, welcomed flag |
| `session-manager/tests/roles.test.ts` | Create | Unit tests for roles.ts |
| `session-manager/tests/telegram.test.ts` | Create | Unit tests for telegram.ts helpers |
| `session-manager/tests/queue.test.ts` | Create | Unit tests for queue.ts |
| `session-manager/tests/seen_users.test.ts` | Create | Unit tests for seen_users.ts |
| `session-manager/server.ts` | Modify | Add 6 new tools, global role + onboarding middleware |
| `session-manager/package.json` | Modify | Add test script |
| `install.sh` | Modify | Auto-set first admin, append CLAUDE.md instruction, --with-voice flag |
| `docs/getting-started.md` | Modify | Group mode + BotFather setup instructions |

---

## Phase 1 — Team Collaboration

### Task 1: Create `session-manager/roles.ts`

**Files:**
- Create: `session-manager/roles.ts`

- [ ] **Step 1: Create the file**

```typescript
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export type Role = 'admin' | 'member'

const ACCESS_FILE =
  process.env._PC_ACCESS_FILE ?? join(homedir(), '.pocket-claude', 'access.json')

function readAccess(): Record<string, unknown> {
  try { return JSON.parse(readFileSync(ACCESS_FILE, 'utf8')) } catch { return {} }
}

function writeAccess(data: Record<string, unknown>): void {
  writeFileSync(ACCESS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 })
}

export function getUserRole(userId: string): Role {
  if (!userId) return 'member'
  const access = readAccess()
  const roles = (access.roles ?? {}) as Record<string, string>
  return roles[userId] === 'admin' ? 'admin' : 'member'
}

export async function setUserRole(userId: string, role: Role): Promise<void> {
  const access = readAccess()
  const roles = (access.roles ?? {}) as Record<string, string>
  roles[userId] = role
  writeAccess({ ...access, roles })
}

export function requireAdmin(callerId: string | undefined): { ok: true } | { ok: false; error: string } {
  if (!callerId) {
    return { ok: false, error: 'caller_id not provided. Claude should pass the Telegram chat_id as caller_id for this tool.' }
  }
  if (getUserRole(callerId) !== 'admin') {
    return { ok: false, error: 'This action requires admin role. Ask the pocket-claude owner to grant you access via set_user_role.' }
  }
  return { ok: true }
}
```

- [ ] **Step 2: Commit**

```bash
git add session-manager/roles.ts
git commit -m "feat: add roles.ts - role reading/enforcement for team collaboration"
```

---

### Task 2: Add test script + write roles tests

**Files:**
- Modify: `session-manager/package.json`
- Create: `session-manager/tests/roles.test.ts`

- [ ] **Step 1: Add test script to package.json**

Replace the `"scripts"` block:
```json
"scripts": {
  "start": "node --experimental-strip-types server.ts",
  "build": "tsc",
  "test": "node --experimental-strip-types --test tests/*.test.ts"
},
```

- [ ] **Step 2: Create `session-manager/tests/` directory and write the test file**

```typescript
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), `roles-test-${Date.now()}`)
const ACCESS_FILE = join(TEST_DIR, 'access.json')

before(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  process.env._PC_ACCESS_FILE = ACCESS_FILE
})

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  delete process.env._PC_ACCESS_FILE
})

function writeAccess(data: Record<string, unknown>) {
  writeFileSync(ACCESS_FILE, JSON.stringify(data))
}

test('getUserRole returns member for unknown user', async () => {
  const { getUserRole } = await import('../roles.ts')
  writeAccess({ allowFrom: ['111'] })
  assert.equal(getUserRole('999'), 'member')
})

test('getUserRole returns admin when set', async () => {
  const { getUserRole } = await import('../roles.ts')
  writeAccess({ allowFrom: ['111'], roles: { '111': 'admin' } })
  assert.equal(getUserRole('111'), 'admin')
})

test('getUserRole returns member when role is member', async () => {
  const { getUserRole } = await import('../roles.ts')
  writeAccess({ roles: { '222': 'member' } })
  assert.equal(getUserRole('222'), 'member')
})

test('setUserRole writes role to access.json', async () => {
  const { setUserRole, getUserRole } = await import('../roles.ts')
  writeAccess({ allowFrom: ['333'] })
  await setUserRole('333', 'admin')
  assert.equal(getUserRole('333'), 'admin')
})

test('requireAdmin returns ok for admin', async () => {
  const { requireAdmin } = await import('../roles.ts')
  writeAccess({ roles: { '111': 'admin' } })
  const result = requireAdmin('111')
  assert.equal(result.ok, true)
})

test('requireAdmin returns error for member', async () => {
  const { requireAdmin } = await import('../roles.ts')
  writeAccess({ roles: { '222': 'member' } })
  const result = requireAdmin('222')
  assert.equal(result.ok, false)
  assert.ok((result as { ok: false; error: string }).error.includes('admin'))
})

test('requireAdmin returns error when callerId is undefined', async () => {
  const { requireAdmin } = await import('../roles.ts')
  const result = requireAdmin(undefined)
  assert.equal(result.ok, false)
})
```

- [ ] **Step 3: Run tests**

```bash
cd session-manager && npm test
```

Expected output: `7 passing`

- [ ] **Step 4: Commit**

```bash
git add session-manager/package.json session-manager/tests/roles.test.ts
git commit -m "test: add roles.ts tests and test script"
```

---

### Task 3: Role enforcement in existing server.ts tools

**Files:**
- Modify: `session-manager/server.ts`

The four existing tools that are destructive — `delete_sessions`, `update_pocket_claude`, `new_session`, `restart_session` — must check caller role before executing.

- [ ] **Step 1: Add import at the top of server.ts**

After the existing imports block, add:
```typescript
import { getUserRole, requireAdmin } from './roles.ts'
```

- [ ] **Step 2: Add global caller_id extraction before the switch statement**

In `mcp.setRequestHandler(CallToolRequestSchema, async req => {`, after `const args = ...`, add:

```typescript
const callerId = typeof args.caller_id === 'string' ? args.caller_id : undefined
```

- [ ] **Step 3: Add role guard to `new_session` case**

Replace the start of the `new_session` case:
```typescript
case 'new_session': {
  const roleCheck = requireAdmin(callerId)
  if (!roleCheck.ok) return { content: [{ type: 'text', text: roleCheck.error }], isError: true }
  if (args.confirmed !== true) {
    return { content: [{ type: 'text', text: 'This will discard your current context window (session history on disk stays safe).\nCall new_session again with confirmed: true to proceed.' }] }
  }
  switchSession('', true)
  return { content: [{ type: 'text', text: 'Starting fresh session in ~3 seconds.' }] }
}
```

- [ ] **Step 4: Add role guard to `restart_session` case**

Replace the start of the `restart_session` case:
```typescript
case 'restart_session': {
  const roleCheck = requireAdmin(callerId)
  if (!roleCheck.ok) return { content: [{ type: 'text', text: roleCheck.error }], isError: true }
  const state = readState()
  // ... rest of existing code unchanged
```

- [ ] **Step 5: Add role guard to `delete_sessions` case**

After `const args = ...` inside the case (before the `confirmed !== true` check), add:
```typescript
case 'delete_sessions': {
  const roleCheck = requireAdmin(callerId)
  if (!roleCheck.ok) return { content: [{ type: 'text', text: roleCheck.error }], isError: true }
  // ... rest of existing code unchanged
```

- [ ] **Step 6: Add role guard to `update_pocket_claude` case**

```typescript
case 'update_pocket_claude': {
  const roleCheck = requireAdmin(callerId)
  if (!roleCheck.ok) return { content: [{ type: 'text', text: roleCheck.error }], isError: true }
  // ... rest of existing code unchanged
```

- [ ] **Step 7: Verify the server still starts**

```bash
cd session-manager && node --experimental-strip-types server.ts &
sleep 2 && kill %1
```

Expected: no crash output, process starts and exits cleanly.

- [ ] **Step 8: Commit**

```bash
git add session-manager/server.ts
git commit -m "feat: enforce admin role on destructive MCP tools"
```

---

### Task 4: Add `set_user_role` and `handoff_summary` tools

**Files:**
- Modify: `session-manager/server.ts`

- [ ] **Step 1: Add `set_user_role` and `handoff_summary` to the tools list in `ListToolsRequestSchema` handler**

After the `update_pocket_claude` tool entry in the `tools: [...]` array, add:

```typescript
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
```

- [ ] **Step 2: Add import for `setUserRole` at the top of server.ts**

Update the existing roles import:
```typescript
import { getUserRole, requireAdmin, setUserRole } from './roles.ts'
```

- [ ] **Step 3: Add cases to the switch statement (before the `default` case)**

```typescript
case 'set_user_role': {
  const roleCheck = requireAdmin(callerId)
  if (!roleCheck.ok) return { content: [{ type: 'text', text: roleCheck.error }], isError: true }
  const targetId = typeof args.target_user_id === 'string' ? args.target_user_id.trim() : ''
  const role = args.role === 'admin' ? 'admin' : 'member'
  if (!targetId) return { content: [{ type: 'text', text: 'Provide target_user_id.' }], isError: true }
  await setUserRole(targetId, role)
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

  const lines = [
    `📋 Handoff Summary — ${new Date().toLocaleString()}`,
    '',
    `Session: "${current?.title ?? 'unknown'}"`,
    `Project: ${current?.projectPath ?? 'unknown'}`,
    `Last active: ${current ? formatAge(current.updatedAt) : 'unknown'}`,
    '',
    '--- Recent context ---',
    preview,
  ]
  return { content: [{ type: 'text', text: lines.join('\n') }] }
}
```

Note: The queue section will be added to `handoff_summary` in Task 12 after queue.ts exists.

- [ ] **Step 4: Verify server starts**

```bash
cd session-manager && node --experimental-strip-types server.ts &
sleep 2 && kill %1
```

- [ ] **Step 5: Commit**

```bash
git add session-manager/server.ts
git commit -m "feat: add set_user_role and handoff_summary MCP tools"
```

---

### Task 5: Update `install.sh` — default admin + CLAUDE.md instruction

**Files:**
- Modify: `install.sh`

- [ ] **Step 1: Find the section in install.sh that writes access.json and add default admin role**

Find the block that creates/writes `access.json` (search for `allowFrom`). After the block that sets `allowFrom`, add:

```bash
# Set first user as admin if roles key is absent (fresh install only)
if ! python3 -c "import json,sys; d=json.load(open('$STATE_DIR/access.json')); sys.exit(0 if 'roles' in d else 1)" 2>/dev/null; then
  FIRST_USER=$(python3 -c "import json; d=json.load(open('$STATE_DIR/access.json')); print(d['allowFrom'][0])" 2>/dev/null || echo "")
  if [[ -n "$FIRST_USER" ]]; then
    python3 -c "
import json
f='$STATE_DIR/access.json'
d=json.load(open(f))
d['roles'] = {'$FIRST_USER': 'admin'}
json.dump(d, open(f,'w'), indent=2)
"
    info "Set $FIRST_USER as admin in access.json"
  fi
fi
```

- [ ] **Step 2: Append the caller_id system prompt instruction to CLAUDE.md on the VM**

Find the post-install section of install.sh (after the service starts) and add:

```bash
# Append caller_id instruction to CLAUDE.md (idempotent)
CLAUDE_MD="$HOME/.claude/CLAUDE.md"
mkdir -p "$HOME/.claude"
if ! grep -q 'pocket-claude role enforcement' "$CLAUDE_MD" 2>/dev/null; then
  cat >> "$CLAUDE_MD" << 'CLAUDE_MD_EOF'

## pocket-claude role enforcement
When a Telegram message arrives via <channel source="telegram" chat_id="X">,
always pass chat_id X as `caller_id` when calling any MCP tool.
This is required for role checks and onboarding tracking.
CLAUDE_MD_EOF
  info "Appended caller_id instruction to $CLAUDE_MD"
fi
```

- [ ] **Step 3: Commit**

```bash
git add install.sh
git commit -m "feat: install.sh - auto-set first admin and append CLAUDE.md caller_id instruction"
```

---

## Phase 2 — Async Notifications & Task Queue

### Task 6: Create `session-manager/telegram.ts`

**Files:**
- Create: `session-manager/telegram.ts`

- [ ] **Step 1: Create the file**

```typescript
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
```

- [ ] **Step 2: Commit**

```bash
git add session-manager/telegram.ts
git commit -m "feat: add telegram.ts - Bot API sendMessage and broadcast helpers"
```

---

### Task 7: Write `tests/telegram.test.ts`

**Files:**
- Create: `session-manager/tests/telegram.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), `telegram-test-${Date.now()}`)
const ENV_FILE = join(TEST_DIR, '.env')
const ACCESS_FILE = join(TEST_DIR, 'access.json')

before(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  process.env._PC_ENV_FILE = ENV_FILE
  process.env._PC_ACCESS_FILE = ACCESS_FILE
})

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  delete process.env._PC_ENV_FILE
  delete process.env._PC_ACCESS_FILE
})

test('getBotToken reads token from .env', async () => {
  const { getBotToken } = await import('../telegram.ts')
  writeFileSync(ENV_FILE, 'TELEGRAM_TOKEN=abc123\nOTHER=value\n')
  assert.equal(getBotToken(), 'abc123')
})

test('getBotToken handles token with = in value', async () => {
  const { getBotToken } = await import('../telegram.ts')
  writeFileSync(ENV_FILE, 'TELEGRAM_TOKEN=abc=def==\n')
  assert.equal(getBotToken(), 'abc=def==')
})

test('getBotToken returns empty string when .env missing', async () => {
  const { getBotToken } = await import('../telegram.ts')
  process.env._PC_ENV_FILE = join(TEST_DIR, 'nonexistent.env')
  assert.equal(getBotToken(), '')
  process.env._PC_ENV_FILE = ENV_FILE
})

test('getNotifyTargets returns users and group IDs', async () => {
  const { getNotifyTargets } = await import('../telegram.ts')
  writeFileSync(ACCESS_FILE, JSON.stringify({
    allowFrom: ['111', '222'],
    groups: { '-100abc': 'mygroup' },
  }))
  const targets = getNotifyTargets()
  assert.ok(targets.includes('111'))
  assert.ok(targets.includes('222'))
  assert.ok(targets.includes('-100abc'))
  assert.equal(targets.length, 3)
})

test('getNotifyTargets returns empty array when access.json missing', async () => {
  const { getNotifyTargets } = await import('../telegram.ts')
  process.env._PC_ACCESS_FILE = join(TEST_DIR, 'nofile.json')
  assert.deepEqual(getNotifyTargets(), [])
  process.env._PC_ACCESS_FILE = ACCESS_FILE
})
```

- [ ] **Step 2: Run tests**

```bash
cd session-manager && npm test
```

Expected: all tests pass (sendMessage/broadcast require a real token so they're not unit-tested here — they'll be verified manually after deploy).

- [ ] **Step 3: Commit**

```bash
git add session-manager/tests/telegram.test.ts
git commit -m "test: add telegram.ts unit tests"
```

---

### Task 8: Add `notify_user` tool to server.ts

**Files:**
- Modify: `session-manager/server.ts`

- [ ] **Step 1: Add import at top of server.ts**

```typescript
import { sendMessage, broadcast } from './telegram.ts'
```

- [ ] **Step 2: Add `notify_user` to the tools list (after `handoff_summary`)**

```typescript
{
  name: 'notify_user',
  description: 'Send a Telegram message proactively — use this when a long task finishes so the user gets pinged without polling. Omit chat_id to broadcast to all users.',
  inputSchema: { type: 'object', properties: {
    message: { type: 'string', description: 'Message to send' },
    chat_id: { type: 'string', description: 'Specific Telegram chat_id to notify (omit to broadcast to all)' },
  }, required: ['message'] },
},
```

- [ ] **Step 3: Add case to the switch statement**

```typescript
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
```

- [ ] **Step 4: Verify server starts**

```bash
cd session-manager && node --experimental-strip-types server.ts &
sleep 2 && kill %1
```

- [ ] **Step 5: Commit**

```bash
git add session-manager/server.ts
git commit -m "feat: add notify_user MCP tool - proactive Telegram notifications"
```

---

### Task 9: Create `session-manager/queue.ts`

**Files:**
- Create: `session-manager/queue.ts`

- [ ] **Step 1: Create the file**

```typescript
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export type TaskStatus = 'pending' | 'in_progress' | 'done'
export type TaskPriority = 'high' | 'normal'

export type Task = {
  id: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  queued_by: string
  queued_at: string
  completed_at: string | null
  note: string | null
}

const QUEUE_FILE =
  process.env._PC_QUEUE_FILE ?? join(homedir(), '.pocket-claude', 'queue.jsonl')

function readAllTasks(): Task[] {
  if (!existsSync(QUEUE_FILE)) return []
  return readFileSync(QUEUE_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try { return [JSON.parse(line) as Task] } catch { return [] }
    })
}

function writeAllTasks(tasks: Task[]): void {
  writeFileSync(QUEUE_FILE, tasks.map(t => JSON.stringify(t)).join('\n') + '\n', { mode: 0o600 })
}

export function queueTask(
  description: string,
  priority: TaskPriority = 'normal',
  queuedBy = 'unknown',
): Task {
  const task: Task = {
    id: randomUUID(),
    description,
    status: 'pending',
    priority,
    queued_by: queuedBy,
    queued_at: new Date().toISOString(),
    completed_at: null,
    note: null,
  }
  appendFileSync(QUEUE_FILE, JSON.stringify(task) + '\n', { mode: 0o600 })
  return task
}

export function listQueue(): Task[] {
  return readAllTasks().sort((a, b) => {
    // High priority first, then by queue order (oldest first)
    if (a.priority !== b.priority) return a.priority === 'high' ? -1 : 1
    return new Date(a.queued_at).getTime() - new Date(b.queued_at).getTime()
  })
}

export function completeTask(taskId: string, note?: string): Task | null {
  const tasks = readAllTasks()
  const idx = tasks.findIndex(t => t.id === taskId)
  if (idx === -1) return null
  tasks[idx] = {
    ...tasks[idx],
    status: 'done',
    completed_at: new Date().toISOString(),
    note: note ?? null,
  }
  writeAllTasks(tasks)
  return tasks[idx]
}

export function getTask(taskId: string): Task | null {
  return readAllTasks().find(t => t.id === taskId) ?? null
}

export function formatQueue(tasks: Task[]): string {
  if (tasks.length === 0) return '(queue is empty)'
  const statusEmoji = (s: TaskStatus) =>
    s === 'done' ? '✅' : s === 'in_progress' ? '🔄' : '⏳'
  const priorityTag = (p: TaskPriority) => p === 'high' ? ' 🔴' : ''
  return tasks
    .map((t, i) => {
      const age = Math.floor((Date.now() - new Date(t.queued_at).getTime()) / 60_000)
      const ageStr = age < 60 ? `${age}m` : `${Math.floor(age / 60)}h`
      return `${i + 1}. ${statusEmoji(t.status)}${priorityTag(t.priority)} ${t.description} [${ageStr} ago, by ${t.queued_by}]${t.note ? `\n   → ${t.note}` : ''}`
    })
    .join('\n')
}
```

- [ ] **Step 2: Commit**

```bash
git add session-manager/queue.ts
git commit -m "feat: add queue.ts - persistent task queue with JSONL storage"
```

---

### Task 10: Write `tests/queue.test.ts`

**Files:**
- Create: `session-manager/tests/queue.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), `queue-test-${Date.now()}`)
const QUEUE_FILE = join(TEST_DIR, 'queue.jsonl')

before(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  process.env._PC_QUEUE_FILE = QUEUE_FILE
})

beforeEach(() => {
  if (existsSync(QUEUE_FILE)) unlinkSync(QUEUE_FILE)
})

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  delete process.env._PC_QUEUE_FILE
})

test('queueTask creates a task with correct fields', async () => {
  const { queueTask } = await import('../queue.ts')
  const task = queueTask('fix the login bug', 'high', '12345')
  assert.equal(task.description, 'fix the login bug')
  assert.equal(task.priority, 'high')
  assert.equal(task.queued_by, '12345')
  assert.equal(task.status, 'pending')
  assert.ok(task.id.length > 0)
  assert.equal(task.completed_at, null)
  assert.equal(task.note, null)
})

test('listQueue returns tasks sorted high priority first', async () => {
  const { queueTask, listQueue } = await import('../queue.ts')
  queueTask('normal task', 'normal', 'u1')
  queueTask('urgent task', 'high', 'u1')
  const tasks = listQueue()
  assert.equal(tasks[0].priority, 'high')
  assert.equal(tasks[1].priority, 'normal')
})

test('completeTask marks task done and sets note', async () => {
  const { queueTask, completeTask, getTask } = await import('../queue.ts')
  const task = queueTask('write tests', 'normal', 'u1')
  const done = completeTask(task.id, '42 tests written')
  assert.ok(done !== null)
  assert.equal(done!.status, 'done')
  assert.equal(done!.note, '42 tests written')
  assert.ok(done!.completed_at !== null)
})

test('completeTask returns null for unknown id', async () => {
  const { completeTask } = await import('../queue.ts')
  assert.equal(completeTask('nonexistent-id'), null)
})

test('getTask finds task by id', async () => {
  const { queueTask, getTask } = await import('../queue.ts')
  const task = queueTask('find me', 'normal', 'u1')
  const found = getTask(task.id)
  assert.ok(found !== null)
  assert.equal(found!.description, 'find me')
})

test('listQueue returns empty array when queue is empty', async () => {
  const { listQueue } = await import('../queue.ts')
  assert.deepEqual(listQueue(), [])
})

test('formatQueue returns empty message for empty list', async () => {
  const { formatQueue } = await import('../queue.ts')
  assert.equal(formatQueue([]), '(queue is empty)')
})
```

- [ ] **Step 2: Run all tests**

```bash
cd session-manager && npm test
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add session-manager/tests/queue.test.ts
git commit -m "test: add queue.ts unit tests"
```

---

### Task 11: Add `queue_task`, `list_queue`, `complete_task` tools to server.ts

**Files:**
- Modify: `session-manager/server.ts`

- [ ] **Step 1: Add imports at top of server.ts**

```typescript
import { queueTask, listQueue, completeTask, formatQueue } from './queue.ts'
```

- [ ] **Step 2: Add three tools to the tools list (after `notify_user`)**

```typescript
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
    task_id: { type: 'string', description: 'Task ID from list_queue' },
    note: { type: 'string', description: 'Optional completion note (e.g. "3 files changed")' },
    caller_id: { type: 'string', description: 'Your Telegram chat_id (optional)' },
  }, required: ['task_id'] },
},
```

- [ ] **Step 3: Add cases to the switch statement**

```typescript
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
  const tasks = listQueue()
  const matchedId = tasks.find(t => t.id === taskId || t.id.startsWith(taskId))?.id
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
```

- [ ] **Step 4: Update `handoff_summary` case to include queue state**

Find the `handoff_summary` case from Task 4 and update the `lines` array:

```typescript
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
```

- [ ] **Step 5: Verify server starts**

```bash
cd session-manager && node --experimental-strip-types server.ts &
sleep 2 && kill %1
```

- [ ] **Step 6: Commit**

```bash
git add session-manager/server.ts
git commit -m "feat: add queue_task, list_queue, complete_task MCP tools with auto-notify on completion"
```

---

## Phase 3 — Onboarding & Voice

### Task 12: Create `session-manager/seen_users.ts`

**Files:**
- Create: `session-manager/seen_users.ts`

- [ ] **Step 1: Create the file**

```typescript
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

type UserRecord = { first_seen: string; welcomed: boolean }
type SeenUsers = Record<string, UserRecord>

const SEEN_FILE =
  process.env._PC_SEEN_FILE ?? join(homedir(), '.pocket-claude', 'seen_users.json')

function read(): SeenUsers {
  try { return JSON.parse(readFileSync(SEEN_FILE, 'utf8')) } catch { return {} }
}

function write(data: SeenUsers): void {
  writeFileSync(SEEN_FILE, JSON.stringify(data, null, 2), { mode: 0o600 })
}

// Returns true if this is the user's first contact and they haven't been welcomed yet.
export function checkAndRecord(userId: string): { needsWelcome: boolean } {
  const data = read()
  if (!data[userId]) {
    data[userId] = { first_seen: new Date().toISOString(), welcomed: false }
    write(data)
    return { needsWelcome: true }
  }
  return { needsWelcome: !data[userId].welcomed }
}

export function markWelcomed(userId: string): void {
  const data = read()
  if (data[userId]) {
    data[userId].welcomed = true
    write(data)
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add session-manager/seen_users.ts
git commit -m "feat: add seen_users.ts - first-contact tracking for onboarding"
```

---

### Task 13: Write `tests/seen_users.test.ts`

**Files:**
- Create: `session-manager/tests/seen_users.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_DIR = join(tmpdir(), `seen-test-${Date.now()}`)
const SEEN_FILE = join(TEST_DIR, 'seen_users.json')

before(() => {
  mkdirSync(TEST_DIR, { recursive: true })
  process.env._PC_SEEN_FILE = SEEN_FILE
})

beforeEach(() => {
  if (existsSync(SEEN_FILE)) unlinkSync(SEEN_FILE)
})

after(() => {
  rmSync(TEST_DIR, { recursive: true, force: true })
  delete process.env._PC_SEEN_FILE
})

test('first contact returns needsWelcome: true', async () => {
  const { checkAndRecord } = await import('../seen_users.ts')
  const result = checkAndRecord('111')
  assert.equal(result.needsWelcome, true)
})

test('second contact before welcome returns needsWelcome: true', async () => {
  const { checkAndRecord } = await import('../seen_users.ts')
  checkAndRecord('111')
  const result = checkAndRecord('111')
  assert.equal(result.needsWelcome, true)
})

test('after markWelcomed, needsWelcome is false', async () => {
  const { checkAndRecord, markWelcomed } = await import('../seen_users.ts')
  checkAndRecord('111')
  markWelcomed('111')
  const result = checkAndRecord('111')
  assert.equal(result.needsWelcome, false)
})

test('different users are tracked independently', async () => {
  const { checkAndRecord, markWelcomed } = await import('../seen_users.ts')
  checkAndRecord('111')
  markWelcomed('111')
  const result = checkAndRecord('222')
  assert.equal(result.needsWelcome, true)
})
```

- [ ] **Step 2: Run all tests**

```bash
cd session-manager && npm test
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add session-manager/tests/seen_users.test.ts
git commit -m "test: add seen_users.ts unit tests"
```

---

### Task 14: Add welcome injection to server.ts

**Files:**
- Modify: `session-manager/server.ts`

The welcome prefix is prepended to any tool response for a user's first interaction.

- [ ] **Step 1: Add import at top of server.ts**

```typescript
import { checkAndRecord, markWelcomed } from './seen_users.ts'
```

- [ ] **Step 2: Define the welcome message constant (near the top, after imports)**

```typescript
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
```

- [ ] **Step 3: Add welcome check in the request handler, after `const callerId = ...`**

```typescript
// Onboarding: prepend welcome message for first-time users
let welcomePrefix = ''
if (callerId) {
  const { needsWelcome } = checkAndRecord(callerId)
  if (needsWelcome) {
    markWelcomed(callerId)
    welcomePrefix = WELCOME_MESSAGE + '\n\n'
  }
}
```

- [ ] **Step 4: Update the response wrapper at the end of the try block**

Wrap the switch statement's return in a helper that prepends the welcome. Add a helper function after the imports:

```typescript
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
```

Then wrap every `return { content: ... }` inside the try block by replacing the existing pattern. Since there are many returns, the cleanest approach is to capture the result before returning:

Replace the structure of the handler:

```typescript
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
```

Extract the entire existing switch block into a new async function. Add this function signature immediately before `mcp.setRequestHandler(CallToolRequestSchema, ...)`:

```typescript
async function handleTool(
  name: string,
  args: Record<string, unknown>,
  callerId: string | undefined,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  switch (name) {
    // paste all existing case blocks here, unchanged
    // the `callerId` variable is now the parameter, not extracted from args
    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true }
  }
}
```

Then replace the entire body of `mcp.setRequestHandler(CallToolRequestSchema, async req => { ... })` with the wrapper shown in Step 3. The switch cases themselves do not change.

- [ ] **Step 5: Verify server starts**

```bash
cd session-manager && node --experimental-strip-types server.ts &
sleep 2 && kill %1
```

- [ ] **Step 6: Commit**

```bash
git add session-manager/server.ts
git commit -m "feat: inject welcome message for first-time users via seen_users tracking"
```

---

### Task 15: Add `transcribe_voice` tool to server.ts

**Files:**
- Modify: `session-manager/server.ts`

- [ ] **Step 1: Add `transcribe_voice` to the tools list**

```typescript
{
  name: 'transcribe_voice',
  description: 'Transcribe a voice message (.ogg file) to text using whisper. Call this when the user sends a voice note — pass the downloaded file path.',
  inputSchema: { type: 'object', properties: {
    file_path: { type: 'string', description: 'Absolute path to the .ogg voice file on disk' },
    caller_id: { type: 'string', description: 'Your Telegram chat_id (optional)' },
  }, required: ['file_path'] },
},
```

- [ ] **Step 2: Add case to handleTool**

```typescript
case 'transcribe_voice': {
  const filePath = typeof args.file_path === 'string' ? args.file_path.trim() : ''
  if (!filePath) return { content: [{ type: 'text', text: 'Provide file_path.' }], isError: true }

  // Check whisper is installed
  const whichResult = spawnSync('which', ['whisper'], { encoding: 'utf8' })
  if (whichResult.status !== 0) {
    return { content: [{ type: 'text', text: 'Voice transcription is not enabled on this instance.\nThe owner can run: bash /opt/pocket-claude/install.sh --with-voice' }], isError: true }
  }

  try {
    const out = execFileSync('whisper', [filePath, '--output-format', 'txt', '--model', 'base', '--output-dir', '/tmp'], {
      encoding: 'utf8', timeout: 60000,
    })
    // whisper writes <filename>.txt — read it
    const txtPath = `/tmp/${filePath.split('/').pop()!.replace(/\.[^.]+$/, '.txt')}`
    // readFileSync is already imported at the top of server.ts
    const transcript = readFileSync(txtPath, 'utf8').trim()
    return { content: [{ type: 'text', text: `[Voice transcript]: ${transcript}` }] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: [{ type: 'text', text: `Transcription failed: ${msg}` }], isError: true }
  }
}
```

- [ ] **Step 3: Verify server starts**

```bash
cd session-manager && node --experimental-strip-types server.ts &
sleep 2 && kill %1
```

- [ ] **Step 4: Commit**

```bash
git add session-manager/server.ts
git commit -m "feat: add transcribe_voice MCP tool - voice message support via whisper"
```

---

### Task 16: Add `--with-voice` flag to `install.sh`

**Files:**
- Modify: `install.sh`

- [ ] **Step 1: Parse the flag at the top of install.sh**

After the existing variable declarations at the top, add:

```bash
WITH_VOICE=false
for arg in "$@"; do
  [[ "$arg" == "--with-voice" ]] && WITH_VOICE=true
done
```

- [ ] **Step 2: Add whisper install block near the end of install.sh (before the final status message)**

```bash
if [[ "$WITH_VOICE" == "true" ]]; then
  info "Installing whisper for voice transcription..."
  if command -v pip3 &>/dev/null; then
    pip3 install --quiet openai-whisper
    if command -v whisper &>/dev/null; then
      info "whisper installed. Voice transcription enabled."
    else
      warn "whisper install may have failed. Check: pip3 show openai-whisper"
    fi
  else
    warn "pip3 not found — skipping voice install. Install python3-pip and re-run with --with-voice."
  fi
fi
```

- [ ] **Step 3: Commit**

```bash
git add install.sh
git commit -m "feat: install.sh --with-voice flag installs whisper for voice transcription"
```

---

### Task 17: Update `docs/getting-started.md` — group mode docs

**Files:**
- Modify: `docs/getting-started.md`

- [ ] **Step 1: Read the current file**

```bash
cat docs/getting-started.md
```

- [ ] **Step 2: Add a "Team & Group Setup" section**

Add the following section after the single-user setup instructions:

```markdown
## Team & Group Setup

pocket-claude supports multiple users sharing one Claude Code instance.

### Adding team members

Edit `~/.pocket-claude/access.json`:

```json
{
  "allowFrom": ["your_telegram_id", "teammate_telegram_id"],
  "roles": {
    "your_telegram_id": "admin",
    "teammate_telegram_id": "member"
  }
}
```

**Roles:**
- `admin` — full access: switch sessions, delete, update, restart, manage roles
- `member` — read/chat access: list sessions, search, preview, queue tasks, get notified

### Using a Telegram Group

1. Create a Telegram group and add your pocket-claude bot to it
2. In BotFather → your bot → **Bot Settings → Group Privacy → Disable** (to receive all messages), or leave **Enabled** for `@yourbot` mention-only responses
3. Get the group's chat ID (send a message and check `https://api.telegram.org/bot<TOKEN>/getUpdates`)
4. Add the group to `access.json`:

```json
{
  "allowFrom": ["your_id"],
  "groups": { "-1001234567890": "my-team" }
}
```

### Sending files

Drop any file (PDF, image, code, document) directly into the Telegram chat. Claude will read and process it — no manual upload steps. The Telegram plugin downloads the attachment to the VM automatically.

### Task queue

Any team member can queue work:

> "Queue a task: Add dark mode to the dashboard"

Claude will work through the queue and notify the requester on completion — even if they've closed Telegram.

### Proactive notifications

At the end of a long task, ask Claude to notify you:

> "When you're done, call notify_user with a summary"

You'll receive a Telegram ping with the result.
```

- [ ] **Step 3: Commit**

```bash
git add docs/getting-started.md
git commit -m "docs: add team/group setup, task queue, and notification docs"
```

---

### Task 18: Final verification and push

- [ ] **Step 1: Run full test suite**

```bash
cd session-manager && npm test
```

Expected: all tests pass.

- [ ] **Step 2: Verify TypeScript compiles cleanly**

```bash
cd session-manager && npm run build
```

Expected: no errors.

- [ ] **Step 3: Count total new tools**

The final server.ts should expose these tools (19 total):
- Existing 13: `list_sessions`, `search_sessions`, `resume_session`, `preview_session`, `pin_session`, `unpin_session`, `new_session`, `restart_session`, `delete_sessions`, `get_status`, `what_am_i_working_on`, `get_logs`, `update_pocket_claude`
- New 7: `set_user_role`, `handoff_summary`, `notify_user`, `queue_task`, `list_queue`, `complete_task`, `transcribe_voice`

Wait — that's 7 new tools. Verify all 7 appear in the `ListToolsRequestSchema` handler output.

- [ ] **Step 4: Push to GitHub**

```bash
git push origin master
```

- [ ] **Step 5: Manual smoke test on the VM**

SSH into the VM and verify:

```bash
# 1. Update from GitHub
cd /opt/pocket-claude && sudo git pull

# 2. Rebuild session manager
cd /opt/pocket-claude/session-manager && sudo npm ci

# 3. Verify CLAUDE.md was updated by install.sh (or add manually)
grep -q 'pocket-claude role enforcement' ~/.claude/CLAUDE.md && echo "OK" || echo "MISSING"

# 4. Verify access.json has roles
python3 -c "import json; d=json.load(open('$HOME/.pocket-claude/access.json')); print('roles:', d.get('roles', 'MISSING'))"

# 5. Restart service
sudo systemctl restart pocket-claude

# 6. Test from Telegram: send "list sessions" — should get welcome message on first contact
# 7. Test: "queue a task: test the queue" — should confirm task queued
# 8. Test: "list queue" — should show the queued task
# 9. Test: "complete task <id>" — should mark done and send notification
```

---

## Out of Scope (this plan)

- Inline Telegram keyboards / button menus
- Per-user session isolation
- Push-to-queue from external webhooks
- Voice on non-Linux platforms
