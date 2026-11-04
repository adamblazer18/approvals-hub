#!/usr/bin/env bash
# First-time install on a Linux server with nginx. Run as root from the repo folder:
#   DOMAIN=approvals.example.com bash deploy/install.sh
set -euo pipefail
APP=/opt/approvals
DOMAIN=${DOMAIN:?Set DOMAIN, e.g. DOMAIN=approvals.example.com bash deploy/install.sh}

node -v | grep -qE '^v(2[2-9]|[3-9][0-9])' || { echo "Needs Node 22+ (node -v says $(node -v))"; exit 1; }
command -v pm2 >/dev/null || npm i -g pm2

mkdir -p $APP
rsync -a --exclude node_modules --exclude data --exclude .env ./ $APP/
cd $APP
npm ci --omit=dev

if [ ! -f .env ]; then
  cp .env.example .env
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" .env
  sed -i "s|^WEBHOOK_SECRET=.*|WEBHOOK_SECRET=$(openssl rand -hex 24)|" .env
  sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=https://$DOMAIN|" .env
  echo ">> Set ADMIN_PASSWORD in $APP/.env, then re-run this script."; exit 0
fi
grep -q '^ADMIN_PASSWORD=change-me' .env && { echo ">> Set ADMIN_PASSWORD in $APP/.env first."; exit 1; }

pm2 startOrReload ecosystem.config.cjs && pm2 save

if [ ! -f /etc/nginx/sites-enabled/approvals ]; then
  sed "s/approvals.example.com/$DOMAIN/" deploy/nginx-approvals.conf > /etc/nginx/sites-available/approvals
  ln -s /etc/nginx/sites-available/approvals /etc/nginx/sites-enabled/approvals
  nginx -t && systemctl reload nginx
  echo ">> Point a DNS A record for $DOMAIN at this server, then run: certbot --nginx -d $DOMAIN"
fi
echo ">> Running on port 3060. Create your first agent key in the web UI (gear icon) or:"
echo "   cd $APP && node src/cli.js create-key \"Website growth agent\" \"Website\""
