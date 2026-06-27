#!/usr/bin/env bash
# pocket-claude installer
# One-command setup: Ubuntu VM → fully running Claude Code on Telegram
#
# Usage (interactive terminal required):
#   curl -fsSL https://raw.githubusercontent.com/romeocoding/pocket-claude/main/install.sh -o install.sh
#   bash install.sh
#   — or —
#   git clone https://github.com/romeocoding/pocket-claude && cd pocket-claude && bash install.sh
#
# Requirements: Ubuntu 22.04+ (x86_64 or ARM64), run as non-root user with sudo access.
# The installer creates a dedicated 'claude' user and runs the daemon under that account.

set -euo pipefail

REPO="https://github.com/romeocoding/pocket-claude"
INSTALL_DIR="/opt/pocket-claude"
CLAUDE_USER="claude"
MIN_NODE_VERSION=22

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

info()    { echo -e "${GREEN}==>${NC} $*"; }
warn()    { echo -e "${YELLOW}WARN:${NC} $*"; }
error()   { echo -e "${RED}ERROR:${NC} $*" >&2; exit 1; }
section() { echo -e "\n${BOLD}── $* ──${NC}"; }

# ── Preflight checks ─────────────────────────────────────────────────────────

section "Preflight"

# Require interactive terminal — piped installs break the prompts
if [[ ! -t 0 ]]; then
  echo ""
  echo -e "${RED}ERROR:${NC} This installer requires an interactive terminal."
  echo ""
  echo "Download and run it directly:"
  echo "  curl -fsSL https://raw.githubusercontent.com/romeocoding/pocket-claude/main/install.sh -o install.sh"
  echo "  bash install.sh"
  echo ""
  exit 1
fi

[[ "$(uname -s)" == "Linux" ]] || error "Linux only."
[[ -f /etc/os-release ]] && source /etc/os-release || true
[[ "${ID:-}" == "ubuntu" ]] || warn "Tested on Ubuntu. Other distros may need manual adjustment."

if [[ $EUID -eq 0 ]]; then
  error "Do not run as root. Run as a regular user with sudo access."
fi

# Check sudo without password caching prompt (just verify it works)
sudo -n true 2>/dev/null || { sudo true || error "sudo required. Add your user to sudoers."; }

info "System: $(uname -m) / ${PRETTY_NAME:-Linux}"

# ── Dependencies ──────────────────────────────────────────────────────────────

section "Installing dependencies"

sudo apt-get update -qq
sudo apt-get install -y -qq \
  curl git tmux jq cron unzip \
  ca-certificates gnupg2 \
  ufw fail2ban

# Node.js (via NodeSource)
if ! command -v node &>/dev/null || ! node -e "if(parseInt(process.version.slice(1))<$MIN_NODE_VERSION)process.exit(1)" 2>/dev/null; then
  info "Installing Node.js $MIN_NODE_VERSION..."
  curl -fsSL https://deb.nodesource.com/setup_${MIN_NODE_VERSION}.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi

NODE_VER=$(node -e 'console.log(Number(process.version.slice(1).split(".")[0]))')
[[ "$NODE_VER" -ge "$MIN_NODE_VERSION" ]] || error "Node.js >= $MIN_NODE_VERSION required, got $NODE_VER"
info "Node.js: $(node --version)"

# Claude Code
if ! command -v claude &>/dev/null; then
  info "Installing Claude Code..."
  sudo npm install -g @anthropic-ai/claude-code --quiet
fi
info "Claude Code: $(claude --version 2>/dev/null || echo 'installed')"

# Bun (required for the official Telegram plugin)
if ! command -v bun &>/dev/null; then
  info "Installing Bun (required for Telegram plugin)..."
  curl -fsSL https://bun.sh/install | sudo -E HOME=/root bash - 2>/dev/null
  if [[ -f /root/.bun/bin/bun ]]; then
    sudo ln -sf /root/.bun/bin/bun /usr/local/bin/bun
  fi
fi
if command -v bun &>/dev/null; then
  info "Bun: $(bun --version)"
else
  warn "Bun not found after install attempt. The Telegram plugin may not work."
fi

# ── Create claude user ────────────────────────────────────────────────────────

section "Setting up claude user"

if ! id "$CLAUDE_USER" &>/dev/null; then
  info "Creating user '$CLAUDE_USER'..."
  sudo useradd -m -s /bin/bash "$CLAUDE_USER"
  # Disable password login — key-based SSH only, sudo via sudoers rules
  sudo passwd -l "$CLAUDE_USER"
fi

CLAUDE_HOME=$(eval echo "~$CLAUDE_USER")
info "Home: $CLAUDE_HOME"

# ── Install pocket-claude ─────────────────────────────────────────────────────

section "Installing pocket-claude"

if [[ -d "$INSTALL_DIR/.git" ]]; then
  info "Updating existing install..."
  sudo git -C "$INSTALL_DIR" pull --quiet || warn "git pull skipped (no remote configured)"
elif [[ -d "$INSTALL_DIR" ]]; then
  info "Using existing install directory."
else
  info "Cloning pocket-claude..."
  sudo git clone --quiet "$REPO" "$INSTALL_DIR"
fi

sudo chown -R root:root "$INSTALL_DIR"
sudo chmod -R 755 "$INSTALL_DIR"
sudo chmod +x "$INSTALL_DIR"/daemon/*.sh "$INSTALL_DIR"/security/*.sh

# ── Session manager MCP ───────────────────────────────────────────────────────

section "Installing session manager"

cd "$INSTALL_DIR/session-manager"
sudo npm install --quiet
cd - > /dev/null

# ── State directory for claude user ──────────────────────────────────────────

sudo -u "$CLAUDE_USER" mkdir -p "$CLAUDE_HOME/.pocket-claude"
sudo -u "$CLAUDE_USER" chmod 700 "$CLAUDE_HOME/.pocket-claude"

# Install switch.sh where session-manager expects it
sudo install -m 755 -o "$CLAUDE_USER" -g "$CLAUDE_USER" \
  "$INSTALL_DIR/daemon/switch.sh" \
  "$CLAUDE_HOME/.pocket-claude/switch.sh"

# Install start.sh
sudo install -m 755 -o "$CLAUDE_USER" -g "$CLAUDE_USER" \
  "$INSTALL_DIR/daemon/start.sh" \
  "$CLAUDE_HOME/.pocket-claude/start.sh"

# ── Claude Code config for claude user ───────────────────────────────────────

section "Configuring Claude Code"

CLAUDE_CONFIG_DIR="$CLAUDE_HOME/.claude"
sudo -u "$CLAUDE_USER" mkdir -p "$CLAUDE_CONFIG_DIR"
SETTINGS_FILE="$CLAUDE_CONFIG_DIR/settings.json"

# Build the base settings object using jq (avoids all shell quoting issues)
NEW_SETTINGS=$(jq -n \
  --arg install_dir "$INSTALL_DIR" \
  '{
    "theme": "dark",
    "permissions": {
      "allow": [
        "mcp__plugin_telegram_telegram__reply",
        "mcp__plugin_telegram_telegram__react",
        "mcp__plugin_telegram_telegram__edit_message",
        "mcp__plugin_telegram_telegram__download_attachment",
        "Bash(*)", "Read(*)", "Write(*)", "Edit(*)", "Glob(*)",
        "WebSearch(*)", "WebFetch(*)"
      ]
    },
    "mcpServers": {
      "pocket-claude-sessions": {
        "command": "node",
        "args": ["--experimental-strip-types", ($install_dir + "/session-manager/server.ts")]
      }
    }
  }'
)

if sudo -u "$CLAUDE_USER" test -f "$SETTINGS_FILE"; then
  # Merge: our settings take precedence so permissions/mcpServers are always correct
  MERGED=$(sudo cat "$SETTINGS_FILE" | jq --argjson new "$NEW_SETTINGS" '. * $new')
  echo "$MERGED" | sudo -u "$CLAUDE_USER" tee "$SETTINGS_FILE" > /dev/null
  info "Settings merged."
else
  echo "$NEW_SETTINGS" | sudo -u "$CLAUDE_USER" tee "$SETTINGS_FILE" > /dev/null
  info "Settings created."
fi
sudo chmod 600 "$SETTINGS_FILE"

# ── Telegram bot token ────────────────────────────────────────────────────────

section "Telegram configuration"

TELEGRAM_DIR="$CLAUDE_CONFIG_DIR/channels/telegram"
TELEGRAM_ENV="$TELEGRAM_DIR/.env"
sudo -u "$CLAUDE_USER" mkdir -p "$TELEGRAM_DIR"
sudo chmod 700 "$TELEGRAM_DIR"

if sudo -u "$CLAUDE_USER" test -f "$TELEGRAM_ENV"; then
  info "Telegram token already configured."
else
  echo ""
  echo "Enter your Telegram bot token from @BotFather:"
  echo "(Format: 123456789:AAH...)"
  read -r -s BOT_TOKEN

  # Validate format before writing
  if [[ ! "$BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{35,}$ ]]; then
    error "Token format looks wrong. Expected: 123456789:AAH... Re-run install.sh and try again."
  fi

  # Show masked confirmation so user can verify they pasted the right token
  TOKEN_PREVIEW="${BOT_TOKEN:0:10}***${BOT_TOKEN: -4}"
  echo "Token received: $TOKEN_PREVIEW"
  read -r -p "Does that look right? [Y/n]: " TOKEN_OK
  if [[ ! "${TOKEN_OK:-Y}" =~ ^[Yy]?$ ]]; then
    error "Cancelled. Re-run install.sh and enter the correct token."
  fi

  # Write without BOM, 600 perms
  printf 'TELEGRAM_BOT_TOKEN=%s\n' "$BOT_TOKEN" | sudo -u "$CLAUDE_USER" tee "$TELEGRAM_ENV" > /dev/null
  sudo chmod 600 "$TELEGRAM_ENV"
  unset BOT_TOKEN
  info "Token saved."
fi

# ── Telegram access control ───────────────────────────────────────────────────

section "Telegram access control"

ACCESS_FILE="$TELEGRAM_DIR/access.json"

if sudo -u "$CLAUDE_USER" test -f "$ACCESS_FILE"; then
  info "Access control already configured."
else
  echo ""
  echo "Who should be able to use your bot?"
  echo ""
  echo "You need your Telegram user ID (a number, NOT your username)."
  echo "  1. Open Telegram and message @userinfobot"
  echo "  2. It will reply with your user ID (e.g. 6765294456)"
  echo ""
  read -r -p "Enter your Telegram user ID: " TELEGRAM_USER_ID

  # Validate: must be a positive integer
  if [[ ! "$TELEGRAM_USER_ID" =~ ^[0-9]{5,}$ ]]; then
    error "Invalid Telegram user ID. It should be a number like 6765294456."
  fi

  # Write access.json — allowlist mode, only this ID can DM the bot
  printf '{"dmPolicy":"allowlist","allowFrom":["%s"],"groups":{},"pending":{}}\n' \
    "$TELEGRAM_USER_ID" | sudo -u "$CLAUDE_USER" tee "$ACCESS_FILE" > /dev/null
  sudo chmod 600 "$ACCESS_FILE"
  info "Bot locked to Telegram user ID $TELEGRAM_USER_ID"
fi

# ── systemd service ───────────────────────────────────────────────────────────

section "Installing systemd service"

sudo install -m 644 "$INSTALL_DIR/daemon/pocket-claude.service" \
  /etc/systemd/system/pocket-claude.service

# Patch User=/Group= and all /home/claude paths to match actual CLAUDE_HOME
sudo sed -i "s/^User=.*/User=$CLAUDE_USER/" /etc/systemd/system/pocket-claude.service
sudo sed -i "s/^Group=.*/Group=$CLAUDE_USER/" /etc/systemd/system/pocket-claude.service
sudo sed -i "s|/home/claude|$CLAUDE_HOME|g" /etc/systemd/system/pocket-claude.service

sudo systemctl daemon-reload
sudo systemctl enable pocket-claude

# ── Sudoers rule for watchdog ──────────────────────────────────────────────────

# Allow the claude user to restart the service from the watchdog cron job
SUDOERS_FILE="/etc/sudoers.d/pocket-claude"
echo "$CLAUDE_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart pocket-claude, /usr/bin/systemctl start pocket-claude" \
  | sudo tee "$SUDOERS_FILE" > /dev/null
sudo chmod 440 "$SUDOERS_FILE"
sudo visudo -c -f "$SUDOERS_FILE" > /dev/null 2>&1 || {
  sudo rm -f "$SUDOERS_FILE"
  warn "sudoers validation failed — watchdog will not be able to restart the service automatically."
}
info "Sudoers: claude can restart pocket-claude"

# ── Watchdog cron ─────────────────────────────────────────────────────────────

section "Installing watchdog"

WATCHDOG_SRC="$INSTALL_DIR/daemon/watchdog.sh"
sudo install -m 755 -o "$CLAUDE_USER" -g "$CLAUDE_USER" \
  "$WATCHDOG_SRC" "$CLAUDE_HOME/.pocket-claude/watchdog.sh"

# Add to claude user's crontab (runs every minute)
CRON_LINE="* * * * * $CLAUDE_HOME/.pocket-claude/watchdog.sh"
sudo -u "$CLAUDE_USER" bash -c "
  (crontab -l 2>/dev/null | grep -v watchdog.sh; echo '$CRON_LINE') | crontab -
"
info "Watchdog: runs every minute"

# ── Security hardening ────────────────────────────────────────────────────────

section "Security hardening"

echo ""
echo "This disables SSH password auth (key-only) and enables UFW + fail2ban."
echo "IMPORTANT: Open a second SSH terminal and verify you can still connect"
echo "before closing this session."
echo ""
read -r -p "Run security hardening now? [Y/n]: " RUN_HARDEN
if [[ "${RUN_HARDEN:-Y}" =~ ^[Yy]?$ ]]; then
  sudo bash "$INSTALL_DIR/security/harden.sh"
  echo ""
  warn "SSH is now key-only. Verify access in a second terminal before closing this one."
else
  warn "Skipped. Run later: sudo bash $INSTALL_DIR/security/harden.sh"
fi

# ── Claude Code login ─────────────────────────────────────────────────────────

section "Claude Code authentication"

echo ""
echo "Claude Code needs to authenticate with your claude.ai account."
echo "A browser link will appear — open it on any device (phone or laptop)."
echo ""
read -r -p "Press Enter to start the login flow..."

sudo -u "$CLAUDE_USER" -i claude auth login

# ── Start ─────────────────────────────────────────────────────────────────────

section "Starting pocket-claude"

sudo systemctl start pocket-claude
sleep 5

if sudo systemctl is-active --quiet pocket-claude; then
  info "pocket-claude service is running."
else
  warn "Service may not have started yet. Check: sudo journalctl -u pocket-claude -n 50"
fi

# ── Telegram plugin setup ──────────────────────────────────────────────────────

section "Installing Telegram plugin"

echo ""
echo "The Telegram plugin must be installed through Claude Code's own UI."
echo "This will happen automatically — watch the steps below."
echo ""

TMUX_DIR="$CLAUDE_HOME/.pocket-claude/tmux"
# tmux creates socket at $TMUX_TMPDIR/tmux-<uid>/<name>
TMUX_CMD=(sudo -u "$CLAUDE_USER" bash -c "export TMUX_TMPDIR=$TMUX_DIR; tmux")

# Wait for tmux socket directory to populate (up to 60s)
info "Waiting for Claude Code to initialize..."
for i in {1..60}; do
  if sudo -u "$CLAUDE_USER" bash -c "export TMUX_TMPDIR=$TMUX_DIR; tmux has-session -t pocket-claude 2>/dev/null"; then
    break
  fi
  sleep 1
done

if ! sudo -u "$CLAUDE_USER" bash -c "export TMUX_TMPDIR=$TMUX_DIR; tmux has-session -t pocket-claude 2>/dev/null"; then
  warn "tmux session not found after 60s"
  warn "Plugin must be installed manually — see instructions below."
  PLUGIN_AUTO=false
else
  TSEND=(sudo -u "$CLAUDE_USER" bash -c "export TMUX_TMPDIR=$TMUX_DIR; tmux send-keys -t pocket-claude")

  # Handle first-run UI (theme picker / welcome screen) by pressing Enter
  "${TSEND[@]}" '' Enter 2>/dev/null || true
  sleep 3

  # Open plugin browser
  info "Opening plugin browser..."
  "${TSEND[@]}" '/plugins' Enter 2>/dev/null
  sleep 5

  # Search for telegram
  info "Searching for Telegram plugin..."
  "${TSEND[@]}" 'telegram' 2>/dev/null
  sleep 3

  # Select first result (Space) then install (i)
  "${TSEND[@]}" ' ' 2>/dev/null
  sleep 1
  "${TSEND[@]}" 'i' 2>/dev/null

  info "Installing Telegram plugin (downloading ~30s)..."
  sleep 40

  # Reload
  "${TSEND[@]}" '/reload-plugins' Enter 2>/dev/null
  sleep 5

  PLUGIN_AUTO=true
  info "Plugin install commands sent."
fi

# ── Done ──────────────────────────────────────────────────────────────────────

section "Setup complete"

echo ""
echo -e "${GREEN}pocket-claude is installed and running.${NC}"
echo ""

if [[ "${PLUGIN_AUTO:-false}" == "true" ]]; then
  echo "The Telegram plugin install was triggered automatically."
  echo "If it didn't complete, follow the manual steps:"
  echo ""
else
  echo -e "${YELLOW}ACTION REQUIRED — install the Telegram plugin manually:${NC}"
  echo ""
fi

echo "  Manual plugin install (if needed):"
echo "    1. SSH into the VM and run:"
echo "         sudo -u $CLAUDE_USER bash -c 'export TMUX_TMPDIR=$CLAUDE_HOME/.pocket-claude/tmux; tmux attach -t pocket-claude'"
echo "    2. Type:  /plugins"
echo "    3. Type:  telegram  (to search)"
echo "    4. Press: Space  (to select telegram@claude-plugins-official)"
echo "    5. Press: i  (to install)"
echo "    6. Wait ~30 seconds"
echo "    7. Type:  /reload-plugins"
echo "    8. Press: Ctrl+B then D  (to detach from tmux)"
echo ""
echo "Commands:"
echo "  sudo systemctl status pocket-claude       — check status"
echo "  sudo journalctl -u pocket-claude -f       — live logs"
echo "  sudo systemctl restart pocket-claude      — restart"
echo "  sudo -u $CLAUDE_USER bash $INSTALL_DIR/security/rotate-token.sh <new-token>  — rotate bot token"
echo ""
echo "From Telegram, ask Claude:"
echo "  'list my sessions'     — see recent conversations"
echo "  'resume session 3'     — switch to that session"
echo "  'start a new session'"
echo ""
echo "  Open Telegram and DM your bot to start."
