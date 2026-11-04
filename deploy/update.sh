#!/usr/bin/env bash
# Pull new commits from GitHub and rebuild only when something changed.
set -euo pipefail
cd /opt/pdfstudio
git fetch -q origin main
if [[ $(git rev-parse HEAD) != $(git rev-parse origin/main) ]]; then
  git reset -q --hard origin/main
  docker compose up -d --build
  docker image prune -f >/dev/null
  echo "Updated to $(git rev-parse --short HEAD)"
fi
