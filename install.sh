#!/usr/bin/env bash
# pocket-claude installer
# One-command setup: Ubuntu VM → fully running Claude Code on Telegram
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/romeocoding/pocket-claude/main/install.sh | bash
#   — or —
#   git clone https://github.com/romeocoding/pocket-claude && cd pocket-claude && bash install.sh
#
# Requirements: Ubuntu 22.04+ (x86_64 or ARM64), run as non-root user with sudo access.
# The installer creates a dedicated 'claude' user and runs the daemon under that account.

set -euo pipefail

REPO="https://github.com/romeocoding/pocket-claude"
INSTALL_DIR="/opt/pocket-claude"
STATE_DIR="$HOME/.pocket-claude"
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
  curl git tmux jq \
  ca-certificates gnupg2 \
  ufw fail2ban

# Node.js (via NodeSource)
if ! command -v node &>/dev/null || [[ "$(node -e 'process.exit(Number(process.version.slice(1).split(".")[0]) < '"$MIN_NODE_VERSION"')')" ]]; then
  info "Installing Node.js $MIN_NODE_VERSION..."
  curl -fsSL https://deb.nodesource.com/setup_${MIN_NODE_VERSION}.x | sudo -E bash - -qq
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

# ── Create claude user ────────────────────────────────────────────────────────

section "Setting up claude user"

if ! id "$CLAUDE_USER" &>/dev/null; then
  info "Creating user '$CLAUDE_USER'..."
  sudo useradd -m -s /bin/bash -G sudo "$CLAUDE_USER"
  # Disable password login for the claude user — key-based SSH only
  sudo passwd -l "$CLAUDE_USER"
fi

CLAUDE_HOME=$(eval echo "~$CLAUDE_USER")
info "Home: $CLAUDE_HOME"

# ── Install pocket-claude ─────────────────────────────────────────────────────

section "Installing pocket-claude"

if [[ -d "$INSTALL_DIR" ]]; then
  info "Updating existing install..."
  sudo git -C "$INSTALL_DIR" pull --quiet
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
sudo npm ci --quiet
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

# Inject session manager as MCP server in Claude Code settings
SETTINGS_FILE="$CLAUDE_CONFIG_DIR/settings.json"
if sudo -u "$CLAUDE_USER" test -f "$SETTINGS_FILE"; then
  # Merge: add session-manager if not already present
  sudo -u "$CLAUDE_USER" bash -c "
    jq '.mcpServers[\"pocket-claude-sessions\"] = {
      \"command\": \"node\",
      \"args\": [\"--experimental-strip-types\", \"$INSTALL_DIR/session-manager/server.ts\"]
    }' '$SETTINGS_FILE' > '${SETTINGS_FILE}.tmp' && mv '${SETTINGS_FILE}.tmp' '$SETTINGS_FILE'
  " 2>/dev/null || true
else
  sudo -u "$CLAUDE_USER" bash -c "cat > '$SETTINGS_FILE' << 'ENDJSON'
{
  \"mcpServers\": {
    \"pocket-claude-sessions\": {
      \"command\": \"node\",
      \"args\": [\"--experimental-strip-types\", \"$INSTALL_DIR/session-manager/server.ts\"]
    }
  }
}
ENDJSON"
fi
sudo -u "$CLAUDE_USER" chmod 600 "$SETTINGS_FILE"

# ── Telegram bot token ────────────────────────────────────────────────────────

section "Telegram configuration"

TELEGRAM_ENV="$CLAUDE_CONFIG_DIR/channels/telegram/.env"
sudo -u "$CLAUDE_USER" mkdir -p "$(dirname "$TELEGRAM_ENV")"
sudo -u "$CLAUDE_USER" chmod 700 "$(dirname "$TELEGRAM_ENV")"

if sudo -u "$CLAUDE_USER" test -f "$TELEGRAM_ENV"; then
  info "Telegram token already configured."
else
  echo ""
  echo "Enter your Telegram bot token from @BotFather:"
  echo "(Format: 123456789:AAH...)"
  read -r -s BOT_TOKEN

  # Validate format before writing
  if [[ ! "$BOT_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{35,}$ ]]; then
    error "Token format looks wrong. Re-run install.sh and enter the correct token."
  fi

  # Write without BOM, 600 perms
  sudo -u "$CLAUDE_USER" bash -c "
    printf 'TELEGRAM_BOT_TOKEN=%s\n' '$BOT_TOKEN' > '$TELEGRAM_ENV'
    chmod 600 '$TELEGRAM_ENV'
  "
  unset BOT_TOKEN
  info "Token saved."
fi

# ── systemd service ───────────────────────────────────────────────────────────

section "Installing systemd service"

sudo install -m 644 "$INSTALL_DIR/daemon/pocket-claude.service" \
  /etc/systemd/system/pocket-claude.service

# Patch User= to match CLAUDE_USER
sudo sed -i "s/^User=.*/User=$CLAUDE_USER/" /etc/systemd/system/pocket-claude.service
sudo sed -i "s/^Group=.*/Group=$CLAUDE_USER/" /etc/systemd/system/pocket-claude.service
sudo sed -i "s|/home/claude|$CLAUDE_HOME|g" /etc/systemd/system/pocket-claude.service

sudo systemctl daemon-reload
sudo systemctl enable pocket-claude

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
read -r -p "Run security hardening now? (SSH key-only, UFW, fail2ban) [Y/n]: " RUN_HARDEN
if [[ "${RUN_HARDEN:-Y}" =~ ^[Yy]?$ ]]; then
  sudo bash "$INSTALL_DIR/security/harden.sh"
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
sleep 2

if sudo systemctl is-active --quiet pocket-claude; then
  info "pocket-claude is running."
else
  warn "Service may not have started yet. Check: sudo journalctl -u pocket-claude -n 50"
fi

# ── Done ──────────────────────────────────────────────────────────────────────

section "Setup complete"

echo ""
echo -e "${GREEN}pocket-claude is installed and running.${NC}"
echo ""
echo "  DM @$(sudo -u "$CLAUDE_USER" bash -c "source $TELEGRAM_ENV 2>/dev/null; curl -s https://api.telegram.org/bot\${TELEGRAM_BOT_TOKEN}/getMe | jq -r '.result.username // \"your-bot\"'")"
echo "  to reach your Claude Code session from anywhere."
echo ""
echo "Commands:"
echo "  sudo systemctl status pocket-claude   — check status"
echo "  sudo journalctl -u pocket-claude -f   — live logs"
echo "  sudo systemctl restart pocket-claude  — restart"
echo "  bash $INSTALL_DIR/security/rotate-token.sh <new-token>  — rotate bot token"
echo ""
echo "From Telegram, ask Claude:"
echo "  'list my sessions'   — see recent conversations"
echo "  'resume session 3'   — switch to that session"
echo "  'start a new session'"
