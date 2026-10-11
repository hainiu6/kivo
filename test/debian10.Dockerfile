# Test fixture only: apt installs test tools here, never on deployment servers.
FROM debian:buster-slim
RUN printf 'deb http://archive.debian.org/debian buster main\n' > /etc/apt/sources.list \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install -y --no-install-recommends curl ca-certificates util-linux hostname \
 && rm -rf /var/lib/apt/lists/*
COPY docker /usr/local/bin/docker
# Simulate the user's broken apt/dpkg and make any attempted use fail the test.
RUN printf '#!/bin/sh\necho UNEXPECTED_APT_CALL >&2\nexit 99\n' > /usr/local/bin/apt-get \
 && cp /usr/local/bin/apt-get /usr/local/bin/apt \
 && cp /usr/local/bin/apt-get /usr/local/bin/dpkg \
 && chmod +x /usr/local/bin/apt-get /usr/local/bin/apt /usr/local/bin/dpkg
