#!/usr/bin/env bash
# =============================================================================
# run.sh — single unified E2E orchestrator for the hermetic LOCAL stack.
#
# Drives the per-surface suite ADAPTERS (adapters/*.sh) against the live
# siwx-e2eh-* stack in two tiers:
#
#   smoke  ONE check per surface (plus the now-green, fast RTC JWT path), ALL
#            confirmed-green. MUST exit 0.
#            connector e2ee_bidirectional_messaging
#            connector rtc_jwt_handshake   (local lk-jwt path via fed-proxy)
#            av-check
#            device-code  (device_code_grant_end_to_end)
#            siwx-oidc    e2e_msc3861::full_lifecycle
#
#   full   every wired check, INCLUDING the known-flagged one. A flagged
#            failure is reported (status known-flagged) but does NOT fail the
#            run. run.sh exits 0 iff every EXPECTED-GREEN check passes; it
#            prints "N known-flagged pending remediation" and lists them. The
#            sole known-flagged entry is
#            siwx-oidc.msc3861.msc4191_metadata_advertised_and_forwarded
#            (Synapse 1.154 re-export limitation, documented).
#
# Lifecycle:
#   * Ensures the stack is healthy (calls up.sh if it is not), then polls for
#     health (no fixed sleeps).
#   * Writes artifacts under e2e-harness/artifacts/<run-id>/: per-suite stdout +
#     exit code, `podman logs` for each siwx-e2eh-* on ANY failure, and a
#     summary.json manifest (each check -> status in {pass,fail,known-flagged}).
#   * EXIT trap tears the stack down via down.sh UNLESS KEEP_STACK=1.
#     KEEP_STACK defaults to 1 (leave stack up). CI sets KEEP_STACK=0.
#
# Usage:
#   e2e-harness/run.sh smoke
#   e2e-harness/run.sh full
#   e2e-harness/run.sh smoke --list      # print tier composition and exit
#   e2e-harness/run.sh --list full       # (flag position-independent)
#
# Exit code: 0 iff all expected-green checks passed; non-zero otherwise.
# =============================================================================
set -uo pipefail

# -----------------------------------------------------------------------------
# Paths & config
# -----------------------------------------------------------------------------
HARNESS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HARNESS_DIR/.." && pwd)"
ADAPTERS="$HARNESS_DIR/adapters"
AV_CHECK="$HARNESS_DIR/av-check/run.sh"
UP="$HARNESS_DIR/up.sh"
DOWN="$HARNESS_DIR/down.sh"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/.env.e2e}"

OIDC_HEALTH_URL="${OIDC_HEALTH_URL:-http://localhost:18081/health}"
EDGE_HEALTH_URL="${EDGE_HEALTH_URL:-http://localhost:18080/_matrix/client/versions}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"   # seconds to wait for health

KEEP_STACK="${KEEP_STACK:-1}"             # 1 = leave stack up (default); 0 = teardown (CI)

E2EH_CONTAINERS=(siwx-e2eh-redis siwx-e2eh-oidc siwx-e2eh-synapse siwx-e2eh-livekit siwx-e2eh-lk-jwt siwx-e2eh-caddy)

log() { printf '%s\n' "$*" >&2; }

# -----------------------------------------------------------------------------
# Tier composition.
#
# Each check is "id|surface|kind|args...". `kind` selects how it is run:
#   connector  -> adapters/connector.sh <artifact> <test_name>
#   oidc       -> adapters/siwx-oidc-realstack.sh <artifact> <target> [fn]
#   devicecode -> adapters/device-code.sh <artifact> [fn]
#   av         -> av-check/run.sh
# A check id beginning with "FLAG:" is KNOWN-FLAGGED (expected-fail pending
# remediation); its failure is tolerated in the full tier.
# -----------------------------------------------------------------------------

# smoke: one per surface, all confirmed green. rtc_jwt_handshake is included
# because it is now green (it validates the lk-jwt JWT path end-to-end against the
# local stack via the fed-proxy) and is fast — a cheap convergence reconfirm of the
# RTC path.
SMOKE_CHECKS=(
  "connector.e2ee_bidirectional_messaging|connector|connector|e2ee_bidirectional_messaging"
  "connector.rtc_jwt_handshake|connector|connector|rtc_jwt_handshake"
  "av-check|av|av"
  "device-code.grant_end_to_end|device-code|devicecode|device_code_grant_end_to_end"
  "siwx-oidc.msc3861.full_lifecycle|siwx-oidc|oidc|e2e_msc3861|full_lifecycle"
)

# full: every wired check. FLAG: prefix marks known-flagged (tolerated failures).
#
# As of the post-remediation finalization, the ONLY known-flagged entry is
# siwx-oidc.msc3861.msc4191_metadata_advertised_and_forwarded (Synapse 1.154
# re-export limitation, documented). The two connector RTC tests
# (rtc_jwt_handshake, rtc_room_alias_matches_element_call) went green via the
# feat/e2e-local-rtc-pointing branch (lk_jwt_endpoint() parameterization) + the
# siwx-e2eh-fed-proxy sidecar; the two msc4191_live tests + session_teardown went
# green via the R2 test updates. All five are now expected-green.
FULL_CHECKS=(
  # ---- connector (green) ----
  "connector.e2ee_bidirectional_messaging|connector|connector|e2ee_bidirectional_messaging"
  "connector.e2ee_media_exchange|connector|connector|e2ee_media_exchange"
  "connector.rtc_member_advertise|connector|connector|rtc_member_advertise"
  # ---- connector RTC (now green: local lk-jwt path via fed-proxy + endpoint param) ----
  "connector.rtc_jwt_handshake|connector|connector|rtc_jwt_handshake"
  "connector.rtc_room_alias_matches_element_call|connector|connector|rtc_room_alias_matches_element_call"
  # ---- av-check (green) ----
  "av-check|av|av"
  # ---- device-code (green) ----
  "device-code.grant_end_to_end|device-code|devicecode|device_code_grant_end_to_end"
  # ---- siwx-oidc msc3861 (green: 3 of 4) ----
  "siwx-oidc.msc3861.full_lifecycle|siwx-oidc|oidc|e2e_msc3861|full_lifecycle"
  "siwx-oidc.msc3861.refresh_token_flow|siwx-oidc|oidc|e2e_msc3861|refresh_token_flow"
  "siwx-oidc.msc3861.returning_user_new_device|siwx-oidc|oidc|e2e_msc3861|returning_user_new_device"
  # ---- siwx-oidc msc4191 live + session teardown (now green: R2 test updates) ----
  "siwx-oidc.msc4191_live.device_management_live|siwx-oidc|oidc|e2e_msc4191_live|msc4191_device_management_live"
  "siwx-oidc.msc4191_live.cross_signing_reset_round_trip_live|siwx-oidc|oidc|e2e_msc4191_live|cross_signing_reset_round_trip_live"
  "siwx-oidc.session_teardown|siwx-oidc|oidc|e2e_session_teardown"
  # ---- siwx-oidc (known-flagged: Synapse 1.154 re-export limitation, documented) ----
  "FLAG:siwx-oidc.msc3861.msc4191_metadata_advertised_and_forwarded|siwx-oidc|oidc|e2e_msc3861|msc4191_metadata_advertised_and_forwarded"
)

# -----------------------------------------------------------------------------
# Arg parse: tier + optional --list (position-independent)
# -----------------------------------------------------------------------------
TIER=""
LIST_ONLY=0
for a in "$@"; do
  case "$a" in
    --list) LIST_ONLY=1 ;;
    smoke|full) TIER="$a" ;;
    -h|--help) sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) log "run.sh: unknown argument '$a'"; exit 2 ;;
  esac
done
[ -n "$TIER" ] || { log "usage: run.sh <smoke|full> [--list]"; exit 2; }

case "$TIER" in
  smoke) CHECKS=("${SMOKE_CHECKS[@]}") ;;
  full)  CHECKS=("${FULL_CHECKS[@]}") ;;
esac

# --list: print composition and exit (no stack interaction).
if [ "$LIST_ONLY" = "1" ]; then
  printf 'tier: %s  (%d checks)\n' "$TIER" "${#CHECKS[@]}"
  for spec in "${CHECKS[@]}"; do
    id="${spec%%|*}"
    if [[ "$id" == FLAG:* ]]; then printf '  [known-flagged] %s\n' "${id#FLAG:}"
    else                          printf '  [expect-green ] %s\n' "$id"; fi
  done
  exit 0
fi

# -----------------------------------------------------------------------------
# Stack health: bring up if needed, then poll (no fixed sleeps).
# -----------------------------------------------------------------------------
stack_healthy() {
  curl -fsS "$OIDC_HEALTH_URL" >/dev/null 2>&1 && \
  curl -fsS "$EDGE_HEALTH_URL" >/dev/null 2>&1
}

ensure_stack() {
  if stack_healthy; then
    log "[run] stack already healthy."
    return 0
  fi
  log "[run] stack not healthy — bringing it up via up.sh ..."
  bash "$UP" >&2 || { log "[run] up.sh failed"; return 1; }

  log "[run] polling for health (timeout ${HEALTH_TIMEOUT}s) ..."
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT ))
  while ! stack_healthy; do
    if [ "$(date +%s)" -ge "$deadline" ]; then
      log "[run] stack did not become healthy within ${HEALTH_TIMEOUT}s"
      return 1
    fi
    sleep 2
  done
  log "[run] stack healthy."
}

# -----------------------------------------------------------------------------
# Teardown trap (default KEEP_STACK=1 -> leave up).
# -----------------------------------------------------------------------------
teardown() {
  local rc=$?
  if [ "$KEEP_STACK" = "1" ]; then
    log "[run] KEEP_STACK=1 — leaving stack UP."
  else
    log "[run] KEEP_STACK=0 — tearing stack down via down.sh ..."
    bash "$DOWN" >&2 || log "[run] down.sh reported an error"
  fi
  return $rc
}
trap teardown EXIT

# -----------------------------------------------------------------------------
# Run.
# -----------------------------------------------------------------------------
RUN_ID="$(date +%Y%m%d-%H%M%S)"
ART_DIR="$HARNESS_DIR/artifacts/$RUN_ID"
mkdir -p "$ART_DIR"

log "=============================================================="
log "  E2E orchestrator — tier=$TIER  run-id=$RUN_ID"
log "  artifacts: $ART_DIR"
log "  KEEP_STACK=$KEEP_STACK"
log "=============================================================="

if ! ensure_stack; then
  log "[run] FATAL: stack not healthy; aborting."
  # Capture container logs so the failure is diagnosable.
  for c in "${E2EH_CONTAINERS[@]}"; do
    podman logs "$c" >"$ART_DIR/podman-$c.log" 2>&1 || true
  done
  exit 1
fi

# Per-check accounting (parallel arrays; bash 4 assoc would also work but keep
# it portable/ordered).
RESULT_IDS=()
RESULT_STATUS=()    # pass | fail | known-flagged
RESULT_RC=()
RESULT_ARTIFACT=()
RESULT_FLAGGED=()   # 1 if the check is known-flagged, else 0

ANY_FAILURE=0       # any check exited non-zero (green OR flagged) -> collect logs
GREEN_FAIL=0        # an EXPECTED-GREEN check failed -> run fails
FLAGGED_FAILS=()    # ids of flagged checks that failed (for the summary line)

run_one() {
  local spec="$1"
  local id="${spec%%|*}"
  local rest="${spec#*|}"
  local surface="${rest%%|*}"; rest="${rest#*|}"
  local kind="${rest%%|*}";    rest="${rest#*|}"
  # remaining (may be empty for av) = adapter args, '|'-separated
  local args_str="$rest"
  local flagged=0
  if [[ "$id" == FLAG:* ]]; then flagged=1; id="${id#FLAG:}"; fi

  # artifact filename: id with non-filename chars flattened
  local safe; safe="$(printf '%s' "$id" | tr '/: ' '___')"
  local artifact="$ART_DIR/${safe}.stdout"
  : >"$artifact"

  # split args_str on '|'
  local -a args=()
  if [ -n "$args_str" ] && [ "$args_str" != "$kind" ]; then
    IFS='|' read -r -a args <<<"$args_str"
  fi

  log ""
  log "-------- [$id]  (surface=$surface kind=$kind $([ "$flagged" = 1 ] && echo '[known-flagged]'))"

  local rc=0
  case "$kind" in
    connector)
      bash "$ADAPTERS/connector.sh" "$artifact" "${args[@]}"; rc=$?
      ;;
    oidc)
      bash "$ADAPTERS/siwx-oidc-realstack.sh" "$artifact" "${args[@]}"; rc=$?
      ;;
    devicecode)
      bash "$ADAPTERS/device-code.sh" "$artifact" "${args[@]}"; rc=$?
      ;;
    av)
      ( bash "$AV_CHECK" ) >"$artifact" 2>&1; rc=$?
      ;;
    *)
      log "[run] unknown kind '$kind' for $id"; rc=99
      ;;
  esac

  printf '%s\n' "$rc" >"$ART_DIR/${safe}.exit"

  local status
  if [ "$rc" -eq 0 ]; then
    status="pass"
    log "         -> PASS (rc=0)"
  elif [ "$flagged" = "1" ]; then
    status="known-flagged"
    FLAGGED_FAILS+=("$id")
    ANY_FAILURE=1
    log "         -> KNOWN-FLAGGED FAIL (rc=$rc) — tolerated, pending remediation"
  else
    status="fail"
    GREEN_FAIL=1
    ANY_FAILURE=1
    log "         -> FAIL (rc=$rc) — EXPECTED-GREEN check failed"
  fi

  RESULT_IDS+=("$id")
  RESULT_STATUS+=("$status")
  RESULT_RC+=("$rc")
  RESULT_ARTIFACT+=("$(basename "$artifact")")
  RESULT_FLAGGED+=("$flagged")
}

for spec in "${CHECKS[@]}"; do
  run_one "$spec"
done

# -----------------------------------------------------------------------------
# On ANY failure (green or flagged), capture podman logs for every container.
# -----------------------------------------------------------------------------
if [ "$ANY_FAILURE" = "1" ]; then
  log ""
  log "[run] failure(s) observed — capturing podman logs for siwx-e2eh-* ..."
  for c in "${E2EH_CONTAINERS[@]}"; do
    podman logs "$c" >"$ART_DIR/podman-$c.log" 2>&1 || true
  done
fi

# -----------------------------------------------------------------------------
# summary.json manifest.
# -----------------------------------------------------------------------------
PASS_N=0; FAIL_N=0; FLAG_N=0
CHECK_JSON=""
for i in "${!RESULT_IDS[@]}"; do
  case "${RESULT_STATUS[$i]}" in
    pass) PASS_N=$((PASS_N+1)) ;;
    fail) FAIL_N=$((FAIL_N+1)) ;;
    known-flagged) FLAG_N=$((FLAG_N+1)) ;;
  esac
  obj="$(jq -nc \
    --arg id "${RESULT_IDS[$i]}" \
    --arg status "${RESULT_STATUS[$i]}" \
    --argjson rc "${RESULT_RC[$i]}" \
    --argjson flagged "$([ "${RESULT_FLAGGED[$i]}" = 1 ] && echo true || echo false)" \
    --arg artifact "${RESULT_ARTIFACT[$i]}" \
    '{id:$id,status:$status,exit_code:$rc,known_flagged:$flagged,artifact:$artifact}')"
  CHECK_JSON="${CHECK_JSON:+$CHECK_JSON,}$obj"
done

OVERALL="$([ "$GREEN_FAIL" = 0 ] && echo pass || echo fail)"

jq -n \
  --arg run_id "$RUN_ID" \
  --arg tier "$TIER" \
  --arg overall "$OVERALL" \
  --argjson total "${#RESULT_IDS[@]}" \
  --argjson passed "$PASS_N" \
  --argjson failed "$FAIL_N" \
  --argjson known_flagged "$FLAG_N" \
  --argjson checks "[$CHECK_JSON]" \
  '{run_id:$run_id, tier:$tier, overall:$overall,
    counts:{total:$total, pass:$passed, fail:$failed, known_flagged:$known_flagged},
    checks:$checks}' >"$ART_DIR/summary.json"

# -----------------------------------------------------------------------------
# Human summary.
# -----------------------------------------------------------------------------
log ""
log "=============================================================="
log "  tier=$TIER  run-id=$RUN_ID  ->  OVERALL: $(echo "$OVERALL" | tr a-z A-Z)"
log "  pass=$PASS_N  fail=$FAIL_N  known-flagged=$FLAG_N  (total ${#RESULT_IDS[@]})"
if [ "$FLAG_N" -gt 0 ]; then
  log "  $FLAG_N known-flagged pending remediation:"
  for id in "${FLAGGED_FAILS[@]}"; do log "      - $id"; done
fi
log "  summary: $ART_DIR/summary.json"
log "=============================================================="

# Exit 0 iff no EXPECTED-GREEN check failed.
[ "$GREEN_FAIL" = "0" ]
exit $?
