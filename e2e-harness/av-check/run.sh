#!/usr/bin/env bash
# =============================================================================
# A6.5 - Minimal audio+video channel-establishment check against LOCAL LiveKit.
#
# WHAT THIS PROVES (MVP invariant `saw_remote_av`, minimal form):
#   A subscriber, joining the SAME local SFU as simulated audio+video
#   publishers, actually SUBSCRIBES to >=1 remote AUDIO track AND >=1 remote
#   VIDEO track, each carrying LIVE media (packets received > 0 and a non-zero
#   bitrate). i.e. both media channels really establish end-to-end over the
#   local SFU, not just signaling.
#
# MECHANISM:
#   Runs the official LiveKit CLI (`lk perf load-test`) inside a throwaway
#   container ON the e2e podman network `siwx-e2eh-net`, so it reaches the
#   running SFU at `ws://siwx-e2eh-livekit:7880` directly over the podman
#   bridge (container-to-container; no host port juggling, no WSL UDP bridge).
#   `lk` publishes simulated H264/VP8 video + Opus audio and a subscriber
#   subscribes; it prints a per-track stats table that we parse.
#
# SCOPE (deliberately MINIMAL): no Deepgram, no transcript-agent, no
#   libwebrtc-from-source, no aqua-agents. Pulls only `livekit/livekit-cli`.
#   Does NOT touch / restart the LiveKit container or any other e2e container.
#   Commits nothing.
#
# OUTPUT: human-readable PASS/FAIL. Exit 0 IFF BOTH remote audio AND remote
#   video were subscribed with live media; non-zero otherwise.
# =============================================================================
set -euo pipefail

# -----------------------------------------------------------------------------
# Config (overridable via env for reuse in other harness contexts)
# -----------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../../.env.e2e}"
LK_IMAGE="${LK_IMAGE:-docker.io/livekit/livekit-cli:latest}"
LK_NETWORK="${LK_NETWORK:-siwx-e2eh-net}"
LK_WS_URL="${LK_WS_URL:-ws://siwx-e2eh-livekit:7880}"
LK_CONTAINER="${LK_CONTAINER:-siwx-e2eh-livekit}"   # only used for a liveness check
ROOM="${ROOM:-e2e-av-$(date +%s)-$$}"
DURATION="${DURATION:-15s}"
# Transport override: leave empty for LiveKit default (UDP/ICE-UDP preferred,
# falls back to ICE-TCP). Set FORCE_TCP=1 to force ICE-TCP (see fallback note).
FORCE_TCP="${FORCE_TCP:-0}"

CRED_BIN="${CRED_BIN:-podman}"   # container runtime

log()  { printf '%s\n' "$*" >&2; }
fail() { log "FAIL: $*"; exit 1; }

# -----------------------------------------------------------------------------
# 1. Load creds from .env.e2e
# -----------------------------------------------------------------------------
[ -f "$ENV_FILE" ] || fail "creds file not found: $ENV_FILE"
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
: "${LIVEKIT_KEY:?LIVEKIT_KEY missing in $ENV_FILE}"
: "${LIVEKIT_SECRET:?LIVEKIT_SECRET missing in $ENV_FILE}"

# -----------------------------------------------------------------------------
# 2. Pre-flight: runtime, network, image, SFU liveness (idempotent)
# -----------------------------------------------------------------------------
command -v "$CRED_BIN" >/dev/null 2>&1 || fail "$CRED_BIN not found on PATH"

"$CRED_BIN" network exists "$LK_NETWORK" 2>/dev/null \
  || "$CRED_BIN" network inspect "$LK_NETWORK" >/dev/null 2>&1 \
  || fail "podman network '$LK_NETWORK' not found - is the e2e stack up? (e2e-harness/up.sh)"

if ! "$CRED_BIN" ps --format '{{.Names}}' 2>/dev/null | grep -qx "$LK_CONTAINER"; then
  fail "LiveKit container '$LK_CONTAINER' is not running - bring the e2e stack up first."
fi

if ! "$CRED_BIN" image exists "$LK_IMAGE" 2>/dev/null; then
  log "Pulling LiveKit CLI image $LK_IMAGE (one-time) ..."
  "$CRED_BIN" pull "$LK_IMAGE" >&2 || fail "could not pull $LK_IMAGE"
fi

# -----------------------------------------------------------------------------
# 3. Run the load test (publish A+V, subscribe), capture output
# -----------------------------------------------------------------------------
EXTRA_ARGS=()
if [ "$FORCE_TCP" = "1" ]; then
  # ICE-TCP is selected by LiveKit when UDP candidates are unreachable. We can
  # bias the client toward TCP by disabling its UDP path via env understood by
  # the pion/webrtc stack inside `lk`. (Only needed if UDP shows 0 bitrate.)
  EXTRA_ARGS+=(--env "PIONS_UDP_DISABLED=1")
  log "FORCE_TCP=1: requesting ICE-TCP transport (UDP disabled in client)."
fi

OUT_FILE="$(mktemp -t av-check.XXXXXX)"
trap 'rm -f "$OUT_FILE"' EXIT

log "=============================================================="
log "A6.5 AV-establishment check"
log "  SFU url   : $LK_WS_URL  (network $LK_NETWORK)"
log "  room      : $ROOM"
log "  duration  : $DURATION   (1 video pub, 1 audio pub, 1 subscriber)"
log "  transport : $([ "$FORCE_TCP" = 1 ] && echo 'ICE-TCP (forced)' || echo 'LiveKit default (UDP preferred)')"
log "=============================================================="

set +e
"$CRED_BIN" run --rm --network "$LK_NETWORK" "${EXTRA_ARGS[@]}" "$LK_IMAGE" \
  perf load-test \
  --url "$LK_WS_URL" \
  --api-key "$LIVEKIT_KEY" \
  --api-secret "$LIVEKIT_SECRET" \
  --room "$ROOM" \
  --video-publishers 1 \
  --audio-publishers 1 \
  --subscribers 1 \
  --duration "$DURATION" >"$OUT_FILE" 2>&1
LK_RC=$?
set -e

# Echo the raw lk output (it is the evidence).
log ""
log "----- lk perf load-test output -------------------------------"
cat "$OUT_FILE" >&2
log "--------------------------------------------------------------"

if [ "$LK_RC" -ne 0 ]; then
  fail "lk perf load-test exited non-zero ($LK_RC) - SFU unreachable or client error."
fi

# -----------------------------------------------------------------------------
# 4. Parse the "Track loading" table & assert the saw_remote_av invariant.
#
#    NB: `lk` exits 0 even when nothing subscribed, so we MUST assert on
#    content. We parse the per-track table rows (delimited by U+2502 '│'):
#       │ Tester │ Track │ Kind │ Pkts. │ Bitrate │ Pkt. Loss │
#    A track counts as LIVE iff Kind in {audio,video} AND packets>0 AND a
#    non-zero bitrate (kbps/mbps with a non-zero number).
# -----------------------------------------------------------------------------
read -r AUDIO_OK AUDIO_PKTS AUDIO_BR VIDEO_OK VIDEO_PKTS VIDEO_BR PKTLOSS_OK <<EOF
$(awk '
  BEGIN { FS="\xe2\x94\x82"; a=0;v=0; ap=0; vp=0; ab="-"; vb="-"; loss_bad=0 }
  # only consider rows that look like table data with a Kind column
  /\xe2\x94\x82/ {
    kind=$4; pkts=$5; br=$6; lossf=$7
    gsub(/^[ \t]+|[ \t]+$/, "", kind)
    gsub(/^[ \t]+|[ \t]+$/, "", pkts)
    gsub(/^[ \t]+|[ \t]+$/, "", br)
    gsub(/^[ \t]+|[ \t]+$/, "", lossf)
    if (kind != "audio" && kind != "video") next
    if (pkts !~ /^[0-9]+$/) next
    pn = pkts + 0
    # bitrate non-zero: a number >0 immediately before kbps/mbps/gbps
    brnum = br
    sub(/(kbps|mbps|gbps|bps).*$/, "", brnum)
    gsub(/[ \t]/, "", brnum)
    brlive = (brnum ~ /^[0-9]+(\.[0-9]+)?$/ && (brnum + 0) > 0)
    # packet loss: capture leading integer of "N (X%)"
    ln = lossf; sub(/[ (].*$/, "", ln)
    if (ln ~ /^[0-9]+$/ && (ln + 0) > 0) loss_bad=1
    if (kind == "audio" && pn > 0 && brlive) { a=1; ap=pn; ab=br }
    if (kind == "video" && pn > 0 && brlive) { v=1; vp=pn; vb=br }
  }
  END {
    printf "%d %s %s %d %s %s %d\n", a, (ap==0?"-":ap), ab, v, (vp==0?"-":vp), vb, (loss_bad?0:1)
  }
' "$OUT_FILE")
EOF

# Sanity: also confirm the explicit subscribe log lines exist (belt & braces).
SUB_AUDIO=$(grep -cE '^subscribed to track .* audio' "$OUT_FILE" || true)
SUB_VIDEO=$(grep -cE '^subscribed to track .* video' "$OUT_FILE" || true)

log ""
log "----- parsed invariant ---------------------------------------"
log "  remote AUDIO track live : $([ "$AUDIO_OK" = 1 ] && echo yes || echo NO)   (pkts=$AUDIO_PKTS bitrate=$AUDIO_BR, subscribe-log=$SUB_AUDIO)"
log "  remote VIDEO track live : $([ "$VIDEO_OK" = 1 ] && echo yes || echo NO)   (pkts=$VIDEO_PKTS bitrate=$VIDEO_BR, subscribe-log=$SUB_VIDEO)"
log "  packet loss acceptable  : $([ "$PKTLOSS_OK" = 1 ] && echo yes || echo 'NO (loss detected)')"
log "--------------------------------------------------------------"

# -----------------------------------------------------------------------------
# 5. Verdict
# -----------------------------------------------------------------------------
if [ "$AUDIO_OK" = 1 ] && [ "$VIDEO_OK" = 1 ] && [ "$SUB_AUDIO" -ge 1 ] && [ "$SUB_VIDEO" -ge 1 ]; then
  log ""
  log "=============================================================="
  log "PASS: remote AUDIO and remote VIDEO both established with live media over the local SFU."
  log "      audio=${AUDIO_PKTS} pkts @ ${AUDIO_BR}; video=${VIDEO_PKTS} pkts @ ${VIDEO_BR}; loss $([ "$PKTLOSS_OK" = 1 ] && echo 0% || echo '>0%')."
  log "=============================================================="
  exit 0
fi

log ""
log "=============================================================="
log "FAIL: did NOT observe both a live remote audio AND a live remote video track."
[ "$FORCE_TCP" = 1 ] || log "      Hint: if UDP media did not flow (0 bitrate), retry with FORCE_TCP=1 $0"
log "=============================================================="
exit 1
