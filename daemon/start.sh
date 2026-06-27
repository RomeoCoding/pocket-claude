#!/usr/bin/env bash
# pocket-claude start script
# Runs as the 'claude' user via systemd. Starts Claude Code inside tmux
# with the Telegram channel plugin enabled.
set -euo pipefail

STATE_DIR="$HOME/.pocket-claude"
PID_FILE="$STATE_DIR/daemon.pid"
LOG_FILE="$STATE_DIR/start.log"
TMUX_SESSION="pocket-claude"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

# Ensure tmux socket directory exists (TMUX_TMPDIR set by systemd environment)
mkdir -p "${TMUX_TMPDIR:-$STATE_DIR/tmux}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG_FILE"; }

# Kill any stale session
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  log "Killing stale tmux session"
  tmux kill-session -t "$TMUX_SESSION" || true
fi

# Write start time for status reporting
echo "{\"startedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$STATE_DIR/state.json"
chmod 600 "$STATE_DIR/state.json"

# Determine resume flag
RESUME_FILE="$STATE_DIR/resume_next"
SESSION_ID=""
if [[ -f "$RESUME_FILE" ]]; then
  RAW_ID=$(cat "$RESUME_FILE")
  rm -f "$RESUME_FILE"
  # Strict UUID v4 validation before using in any command
  if [[ "$RAW_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
    SESSION_ID="$RAW_ID"
    log "Resuming session: $SESSION_ID"
  else
    log "WARNING: Invalid session ID in resume_next, starting fresh"
  fi
fi

# Build args array — never interpolate session ID into a string
CLAUDE_ARGS=(claude --channels plugin:telegram@claude-plugins-official)
if [[ -n "$SESSION_ID" ]]; then
  CLAUDE_ARGS+=(--resume "$SESSION_ID")
fi

log "Starting: ${CLAUDE_ARGS[*]}"

# New detached tmux session — args passed as array, not a shell string
tmux new-session -d -s "$TMUX_SESSION" -- "${CLAUDE_ARGS[@]}"

# Store tmux pid so systemd can track it
TMUX_PID=$(tmux list-panes -t "$TMUX_SESSION" -F "#{pane_pid}" | head -1)
echo "$TMUX_PID" > "$PID_FILE"
chmod 600 "$PID_FILE"

log "Started. tmux session=$TMUX_SESSION pid=$TMUX_PID"
