#!/usr/bin/env bash
# pocket-claude session switch
# Called by the session-manager MCP to resume or start a new session.
# Writes the desired session ID to a file, then kills the current Claude
# process. systemd restarts it via start.sh, which picks up the file.
set -euo pipefail

# Must match the path set in pocket-claude.service Environment=TMUX_TMPDIR
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
  # Validate UUID before writing — belt-and-suspenders on top of server.ts validation
  if [[ ! "$SESSION_ID" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$ ]]; then
    echo "ERROR: invalid session ID" >&2
    exit 1
  fi
  # Write with restricted permissions — only claude user can read
  printf '%s' "$SESSION_ID" > "$RESUME_FILE"
  chmod 600 "$RESUME_FILE"
else
  echo "Usage: switch.sh --new | --resume <session-id>" >&2
  exit 1
fi

# Send interrupt to Claude process in the tmux pane, then let systemd restart it
# We don't kill tmux itself — systemd's ExecStop does that if needed
if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
  tmux send-keys -t "$TMUX_SESSION" C-c 2>/dev/null || true
  sleep 0.3
  tmux send-keys -t "$TMUX_SESSION" "exit" Enter 2>/dev/null || true
fi
