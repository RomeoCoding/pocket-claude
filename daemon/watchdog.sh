#!/usr/bin/env bash
# pocket-claude watchdog
# Runs every 60s via cron. Checks Claude is alive inside tmux.
# If not, restarts via systemd and notifies via Telegram.
# Also pings a URL to keep Oracle Always Free VM from idle reclamation.
set -euo pipefail

export TMUX_TMPDIR="$HOME/.pocket-claude/tmux"

TMUX_SESSION="pocket-claude"
LOG_FILE="$HOME/.pocket-claude/watchdog.log"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG_FILE"; }

# Rotate log at 1 MB
if [[ -f "$LOG_FILE" ]] && [[ $(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0) -gt 1048576 ]]; then
  mv "$LOG_FILE" "${LOG_FILE}.1"
fi

# Send a Telegram message to all allowlisted users AND group chats
notify_telegram() {
  local msg="$1"
  local token_file="$HOME/.claude/channels/telegram/.env"
  local access_file="$HOME/.claude/channels/telegram/access.json"
  [[ -f "$token_file" ]] && [[ -f "$access_file" ]] || return 0
  local token
  # cut -d= -f2- keeps everything after the first = (tokens can contain = in base64)
  token=$(grep TELEGRAM_BOT_TOKEN "$token_file" 2>/dev/null | cut -d= -f2- || true)
  [[ -z "$token" ]] && return 0

  # Notify DM-allowlisted users
  local user_ids
  user_ids=$(jq -r '.allowFrom[]?' "$access_file" 2>/dev/null || true)
  while IFS= read -r chat_id; do
    [[ -z "$chat_id" ]] && continue
    curl -sf "https://api.telegram.org/bot${token}/sendMessage" \
      --data-urlencode "chat_id=${chat_id}" \
      --data-urlencode "text=${msg}" \
      -o /dev/null --max-time 10 || true
  done <<< "$user_ids"

  # Also notify configured group chats
  local group_ids
  group_ids=$(jq -r '.groups | keys[]?' "$access_file" 2>/dev/null || true)
  while IFS= read -r chat_id; do
    [[ -z "$chat_id" ]] && continue
    curl -sf "https://api.telegram.org/bot${token}/sendMessage" \
      --data-urlencode "chat_id=${chat_id}" \
      --data-urlencode "text=${msg}" \
      -o /dev/null --max-time 10 || true
  done <<< "$group_ids"
}

# Attempt a systemd restart, logging failure explicitly rather than swallowing it
restart_service() {
  local reason="$1"
  log "WARNING: $reason. Attempting systemd restart."
  notify_telegram "⚠️ pocket-claude: ${reason} — restarting"
  if sudo systemctl restart pocket-claude 2>/tmp/watchdog-restart-err; then
    log "INFO: pocket-claude restarted successfully."
  else
    local err
    err=$(cat /tmp/watchdog-restart-err 2>/dev/null || echo "(no stderr captured)")
    log "ERROR: systemd restart failed: ${err}"
    log "ERROR: Manual intervention required. SSH in and run: sudo systemctl restart pocket-claude"
    notify_telegram "❌ pocket-claude: restart FAILED — SSH in to fix. Error: ${err}"
  fi
  rm -f /tmp/watchdog-restart-err
}

# Check tmux session exists
if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  restart_service "tmux session '$TMUX_SESSION' not found"
  exit 0
fi

# Get the PID of the process running directly in the tmux pane
PANE_PID=$(tmux list-panes -t "$TMUX_SESSION" -F "#{pane_pid}" 2>/dev/null | head -1)
if [[ -z "$PANE_PID" ]]; then
  restart_service "no tmux panes found in session"
  exit 0
fi

# pane_pid IS the claude process when started with `tmux new-session -- claude`
PROC_NAME=$(ps -p "$PANE_PID" -o comm= 2>/dev/null || true)
if [[ "${PROC_NAME:-}" != "claude" ]]; then
  restart_service "pane process is '${PROC_NAME:-dead}' (pid $PANE_PID), expected 'claude'"
  exit 0
fi

# Oracle Always Free keep-alive: runs AFTER health check so a crash is detected
# within 60s even on network blips. Generates outbound traffic Oracle monitors.
curl -sf --max-time 10 https://1.1.1.1 -o /dev/null &

log "OK (claude pid=$PANE_PID)"
