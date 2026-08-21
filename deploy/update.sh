#!/usr/bin/env bash
#
# Redeploy the Fleet Management system on the Droplet after pushing
# changes to GitHub.
#
# Usage (on the Droplet):
#   cd /opt/fleet/app && sudo ./deploy/update.sh
#
# It pulls the latest code, reinstalls any new Python packages, rebuilds
# the frontend, and restarts the API.

set -euo pipefail   # stop on first error, and on undefined variables

APP_DIR="/opt/fleet/app"
VENV="/opt/fleet/venv"
WEB_DIR="/opt/fleet/frontend"

echo "==> Pulling latest code"
cd "$APP_DIR"
git pull origin main

echo "==> Installing Python dependencies"
"$VENV/bin/pip" install --quiet --upgrade -r requirements.txt

echo "==> Building frontend"
cd "$APP_DIR/frontend"
npm ci --silent
npm run build

echo "==> Publishing frontend"
# --delete removes files from old builds. Vite fingerprints filenames,
# so without this the directory accumulates every past build.
rsync -a --delete "$APP_DIR/frontend/dist/" "$WEB_DIR/"

echo "==> Restarting API"
systemctl restart fleet-api

echo "==> Waiting for the API to come up"
sleep 3
if systemctl is-active --quiet fleet-api; then
    echo "    API is running."
else
    echo "    ERROR: the API failed to start. Recent logs:"
    journalctl -u fleet-api -n 30 --no-pager
    exit 1
fi

echo "==> Reloading nginx"
nginx -t && systemctl reload nginx

echo ""
echo "Done. Deployment updated successfully."
