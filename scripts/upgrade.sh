#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! -f "$ROOT/deployment.env" ]]; then exec bash "$ROOT/scripts/upgrade-compose.sh"; fi
. "$ROOT/scripts/lib-docker.sh"
kivo_host_check
exec 9>"$ROOT/.upgrade.lock"
flock -n 9 || kivo_error '另一个升级正在运行。'
kivo_docker_init
kivo_container_config
kivo_managed "$CONTAINER" || kivo_error '拒绝操作非 Kivo 管理的容器。'
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# Download and import before interrupting the old container.
kivo_fetch_bundle "$WORK"
kivo_docker load -i "$BUNDLE/image.tar"
echo '→ 升级前在线备份数据库与配置'
bash "$ROOT/scripts/backup.sh"
PREVIOUS="$CONTAINER-previous-$(date +%s)-$$"
OLD_VERSION="$(kivo_get "$ROOT/deployment.env" KIVO_VERSION)"
NEW_CID=''
rollback() {
  trap - ERR
  echo '升级失败，正在恢复旧容器；聊天数据和备份已保留。' >&2
  if kivo_docker inspect "$PREVIOUS" >/dev/null 2>&1; then
    # docker run may create a container before failing to start it (e.g. a busy port).
    if kivo_managed "$CONTAINER"; then kivo_docker rm -f "$CONTAINER" >/dev/null || true; fi
    kivo_docker rename "$PREVIOUS" "$CONTAINER"
    kivo_docker start "$CONTAINER" >/dev/null
    kivo_wait "$CONTAINER" || echo '旧容器未通过健康检查，请查看日志及备份。' >&2
  else
    kivo_docker start "$CONTAINER" >/dev/null || true
  fi
  exit 1
}
echo '→ 替换客服容器'
trap rollback ERR
kivo_docker stop "$CONTAINER" >/dev/null
kivo_docker rename "$CONTAINER" "$PREVIOUS"
if NEW_CID="$(kivo_run "$IMAGE")"; then :; else rollback; fi
kivo_wait "$NEW_CID"
kivo_save_release
trap - ERR
kivo_docker rm "$PREVIOUS" >/dev/null
printf '升级完成：%s → %s\n' "$OLD_VERSION" "$RELEASE_VERSION"
