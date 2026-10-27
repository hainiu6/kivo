#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
REPO_URL="${KIVO_REPO_URL:-https://github.com/hainiu6/kivo.git}"
INSTALL_DIR="${KIVO_INSTALL_DIR:-/opt/kivo}"
if [[ $EUID -ne 0 ]]; then echo '请使用 sudo bash 运行安装脚本。' >&2; exit 1; fi
if [[ ! -r /etc/os-release ]]; then echo '需要 Debian 12 或 13。' >&2; exit 1; fi
. /etc/os-release
if [[ "$ID" != debian || ! "$VERSION_ID" =~ ^(12|13)$ ]]; then echo '支持 Debian 12 / 13。' >&2; exit 1; fi
if [[ -e "$INSTALL_DIR" && -n "$(ls -A "$INSTALL_DIR")" ]]; then
  echo "安装目录已存在，请运行：sudo bash $INSTALL_DIR/scripts/upgrade.sh" >&2; exit 1
fi
apt_install() {
  if apt-get install -y "$@"; then return 0; fi
  echo '系统软件包安装失败，Kivo 安装尚未完成。请先修复上面的 apt / dpkg 错误，再重新运行安装脚本。' >&2
  if [[ ! -e /etc/mysql/mariadb.cnf ]] && dpkg-query -W -f='${Status}' mariadb-common 2>/dev/null | grep -Eq '^(install|hold) ok (installed|unpacked|half-configured)$'; then
    cat >&2 <<'EOF'
检测到已有 MariaDB 软件包缺少 /etc/mysql/mariadb.cnf。Kivo 使用 SQLite，不依赖 MariaDB。
可在 root 终端恢复 mariadb-common 软件包中的缺失配置，再完成待配置软件包：
  apt-get --no-remove -o Dpkg::Options::="--force-confmiss" install --reinstall mariadb-common
  dpkg --configure -a
  apt-get --no-remove -f install
这些命令不卸载 MariaDB；安装脚本不会自动修改已有数据库配置。
EOF
  else
    echo '可先运行 dpkg --audit 查看尚未完成配置的软件包。' >&2
  fi
  exit 1
}
echo '→ 安装系统依赖'
apt-get update
apt_install ca-certificates curl git openssl
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
  apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
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
PUBLIC_ADDRESS="${KIVO_PUBLIC_URL:-http://${SERVER_IP:-127.0.0.1}:8088}"
SITE=':80'
HTTP_PORT=8088
HTTPS_PORT=8443
if [[ -n "${KIVO_DOMAIN:-}" ]]; then
  if [[ ! "$KIVO_DOMAIN" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]; then echo 'KIVO_DOMAIN 必须为有效域名，不包含协议或路径。' >&2; exit 1; fi
  PUBLIC_ADDRESS="https://$KIVO_DOMAIN"; SITE="$KIVO_DOMAIN"; HTTP_PORT=80; HTTPS_PORT=443
fi
if [[ ! "$PUBLIC_ADDRESS" =~ ^https?://[^[:space:]/]+/?$ ]]; then echo 'KIVO_PUBLIC_URL 必须为有效的 http(s)://主机:端口，不能含路径。' >&2; exit 1; fi
printf 'PUBLIC_URL=%s\nADMIN_USERNAME=admin\nADMIN_PASSWORD=%s\nHTTP_PORT=%s\nHTTPS_PORT=%s\nCADDY_SITE=%s\n' "${PUBLIC_ADDRESS%/}" "$PASSWORD" "$HTTP_PORT" "$HTTPS_PORT" "$SITE" > .env
chmod 600 .env
echo '→ 构建并启动（首次需要下载镜像和依赖）'
docker compose config --quiet
docker compose up -d --build --wait --wait-timeout 180
curl --fail --silent --show-error --retry 8 --retry-delay 2 --retry-connrefused "http://127.0.0.1:$HTTP_PORT/healthz" >/dev/null
printf '\nKivo 已安装\n工作台：%s\n账号：admin\n初始密码：%s\n配置文件：%s/.env\n升级：sudo bash %s/scripts/upgrade.sh\n' "$PUBLIC_ADDRESS" "$PASSWORD" "$INSTALL_DIR" "$INSTALL_DIR"
echo '如果服务器在 NAT 后，请将 .env 中 PUBLIC_URL 改为实际访问地址。建议使用域名启用 HTTPS。'
