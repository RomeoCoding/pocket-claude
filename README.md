<div align="center">

```
 ____   ___   ____  _  __  _____  _____
|  _ \ / _ \ / ___|| |/ / | ____||_   _|
| |_) || | | || |   | ' /  |  _|    | |
|  __/ | |_| || |___| . \  | |___   | |
|_|     \___/  \____|_|\_\ |_____| |_|

  ____  _        _    _   _ ____  _____
 / ___|| |      / \  | | | |  _ \| ____|
| |    | |     / _ \ | | | | | | |  _|
| |___ | |___ / ___ \| |_| | |_| | |___
 \____||_____/_/   \_\\___/|____/|_____|
```

**Claude Code · Always On · Telegram · Free**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Ubuntu](https://img.shields.io/badge/Ubuntu-20.04%2B-orange?logo=ubuntu)](https://ubuntu.com)
[![Debian](https://img.shields.io/badge/Debian-11%2B-red?logo=debian)](https://debian.org)
[![Fedora](https://img.shields.io/badge/Fedora-37%2B-blue?logo=fedora)](https://fedoraproject.org)
[![RHEL](https://img.shields.io/badge/RHEL%2FAlma%2FRocky-8%2B-red)](https://almalinux.org)
[![Telegram](https://img.shields.io/badge/Telegram-Plugin-blue?logo=telegram)](https://telegram.org)

</div>

---

**pocket-claude** runs a full persistent **Claude Code** session 24/7 on a VM and connects it to Telegram via the **official Anthropic plugin**. Open your phone, DM your bot, and pick up any conversation — from anywhere, even when your laptop is closed.

No API key. No per-token billing. Works with your **claude.ai Pro or Max** subscription. Runs free on **Oracle Cloud Always Free** or any Linux VM.

---

## Why pocket-claude

| | pocket-claude | API-based bots (Clawcode, etc.) |
|---|---|---|
| **Backend** | Full Claude Code session — persistent, stateful | Stateless API call per message |
| **Auth** | claude.ai OAuth (Pro/Max subscription) | Requires Anthropic API key + billing |
| **Tool use** | Full: bash, file read/write, web search, MCP | Limited or none |
| **Session memory** | List and resume any past conversation | Starts fresh every message |
| **File access** | Full VM filesystem | None |
| **Plugin** | Official `plugin:telegram@claude-plugins-official` | Third-party wrapper |
| **Collaboration** | Multi-user allowlist + Telegram group mode | Single user |
| **Skills** | Sync your custom skills to the shared VM | N/A |
| **Privacy** | Your VM, your bot, nobody else's infra | Your messages hit the bot's server |
| **Cost** | Free (Oracle Always Free tier) | API costs per token |

---

## Features

- **Always on** — systemd service, cron watchdog, auto-restart on crash
- **Persistent context** — deep project conversations survive phone restarts and laptop closures
- **Session memory** — list and resume past conversations from Telegram
- **Full tool use** — bash, file read/write, web search, edit, glob — everything Claude Code supports
- **Official plugin** — uses `plugin:telegram@claude-plugins-official`, not a third-party bridge
- **Multi-user collaboration** — add teammates to the allowlist or use a shared Telegram group
- **Skills sync** — bring your custom Claude skills to the shared VM environment
- **Multi-distro** — Ubuntu, Debian, Fedora, RHEL, AlmaLinux, Rocky, CentOS Stream
- **Any hypervisor** — Oracle Cloud, AWS, GCP, Azure, DigitalOcean, VirtualBox, Proxmox, bare metal
- **Free** — Oracle Always Free tier (no credit card charges after signup)
- **Hardened** — UFW/firewalld, fail2ban, SSH key-only, dedicated system user, systemd sandbox

---

## How it works

```
[Your phone]
     │  Telegram DM
     ▼
[Telegram servers]
     │  outbound HTTPS long-polling (VM initiates, no open inbound ports)
     ▼
[Your VM]
     ├─ claude --channels plugin:telegram@claude-plugins-official
     │       └─ Session Manager MCP  (list / resume / new session)
     └─ tmux  (keeps session alive across SSH disconnects)
```

Session switching: writes a session ID to disk → sends Ctrl-C to Claude → systemd restarts it with `--resume <id>`. No sockets, no IPC, no race conditions.

---

## OS compatibility

| Distro | Min version | Package manager | Firewall |
|--------|-------------|-----------------|----------|
| Ubuntu | 20.04 | apt | UFW |
| Debian | 11 (Bullseye) | apt | UFW |
| Fedora | 37 | dnf | firewalld |
| RHEL / AlmaLinux / Rocky | 8 | dnf | firewalld |
| CentOS Stream | 8 | dnf | firewalld |
| Pop!\_OS / Mint / Kali | — | apt | UFW |
| Arch / Gentoo / NixOS | — | — | ❌ not supported |

Works on any hypervisor or cloud — **VirtualBox, VMware, Hyper-V, KVM, Proxmox, Oracle Cloud, AWS EC2, GCP, Azure, DigitalOcean, Hetzner, Linode, bare metal.** The installer only cares about the guest OS.

---

## Prerequisites

| | |
|---|---|
| A Linux VM | Any distro from the table above |
| claude.ai Pro or Max | OAuth login — no API key |
| Telegram bot token | [@BotFather](https://t.me/BotFather) → `/newbot` |
| Your Telegram user ID | [@userinfobot](https://t.me/userinfobot) — a number, not a username |

---

## Install

SSH into your VM as a non-root user with sudo, then:

```bash
curl -fsSL https://raw.githubusercontent.com/RomeoCoding/pocket-claude/master/install.sh -o install.sh
bash install.sh
```

> The installer is interactive — download it first, don't pipe directly to bash.

**The installer (~5 min) will:**
1. Install Node.js 22, tmux, Claude Code, Bun
2. Create a dedicated locked-down `claude` system user
3. Ask for your Telegram bot token and your Telegram user ID (locks the bot to you only)
4. Set up the Session Manager MCP server
5. Harden SSH, enable firewall (UFW or firewalld) + fail2ban
6. Walk you through `claude auth login` with your claude.ai account
7. Start the systemd daemon and attempt automated Telegram plugin install

---

## Usage

DM your bot. That's it.

**Say these naturally in chat:**

| You say | What happens |
|---------|-------------|
| `list my sessions` | Shows your recent conversations with titles and ages |
| `resume session 3` | Restores session #3 with full context |
| `start a new session` | Opens a fresh Claude conversation |
| `what session am I in?` | Current session info and uptime |

---

## Multi-user collaboration

pocket-claude runs one persistent Claude Code session. Multiple people can share the same context — same conversation history, same open files, same project knowledge.

**Option 1 — Individual DMs (separate threads, shared Claude process)**

Add teammates' Telegram user IDs to the allowlist:

```bash
# SSH into the VM, then:
sudo -u claude nano /home/claude/.claude/channels/telegram/access.json
```

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["111111111", "222222222", "333333333"],
  "groups": {},
  "pending": {}
}
```

Each person DMs the bot privately. Messages interleave in the same running session.

**Option 2 — Telegram Group (one shared thread)**

1. Create a Telegram group and add your bot to it
2. Get the group's chat ID (send a message, then check `https://api.telegram.org/bot<token>/getUpdates`)
3. Add the group ID to `access.json`:

```json
{
  "dmPolicy": "allowlist",
  "allowFrom": ["111111111"],
  "groups": { "-1001234567890": { "policy": "allow" } },
  "pending": {}
}
```

Everyone in the group now shares one conversation thread with full shared context. Ideal for teams working on the same project.

---

## Skills sync

Claude Code skills are custom prompt workflows stored in `~/.claude/skills/`. You can sync your local skills to the VM so the shared Claude environment has all your team's workflows.

**Linux / macOS:**
```bash
# Sync your entire local skills directory to the VM
bash scripts/sync-skills.sh ubuntu@<vm-ip>

# Sync a specific directory
bash scripts/sync-skills.sh ubuntu@<vm-ip> ~/my-project-skills

# Remove a skill from the VM
bash scripts/sync-skills.sh ubuntu@<vm-ip> --remove brand-identity
```

**Windows (PowerShell):**
```powershell
# Sync your entire local skills directory to the VM
.\scripts\sync-skills.ps1 -Remote ubuntu@<vm-ip>

# Sync a specific directory
.\scripts\sync-skills.ps1 -Remote ubuntu@<vm-ip> -SkillsDir C:\my-skills

# Remove a skill from the VM
.\scripts\sync-skills.ps1 -Remote ubuntu@<vm-ip> -Remove brand-identity
```

After syncing, restart the service to pick up the new skills:

```bash
ssh ubuntu@<vm-ip> 'sudo systemctl restart pocket-claude'
```

Skills from all teammates can be layered onto the shared VM — everyone contributes their workflows, everyone benefits.

---

## Operations

```bash
# Service
sudo systemctl status pocket-claude
sudo journalctl -u pocket-claude -f
sudo systemctl restart pocket-claude

# Update to latest
bash /opt/pocket-claude/update.sh

# Rotate bot token (if ever exposed: BotFather → /revoke → /token)
sudo -u claude bash /opt/pocket-claude/security/rotate-token.sh <new-token>

# Attach to Claude's terminal for debugging
sudo -u claude bash -c \
  'export TMUX_TMPDIR=$HOME/.pocket-claude/tmux; tmux attach -t pocket-claude'
```

---

## Project structure

```
pocket-claude/
├── install.sh                      # One-command installer (multi-distro)
├── update.sh                       # Pull latest + rebuild
├── daemon/
│   ├── start.sh                    # tmux launcher (called by systemd)
│   ├── switch.sh                   # Session switcher (called by MCP)
│   ├── watchdog.sh                 # Health check + Oracle keep-alive (cron)
│   └── pocket-claude.service       # systemd unit
├── session-manager/
│   ├── server.ts                   # MCP server: list / resume / new / status
│   ├── sessions.ts                 # Reads ~/.claude/projects/ JSONL files
│   ├── package.json
│   └── tsconfig.json
├── security/
│   ├── harden.sh                   # SSH + firewall + fail2ban hardening
│   └── rotate-token.sh             # Safe bot token rotation
├── scripts/
│   └── motd.sh                     # SSH login banner (installed on setup)
└── docs/
    ├── oracle-setup.md
    ├── getting-started.md
    └── security.md
```

---

## Security

- **Bot access**: Telegram user ID allowlist — unknown IDs silently dropped
- **Token storage**: `chmod 600`, excluded from git, never logged
- **Session IDs**: UUID v4 validated by regex at two independent layers before shell use
- **Shell injection**: all subprocesses use `execFileSync` with arg arrays — no string interpolation
- **Network**: only SSH port 22 open; Telegram uses outbound long-polling (no webhook, no inbound HTTP)
- **systemd sandbox**: `PrivateTmp`, `ProtectSystem=strict`, `NoNewPrivileges`, `PrivateDevices`
- **SSH**: password auth off, root login off, fail2ban (3 retries → 24h ban)

Full threat model: [docs/security.md](docs/security.md)

---

## Docs

- [Getting started](docs/getting-started.md)
- [Oracle Cloud setup](docs/oracle-setup.md)
- [Security architecture](docs/security.md)

---

## License

MIT — see [LICENSE](LICENSE)
