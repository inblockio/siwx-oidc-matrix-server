# livekit-server vendored patches: the registry

This directory is the **complete, canonical list of every modification we apply to
upstream livekit-server** (livekit/livekit, the SFU and embedded TURN server behind
MatrixRTC calls). `dockerfiles/Dockerfile.livekit` is the single build source of our own
image. It fetches upstream at a pinned commit and applies exactly the patches listed here
with `git apply`, in file name order, so **a patch that stops applying fails the image
build loudly**, never silently at runtime. The tests a patch carries run in the builder
stage, so a red test fails the build too.

The rules are the same as `patches/element-web/README.md`: every entry states *what*,
*why*, the *evidence*, its *upstream status* and its *retirement condition*. Behavioral
patches name their tests. Classifications are UPSTREAM DEFECT, UPSTREAM-TRACKED and
POLICY; only POLICY is permanent. livekit-server is Apache-2.0, like this repository; a
file a patch adds is Apache-2.0 too (see `NOTICE`).

**Bump procedure** (every change of `LIVEKIT_TAG`/`LIVEKIT_COMMIT` in the Dockerfile, and
the two `FROM` lines, which follow upstream's own Dockerfile at the new tag): dry-run each
patch against the new commit, then run the patch tests and upstream's service tests on the
patched tree (no Go on the host needed; the golang image is the one the Dockerfile pins):

```bash
d=$(mktemp -d -p ~/.cache) && git -C "$d" init -q && git -C "$d" fetch -q --depth 1 \
  https://github.com/livekit/livekit "refs/tags/<new tag>" && git -C "$d" checkout -q FETCH_HEAD \
  && for p in patches/livekit/*.patch; do git -C "$d" apply --check "$PWD/$p" && echo "OK $p"; done
# then, in $d with the patches applied:
podman run --rm -v "$d":/src -w /src -e GOTOOLCHAIN=local <golang image of the Dockerfile> \
  go test -count=1 ./pkg/service/... -args -docker=false
```

**Shipping.** The image is built by `dockerfiles/Dockerfile.livekit` and published by the
CI build-and-push matrix as `ghcr.io/inblockio/siwx-oidc-matrix-server/livekit-server`.
`docker-compose.yml` defaults `LIVEKIT_IMAGE_REF` to it; a deployment that pins
`LIVEKIT_IMAGE_REF` to the stock `livekit/livekit-server` image runs without these patches
(the relay policy is then ignored, calls work as before).

## 1. `0001-relay-policy.patch`

**What.** A relay policy: a client whose address falls in a configured IP range gets
relay-only ICE over TURN/TLS on :443 from the first second of a join or resume. Ranges come
from a directory of YAML files, one file per policy (a country or a carrier group), named by
`LIVEKIT_RELAY_POLICY_DIR`. Unset, the server behaves exactly as upstream. The patch adds
`pkg/service/relaypolicy.go` (loader, matcher, hot reload, TURN guard) and a small change in
`pkg/service/roommanager.go`: the policy at construction, the match in `getIceConfig`, and
`resumeIceConfig` for a resume.

**How.** It reuses upstream's own fallback: after ICE failures upstream caches an
`ICEConfig` with `PreferenceSubscriber = ICT_TLS` for the participant, and on the next join
`iceServersForParticipant(..., tlsOnly)` hands out only `turns:<turn.domain>:443` and the
participant's `ClientConfiguration.ForceRelay` becomes `ENABLED`. The patch returns that
config up front for a matching address. A join matches the address it comes from. A resume
matches the address the client resumes from (not the join address, so moving onto a listed
network mid-call counts), and on a match the ICE config is applied before the
ReconnectResponse is built: that response carries the participant's `ClientConfiguration`,
whose `ForceRelay` follows the applied config, and upstream would only apply it afterwards
(`Room.ResumeParticipant` sends the response, then `ICERestart`). A resume that does not match is
upstream's, untouched, so a client that fell back to TURN/TLS on its own keeps what it was told. Every livekit-client honours `forceRelay`
(`iceTransportPolicy: 'relay'`) and the server's ICE servers; Element Call (in Element Web,
in Element X, and as aqua-meet's fork) never overrides either, so one server patch covers
every client. The address is LiveKit's `ClientInfo.Address` (`GetClientIP`:
`CF-Connecting-IP`, then `X-Forwarded-For`, of which the first element counts, then
`X-Real-IP`, then the TCP peer). The proxy must not pass a client-supplied
`X-Forwarded-For` through unless it is a trusted hop; a forged header can only force relay
for the forger, which costs TURN bandwidth and nothing else.

**File format and reload.** `name` (required, unique), `description`, `asns` (input for
`scripts/relay-policy-refresh`, not matched), `manual_prefixes` and `prefixes` (CIDRs,
IPv4 and IPv6; IPv4-mapped IPv6 addresses match IPv4 ranges). Unknown keys, a bad CIDR, a
missing or duplicate name or an unreadable directory stop the server at startup. A server
without embedded TURN and its TLS leg (`turn.enabled`, `turn.domain`, `turn.tls_port`)
ignores the policy with a warning, because forced relay without a TURN/TLS server would
leave a matching client with no candidate at all. The
directory is re-checked at most every 30 s on a join; a change of the file set or of a
file's content is loaded without a restart, and a reload that fails keeps the previous
policy and logs at error level. A match logs `relay policy matched` with the policy name
(not the address).

**Why.** Some carriers filter UDP media (VoIP blocking): ICE then either fails slowly
before reaching TURN/TLS, or a UDP path connects and is cut later. Team members abroad on
such networks need calls that work from the start. POLICY.

**Evidence.** Mechanism: `pkg/service/roommanager.go` (`getIceConfig`,
`iceServersForParticipant`), `pkg/rtc/participant.go` (`OnICEConfigChanged`, ForceRelay) at
v1.13.10; livekit-client 2.22.3 `src/room/RTCEngine.ts` (iceServers, forceRelay). Tests:
`pkg/service/relaypolicy_test.go` (matching for IPv4, IPv6, mapped, zones, ports and
forwarded lists; startup errors; reload on added, changed, broken, fixed and removed
files; the TURN/TLS guard; `getIceConfig` with and without a match and with the resume
address; `resumeIceConfig` applying the config before the response), run by the Dockerfile,
which also loads this repository's `config/relay-policy/` (`TestRelayPolicyValidateDir`), so a
broken policy file fails CI instead of stopping LiveKit.

**Upstream status.** Not filed. Upstream has no per-address client configuration
(`clientconfiguration.StaticConfigurations` is compiled in and matches client metadata).

**Retirement condition.** Upstream gains a configurable way to force relay or TLS-only
ICE for clients by address range; then move the policy files to it and drop the patch.
