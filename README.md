# pocket-claude

**Run Claude Code 24/7 from your phone via Telegram.**

One command installs everything on any Ubuntu VM — Oracle Cloud Always Free tier, DigitalOcean, Hetzner, whatever. Your Claude Code sessions persist across days. Resume any past conversation by name. No API key required — works with your existing claude.ai subscription.

---

## What it does

- Keeps Claude Code running in a persistent tmux session on your VM
- Connects it to Telegram via the official Anthropic Claude Code Telegram plugin
- Lets you resume past conversations from your phone ("resume session 3")
- Survives crashes via systemd + watchdog
- Prevents Oracle's idle-VM reclamation automatically
- Hardened: key-only SSH, fail2ban, UFW, zero inbound ports for Telegram

---

## Install

On your Ubuntu VM (22.04+), as a non-root user with sudo:

```bash
curl -fsSL https://raw.githubusercontent.com/romeocoding/pocket-claude/main/install.sh | bash
```

That's it. The installer:
1. Installs Node.js 22, tmux, Claude Code
2. Creates a dedicated `claude` system user
3. Prompts for your Telegram bot token (from @BotFather)
4. Configures the session manager MCP
5. Hardens SSH, enables UFW + fail2ban
6. Opens `claude auth login` for your claude.ai account
7. Starts the daemon under systemd

**Total time: ~5 minutes**

---

## Session management from Telegram

| You say | What happens |
|---------|-------------|
| `list my sessions` | Shows 10 most recent conversations with titles |
| `resume session 3` | Switches to that session, full context restored |
| `start a new session` | Opens a fresh conversation |
| `what session am I in?` | Current session ID and uptime |

---

## Architecture

```
[Phone] → [Telegram] → [Claude Code on VM]
                              ↓
                     [Session Manager MCP]
                              ↓
                    ~/.claude/projects/ (JSONL)
```

- **Official plugin**: Uses `plugin:telegram@claude-plugins-official` — not a third-party bridge
- **No API key**: Authenticates via claude.ai OAuth, same as desktop Claude Code
- **Session switching**: Writes desired session ID to a file → Claude restarts → picks it up
- **Security**: UUID validation at two layers; `execFileSync` with arg arrays (no shell interpolation)

---

## Requirements

- Ubuntu 22.04+ (x86_64 or ARM64)
- A claude.ai Pro or Max subscription
- A Telegram account + bot from @BotFather
- A VM (Oracle Cloud Free Tier works; see [docs/oracle-setup.md](docs/oracle-setup.md))

---

## Project structure

```
pocket-claude/
├── install.sh                  # One-command installer
├── update.sh                   # Pull latest + rebuild
├── daemon/
│   ├── start.sh                # tmux session launcher
│   ├── switch.sh               # Session switcher (called by MCP)
│   ├── watchdog.sh             # Health check + Oracle keep-alive
│   └── pocket-claude.service   # systemd unit
├── session-manager/
│   ├── server.ts               # MCP server (list/resume/new/status)
│   ├── sessions.ts             # Session discovery from ~/.claude/projects/
│   ├── tsconfig.json
│   └── package.json
├── security/
│   ├── harden.sh               # UFW + fail2ban + SSH hardening
│   └── rotate-token.sh         # Bot token rotation
└── docs/
    ├── oracle-setup.md
    ├── getting-started.md
    └── security.md
```

---

## Docs

- [Getting started](docs/getting-started.md)
- [Oracle Cloud setup](docs/oracle-setup.md)
- [Security architecture](docs/security.md)

---

## Operations

```bash
sudo systemctl status pocket-claude        # check status
sudo journalctl -u pocket-claude -f        # live logs
sudo systemctl restart pocket-claude       # restart
bash /opt/pocket-claude/update.sh          # update to latest
bash /opt/pocket-claude/security/rotate-token.sh <token>  # rotate bot token
```

---

## License

MIT
