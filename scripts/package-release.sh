#!/usr/bin/env bash
# Build a self-contained server bundle from an already built Docker image.
set -euo pipefail
VERSION="${1:?version}"; ARCH="${2:?architecture}"; IMAGE="${3:?image}"; REVISION="${4:?revision}"; OUTPUT="${5:?output directory}"
[[ "$VERSION" =~ ^v[0-9][a-zA-Z0-9._-]*$ && "$ARCH" =~ ^(amd64|arm64)$ && "$REVISION" =~ ^[a-f0-9]{40}$ ]]
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/scripts" "$OUTPUT"
docker save "$IMAGE" -o "$WORK/image.tar"
printf 'KIVO_VERSION=%s\nKIVO_ARCH=%s\nKIVO_IMAGE=%s\nKIVO_REVISION=%s\n' "$VERSION" "$ARCH" "$IMAGE" "$REVISION" > "$WORK/manifest.env"
for file in install.sh install-runtime.sh lib-docker.sh upgrade.sh backup.sh docker.sh; do cp "$REPO/scripts/$file" "$WORK/scripts/"; done
chmod 755 "$WORK"/scripts/*.sh
tar -czf "$OUTPUT/kivo-linux-$ARCH.tar.gz" -C "$WORK" .
