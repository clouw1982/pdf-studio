#!/usr/bin/env bash
# One-shot deploy of PDF Studio to a Compute Engine VM. Run in Google Cloud Shell:
#   curl -fsSL https://raw.githubusercontent.com/clouw1982/pdf-studio/main/deploy/cloudshell.sh | bash
# Optional: VM=<name> ZONE=<zone> to pick the VM explicitly.
set -euo pipefail
RAW=https://raw.githubusercontent.com/clouw1982/pdf-studio/main
say(){ printf "\n\033[1;31m▸\033[0m %s\n" "$*"; }

PROJECT=$(gcloud config get-value project 2>/dev/null || true)
if [[ -z "$PROJECT" ]]; then
  PROJECT=$(gcloud projects list --format="value(projectId)" --limit=1)
  gcloud config set project "$PROJECT" >/dev/null
fi
say "Project: $PROJECT"

if [[ -z "${VM:-}" ]]; then
  mapfile -t VMS < <(gcloud compute instances list --filter="status=RUNNING" --format="value(name,zone.basename())")
  if [[ ${#VMS[@]} -eq 0 ]]; then echo "No running VMs found in $PROJECT."; exit 1; fi
  if [[ ${#VMS[@]} -eq 1 ]]; then read -r VM ZONE <<<"${VMS[0]}"
  else
    echo "Running VMs:"; for i in "${!VMS[@]}"; do echo "  $((i+1))) ${VMS[$i]}"; done
    read -rp "Which VM number? " n </dev/tty; read -r VM ZONE <<<"${VMS[$((n-1))]}"
  fi
fi
ZONE=${ZONE:-$(gcloud compute instances list --filter="name=$VM" --format="value(zone.basename())")}
say "Deploying to VM $VM ($ZONE)"

say "Installing on the VM (first build takes ~5 minutes)…"
OUT=$(gcloud compute ssh "$VM" --zone "$ZONE" --quiet --command "curl -fsSL $RAW/deploy/vm-setup.sh | sudo bash" | tee /dev/stderr)
PORT=$(grep -o '^PDFSTUDIO_PORT=[0-9]*' <<<"$OUT" | tail -1 | cut -d= -f2); PORT=${PORT:-8080}
PW=$(grep -o '^PDFSTUDIO_PASSWORD=.*' <<<"$OUT" | tail -1 | cut -d= -f2)

say "Opening port $PORT in the firewall…"
gcloud compute firewall-rules describe "pdfstudio-$PORT" >/dev/null 2>&1 || \
  gcloud compute firewall-rules create "pdfstudio-$PORT" --allow "tcp:$PORT" --target-tags pdfstudio \
    --source-ranges 0.0.0.0/0 --description "PDF Studio web editor" --quiet
gcloud compute instances add-tags "$VM" --zone "$ZONE" --tags pdfstudio --quiet

IP=$(gcloud compute instances describe "$VM" --zone "$ZONE" --format="value(networkInterfaces[0].accessConfigs[0].natIP)")
cat <<MSG

  ✅ PDF Studio is live:  http://$IP:$PORT
     Password:            $PW
     Auto-update:         the VM pulls new commits from GitHub every 5 minutes.

MSG
