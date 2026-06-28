# Getting Started

## Prerequisites

- Ubuntu 22.04+ VM (Oracle Cloud Free Tier, DigitalOcean, Hetzner, etc.)
- A Telegram account
- A claude.ai subscription (Pro or Max — no API key needed)
- SSH access to your VM

---

## Step 1: Create a Telegram bot

1. Open Telegram → search for **@BotFather**
2. Send `/newbot`
3. Choose a name (e.g. "My Claude") and a username ending in `bot` (e.g. `myclaudeXYZ_bot`)
4. BotFather replies with a token like `1234567890:AAHxyz...` (keep this secret)
5. **Keep this token secret.** It grants full control over your bot.

---

## Step 2: Install pocket-claude on your VM

SSH into your VM, then run:

```bash
curl -fsSL https://raw.githubusercontent.com/RomeoCoding/pocket-claude/master/install.sh -o install.sh
bash install.sh
```

The installer will prompt you for:
- Your Telegram bot token
- Whether to run security hardening (recommended: yes)
- Authentication with your claude.ai account (a browser link will appear)

Total install time: ~5 minutes.

---

## Step 3: Pair your Telegram account

When you first DM your bot, Claude Code will ask you to confirm your Telegram ID and approve the pairing. This happens automatically — just send any message to your bot and follow the prompt that appears in your SSH session.

Your Telegram user ID is stored in `~/.claude/channels/telegram/access.json` on the VM. Only IDs in the allowlist can interact with Claude.

---

## Step 4: Start chatting

DM your bot. You're now talking to Claude Code running 24/7 on your VM.

**Session commands you can use in chat:**

| What you say | What happens |
|--------------|--------------|
| `list my sessions` | Shows your 10 most recent conversations with titles |
| `resume session 3` | Switches to that session (preserves all context) |
| `start a new session` | Opens a fresh conversation |
| `what session am I in?` | Shows current session ID and uptime |

---

## Team & Group Setup

pocket-claude supports multiple users and Telegram groups sharing one Claude Code instance.

### Adding team members

Edit `~/.pocket-claude/access.json` on the VM:

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
- `member` — read/chat access: list sessions, search, preview, queue tasks, receive notifications

Your own ID is set as `admin` automatically during install. Teammates get `member` by default.

To promote someone from Telegram chat: `"set user 987654321 as admin"`

### Using a Telegram Group

1. Create a Telegram group and add your pocket-claude bot to it
2. In **BotFather → your bot → Bot Settings → Group Privacy → Disable** (to receive all messages in the group), or leave **Enabled** for `@yourbot` mention-only responses
3. Get the group's chat ID — send a message to the group, then open:
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
   Look for `"chat":{"id":-100...}` — the negative number is the group ID
4. Add the group to `~/.pocket-claude/access.json`:

```json
{
  "allowFrom": ["your_id"],
  "groups": { "-1001234567890": "my-team" }
}
```

### Sending files

Drop any file (PDF, image, code, document) directly into the Telegram chat — your bot will read and process it. The Telegram plugin downloads the attachment to the VM automatically. No manual upload steps.

### Task queue

Any team member can queue work for Claude to process asynchronously:

> "Queue a task: Add dark mode to the dashboard"

List pending tasks:

> "List the queue"

Claude works through the queue and notifies the requester on completion — even if they've closed Telegram.

### Proactive notifications

At the end of a long task, ask Claude to ping you:

> "When you're done, notify me with a summary"

You'll receive a Telegram message with the result — no polling needed.

### Voice messages (optional)

If installed with `bash install.sh --with-voice`, Claude will transcribe voice notes you send:

1. Send a voice message to your bot
2. Claude automatically calls `transcribe_voice` on the audio file
3. The transcript is treated as your message and Claude responds normally

To enable voice on an existing install:
```bash
bash /opt/pocket-claude/install.sh --with-voice
```

---

## Step 5: Close your laptop

Your Claude Code session keeps running on the VM. Come back tomorrow, DM your bot, and pick up exactly where you left off.

---

## Troubleshooting

**Bot doesn't respond**

```bash
sudo journalctl -u pocket-claude -n 50
```

Look for "Telegram token" errors — the token may have been entered incorrectly. Re-run:
```bash
bash /opt/pocket-claude/security/rotate-token.sh <correct-token>
```

**Session switch didn't work**

The session manager needs Claude Code sessions to exist in `~/.claude/projects/`. Start a few conversations first, then try listing sessions.

**Service keeps restarting**

```bash
sudo systemctl status pocket-claude
sudo journalctl -u pocket-claude --since "5 min ago"
```

Usually a Claude Code auth issue — re-run `claude auth login` as the `claude` user:
```bash
sudo -u claude -i claude auth login
```

**SSH locked out after hardening**

Ensure you have your SSH key before running harden.sh. The hardening script disables password auth. If locked out, use Oracle's Console → Instance → **Boot volume: Console connection** for emergency access.
