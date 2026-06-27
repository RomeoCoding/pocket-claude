# Oracle Cloud Free Tier Setup

> pocket-claude works on any Ubuntu 20.04+/Debian 11+ VM — not just Oracle. See below for other providers.

Oracle's Always Free ARM VM (4 OCPU, 24 GB RAM, indefinitely free) is the best zero-cost option if you can get one in your region.

---

## 1. Create an Oracle Cloud account

1. Go to [cloud.oracle.com](https://cloud.oracle.com) → **Start for free**
2. Use a real credit card (required for verification, not charged for Always Free resources)
3. Choose your home region carefully — **you cannot change it later**
4. Wait for the confirmation email; account activation can take a few minutes

---

## 2. Create the VM instance

1. In the OCI Console, go to **Compute → Instances → Create instance**
2. **Name**: `pocket-claude` (or anything you like)
3. **Image**: Ubuntu 22.04 (Minimal) — click "Change image"
4. **Shape**: Click "Change shape" → **Ampere** → `VM.Standard.A1.Flex`
   - Set **OCPUs: 2** and **Memory: 12 GB** (leaves headroom; max is 4 OCPU / 24 GB)
5. **Networking**: leave defaults (new VCN is created automatically)
6. **SSH keys**: paste your public key (`cat ~/.ssh/id_ed25519.pub`) or generate one
7. Click **Create**

The instance takes ~2 minutes to start. Note the **Public IP address**.

---

## 3. Open SSH in the security list

By default, Oracle's Security List allows port 22 inbound. Verify:

1. In the Console, go to **Networking → Virtual Cloud Networks → your VCN**
2. Click **Security Lists → Default Security List**
3. Confirm there is an ingress rule for **TCP port 22** from `0.0.0.0/0`

If it's missing, add it. This is the only inbound port you need — pocket-claude uses outbound Telegram long polling exclusively.

---

## 4. SSH into the VM

```bash
ssh ubuntu@<your-public-ip>
```

If you named your key file something else:
```bash
ssh -i ~/.ssh/your-key ubuntu@<your-public-ip>
```

---

## 5. Run pocket-claude installer

```bash
curl -fsSL https://raw.githubusercontent.com/RomeoCoding/pocket-claude/master/install.sh -o install.sh
bash install.sh
```

The installer will:
- Install Node.js, tmux, Claude Code
- Create a dedicated `claude` user
- Prompt for your Telegram bot token
- Run security hardening (UFW + fail2ban)
- Walk you through `claude auth login`
- Start the daemon

---

## 6. Oracle idle-VM protection

Oracle has a policy of reclaiming Always Free VMs that appear idle. pocket-claude's watchdog handles this: it runs every minute via cron and writes a `.keepalive` file to disk, which signals activity to Oracle's monitoring.

No additional configuration needed — this is built in.

---

## Maintenance

| Task | Command |
|------|---------|
| Check status | `sudo systemctl status pocket-claude` |
| View live logs | `sudo journalctl -u pocket-claude -f` |
| Restart | `sudo systemctl restart pocket-claude` |
| Update pocket-claude | `bash /opt/pocket-claude/update.sh` |
| Rotate bot token | `bash /opt/pocket-claude/security/rotate-token.sh <new-token>` |
