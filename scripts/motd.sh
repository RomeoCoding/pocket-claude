#!/usr/bin/env bash
# pocket-claude MOTD — installed to /etc/update-motd.d/01-pocket-claude

CYAN='\033[0;36m'
GREEN='\033[0;32m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
NC='\033[0m'

# Service status
if systemctl is-active --quiet pocket-claude 2>/dev/null; then
  dot="${GREEN}●${NC}"
  label="${GREEN}running${NC}"
  STARTED=$(systemctl show pocket-claude -p ActiveEnterTimestamp --value 2>/dev/null | sed 's/ UTC//')
  STATUS_LINE="$dot ${label}  ${DIM}since ${STARTED}${NC}"
else
  dot="${RED}●${NC}"
  label="${RED}stopped${NC}"
  STATUS_LINE="$dot ${label}"
fi

# Bot ID hint
BOT_TOKEN_FILE="/home/claude/.claude/channels/telegram/.env"
if [[ -f "$BOT_TOKEN_FILE" ]]; then
  BOT_ID=$(grep TELEGRAM_BOT_TOKEN "$BOT_TOKEN_FILE" 2>/dev/null | cut -d= -f2 | cut -d: -f1)
  BOT_HINT="${DIM}bot id ${BOT_ID:-???}${NC}"
else
  BOT_HINT="${DIM}bot not configured${NC}"
fi

printf "\n"
printf "${CYAN}"
printf '  ░█████████                        ░██                     ░██         ░██████  ░██                              ░██\n'
printf '  ░██     ░██                       ░██                     ░██        ░██   ░██ ░██                              ░██\n'
printf '  ░██     ░██  ░███████   ░███████  ░██    ░██ ░███████  ░████████    ░██        ░██  ░██████   ░██    ░██  ░████████  ░███████\n'
printf '  ░█████████  ░██    ░██ ░██    ░██ ░██   ░██ ░██    ░██    ░██       ░██        ░██       ░██  ░██    ░██ ░██    ░██ ░██    ░██\n'
printf '  ░██         ░██    ░██ ░██        ░███████  ░█████████    ░██       ░██        ░██  ░███████  ░██    ░██ ░██    ░██ ░█████████\n'
printf '  ░██         ░██    ░██ ░██    ░██ ░██   ░██ ░██           ░██        ░██   ░██ ░██ ░██   ░██  ░██   ░███ ░██   ░███ ░██\n'
printf '  ░██          ░███████   ░███████  ░██    ░██ ░███████      ░████      ░██████  ░██  ░█████░██  ░█████░██  ░█████░██  ░███████\n'
printf "${NC}"
printf "\n"
printf "  ${DIM}Claude Code · Always On · Private · Oracle Free${NC}\n"
printf "\n"
printf "  Status  %b\n" "$STATUS_LINE"
printf "  Bot     %b\n" "$BOT_HINT"
printf "\n"
printf "  ${DIM}sudo systemctl status pocket-claude    — service health${NC}\n"
printf "  ${DIM}sudo journalctl -u pocket-claude -f    — live logs${NC}\n"
printf "  ${DIM}sudo systemctl restart pocket-claude   — restart${NC}\n"
printf "\n"
