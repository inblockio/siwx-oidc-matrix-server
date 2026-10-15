#!/bin/sh
# The Redis password of this stack: create, check or rotate the files that carry it.
#
#   scripts/redis-secret.sh init     create both files if neither exists (safe to run again)
#   scripts/redis-secret.sh check    owner, modes, group, and that both files carry the same password
#   scripts/redis-secret.sh rotate   a new password in both files; the old files stay as *.bak-<UTC stamp>
#
# Run it from the stack directory (the one with docker-compose.yml), as the user that owns the
# stack. It never prints the password. After `rotate`, recreate Redis and siwx-oidc together:
# docs/redis-password.md, "Rotate".
#
# Files, in STACK_SECRETS_DIR (default ./secrets, mode 0700):
#   redis.conf       `requirepass <password>`, mode 0600. Redis reads it on stdin (docker-compose.yml).
#   siwx-oidc.toml   `redis_url = "redis://:<password>@redis"`, mode 0640. siwx-oidc runs as uid
#                    10001 and reads it through the group in STACK_SECRETS_GID (group_add in
#                    docker-compose.yml, default 1000), which must be this file's group.
#
# The password is passed between shell functions only: printf is a shell builtin here, so it
# never becomes a process argument that `ps` could show.
set -eu
umask 077

DIR="${STACK_SECRETS_DIR:-secrets}"
CONF="$DIR/redis.conf"
TOML="$DIR/siwx-oidc.toml"
HOST="${STACK_REDIS_HOST:-redis}"

die() { echo "redis-secret: $*" >&2; exit 1; }

# The gid docker-compose.yml gives siwx-oidc: the environment, else .env, else 1000.
want_gid() {
  g="${STACK_SECRETS_GID:-}"
  [ -n "$g" ] || [ ! -f .env ] || g=$(sed -n 's/^STACK_SECRETS_GID=\([0-9][0-9]*\)$/\1/p' .env | tail -n 1)
  echo "${g:-1000}"
}

new_password() {
  # 48 random bytes in base64 without / + =: about 64 characters of [A-Za-z0-9], so it needs
  # no quoting in a Redis config line and no escaping in a URL.
  p=$(openssl rand -base64 48 | tr -d '/+=\n')
  [ "${#p}" -ge 48 ] || die "openssl gave a short password"
  printf '%s' "$p"
}

write_files() { # $1 = the password. Each file is written beside its target, then renamed.
  [ -d "$DIR" ] || mkdir -p "$DIR"
  chmod 0700 "$DIR"
  {
    echo "# Redis password of this stack (docs/redis-password.md). Written by scripts/redis-secret.sh."
    printf 'requirepass %s\n' "$1"
  } > "$CONF.tmp"
  chmod 0600 "$CONF.tmp"
  {
    echo "# siwx-oidc: the Redis URL with the stack's Redis password (docs/redis-password.md)."
    echo "# Written by scripts/redis-secret.sh."
    echo "[default]"
    printf 'redis_url = "redis://:%s@%s"\n' "$1" "$HOST"
  } > "$TOML.tmp"
  chgrp "$(want_gid)" "$TOML.tmp" 2>/dev/null \
    || echo "redis-secret: WARN cannot give $TOML group $(want_gid); set STACK_SECRETS_GID in .env to a group you are in (see check)" >&2
  chmod 0640 "$TOML.tmp"
  mv -f "$CONF.tmp" "$CONF"
  mv -f "$TOML.tmp" "$TOML"
}

pw_conf() { sed -n 's/^requirepass //p' "$CONF"; }
pw_toml() { sed -n 's/^redis_url = "redis:\/\/:\([^@]*\)@.*"$/\1/p' "$TOML"; }

cmd_init() {
  if [ -f "$CONF" ] && [ -f "$TOML" ]; then
    echo "redis-secret: $CONF and $TOML exist, nothing to do"
    return 0
  fi
  if [ -f "$CONF" ] || [ -f "$TOML" ]; then
    die "only one of $CONF and $TOML exists: restore the other from the backup, or run rotate"
  fi
  write_files "$(new_password)"
  echo "redis-secret: created $CONF (0600) and $TOML (0640, group $(want_gid))"
}

cmd_check() {
  bad=0
  [ -d "$DIR" ] || die "$DIR is missing: run scripts/redis-secret.sh init"
  for f in "$CONF" "$TOML"; do [ -f "$f" ] || die "$f is missing"; done
  me=$(id -un)
  for e in "$DIR 700" "$CONF 600" "$TOML 640"; do
    f=${e% *}; m=${e##* }
    [ "$(stat -c %a "$f")" = "$m" ] || { echo "BAD  $f has mode $(stat -c %a "$f"), want $m"; bad=1; }
    [ "$(stat -c %U "$f")" = "$me" ] || { echo "BAD  $f is owned by $(stat -c %U "$f"), want $me"; bad=1; }
  done
  [ "$(stat -c %g "$TOML")" = "$(want_gid)" ] \
    || { echo "BAD  $TOML has group $(stat -c %g "$TOML"), siwx-oidc gets group $(want_gid) (STACK_SECRETS_GID)"; bad=1; }
  n=$(pw_conf | tr -d '\n' | wc -c)
  [ "$n" -ge 32 ] || { echo "BAD  the password in $CONF has $n characters, want 32 or more"; bad=1; }
  a=$(pw_conf | sha256sum | cut -d' ' -f1)
  b=$(pw_toml | sha256sum | cut -d' ' -f1)
  [ "$a" = "$b" ] || { echo "BAD  $CONF and $TOML carry different passwords"; bad=1; }
  # A SHA-256 prefix of the password: compare copies on two machines without showing it.
  echo "fingerprint ${a%"${a#????????????}"} ($n characters)"
  [ "$bad" = 0 ] && echo "OK   $DIR" || exit 1
}

cmd_rotate() {
  [ -f "$CONF" ] || [ -f "$TOML" ] || die "nothing to rotate: run init"
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  for f in "$CONF" "$TOML"; do [ ! -f "$f" ] || cp -p "$f" "$f.bak-$ts"; done
  write_files "$(new_password)"
  echo "redis-secret: new password in $CONF and $TOML; the old files are *.bak-$ts"
  echo "next: docker compose up -d --no-deps --force-recreate redis siwx-oidc"
  echo "      then delete the *.bak-$ts files once sign-in works (docs/redis-password.md)"
}

case "${1:-}" in
  init) cmd_init ;;
  check) cmd_check ;;
  rotate) cmd_rotate ;;
  *) echo "usage: $0 init|check|rotate" >&2; exit 2 ;;
esac
