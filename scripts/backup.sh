#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! -f "$ROOT/deployment.env" ]]; then exec bash "$ROOT/scripts/backup-compose.sh"; fi
. "$ROOT/scripts/lib-docker.sh"
[[ $EUID -eq 0 ]] || kivo_error '请使用 root / sudo 备份。'
kivo_docker_init
kivo_container_config
kivo_managed "$CONTAINER" || kivo_error '拒绝操作非 Kivo 管理的容器。'
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$$"
DEST="$ROOT/backups/$STAMP"
mkdir -p "$DEST"; chmod 700 "$ROOT/backups" "$DEST"
kivo_docker exec "$CONTAINER" node scripts/db-backup.js "/app/data/backup-$STAMP.sqlite"
mv "$ROOT/data/backup-$STAMP.sqlite" "$DEST/kivo.sqlite"
cp "$ROOT/.env" "$ROOT/deployment.env" "$ROOT/runtime.env" "$DEST/"
chmod 600 "$DEST"/*
echo "备份已保存：$DEST"
