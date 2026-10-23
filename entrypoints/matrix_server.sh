#!/bin/bash

# -----------------------------------------------------------------------------
# SECRET STORE MODE: EXPLICIT, OFF BY DEFAULT.
#
# Switched on by one non-secret variable, SYNAPSE_SECRETS_DIR (the directory the
# operator mounts read-only, normally /run/secrets). Unset or empty, nothing in
# this block runs and every other line of this script behaves as it always did.
# docs/synapse-secret-files.md is the reference: file names, variables, the
# inventory, what is refused and why.
#
# In store mode Synapse reads every secret from a file the container only reads:
#   * homeserver.yaml gets `*_path` references and no inline secret (the three
#     keys `/start.py generate` writes inline are deleted again on this very
#     boot, before Synapse ever starts);
#   * a secret-looking variable in the environment (a fixed list, any name with
#     SECRET, TOKEN, PASSWORD, ... in it, any URL with a password) is a start
#     error, named, never its value;
#   * a missing, empty, blank, unreadable or writable secret file is a start error
#     naming the file, never its content, and so is a file the container user owns
#     or a file in a directory it can write; a MAS, macaroon or form secret with a
#     byte outside printable ASCII is refused too; two registrations that share an
#     id or a token are refused by file name before Synapse can print the token,
#     and a registration the config lists that cannot be compared is refused too;
#   * with the mode off, a homeserver.yaml that a store-mode boot wrote is refused
#     (fix forward), not completed with an inline secret beside the file reference;
#   * Synapse starts with --no-secrets-in-config, so an inline secret that still
#     got into homeserver.yaml is a start error of Synapse itself;
#   * the container must run as the Synapse user (compose `user: "991:991"`),
#     never as root: /start.py drops root with gosu, which clears supplementary
#     groups, and a secret file readable through `group_add` would then be
#     unreadable AFTER this script's own check had passed.
# This script never prints a value: no `set -x`, no echo of a secret variable, no
# `cat` of a secret file; homeserver.yaml is edited with yq only.
# -----------------------------------------------------------------------------
SECRET_STORE=0
[ -z "${SYNAPSE_SECRETS_DIR:-}" ] || SECRET_STORE=1

# Environment variables that would carry a secret. Present in the environment of
# a store-mode container (even empty) means the operator has not finished the
# switch: the value is then in `docker inspect` and in /proc/<pid>/environ, which
# is exactly what the store removes. The first five are the secrets this image
# consumes (this script, and /start.py in its migrate_config mode); the last two
# are other services' secrets that reach Synapse when a compose file still gives
# it `env_file: .env`. SYNAPSE_SECRET_ENV_DENY adds more names (non-secret).
SS_REFUSED_ENV_NAMES="MAS_SHARED_SECRET LK_JWT_AS_TOKEN LK_JWT_HS_TOKEN SYNAPSE_REGISTRATION_SHARED_SECRET SYNAPSE_MACAROON_SECRET_KEY SIWEOIDC_SIGNING_KEY_PEM LIVEKIT_SECRET"

# A fixed list cannot name every secret a shared `.env` carries, so a name that
# LOOKS like a secret is refused too: any variable whose name contains one of these
# words (case-insensitive), whatever its value. The store mode's own settings
# contain SECRET and are the allowlist below: each holds a path or a list of names,
# never a value. Every other name this script or /start.py reads is free of these
# words (checked against the script when this list was written).
SS_NAME_WORDS=(SECRET TOKEN PASSWORD PASSWD PEM PRIVATE_KEY API_KEY)
SS_ENV_ALLOWED_NAMES=" SYNAPSE_SECRETS_DIR SYNAPSE_MAS_SECRET_FILE SYNAPSE_MACAROON_SECRET_FILE SYNAPSE_FORM_SECRET_FILE SYNAPSE_SECRET_ENV_DENY "
# A URL whose userinfo part holds a password (user, colon, password, then the at sign), in any variable.
# The userinfo ends at the LAST at sign before the host, so an at sign may sit in the user name
# (user@example.org:password@host) or in the password: the classes below leave it in.
SS_URL_USERINFO_RE='[A-Za-z][A-Za-z0-9+.-]*://[^/?#[:space:]]*:[^/?#[:space:]]+@'

# Inline secret keys that Synapse's --no-secrets-in-config does NOT check (v1.163.0
# synapse/config: only macaroon_secret_key, form_secret, registration_shared_secret,
# matrix_authentication_service.secret, redis.password, recaptcha_*_key,
# turn_shared_secret and worker_replication_secret are covered). None of these is
# written by this image; a homeserver.yaml that carries one is refused, because
# store mode promises that no secret stays inline.
SS_INLINE_KEYS=(
  '.password_config.pepper'
  '.email.smtp_pass'
  '.jwt_config.secret'
  '.turn_password'
  '.database.args.password'
  '.databases.*.args.password'
  '.oidc_config.client_secret'
  '.oidc_providers[].client_secret'
  '.oidc_providers[].client_secret_jwt_key.key'
)

# The registration file the mode-off boots render. Store mode never writes it and
# unlists it; the file itself stays until the operator deletes it.
SS_LEGACY_REGISTRATION=/data/lk-jwt-as.yaml

secret_store_refuse() {
  echo "REFUSING TO START (secret store mode): $*" >&2
  exit 1
}

# One secret file: a regular file, readable by THIS process, that THIS process
# cannot write and does not own, in a directory it cannot write, not empty, not
# blank. $3 is "raw" (the whole file is the value: MAS, macaroon, form) or "yaml" (a
# registration). The checks below read no byte into the shell or the log: they test
# permissions and count bytes through pipes. Only the path is ever printed.
secret_store_check_file() { # $1 the setting that names the file, $2 its path, $3 raw|yaml
  local what="$1" f="$2" kind="${3:-raw}" owner d rd
  [[ "$f" =~ ^/[A-Za-z0-9._/-]+$ ]] \
    || secret_store_refuse "${what} must be an absolute path made of [A-Za-z0-9._/-]."
  [ -e "$f" ] \
    || secret_store_refuse "secret file ${f} (${what}) does not exist, or its directory cannot be searched. Mount it read-only into the container."
  [ -f "$f" ] \
    || secret_store_refuse "${f} (${what}) is not a regular file."
  { : < "$f"; } 2>/dev/null \
    || secret_store_refuse "secret file ${f} (${what}) is not readable by uid $(id -u), gid $(id -g), groups $(id -G | tr ' ' ','). Check its owner and mode, and the container's user and group_add."
  # A read-only bind mount answers "not writable" to every user. A file this process
  # can write is not a store mount (for example a setting pointed into /data), and
  # the container could then change a secret it only should read.
  [ ! -w "$f" ] \
    || secret_store_refuse "secret file ${f} (${what}) is writable by uid $(id -u). A secret file is mounted read-only (compose: read_only: true) and carries no write permission for the container user."
  # The owner of a file can change its mode whatever the mode says now, and so can write it later.
  owner=$(stat -L -c %u -- "$f" 2>/dev/null) && [[ "$owner" =~ ^[0-9]+$ ]] \
    || secret_store_refuse "could not read the owner of secret file ${f} (${what})."
  [ "$owner" != "$(id -u)" ] \
    || secret_store_refuse "secret file ${f} (${what}) is owned by uid ${owner}, the user the container runs as. An owner can change a file's mode and then its content. Let root (or another user) own the file and give the container user read access through a group (compose: group_add)."
  # A directory the container user can write lets it replace the file (delete it, create another).
  # Judged for the path as given and, when that is a link, for the directory of what it resolves to.
  d="${f%/*}"; d="${d:-/}"
  rd=$(readlink -f -- "$f" 2>/dev/null) && rd="${rd%/*}" && rd="${rd:-/}" \
    || secret_store_refuse "could not resolve secret file ${f} (${what})."
  for d in "$d" "$rd"; do
    [ ! -w "$d" ] \
      || secret_store_refuse "secret file ${f} (${what}) sits in the directory ${d}, which is writable by uid $(id -u). The container user could replace the file. Mount the directory read-only (compose: read_only: true) and give the container user no write permission to it."
  done
  [ -s "$f" ] \
    || secret_store_refuse "secret file ${f} (${what}) is empty."
  # `-s` passes a file of blanks and newlines; Synapse strips such a value to "".
  LC_ALL=C grep -q '[^[:space:]]' "$f" 2>/dev/null \
    || secret_store_refuse "secret file ${f} (${what}) holds nothing but whitespace."
  if [ "$kind" = raw ]; then
    # The value is the file: no leading whitespace, and no trailing whitespace beyond
    # one final newline. Synapse strips both ends, a reader that does not (the other
    # consumer of the MAS secret) would see a different value.
    # Each count is 1 when the byte looked at is not whitespace.
    local lead core
    lead=$(head -c1 "$f" | LC_ALL=C tr -d '[:space:]' | wc -c)
    if [ "$(tail -c1 "$f" | LC_ALL=C tr -d '\n' | wc -c)" -eq 0 ]; then
      core=$(tail -c2 "$f" | head -c1 | LC_ALL=C tr -d '[:space:]' | wc -c)   # the byte before the final newline
    else
      core=$(tail -c1 "$f" | LC_ALL=C tr -d '[:space:]' | wc -c)
    fi
    if [ "$lead" -ne 1 ] || [ "$core" -ne 1 ]; then
      secret_store_refuse "secret file ${f} (${what}) has leading or trailing whitespace (one final newline is the only one allowed). Write the value alone, for example with printf '%s\\n'."
    fi
    # Nothing but printable ASCII (0x21 to 0x7e) is left once one final newline is taken off: a space,
    # a control character or a byte of 0x80 and up inside the value is read one way by Synapse (it
    # strips the ends and decodes the rest) and another by a consumer that sends the bytes as a
    # header or compares them. `tr` deletes the allowed bytes and `wc` counts what is left.
    local extra fin=0
    extra=$(LC_ALL=C tr -d '\041-\176' < "$f" | wc -c)
    [ "$(tail -c1 "$f" | LC_ALL=C tr -d '\n' | wc -c)" -ne 0 ] || fin=1
    if [ "$extra" -ne "$fin" ]; then
      secret_store_refuse "secret file ${f} (${what}) holds a byte outside printable ASCII (0x21 to 0x7e), a final newline apart: a space, a control character or a non-ASCII byte inside the value. Write the value alone, for example with printf '%s\\n'."
    fi
  fi
}

# Every variable of the environment THIS process was started with, as NAME=value
# records ended by NUL. Read from /proc, so that a name bash cannot import (a dot
# or a dash in it) is seen too; compgen is the fallback. Nothing here is printed.
secret_store_env_records() {
  if [ -r "/proc/$$/environ" ]; then
    cat "/proc/$$/environ"
  else
    local n
    for n in $(compgen -e); do printf '%s=%s\0' "$n" "${!n}"; done
  fi
}

# Secret-looking names and URLs with a password, in ANY variable. A fixed list
# cannot name what a shared `.env` carries. Only the NAME is ever printed.
secret_store_scan_environment() {
  local dir="$1" rec n v u p shown
  while IFS= read -r -d '' rec; do
    n="${rec%%=*}"
    [ "$n" != "$rec" ] || continue
    v="${rec#*=}"
    shown="${n//[^A-Za-z0-9_.-]/?}"
    case "$SS_ENV_ALLOWED_NAMES" in *" ${n} "*) ;; *)
      u="${n^^}"
      for p in "${SS_NAME_WORDS[@]}"; do
        if [[ "$u" == *"$p"* ]]; then
          secret_store_refuse "the environment variable ${shown} is set, and its name looks like a secret (it contains ${p}). In store mode no secret is passed in the environment: remove it from env_file and environment (a compose environment: list names only what Synapse needs), and put the value in a file under ${dir}/."
        fi
      done ;;
    esac
    if [[ "$v" =~ $SS_URL_USERINFO_RE ]]; then
      secret_store_refuse "the environment variable ${shown} is set to a URL that carries a password in its userinfo part. In store mode no secret is passed in the environment: remove the password from the URL and the variable, and put it in a file under ${dir}/."
    fi
  done < <(secret_store_env_records)
}

# sha256 of one string field of a registration file, nothing else on stdout; fails
# when the field is not a non-empty string. The value stays in the pipe.
secret_store_reg_hash() { # $1 file, $2 key
  [ "$(yq ".${2} | select(tag == \"!!str\" and length > 0) | tag" "$1" 2>/dev/null)" = '!!str' ] || return 1
  yq ".${2}" "$1" 2>/dev/null | sha256sum | cut -d' ' -f1
}

# Synapse refuses two registrations with one id or one as_token, and the error it
# raises for the second as_token PRINTS THE TOKEN (appservice.py "Cannot reuse
# as_token across application services"). So the registrations are compared here,
# by id and by a sha256 of each token, before Synapse can print one: the files to be
# listed (SS_APPSERVICE_FILES) and the other registrations that stay listed in an
# existing homeserver.yaml. Only file names are printed.
secret_store_check_registrations() {
  local -A seen_id=() seen_as=() seen_hs=()
  local -a others=() all=()
  local e f i n="${#SS_APPSERVICE_FILES[@]}" h_id h_as h_hs shown
  if [ -f /data/homeserver.yaml ]; then
    while IFS= read -r e; do
      [ -n "$e" ] || continue
      [ "$e" != "$SS_LEGACY_REGISTRATION" ] || continue    # unlisted by this mode
      case "$e" in "${SS_DIR}/"*) continue ;; esac         # this mode's own entries are replaced
      case " ${SS_APPSERVICE_FILES[*]} " in *" ${e} "*) continue ;; esac   # the same file, compared once
      # Fail closed: an entry that cannot be read and compared is refused, never skipped. A skipped
      # registration could share its as_token with a file to be listed, and Synapse's error for
      # that prints the token. Only the name is printed, and a name that is not a safe path is
      # printed with every unsafe character replaced by a question mark.
      if ! [[ "$e" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
        shown="${e//[^A-Za-z0-9._\/-]/?}"
        secret_store_refuse "/data/homeserver.yaml lists the entry ${shown:0:200} in app_service_config_files, and it is not an absolute path made of [A-Za-z0-9._/-], so it cannot be checked against the other registrations (Synapse's error for a repeated as_token prints the token). Fix the entry or remove it."
      fi
      [ -f "$e" ] && [ -r "$e" ] \
        || secret_store_refuse "/data/homeserver.yaml lists ${e} in app_service_config_files, and it is not a readable regular file, so it cannot be checked against the other registrations (Synapse's error for a repeated as_token prints the token). Fix the entry or remove it."
      others+=("$e")
    done < <(yq '(.app_service_config_files // [])[] | select(tag == "!!str")' /data/homeserver.yaml 2>/dev/null)
  fi
  all=("${SS_APPSERVICE_FILES[@]}" "${others[@]}")
  for ((i = 0; i < ${#all[@]}; i++)); do
    f="${all[i]}"
    if ! { h_id=$(secret_store_reg_hash "$f" id) && h_as=$(secret_store_reg_hash "$f" as_token) && h_hs=$(secret_store_reg_hash "$f" hs_token); }; then
      if [ "$i" -lt "$n" ]; then
        secret_store_refuse "registration file ${f} (SYNAPSE_APPSERVICE_FILES) is not a registration Synapse can load: it needs the string fields id, as_token and hs_token."
      fi
      continue    # another registration of the config: Synapse judges it
    fi
    [ -z "${seen_id[$h_id]:-}" ] \
      || secret_store_refuse "the registration files ${seen_id[$h_id]} and ${f} have the same id. Synapse refuses two application services with one id."
    [ -z "${seen_as[$h_as]:-}" ] \
      || secret_store_refuse "the registration files ${seen_as[$h_as]} and ${f} have the same as_token. Synapse refuses that with an error message that prints the token, so the files are refused here, by name only. Give each application service its own as_token."
    [ -z "${seen_hs[$h_hs]:-}" ] \
      || secret_store_refuse "the registration files ${seen_hs[$h_hs]} and ${f} have the same hs_token. Give each application service its own hs_token."
    [ -z "${seen_hs[$h_as]:-}" ] \
      || secret_store_refuse "the as_token of ${f} is the hs_token of ${seen_hs[$h_as]}. Give each token its own value."
    [ -z "${seen_as[$h_hs]:-}" ] \
      || secret_store_refuse "the hs_token of ${f} is the as_token of ${seen_as[$h_hs]}. Give each token its own value."
    [ "$h_as" != "$h_hs" ] \
      || secret_store_refuse "the registration file ${f} has the same value as as_token and as hs_token."
    seen_id[$h_id]="$f"; seen_as[$h_as]="$f"; seen_hs[$h_hs]="$f"
  done
}

# Every refusal that does not need homeserver.yaml, before anything is written
# (and so before `/start.py generate` on a first boot).
secret_store_preflight() {
  local dir="${SYNAPSE_SECRETS_DIR%/}" n f tmpd tmpf
  local -a names files

  [[ "$dir" =~ ^/[A-Za-z0-9._/-]+$ ]] \
    || secret_store_refuse "SYNAPSE_SECRETS_DIR must be an absolute directory path made of [A-Za-z0-9._/-]."
  SS_DIR="$dir"

  # yq -i writes its temp file under $TMPDIR (default /tmp): with that unwritable
  # (a read-only root file system without a tmpfs) every edit below would fail
  # half way. Checked first, before anything else needs a temp file.
  tmpd="${TMPDIR:-/tmp}"
  if tmpf=$(mktemp "${tmpd%/}/.ss-preflight.XXXXXX" 2>/dev/null); then
    rm -f "$tmpf" || secret_store_refuse "could not remove the test file ${tmpf} from ${tmpd}."
  else
    secret_store_refuse "${tmpd} is not a writable directory. yq -i writes its temp file there: give the container a writable /tmp (compose: tmpfs: /tmp) or point TMPDIR at a writable directory."
  fi

  # Names only, never values. read -a splits on comma, space, tab and newline and
  # never globs; -d '' reads the whole value, not its first line.
  IFS=$', \n\t' read -r -d '' -a names <<< "${SS_REFUSED_ENV_NAMES} ${SYNAPSE_SECRET_ENV_DENY:-}" || true
  for n in "${names[@]}"; do
    [[ "$n" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] \
      || secret_store_refuse "SYNAPSE_SECRET_ENV_DENY holds an entry that is not an environment variable name."
    if [ -n "${!n+x}" ]; then
      secret_store_refuse "the environment variable ${n} is set. In store mode no secret is passed in the environment: remove it from env_file and environment, and put the value in a file under ${dir}/."
    fi
  done
  secret_store_scan_environment "$dir"

  if [ "$(id -u)" = 0 ]; then
    secret_store_refuse "the container runs as root. Run it as the Synapse user (compose: user: \"991:991\"): /start.py would drop root with gosu, which clears supplementary groups, and a secret file readable only through group_add would then be unreadable."
  fi
  # With UID in the environment /start.py always calls gosu, which a non-root user cannot.
  if tr '\0' '\n' </proc/$$/environ 2>/dev/null | grep -q '^UID='; then
    secret_store_refuse "the environment variable UID is set. /start.py would then try to switch users with gosu; run the container with compose user: \"991:991\" and leave UID and GID unset."
  fi

  # This script edits /data/homeserver.yaml and nothing else. If /start.py were told
  # to read another config, Synapse would run on a file nothing here has secured.
  case "${SYNAPSE_CONFIG_DIR:-}" in ""|/data|/data/) ;; *)
    secret_store_refuse "SYNAPSE_CONFIG_DIR is set to something other than /data. This entrypoint secures /data/homeserver.yaml only; unset it." ;;
  esac
  case "${SYNAPSE_CONFIG_PATH:-}" in ""|/data/homeserver.yaml) ;; *)
    secret_store_refuse "SYNAPSE_CONFIG_PATH is set to something other than /data/homeserver.yaml. This entrypoint secures that file only; unset it." ;;
  esac

  # yq -i writes through a temp file and copies it back, so it needs write
  # permission on the file itself (a homeserver.yaml owned by another uid fails
  # with "permission denied" even when /data is ours).
  [ -d /data ] && [ -w /data ] \
    || secret_store_refuse "/data is not writable by uid $(id -u). Give the Synapse user (991) ownership of the data volume once."
  if [ -f /data/homeserver.yaml ] && [ ! -w /data/homeserver.yaml ]; then
    secret_store_refuse "/data/homeserver.yaml is not writable by uid $(id -u). Give the Synapse user (991) ownership of it once."
  fi

  SS_MAS_FILE="${SYNAPSE_MAS_SECRET_FILE:-${dir}/mas_shared_secret}"
  SS_MACAROON_FILE="${SYNAPSE_MACAROON_SECRET_FILE:-${dir}/macaroon_secret_key}"
  SS_FORM_FILE="${SYNAPSE_FORM_SECRET_FILE:-${dir}/form_secret}"
  SS_APPSERVICE_FILES=()
  if [ -n "${SYNAPSE_APPSERVICE_FILES+x}" ]; then
    # Set but empty is a valid choice: no registration file. The whole value is read,
    # a newline separates like a comma or a space; each file once.
    IFS=$', \n\t' read -r -d '' -a files <<< "${SYNAPSE_APPSERVICE_FILES}" || true
    for f in "${files[@]}"; do
      case " ${SS_APPSERVICE_FILES[*]} " in *" ${f} "*) ;; *) SS_APPSERVICE_FILES+=("$f") ;; esac
    done
  else
    SS_APPSERVICE_FILES=("${dir}/lk_jwt_as_registration.yaml")
  fi
  secret_store_check_file SYNAPSE_MAS_SECRET_FILE "$SS_MAS_FILE" raw
  secret_store_check_file SYNAPSE_MACAROON_SECRET_FILE "$SS_MACAROON_FILE" raw
  secret_store_check_file SYNAPSE_FORM_SECRET_FILE "$SS_FORM_FILE" raw
  for f in "${SS_APPSERVICE_FILES[@]}"; do
    secret_store_check_file SYNAPSE_APPSERVICE_FILES "$f" yaml
  done
  secret_store_check_registrations
  secret_store_check_inline_keys
  echo "Secret store mode: MAS, macaroon and form secrets and the appservice registration(s) are read from files under ${dir}/; none is in the environment; Synapse will start with --no-secrets-in-config."
}

# The mode is off, but homeserver.yaml was written by a store-mode boot. Going on
# would write `matrix_authentication_service.secret` next to the `secret_path` store
# mode set (Synapse's MasConfigModel refuses both and its error repeats the block,
# the secret included) and would list a second copy of the registration. Nothing
# is written; this is a read of the file, and a config without those keys (every
# deployment that never used the mode) passes untouched.
secret_store_mode_off_check() {
  local hs=/data/homeserver.yaml k n
  [ -f "$hs" ] || return 0
  for k in .matrix_authentication_service.secret_path .macaroon_secret_key_path .form_secret_path; do
    n=$(yq "[${k}] | map(select(. != null)) | length" "$hs" 2>/dev/null) || n=0
    if [ "${n:-0}" != 0 ]; then
      secret_store_refuse "SYNAPSE_SECRETS_DIR is not set, but /data/homeserver.yaml has ${k}, which only the secret store mode writes. With the mode off this entrypoint would write the secret inline next to it, and Synapse refuses that with an error message that prints the secret. Rolling back is not supported: fix forward (set SYNAPSE_SECRETS_DIR again and mount the secret files), or restore a homeserver.yaml from before the switch. Nothing was changed."
    fi
  done
}

# homeserver.yaml must carry none of the inline secret keys that Synapse's own flag
# does not check. Run before anything is written (an existing config), and again on
# the final re-read.
secret_store_check_inline_keys() {
  local hs=/data/homeserver.yaml k n
  [ -f "$hs" ] || return 0
  for k in "${SS_INLINE_KEYS[@]}"; do
    n=$(yq "[${k}] | map(select(. != null and . != \"\")) | length" "$hs" 2>/dev/null) || n=error
    [ "$n" = 0 ] \
      || secret_store_refuse "/data/homeserver.yaml holds an inline secret at ${k} (or could not be read). Synapse's --no-secrets-in-config does not check this key; move the value to a file or remove it."
  done
}

# What is ON DISK, after every writer has had its turn: none of the inline keys,
# and the `*_path` references this mode owns.
secret_store_verify_on_disk() {
  local hs=/data/homeserver.yaml n
  [ -f "$hs" ] || return 0
  n=$(yq '[.macaroon_secret_key, .form_secret, .registration_shared_secret, .registration_shared_secret_path, .matrix_authentication_service.secret] | map(select(. != null)) | length' "$hs" 2>/dev/null) || n=error
  [ "$n" = 0 ] \
    || secret_store_refuse "/data/homeserver.yaml still holds an inline secret key (macaroon_secret_key, form_secret, registration_shared_secret(_path) or matrix_authentication_service.secret), or could not be read."
  [ "$(yq '.macaroon_secret_key_path' "$hs" 2>/dev/null)" = "$SS_MACAROON_FILE" ] \
    && [ "$(yq '.form_secret_path' "$hs" 2>/dev/null)" = "$SS_FORM_FILE" ] \
    && [ "$(yq '.matrix_authentication_service.secret_path' "$hs" 2>/dev/null)" = "$SS_MAS_FILE" ] \
    || secret_store_refuse "/data/homeserver.yaml does not reference the secret files (macaroon_secret_key_path, form_secret_path, matrix_authentication_service.secret_path) after writing them."
  secret_store_check_inline_keys
}

# Delete every inline secret this image knows, point the `*_path` keys at the
# files. One yq edit: all of it or none of it. registration_shared_secret and its
# _path are deleted outright (nothing uses them).
apply_secret_store_config() {
  local hs=/data/homeserver.yaml
  SS_MAC="$SS_MACAROON_FILE" SS_FORM="$SS_FORM_FILE" SS_MAS="$SS_MAS_FILE" yq -i '
      del(.macaroon_secret_key) | del(.form_secret)
    | del(.registration_shared_secret) | del(.registration_shared_secret_path)
    | del(.matrix_authentication_service.secret)
    | .macaroon_secret_key_path = strenv(SS_MAC)
    | .form_secret_path = strenv(SS_FORM)
    | .matrix_authentication_service.secret_path = strenv(SS_MAS)
  ' "$hs" || secret_store_refuse "could not write the secret file references to ${hs}."
  secret_store_verify_on_disk
  echo "Secret store mode: homeserver.yaml now has macaroon_secret_key_path, form_secret_path and matrix_authentication_service.secret_path, and no inline secret."
}

# The registration file(s) are mounted secrets (they hold the as_token and the
# hs_token): listed once each, never rendered, rewritten or deleted here. The old
# rendered /data/lk-jwt-as.yaml is only unlisted by apply_lk_jwt_membership, and
# the file itself stays until the operator deletes it: listing both would make
# Synapse refuse the duplicate as_token, and its error message prints that token.
#
# The entries under the secrets directory are this mode's: SYNAPSE_APPSERVICE_FILES
# is the whole list of them. An entry an earlier boot added there that is no longer
# in the list (a registration the operator dropped, or renamed) is unlisted first,
# or Synapse would load a registration nobody wants, fail on a file that is no
# longer mounted, or refuse two files with one id. Entries elsewhere are not touched.
apply_secret_store_appservices() {
  local hs=/data/homeserver.yaml f e
  while IFS= read -r e; do
    case "$e" in "${SS_DIR}/"*) ;; *) continue ;; esac
    case " ${SS_APPSERVICE_FILES[*]} " in *" ${e} "*) continue ;; esac
    SS_F="$e" yq -i 'del(.app_service_config_files[] | select(tag == "!!str" and . == strenv(SS_F)))' "$hs" \
      || secret_store_refuse "could not remove ${e} from app_service_config_files."
    echo "Secret store mode: ${e} is no longer in SYNAPSE_APPSERVICE_FILES and is unlisted from app_service_config_files."
  done < <(yq '(.app_service_config_files // [])[] | select(tag == "!!str")' "$hs" 2>/dev/null)
  for f in "${SS_APPSERVICE_FILES[@]}"; do
    SS_F="$f" yq -i '(.app_service_config_files // []) as $l | .app_service_config_files = (($l - [strenv(SS_F)]) + [strenv(SS_F)])' "$hs" \
      || secret_store_refuse "could not add ${f} to app_service_config_files."
    [ "$(SS_F="$f" yq '[(.app_service_config_files // [])[] | select(. == strenv(SS_F))] | length' "$hs" 2>/dev/null)" = "1" ] \
      || secret_store_refuse "${f} is not listed once in app_service_config_files after writing it."
    echo "Secret store mode: appservice registration ${f} is listed in app_service_config_files."
  done
}

if [ "$SECRET_STORE" = 1 ]; then
  secret_store_preflight
else
  secret_store_mode_off_check
fi

if [ ! -f /data/homeserver.yaml ]; then

/start.py generate


#general
yq -i --unwrapScalar=false ".server_name =\"${MATRIX_HOST}\"" /data/homeserver.yaml
yq -i ".public_baseurl = \"${MATRIX_BASE_URL}\"" /data/homeserver.yaml


#port configuration
yq -i ".listeners[0].port = ${MATRIX_PORT}" /data/homeserver.yaml
yq -i ".listeners[0].resources[0].names = [\"client\", \"federation\"]" /data/homeserver.yaml
yq -i ".listeners[0].tls = false" /data/homeserver.yaml
yq -i ".listeners[0].type = \"http\"" /data/homeserver.yaml
yq -i ".listeners[0].x_forwarded = true" /data/homeserver.yaml
yq -i "del(.listeners[1])" /data/homeserver.yaml

# Delegated auth (Matrix Authentication Service) used to be configured here as
# `experimental_features.msc3861`, first-boot-only. Synapse 1.157.0 REMOVED that
# block outright, so it is now written by apply_mas_config() in the always-run
# section below the first-boot guard — which is also what MIGRATES an
# already-provisioned /data/homeserver.yaml off msc3861. See the block comment there.

# MatrixRTC / call-hardening config (MSC4108/4143/3266/4222, delayed events,
# rc_delayed_event_mgmt, rc_message, matrix_rtc.transports) used to live here,
# first-boot-only. It is now applied by apply_matrixrtc_config() in the
# always-run section below the first-boot guard, so template changes reach
# already-provisioned deployments too. It moved after a call-drop incident
# (2026-06-11) where rc_message had to be hand-applied live with yq because
# this block was first-boot-only.

#federation via well-known delegation (Caddy serves .well-known on port 443)
yq -i ".serve_server_wellknown = false" /data/homeserver.yaml

# ---------------------------------------------------------------------------
# RETENTION — the knob is now REAL, and it is DELIBERATELY OFF.
#
# What was wrong:
#   yq -i ".retention.default_policy.allowed_lifetime_max = ${MATRIX_MESSAGE_LIFETIME}"
# `allowed_lifetime_max` is a TOP-LEVEL retention key: it CLAMPS what a room's
# own m.room.retention event may request. It is not a key Synapse reads inside
# `default_policy`, which accepts only `min_lifetime` / `max_lifetime`. Written
# there it was silently ignored, so there was NO default policy at all and no
# room lacking its own m.room.retention event was ever purged.
#
# MATRIX_MESSAGE_LIFETIME therefore did nothing whatsoever. Confirmed live on
# dev-staging 2026-08-30: retention = {enabled: true, default_policy:
# {allowed_lifetime_max: 4w}} — a setting that reads like a 4-week retention
# policy and purges nothing.
#
# THE KEY THAT ACTUALLY DELETES MESSAGES is `retention.default_policy.max_lifetime`.
# It is left UNSET here on purpose: turning it on has real, irreversible purge
# blast radius and is the operator's call, not a default here. Enabling it
# needs a measured blast-radius number first.
#
# TWO THINGS HAD TO CHANGE, not one. Fixing this template alone does NOT reach
# dev-staging or prod: this whole block sits inside the first-boot guard, so it
# only ever runs on a fresh volume (the retention keys are "frozen").
# An existing deployment keeps its wrong config until someone either hand-edits
# it or the first-boot guard is replaced by a one-shot, versioned migration.
# This change makes NEW deployments correct and honest; it changes NOTHING on
# any existing box, which is exactly the intent.
#
#   MATRIX_RETENTION_ENABLED         default "false" -> nothing is ever purged
#   MATRIX_RETENTION_MAX_LIFETIME    the purging knob; only read when enabled
#   MATRIX_MESSAGE_LIFETIME          legacy name, now used as the CLAMP, which
#                                    is what the key it fed always meant
# ---------------------------------------------------------------------------
if [ "${MATRIX_RETENTION_ENABLED:-false}" = "true" ]; then
  yq -i ".retention.enabled = true" /data/homeserver.yaml
  # The clamp, at its correct TOP-LEVEL position (not under default_policy).
  yq -i ".retention.allowed_lifetime_max = \"${MATRIX_MESSAGE_LIFETIME}\"" /data/homeserver.yaml
  # The key that actually purges. Only written when explicitly configured.
  if [ -n "${MATRIX_RETENTION_MAX_LIFETIME:-}" ]; then
    yq -i ".retention.default_policy.max_lifetime = \"${MATRIX_RETENTION_MAX_LIFETIME}\"" /data/homeserver.yaml
    echo "First boot: retention ENABLED, default_policy.max_lifetime=${MATRIX_RETENTION_MAX_LIFETIME} (messages WILL be purged)"
  else
    echo "First boot: retention enabled as a CLAMP only (allowed_lifetime_max=${MATRIX_MESSAGE_LIFETIME}); no default_policy.max_lifetime, so nothing is purged"
  fi
else
  # Explicitly off, and explicitly written, so the config states the intent
  # rather than leaving a reader to infer it from a key that does nothing.
  yq -i ".retention.enabled = false" /data/homeserver.yaml
  echo "First boot: message retention DISABLED (no purging). Set MATRIX_RETENTION_ENABLED=true to change."
fi

# Server notices: the channel the storage controller (scripts/matrix-storage-controller.sh)
# pushes WARN/CRIT storage alerts through. Synapse force-creates @notices and a
# "Server Alerts" room and posts via POST /_synapse/admin/v1/send_server_notice,
# authenticated by a short-TTL admin token the controller mints from siwx-oidc
# (POST /oauth2/admin_token). The MAS shared secret does not work there on
# Synapse 1.157+.
yq -i ".server_notices.system_mxid_localpart = \"notices\"" /data/homeserver.yaml
yq -i ".server_notices.system_mxid_display_name = \"${MATRIX_HOST} storage alerts\"" /data/homeserver.yaml
yq -i ".server_notices.room_name = \"Server Alerts\"" /data/homeserver.yaml

echo "First boot: homeserver.yaml generated; delegated auth is applied below on every boot."

else
  echo "Setup already completed! Skipping Setup"
fi

# -----------------------------------------------------------------------------
# MatrixRTC / call-hardening config — ALWAYS RE-ASSERTED, EVERY BOOT.
#
# These are pure `yq -i` key assignments — idempotent, since re-applying the
# same value is a no-op — so they are safe (and necessary) to run
# unconditionally whenever /data/homeserver.yaml exists: right after
# /start.py generate on first boot (above), AND on every later restart
# against an already-generated homeserver.yaml. Before this restructure, this
# block lived only inside the first-boot guard, so a template change here
# would silently never reach an existing deployment: in the 2026-06-11
# call-drop incident, rc_message had to be hand-applied live with yq plus a
# manual restart.
# -----------------------------------------------------------------------------
# -----------------------------------------------------------------------------
# Delegated auth via the STABLE Matrix Authentication Service integration —
# ALWAYS RE-ASSERTED, EVERY BOOT, because it is also the MIGRATION off MSC3861.
#
# Synapse 1.157.0 removed `experimental_features.msc3861`; a leftover non-empty
# block is now a hard ConfigError that refuses to boot
# (synapse/config/experimental.py). This entrypoint's setup block is
# first-boot-only, so an already-provisioned /data/homeserver.yaml would keep its
# msc3861 block forever and the container would crash-loop on upgrade. The
# migration therefore runs unconditionally, here, before /start.py.
#
# Stable config shape (synapse/config/mas.py, MasConfigModel):
#   matrix_authentication_service:
#     enabled: true
#     endpoint: <base URL of the OP>   # AnyHttpUrl
#     secret:   <shared secret>        # == the old msc3861 client_secret
#
# `endpoint` is the ONLY location knob. Synapse derives BOTH
#   {endpoint}/.well-known/openid-configuration  (MasDelegatedAuth._metadata_url)
#   {endpoint}/oauth2/introspect                 (_introspection_endpoint)
# from it, and IGNORES the metadata document's own `introspection_endpoint`.
#
# There is no `issuer_metadata` override any more, and none is needed: siwx-oidc
# builds its whole discovery document from SIWEOIDC_BASE_URL (host-independent —
# it does not echo the request Host), so fetching it over the docker-internal
# address still returns the PUBLIC issuer and endpoint URLs, which Synapse then
# forwards to browsers verbatim via GET /_matrix/client/v1/auth_metadata
# (MasDelegatedAuth.auth_metadata returns the full metadata dict, and
# ServerMetadata is pydantic with extra="allow", so our extra keys — including
# account_management_actions_supported — survive). That is exactly the
# decoupling the old hand-built issuer_metadata block provided, now for free.
#
# Two knobs disappear as a consequence, both correctly:
#   * issuer — clients now see siwx-oidc's own `issuer` claim, so the RFC 8414
#     3.3 trailing-slash byte-match against .well-known/matrix/client is owned by
#     siwx-oidc alone and can no longer drift from Synapse's config. It HAD
#     drifted: dev-staging carried msc3861.issuer with no trailing slash.
#   * account_management_url — Synapse reads `account_management_uri` from the OP
#     metadata (a REQUIRED field of ServerMetadata), which siwx-oidc always emits
#     as {base_url}/account.
#
# On 1.157+ Synapse accepts the shared secret in two places only: as the
# `Authorization: Bearer <secret>` it sends to siwx-oidc's introspection
# endpoint, and on its own /_synapse/mas/* routes
# (is_request_using_the_shared_secret()). It no longer opens /_synapse/admin/*:
# 1.157 removed the msc3861 `admin_token`. The admin API takes a short-TTL
# admin-scoped token that siwx-oidc mints (POST /oauth2/admin_token, itself
# authenticated with this secret; the storage controller uses it too). Do not
# reintroduce an admin_token setting here.
# -----------------------------------------------------------------------------
apply_mas_config() {
  # Where Synapse reaches siwx-oidc. Internal docker address when the compose
  # supplies one (local/e2e); otherwise the public base URL — which is what
  # prod/dev-staging already used under msc3861 (no issuer_metadata there), so
  # this preserves the existing network path exactly.
  local mas_endpoint="${SIWEOIDC_INTERNAL_URL:-${SIWEOIDC_BASE_URL:-}}"
  mas_endpoint="${mas_endpoint%/}"

  # DO NOT CLOBBER A GOOD CONFIG FROM AN INCOMPLETE ENVIRONMENT.
  #
  # Unlike the first-boot setup block, this function runs on EVERY boot and
  # re-derives both values from the environment each time. That is what makes it
  # a migration — and also what makes an env regression destructive in a way the
  # first-boot guard never was: with SIWEOIDC_BASE_URL (or MAS_SHARED_SECRET)
  # missing or empty, the yq writes below replace a WORKING on-disk config with
  # `endpoint: ""` / `secret: ""`. Synapse 1.159 then refuses to boot
  # ("Could not validate Matrix Authentication Service configuration: 1
  # validation error for MasConfigModel") and the last-known-good value is gone
  # from disk. Verified empirically, H13 phase 7, 2026-08-30.
  #
  # Both vars reach the Synapse container via compose `env_file: .env`, so a
  # single .env edit or an env_file drop is enough to trigger this.
  #
  # Skip rather than exit: if the on-disk config is already correct the server
  # stays up (nothing else in this container consumes these vars), and if it
  # still carries an msc3861 block Synapse fails loudly on its own with the
  # explicit "was removed. Use the matrix_authentication_service configuration
  # instead." ConfigError. Either way no good state is destroyed and no failure
  # is hidden.
  #
  # Store mode: the secret is a file (checked by secret_store_preflight and
  # referenced by apply_secret_store_config), so only the endpoint can be missing.
  if [ -z "${mas_endpoint}" ] || { [ "${SECRET_STORE:-0}" != 1 ] && [ -z "${MAS_SHARED_SECRET:-}" ]; }; then
    echo "ERROR: refusing to write matrix_authentication_service — endpoint (SIWEOIDC_INTERNAL_URL/SIWEOIDC_BASE_URL) or MAS_SHARED_SECRET is empty." >&2
    echo "ERROR: leaving /data/homeserver.yaml untouched; restore the environment and restart." >&2
    return 0
  fi

  # THE MIGRATION: drop the removed experimental block. No-op once already gone.
  yq -i "del(.experimental_features.msc3861)" /data/homeserver.yaml

  yq -i ".matrix_authentication_service.enabled = true" /data/homeserver.yaml
  yq -i ".matrix_authentication_service.endpoint = \"${mas_endpoint}\"" /data/homeserver.yaml
  # Store mode never writes the secret: apply_secret_store_config sets secret_path.
  if [ "${SECRET_STORE:-0}" != 1 ]; then
    yq -i ".matrix_authentication_service.secret = \"${MAS_SHARED_SECRET}\"" /data/homeserver.yaml
  fi
}

# -----------------------------------------------------------------------------
# THE DID PROFILE FIELD — a THREE-SIDED wire contract whose sides are deployed
# independently and fail APART, silently:
#
#   provider    siwx-oidc          src/did_assertion.rs::DID_PROFILE_FIELD
#   consumer    siwx-oidc-auth     src/did_assertion.rs::DID_PROFILE_FIELD
#   homeserver  THIS denylist entry
#
# Overridable for a deployment that renames it, but all three move TOGETHER:
# changing it on one side alone silently unprotects the live field. Hoisted to a
# script-level export (it used to be a one-shot prefix assignment on the `yq`
# line) because the verification, the failure banner and the write all have to
# name the same string, and `strenv()` needs it exported anyway.
# -----------------------------------------------------------------------------
SIWX_DID_PROFILE_FIELD="${SIWX_DID_PROFILE_FIELD:-io.inblock.did}"
export SIWX_DID_PROFILE_FIELD

# The ONE place the "what / what it means / what to do" text lives, so the hard
# fail and the SIWX_ALLOW_UNPROTECTED_DID_FIELD warn-mode downgrade can never
# drift apart into two different descriptions of the same hole. $1 is the one
# line that differs: the specific defect detected.
did_field_unprotected_banner() {
  echo "" >&2
  echo "################################################################################" >&2
  echo "##  DID PROFILE FIELD '${SIWX_DID_PROFILE_FIELD}' IS NOT PROTECTED" >&2
  echo "##" >&2
  echo "##  WHAT:  $1" >&2
  echo "##" >&2
  echo "##  MEANS: '${SIWX_DID_PROFILE_FIELD}' is then an ordinary, USER-WRITABLE" >&2
  echo "##         MSC4133 custom profile field. Stock Synapse authorizes a custom-" >&2
  echo "##         field write with an ownership check and NOTHING else (1.159.0" >&2
  echo "##         handlers/profile.py:700-704 — no value validation anywhere in the" >&2
  echo "##         path), so ANY user can overwrite their OWN copy of this field with" >&2
  echo "##         SOMEONE ELSE'S DID and misrepresent their cryptographic identity to" >&2
  echo "##         every client and every federating server that reads it — the field" >&2
  echo "##         is world-readable by default (config/server.py:561," >&2
  echo "##         require_auth_for_profile_requests = False) and federates via" >&2
  echo "##         handlers/profile.py::on_profile_query. siwx-oidc's ES256 assertion" >&2
  echo "##         makes such tampering DETECTABLE; only this denylist makes it" >&2
  echo "##         IMPOSSIBLE." >&2
  echo "##" >&2
  echo "##  DO:    run the PATCHED Synapse image this repo builds — dockerfiles/" >&2
  echo "##         Dockerfile applies patches/synapse/msc4133-profile-field-write-" >&2
  echo "##         policy.patch (element-hq/synapse#19980) and FAILS THE BUILD if it" >&2
  echo "##         stops applying. Production pins that image by DIGEST and promotion" >&2
  echo "##         is a human editing .env, so the usual cause is a digest that" >&2
  echo "##         predates the patch, or one that points at a stock" >&2
  echo "##         matrixdotorg/synapse. Full registry: patches/synapse/README.md." >&2
  echo "################################################################################" >&2
  echo "" >&2
}

# Can the Synapse in THIS container actually enforce the denylist?
#
# The build-time guarantee is real, but it is not THIS guarantee. `patch
# --forward --batch --fuzz=0` failing the image build protects the image we
# BUILD; it says nothing about the image a deployment actually PINNED. Prod runs
# a digest chosen by hand in .env, so "accidentally running a stock Synapse" is a
# realistic deploy mistake rather than a hypothetical — and it is the worst kind,
# because on stock Synapse `msc4133_key_denylist` is simply an unknown
# `experimental_features` entry that is silently IGNORED. The write below still
# succeeds, the config still LOOKS right, and every user's provider-asserted DID
# is user-writable with ZERO signal anywhere. (The previous version of this
# function's comment noted that "it does not gate startup" as a safety property.
# That was exactly backwards: it is the hole.)
#
# Probed by SOURCE MARKER, not by a live 403: this runs before Synapse is
# listening, and a live probe would need a user access token we do not have here.
#
# TWO markers, and both are the CONFIG KEY NAME, because they are the two
# independent halves of "this config has any effect at all":
#   config/experimental.py  — the key we write is PARSED (not silently ignored)
#   handlers/profile.py     — the parsed key is READ on the profile write path
# Deliberately NOT the patch's private helper `_is_profile_field_disallowed`
# (verified to discriminate correctly on 2026-09-13, patched vs stock): it is an
# internal name upstream may rename at will, whereas patches/synapse/README.md
# keeps the upstream CONFIG key names verbatim precisely so that adopting the
# merged PR is a no-op for this config. And a rename of the config key would
# break the `yq` write below anyway, so it MUST fail here rather than pass.
#
# The package directory is resolved via `import synapse` rather than hard-coded
# as python3.13/site-packages, for the same reason dockerfiles/Dockerfile does:
# a base image that bumps its Python would otherwise make this probe read
# "absent" (fail-closed, but for the wrong reason) or, worse, miss the file.
synapse_enforces_did_field_denylist() {
  local pkg
  pkg="$(python3 -c 'import synapse, os; print(os.path.dirname(synapse.__file__))' 2>/dev/null)"
  [ -n "${pkg}" ] || return 1
  grep -q 'msc4133_key_denylist' "${pkg}/config/experimental.py" 2>/dev/null || return 1
  grep -q 'msc4133_key_denylist' "${pkg}/handlers/profile.py"    2>/dev/null || return 1
  return 0
}

# Re-read what is ACTUALLY ON DISK. "`yq -i` was invoked" and "/data/homeserver.yaml
# contains the value" are different facts and only the second one protects anyone:
# this script runs without `set -e`, so a failed write is otherwise a no-op that
# startup sails straight past.
#
# `grep -Fxq` rather than a `yq ... | contains(...)` expression: the field name is
# full of dots, F makes it a fixed string and x anchors the whole line, so no part
# of the value can be re-interpreted as a pattern or a yq path.
did_field_denylist_on_disk_contains_field() {
  [ -f /data/homeserver.yaml ] || return 1
  yq '.experimental_features.msc4133_key_denylist // [] | .[]' /data/homeserver.yaml 2>/dev/null \
    | grep -Fxq "${SIWX_DID_PROFILE_FIELD}"
}

apply_did_field_protection() {
  # Make the provider-asserted DID profile field immutable to the user.
  #
  # siwx-oidc publishes each user's DID into their MSC4133 profile under
  # `io.inblock.did`, signed with the provider's ES256 key. On stock Synapse
  # that field is freely user-writable with no value validation
  # (handlers/profile.py:700-704 checks ownership and nothing else) — see the
  # banner above for the full consequence. The signature makes tampering
  # detectable; this denylist makes it impossible.
  #
  # Requires the vendored patch dockerfiles/Dockerfile applies —
  # patches/synapse/msc4133-profile-field-write-policy.patch, a backport of
  # element-hq/synapse#19980 — and, since 2026-09-13, VERIFIES that it is
  # present rather than assuming it.
  #
  # DENYLIST, never msc4133_key_allowlist: the allowlist is a hard whitelist
  # over EVERY custom profile field on the homeserver, which would forbid every
  # other field our users might ever set. Upstream's key name is used verbatim
  # so that adopting the merged PR is a no-op for this config.

  # The field name must satisfy Synapse's Common Namespaced Identifier Grammar
  # (1.159.0 util/stringutils.py:53, unchanged at 1.161.0; enforced by is_namedspaced_grammar() at
  # rest/client/profile.py:138/179/240 on EVERY custom-field GET/PUT/DELETE).
  # A name that fails it is unreachable on the C-S API for everybody — including
  # siwx-oidc's own admin PUT — so a denylist carrying one is inert and the whole
  # feature is silently off. Hard fail with NO escape hatch: this is a typo in
  # our own configuration, never a deployment shape anyone deliberately chooses.
  if [[ ! "${SIWX_DID_PROFILE_FIELD}" =~ ^[a-z][a-z0-9_.-]{0,254}$ ]]; then
    did_field_unprotected_banner "SIWX_DID_PROFILE_FIELD='${SIWX_DID_PROFILE_FIELD}' violates Synapse's Common Namespaced Identifier Grammar ^[a-z][a-z0-9_.-]{0,254}\$, so no such profile field can exist and the denylist entry would protect nothing."
    echo "REFUSING TO START: this is a typo in our own configuration, not a deployment shape; there is no override." >&2
    exit 1
  fi

  # `yq` is given the field name as a strenv() so the dots in "io.inblock.did"
  # are never parsed as a yq path expression.
  if ! yq -i '.experimental_features.msc4133_key_denylist = [strenv(SIWX_DID_PROFILE_FIELD)]' \
        /data/homeserver.yaml; then
    did_field_unprotected_banner "the yq write of experimental_features.msc4133_key_denylist into /data/homeserver.yaml FAILED (yq exited non-zero — unwritable file, malformed YAML, or no yq)."
    echo "REFUSING TO START: a config write that silently did not happen must not become a running server." >&2
    exit 1
  fi

  # THE GATE. Default is a hard fail, deliberately: a homeserver that publishes
  # provider-signed DID assertions into a field any user can overwrite is worse
  # than a homeserver that refuses to start. The first is a silent identity
  # forgery surface that nobody will notice; the second is an outage somebody
  # fixes in ten minutes.
  if synapse_enforces_did_field_denylist; then
    echo "DID field protection: '${SIWX_DID_PROFILE_FIELD}' denylisted, and this Synapse carries the MSC4133 write-ACL patch (msc4133_key_denylist parsed in config/experimental.py and read in handlers/profile.py)."
  elif [ "${SIWX_ALLOW_UNPROTECTED_DID_FIELD:-}" = "1" ]; then
    # Escape hatch, named so that nobody sets it without understanding it. It
    # downgrades ONLY this check — an operator may deliberately run a stock
    # Synapse (a version-bump dry run, a bisect, a standalone deployment that
    # publishes no DIDs). It does NOT downgrade the write verification: a config
    # write that did not land is never an intended deployment shape.
    SIWX_DID_FIELD_UNPROTECTED_WARN=1
    did_field_unprotected_banner "this Synapse does NOT carry the MSC4133 write-ACL patch — 'msc4133_key_denylist' is an unknown experimental_features key here and Synapse IGNORES it."
    echo "WARNING: SIWX_ALLOW_UNPROTECTED_DID_FIELD=1 is set — starting anyway, with the field UNPROTECTED. You are accepting everything above." >&2
  else
    did_field_unprotected_banner "this Synapse does NOT carry the MSC4133 write-ACL patch — 'msc4133_key_denylist' is an unknown experimental_features key here and Synapse IGNORES it."
    echo "REFUSING TO START. Set SIWX_ALLOW_UNPROTECTED_DID_FIELD=1 to start anyway (you are then accepting everything above)." >&2
    exit 1
  fi
}

apply_matrixrtc_config() {
  # Enable QR code login rendezvous server (MSC4108 2024 version)
  yq -i ".experimental_features.msc4108_enabled = true" /data/homeserver.yaml

  # MatrixRTC: enable experimental features for Element Call
  yq -i ".experimental_features.msc4143_enabled = true" /data/homeserver.yaml
  yq -i ".experimental_features.msc3266_enabled = true" /data/homeserver.yaml
  yq -i ".experimental_features.msc4222_enabled = true" /data/homeserver.yaml

  # Delayed events (MSC4140): auto-quit interrupted calls
  yq -i ".max_event_delay_duration = \"24h\"" /data/homeserver.yaml

  # Rate limiting for call heartbeats (every 5s per participant)
  yq -i ".rc_delayed_event_mgmt.per_second = 1" /data/homeserver.yaml
  yq -i ".rc_delayed_event_mgmt.burst_count = 20" /data/homeserver.yaml

  # Rate limiting for in-call E2EE key sharing (bursty room messages); values from
  # Element Call docs/self_hosting.md. Synapse defaults (0.2/10) can rate-limit calls.
  yq -i ".rc_message.per_second = 0.5" /data/homeserver.yaml
  yq -i ".rc_message.burst_count = 30" /data/homeserver.yaml

  # MatrixRTC transport: LiveKit SFU
  #
  # Synapse 1.161.0 DEPRECATES `livekit_service_url` and adds an optional sibling
  # `url` (the SFU WebSocket URL). We deliberately keep `livekit_service_url`
  # and do NOT write `url`: upstream says to keep listing the deprecated key for
  # older clients, and a client that sees `url` switches to reaching the LiveKit
  # authorization service through the C-S API, which only works when
  # lk-jwt-service is registered as an application service. Ours is not (it
  # runs as a plain HTTP service behind /livekit/jwt), so adding `url` would
  # break calls for exactly the newer clients. Adopt `url` together with the
  # appservice registration, never on its own. (apply_lk_jwt_membership now
  # writes a registration, but only for the MSC4502 membership look-up; it has
  # `url: null`, and /livekit/jwt is still the route clients use, so `url`
  # stays unadopted.) 1.161 also starts validating
  # every transport entry (strict strings, and a livekit transport needs `url`
  # or `livekit_service_url`), which the two keys below satisfy.
  yq -i ".matrix_rtc.transports[0].type = \"livekit\"" /data/homeserver.yaml
  yq -i ".matrix_rtc.transports[0].livekit_service_url = \"https://${MATRIX_HOST}/livekit/jwt\"" /data/homeserver.yaml
}

# ---------------------------------------------------------------------------
# lk-jwt-service membership look-up (MSC4502) and its application-service
# registration. Always-run, like the other apply_* functions, so a deployment
# whose /data/homeserver.yaml predates this block converges on its next boot.
#
# WHY. lk-jwt-service (upstream v0.9.0, element-hq/lk-jwt-service#250; formerly our
# require-membership.patch) asks Synapse "is this user joined to this
# room?" through MSC4502, authenticated with an application-service token,
# before it hands out an SFU token. Synapse ships MSC4502 from v1.162.0 behind
# experimental_features.msc4502_enabled. Older Synapse ignores an unknown
# experimental_features key, so the image pin (dockerfiles/Dockerfile) is what
# makes this work, not this line.
#
# THE REGISTRATION is rendered from two secrets in the environment, never
# committed: LK_JWT_AS_TOKEN (lk-jwt -> Synapse) and LK_JWT_HS_TOKEN
# (Synapse -> lk-jwt, unused while `url` is null but required by Synapse).
# lk-jwt-service gets the same two values as LIVEKIT_AS_TOKEN/LIVEKIT_HS_TOKEN
# (docker-compose.yml), so the file never has to be shared with it. Generate with
# `openssl rand -hex 32`, one value each, different from each other.
#
# SCOPE. `io.element.msc4502.scopes` is what the membership look-up needs, and
# it is a list of strings: Synapse REFUSES TO START on an unknown scope, so a
# typo here crashes the container rather than silently granting nothing.
#
# USERS NAMESPACE. lk-jwt's delayed-event handling (upstream PR #240) restarts
# and sends a user's delayed leave event as that user, which an application
# service may only do for users in its `users` namespace. The namespace is
# every LOCAL user (`^@[^:]+:<server_name>$`, the server_name read back from
# homeserver.yaml) and non-exclusive, so it reserves no name and leaves remote
# users' events out of the service's interest. Consequence to know about: the
# AS token is therefore a credential that can act as ANY local user. Treat
# LK_JWT_AS_TOKEN like an admin secret; do not log it and rotate it by changing
# both values and restarting both services.
# The uid:gid Synapse's /start.py runs as, mirroring its main(): a numeric UID
# in the container env, with GID defaulting to 991; without one, 991:991 when
# root, else the current user (start.py then changes no ids, and prints
# nothing here). Read from the process's initial environment, which is what
# /start.py inherits.
synapse_runtime_ids() {
  local u g
  u=$(tr '\0' '\n' </proc/$$/environ | sed -n 's/^UID=//p' | head -n1)
  g=$(tr '\0' '\n' </proc/$$/environ | sed -n 's/^GID=//p' | head -n1)
  if [[ "$u" =~ ^[0-9]+$ ]]; then
    [[ "$g" =~ ^[0-9]+$ ]] || g=991
  elif [ "$(id -u)" = 0 ]; then
    u=991; g=991
  else
    return 0
  fi
  echo "${u}:${g}"
}

lk_jwt_refuse() {
  echo "ERROR: lk-jwt AS registration: $1 Refusing to start Synapse." >&2
  exit 1
}

apply_lk_jwt_membership() {
  local reg=/data/lk-jwt-as.yaml

  # A failed write to homeserver.yaml stops the boot here, as the guest policy's
  # writes do: the file is then in a state nobody checked.
  yq -i ".experimental_features.msc4502_enabled = true" /data/homeserver.yaml \
    || lk_jwt_refuse "could not set msc4502_enabled in /data/homeserver.yaml."
  # Our entry is always removed first and re-added when configured, so the list
  # never holds it twice and another registration in it is left alone.
  yq -i "(.app_service_config_files // []) as \$l | .app_service_config_files = (\$l - [\"${reg}\"])" /data/homeserver.yaml \
    || lk_jwt_refuse "could not remove the old entry from app_service_config_files."

  # Store mode: the registration is a mounted file (apply_secret_store_appservices
  # lists it). Nothing is rendered, chowned or deleted here: LK_JWT_AS_TOKEN and
  # LK_JWT_HS_TOKEN are refused in the environment, and the old rendered
  # ${reg} (unlisted above) is left for the operator to delete.
  if [ "${SECRET_STORE:-0}" = 1 ]; then
    apply_secret_store_appservices
    # The registration the mode-off boots rendered stays on the volume by design
    # (the operator deletes it after the check). Say so on every boot, by name.
    if [ -e "$reg" ]; then
      echo "Secret store mode: ${reg} is left over from boots without the mode. It is no longer listed and still holds both registration tokens: delete it once the switch is verified."
    fi
    return 0
  fi

  # Not configured is a supported state, not an error: a deployment whose env
  # predates these variables must keep starting exactly as before (a merge to
  # main auto-deploys to dev-staging). Only the lk-jwt membership check is lost,
  # and the patched lk-jwt-service itself refuses to start without a registration.
  # A half-set or malformed pair is treated the same way, never as a crash.
  local ok=1 t sn sn_re why
  for t in "${LK_JWT_AS_TOKEN:-}" "${LK_JWT_HS_TOKEN:-}"; do
    # Strict charset, because the value is written into YAML.
    [[ "$t" =~ ^[A-Za-z0-9_-]{32,}$ ]] || ok=0
  done
  [ "${LK_JWT_AS_TOKEN:-}" != "${LK_JWT_HS_TOKEN:-}" ] || ok=0
  why="LK_JWT_AS_TOKEN and LK_JWT_HS_TOKEN must be two different values of 32+ characters [A-Za-z0-9_-], see env.example"
  if [ "$ok" = 1 ]; then
    # The users namespace is built from the server_name on disk; its charset is
    # checked too, because it is written into YAML and into a regex. A missing
    # key reads as empty, never as the string "null". An IPv6 literal server_name
    # is outside the charset and leaves the registration unconfigured.
    sn=$(yq '.server_name // ""' /data/homeserver.yaml 2>/dev/null)
    if ! [[ "$sn" =~ ^[A-Za-z0-9.:-]+$ ]] || [ "$sn" = null ]; then
      ok=0
      why="the server_name in /data/homeserver.yaml is missing or has characters outside [A-Za-z0-9.:-]"
    fi
  fi
  if [ "$ok" != 1 ]; then
    rm -f "$reg"
    echo "lk-jwt AS registration not configured; MSC4502 membership checks unavailable (${why})" >&2
    return 0
  fi

  sn_re=${sn//./\\.}
  # Written next to homeserver.yaml, mode 600: the tokens are secrets, and the
  # process that reads this file is Synapse.
  ( umask 077
    cat > "$reg" <<LKJWT_AS_EOF
id: lk-jwt-service
as_token: "${LK_JWT_AS_TOKEN}"
hs_token: "${LK_JWT_HS_TOKEN}"
sender_localpart: _lk_jwt_service
url: null
namespaces:
  users:
    - exclusive: false
      regex: '^@[^:]+:${sn_re}$'
io.element.msc4502.scopes:
  - "urn:matrix:client:io.element.msc4502:rooms:is_joined"
LKJWT_AS_EOF
  ) || lk_jwt_refuse "could not write ${reg}."
  # Owned by the ids /start.py drops to ($UID:$GID, default 991:991), never by
  # homeserver.yaml's owner: that file is 0644, so Synapse reads it whoever owns
  # it, and on dev-staging it was uid 1000, which left this 0600 file unreadable
  # and Synapse crash-looping (PermissionError on /data/lk-jwt-as.yaml). The ids
  # are the ones synapse_runtime_ids derives; a non-root container without UID
  # already wrote the file as the user Synapse runs as.
  local ids
  ids=$(synapse_runtime_ids)
  if [ -n "$ids" ]; then
    chown "$ids" "$reg" 2>/dev/null \
      || echo "ERROR: could not chown ${reg} to ${ids}; Synapse will not be able to read it" >&2
  fi
  yq -i ".app_service_config_files += [\"${reg}\"]" /data/homeserver.yaml \
    || lk_jwt_refuse "could not add ${reg} to app_service_config_files."
  # Re-read what is ON DISK, as the other gates do.
  [ "$(yq "[(.app_service_config_files // [])[] | select(. == \"${reg}\")] | length" /data/homeserver.yaml 2>/dev/null)" = "1" ] \
    || lk_jwt_refuse "${reg} is not listed once in app_service_config_files after writing it."
}

# -----------------------------------------------------------------------------
# Guest policy module (synapse-guest-policy) — OPTIONAL, ENV-GATED, ALWAYS
# RE-ASSERTED, EVERY BOOT.
#
# WHY IT IS A MOUNT AND NOT IN THE IMAGE. This repository and its GHCR images
# are public; the module repository (inblockio/synapse-guest-policy) is private.
# So the published Synapse image does not contain the module. An operator who
# wants guest confinement mounts a checkout read-only (docker-compose.yml, README
# "Guest policy module (optional)") and sets GUEST_POLICY_ENABLED=true.
#
# FAIL CLOSED. If the flag is on but the module cannot be imported, this REFUSES
# TO START. Confinement must never be silently off when the operator asked for it
# (the same stance as the DID-field gate below). A bad value for any
# GUEST_POLICY_* setting is refused the same way, and Synapse itself stops with a
# ConfigError on a key the module rejects.
#
# FLAG OFF (unset, empty, anything but "true"): Synapse starts exactly as before.
# One info line, no change to homeserver.yaml, except that a module entry this
# function wrote on an earlier boot is removed again (otherwise the next boot
# would fail to import a module nobody mounts). `user_types` is left alone: a
# registered but unused user type is harmless.
#
# Env (all optional except the flag; unset = the module's own default):
#   GUEST_POLICY_ENABLED              true/1/yes/on turns it on; empty/false/0/no/off
#                                     leaves it off; any other value refuses to start
#   GUEST_POLICY_MODULE_PATH          where the checkout is mounted in the
#                                     container (default /modules/synapse-guest-policy;
#                                     the directory that CONTAINS the synapse_guest_policy package)
#   GUEST_POLICY_USER_TYPE            guest_user_type, default io.inblock.guest. Also the
#                                     value added to user_types.extra_user_types.
#   GUEST_POLICY_ROOM_STATE_TYPE      guest_room_state_type, default io.inblock.guest_room
#   GUEST_POLICY_ALLOWED_EVENT_TYPES  guest_allowed_event_types, comma separated.
#                                     Module default m.room.encrypted (guests post in the
#                                     encrypted call chat). "none" = guests read only.
#   GUEST_POLICY_KNOCK_CAP            knock_cap, default 3
#   GUEST_POLICY_KNOCK_WINDOW_SECS    knock_window_secs, default 600
#   GUEST_POLICY_NAME_SUFFIX          name_suffix, default " (Guest)"
# -----------------------------------------------------------------------------
GUEST_POLICY_MODULE_CLASS="synapse_guest_policy.GuestPolicy"

guest_policy_refuse() {
  echo "REFUSING TO START: $*" >&2
  exit 1
}

guest_policy_value_ok() { # $1 name, $2 value, $3 extended regex
  [[ "$2" =~ $3 ]] || guest_policy_refuse "${1}='${2}' is not an accepted value (must match ${3})."
}

# The flag is a security switch, so it never fails open: the usual true
# spellings turn it on, empty and the usual false spellings leave it off, and
# anything else refuses to start (audit F3: "True" or "1" used to mean off).
guest_policy_flag() {
  case "${GUEST_POLICY_ENABLED:-}" in
    [Tt][Rr][Uu][Ee]|1|[Yy][Ee][Ss]|[Oo][Nn]) echo on ;;
    ""|[Ff][Aa][Ll][Ss][Ee]|0|[Nn][Oo]|[Oo][Ff][Ff]) echo off ;;
    *) echo invalid ;;
  esac
}

apply_guest_policy() {
  local hs=/data/homeserver.yaml
  local flag
  flag="$(guest_policy_flag)"
  [ "$flag" != invalid ] || guest_policy_refuse "GUEST_POLICY_ENABLED='${GUEST_POLICY_ENABLED}' is neither true (true, 1, yes, on) nor false (empty, false, 0, no, off)."

  if [ "$flag" != on ]; then
    # Drop only our own entry, leave every other module alone.
    if [ "$(yq "[(.modules // [])[] | select(.module == \"${GUEST_POLICY_MODULE_CLASS}\")] | length" "$hs" 2>/dev/null)" -gt 0 ] 2>/dev/null; then
      yq -i "del(.modules[] | select(.module == \"${GUEST_POLICY_MODULE_CLASS}\")) | del(.modules | select(length == 0))" "$hs"
      echo "Guest policy: GUEST_POLICY_ENABLED is not true; removed the module entry from an earlier boot."
    else
      echo "Guest policy: disabled (GUEST_POLICY_ENABLED is not true)."
    fi
    return 0
  fi

  local path="${GUEST_POLICY_MODULE_PATH:-/modules/synapse-guest-policy}"
  local utype="${GUEST_POLICY_USER_TYPE:-io.inblock.guest}"
  local rstate="${GUEST_POLICY_ROOM_STATE_TYPE:-}"
  local events="${GUEST_POLICY_ALLOWED_EVENT_TYPES:-}"
  local cap="${GUEST_POLICY_KNOCK_CAP:-}"
  local win="${GUEST_POLICY_KNOCK_WINDOW_SECS:-}"
  local suffix="${GUEST_POLICY_NAME_SUFFIX:-}"

  # Values end up in YAML and in a PYTHONPATH: strict charsets, no interpolation.
  guest_policy_value_ok GUEST_POLICY_MODULE_PATH "$path" '^/[A-Za-z0-9._/-]+$'
  guest_policy_value_ok GUEST_POLICY_USER_TYPE "$utype" '^[A-Za-z0-9._-]+$'
  [ -z "$rstate" ] || guest_policy_value_ok GUEST_POLICY_ROOM_STATE_TYPE "$rstate" '^[A-Za-z0-9._-]+$'
  [ -z "$events" ] || guest_policy_value_ok GUEST_POLICY_ALLOWED_EVENT_TYPES "$events" '^(none|[A-Za-z0-9._-]+(,[A-Za-z0-9._-]+)*)$'
  [ -z "$cap" ] || guest_policy_value_ok GUEST_POLICY_KNOCK_CAP "$cap" '^[1-9][0-9]{0,5}$'
  [ -z "$win" ] || guest_policy_value_ok GUEST_POLICY_KNOCK_WINDOW_SECS "$win" '^[1-9][0-9]{0,6}$'
  [ -z "$suffix" ] || guest_policy_value_ok GUEST_POLICY_NAME_SUFFIX "$suffix" '^[][ A-Za-z0-9._()-]+$'

  # The module must be importable BEFORE anything is written.
  if ! PYTHONPATH="${path}${PYTHONPATH:+:${PYTHONPATH}}" python3 -c 'from synapse_guest_policy import GuestPolicy' 2>/dev/null; then
    guest_policy_refuse "GUEST_POLICY_ENABLED=true but the module 'synapse_guest_policy' cannot be imported from ${path}. Mount a checkout of inblockio/synapse-guest-policy there read-only (docker-compose.yml, README 'Guest policy module (optional)'), or unset GUEST_POLICY_ENABLED. Guest confinement is never silently off when requested."
  fi
  export PYTHONPATH="${path}${PYTHONPATH:+:${PYTHONPATH}}"

  # Synapse refuses to store a user_type it does not know. Merge, never replace.
  GP_UTYPE="$utype" yq -i '.user_types.extra_user_types = (((.user_types.extra_user_types // []) + [strenv(GP_UTYPE)]) | unique)' "$hs" \
    || guest_policy_refuse "could not write user_types.extra_user_types to ${hs}."

  # Our entry is always removed first and re-added, so it is never there twice and
  # another module in the list is left alone. Only keys that are set are written.
  GP_CLASS="$GUEST_POLICY_MODULE_CLASS" GP_UTYPE="$utype" GP_RSTATE="$rstate" GP_EVENTS="$events" \
  GP_CAP="$cap" GP_WIN="$win" GP_SUFFIX="$suffix" yq -i '
    (.modules // []) as $m
    | .modules = ($m | map(select(.module != strenv(GP_CLASS))))
    | .modules += [{"module": strenv(GP_CLASS), "config": ({"guest_user_type": strenv(GP_UTYPE)}
        + (strenv(GP_RSTATE) | select(. != "") | {"guest_room_state_type": .})
        + (strenv(GP_EVENTS) | select(. != "") | {"guest_allowed_event_types": (split(",") | map(select(. != "none")))})
        + (strenv(GP_CAP) | select(. != "") | {"knock_cap": to_number})
        + (strenv(GP_WIN) | select(. != "") | {"knock_window_secs": to_number})
        + (strenv(GP_SUFFIX) | select(. != "") | {"name_suffix": .}))}]
  ' "$hs" || guest_policy_refuse "could not write the modules entry to ${hs}."

  # Re-read what is ON DISK, as the other gates do.
  if [ "$(yq "[(.modules // [])[] | select(.module == \"${GUEST_POLICY_MODULE_CLASS}\")] | length" "$hs" 2>/dev/null)" != "1" ]; then
    guest_policy_refuse "the ${GUEST_POLICY_MODULE_CLASS} entry is not in ${hs} after writing it."
  fi
  echo "Guest policy: ENABLED, module from ${path}, guest_user_type=${utype}, allowed event types=${events:-<module default>}."
}

# -----------------------------------------------------------------------------
# Directory search module (inblock_directory) - OPTIONAL, ENV-GATED, ALWAYS
# RE-ASSERTED, EVERY BOOT.
#
# The module answers "whom may this asker find under this term?" for admitted
# service accounts, with the rows Synapse's own user directory gives that asker
# plus each local hit's io.inblock.did profile field. The code is in the image
# (dockerfiles/Dockerfile, synapse-modules/inblock_directory); this function only
# registers it. Contract: docs/directory-search.md.
#
# FLAG OFF (DIRECTORY_ADMITTED_SERVICES unset or empty): the module is NOT
# registered. A module entry this function wrote on an earlier boot is removed
# again (a list that is emptied must switch the endpoint off), and nothing else in
# `modules:` is touched.
#
# FAIL CLOSED. With services set, a malformed value or a module that cannot be
# imported REFUSES TO START: an endpoint that was asked for must not silently be
# missing, and one that is half configured must not serve. The module itself also
# refuses a service that is not a local account.
#
# Env:
#   DIRECTORY_ADMITTED_SERVICES  comma separated MXIDs of the service accounts
#                                that may query (spaces around a comma are ignored)
#   DIRECTORY_MAX_LIMIT          optional, 1 to 50; unset = the module's default (20)
# -----------------------------------------------------------------------------
DIRECTORY_MODULE_CLASS="inblock_directory.DirectoryModule"

directory_refuse() {
  echo "REFUSING TO START: $*" >&2
  exit 1
}

apply_directory_search() {
  local hs=/data/homeserver.yaml
  local raw="${DIRECTORY_ADMITTED_SERVICES:-}"
  local maxl="${DIRECTORY_MAX_LIMIT:-}"

  if [ -z "${raw//[[:space:]]/}" ]; then
    # Drop only our own entry, leave every other module alone.
    if [ "$(yq "[(.modules // [])[] | select(.module == \"${DIRECTORY_MODULE_CLASS}\")] | length" "$hs" 2>/dev/null)" -gt 0 ] 2>/dev/null; then
      yq -i "del(.modules[] | select(.module == \"${DIRECTORY_MODULE_CLASS}\")) | del(.modules | select(length == 0))" "$hs" \
        || directory_refuse "could not remove the ${DIRECTORY_MODULE_CLASS} entry from ${hs}."
      echo "Directory search: DIRECTORY_ADMITTED_SERVICES is empty; removed the module entry from an earlier boot."
    else
      echo "Directory search: disabled (DIRECTORY_ADMITTED_SERVICES is empty)."
    fi
    return 0
  fi

  # Values end up in YAML: strict charsets, no interpolation. Each entry is
  # trimmed, checked on its own and joined again with a plain comma.
  local entry services="" n=0 item rest="${raw},"
  while [ -n "$rest" ]; do
    item="${rest%%,*}"
    rest="${rest#*,}"
    entry="${item#"${item%%[![:space:]]*}"}"
    entry="${entry%"${entry##*[![:space:]]}"}"
    [[ "$entry" =~ ^@[A-Za-z0-9._=/+-]+:[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] \
      || directory_refuse "DIRECTORY_ADMITTED_SERVICES holds an entry that is not a Matrix user ID (@localpart:server, no spaces, no empty entry)."
    services="${services:+${services},}${entry}"
    n=$((n + 1))
  done
  [ -z "$maxl" ] || [[ "$maxl" =~ ^([1-9]|[1-4][0-9]|50)$ ]] \
    || directory_refuse "DIRECTORY_MAX_LIMIT='${maxl}' is not an integer from 1 to 50."

  # The module must be importable BEFORE anything is written.
  if ! python3 -c 'from inblock_directory import DirectoryModule' 2>/dev/null; then
    directory_refuse "DIRECTORY_ADMITTED_SERVICES is set but the module 'inblock_directory' cannot be imported (it is baked into the image by dockerfiles/Dockerfile). Unset DIRECTORY_ADMITTED_SERVICES or use an image that carries the module."
  fi

  # Our entry is always removed first and re-added, so it is never there twice and
  # another module in the list is left alone.
  DIR_CLASS="$DIRECTORY_MODULE_CLASS" DIR_SERVICES="$services" DIR_MAXL="$maxl" yq -i '
    (.modules // []) as $m
    | .modules = ($m | map(select(.module != strenv(DIR_CLASS))))
    | .modules += [{"module": strenv(DIR_CLASS), "config": ({"admitted_services": (strenv(DIR_SERVICES) | split(","))}
        + (strenv(DIR_MAXL) | select(. != "") | {"max_limit": to_number}))}]
  ' "$hs" || directory_refuse "could not write the modules entry to ${hs}."

  # Re-read what is ON DISK, as the other gates do.
  if [ "$(yq "[(.modules // [])[] | select(.module == \"${DIRECTORY_MODULE_CLASS}\")] | length" "$hs" 2>/dev/null)" != "1" ]; then
    directory_refuse "the ${DIRECTORY_MODULE_CLASS} entry is not in ${hs} after writing it."
  fi
  echo "Directory search: ENABLED for ${n} service account(s), max_limit=${maxl:-<module default>}."
}

if [ -f /data/homeserver.yaml ]; then
  apply_mas_config
  apply_matrixrtc_config
  apply_lk_jwt_membership
  apply_guest_policy
  apply_directory_search
  if [ "$SECRET_STORE" = 1 ]; then
    apply_secret_store_config
  fi
  # KEEP LAST among the apply_* functions. apply_mas_config deletes
  # .experimental_features.msc3861 and apply_matrixrtc_config writes four
  # .experimental_features.* keys (apply_lk_jwt_membership one more); running the denylist write after both means a
  # clobber by either is impossible by construction. This is belt; the braces are
  # the final on-disk re-read immediately before /start.py, which makes the
  # guarantee independent of this ordering if a future apply_* is appended here.
  apply_did_field_protection
else
  # /start.py generate above should have created this; if it somehow didn't,
  # the final /start.py below will fail loudly on its own missing config.
  echo "WARNING: /data/homeserver.yaml still missing after setup — skipping MatrixRTC config re-assert." >&2
fi

# Promote admin user if MATRIX_ADMIN_DID (or MATRIX_ADMIN_MXID) is set (idempotent, runs every
# boot). The user must have completed at least one OIDC login before this takes effect.
#
# The admin's MXID is RESOLVED, never derived (2026-09-27): siwx-oidc gives every NEW DID an
# opaque localpart (16 base36 chars) and keeps pre-2026-09 accounts on their legacy
# `did-...` localpart, so `tr ':' '-'` names the wrong account for a new admin DID. siwx-oidc's
# /resolve cannot be asked from here (it probes THIS Synapse, which is not running yet), so the
# lookup reads the database, in the same order as siwx-oidc's own grandfathering rule:
#   1. MATRIX_ADMIN_MXID, when set: used verbatim (the explicit, preferred form).
#   2. The legacy-shaped account, ONLY if it exists: siwx-oidc checks legacy first, so an
#      existing legacy account is by construction the DID's account (an existence check, not
#      a guess; a missing one is never promoted into being).
#   3. The account whose `io.inblock.did` profile field (written by siwx-oidc, write-protected)
#      binds the DID.
# Nothing found = deferred with a message; never a guessed MXID.
if [ -n "${MATRIX_ADMIN_DID:-}" ] || [ -n "${MATRIX_ADMIN_MXID:-}" ]; then
  ADMIN_OK=1
  if [ -n "${MATRIX_ADMIN_MXID:-}" ]; then
    if ! echo "${MATRIX_ADMIN_MXID}" | grep -qE '^@[a-z0-9._=/+-]+:[A-Za-z0-9.:-]+$'; then
      echo "WARNING: MATRIX_ADMIN_MXID='${MATRIX_ADMIN_MXID}' is not a well-formed Matrix ID — skipping admin promotion."
      ADMIN_OK=0
    fi
  elif ! echo "${MATRIX_ADMIN_DID:-}" | grep -qE '^(did:[a-z]+:[a-z0-9]+:[a-z0-9]+:0x[0-9a-fA-F]{40}|did:key:z[1-9A-HJ-NP-Za-km-z]+)$'; then
    # Validate format before use — reject anything that isn't a well-formed DID.
    echo "WARNING: MATRIX_ADMIN_DID='${MATRIX_ADMIN_DID}' has invalid format — skipping admin promotion."
    ADMIN_OK=0
  fi
  if [ "$ADMIN_OK" = "1" ]; then
    # Values are passed as env vars; the Python source is a literal heredoc (single-quoted
    # terminator = no shell expansion inside). Nothing is interpolated into Python code.
    ADMIN_DID="${MATRIX_ADMIN_DID:-}" ADMIN_MXID="${MATRIX_ADMIN_MXID:-}" ADMIN_HOST="${MATRIX_HOST}" python3 << 'PYEOF'
import sqlite3, os

did = os.environ.get('ADMIN_DID', '')        # never comes from shell interpolation into source
explicit = os.environ.get('ADMIN_MXID', '')
host = os.environ['ADMIN_HOST']
FIELD = '$."io.inblock.did".did'

try:
    conn = sqlite3.connect('/data/homeserver.db')
    c = conn.cursor()
    user, how = None, ''
    if explicit:
        user, how = explicit, 'MATRIX_ADMIN_MXID'
    else:
        legacy = '@' + did.replace(':', '-').lower() + ':' + host
        if c.execute('SELECT 1 FROM users WHERE name=?', (legacy,)).fetchone():
            user, how = legacy, 'grandfathered legacy account'
        else:
            # did:pkh is canonicalised case-insensitively (siwx-oidc mxid::canonicalize);
            # did:key is case-sensitive (base58btc) and must match byte-for-byte.
            if did.startswith('did:pkh:'):
                q = f"SELECT full_user_id FROM profiles WHERE lower(json_extract(fields, '{FIELD}')) = lower(?)"
            else:
                q = f"SELECT full_user_id FROM profiles WHERE json_extract(fields, '{FIELD}') = ?"
            try:
                rows = [r[0] for r in c.execute(q, (did,)).fetchall()]
            except sqlite3.OperationalError as e:   # pre-MSC4133 schema: no `fields` column
                rows = []
                print(f'Admin promotion: profile-field lookup unavailable ({e})')
            if len(rows) == 1:
                user, how = rows[0], 'io.inblock.did profile binding'
            elif len(rows) > 1:
                print(f'Admin promotion SKIPPED: {len(rows)} accounts claim {did} ({rows}); '
                      'set MATRIX_ADMIN_MXID explicitly')
    if user is None:
        if not explicit:
            print(f'Admin promotion deferred: no account resolves for {did} yet '
                  '(it must sign in first; the MXID is never guessed)')
    else:
        c.execute('UPDATE users SET admin=1 WHERE name=?', (user,))
        if c.rowcount:
            print(f'Admin promoted: {user} (via {how})')
        else:
            print(f'Admin promotion deferred: {user} not found (user must log in first)')
        conn.commit()
    conn.close()
except Exception as e:
    print(f'Admin promotion error: {e}')
PYEOF
  fi
fi

# -----------------------------------------------------------------------------
# LAST GATE, at the last possible moment before Synapse takes over the process.
#
# apply_did_field_protection() verified its own `yq` exit status; this verifies
# the FILE, after every other apply_* has had its turn at it. Those are different
# claims: "the write command succeeded" does not survive a later function
# replacing the key, the map, or the whole file, and this script deliberately
# runs without `set -e`, so nothing else would notice.
#
# Skipped when /data/homeserver.yaml is absent, on purpose: that path is already
# owned by the WARNING above plus /start.py's own explicit "Config file does not
# exist" error, and stealing it would replace a precise diagnosis with a vaguer
# one. (`/start.py` with no args is run-mode and never rewrites the config —
# verified against v1.159.0's start.py (docker/ unchanged at 1.161.0), which only generates in `generate` /
# `migrate_config` modes — so there is no post-gate write to worry about.)
# -----------------------------------------------------------------------------
if [ -f /data/homeserver.yaml ]; then
  if ! did_field_denylist_on_disk_contains_field; then
    did_field_unprotected_banner "/data/homeserver.yaml does NOT contain '${SIWX_DID_PROFILE_FIELD}' in experimental_features.msc4133_key_denylist at startup — the write never landed, or something later in this entrypoint clobbered it."
    echo "REFUSING TO START: a config write that silently did not happen must not become a running server." >&2
    exit 1
  fi
fi

# Store mode: the same re-read of the FILE as the gate above, for the secret keys.
if [ "$SECRET_STORE" = 1 ]; then
  secret_store_verify_on_disk
fi

# Repeat the warning here so it is the LAST thing in the log before Synapse's own
# (very noisy) startup output, rather than something that scrolled away minutes
# ago. An unprotected DID field is a standing condition, not a startup event.
if [ "${SIWX_DID_FIELD_UNPROTECTED_WARN:-}" = "1" ]; then
  did_field_unprotected_banner "STARTING WITH THE FIELD UNPROTECTED because SIWX_ALLOW_UNPROTECTED_DID_FIELD=1 was set. This Synapse does not carry the MSC4133 write-ACL patch."
fi

# `run` is /start.py's default mode, spelled out so that the flag can follow it:
# /start.py hands everything after `run` to `python -m synapse.app.homeserver`
# (docker/start.py of v1.163.0, main(): args = args[2:]).
if [ "$SECRET_STORE" = 1 ]; then
  /start.py run --no-secrets-in-config
else
  /start.py
fi
