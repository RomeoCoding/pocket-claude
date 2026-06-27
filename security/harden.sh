#!/usr/bin/env bash
# pocket-claude security hardening
# Run once after initial setup. Hardens SSH, configures firewall + fail2ban.
# Supports: Debian/Ubuntu (ufw) and RHEL/Fedora/CentOS (firewalld)
# Must be run as root or with sudo.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash security/harden.sh" >&2
  exit 1
fi

if command -v apt-get &>/dev/null; then
  PKG_MGR="apt"
elif command -v dnf &>/dev/null; then
  PKG_MGR="dnf"
elif command -v yum &>/dev/null; then
  PKG_MGR="yum"
else
  PKG_MGR="unknown"
fi

echo "==> Installing firewall and fail2ban..."
if [[ "$PKG_MGR" == "apt" ]]; then
  apt-get update -qq
  apt-get install -y -qq ufw fail2ban
else
  "$PKG_MGR" install -y -q epel-release 2>/dev/null || true
  "$PKG_MGR" install -y -q fail2ban firewalld
fi

echo "==> Configuring firewall..."
if command -v ufw &>/dev/null; then
  ufw --force reset
  ufw default deny incoming
  ufw default allow outgoing
  ufw allow ssh comment 'SSH access'
  ufw --force enable
  echo "    UFW: active (SSH only inbound)"
elif command -v firewall-cmd &>/dev/null; then
  systemctl enable --now firewalld
  firewall-cmd --permanent --set-default-zone=drop
  firewall-cmd --permanent --add-service=ssh
  firewall-cmd --permanent --remove-service=dhcpv6-client 2>/dev/null || true
  firewall-cmd --reload
  echo "    firewalld: active (SSH only, default zone=drop)"
else
  echo "    WARN: no firewall tool found — skipping firewall config"
fi

echo "==> Configuring fail2ban..."
cat > /etc/fail2ban/jail.local << 'EOF'
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5
backend  = auto

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
SSHD_BAK="${SSHD_CONFIG}.bak.$(date +%s)"
cp "$SSHD_CONFIG" "$SSHD_BAK"

# If sshd -t fails below, restore the original config so SSH stays accessible
trap 'echo "ERROR: sshd config validation failed — restoring $SSHD_BAK"; cp "$SSHD_BAK" "$SSHD_CONFIG"; systemctl reload sshd 2>/dev/null || systemctl reload sshd.service 2>/dev/null || true; echo "Original sshd config restored. SSH access preserved."' ERR

sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' "$SSHD_CONFIG"
sed -i 's/^#\?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' "$SSHD_CONFIG"
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' "$SSHD_CONFIG"
sed -i 's/^#\?X11Forwarding.*/X11Forwarding no/' "$SSHD_CONFIG"

# AllowUsers: append our users to existing line, or create it if absent.
# Critical: if a line exists but doesn't include our users, we'd lock them out.
ALLOW_USER="${SUDO_USER:-}"
if [[ -z "$ALLOW_USER" ]]; then
  ALLOW_USER=$(logname 2>/dev/null || echo "")
fi

add_allow_user() {
  local user="$1"
  [[ -z "$user" || "$user" == "root" ]] && return
  if grep -q "^AllowUsers" "$SSHD_CONFIG"; then
    # Line exists — append user only if not already present
    if ! grep -qP "^AllowUsers\b.*\b${user}\b" "$SSHD_CONFIG"; then
      sed -i "s/^AllowUsers.*/& ${user}/" "$SSHD_CONFIG"
    fi
  else
    echo "AllowUsers ${user}" >> "$SSHD_CONFIG"
  fi
}

add_allow_user "$ALLOW_USER"
add_allow_user "claude"

# Additional hardening directives
grep -q "^MaxAuthTries"     "$SSHD_CONFIG" || echo "MaxAuthTries 3"          >> "$SSHD_CONFIG"
grep -q "^LoginGraceTime"   "$SSHD_CONFIG" || echo "LoginGraceTime 30"       >> "$SSHD_CONFIG"
grep -q "^MaxStartups"      "$SSHD_CONFIG" || echo "MaxStartups 10:30:60"    >> "$SSHD_CONFIG"
grep -q "^ClientAliveInterval" "$SSHD_CONFIG" || echo "ClientAliveInterval 300" >> "$SSHD_CONFIG"
grep -q "^ClientAliveCountMax" "$SSHD_CONFIG" || echo "ClientAliveCountMax 2"   >> "$SSHD_CONFIG"

sshd -t  # Validate before reloading — exits non-zero if config is broken (trap fires)
systemctl reload sshd 2>/dev/null || systemctl reload sshd.service 2>/dev/null || true
trap - ERR  # Config is valid and loaded — clear the restore trap

echo "==> Setting system-wide umask to 027..."
grep -q "^umask 027" /etc/profile || echo "umask 027" >> /etc/profile

echo "==> Disabling core dumps..."
# Set both soft and hard limits — soft limit is what processes actually see by default
grep -q "^\* soft core" /etc/security/limits.conf || echo "* soft core 0" >> /etc/security/limits.conf
grep -q "^\* hard core" /etc/security/limits.conf || echo "* hard core 0" >> /etc/security/limits.conf
grep -q "^fs.suid_dumpable" /etc/sysctl.conf || echo "fs.suid_dumpable = 0" >> /etc/sysctl.conf
sysctl -p > /dev/null 2>&1 || true  # some params are read-only in VMs; non-fatal

echo ""
echo "Hardening complete."
if command -v ufw &>/dev/null; then
  echo "  Firewall: UFW — SSH only inbound"
else
  echo "  Firewall: firewalld — SSH only inbound (zone=drop)"
fi
echo "  fail2ban: SSH (3 retries → 24h ban)"
echo "  SSH:      key-only, root disabled, LoginGraceTime=30, MaxStartups=10:30:60"
echo ""
echo "IMPORTANT: Verify you can still SSH in from a new terminal BEFORE"
echo "closing this session."
