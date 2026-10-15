#!/bin/sh
# redis-cli in this stack's Redis container, signed in with the stack's Redis password.
#
#   scripts/redis-cli.sh DBSIZE
#   scripts/redis-cli.sh INFO persistence
#
# The password is read inside the container from the mounted secret, so it reaches no command
# line, no environment of this shell and no terminal. The container is the running `redis`
# service of the compose project whose working directory is this stack directory.
#
# siwx-oidc's Redis key NAMES are raw access and refresh tokens: never list keys (KEYS, SCAN,
# --scan, MONITOR) into a terminal or a log. Count them instead: `... --scan --pattern 'x/*' | wc -l`.
set -eu
# Compose labels the container with the stack directory as it was given, so try the path as
# reached and with symlinks resolved.
c=
for dir in "$(cd "$(dirname "$0")/.." && pwd -L)" "$(cd "$(dirname "$0")/.." && pwd -P)"; do
  c=$(docker ps -q --filter "label=com.docker.compose.project.working_dir=$dir" \
    --filter label=com.docker.compose.service=redis)
  [ -z "$c" ] || break
done
[ -n "$c" ] || { echo "redis-cli.sh: no running redis service for $dir" >&2; exit 1; }
[ "$(echo "$c" | wc -l)" = 1 ] || { echo "redis-cli.sh: more than one redis container for $dir" >&2; exit 1; }
exec docker exec -i "$c" sh -c \
  'REDISCLI_AUTH="$(sed -n "s/^requirepass //p" /run/secrets/redis_conf)" exec redis-cli "$@"' redis-cli "$@"
