#!/usr/bin/env bash
# Test adapter: execute the generated unit's real command inside an isolated privileged container.
set -euo pipefail
case "${1:-}" in
  daemon-reload) exit 0;;
  enable)
    unit=/etc/systemd/system/kivo-docker.service
    runtime_path="$(awk 'index($0,"Environment=PATH=")==1 {print substr($0,18)}' "$unit")"
    command_line="$(awk 'index($0,"ExecStart=")==1 {print substr($0,11)}' "$unit")"
    read -r -a args <<< "$command_line"
    PATH="$runtime_path" nohup "${args[@]}" > /tmp/kivo-runtime.log 2>&1 &
    exit 0;;
  *) exit 1;;
esac
