#!/usr/bin/env bash
# Execute the actual install/update scripts in Debian 10 userspace, using the CI host Docker daemon.
set -Eeuo pipefail
IMAGE="${1:?image}"; ARCH="${2:?architecture}"; REVISION="${3:?revision}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d /tmp/kivo-ci.XXXXXX)"
ROOT="$WORK/install"; COLLISION_ROOT="$WORK/collision"
cleanup() {
  docker logs --tail 30 kivo-ci >&2 || true
  docker rm -f kivo-ci kivo-ci-collision kivo-ci-foreign >/dev/null 2>&1 || true
  [[ -z "${SERVER_PID:-}" ]] || kill "$SERVER_PID" || true
  sudo rm -rf "$WORK"
}
trap cleanup EXIT
mkdir -p "$WORK/www/releases/download/v0.0.1" "$WORK/www/scripts" "$WORK/fixture" "$ROOT" "$COLLISION_ROOT"
cp "$REPO"/scripts/*.sh "$WORK/www/scripts/"
bash "$REPO/scripts/package-release.sh" v0.0.1 "$ARCH" "$IMAGE" "$REVISION" "$WORK/www/releases/download/v0.0.1"
(cd "$WORK/www/releases/download/v0.0.1" && sha256sum *.tar.gz > SHA256SUMS)
case "$ARCH" in amd64) platform=x86_64;; arm64) platform=aarch64;; esac
curl -fsSL --retry 3 "https://download.docker.com/linux/static/stable/$platform/docker-29.8.2.tgz" -o "$WORK/docker.tgz"
tar -xzf "$WORK/docker.tgz" -C "$WORK/fixture" --strip-components=1 docker/docker
docker build -t kivo/debian10-test -f "$REPO/test/debian10.Dockerfile" "$WORK/fixture"
docker run --rm -v "$REPO:/repo:ro" kivo/debian10-test bash /repo/test/runtime-detection.sh
python3 -m http.server 18088 --bind 127.0.0.1 --directory "$WORK/www" > "$WORK/http.log" 2>&1 &
SERVER_PID=$!
for ((i=0;i<30;i++)); do if curl -fsS http://127.0.0.1:18088/scripts/install.sh >/dev/null; then break; fi; sleep 1; done
run_debian() {
  docker run --rm --network host \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$WORK:$WORK" \
    -e KIVO_SCRIPT_BASE=http://127.0.0.1:18088/scripts \
    -e KIVO_RELEASE_BASE=http://127.0.0.1:18088/releases \
    -e KIVO_VERSION="${TEST_VERSION:-v0.0.1}" \
    -e KIVO_INSTALL_DIR="${TEST_ROOT:-$ROOT}" \
    -e KIVO_CONTAINER="${TEST_CONTAINER:-kivo-ci}" \
    -e KIVO_DOCKER_SOCKET="${TEST_SOCKET:-}" \
    kivo/debian10-test bash "$@"
}
# An unreachable local endpoint must fail with its actual error before downloading an image.
if TEST_SOCKET=unix:///run/kivo-missing-test.sock TEST_ROOT="$WORK/preflight" run_debian "$WORK/www/scripts/install.sh" > "$WORK/preflight.log" 2>&1; then echo 'Bad endpoint accepted' >&2; exit 1; fi
grep -q 'Docker 原始错误' "$WORK/preflight.log"
if grep -q '预构建镜像' "$WORK/preflight.log"; then echo 'Image downloaded before Docker check' >&2; exit 1; fi
run_debian "$WORK/www/scripts/install.sh"
grep -qx 'HTTP_PORT=8088' "$ROOT/.env"
curl --fail http://127.0.0.1:8088/healthz
docker exec kivo-ci node -e "const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync('/app/data/kivo.sqlite');d.exec('CREATE TABLE deployment_probe (value TEXT); INSERT INTO deployment_probe VALUES (\"retained\")'.replaceAll('\"',\"'\"));"
run_debian "$ROOT/scripts/backup.sh"
[[ "$(find "$ROOT/backups" -name kivo.sqlite | wc -l)" -ge 1 ]]
run_debian "$ROOT/scripts/upgrade.sh"
docker exec kivo-ci node -e "const {DatabaseSync}=require('node:sqlite');if(new DatabaseSync('/app/data/kivo.sqlite').prepare('SELECT value FROM deployment_probe').get().value!=='retained')process.exit(1);"
# A second deployment detects the occupied default port, preserving the first.
TEST_ROOT="$COLLISION_ROOT" TEST_CONTAINER=kivo-ci-collision run_debian "$WORK/www/scripts/install.sh"
grep -qx 'HTTP_PORT=8089' "$COLLISION_ROOT/.env"
curl --fail http://127.0.0.1:8089/healthz
# Foreign containers are never overwritten.
docker create --name kivo-ci-foreign "$IMAGE" >/dev/null
if TEST_ROOT="$WORK/foreign" TEST_CONTAINER=kivo-ci-foreign run_debian "$WORK/www/scripts/install.sh"; then echo 'Foreign container was not rejected' >&2; exit 1; fi
docker inspect kivo-ci-foreign >/dev/null
# A bad release must restore the running old container and retain the database.
printf 'FROM %s\nCMD ["node","-e","process.exit(1)"]\n' "$IMAGE" > "$WORK/fixture/broken.Dockerfile"
docker build -t kivo/app:ci-broken -f "$WORK/fixture/broken.Dockerfile" "$WORK/fixture"
mkdir -p "$WORK/www/releases/download/v0.0.2"
bash "$REPO/scripts/package-release.sh" v0.0.2 "$ARCH" kivo/app:ci-broken "$REVISION" "$WORK/www/releases/download/v0.0.2"
(cd "$WORK/www/releases/download/v0.0.2" && sha256sum *.tar.gz > SHA256SUMS)
if TEST_VERSION=v0.0.2 run_debian "$ROOT/scripts/upgrade.sh"; then echo 'Broken upgrade was not rejected' >&2; exit 1; fi
curl --fail http://127.0.0.1:8088/healthz
grep -qx 'KIVO_VERSION=v0.0.1' "$ROOT/deployment.env"
docker exec kivo-ci node -e "const {DatabaseSync}=require('node:sqlite');if(new DatabaseSync('/app/data/kivo.sqlite').prepare('SELECT value FROM deployment_probe').get().value!=='retained')process.exit(1);"
# Checksum corruption must abort before stopping the working container.
printf '%064d  kivo-linux-%s.tar.gz\n' 0 "$ARCH" > "$WORK/www/releases/download/v0.0.2/SHA256SUMS"
if TEST_VERSION=v0.0.2 run_debian "$ROOT/scripts/upgrade.sh"; then echo 'Bad checksum was not rejected' >&2; exit 1; fi
curl --fail http://127.0.0.1:8088/healthz
echo "Debian 10 / $ARCH install, default 8088, collision, backup, upgrade, rollback, checksum and ownership tests passed."
