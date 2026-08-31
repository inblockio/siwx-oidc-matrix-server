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
#   full   every wired check. THERE ARE CURRENTLY NO KNOWN-FLAGGED CHECKS.
#            The mechanism remains (a `FLAG:` id prefix marks a check whose
#            failure is tolerated), but the list is empty and should stay that
#            way — see the warning on FULL_CHECKS below before adding one.
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

# Same resolution order the adapters use (see adapters/_common.sh).
SIWX_OIDC_DIR_FOR_RUN="${SIWX_OIDC_DIR:-${OIDC_E2EH_DIR:-$(cd "$REPO_ROOT/.." && pwd)/siwx-oidc}}"

OIDC_HEALTH_URL="${OIDC_HEALTH_URL:-http://localhost:18081/health}"
EDGE_HEALTH_URL="${EDGE_HEALTH_URL:-http://localhost:18080/_matrix/client/versions}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-180}"   # seconds to wait for health

KEEP_STACK="${KEEP_STACK:-1}"             # 1 = leave stack up (default); 0 = teardown (CI)

# -----------------------------------------------------------------------------
# STRICT SKIPS ARE ON BY DEFAULT (2026-08-30).
#
# E2E_STRICT_SKIPS previously defaulted to 0 and was set NOWHERE — not here, not
# in CI — so the in-test skip guard existed but was never once armed. A test that
# early-returned past all its assertions was reported by cargo as `ok` and by
# this orchestrator as a PASS.
#
# Exported (not just set) because the adapters run as separate bash processes.
# Opt out explicitly with E2E_STRICT_SKIPS=0 — and if you find yourself doing
# that to get a green run, the run was never green.
# -----------------------------------------------------------------------------
export E2E_STRICT_SKIPS="${E2E_STRICT_SKIPS:-1}"

# Revision pinning. If set, every adapter asserts its checkout matches before
# running (see adapters/_common.sh assert_checkout_revision). Left unset by
# default for local use; CI should pin these so an artifact can never be
# recorded against a different branch than the one under test.
export E2E_EXPECT_SHA="${E2E_EXPECT_SHA:-}"
export E2E_EXPECT_REF="${E2E_EXPECT_REF:-}"
export E2E_ALLOW_DIRTY="${E2E_ALLOW_DIRTY:-0}"

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

# full: every wired check. A `FLAG:` id prefix marks a check as known-flagged
# (its failure is tolerated and does NOT fail the run).
#
# ** THE KNOWN-FLAGGED LIST IS EMPTY, AND ADDING TO IT IS A LOAD-BEARING DECISION. **
#
# A flagged failure sets ANY_FAILURE but NOT GREEN_FAIL, and run.sh exits
# `0 iff GREEN_FAIL=0` — so a genuine regression in a flagged check still exits
# 0 and CI still goes green. A flag is therefore not "a known issue we track";
# it is "this check no longer gates anything". Only flag a check with a written
# reason and a retirement condition.
#
# Retired 2026-08-30: siwx-oidc.msc3861.msc4191_metadata_advertised_and_forwarded
# was flagged for a "Synapse 1.154 re-export limitation". That limitation no
# longer exists — the stack is pinned to Synapse 1.159.0 and the check passes —
# so the flag was silently suppressing a real gate. Now expected-green.
#
# The two connector RTC tests (rtc_jwt_handshake,
# rtc_room_alias_matches_element_call) went green via the
# feat/e2e-local-rtc-pointing branch (lk_jwt_endpoint() parameterization) + the
# siwx-e2eh-fed-proxy sidecar; the two msc4191_live tests + session_teardown went
# green via the R2 test updates.
#
# -----------------------------------------------------------------------------
# DELIBERATELY NOT WIRED HERE (this is a decision, not an oversight):
#   siwx-oidc  tests/e2e_oauth_binding.rs      (11 tests)
#   siwx-oidc  tests/e2e_race_teardown.rs      (12 tests)
#   siwx-oidc  tests/e2e_account_management.rs ( 5 tests)
#
# These 28 tests target a DIFFERENT stack: the fault-injecting MOCK brought up
# by the siwx-oidc repo's own `e2e/up.sh` — siwx-oidc on :8080 and a Synapse
# MOCK on :8090 that records a call log and exposes /__reset, /__seed_device,
# /__state, /__set_secret and /__fail. Their assertions are ABOUT those fault
# injections (forced Synapse failures, teardown races aligned on a
# tokio::sync::Barrier, token-resurrection regression guards).
#
# This harness runs a REAL Synapse (siwx-e2eh-synapse). Pointing these targets
# at it would be worse than leaving them out: they would connect, look wired,
# and silently stop exercising the fault paths they exist to cover — coverage
# theatre, which is the exact defect class this harness was repaired to remove.
#
# They are already `#[ignore = "requires live e2e stack (e2e/up.sh)"]`, so a
# plain `cargo test` stays green. They only go red for someone running
# `cargo test -- --ignored` WITHOUT that mock stack up, where they fail on
# ConnectionRefused to :8090 (plan D16 — environmental, never a regression).
# To run them:
#     cd <siwx-oidc>; bash e2e/up.sh
#     cargo test --test e2e_race_teardown -- --ignored --test-threads=1 --nocapture
#
# Wiring them properly means adding the mock stack as a SECOND surface with its
# own adapter (ports :8080/:8090 do not collide with this stack's :18081/:18080,
# so it is feasible) — worth doing, but it is new harness surface, not a fix.
# -----------------------------------------------------------------------------
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
  # ---- siwx-oidc cross-signing-reset CONTRACT-LOCK (B2: regression locks for the honesty fix) ----
  "siwx-oidc.cross_signing_reset.legA_roundtrip|siwx-oidc|oidc|e2e_msc4191_live|cross_signing_reset_leg_a_roundtrip_completed_live"
  "siwx-oidc.cross_signing_reset.stale_window_wedge|siwx-oidc|oidc|e2e_msc4191_live|cross_signing_reset_stale_window_wedge_live"
  "siwx-oidc.cross_signing_reset.no_master_completed|siwx-oidc|oidc|e2e_msc4191_live|cross_signing_reset_no_master_completed_live"
  "siwx-oidc.session_teardown|siwx-oidc|oidc|e2e_session_teardown"
  # ---- siwx-oidc msc4191 metadata (expected-green since the 1.159 upgrade) ----
  "siwx-oidc.msc3861.msc4191_metadata_advertised_and_forwarded|siwx-oidc|oidc|e2e_msc3861|msc4191_metadata_advertised_and_forwarded"
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
log "  KEEP_STACK=$KEEP_STACK  E2E_STRICT_SKIPS=$E2E_STRICT_SKIPS"
log "=============================================================="

if ! ensure_stack; then
  log "[run] FATAL: stack not healthy; aborting."
  # Capture container logs so the failure is diagnosable.
  for c in "${E2EH_CONTAINERS[@]}"; do
    podman logs "$c" >"$ART_DIR/podman-$c.log" 2>&1 || true
  done
  exit 1
fi

# -----------------------------------------------------------------------------
# IMAGE PROVENANCE GUARD.
#
# The adapters assert the TEST-code revision. Nothing asserted the SERVER IMAGE,
# and on 2026-08-30 the harness default (localhost/siwx-oidc:local-grace) turned
# out to be FIVE WEEKS OLD — so every "green" run had been validating a
# five-week-old binary while claiming to exercise current code. A green run
# against the wrong binary is worse than no run: it manufactures false
# confidence in code that was never executed.
#
# Rule: the siwx-oidc image must not be OLDER than the HEAD commit of the
# siwx-oidc checkout under test. Older => it cannot contain that code.
# -----------------------------------------------------------------------------
SIWX_OIDC_IMAGE_REF="${SIWX_OIDC_IMAGE_REF:-localhost/siwx-oidc:e2eh-5f47a9b}"
IMAGE_PROVENANCE="unknown"

assert_image_not_stale() {
  local dir="$1" img="$2"
  local img_epoch commit_epoch img_created

  img_created="$(podman image inspect "$img" --format '{{.Created}}' 2>/dev/null || true)"
  if [ -z "$img_created" ]; then
    log "[run] FATAL: siwx-oidc image '$img' not found locally."
    log "       Build it:  podman build -t $img -f Dockerfile $dir"
    return 1
  fi
  img_epoch="$(date -d "$img_created" +%s 2>/dev/null || echo 0)"
  commit_epoch="$(git -C "$dir" log -1 --format=%ct 2>/dev/null || echo 0)"

  IMAGE_PROVENANCE="$img (built $img_created)"
  log "[run] image under test : $IMAGE_PROVENANCE"

  if [ "$img_epoch" = "0" ] || [ "$commit_epoch" = "0" ]; then
    log "[run] WARNING: could not compare image build time to commit time; provenance unverified."
    return 0
  fi
  if [ "$img_epoch" -lt "$commit_epoch" ]; then
    log "[run] ================================================================"
    log "[run] STALE IMAGE: the siwx-oidc image PREDATES the code under test."
    log "[run]   image  built : $img_created"
    log "[run]   HEAD committed: $(git -C "$dir" log -1 --format=%ci)"
    log "[run]   checkout      : $dir ($(git -C "$dir" rev-parse --short HEAD 2>/dev/null))"
    log "[run] This image CANNOT contain the code you are trying to test. A pass"
    log "[run] here would prove nothing about it. Rebuild:"
    log "[run]   podman build -t localhost/siwx-oidc:e2eh-\$(git -C $dir rev-parse --short HEAD) -f Dockerfile $dir"
    log "[run] ================================================================"
    if [ "${E2E_STRICT_SKIPS:-1}" = "1" ]; then
      return 1
    fi
    log "[run] E2E_STRICT_SKIPS=0 — continuing against the stale image anyway."
  fi

  # The ref above is only a CLAIM about what should be running. The stack may
  # already be up from an earlier bring-up with a different image, in which case
  # SIWX_OIDC_IMAGE_REF describes nothing. Compare the ref's image id to the id
  # the live container is actually running.
  local want_id have_id
  want_id="$(podman image inspect "$img" --format '{{.Id}}' 2>/dev/null || true)"
  have_id="$(podman inspect siwx-e2eh-oidc --format '{{.Image}}' 2>/dev/null || true)"
  if [ -n "$have_id" ] && [ -n "$want_id" ] && [ "$have_id" != "$want_id" ]; then
    log "[run] ================================================================"
    log "[run] RUNNING CONTAINER DOES NOT MATCH THE IMAGE UNDER TEST."
    log "[run]   configured ref : $img -> ${want_id:0:12}"
    log "[run]   siwx-e2eh-oidc : running ${have_id:0:12}"
    log "[run] The stack was brought up from a different image. Tear it down and"
    log "[run] bring it back up so the container matches the ref:"
    log "[run]   e2e-harness/down.sh && SIWX_OIDC_IMAGE_REF=$img e2e-harness/up.sh"
    log "[run] ================================================================"
    IMAGE_PROVENANCE="MISMATCH: ref=$img(${want_id:0:12}) running=${have_id:0:12}"
    [ "${E2E_STRICT_SKIPS:-1}" = "1" ] && return 1
    log "[run] E2E_STRICT_SKIPS=0 — continuing against the mismatched container anyway."
  elif [ -n "$have_id" ]; then
    IMAGE_PROVENANCE="$IMAGE_PROVENANCE [running container matches: ${have_id:0:12}]"
    log "[run] running container matches the ref (${have_id:0:12})."
  fi
  return 0
}

if ! assert_image_not_stale "$SIWX_OIDC_DIR_FOR_RUN" "$SIWX_OIDC_IMAGE_REF"; then
  log "[run] FATAL: refusing to record an artifact against an unverifiable image."
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
HARNESS_ERRORS=()   # ids of checks the harness could not run / that judged nothing

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
  elif [ "$rc" -eq 2 ] || [ "$rc" -eq 3 ]; then
    # rc=2 the adapter could NOT run the check (precondition/environment).
    # rc=3 it ran but judged nothing (name filter matched no test).
    # Neither is a product verdict, so neither may be tolerated -- NOT EVEN for a
    # known-flagged check. A broken instrument filed as "expected failure" is how
    # a run comes out green while proving nothing.
    status="harness-error"
    HARNESS_ERRORS+=("$id (rc=$rc)")
    GREEN_FAIL=1
    ANY_FAILURE=1
    if [ "$rc" -eq 2 ]; then
      log "         -> HARNESS ERROR (rc=2) -- check could NOT RUN; this is not a product failure"
    else
      log "         -> HARNESS ERROR (rc=3) -- check ran but JUDGED NOTHING (0 tests matched)"
    fi
  elif [ "$rc" -eq 4 ]; then
    # rc=4 the check RAN but early-returned past its assertions (strict skips).
    # cargo called it `ok`; it proved nothing. Like rc=2/3 this is not a product
    # verdict and must never be tolerated, not even for a flagged check.
    status="skipped-not-run"
    HARNESS_ERRORS+=("$id (rc=4, in-test skip)")
    GREEN_FAIL=1
    ANY_FAILURE=1
    log "         -> SKIPPED (rc=4) -- the test early-returned past its assertions; it proved NOTHING"
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
PASS_N=0; FAIL_N=0; FLAG_N=0; HERR_N=0
CHECK_JSON=""
for i in "${!RESULT_IDS[@]}"; do
  case "${RESULT_STATUS[$i]}" in
    pass) PASS_N=$((PASS_N+1)) ;;
    fail) FAIL_N=$((FAIL_N+1)) ;;
    known-flagged) FLAG_N=$((FLAG_N+1)) ;;
    harness-error|skipped-not-run) HERR_N=$((HERR_N+1)) ;;
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

# Record WHAT WAS TESTED, not just the verdict. An artifact that does not name
# its revision cannot be audited later — and a red baseline recorded against the
# wrong branch is exactly how this harness previously misled a reader.
SIWX_OIDC_DIR_FOR_SUMMARY="$SIWX_OIDC_DIR_FOR_RUN"
rev_of() {
  local d="$1"
  if [ -d "$d/.git" ] || git -C "$d" rev-parse --git-dir >/dev/null 2>&1; then
    printf '%s @ %s%s' \
      "$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')" \
      "$(git -C "$d" rev-parse --short HEAD 2>/dev/null || echo '?')" \
      "$([ -n "$(git -C "$d" status --porcelain 2>/dev/null)" ] && echo ' (dirty)')"
  else
    printf 'not-a-git-checkout'
  fi
}
REV_HARNESS="$(rev_of "$REPO_ROOT")"
REV_SIWX="$(rev_of "$SIWX_OIDC_DIR_FOR_SUMMARY")"
REV_CONNECTOR="$(rev_of "${CONNECTOR_DIR:-/home/waldknoten-01/aqua-matrix-agent}")"

jq -n \
  --arg run_id "$RUN_ID" \
  --arg tier "$TIER" \
  --arg overall "$OVERALL" \
  --arg rev_harness "$REV_HARNESS" \
  --arg rev_siwx_oidc "$REV_SIWX" \
  --arg rev_connector "$REV_CONNECTOR" \
  --arg image_siwx_oidc "$IMAGE_PROVENANCE" \
  --arg strict_skips "$E2E_STRICT_SKIPS" \
  --argjson total "${#RESULT_IDS[@]}" \
  --argjson passed "$PASS_N" \
  --argjson failed "$FAIL_N" \
  --argjson known_flagged "$FLAG_N" \
  --argjson harness_error "$HERR_N" \
  --argjson checks "[$CHECK_JSON]" \
  '{run_id:$run_id, tier:$tier, overall:$overall,
    under_test:{harness:$rev_harness, siwx_oidc:$rev_siwx_oidc, connector:$rev_connector,
                siwx_oidc_image:$image_siwx_oidc},
    settings:{strict_skips:$strict_skips},
    counts:{total:$total, pass:$passed, fail:$failed, known_flagged:$known_flagged,
            harness_error:$harness_error},
    checks:$checks}' >"$ART_DIR/summary.json"

# -----------------------------------------------------------------------------
# Human summary.
# -----------------------------------------------------------------------------
log ""
log "=============================================================="
log "  tier=$TIER  run-id=$RUN_ID  ->  OVERALL: $(echo "$OVERALL" | tr a-z A-Z)"
log "  pass=$PASS_N  fail=$FAIL_N  known-flagged=$FLAG_N  harness-error=$HERR_N  (total ${#RESULT_IDS[@]})"
if [ "$HERR_N" -gt 0 ]; then
  log "  $HERR_N CHECK(S) JUDGED NOTHING (harness error or in-test skip):"
  for id in "${HARNESS_ERRORS[@]}"; do log "      - $id"; done
  log "  A run with a harness error proves nothing about the checks it could not run."
fi
if [ "$FLAG_N" -gt 0 ]; then
  log "  $FLAG_N known-flagged pending remediation:"
  for id in "${FLAGGED_FAILS[@]}"; do log "      - $id"; done
fi
log "  summary: $ART_DIR/summary.json"
log "=============================================================="

# Exit 0 iff no EXPECTED-GREEN check failed.
[ "$GREEN_FAIL" = "0" ]
exit $?
