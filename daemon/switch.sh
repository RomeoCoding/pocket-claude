#!/usr/bin/env bash
# pocket-claude session switch
# Called by the session-manager MCP to resume or start a new session.
# Writes the desired session ID to a file, then kills the current Claude
# process. systemd restarts it via start.sh, which picks up the file.
set -euo pipefail

export TMUX_TMPDIR="$HOME/.pocket-claude/tmux"

STATE_DIR="$HOME/.pocket-claude"
RESUME_FILE="$STATE_DIR/resume_next"
TMUX_SESSION="pocket-claude"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

MODE="${1:-}"
SESSION_ID="${2:-}"

if [[ "$MODE" == "--new" ]]; then
  rm -f "$RESUME_FILE"
elif [[ "$MODE" == "--resume" ]]; then
  if [[ ! "$SESSION_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
    echo "ERROR: invalid session ID" >&2
    exit 1
  fi
  printf '%s' "$SESSION_ID" > "$RESUME_FILE"
  chmod 600 "$RESUME_FILE"
else
  echo "Usage: switch.sh --new | --resume <session-id>" >&2
  exit 1
fi

# Send interrupt to Claude — then verify it actually died before returning
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  PANE_PID=$(tmux list-panes -t "$TMUX_SESSION" -F "#{pane_pid}" 2>/dev/null | head -1)

  tmux send-keys -t "$TMUX_SESSION" C-c 2>/dev/null || true
  sleep 0.5
  tmux send-keys -t "$TMUX_SESSION" "exit" Enter 2>/dev/null || true

  # Wait up to 5s for the process to die
  DEADLINE=$(( $(date +%s) + 5 ))
  while [[ $(date +%s) -lt $DEADLINE ]]; do
    PROC=$(ps -p "$PANE_PID" -o comm= 2>/dev/null || echo "")
    if [[ "$PROC" != "claude" ]]; then
      exit 0  # process gone — systemd will restart
    fi
    sleep 0.5
  done

  # Claude didn't respond to C-c — force-kill the pane process
  kill -9 "$PANE_PID" 2>/dev/null || true
fi
