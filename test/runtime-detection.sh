#!/usr/bin/env bash
set -Eeuo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/root"
cat > "$WORK/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -eu
if [[ "${1:-}" == context ]]; then printf '%s\n' "${MOCK_ENDPOINT:-unix:///var/run/docker.sock}"; exit 0; fi
[[ -z "${DOCKER_HOST:-}${DOCKER_CONTEXT:-}${DOCKER_TLS_VERIFY:-}${DOCKER_CERT_PATH:-}${DOCKER_API_VERSION:-}" ]] || { echo 'Inherited Docker override was not removed' >&2; exit 91; }
[[ "$1" == --host ]]; socket="$2"; shift 2
if [[ "$1" == info ]]; then echo 'Simulated non-connection info failure' >&2; exit 1; fi
if [[ "$1" == version ]]; then
  if [[ "${MOCK_FAIL:-0}" == 1 || ( "${MOCK_STOPPED:-0}" == 1 && ! -f "$MOCK_WORK/started" ) ]]; then echo 'Cannot connect to the Docker daemon: simulated original error' >&2; exit 1; fi
  if [[ "${MOCK_RUN_ONLY:-0}" == 1 && "$socket" != unix:///run/docker.sock ]]; then echo 'Missing socket in separate /var/run' >&2; exit 1; fi
  [[ "${MOCK_WARNING:-0}" != 1 ]] || echo 'WARNING: simulated CLI warning' >&2
  printf '%s\n' "${MOCK_VERSION:-29.8.1}"
fi
MOCK
cat > "$WORK/bin/systemctl" <<'MOCK'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$MOCK_WORK/systemctl.log"
case "$1" in
  show) echo loaded;;
  is-active) if [[ "${MOCK_STOPPED:-0}" == 1 && ! -f "$MOCK_WORK/started" ]]; then echo inactive; exit 3; else echo active; fi;;
  start) touch "$MOCK_WORK/started";;
  *) echo 'Unexpected systemctl mutation' >&2; exit 92;;
esac
MOCK
chmod +x "$WORK/bin"/*
export PATH="$WORK/bin:$PATH" MOCK_WORK="$WORK"
. "$REPO/scripts/lib-docker.sh"
ROOT="$WORK/root"
# A working /version endpoint suffices even if /info fails; TLS/API overrides are removed.
export DOCKER_HOST=unix:///run/docker.sock DOCKER_CONTEXT=broken-context DOCKER_TLS_VERIFY=1 DOCKER_CERT_PATH=/missing DOCKER_API_VERSION=1.12
kivo_use_existing_docker
[[ "$DOCKER_SOCKET" == unix:///run/docker.sock && "$DOCKER_SERVER_VERSION" == 29.8.1 ]]
kivo_save_runtime
kivo_docker_init
[[ ! -f "$WORK/systemctl.log" ]]
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH DOCKER_API_VERSION
# Fallback /run path, local custom context and successful command with warnings.
export MOCK_RUN_ONLY=1 MOCK_WARNING=1
kivo_use_existing_docker
[[ "$DOCKER_SOCKET" == unix:///run/docker.sock && "$DOCKER_SERVER_VERSION" == 29.8.1 ]]
unset MOCK_RUN_ONLY MOCK_WARNING
export MOCK_ENDPOINT=unix:///run/custom-docker.sock
kivo_use_existing_docker
[[ "$DOCKER_SOCKET" == unix:///run/custom-docker.sock ]]
# Remote endpoints are refused, avoiding host bind mounts on another server.
export MOCK_ENDPOINT=tcp://example.invalid:2375
if (kivo_use_existing_docker) > "$WORK/remote.log" 2>&1; then echo 'Remote endpoint accepted' >&2; exit 1; fi
grep -q '仅支持本机' "$WORK/remote.log"
# Starting an inactive service is allowed, but active services are never restarted.
export MOCK_ENDPOINT=unix:///run/docker.sock MOCK_STOPPED=1
kivo_use_existing_docker
[[ -f "$WORK/started" ]]
grep -qx 'start --no-block docker.service' "$WORK/systemctl.log"
unset MOCK_STOPPED
# An active but unreachable daemon prints the original error, without start/restart.
rm "$WORK/systemctl.log"
export MOCK_FAIL=1
if (kivo_use_existing_docker) > "$WORK/failure.log" 2>&1; then echo 'Unreachable daemon accepted' >&2; exit 1; fi
grep -q 'simulated original error' "$WORK/failure.log"
grep -q '主机：' "$WORK/failure.log"
if grep -E '^(start|restart|enable) ' "$WORK/systemctl.log"; then echo 'Active Docker mutated' >&2; exit 1; fi
unset MOCK_FAIL
export MOCK_VERSION=19.03.15
if (kivo_use_existing_docker) > "$WORK/old-version.log" 2>&1; then echo 'Unsupported server accepted' >&2; exit 1; fi
echo 'Docker preflight, local sockets, environment isolation, inactive start and active service protection passed.'
