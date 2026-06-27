#!/usr/bin/env bash
# pocket-claude security hardening
# Run once after initial setup. Hardens SSH, installs UFW + fail2ban,
# locks down to minimal attack surface.
# Must be run as root or with sudo.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash security/harden.sh" >&2
  exit 1
fi

echo "==> Installing UFW and fail2ban..."
apt-get update -qq
apt-get install -y -qq ufw fail2ban

echo "==> Configuring UFW..."
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh comment 'SSH access'
# No inbound HTTP/HTTPS — Telegram uses outbound long polling only
ufw --force enable

echo "==> Configuring fail2ban..."
cat > /etc/fail2ban/jail.local << 'EOF'
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5
backend  = systemd

[sshd]
enabled  = true
port     = ssh
logpath  = %(sshd_log)s
maxretry = 3
bantime  = 86400
EOF
systemctl enable fail2ban
systemctl restart fail2ban

echo "==> Hardening SSH..."
SSHD_CONFIG="/etc/ssh/sshd_config"
cp "$SSHD_CONFIG" "${SSHD_CONFIG}.bak.$(date +%s)"

# Disable password auth — key only
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' "$SSHD_CONFIG"
sed -i 's/^#\?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' "$SSHD_CONFIG"
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' "$SSHD_CONFIG"
sed -i 's/^#\?X11Forwarding.*/X11Forwarding no/' "$SSHD_CONFIG"

# Allow current invoking user + claude — preserves existing SSH access
ALLOW_USER="${SUDO_USER:-}"
if [[ -z "$ALLOW_USER" ]]; then
  ALLOW_USER=$(logname 2>/dev/null || echo "")
fi
if [[ -n "$ALLOW_USER" && "$ALLOW_USER" != "root" ]]; then
  grep -q "^AllowUsers" "$SSHD_CONFIG" || echo "AllowUsers $ALLOW_USER claude" >> "$SSHD_CONFIG"
else
  grep -q "^AllowUsers" "$SSHD_CONFIG" || echo "AllowUsers claude" >> "$SSHD_CONFIG"
fi
grep -q "^MaxAuthTries" "$SSHD_CONFIG" || echo "MaxAuthTries 3" >> "$SSHD_CONFIG"
grep -q "^ClientAliveInterval" "$SSHD_CONFIG" || echo "ClientAliveInterval 300" >> "$SSHD_CONFIG"
grep -q "^ClientAliveCountMax" "$SSHD_CONFIG" || echo "ClientAliveCountMax 2" >> "$SSHD_CONFIG"

sshd -t  # Validate config before reloading
systemctl reload sshd

echo "==> Setting system-wide umask to 027..."
grep -q "^umask 027" /etc/profile || echo "umask 027" >> /etc/profile

echo "==> Disabling core dumps..."
echo "* hard core 0" >> /etc/security/limits.conf
echo "fs.suid_dumpable = 0" >> /etc/sysctl.conf
sysctl -p > /dev/null

echo ""
echo "Hardening complete."
echo "  UFW:      active, SSH only inbound"
echo "  fail2ban: SSH (3 retries → 24h ban)"
echo "  SSH:      key-only, root login disabled, password auth off"
echo ""
echo "IMPORTANT: Verify you can still SSH in from a new terminal BEFORE"
echo "closing this session. Test: ssh claude@<your-ip>"
