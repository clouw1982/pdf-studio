#!/usr/bin/env bash
# Runs on the VM as root. Installs Docker, clones PDF Studio to /opt/pdfstudio,
# starts it next to anything already running, and enables auto-update from GitHub.
set -euo pipefail
REPO=https://github.com/clouw1982/pdf-studio.git
DIR=/opt/pdfstudio
say(){ printf "\n▸ %s\n" "$*"; }

command -v git >/dev/null || { apt-get update -qq && apt-get install -y -qq git curl; }
if ! command -v docker >/dev/null; then say "Installing Docker…"; curl -fsSL https://get.docker.com | sh; fi
docker compose version >/dev/null 2>&1 || apt-get install -y -qq docker-compose-plugin

# Memory: LibreOffice/OCR builds like headroom; add swap on small VMs without any
MEM=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
if [[ $MEM -lt 4000 && -z "$(swapon --show)" ]]; then
  say "Adding 4 GB swap (VM has ${MEM} MB RAM)…"
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

if [[ -d $DIR/.git ]]; then git -C $DIR pull -q; else git clone -q $REPO $DIR; fi
cd $DIR

# Pick a free port (keep the existing one on re-runs)
if [[ -f .env ]]; then PORT=$(grep ^PORT= .env | cut -d= -f2)
else
  PORT=8080
  while [[ -n "$(ss -ltnH "sport = :$PORT")" ]]; do PORT=$((PORT+10)); done
fi
export PORT
bash install.sh

# Auto-update every 5 minutes
cat > /etc/systemd/system/pdfstudio-update.service <<UNIT
[Unit]
Description=Update PDF Studio from GitHub
[Service]
Type=oneshot
ExecStart=/bin/bash $DIR/deploy/update.sh
UNIT
cat > /etc/systemd/system/pdfstudio-update.timer <<UNIT
[Unit]
Description=Check GitHub for PDF Studio updates
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload && systemctl enable --now pdfstudio-update.timer >/dev/null 2>&1

echo "PDFSTUDIO_PORT=$PORT"
echo "PDFSTUDIO_PASSWORD=$(grep ^APP_PASSWORD= .env | cut -d= -f2)"
