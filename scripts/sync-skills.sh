#!/usr/bin/env bash
# sync-skills.sh — copy a local ~/.claude/skills directory to the pocket-claude VM
# Usage: bash scripts/sync-skills.sh <user@host> [skills-dir]
#
# Examples:
#   bash scripts/sync-skills.sh ubuntu@1.2.3.4
#   bash scripts/sync-skills.sh ubuntu@1.2.3.4 ~/my-custom-skills
#   bash scripts/sync-skills.sh ubuntu@1.2.3.4 --remove brand-identity
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; DIM='\033[2m'; NC='\033[0m'
info()  { printf "${CYAN}==>${NC} %s\n" "$*"; }
ok()    { printf "${GREEN} ✓${NC} %s\n" "$*"; }
error() { printf "${RED}ERROR:${NC} %s\n" "$*" >&2; exit 1; }

REMOTE="${1:-}"
[[ -z "$REMOTE" ]] && error "Usage: $0 <user@host> [skills-dir | --remove <skill-name>]"

# Handle --remove
if [[ "${2:-}" == "--remove" ]]; then
  SKILL_NAME="${3:-}"
  [[ -z "$SKILL_NAME" ]] && error "--remove requires a skill name"
  info "Removing skill '$SKILL_NAME' from VM..."
  ssh "$REMOTE" "sudo rm -rf /home/claude/.claude/skills/$SKILL_NAME && echo removed"
  ok "Removed skill '$SKILL_NAME' from VM"
  info "Reload with: sudo systemctl restart pocket-claude"
  exit 0
fi

# Source skills directory
SKILLS_SRC="${2:-$HOME/.claude/skills}"
[[ ! -d "$SKILLS_SRC" ]] && error "Skills directory not found: $SKILLS_SRC"

SKILL_COUNT=$(find "$SKILLS_SRC" -maxdepth 1 -mindepth 1 -type d | wc -l)
[[ "$SKILL_COUNT" -eq 0 ]] && error "No skills found in $SKILLS_SRC"

info "Syncing $SKILL_COUNT skill(s) from $SKILLS_SRC → $REMOTE:/home/claude/.claude/skills/"

# Ensure target directory exists on VM
ssh "$REMOTE" "sudo mkdir -p /home/claude/.claude/skills && sudo chown -R claude:claude /home/claude/.claude/skills"

# Sync (rsync preferred, scp fallback)
if command -v rsync &>/dev/null; then
  rsync -az --delete \
    -e ssh \
    "$SKILLS_SRC/" \
    "$REMOTE:/tmp/skills-staging/"
else
  scp -r "$SKILLS_SRC/." "$REMOTE:/tmp/skills-staging/"
fi

# Move into place as claude user
ssh "$REMOTE" "
  sudo cp -r /tmp/skills-staging/. /home/claude/.claude/skills/
  sudo chown -R claude:claude /home/claude/.claude/skills/
  rm -rf /tmp/skills-staging
"

ok "Synced successfully"
echo ""
info "Skills on VM:"
ssh "$REMOTE" "sudo ls /home/claude/.claude/skills/ 2>/dev/null | sed 's/^/  - /'"
echo ""
info "Restart pocket-claude to pick up new skills:"
printf "  ${DIM}ssh $REMOTE 'sudo systemctl restart pocket-claude'${NC}\n"
