#!/usr/bin/env bash
set -Eeuo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${1:?image}"
WORK="$(mktemp -d)"
trap 'docker logs --tail 30 kivo-runtime-ci >&2 || true; docker rm -f kivo-runtime-ci >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT
docker save "$IMAGE" -o "$WORK/image.tar"
docker run --name kivo-runtime-ci --rm --privileged --cgroupns private \
  -v "$REPO:/repo:ro" -v "$WORK:/fixture:ro" -e TEST_IMAGE="$IMAGE" \
  kivo/debian10-test bash -Eeuo pipefail -c '
    rm /usr/local/bin/docker
    mkdir -p /etc/systemd/system
    cp /repo/test/runtime-systemctl.sh /usr/local/bin/systemctl
    chmod +x /usr/local/bin/systemctl
    ROOT=/opt/kivo bash /repo/scripts/install-runtime.sh || { cat /tmp/kivo-runtime.log; exit 1; }
    ROOT=/opt/kivo
    . /repo/scripts/lib-docker.sh
    kivo_docker_init
    kivo_docker load -i /fixture/image.tar
    mkdir -p "$ROOT/data"; chown 1000:1000 "$ROOT/data"
    printf "PUBLIC_URL=http://localhost:8088\nADMIN_PASSWORD=runtime-ci-test-password\nTRUST_PROXY=0\nHTTP_PORT=8088\n" > "$ROOT/.env"
    CONTAINER=kivo-runtime-app; HTTP_PORT=8088; BIND_HOST=0.0.0.0
    cid="$(kivo_run "$TEST_IMAGE")"
    kivo_wait "$cid" || { cat /tmp/kivo-runtime.log; exit 1; }
    curl --fail http://127.0.0.1:8088/healthz
    [[ ! -e /usr/bin/docker && ! -e /etc/docker/daemon.json && ! -e /var/run/docker.sock ]]
    kivo_docker network inspect kivo --format "{{json .Options}}"
    echo "Static Docker bootstrap, isolated socket/storage/network and application health passed."
  '
