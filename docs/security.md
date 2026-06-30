# Security Architecture

pocket-claude is designed with zero inbound attack surface. This document explains the threat model, what's protected, and what you're responsible for.

---

## Threat model

| Threat | Mitigation |
|--------|-----------|
| Unauthorized Telegram access | Per-user allowlist (`access.json`); unknown IDs are silently dropped |
| Bot token theft | Token stored at `~/.claude/channels/telegram/.env` with `chmod 600`; excluded from git |
| SSH brute force | fail2ban: 3 retries → 24-hour IP ban |
| SSH password attack | Password auth disabled; key-only login enforced |
| Network scanning | UFW default deny inbound; only port 22 open |
| Session ID injection | Double UUID validation (TypeScript + bash regex) before any shell use |
| Shell injection via session IDs | `execFileSync` with arg arrays — never string interpolation |
| Privilege escalation | Daemon runs as dedicated `claude` user, not root; `NoNewPrivileges=true` in systemd |
| systemd sandbox escape | `ProtectSystem=strict`, `PrivateTmp=true`, `PrivateDevices=true`, `ProtectKernelTunables=true` |
| Log tampering | Log files owned by `claude` user; watchdog log rotated at 1 MB |
| Bot token in memory | Token read at startup only; not re-read from disk on each request |

---

## Network architecture

```
[Your phone] ──HTTPS──▶ [Telegram servers] ──HTTPS──▶ [VM: long-polling outbound]
                                                              │
                                                        [Claude Code]
                                                              │
                                                    [Session manager MCP]
```

**No inbound HTTP.** Telegram connections are initiated by the VM, not by Telegram pushing to a webhook. This means:
- No public port for Telegram traffic
- No SSL certificate needed
- No web server to attack

The only inbound port is SSH (22), protected by key auth and fail2ban.

---

## File permissions

| Path | Perms | Owner |
|------|-------|-------|
| `~/.claude/channels/telegram/.env` | 600 | claude |
| `~/.claude/channels/telegram/access.json` | 600 | claude |
| `~/.claude/settings.json` | 600 | claude |
| `~/.pocket-claude/` | 700 | claude |
| `~/.pocket-claude/resume_next` | 600 | claude |
| `~/.pocket-claude/turn.lock` | 600 | claude |
| `~/.pocket-claude/queue.jsonl` | 600 | claude |
| `~/.pocket-claude/seen_users.json` | 600 | claude |
| `~/.pocket-claude/pinned.json` | 600 | claude |
| `/opt/pocket-claude/` | 755 | root:root |

---

## What is NOT in git

The `.gitignore` excludes:
- `.env` files (Telegram token)
- `access.json` (Telegram allowlist with your user ID)
- `*.log` files
- `node_modules/`
- `dist/`

Never commit your bot token. If you do, revoke it immediately via @BotFather (`/revoke`) and rotate with:
```bash
bash /opt/pocket-claude/security/rotate-token.sh <new-token>
```

---

## Session ID security

Claude Code session IDs are UUIDs (version 4). Before any session ID is used in a file path or shell command, it is validated against the strict RFC 4122 v4 regex in two places:

1. **`session-manager/sessions.ts`** — `isValidSessionId()` validates before the ID is accepted from MCP input
2. **`daemon/switch.sh`** — bash regex validates before writing to `resume_next`

Session IDs are never interpolated into shell strings. The switch script is called via `execFileSync('bash', ['switch.sh', '--resume', sessionId])` — the ID is passed as a separate argument, not concatenated.

---

## Rotating the bot token

If you suspect your token is compromised:

1. Open Telegram → @BotFather → `/revoke` → select your bot → `/token`
2. Copy the new token
3. On the VM: `bash /opt/pocket-claude/security/rotate-token.sh <new-token>`

The script validates the format, backs up the old `.env`, writes the new one with `printf` (no BOM), and restarts the service.

---

## What you're responsible for

- **Protecting your SSH private key.** If someone gets your key, they own the VM.
- **Protecting your Telegram account.** Enable 2FA in Telegram settings.
- **Your claude.ai credentials.** OAuth tokens are stored by Claude Code in `~/.claude/` — treat your VM like a device with your account logged in.
- **Reviewing what Claude does.** Claude Code can read and write files, run commands, and make network requests. The access.json allowlist only controls who can send messages — it does not restrict what Claude can do once a message is accepted.

---

## Reporting security issues

Open a private security advisory at the GitHub repository. Do not post vulnerability details in public issues.
