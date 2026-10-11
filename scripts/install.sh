#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
REPO_URL="${KIVO_REPO_URL:-https://github.com/panhui/Kivo.git}"
INSTALL_DIR="${KIVO_INSTALL_DIR:-/opt/kivo}"
if [[ $EUID -ne 0 ]]; then echo '请使用 sudo bash 运行安装脚本。' >&2; exit 1; fi
if [[ ! -r /etc/os-release ]]; then echo '需要 Debian 12 或 13。' >&2; exit 1; fi
. /etc/os-release
if [[ "$ID" != debian || ! "$VERSION_ID" =~ ^(12|13)$ ]]; then echo '支持 Debian 12 / 13。' >&2; exit 1; fi
if [[ -e "$INSTALL_DIR" && -n "$(ls -A "$INSTALL_DIR")" ]]; then
  echo "安装目录已存在，请运行：sudo bash $INSTALL_DIR/scripts/upgrade.sh" >&2; exit 1
fi
echo '→ 安装系统依赖'
apt-get update
apt-get install -y ca-certificates curl git openssl
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  echo '→ 从 Docker 官方 Debian 软件源安装 Docker 和 Compose'
  if dpkg-query -W -f='${Status}' docker.io 2>/dev/null | grep -q 'install ok installed'; then
    echo '检测到 docker.io；请先安装兼容的 Docker Compose v2，避免自动替换已有 Docker。' >&2; exit 1
  fi
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: ${VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
echo '→ 获取 Kivo'
git clone --branch main "$REPO_URL" "$INSTALL_DIR"
cd "$INSTALL_DIR"
mkdir -p data backups
chown 1000:1000 data
chmod 700 data backups
PASSWORD="$(openssl rand -hex 16)"
SERVER_IP="$(hostname -I | awk '{print $1}')"
PUBLIC_ADDRESS="${KIVO_PUBLIC_URL:-http://${SERVER_IP:-127.0.0.1}:8080}"
SITE=':80'
HTTP_PORT=8080
if [[ -n "${KIVO_DOMAIN:-}" ]]; then
  if [[ ! "$KIVO_DOMAIN" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]; then echo 'KIVO_DOMAIN 必须为有效域名，不包含协议或路径。' >&2; exit 1; fi
  PUBLIC_ADDRESS="https://$KIVO_DOMAIN"; SITE="$KIVO_DOMAIN"; HTTP_PORT=80
fi
if [[ ! "$PUBLIC_ADDRESS" =~ ^https?://[^[:space:]/]+/?$ ]]; then echo 'KIVO_PUBLIC_URL 必须为有效的 http(s)://主机:端口，不能含路径。' >&2; exit 1; fi
printf 'PUBLIC_URL=%s\nADMIN_USERNAME=admin\nADMIN_PASSWORD=%s\nHTTP_PORT=%s\nHTTPS_PORT=443\nCADDY_SITE=%s\n' "${PUBLIC_ADDRESS%/}" "$PASSWORD" "$HTTP_PORT" "$SITE" > .env
chmod 600 .env
echo '→ 构建并启动（首次需要下载镜像和依赖）'
docker compose config --quiet
docker compose up -d --build --wait --wait-timeout 180
curl --fail --silent --show-error --retry 8 --retry-delay 2 --retry-connrefused "http://127.0.0.1:$HTTP_PORT/healthz" >/dev/null
printf '\nKivo 已安装\n工作台：%s\n账号：admin\n初始密码：%s\n配置文件：%s/.env\n升级：sudo bash %s/scripts/upgrade.sh\n' "$PUBLIC_ADDRESS" "$PASSWORD" "$INSTALL_DIR" "$INSTALL_DIR"
echo '如果服务器在 NAT 后，请将 .env 中 PUBLIC_URL 改为实际访问地址。建议使用域名启用 HTTPS。'
