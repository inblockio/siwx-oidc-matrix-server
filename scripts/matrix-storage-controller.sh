#!/usr/bin/env bash
#
# matrix-storage-controller.sh
#
# Closed-loop storage controller for the Matrix stack. It measures utilization of
# the dedicated Matrix volume and drives Synapse media retention along a convex
# "bonding curve": no pruning while the volume is roomy, then increasingly
# aggressive deletion of old media as it fills, guaranteeing the service stays up
# within its bounded volume. Matrix is treated as a stream-communication service,
# not permanent storage.
#
# It collapses four concerns into one feedback loop:
#   guard       - the dedicated volume is the hard cap; this keeps Matrix inside it
#   monitor     - reads volume + root utilization every tick
#   auto-prune  - calls the Synapse Admin API (no restart) to delete old media
#   alert       - pushes a Matrix server-notice on WARN/CRIT state transitions
#
# Because total capacity is read live each tick, expanding the DO volume
# (resize2fs) lowers utilization and the controller relaxes/deactivates on its
# own (stateless on capacity => "add storage = auto-relax" is free). Pruning is
# negative feedback, so the loop self-stabilizes; alerts fire only on level
# transitions, so there is no per-tick spam.
#
# Subcommands:
#   tick            (default) one control cycle: measure -> compute -> prune -> log -> alert
#   status          print live utilization + the currently-computed retention windows
#   notice "<msg>"  send a one-off server-notice to the admin (for testing/manual use)
#
# Synapse is reached through `docker compose exec` using the msc3861 admin_token
# (MAS_SHARED_SECRET) read from the stack .env. Secrets are passed via the
# container environment and are NEVER printed (SEC-0006).
#
# All tunables below are env-overridable, so the timer unit or an operator can
# retune the curve without editing this file.

set -euo pipefail

# ---- tunable parameters -------------------------------------------------------
STACK_DIR="${STACK_DIR:-/home/deploy/matrix/stack}"
VOL_PATH="${VOL_PATH:-/mnt/volume_matrix_service}"   # the bounded Matrix volume
ROOT_PATH="${ROOT_PATH:-/}"                          # host root, alerted on too
STATE_DIR="${STATE_DIRECTORY:-${STATE_DIR:-/var/lib/matrix-storage-controller}}"

WARN_PCT="${WARN_PCT:-80}"      # alert threshold (warning)
CRIT_PCT="${CRIT_PCT:-90}"      # alert threshold (critical)

# Remote media = re-fetchable cache from other homeservers. Free to delete, so
# it activates earlier and tightens harder; emergency purges everything.
REMOTE_ON="${REMOTE_ON:-40}"; REMOTE_FULL="${REMOTE_FULL:-90}"; REMOTE_EMERG="${REMOTE_EMERG:-95}"
REMOTE_LMAX_D="${REMOTE_LMAX_D:-60}"; REMOTE_LMIN_D="${REMOTE_LMIN_D:-1}"

# Local media = users' own uploads. Conservative: activates at 50% with a ~3-month
# window, keeps profile/avatar images, and never deletes below the hard floor.
LOCAL_ON="${LOCAL_ON:-50}"; LOCAL_FULL="${LOCAL_FULL:-90}"; LOCAL_EMERG="${LOCAL_EMERG:-95}"
LOCAL_LMAX_D="${LOCAL_LMAX_D:-90}"; LOCAL_LMIN_D="${LOCAL_LMIN_D:-7}"

CURVE_K="${CURVE_K:-2}"          # convexity exponent (>1 = aggressive near the top)
HARD_FLOOR_D="${HARD_FLOOR_D:-1}" # never delete media younger than this, ever
DRY_RUN="${DRY_RUN:-0}"          # 1 = compute + log, but make no Admin API mutations

# ---- small helpers ------------------------------------------------------------
log() { printf '%s controller: %s\n' "$(date -Is)" "$*"; }

# Read one key from .env without exposing the rest of the file.
env_get() { sed -n "s/^$1=//p" "$STACK_DIR/.env" | head -1 | sed -e 's/^"//' -e 's/"$//'; }

now_ms() { date +%s%3N; }
ts_before_days() { awk -v now="$(now_ms)" -v d="$1" 'BEGIN{ printf "%d", now - (d*86400000) }'; }

# Integer-precision-ish percent used for a mount path.
util_pct() { df -B1 --output=used,size "$1" | awk 'NR==2 {printf "%.2f", ($2>0 ? $1*100.0/$2 : 0)}'; }

level_for() { awk -v u="$1" -v w="$WARN_PCT" -v c="$CRIT_PCT" 'BEGIN{ print (u>=c)?"CRIT":((u>=w)?"WARN":"OK") }'; }

# The control law. Given utilization U and a class profile, print the retention
# window: "INF" (no pruning), "ALL" (emergency purge-everything, remote only), or
# a number of days. Convex: window = Lmax - (Lmax-Lmin)*p^k for p in [0,1].
window_days() {
  local U="$1" ON="$2" FULL="$3" EMERG="$4" LMAX="$5" LMIN="$6" emergencyAll="$7"
  awk -v U="$U" -v ON="$ON" -v FULL="$FULL" -v EMERG="$EMERG" -v LMAX="$LMAX" -v LMIN="$LMIN" \
      -v K="$CURVE_K" -v FLOOR="$HARD_FLOOR_D" -v allEmerg="$emergencyAll" 'BEGIN{
        if (U < ON)        { print "INF"; exit }
        if (U >= EMERG)    { if (allEmerg=="1") { print "ALL"; exit } w=LMIN }
        else if (U >= FULL){ w=LMIN }
        else               { p=(U-ON)/(FULL-ON); w=LMAX-(LMAX-LMIN)*(p^K) }
        if (w < FLOOR) w=FLOOR
        printf "%.2f", w
      }'
}
fmt_window() { case "$1" in INF) echo "INFINITE (no pruning)";; ALL) echo "PURGE ALL (emergency)";; *) echo "$1 days";; esac; }

# ---- Synapse Admin API (token via container env; never printed) ---------------
# Prints "<body>\n__HTTP__<code>"; callers split with body_of / http_of.
synapse_call() {
  local method="$1" path="$2" data="${3:-}"
  docker compose --project-directory "$STACK_DIR" exec -T \
    -e TOK="$ADMIN_TOKEN" -e PORT="$MATRIX_PORT" -e M="$method" -e P="$path" -e D="$data" \
    matrix_synapse sh -c '
      if [ -n "$D" ]; then
        curl -s -w "\n__HTTP__%{http_code}" -X "$M" \
          -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
          -d "$D" "http://localhost:$PORT$P"
      else
        curl -s -w "\n__HTTP__%{http_code}" -X "$M" \
          -H "Authorization: Bearer $TOK" "http://localhost:$PORT$P"
      fi'
}
http_of() { printf '%s' "$1" | sed -n 's/.*__HTTP__//p'; }
body_of() { printf '%s' "$1" | sed 's/__HTTP__[0-9]*$//' | tr -d '\n'; }

prune_remote() {
  local w="$1" ts out code
  if [ "$w" = "INF" ]; then log "remote: below activation (<${REMOTE_ON}%); no prune"; return 0; fi
  if [ "$w" = "ALL" ]; then ts="$(now_ms)"; else ts="$(ts_before_days "$w")"; fi
  if [ "$DRY_RUN" = "1" ]; then log "remote: DRY_RUN purge_media_cache before_ts=$ts window=$(fmt_window "$w")"; return 0; fi
  out="$(synapse_call POST "/_synapse/admin/v1/purge_media_cache?before_ts=$ts")"; code="$(http_of "$out")"
  log "remote: purge window=$(fmt_window "$w") http=$code resp=$(body_of "$out")"
}

prune_local() {
  local w="$1" ts out code
  if [ "$w" = "INF" ]; then log "local: below activation (<${LOCAL_ON}%); no prune"; return 0; fi
  ts="$(ts_before_days "$w")"   # local media is never 'ALL'; floor still applies
  if [ "$DRY_RUN" = "1" ]; then log "local: DRY_RUN media delete before_ts=$ts keep_profiles=true window=$(fmt_window "$w")"; return 0; fi
  out="$(synapse_call POST "/_synapse/admin/v1/media/$MATRIX_HOST/delete?before_ts=$ts&keep_profiles=true")"; code="$(http_of "$out")"
  log "local: delete window=$(fmt_window "$w") keep_profiles=true http=$code resp=$(body_of "$out")"
}

admin_user_id() { printf '@%s:%s' "$(printf '%s' "$1" | tr ':' '-' | tr 'A-Z' 'a-z')" "$2"; }
json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/ /g'; }

send_notice() {
  local body="$1" uid esc payload out code
  if [ -z "${ADMIN_DID:-}" ]; then log "no MATRIX_ADMIN_DID set; skip server-notice: $body"; return 0; fi
  uid="$(admin_user_id "$ADMIN_DID" "$MATRIX_HOST")"
  esc="$(json_escape "$body")"
  payload="{\"user_id\":\"$uid\",\"content\":{\"msgtype\":\"m.text\",\"body\":\"$esc\"}}"
  if [ "$DRY_RUN" = "1" ]; then log "DRY_RUN notice -> $uid: $body"; return 0; fi
  out="$(synapse_call POST "/_synapse/admin/v1/send_server_notice" "$payload")"; code="$(http_of "$out")"
  if [ "$code" = "200" ]; then log "notice -> $uid http=200"; else log "notice -> $uid FAILED http=$code resp=$(body_of "$out")"; fi
}

# ---- alerting on level transitions (no per-tick spam) -------------------------
read_level() { cat "$STATE_DIR/level_$1" 2>/dev/null || echo "OK"; }
write_level() { mkdir -p "$STATE_DIR"; printf '%s' "$2" > "$STATE_DIR/level_$1"; }

alert_transition() {
  local disk="$1" level="$2" u="$3" prev; prev="$(read_level "$disk")"
  if [ "$level" != "$prev" ]; then
    if [ "$level" = "OK" ]; then
      send_notice "[matrix-storage] $disk recovered to OK (${u}% used)."
    else
      send_notice "[matrix-storage] $disk $level: ${u}% used (warn=${WARN_PCT}% crit=${CRIT_PCT}%). Consider expanding the Matrix volume; media pruning is tightening."
    fi
    log "ALERT $disk $prev -> $level (${u}%)"
    write_level "$disk" "$level"
  fi
}

# ---- environment --------------------------------------------------------------
load_env() {
  [ -f "$STACK_DIR/.env" ] || { log "FATAL: $STACK_DIR/.env not found"; exit 1; }
  ADMIN_TOKEN="$(env_get MAS_SHARED_SECRET)"
  MATRIX_HOST="$(env_get MATRIX_HOST)"
  MATRIX_PORT="$(env_get MATRIX_PORT)"; MATRIX_PORT="${MATRIX_PORT:-8080}"
  ADMIN_DID="$(env_get MATRIX_ADMIN_DID)"
  [ -n "$ADMIN_TOKEN" ] || { log "FATAL: MAS_SHARED_SECRET empty in $STACK_DIR/.env"; exit 1; }
}

# ---- subcommands --------------------------------------------------------------
cmd_tick() {
  load_env
  local volU rootU volLevel rootLevel rW lW
  volU="$(util_pct "$VOL_PATH")"; rootU="$(util_pct "$ROOT_PATH")"
  volLevel="$(level_for "$volU")"; rootLevel="$(level_for "$rootU")"
  rW="$(window_days "$volU" "$REMOTE_ON" "$REMOTE_FULL" "$REMOTE_EMERG" "$REMOTE_LMAX_D" "$REMOTE_LMIN_D" 1)"
  lW="$(window_days "$volU" "$LOCAL_ON"  "$LOCAL_FULL"  "$LOCAL_EMERG"  "$LOCAL_LMAX_D"  "$LOCAL_LMIN_D"  0)"
  log "tick vol=${volU}%($volLevel) root=${rootU}%($rootLevel) remote_window=$rW local_window=$lW dry=$DRY_RUN"
  prune_remote "$rW"
  prune_local  "$lW"
  alert_transition vol  "$volLevel"  "$volU"
  alert_transition root "$rootLevel" "$rootU"
}

cmd_status() {
  load_env
  local volU rootU rW lW
  volU="$(util_pct "$VOL_PATH")"; rootU="$(util_pct "$ROOT_PATH")"
  rW="$(window_days "$volU" "$REMOTE_ON" "$REMOTE_FULL" "$REMOTE_EMERG" "$REMOTE_LMAX_D" "$REMOTE_LMIN_D" 1)"
  lW="$(window_days "$volU" "$LOCAL_ON"  "$LOCAL_FULL"  "$LOCAL_EMERG"  "$LOCAL_LMAX_D"  "$LOCAL_LMIN_D"  0)"
  cat <<EOF
matrix-storage-controller status
  volume $VOL_PATH : ${volU}% used (level $(level_for "$volU"))
  root   $ROOT_PATH : ${rootU}% used (level $(level_for "$rootU"))
  thresholds        : warn=${WARN_PCT}% crit=${CRIT_PCT}%
  remote media      : $(fmt_window "$rW")   [activate >=${REMOTE_ON}%, full ${REMOTE_FULL}%, emerg ${REMOTE_EMERG}%, floor ${HARD_FLOOR_D}d]
  local  media      : $(fmt_window "$lW")   [activate >=${LOCAL_ON}%, full ${LOCAL_FULL}%, emerg ${LOCAL_EMERG}%, keep_profiles, floor ${HARD_FLOOR_D}d]
EOF
}

case "${1:-tick}" in
  tick|once) cmd_tick ;;
  status)    cmd_status ;;
  notice)    shift; load_env; send_notice "${*:-matrix-storage controller test notice}" ;;
  *) echo "usage: $0 {tick|status|notice <msg>}" >&2; exit 2 ;;
esac
