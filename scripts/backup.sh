#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
DEST="$ROOT/backups/$STAMP"
mkdir -p "$DEST"
chmod 700 "$ROOT/backups" "$DEST"
# SQLite's online backup API includes committed WAL data without stopping chats.
docker compose exec -T app node scripts/db-backup.js "/app/data/backup-$STAMP.sqlite"
mv "data/backup-$STAMP.sqlite" "$DEST/kivo.sqlite"
cp .env "$DEST/.env"
git rev-parse HEAD > "$DEST/revision"
chmod 600 "$DEST/kivo.sqlite" "$DEST/.env" "$DEST/revision"
echo "备份已保存：$DEST"
