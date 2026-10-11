#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
exec 9>"$ROOT/.git/kivo-upgrade.lock"
flock -n 9 || { echo '另一个升级正在运行。' >&2; exit 1; }
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then echo '代码有本地修改，请先保存修改后再升级。数据和 .env 不受影响。' >&2; exit 1; fi
if [[ "$(git branch --show-current)" != main ]]; then echo '部署目录必须在 main 分支。' >&2; exit 1; fi
OLD_REV="$(git rev-parse HEAD)"
echo '→ 升级前备份数据库与配置'
bash scripts/backup.sh
echo '→ 获取最新版本'
git fetch origin main
# Require linear updates. No silent reset of a locally modified deployment.
git merge --ff-only origin/main
rollback() {
  trap - ERR
  echo '升级失败，恢复升级前代码并重新启动。数据库备份位于 backups/。' >&2
  git checkout --detach "$OLD_REV"
  if docker compose up -d --build --force-recreate --wait --wait-timeout 180; then
    git checkout -B main "$OLD_REV"
    echo '旧版本已恢复。' >&2
  else
    echo '自动恢复未成功，请查看 docker compose logs；数据库升级若不兼容，请按 README 从升级前备份恢复。' >&2
  fi
  exit 1
}
trap rollback ERR
docker compose config --quiet
echo '→ 构建并重启服务'
docker compose up -d --build --force-recreate --wait --wait-timeout 180
docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
trap - ERR
printf '升级完成：%s → %s\n' "${OLD_REV:0:7}" "$(git rev-parse --short HEAD)"
