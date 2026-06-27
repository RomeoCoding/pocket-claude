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
