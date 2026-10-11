#!/usr/bin/env bash
kivo_error() { echo "Kivo: $*" >&2; exit 1; }
kivo_get() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  awk -v key="$key" 'index($0,key "=")==1 {print substr($0,length(key)+2);exit}' "$file"
}
kivo_arch() {
  case "$(uname -m)" in x86_64) echo amd64;; aarch64|arm64) echo arm64;; *) kivo_error '只支持 amd64 / arm64。';; esac
}
kivo_host_check() {
  [[ $EUID -eq 0 ]] || kivo_error '请在 root 终端运行，或使用 sudo bash。'
  [[ "$(uname -s)" == Linux ]] || kivo_error '安装脚本需要 Linux。'
  [[ -r /etc/os-release ]] || kivo_error '无法识别系统版本。'
  local os_id os_version kernel_major kernel_minor
  os_id="$(kivo_get /etc/os-release ID)"; os_id="${os_id//\"/}"
  os_version="$(kivo_get /etc/os-release VERSION_ID)"; os_version="${os_version//\"/}"
  [[ "$os_id" == debian && "$os_version" =~ ^(10|11|12|13)$ ]] || kivo_error '支持 Debian 10 / 11 / 12 / 13。'
  IFS=. read -r kernel_major kernel_minor _ <<< "$(uname -r)"
  (( kernel_major > 4 || (kernel_major == 4 && kernel_minor >= 18) )) || kivo_error '需要 Linux 内核 4.18+（Debian 10 默认内核为 4.19）。'
  for command in curl tar gzip awk sha256sum od flock tr hostname; do command -v "$command" >/dev/null || kivo_error "缺少 $command；此安装器不会通过 apt 修改系统软件包。"; done
}
kivo_docker_init() {
  DOCKER_BIN="$(kivo_get "$ROOT/runtime.env" DOCKER_BIN)"
  DOCKER_SOCKET="$(kivo_get "$ROOT/runtime.env" DOCKER_SOCKET)"
  DOCKER_NETWORK="$(kivo_get "$ROOT/runtime.env" DOCKER_NETWORK)"; DOCKER_NETWORK="${DOCKER_NETWORK:-bridge}"
  [[ -n "$DOCKER_BIN" && -x "$DOCKER_BIN" ]] || kivo_error 'Docker 运行时配置不存在，请重新运行安装脚本。'
  # Configuration is parsed as data, never sourced as shell code.
  [[ "$DOCKER_BIN" == /* ]] || kivo_error 'Docker 路径必须为绝对路径。'
  [[ -z "$DOCKER_SOCKET" || "$DOCKER_SOCKET" == unix:///* ]] || kivo_error '仅支持本机 Unix socket。'
  kivo_probe_docker || kivo_docker_diagnose
}
kivo_docker() {
  # Explicit local endpoint: inherited TLS/context/API overrides must not redirect this command.
  if [[ -n "${DOCKER_SOCKET:-}" ]]; then
    env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH -u DOCKER_API_VERSION "$DOCKER_BIN" --host "$DOCKER_SOCKET" "$@"
  else "$DOCKER_BIN" "$@"; fi
}
kivo_probe_docker() {
  local result version
  if result="$(kivo_docker version --format '{{.Server.Version}}' 2>&1)"; then
    # Debian 10 ships mawk 1.3.3, which lacks POSIX character classes.
    version="$(printf '%s\n' "$result" | awk '/^[0-9]+\.[0-9]+\.[0-9]+[-+_.0-9a-zA-Z]*$/ {print;exit}')"
    if [[ -n "$version" ]]; then DOCKER_SERVER_VERSION="$version"; return 0; fi
  fi
  KIVO_DOCKER_ERROR="$result"
  return 1
}
kivo_docker_diagnose() {
  printf 'Kivo Docker 检查失败\n主机：%s\n客户端：%s\n连接：%s\n' "$(hostname)" "$DOCKER_BIN" "$DOCKER_SOCKET" >&2
  printf 'Docker 原始错误：\n%s\n' "${KIVO_DOCKER_ERROR:-未收到服务端版本。}" >&2
  echo '请在这台主机执行：systemctl status docker --no-pager -l；journalctl -u docker -n 30 --no-pager。已有 Docker 不会被重装或重启。' >&2
  exit 1
}
kivo_use_existing_docker() {
  local selected context_endpoint load_state state i
  command -v docker >/dev/null || return 1
  DOCKER_BIN="$(command -v docker)"
  DOCKER_NETWORK=bridge
  selected="${KIVO_DOCKER_SOCKET:-${DOCKER_HOST:-}}"
  if [[ -z "$selected" ]]; then
    context_endpoint="$(env -u DOCKER_HOST "$DOCKER_BIN" context inspect --format '{{(index .Endpoints "docker").Host}}' 2>/dev/null || true)"
    selected="${context_endpoint:-unix:///run/docker.sock}"
  fi
  [[ "$selected" == unix:///* && "$selected" != *[[:space:]]* ]] || kivo_error 'Docker 接入仅支持本机 Unix socket。可用 KIVO_DOCKER_SOCKET=unix:///run/docker.sock 指定本机服务，不能挂载数据到远程 Docker。'
  DOCKER_SOCKET="$selected"
  if ! kivo_probe_docker; then
    # /var/run is normally a symlink; also support hosts where it is a separate directory.
    if [[ "$selected" == unix:///var/run/docker.sock ]]; then DOCKER_SOCKET=unix:///run/docker.sock; kivo_probe_docker || DOCKER_SOCKET="$selected"; fi
    if ! kivo_probe_docker; then
      if [[ "$DOCKER_SOCKET" == unix:///run/docker.sock || "$DOCKER_SOCKET" == unix:///var/run/docker.sock ]] && command -v systemctl >/dev/null; then
        load_state="$(systemctl show docker.service --property=LoadState --value 2>/dev/null || true)"
        state="$(systemctl is-active docker.service 2>/dev/null || true)"
        if [[ "$load_state" == loaded && ( "$state" == inactive || "$state" == failed ) ]]; then
          echo '→ 已有 Docker 未启动，尝试启动 docker.service（不重装、不重启）' >&2
          if systemctl start --no-block docker.service; then
            for ((i=0;i<30;i++)); do if kivo_probe_docker; then break; fi; sleep 2; done
          fi
        fi
      fi
      kivo_probe_docker || kivo_docker_diagnose
    fi
  fi
  [[ "$(printf '%s\n%s\n' 20.10.10 "$DOCKER_SERVER_VERSION" | sort -V | head -n1)" == 20.10.10 ]] || kivo_error '已有 Docker 版本过旧，需要 20.10.10+；请维护原 Docker 后重试。'
  printf '→ 连接已有 Docker：主机 %s，服务端 %s，socket %s\n' "$(hostname)" "$DOCKER_SERVER_VERSION" "$DOCKER_SOCKET" >&2
}
kivo_save_runtime() {
  printf 'DOCKER_BIN=%s\nDOCKER_SOCKET=%s\nDOCKER_NETWORK=%s\n' "$DOCKER_BIN" "$DOCKER_SOCKET" "$DOCKER_NETWORK" > "$ROOT/runtime.env.new"
  chmod 600 "$ROOT/runtime.env.new"
  mv "$ROOT/runtime.env.new" "$ROOT/runtime.env"
}
kivo_container_config() {
  CONTAINER="$(kivo_get "$ROOT/deployment.env" KIVO_CONTAINER)"; CONTAINER="${CONTAINER:-kivo}"
  [[ "$CONTAINER" =~ ^kivo[a-zA-Z0-9_.-]*$ ]] || kivo_error '容器名称无效。'
  HTTP_PORT="$(kivo_get "$ROOT/.env" HTTP_PORT)"; BIND_HOST="$(kivo_get "$ROOT/.env" BIND_HOST)"; BIND_HOST="${BIND_HOST:-0.0.0.0}"
  [[ "$HTTP_PORT" =~ ^[0-9]{4,5}$ ]] && ((HTTP_PORT >= 1024 && HTTP_PORT <= 65535)) || kivo_error 'HTTP_PORT 须在 1024–65535 之间。'
  [[ "$BIND_HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || kivo_error 'BIND_HOST 须为 IPv4 地址，例如 0.0.0.0 或 127.0.0.1。'
}
kivo_managed() {
  [[ "$(kivo_docker inspect --format '{{index .Config.Labels "io.kivo.managed"}}' "$1" 2>/dev/null)" == true ]]
}
kivo_wait() {
  local container="$1" health state i
  for ((i=0;i<90;i++)); do
    health="$(kivo_docker inspect --format '{{.State.Health.Status}}' "$container" 2>/dev/null || true)"
    [[ "$health" == healthy ]] && return 0
    state="$(kivo_docker inspect --format '{{.State.Status}}' "$container" 2>/dev/null || true)"
    [[ "$state" == exited || "$state" == dead || "$health" == unhealthy ]] && break
    sleep 2
  done
  kivo_docker logs --tail 30 "$container" >&2 || true
  return 1
}
kivo_run() {
  local image="$1"
  kivo_docker run -d --name "$CONTAINER" --label io.kivo.managed=true \
    --restart unless-stopped --init --read-only --security-opt no-new-privileges:true \
    --tmpfs /tmp:rw,noexec,nosuid,size=64m --log-opt max-size=10m --log-opt max-file=3 \
    --env-file "$ROOT/.env" --env DATA_DIR=/app/data --env NODE_ENV=production --env PORT=3000 \
    --network "$DOCKER_NETWORK" --publish "$BIND_HOST:$HTTP_PORT:3000" --mount "type=bind,src=$ROOT/data,dst=/app/data" "$image"
}
kivo_fetch_bundle() {
  local work="$1" version arch base asset digest
  base="${KIVO_RELEASE_BASE:-https://github.com/panhui/Kivo/releases}"
  version="${KIVO_VERSION:-}"
  [[ -n "$version" ]] || version="$(curl -fsSL --retry 3 --connect-timeout 15 "$base/latest/download/version.txt")"
  [[ "$version" =~ ^v[0-9][a-zA-Z0-9._-]*$ ]] || kivo_error '无法获取有效的发行版本。'
  arch="$(kivo_arch)"; asset="kivo-linux-$arch.tar.gz"
  echo "→ 下载 $version / $arch 预构建镜像" >&2
  curl -fL --retry 3 --connect-timeout 15 "$base/download/$version/$asset" -o "$work/$asset"
  curl -fsSL --retry 3 --connect-timeout 15 "$base/download/$version/SHA256SUMS" -o "$work/SHA256SUMS"
  digest="$(awk -v name="$asset" '$2==name {print $1;exit}' "$work/SHA256SUMS")"
  [[ "$digest" =~ ^[a-f0-9]{64}$ ]] || kivo_error '发行包校验文件无效。'
  printf '%s  %s\n' "$digest" "$work/$asset" | sha256sum -c - >&2
  tar -tzf "$work/$asset" | awk '/^\// || /(^|\/)\.\.(\/|$)/ {bad=1} END{exit bad}' || kivo_error '发行包包含非法路径。'
  mkdir "$work/bundle"
  tar -xzf "$work/$asset" -C "$work/bundle" --no-same-owner
  BUNDLE="$work/bundle"
  IMAGE="$(kivo_get "$BUNDLE/manifest.env" KIVO_IMAGE)"
  REVISION="$(kivo_get "$BUNDLE/manifest.env" KIVO_REVISION)"
  [[ "$IMAGE" =~ ^kivo/app:[a-zA-Z0-9._-]+$ && "$REVISION" =~ ^[a-f0-9]{40}$ ]] || kivo_error '发行包镜像信息无效。'
  [[ "$(kivo_get "$BUNDLE/manifest.env" KIVO_ARCH)" == "$arch" && "$(kivo_get "$BUNDLE/manifest.env" KIVO_VERSION)" == "$version" ]] || kivo_error '发行包的架构或版本不匹配。'
  RELEASE_VERSION="$version"
}
kivo_save_release() {
  local file name
  install -m 700 -d "$ROOT/scripts"
  # Atomic replacement preserves the file descriptor of a currently running upgrade script.
  for file in "$BUNDLE"/scripts/*.sh; do
    name="${file##*/}"
    cp "$file" "$ROOT/scripts/$name.new"
    chmod 700 "$ROOT/scripts/$name.new"
    mv "$ROOT/scripts/$name.new" "$ROOT/scripts/$name"
  done
  printf 'KIVO_VERSION=%s\nKIVO_IMAGE=%s\nKIVO_REVISION=%s\nKIVO_ARCH=%s\nKIVO_CONTAINER=%s\n' "$RELEASE_VERSION" "$IMAGE" "$REVISION" "$(kivo_arch)" "$CONTAINER" > "$ROOT/deployment.env.new"
  mv "$ROOT/deployment.env.new" "$ROOT/deployment.env"
  chmod 600 "$ROOT/deployment.env"
}
