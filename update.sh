#!/usr/bin/env bash
# pocket-claude updater
# Pulls latest code, rebuilds session manager, reloads systemd.
# Run as the same non-root user who ran install.sh.
set -euo pipefail

INSTALL_DIR="/opt/pocket-claude"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

info()  { echo -e "${GREEN}==>${NC} $*"; }
error() { echo -e "${RED}ERROR:${NC} $*" >&2; exit 1; }

[[ -d "$INSTALL_DIR" ]] || error "pocket-claude not installed at $INSTALL_DIR. Run install.sh first."

info "Pulling latest code..."
sudo git -C "$INSTALL_DIR" pull --quiet

info "Rebuilding session manager..."
cd "$INSTALL_DIR/session-manager"
sudo npm ci --quiet
cd - > /dev/null

info "Reloading systemd unit..."
sudo install -m 644 "$INSTALL_DIR/daemon/pocket-claude.service" \
  /etc/systemd/system/pocket-claude.service
sudo systemctl daemon-reload

info "Restarting pocket-claude..."
sudo systemctl restart pocket-claude
sleep 2

if sudo systemctl is-active --quiet pocket-claude; then
  info "pocket-claude updated and running."
else
  echo "Service may still be starting. Check: sudo journalctl -u pocket-claude -n 30"
fi
