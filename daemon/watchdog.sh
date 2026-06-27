#!/usr/bin/env bash
# pocket-claude watchdog
# Runs every 60s via cron. Checks Claude is alive inside tmux.
# If not, restarts via systemd (which handles backoff/limits).
# Also sends an Oracle keep-alive ping to prevent idle-VM reclamation.
set -euo pipefail

# Must match the path set in pocket-claude.service Environment=TMUX_TMPDIR
export TMUX_TMPDIR="$HOME/.pocket-claude/tmux"

TMUX_SESSION="pocket-claude"
LOG_FILE="$HOME/.pocket-claude/watchdog.log"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG_FILE"; }

# Rotate log at 1 MB
if [[ -f "$LOG_FILE" ]] && [[ $(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0) -gt 1048576 ]]; then
  mv "$LOG_FILE" "${LOG_FILE}.1"
fi

# Check tmux session exists
if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  log "WARNING: tmux session '$TMUX_SESSION' not found. Triggering systemd restart."
  sudo systemctl restart pocket-claude 2>/dev/null || \
    log "ERROR: Could not restart pocket-claude service. Check sudoers: /etc/sudoers.d/pocket-claude"
  exit 0
fi

# Check claude process is alive in the pane
PANE_PID=$(tmux list-panes -t "$TMUX_SESSION" -F "#{pane_pid}" 2>/dev/null | head -1)
if [[ -z "$PANE_PID" ]]; then
  log "WARNING: No panes in session. Restarting."
  sudo systemctl restart pocket-claude 2>/dev/null || true
  exit 0
fi

if ! pgrep -P "$PANE_PID" claude > /dev/null 2>&1; then
  log "WARNING: Claude process not found under pane pid $PANE_PID. Restarting."
  sudo systemctl restart pocket-claude 2>/dev/null || true
  exit 0
fi

# Oracle keep-alive: write a tiny file to block idle detection
# Oracle reclaims VMs it considers idle. A file write every minute prevents this.
touch "$HOME/.pocket-claude/.keepalive"

log "OK"
