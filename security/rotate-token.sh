#!/usr/bin/env bash
# Rotate the Telegram bot token.
# Run this if your token is ever exposed or you suspect compromise.
# Steps: 1) get new token from BotFather, 2) run this script with it.
set -euo pipefail

ENV_FILE="$HOME/.claude/channels/telegram/.env"

if [[ -z "${1:-}" ]]; then
  echo "Usage: bash rotate-token.sh <new-token-from-botfather>"
  echo ""
  echo "Get a new token: open Telegram → @BotFather → /revoke → /token"
  exit 1
fi

NEW_TOKEN="$1"

# Basic token format check: numeric-id:alphanum
if [[ ! "$NEW_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{35,}$ ]]; then
  echo "ERROR: Token format looks wrong. Expected: 123456789:AAH..." >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found. Is pocket-claude installed?" >&2
  exit 1
fi

# Backup old token (for rollback)
cp "$ENV_FILE" "${ENV_FILE}.bak.$(date +%s)"
chmod 600 "${ENV_FILE}.bak."*

# Write new token — printf avoids BOM, newline, and shell escaping issues
printf 'TELEGRAM_BOT_TOKEN=%s\n' "$NEW_TOKEN" > "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "Token updated. Restarting pocket-claude..."
systemctl --user restart pocket-claude 2>/dev/null || \
  sudo systemctl restart pocket-claude 2>/dev/null || \
  { echo "Could not restart automatically. Run: sudo systemctl restart pocket-claude"; exit 1; }

echo "Done. Test by DM-ing your bot."
