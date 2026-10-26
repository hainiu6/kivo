#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT="${KIVO_INSTALL_DIR:-/opt/kivo}"
[[ "$ROOT" =~ ^/[a-zA-Z0-9_./-]+$ && "$ROOT" != / ]] || { echo '安装目录须为不含空格的绝对路径，且不能为 /。' >&2; exit 1; }
[[ $EUID -eq 0 ]] || { echo '请在 root 终端运行，或使用 sudo bash。' >&2; exit 1; }
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SCRIPT_BASE="${KIVO_SCRIPT_BASE:-https://raw.githubusercontent.com/hainiu3/Kivo/main/scripts}"
curl -fsSL --retry 3 "$SCRIPT_BASE/lib-docker.sh" -o "$WORK/lib-docker.sh"
. "$WORK/lib-docker.sh"
kivo_host_check
if [[ -f "$ROOT/.env" && ! -f "$ROOT/deployment.env" && -d "$ROOT/.git" ]]; then
  kivo_error '检测到旧版 Compose 安装。请使用原部署目录的升级脚本；Docker 镜像版可通过 KIVO_INSTALL_DIR 选择一个新目录。'
fi
mkdir -p "$ROOT"
exec 9>"$ROOT/.install.lock"
flock -n 9 || kivo_error '另一个安装正在运行。'
if [[ -f "$ROOT/deployment.env" ]]; then echo "已有 Docker 镜像版安装，请运行：bash $ROOT/scripts/upgrade.sh" >&2; exit 1; fi
# Check an existing daemon before downloading the 113 MB image bundle.
if [[ -f "$ROOT/runtime.env" ]]; then
  kivo_docker_init
elif kivo_use_existing_docker; then
  kivo_save_runtime
fi
kivo_fetch_bundle "$WORK"
if [[ ! -f "$ROOT/runtime.env" ]]; then ROOT="$ROOT" bash "$BUNDLE/scripts/install-runtime.sh"; fi
kivo_docker_init
CONTAINER="${KIVO_CONTAINER:-kivo}"
[[ "$CONTAINER" =~ ^kivo[a-zA-Z0-9_.-]*$ ]] || kivo_error '容器名称必须以 kivo 开头，仅可包含字母、数字、点、下划线和连字符。'
if kivo_docker inspect "$CONTAINER" >/dev/null 2>&1; then kivo_error "容器 $CONTAINER 已存在，不会覆盖；请指定其他 KIVO_CONTAINER，或先检查原容器。"; fi
port_busy() {
  local hex
  # Docker may publish via NAT without a listening userspace process.
  if kivo_docker ps --format '{{.Ports}}' | awk -v port="$1" 'index($0,":" port "->") {found=1} END{exit !found}'; then return 0; fi
  hex="$(printf '%04X' "$1")"
  awk -v port="$hex" 'NR>1 {split($2,a,":");if(toupper(a[2])==port && $4=="0A") found=1} END{exit !found}' /proc/net/tcp /proc/net/tcp6
}
if [[ ! -f "$ROOT/.env" ]]; then
  HTTP_PORT="${KIVO_PORT:-8088}"
  [[ "$HTTP_PORT" =~ ^[0-9]{4,5}$ ]] && ((HTTP_PORT >= 1024 && HTTP_PORT <= 65535)) || kivo_error 'KIVO_PORT 须在 1024–65535 之间。'
  if [[ -n "${KIVO_PORT:-}" ]]; then
    port_busy "$HTTP_PORT" && kivo_error "端口 $HTTP_PORT 已被占用；请指定其他 KIVO_PORT。"
  else
    while port_busy "$HTTP_PORT"; do ((HTTP_PORT+=1)); ((HTTP_PORT <= 8107)) || kivo_error '8088–8107 都被占用，请指定 KIVO_PORT。'; done
  fi
  PASSWORD="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
  SERVER_IP="$(hostname -I | awk '{print $1}')"
  [[ "$SERVER_IP" == *:* ]] && SERVER_IP="[$SERVER_IP]"
  PUBLIC_URL="${KIVO_PUBLIC_URL:-http://${SERVER_IP:-127.0.0.1}:$HTTP_PORT}"
  [[ "$PUBLIC_URL" =~ ^https?://[^[:space:]/?#@]+/?$ ]] || kivo_error 'KIVO_PUBLIC_URL 须为 http(s)://域名或IP:端口，不含路径、账号或查询参数。'
  printf 'PUBLIC_URL=%s\nADMIN_USERNAME=admin\nADMIN_PASSWORD=%s\nHTTP_PORT=%s\nBIND_HOST=%s\nTRUST_PROXY=0\n' "${PUBLIC_URL%/}" "$PASSWORD" "$HTTP_PORT" "${KIVO_BIND_HOST:-0.0.0.0}" > "$ROOT/.env"
  chmod 600 "$ROOT/.env"
fi
mkdir -p "$ROOT/data" "$ROOT/backups"
chown 1000:1000 "$ROOT/data"
chmod 700 "$ROOT/data" "$ROOT/backups"
kivo_container_config
# Preserve the custom name during first installation (no deployment.env yet).
CONTAINER="${KIVO_CONTAINER:-kivo}"
echo '→ 导入镜像（服务器无需 npm、Git、Compose）'
kivo_docker load -i "$BUNDLE/image.tar"
echo "→ 启动客服容器，使用端口 $HTTP_PORT"
if CID="$(kivo_run "$IMAGE")"; then :; else
  if kivo_managed "$CONTAINER"; then kivo_docker rm -f "$CONTAINER" >/dev/null || true; fi
  kivo_error '容器创建失败，配置和数据已保留，请解决上述错误后重新运行安装脚本。'
fi
if ! kivo_wait "$CID"; then
  echo "启动失败。配置与数据已保留，请查看上面的容器日志。解决错误后可重新运行安装脚本。" >&2
  kivo_docker rm -f "$CID" >/dev/null
  exit 1
fi
kivo_save_release
printf '\nKivo Docker 镜像版已安装\n工作台：%s\n账号：%s\n初始密码：%s\n升级：bash %s/scripts/upgrade.sh\n备份：bash %s/scripts/backup.sh\n' "$(kivo_get "$ROOT/.env" PUBLIC_URL)" "$(kivo_get "$ROOT/.env" ADMIN_USERNAME)" "$(kivo_get "$ROOT/.env" ADMIN_PASSWORD)" "$ROOT" "$ROOT"
echo '安装器未调用 apt，也未更改服务器已有 MariaDB / Node.js / Nginx 配置。请在防火墙中放行上面显示的端口。'
