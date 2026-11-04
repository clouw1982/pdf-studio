#!/usr/bin/env bash
# PDF Studio installer for a Debian/Ubuntu VM (Google Cloud Compute Engine or any Linux box).
# Usage:  bash install.sh            # install / update and start
#         bash install.sh --tailscale # also install Tailscale for private access
set -euo pipefail
cd "$(dirname "$0")"
say(){ printf "\n\033[1;31m▸\033[0m %s\n" "$*"; }

if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker…"
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER" || true
fi
DOCKER="docker"; docker info >/dev/null 2>&1 || DOCKER="sudo docker"

if [[ "${1:-}" == "--tailscale" ]] && ! command -v tailscale >/dev/null 2>&1; then
  say "Installing Tailscale…"
  curl -fsSL https://tailscale.com/install.sh | sh
  sudo tailscale up || true
fi

if [[ ! -f .env ]]; then
  say "Creating .env with a random password…"
  PW=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)
  SK=$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48)
  cat > .env <<ENV
# Password for the web editor
APP_PASSWORD=$PW
# Signs login cookies — keep secret
SECRET_KEY=$SK
# Resolution of PSDs made from the inbox (150 = good for screen, 300 = print)
PSD_DPI=150
# Port and address the editor listens on (set BIND_ADDR to your Tailscale IP to keep it private)
PORT=8080
BIND_ADDR=0.0.0.0
# For HTTPS: your domain, then run: docker compose --profile https up -d
DOMAIN=
ENV
fi

say "Preparing data folders…"
mkdir -p data/inbox data/output data/library data/tmp
sudo chown -R 1000:1000 data 2>/dev/null || chown -R 1000:1000 data 2>/dev/null || true
chmod 0777 data/inbox data/output   # so you can scp/sftp files in and out as your own user

say "Building and starting PDF Studio (first build takes a few minutes)…"
$DOCKER compose up -d --build

for i in $(seq 1 60); do curl -fs http://localhost:${PORT:-8080}/healthz >/dev/null 2>&1 && break; sleep 2; done

IP=$(curl -fs -H "Metadata-Flavor: Google" http://metadata/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip 2>/dev/null || hostname -I | awk '{print $1}')
TS=$(command -v tailscale >/dev/null && tailscale ip -4 2>/dev/null | head -1 || true)
PW=$(grep ^APP_PASSWORD .env | cut -d= -f2)
cat <<MSG

  ✅ PDF Studio is running.

  Open:      http://$IP:8080 ${TS:+  (or privately: http://$TS:8080)}
  Password:  $PW   (change it in $(pwd)/.env, then: docker compose up -d)

  Drop-folder:  $(pwd)/data/inbox      → layered PSDs appear in $(pwd)/data/output/<name>/
  From your Mac:  gcloud compute scp report.pdf <vm-name>:$(pwd)/data/inbox/

  Google Cloud firewall (only if you want it on the public internet):
    gcloud compute firewall-rules create pdfstudio --allow tcp:8080 --target-tags pdfstudio
    gcloud compute instances add-tags <vm-name> --tags pdfstudio --zone <zone>

MSG
