# pocket-claude WOW Features Design
**Date:** 2026-06-27  
**Status:** Approved

---

## Goal

Ship pocket-claude as a compelling open-source product with three clear differentiators over API-based bots:
1. No API key — powered by Claude Code subscription, not per-token billing
2. Always-on — works while the user's laptop is off
3. Team-shared — one Claude Code instance, whole team connected

The three features below directly embody and demonstrate these differentiators.

---

## Architecture Overview

```
Telegram (Group or DM)
       │
       ▼
  Telegram Plugin  ←── @claude filter via BotFather privacy mode
       │
       ▼
  MCP Server (session-manager/server.ts)
       │
       ├──→ ~/.pocket-claude/access.json      (roles field added)
       ├──→ ~/.pocket-claude/queue.jsonl      (NEW: task queue)
       └──→ ~/.pocket-claude/seen_users.json  (NEW: onboarding tracker)
```

**Unchanged:** Telegram plugin, watchdog.sh, daemon, all 13 existing MCP tools.  
**New files:** `session-manager/queue.ts`, `session-manager/seen_users.ts`  
**Modified files:** `session-manager/server.ts`, `access.json` schema, `install.sh` (voice flag)

---

## Feature 1 — Team Collaboration

### 1.1 Group Mode + @claude Trigger

Telegram bots have a BotFather setting: **Group Privacy**. When enabled, the bot only receives messages that @-mention it or reply to it — no code change required. The `install.sh` post-install checklist and `docs/getting-started.md` will include:

> "To use pocket-claude in a Telegram Group: add the bot to your group, then in BotFather → your bot → Bot Settings → Group Privacy → set to Disabled to receive all messages, or leave Enabled for @-mention-only responses."

Groups are already supported in `access.json` via the `groups` key. No change to that structure.

### 1.2 Role System

`access.json` gains a `roles` field:

```json
{
  "allowFrom": ["111", "222"],
  "groups": { "-100group_id": "group_name" },
  "roles": {
    "111": "admin",
    "222": "member"
  }
}
```

**Rules:**
- Users absent from `roles` default to `member`
- The first entry in `allowFrom` is automatically set to `admin` on fresh installs only — `install.sh` checks if `roles` key is absent before writing the default; existing installs running `update.sh` are never touched
- Groups themselves have no role — individual members carry their roles

**Role permissions:**

| Tool | admin | member |
|---|---|---|
| All 13 existing read/nav tools | ✅ | ✅ |
| `delete_sessions` | ✅ | ❌ |
| `update_pocket_claude` | ✅ | ❌ |
| `new_session` | ✅ | ❌ |
| `restart_session` | ✅ | ❌ |
| `set_user_role` | ✅ | ❌ |
| `queue_task`, `list_queue`, `complete_task` | ✅ | ✅ |
| `notify_user` | ✅ | ✅ |
| `handoff_summary` | ✅ | ✅ |

**Implementation:** Role enforcement lives entirely in `server.ts`. Each restricted tool reads `caller_id` from the tool arguments. The system prompt instructs Claude to always pass the sender's Telegram user ID (from the `<channel chat_id="...">` tag) as `caller_id` when calling role-sensitive tools. The server reads `access.json`, checks `roles[caller_id]`, and returns an error if the role is insufficient.

**Where the system prompt addition lives:** `~/.claude/CLAUDE.md` on the VM. Claude Code loads this automatically on startup. The `install.sh` appends the following block once (idempotent check via grep):

```
## pocket-claude role enforcement
When a Telegram message arrives via <channel source="telegram" chat_id="X">,
always pass chat_id X as `caller_id` when calling any of these tools:
delete_sessions, update_pocket_claude, new_session, restart_session, set_user_role.
```

### 1.3 New Tools

**`set_user_role(user_id, role, caller_id)`**
- Admin only
- `role` must be `"admin"` or `"member"`
- Updates `access.json` in place
- Returns confirmation with the user's display name if known

**`handoff_summary()`**
- Available to all roles
- Claude generates a structured handoff: current session title, last 3 exchanges, open tasks from queue, pinned sessions
- Formatted as a Telegram-readable block the next teammate can act on immediately

---

## Feature 2 — Async Notifications & Task Queue

### 2.1 `notify_user` Tool

Claude calls this when a long job finishes. The MCP server reads the bot token from `~/.pocket-claude/.env` and sends a Telegram Bot API `sendMessage` directly — no daemon involvement.

**Signature:** `notify_user(message, chat_id?)`

- If `chat_id` provided → sends to that user only
- If omitted → broadcasts to all `allowFrom` IDs and all `groups` keys in `access.json`

**Implementation in `server.ts`:**
```typescript
// Reads TELEGRAM_TOKEN from ~/.pocket-claude/.env
// Calls https://api.telegram.org/bot{token}/sendMessage
// chat_id list derived from access.json allowFrom + Object.keys(groups)
```

This is the "laptop off" killer feature: users submit a long task, close Telegram, and receive a ping when Claude calls `notify_user`.

### 2.2 Task Queue

**Storage:** `~/.pocket-claude/queue.jsonl` — one JSON object per line.

**Entry schema:**
```json
{
  "id": "uuid-v4",
  "description": "Add dark mode to dashboard",
  "status": "pending",
  "priority": "normal",
  "queued_by": "telegram_user_id",
  "queued_at": "ISO8601",
  "completed_at": null,
  "note": null
}
```

**Statuses:** `pending` → `in_progress` → `done`

**New file:** `session-manager/queue.ts` exports:
- `queueTask(description, priority, userId)` → returns `task_id`
- `listQueue()` → returns all tasks sorted by priority then queued_at
- `completeTask(taskId, note?)` → marks done, returns task for notify_user

**New tools in `server.ts`:**

**`queue_task(description, priority?, caller_id?)`**
- Appends entry to queue.jsonl
- Returns: `Task queued: #<id> — "<description>"`
- `priority`: `"high"` | `"normal"` (default `"normal"`)

**`list_queue()`**
- Returns formatted list: index, status emoji, description, who queued it, age
- Status emojis: ⏳ pending, 🔄 in_progress, ✅ done
- Shows last 5 completed tasks at bottom (for context)

**`complete_task(task_id, note?)`**
- Marks task done
- Automatically calls `notify_user` with completion message to the user who queued it
- `note` is appended to the notification (e.g. "3 files changed, tests passing")

Tasks persist across session restarts. A teammate can queue work, go offline, and receive a completion ping later — regardless of who is actively in the Telegram chat.

---

## Feature 3 — Onboarding Experience

### 3.1 Seen Users Tracking

**New file:** `session-manager/seen_users.ts`  
**Storage:** `~/.pocket-claude/seen_users.json`

```json
{
  "111": { "first_seen": "ISO8601", "welcomed": true },
  "222": { "first_seen": "ISO8601", "welcomed": false }
}
```

On every tool call, the MCP server checks if `caller_id` exists in `seen_users.json`. If not (or if `welcomed: false`), it sets a flag on the response that signals Claude to prepend the welcome message before its actual reply.

### 3.2 Welcome Message

Claude sends this once per new user, never again:

```
👋 Welcome to pocket-claude

This is a full Claude Code instance running 24/7 on a VM — 
accessible from Telegram, no laptop needed.

What makes it different from API bots:
• Runs real code, edits files, uses all MCP tools
• No API key — powered by your Claude subscription
• Works while your laptop is off
• Shared with your team — one instance, everyone connected

Things to try:
  "What are you working on?"
  "List my sessions"
  "Queue a task: <description>"

Drop a file here and I'll read it.
Send a voice note and I'll transcribe and act on it (if voice is enabled).
```

After sending, `seen_users.ts` marks `welcomed: true` for that user ID.

### 3.3 File Inbox

Already functional — the Telegram plugin downloads attachments and passes the file path. The welcome message makes this explicit. No code change needed.

### 3.4 Voice Transcription (Optional)

**Trigger:** `install.sh --with-voice` flag  
**Dependency:** `whisper` installed via `pip install openai-whisper`

**Flow:**
1. User sends a voice message → Telegram plugin downloads the `.ogg` file, passes the local file path to Claude
2. Claude recognizes the voice attachment and calls the new `transcribe_voice(file_path)` tool
3. MCP server runs `whisper <file_path> --output-format txt --model base` via `spawnSync`
4. Returns the transcript text to Claude
5. Claude treats the transcript as the user's message and responds normally

**New tool:** `transcribe_voice(file_path)`
- Checks if whisper is installed: `spawnSync('which', ['whisper']).status === 0`
- If not installed: returns error text `"Voice transcription is not enabled. The owner can run bash install.sh --with-voice to add it."`
- Runs whisper synchronously (base model, ~5s on a 1-core VM for a short message)
- Returns `{ transcript: string }`

Detection is runtime (inside the tool), not at server startup — so the tool always exists in the schema and gracefully degrades if whisper is absent.

---

## Files Changed Summary

| File | Change type | Description |
|---|---|---|
| `session-manager/server.ts` | Modified | 6 new tools, role enforcement, seen_users check, notify_user impl |
| `session-manager/queue.ts` | New | Task queue CRUD |
| `session-manager/seen_users.ts` | New | First-contact tracking, welcomed flag |
| `access.json` (schema) | Modified | Add `roles` field |
| `install.sh` | Modified | `--with-voice` flag, whisper install, auto-set first admin |
| `docs/getting-started.md` | Modified | Group mode setup, BotFather privacy instructions |
| `~/.claude/CLAUDE.md` (VM) | Modified | caller_id system prompt instruction (appended by install.sh) |
| `docs/superpowers/specs/` | New | This file |

**Implementation order (recommended):** Feature 1 (roles) → Feature 2 (notify + queue) → Feature 3 (onboarding + voice). Each can be a separate execution cycle.

---

## Out of Scope (Second Pass)

- Inline Telegram keyboards / button UI
- Per-user session isolation (all users share one Claude session by design)
- Telegram bot command menu (`/start`, `/help` shortcuts)
- Push-to-queue from external webhooks
