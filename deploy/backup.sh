#!/usr/bin/env bash
# Nightly backup (cron: 15 3 * * * /opt/approvals/deploy/backup.sh). Keeps 14 days.
set -euo pipefail
D=/opt/approvals/data; B=/opt/approvals/backups; mkdir -p $B
T=$(date +%F)
sqlite3 $D/approvals.db ".backup '$B/approvals-$T.db'" 2>/dev/null || cp $D/approvals.db $B/approvals-$T.db
tar -czf $B/uploads-$T.tgz -C $D uploads
find $B -mtime +14 -delete
