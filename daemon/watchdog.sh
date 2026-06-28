#!/usr/bin/env bash
# pocket-claude watchdog
# Runs every 60s via cron. Checks Claude is alive inside tmux.
# If not, restarts via systemd and notifies via Telegram.
# Also: idle turn auto-release, due task notifications, keep-alive ping.
set -euo pipefail

export TMUX_TMPDIR="$HOME/.pocket-claude/tmux"

TMUX_SESSION="pocket-claude"
LOG_FILE="$HOME/.pocket-claude/watchdog.log"
TURN_FILE="$HOME/.pocket-claude/turn.json"
QUEUE_FILE="$HOME/.pocket-claude/queue.jsonl"
PANE_HASH_FILE="$HOME/.pocket-claude/pane_hash.txt"
PANE_IDLE_SINCE_FILE="$HOME/.pocket-claude/pane_idle_since.txt"
IDLE_THRESHOLD_MIN=10

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
  token=$(grep TELEGRAM_BOT_TOKEN "$token_file" 2>/dev/null | cut -d= -f2- || true)
  [[ -z "$token" ]] && return 0

  local user_ids
  user_ids=$(jq -r '.allowFrom[]?' "$access_file" 2>/dev/null || true)
  while IFS= read -r chat_id; do
    [[ -z "$chat_id" ]] && continue
    curl -sf "https://api.telegram.org/bot${token}/sendMessage" \
      --data-urlencode "chat_id=${chat_id}" \
      --data-urlencode "text=${msg}" \
      -o /dev/null --max-time 10 || true
  done <<< "$user_ids"

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

# Attempt a systemd restart, logging failure explicitly
# Includes last 5 log lines in the alert for context
restart_service() {
  local reason="$1"
  log "WARNING: $reason. Attempting systemd restart."
  local recent_logs
  recent_logs=$(tail -n 5 "$LOG_FILE" 2>/dev/null | sed 's/$/\\n/' | tr -d '\n' || true)
  notify_telegram "⚠️ pocket-claude: ${reason} — restarting
Recent log:
${recent_logs}"
  if sudo systemctl restart pocket-claude 2>/tmp/watchdog-restart-err; then
    log "INFO: pocket-claude restarted successfully."
  else
    local err
    err=$(cat /tmp/watchdog-restart-err 2>/dev/null || echo "(no stderr captured)")
    log "ERROR: systemd restart failed: ${err}"
    notify_telegram "❌ pocket-claude: restart FAILED — SSH in to fix. Error: ${err}"
  fi
  rm -f /tmp/watchdog-restart-err
}

# ─── Health check ────────────────────────────────────────────────────────────

if ! tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  restart_service "tmux session '$TMUX_SESSION' not found"
  exit 0
fi

PANE_PID=$(tmux list-panes -t "$TMUX_SESSION" -F "#{pane_pid}" 2>/dev/null | head -1)
if [[ -z "$PANE_PID" ]]; then
  restart_service "no tmux panes found in session"
  exit 0
fi

PROC_NAME=$(ps -p "$PANE_PID" -o comm= 2>/dev/null || true)
if [[ "${PROC_NAME:-}" != "claude" ]]; then
  restart_service "pane process is '${PROC_NAME:-dead}' (pid $PANE_PID), expected 'claude'"
  exit 0
fi

# ─── Pane idle detection + turn auto-release ─────────────────────────────────

CURRENT_HASH=$(tmux capture-pane -t "$TMUX_SESSION" -p 2>/dev/null | md5sum | cut -d' ' -f1 || true)

if [[ -n "$CURRENT_HASH" ]]; then
  STORED_HASH=$(cat "$PANE_HASH_FILE" 2>/dev/null || echo "")

  if [[ "$CURRENT_HASH" != "$STORED_HASH" ]]; then
    # Pane changed — reset idle timer
    echo "$CURRENT_HASH" > "$PANE_HASH_FILE"
    rm -f "$PANE_IDLE_SINCE_FILE"
  else
    # Pane unchanged — track idle duration
    if [[ ! -f "$PANE_IDLE_SINCE_FILE" ]]; then
      date +%s > "$PANE_IDLE_SINCE_FILE"
    else
      IDLE_SINCE=$(cat "$PANE_IDLE_SINCE_FILE" 2>/dev/null || echo 0)
      NOW=$(date +%s)
      IDLE_MIN=$(( (NOW - IDLE_SINCE) / 60 ))

      if [[ $IDLE_MIN -ge $IDLE_THRESHOLD_MIN ]] && [[ -f "$TURN_FILE" ]]; then
        TURN_HOLDER=$(jq -r '.holder_name // .holder // ""' "$TURN_FILE" 2>/dev/null || echo "")
        if [[ -n "$TURN_HOLDER" ]]; then
          log "INFO: Pane idle for ${IDLE_MIN}m — auto-releasing turn held by $TURN_HOLDER"
          rm -f "$TURN_FILE"
          notify_telegram "🔄 pocket-claude: turn auto-released after ${IDLE_MIN}m idle (was held by ${TURN_HOLDER})"
        fi
      fi
    fi
  fi
fi

# ─── Due task notifications ───────────────────────────────────────────────────

if [[ -f "$QUEUE_FILE" ]] && command -v jq &>/dev/null; then
  NOW_EPOCH=$(date +%s)
  NOTIFIED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue

    STATUS=$(echo "$line" | jq -r '.status // ""' 2>/dev/null)
    [[ "$STATUS" != "pending" ]] && continue

    NOTIFIED=$(echo "$line" | jq -r '.notified_at // ""' 2>/dev/null)
    [[ -n "$NOTIFIED" ]] && continue

    RUN_AFTER=$(echo "$line" | jq -r '.run_after // ""' 2>/dev/null)
    if [[ -n "$RUN_AFTER" ]]; then
      RUN_EPOCH=$(date -d "$RUN_AFTER" +%s 2>/dev/null || echo 0)
      [[ $RUN_EPOCH -gt $NOW_EPOCH ]] && continue
    fi

    TASK_ID=$(echo "$line" | jq -r '.id // ""' 2>/dev/null)
    TASK_DESC=$(echo "$line" | jq -r '.description // ""' 2>/dev/null)
    [[ -z "$TASK_ID" ]] && continue

    log "INFO: Due task notification: ${TASK_ID:0:8} ($TASK_DESC)"
    notify_telegram "⏰ Scheduled task due: \"$TASK_DESC\"
Task ID: ${TASK_ID:0:8}"

    # Mark notified in queue file via tmp+rename
    TMP_QUEUE="${QUEUE_FILE}.tmp.$$"
    while IFS= read -r qline; do
      [[ -z "$qline" ]] && continue
      QID=$(echo "$qline" | jq -r '.id // ""' 2>/dev/null)
      if [[ "$QID" == "$TASK_ID" ]]; then
        echo "$qline" | jq --arg t "$NOTIFIED_AT" '. + {notified_at: $t}' >> "$TMP_QUEUE"
      else
        echo "$qline" >> "$TMP_QUEUE"
      fi
    done < "$QUEUE_FILE"
    [[ -f "$TMP_QUEUE" ]] && mv "$TMP_QUEUE" "$QUEUE_FILE"

  done < "$QUEUE_FILE"
fi

# ─── Oracle Always Free keep-alive ───────────────────────────────────────────
# Runs AFTER health check so a crash is detected within 60s even on network blips.
curl -sf --max-time 10 https://1.1.1.1 -o /dev/null &

log "OK (claude pid=$PANE_PID)"
