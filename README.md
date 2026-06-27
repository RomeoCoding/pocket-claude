<div align="center">

```
░█████████                        ░██                     ░██         ░██████  ░██                              ░██
░██     ░██                       ░██                     ░██        ░██   ░██ ░██                              ░██
░██     ░██  ░███████   ░███████  ░██    ░██ ░███████  ░████████    ░██        ░██  ░██████   ░██    ░██  ░████████  ░███████
░█████████  ░██    ░██ ░██    ░██ ░██   ░██ ░██    ░██    ░██       ░██        ░██       ░██  ░██    ░██ ░██    ░██ ░██    ░██
░██         ░██    ░██ ░██        ░███████  ░█████████    ░██       ░██        ░██  ░███████  ░██    ░██ ░██    ░██ ░█████████
░██         ░██    ░██ ░██    ░██ ░██   ░██ ░██           ░██        ░██   ░██ ░██ ░██   ░██  ░██   ░███ ░██   ░███ ░██
░██          ░███████   ░███████  ░██    ░██ ░███████      ░████      ░██████  ░██  ░█████░██  ░█████░██  ░█████░██  ░███████
```

**Claude Code · Always On · Telegram · Oracle Free**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Ubuntu](https://img.shields.io/badge/Ubuntu-22.04%2B-orange?logo=ubuntu)](https://ubuntu.com)
[![Claude](https://img.shields.io/badge/Claude-Pro%2FMax-purple?logo=anthropic)](https://claude.ai)
[![Telegram](https://img.shields.io/badge/Telegram-Plugin-blue?logo=telegram)](https://telegram.org)

</div>

---

**pocket-claude** runs Claude Code 24/7 on a VM and connects it to Telegram. Open your phone, DM your bot, and pick up any conversation — from anywhere, even when your laptop is closed.

It uses the **official Anthropic Telegram plugin**, your existing **claude.ai Pro/Max subscription** (no API key), and Oracle Cloud's **Always Free tier** — so the infrastructure costs nothing.

---

## Features

- **Always on** — systemd service, watchdog cron, auto-restart after crashes
- **Truly private** — your VM, your bot, your Telegram ID only (allowlist enforced)
- **Session memory** — ask Claude to list your past conversations and resume any by name
- **Official plugin** — uses `plugin:telegram@claude-plugins-official`, not a third-party bridge
- **Free infrastructure** — Oracle Cloud Always Free (1 OCPU, 1 GB RAM AMD; or 4 OCPU/24 GB ARM where available)
- **Zero inbound ports** — Telegram uses outbound long-polling; only SSH (port 22) is open
- **Hardened** — UFW, fail2ban, SSH key-only, dedicated `claude` system user, systemd sandbox

---

## How it works

```
[Your phone]
    │
    ▼ Telegram DM
[Telegram servers]
    │
    ▼ outbound HTTPS (long polling, initiated by VM)
[Oracle VM]
    │
    ├── Claude Code (claude --channels plugin:telegram@...)
    │       │
    │       └── Session Manager MCP (list/resume/new sessions)
    │
    └── tmux session (persists across SSH disconnects)
```

Session switching works by writing a session ID to disk, sending Ctrl-C to Claude, and letting systemd restart it with `--resume <id>`. No sockets, no IPC, no race conditions.

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Oracle Cloud account | Always Free tier — no ongoing charge after signup |
| Ubuntu 22.04+ VM | x86_64 or ARM64; see [Oracle setup guide](docs/oracle-setup.md) |
| claude.ai Pro or Max | No API key — uses OAuth login |
| Telegram account | Create a bot via [@BotFather](https://t.me/BotFather) |
| Telegram user ID | Get yours from [@userinfobot](https://t.me/userinfobot) |

---

## Install

On your Ubuntu VM, as a non-root user with sudo access:

```bash
curl -fsSL https://raw.githubusercontent.com/RomeoCoding/pocket-claude/master/install.sh -o install.sh
bash install.sh
```

> **Note:** The installer is interactive. Do not pipe it directly to bash — download it first.

The installer (~5 minutes) will:

1. Install Node.js 22, tmux, Claude Code, Bun
2. Create a dedicated `claude` system user (locked password, key-only SSH)
3. Prompt for your Telegram bot token and your Telegram user ID
4. Set up the session manager MCP server
5. Harden SSH, enable UFW + fail2ban
6. Open `claude auth login` for your claude.ai account
7. Start the daemon under systemd with auto-restart
8. Guide you through installing the official Telegram plugin

**One manual step remains after install:** install the Telegram plugin through Claude Code's UI (the installer will attempt this automatically and show manual steps if it fails).

---

## Usage

DM your bot. That's it.

**Session commands (say these naturally in chat):**

| You say | What happens |
|---------|-------------|
| `list my sessions` | Shows 10 most recent conversations with titles and ages |
| `resume session 3` | Switches to session #3, full context restored |
| `start a new session` | Opens a fresh Claude conversation |
| `what session am I in?` | Current session status and uptime |

---

## Operations

```bash
# Service management
sudo systemctl status pocket-claude          # health check
sudo journalctl -u pocket-claude -f          # live logs
sudo systemctl restart pocket-claude         # restart

# Update to latest version
bash /opt/pocket-claude/update.sh

# Rotate bot token (if token is ever exposed)
sudo -u claude bash /opt/pocket-claude/security/rotate-token.sh <new-token>

# Attach to Claude's tmux session (for debugging)
sudo -u claude bash -c \
  'export TMUX_TMPDIR=$HOME/.pocket-claude/tmux; tmux attach -t pocket-claude'
```

---

## Project structure

```
pocket-claude/
├── install.sh                      # One-command installer
├── update.sh                       # Pull latest + rebuild
├── daemon/
│   ├── start.sh                    # tmux session launcher (called by systemd)
│   ├── switch.sh                   # Session switcher (called by session MCP)
│   ├── watchdog.sh                 # Health check + Oracle keep-alive (cron)
│   └── pocket-claude.service       # systemd unit
├── session-manager/
│   ├── server.ts                   # MCP server: list / resume / new / status
│   ├── sessions.ts                 # Reads ~/.claude/projects/ JSONL files
│   ├── package.json
│   └── tsconfig.json
├── security/
│   ├── harden.sh                   # UFW + fail2ban + SSH hardening
│   └── rotate-token.sh             # Safe bot token rotation
├── scripts/
│   └── motd.sh                     # SSH login banner (installed by installer)
└── docs/
    ├── oracle-setup.md
    ├── getting-started.md
    └── security.md
```

---

## Security

pocket-claude is designed with zero inbound attack surface.

- **Bot access**: Telegram user ID allowlist — unknown IDs are silently ignored
- **Token storage**: `chmod 600`, never in git, excluded by `.gitignore`
- **Session IDs**: UUID v4 validated by regex at two layers before any shell use
- **Shell injection**: all subprocesses use `execFileSync` with arg arrays — never string interpolation
- **Network**: UFW default-deny inbound; only SSH port 22 open; Telegram uses outbound polling
- **systemd**: `PrivateTmp`, `ProtectSystem=strict`, `NoNewPrivileges`, `PrivateDevices`
- **SSH**: password auth disabled, root login disabled, fail2ban (3 retries → 24h ban)

See [docs/security.md](docs/security.md) for the full threat model.

---

## Docs

- [Getting started](docs/getting-started.md)
- [Oracle Cloud setup guide](docs/oracle-setup.md)
- [Security architecture](docs/security.md)

---

## License

MIT — see [LICENSE](LICENSE)
