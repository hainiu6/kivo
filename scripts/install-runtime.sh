#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
ROOT="${ROOT:-/opt/kivo}"
. "$(dirname "${BASH_SOURCE[0]}")/lib-docker.sh"
kivo_host_check
mkdir -p "$ROOT/runtime"
DOCKER_SOCKET=''
if command -v docker >/dev/null; then
  DOCKER_BIN="$(command -v docker)"
  # Always select the local daemon; a remote/context endpoint must not receive host bind mounts.
  DOCKER_SOCKET=unix:///var/run/docker.sock
  kivo_docker info >/dev/null 2>&1 || kivo_error '检测到已有 Docker，但本机 /var/run/docker.sock 不可用。请先启动已有 Docker；安装器不会重装或重启它。'
  docker_version="$(kivo_docker version --format '{{.Server.Version}}')"
  minimum=20.10.10
  [[ "$(printf '%s\n%s\n' "$minimum" "$docker_version" | sort -V | head -n1)" == "$minimum" ]] || kivo_error '已有 Docker 版本过旧，需要 20.10.10+；请维护原 Docker 后重试。'
else
  for command in systemctl iptables ps mount; do command -v "$command" >/dev/null || kivo_error "缺少 $command；独立 Docker 运行时需要此系统组件，安装器不会调用 apt。"; done
  [[ -d /sys/fs/cgroup ]] || kivo_error '系统未挂载 cgroups。'
  [[ ! -e /var/run/docker.sock && ! -d /etc/docker ]] || kivo_error '检测到已有 Docker 配置或 socket；请恢复已有 Docker，避免创建冲突的运行时。'
  if ps -eo comm= | awk '$1=="dockerd" {found=1} END{exit !found}'; then kivo_error '已有 dockerd 正在运行，请恢复其 docker 客户端。'; fi
  unit=/etc/systemd/system/kivo-docker.service
  [[ ! -e "$unit" ]] || kivo_error 'kivo-docker.service 已存在；请检查之前的安装后重试。'
  version=29.8.2
  case "$(kivo_arch)" in
    amd64) platform=x86_64; digest=995d1ef289677f74fd58d8d2c35727b6a4ee389c69db8638a3e42d0487aa5b0f;;
    arm64) platform=aarch64; digest=76a624e4a8e5da654d1150e808175125efb5a6f1b6aa1cbd9caee18f51047a50;;
  esac
  echo "→ 安装独立 Docker $version 运行时（不使用 apt）"
  archive="$ROOT/runtime/docker.tgz"
  curl -fL --retry 3 --connect-timeout 15 "https://download.docker.com/linux/static/stable/$platform/docker-$version.tgz" -o "$archive"
  printf '%s  %s\n' "$digest" "$archive" | sha256sum -c -
  tar -xzf "$archive" -C "$ROOT/runtime" --no-same-owner
  rm "$archive"
  # Classic overlay2 avoids changing the storage backend on upgrades.
  printf '{"features":{"containerd-snapshotter":false}}\n' > "$ROOT/runtime/daemon.json"
  DOCKER_BIN="$ROOT/runtime/docker/docker"
  DOCKER_SOCKET=unix:///run/kivo-docker.sock
  printf 'DOCKER_BIN=%s\nDOCKER_SOCKET=%s\n' "$DOCKER_BIN" "$DOCKER_SOCKET" > "$ROOT/runtime.env"
  chmod 600 "$ROOT/runtime.env"
  cat > "$unit" <<UNIT
# Managed by Kivo: $ROOT
[Unit]
Description=Kivo isolated Docker runtime
After=network-online.target
Wants=network-online.target
[Service]
Environment=PATH=$ROOT/runtime/docker:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$ROOT/runtime/docker/dockerd --config-file=$ROOT/runtime/daemon.json --host=$DOCKER_SOCKET --data-root=$ROOT/docker-data --exec-root=/run/kivo-docker --pidfile=/run/kivo-docker.pid --bridge=kivo0 --default-address-pool=base=10.248.0.0/16,size=24
Restart=on-failure
RestartSec=5
TimeoutStartSec=120
Delegate=yes
KillMode=process
LimitNOFILE=1048576
[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now kivo-docker.service
  ready=false
  for ((i=0;i<60;i++)); do
    if kivo_docker info >/dev/null 2>&1; then ready=true; break; fi
    sleep 2
  done
  if [[ "$ready" != true ]]; then
    journalctl -u kivo-docker.service --no-pager -n 40 >&2 || true
    kivo_error '独立 Docker 启动失败。请检查上述日志；没有修改系统 Docker 或 apt 软件包。'
  fi
fi
printf 'DOCKER_BIN=%s\nDOCKER_SOCKET=%s\n' "$DOCKER_BIN" "$DOCKER_SOCKET" > "$ROOT/runtime.env"
chmod 600 "$ROOT/runtime.env"
