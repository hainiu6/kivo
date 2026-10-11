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
  [[ -n "$DOCKER_BIN" && -x "$DOCKER_BIN" ]] || kivo_error 'Docker 运行时配置不存在，请重新运行安装脚本。'
  # Configuration is parsed as data, never sourced as shell code.
  [[ "$DOCKER_BIN" == /* ]] || kivo_error 'Docker 路径必须为绝对路径。'
  [[ -z "$DOCKER_SOCKET" || "$DOCKER_SOCKET" == unix:///* ]] || kivo_error '仅支持本机 Unix socket。'
  kivo_docker info >/dev/null 2>&1 || kivo_error 'Docker 不可用；已有 Docker 不会被自动重装或重启。'
}
kivo_docker() {
  if [[ -n "${DOCKER_SOCKET:-}" ]]; then "$DOCKER_BIN" --host "$DOCKER_SOCKET" "$@"; else "$DOCKER_BIN" "$@"; fi
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
    --publish "$BIND_HOST:$HTTP_PORT:3000" --mount "type=bind,src=$ROOT/data,dst=/app/data" "$image"
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
