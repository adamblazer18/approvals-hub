#!/usr/bin/env bash
# Push a new version: run from the updated repo folder on the server. Keeps .env and data/.
set -euo pipefail
rsync -a --exclude node_modules --exclude data --exclude .env ./ /opt/approvals/
cd /opt/approvals && npm ci --omit=dev && pm2 reload approvals
