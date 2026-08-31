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
# -----------------------------------------------------------------------------
# AUTHENTICATION (rewritten 2026-08-30 for Synapse 1.159 — plan H5)
# -----------------------------------------------------------------------------
# Synapse 1.157.0 REMOVED the msc3861 `admin_token` mechanism. Before that, this
# script bearer'd MAS_SHARED_SECRET straight at /_synapse/admin/v1/*. On 1.157+
# every one of those calls returns 401 M_UNKNOWN_TOKEN.
#
# The three admin routes this script needs have NO /_synapse/mas/* equivalent:
#   /_synapse/admin/v1/purge_media_cache
#   /_synapse/admin/v1/media/{host}/delete
#   /_synapse/admin/v1/send_server_notice
# so they can only be reached with a real admin-scoped access token. siwx-oidc
# mints one on demand at POST /oauth2/admin_token, authenticated by the MAS
# shared secret, returning a SHORT-TTL token carrying `urn:synapse:admin:*`.
#
# Tokens are minted per run and re-minted mid-run as they near expiry. They are
# NEVER cached to disk and the TTL is never widened to cover a long run.
#
# -----------------------------------------------------------------------------
# FAIL-LOUD CONTRACT (the reason this rewrite exists)
# -----------------------------------------------------------------------------
# This is the one script in the stack that used to fail SILENTLY: `curl -s`
# without --fail exits 0 on a 401, the HTTP status was logged but never
# inspected, and the process exited 0. An hourly systemd oneshot would go on
# "succeeding" while media retention did nothing and the bounded volume filled.
# That is the worst failure mode available here, so it is now structurally
# impossible to hit quietly:
#
#   1. EVERY admin call's HTTP status is inspected. Non-2xx is an error, never
#      just a log line.
#   2. Any auth failure (401/403) or transport failure aborts the tick with a
#      distinct NON-ZERO exit code, so systemd marks the unit failed.
#   3. Fatal lines go to stderr with a `<3>` (LOG_ERR) syslog prefix, so
#      `journalctl -p err -u matrix-storage-controller` shows them and any log
#      shipper escalates them.
#   4. A failure leaves a marker in STATE_DIR. The next tick that recovers sends
#      a server notice announcing how long the controller had been broken. This
#      is how the outage reaches a human over Matrix WITHOUT depending on the
#      very auth that was failing (a notice cannot be sent while auth is down).
#   5. A WARN/CRIT level transition is only committed to STATE_DIR once its
#      notice was actually accepted. A failed alert is retried next tick instead
#      of being lost forever.
#
# Exit codes: 0 ok | 1 config fatal | 2 usage | 3 mint failure
#             4 admin-API auth failure | 5 admin-API/transport failure
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

# MATRIX_ADMIN_DID unset means alerting can NEVER work. By default that is a
# loud, tick-failing condition, because a storage controller whose alerts go
# nowhere is half-broken and used to hide it. Set ALERTS_OPTIONAL=1 to run
# retention deliberately without alerting: the condition is then a once-per-tick
# WARN instead of a failure. It is never silent either way.
#
# NOTE: alerting problems NEVER block pruning. Every tick runs both prunes
# before it touches alerting, so a misconfigured alert channel cannot stop the
# thing that actually protects the volume.
ALERTS_OPTIONAL="${ALERTS_OPTIONAL:-0}"

# Set to 1 only when media deliberately lives on the root disk (the documented
# rollback config). Otherwise VOL_PATH resolving to the root filesystem means
# the dedicated volume failed to mount, which must never look healthy.
ALLOW_VOL_ON_ROOT="${ALLOW_VOL_ON_ROOT:-0}"

# Compose service names + the in-network siwx-oidc address used for minting.
SYNAPSE_SERVICE="${SYNAPSE_SERVICE:-matrix_synapse}"
OIDC_SERVICE="${OIDC_SERVICE:-siwx-oidc}"
# Re-mint when the current token has less than this many seconds left. The mint
# clamps TTL to 30-900s, so a long purge is covered by RE-MINTING, never by
# asking for a wider TTL.
TOKEN_RENEW_MARGIN="${TOKEN_RENEW_MARGIN:-60}"

# Without these, a backend that accepts the TCP connection and then never
# answers (half-open socket, DROP rule) blocks curl — and therefore the whole
# tick — forever: no fatal line, no failure marker, no exit code at all, and the
# next hourly tick may never start. That is strictly worse than any failure this
# script can report, so every curl is bounded.
# MINT_MAX_TIME is short (the mint is a local, trivial call). ADMIN_MAX_TIME is
# generous because purge_media_cache is synchronous and can legitimately run for
# minutes on a large media store.
HTTP_CONNECT_TIMEOUT="${HTTP_CONNECT_TIMEOUT:-10}"
MINT_MAX_TIME="${MINT_MAX_TIME:-30}"
ADMIN_MAX_TIME="${ADMIN_MAX_TIME:-900}"

# ---- small helpers ------------------------------------------------------------
log() { printf '%s controller: %s\n' "$(date -Is)" "$*"; }

# Under systemd, a leading "<N>" on a log line sets the journal priority
# (SyslogLevelPrefix defaults to yes). Outside systemd it would just be noise,
# so it is only emitted when running as a unit.
sev() { if [ -n "${INVOCATION_ID:-}" ]; then printf '<%s>' "$1"; fi; }
log_err()   { printf '%s%s controller: ERROR %s\n' "$(sev 3)" "$(date -Is)" "$*" >&2; }
log_fatal() { printf '%s%s controller: !!! FATAL !!! %s\n' "$(sev 2)" "$(date -Is)" "$*" >&2; }
# Emitted only where retention really is dead, so the line keeps its meaning.
log_unprotected() {
  printf '%s%s controller: media retention is NOT running; the bounded Matrix volume is UNPROTECTED\n' \
    "$(sev 2)" "$(date -Is)" >&2
}

# Read one key from .env without exposing the rest of the file.
env_get() { sed -n "s/^$1=//p" "$STACK_DIR/.env" | head -1 | sed -e 's/^"//' -e 's/"$//'; }

now_ms() { date +%s%3N; }
now_s() { date +%s; }
ts_before_days() { awk -v now="$(now_ms)" -v d="$1" 'BEGIN{ printf "%d", now - (d*86400000) }'; }

# Integer-precision-ish percent used for a mount path.
util_pct() { df -B1 --output=used,size "$1" | awk 'NR==2 {printf "%.2f", ($2>0 ? $1*100.0/$2 : 0)}'; }

path_readable() { df -B1 --output=used,size "$1" >/dev/null 2>&1; }
fs_device() { df --output=source "$1" 2>/dev/null | awk 'NR==2 {print $1}'; }

# An unmounted bounded volume is the same defect family as a silent 401: without
# this guard `set -e` aborted on df's failure with a bare `exit 1`, no controller
# log line and no failure marker — the operator would see a failed unit with no
# statement of what broke. Worse, a df that succeeded but returned nothing would
# make util 0, which reads as "roomy" and disables pruning entirely.
require_measurable_paths() {
  local p
  for p in "$VOL_PATH" "$ROOT_PATH"; do
    if ! path_readable "$p"; then
      log_fatal "cannot measure utilisation of '$p' — is the bounded Matrix volume mounted?"
      log_unprotected
      record_failure "path $p unavailable"
      exit 1
    fi
  done

  # The nastier variant, and the one df will NOT report as an error: the volume
  # failed to mount but its mountpoint directory still exists, so df happily
  # measures the ROOT filesystem instead. Utilisation then looks like the root
  # disk, the curve reads "roomy", nothing is pruned, and the tick exits 0 —
  # while the 100 GB volume this controller exists to guard is unmeasured.
  # Detect it by device identity rather than by df's exit status.
  if [ "$VOL_PATH" != "$ROOT_PATH" ] && [ "$ALLOW_VOL_ON_ROOT" != "1" ]; then
    local vdev rdev; vdev="$(fs_device "$VOL_PATH")"; rdev="$(fs_device "$ROOT_PATH")"
    if [ -n "$vdev" ] && [ "$vdev" = "$rdev" ]; then
      log_fatal "'$VOL_PATH' is NOT a separate mount — it resolves to the root filesystem ($vdev)"
      log_fatal "the bounded Matrix volume is not mounted; utilisation would be measured against the wrong disk"
      log_fatal "set ALLOW_VOL_ON_ROOT=1 if this deployment deliberately keeps media on the root disk"
      log_unprotected
      record_failure "bounded volume $VOL_PATH not mounted (same device as $ROOT_PATH)"
      exit 1
    fi
  fi
}

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

# ---- failure bookkeeping ------------------------------------------------------
# A tick that fails leaves this marker behind. The next tick that gets working
# auth back announces the gap over the server-notice channel and clears it, so a
# silent outage is reported even though the outage itself made alerting
# impossible.
FAIL_MARKER() { printf '%s/failure' "$STATE_DIR"; }

record_failure() {
  local reason="$1" first count
  mkdir -p "$STATE_DIR"
  if [ -f "$(FAIL_MARKER)" ]; then
    first="$(sed -n 's/^first_ts=//p' "$(FAIL_MARKER)" | head -1)"
    count="$(sed -n 's/^count=//p' "$(FAIL_MARKER)" | head -1)"
  fi
  first="${first:-$(now_s)}"
  count="$(( ${count:-0} + 1 ))"
  { printf 'first_ts=%s\n' "$first"
    printf 'count=%s\n' "$count"
    printf 'last_ts=%s\n' "$(now_s)"
    printf 'last_reason=%s\n' "$reason"
  } > "$(FAIL_MARKER)"
  log_err "consecutive failure #$count (first at $(date -Is -d "@$first")): $reason"
}

# Announce a recovered outage over the notice channel, then clear the marker.
# Runs only on a tick where auth demonstrably works again.
announce_recovery() {
  [ -f "$(FAIL_MARKER)" ] || return 0
  local first count last_reason mins
  first="$(sed -n 's/^first_ts=//p' "$(FAIL_MARKER)" | head -1)"
  count="$(sed -n 's/^count=//p' "$(FAIL_MARKER)" | head -1)"
  last_reason="$(sed -n 's/^last_reason=//p' "$(FAIL_MARKER)" | head -1)"
  mins="$(awk -v a="$(now_s)" -v b="${first:-0}" 'BEGIN{ printf "%d", (a-b)/60 }')"
  log "recovered after ${count:-?} failed tick(s) over ~${mins}m; announcing"
  if send_notice "[matrix-storage] RECOVERED: the storage controller had been FAILING for ~${mins}m (${count:-?} ticks). Media retention was not running during that window. Last error: ${last_reason:-unknown}"; then
    rm -f "$(FAIL_MARKER)"
  else
    log_err "recovery notice could not be delivered; keeping failure marker for the next tick"
    return 1
  fi
}

# ---- admin token (minted on demand; never cached to disk) ---------------------
ADMIN_TOKEN=""
TOKEN_EXPIRES_AT=0

# Run a shell snippet inside the Synapse container. The Synapse container is
# used as the HTTP client for BOTH Synapse and the siwx-oidc mint because it is
# already on the compose network (siwx-oidc resolves there) and already has
# curl; this keeps the whole auth path inside the stack with no host-side
# network dependency and no new exposed port.
#
# Secrets are fed on STDIN, not via `-e VAR=value`, because the latter puts them
# in the docker argv where any local user can read them out of `ps`.
in_synapse() {
  local script="$1"; shift
  docker compose --project-directory "$STACK_DIR" exec -T "$@" "$SYNAPSE_SERVICE" sh -c "$script"
}

http_of() { printf '%s' "$1" | sed -n 's/.*__HTTP__//p'; }
body_of() { printf '%s' "$1" | sed 's/__HTTP__[0-9]*$//' | tr -d '\n'; }
is_2xx()  { case "$1" in 2??) return 0;; *) return 1;; esac; }

# Mint a fresh short-TTL admin-scoped token from siwx-oidc. Fatal on failure:
# with no token there is no retention at all, and that must never be quiet.
mint_admin_token() {
  local out rc code body tok ttl
  # stderr is deliberately NOT swallowed: command substitution captures stdout
  # only, so docker/compose diagnostics reach the journal instead of vanishing.
  set +e
  out="$(printf '%s\n' "$MAS_SECRET" | in_synapse '
      read -r SEC
      curl -s -w "\n__HTTP__%{http_code}" -X POST \
        --connect-timeout "$CT" --max-time "$MT" \
        -H "Authorization: Bearer $SEC" \
        "$OIDC_URL/oauth2/admin_token"
    ' -e OIDC_URL="$OIDC_INTERNAL_URL" -e CT="$HTTP_CONNECT_TIMEOUT" -e MT="$MINT_MAX_TIME")"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ] && ! printf '%s' "$out" | grep -q '__HTTP__'; then
    log_fatal "could not reach the admin-token mint at $OIDC_INTERNAL_URL via compose service '$SYNAPSE_SERVICE' (docker exec rc=$rc)"
    log_unprotected
    record_failure "mint transport failure (rc=$rc)"
    exit 3
  fi
  code="$(http_of "$out")"; body="$(body_of "$out")"
  if [ "$code" = "000" ]; then
    # curl ran but never got an HTTP response: wrong address, siwx-oidc down, or
    # the two services are no longer on a shared compose network.
    log_fatal "admin-token mint at $OIDC_INTERNAL_URL is UNREACHABLE from compose service '$SYNAPSE_SERVICE' (no HTTP response)"
    log_fatal "check that siwx-oidc is running and shares a network with $SYNAPSE_SERVICE"
    log_unprotected
    record_failure "mint unreachable ($OIDC_INTERNAL_URL)"
    exit 3
  fi
  if ! is_2xx "$code"; then
    log_fatal "admin-token mint REFUSED: http=$code resp=$body"
    log_fatal "check that MAS_SHARED_SECRET in $STACK_DIR/.env matches siwx-oidc's SIWEOIDC_MAS_SHARED_SECRET"
    log_unprotected
    record_failure "mint http=$code"
    exit 3
  fi
  tok="$(printf '%s' "$body" | sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  ttl="$(printf '%s' "$body" | sed -n 's/.*"expires_in"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p')"
  if [ -z "$tok" ]; then
    log_fatal "admin-token mint returned http=$code but no access_token could be parsed"
    log_unprotected
    record_failure "mint returned no access_token"
    exit 3
  fi
  ADMIN_TOKEN="$tok"
  TOKEN_EXPIRES_AT="$(( $(now_s) + ${ttl:-300} ))"
  log "minted admin token (ttl=${ttl:-300}s, expires $(date -Is -d "@$TOKEN_EXPIRES_AT"))"
}

# Mint lazily, and re-mint rather than widening the TTL if a long run is about
# to outlive the current token.
ensure_admin_token() {
  if [ -z "$ADMIN_TOKEN" ] || [ "$(now_s)" -ge "$(( TOKEN_EXPIRES_AT - TOKEN_RENEW_MARGIN ))" ]; then
    mint_admin_token
  fi
}

# ---- Synapse Admin API (token via stdin; never printed, never in argv) --------
# Prints "<body>\n__HTTP__<code>"; callers split with body_of / http_of.
# __HTTP__000 means the request never got an HTTP response at all.
#
# NOTE: callers MUST call ensure_admin_token themselves, before the command
# substitution that captures this function. Minting from in here would run
# inside that subshell, where the "minted admin token" log line would be
# captured into the response body and the token itself would not survive.
synapse_call() {
  local method="$1" path="$2" data="${3:-}" out rc
  set +e
  out="$(printf '%s\n' "$ADMIN_TOKEN" | in_synapse '
      read -r TOK
      if [ -n "$D" ]; then
        curl -s -w "\n__HTTP__%{http_code}" -X "$M" \
          --connect-timeout "$CT" --max-time "$MT" \
          -H "Authorization: Bearer $TOK" -H "Content-Type: application/json" \
          -d "$D" "http://localhost:$PORT$P"
      else
        curl -s -w "\n__HTTP__%{http_code}" -X "$M" \
          --connect-timeout "$CT" --max-time "$MT" \
          -H "Authorization: Bearer $TOK" "http://localhost:$PORT$P"
      fi
    ' -e PORT="$MATRIX_PORT" -e M="$method" -e P="$path" -e D="$data" \
      -e CT="$HTTP_CONNECT_TIMEOUT" -e MT="$ADMIN_MAX_TIME")"
  rc=$?
  set -e
  if ! printf '%s' "$out" | grep -q '__HTTP__'; then
    printf 'no HTTP response (docker exec rc=%s)\n__HTTP__000' "$rc"
    return 0
  fi
  printf '%s' "$out"
}

# Central status gate. THIS is what makes a broken retention loop impossible to
# miss: no admin call anywhere in this script may bypass it.
#   401/403 -> auth is broken; nothing else this tick can work. Abort hard.
#   000     -> the call never reached Synapse. Abort hard.
#   other non-2xx -> record and let the caller decide, but the run still fails.
require_http_ok() {
  local code="$1" what="$2" body="$3"
  if is_2xx "$code"; then return 0; fi
  case "$code" in
    401|403)
      log_fatal "$what was REJECTED by Synapse: http=$code resp=$body"
      log_fatal "the minted admin token was not accepted — media retention is DEAD until this is fixed"
      log_unprotected
      record_failure "$what auth failure http=$code"
      exit 4
      ;;
    000)
      log_fatal "$what never reached Synapse: $body"
      log_unprotected
      record_failure "$what transport failure"
      exit 5
      ;;
    *)
      log_err "$what FAILED: http=$code resp=$body"
      return 1
      ;;
  esac
}

prune_remote() {
  local w="$1" ts out code body
  if [ "$w" = "INF" ]; then log "remote: below activation (<${REMOTE_ON}%); no prune"; return 0; fi
  if [ "$w" = "ALL" ]; then ts="$(now_ms)"; else ts="$(ts_before_days "$w")"; fi
  if [ "$DRY_RUN" = "1" ]; then log "remote: DRY_RUN purge_media_cache before_ts=$ts window=$(fmt_window "$w")"; return 0; fi
  ensure_admin_token
  out="$(synapse_call POST "/_synapse/admin/v1/purge_media_cache?before_ts=$ts")"
  code="$(http_of "$out")"; body="$(body_of "$out")"
  require_http_ok "$code" "remote purge_media_cache" "$body" || return 1
  log "remote: purge window=$(fmt_window "$w") http=$code resp=$body"
}

prune_local() {
  local w="$1" ts out code body
  if [ "$w" = "INF" ]; then log "local: below activation (<${LOCAL_ON}%); no prune"; return 0; fi
  ts="$(ts_before_days "$w")"   # local media is never 'ALL'; floor still applies
  if [ "$DRY_RUN" = "1" ]; then log "local: DRY_RUN media delete before_ts=$ts keep_profiles=true window=$(fmt_window "$w")"; return 0; fi
  ensure_admin_token
  out="$(synapse_call POST "/_synapse/admin/v1/media/$MATRIX_HOST/delete?before_ts=$ts&keep_profiles=true")"
  code="$(http_of "$out")"; body="$(body_of "$out")"
  require_http_ok "$code" "local media delete" "$body" || return 1
  log "local: delete window=$(fmt_window "$w") keep_profiles=true http=$code resp=$body"
}

admin_user_id() { printf '@%s:%s' "$(printf '%s' "$1" | tr ':' '-' | tr 'A-Z' 'a-z')" "$2"; }
# Backslashes first, then quotes, so the round-trip is correct. Raw newlines /
# CR / tabs are illegal inside a JSON string (RFC 8259) and would be rejected by
# Synapse, so they are folded to spaces BEFORE escaping.
json_escape() { printf '%s' "$1" | tr '\n\r\t' '   ' | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

# Returns non-zero when the notice was NOT accepted, so callers can retry rather
# than silently dropping an alert.
send_notice() {
  local body="$1" uid esc payload out code resp
  if [ -z "${ADMIN_DID:-}" ]; then
    if [ "$ALERTS_OPTIONAL" = "1" ]; then
      log "MATRIX_ADMIN_DID unset and ALERTS_OPTIONAL=1 — alerting is deliberately off; dropping: $body"
      return 0
    fi
    log_err "MATRIX_ADMIN_DID is not set in $STACK_DIR/.env — server-notice alerting is DISABLED; dropping: $body"
    log_err "set MATRIX_ADMIN_DID, or set ALERTS_OPTIONAL=1 to run retention without alerting on purpose"
    return 1
  fi
  uid="$(json_escape "$(admin_user_id "$ADMIN_DID" "$MATRIX_HOST")")"
  esc="$(json_escape "$body")"
  payload="{\"user_id\":\"$uid\",\"content\":{\"msgtype\":\"m.text\",\"body\":\"$esc\"}}"
  if [ "$DRY_RUN" = "1" ]; then log "DRY_RUN notice -> $uid: $body"; return 0; fi
  ensure_admin_token
  out="$(synapse_call POST "/_synapse/admin/v1/send_server_notice" "$payload")"
  code="$(http_of "$out")"; resp="$(body_of "$out")"
  require_http_ok "$code" "send_server_notice" "$resp" || return 1
  log "notice -> $uid http=$code"
}

# ---- alerting on level transitions (no per-tick spam) -------------------------
read_level() { cat "$STATE_DIR/level_$1" 2>/dev/null || echo "OK"; }
write_level() { mkdir -p "$STATE_DIR"; printf '%s' "$2" > "$STATE_DIR/level_$1"; }

alert_transition() {
  local disk="$1" level="$2" u="$3" prev msg; prev="$(read_level "$disk")"
  if [ "$level" != "$prev" ]; then
    if [ "$level" = "OK" ]; then
      msg="[matrix-storage] $disk recovered to OK (${u}% used)."
    else
      msg="[matrix-storage] $disk $level: ${u}% used (warn=${WARN_PCT}% crit=${CRIT_PCT}%). Consider expanding the Matrix volume; media pruning is tightening."
    fi
    # The level is only committed once the alert was actually accepted.
    # Committing first (the old behaviour) meant a failed notice permanently
    # lost that WARN/CRIT — the transition never repeats.
    if send_notice "$msg"; then
      log "ALERT $disk $prev -> $level (${u}%)"
      write_level "$disk" "$level"
    else
      log_err "ALERT $disk $prev -> $level (${u}%) COULD NOT BE DELIVERED; not committing the level so it retries next tick"
      return 1
    fi
  fi
}

# ---- environment --------------------------------------------------------------
load_env() {
  [ -f "$STACK_DIR/.env" ] || { log_fatal "$STACK_DIR/.env not found"; log_unprotected; exit 1; }
  MAS_SECRET="$(env_get MAS_SHARED_SECRET)"
  MATRIX_HOST="$(env_get MATRIX_HOST)"
  MATRIX_PORT="$(env_get MATRIX_PORT)"; MATRIX_PORT="${MATRIX_PORT:-8080}"
  ADMIN_DID="$(env_get MATRIX_ADMIN_DID)"
  local oidc_port; oidc_port="$(env_get SIWEOIDC_PORT)"
  OIDC_INTERNAL_URL="${OIDC_INTERNAL_URL:-http://${OIDC_SERVICE}:${oidc_port:-8081}}"
  [ -n "$MAS_SECRET" ] || { log_fatal "MAS_SHARED_SECRET empty in $STACK_DIR/.env"; log_unprotected; exit 1; }
  # MATRIX_HOST builds both the local-media admin path and the notice mxid. Empty
  # yields ".../media//delete" and "@did-...:", which Synapse rejects with a
  # confusing 400/404 instead of naming the real problem. Fail on the config.
  [ -n "$MATRIX_HOST" ] || { log_fatal "MATRIX_HOST empty in $STACK_DIR/.env"; log_unprotected; exit 1; }
}

# ---- subcommands --------------------------------------------------------------
cmd_tick() {
  load_env
  require_measurable_paths
  local volU rootU volLevel rootLevel rW lW failed=0
  volU="$(util_pct "$VOL_PATH")"; rootU="$(util_pct "$ROOT_PATH")"
  volLevel="$(level_for "$volU")"; rootLevel="$(level_for "$rootU")"
  rW="$(window_days "$volU" "$REMOTE_ON" "$REMOTE_FULL" "$REMOTE_EMERG" "$REMOTE_LMAX_D" "$REMOTE_LMIN_D" 1)"
  lW="$(window_days "$volU" "$LOCAL_ON"  "$LOCAL_FULL"  "$LOCAL_EMERG"  "$LOCAL_LMAX_D"  "$LOCAL_LMIN_D"  0)"
  log "tick vol=${volU}%($volLevel) root=${rootU}%($rootLevel) remote_window=$rW local_window=$lW dry=$DRY_RUN"
  # DRY_RUN is a legitimate mode, but a DRY_RUN accidentally left set in the unit
  # environment is indistinguishable from a healthy tick if it only whispers.
  # State plainly, at error priority, that no retention happened.
  if [ "$DRY_RUN" = "1" ]; then
    log_err "DRY_RUN=1 — NO media is being deleted and NO alerts are being sent this tick"
  fi

  # Mint up front even on a tick that will not prune (both windows INF, or
  # DRY_RUN). Auth is then verified EVERY hour rather than only once the volume
  # crosses an activation threshold — otherwise a broken token would lie dormant
  # and first surface at the exact moment the volume needed pruning.
  ensure_admin_token

  # Pruning happens FIRST and unconditionally: a broken alert channel must never
  # be able to stop the thing that actually protects the volume.
  local prune_failed=0
  prune_remote "$rW" || { failed=1; prune_failed=1; }
  prune_local  "$lW" || { failed=1; prune_failed=1; }
  alert_transition vol  "$volLevel"  "$volU"  || failed=1
  alert_transition root "$rootLevel" "$rootU" || failed=1

  if [ "$failed" -ne 0 ]; then
    if [ "$prune_failed" -ne 0 ]; then
      log_fatal "tick completed with errors; media retention did NOT run cleanly"
      log_unprotected
    else
      # Prunes succeeded; only alerting failed. Say exactly that — claiming the
      # volume is unprotected here would cry wolf and devalue the real message.
      log_fatal "tick completed with errors: pruning SUCCEEDED but alerting FAILED (see ERROR lines above)"
    fi
    record_failure "tick completed with errors"
    exit 5
  fi

  mkdir -p "$STATE_DIR"; printf '%s' "$(now_s)" > "$STATE_DIR/last_success"
  # A failed recovery ANNOUNCEMENT is itself a reportable failure. Without this
  # the tick logged the error and still said "tick ok" / exited 0 — which is the
  # very shape of bug this rewrite exists to remove. Reachable in practice when
  # `server_notices` is not configured in homeserver.yaml: send_server_notice
  # then returns 400, which is require_http_ok's generic branch, not its 401.
  if ! announce_recovery; then
    log_fatal "retention ran, but the RECOVERY ANNOUNCEMENT could not be delivered"
    log_fatal "the failure marker is kept, so the announcement retries next tick"
    exit 5
  fi
  log "tick ok"
}

cmd_status() {
  load_env
  local volU rootU rW lW
  for p in "$VOL_PATH" "$ROOT_PATH"; do
    path_readable "$p" || { log_fatal "cannot measure utilisation of '$p' — is it mounted?"; exit 1; }
  done
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
  if [ -f "$STATE_DIR/last_success" ]; then
    echo "  last successful tick : $(date -Is -d "@$(cat "$STATE_DIR/last_success")")"
  else
    echo "  last successful tick : NEVER (no successful tick recorded)"
  fi
  if [ -f "$(FAIL_MARKER)" ]; then
    echo "  !! CURRENTLY FAILING !!"
    sed 's/^/    /' "$(FAIL_MARKER)"
  fi
}

cmd_notice() {
  load_env
  if send_notice "$*"; then
    log "notice sent"
  else
    log_fatal "one-off notice could NOT be delivered"
    exit 5
  fi
}

case "${1:-tick}" in
  tick|once) cmd_tick ;;
  status)    cmd_status ;;
  notice)    shift; cmd_notice "${*:-matrix-storage controller test notice}" ;;
  *) echo "usage: $0 {tick|status|notice <msg>}" >&2; exit 2 ;;
esac
