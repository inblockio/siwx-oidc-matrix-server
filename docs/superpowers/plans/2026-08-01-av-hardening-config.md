# A/V hardening — config-only backlog from the 2026-08-01 call-incident audit

**Status:** IMPLEMENTED + REVIEWED on `fix/av-hardening-config`; NOT deployed anywhere. Next gate is T10 (dev-staging validation) — see the checklist at the end.
**Scope:** repo `siwx-oidc-matrix-server`, config/deploy files only. No service code. No prod deployment in this pipeline (manual promotion per prod policy).
**Origin:** 2026-08-01 failed-call investigation. Root cause of the incident itself was **client-side** (iOS Element X camera capture); these tasks fix what the audit found around it. Evidence: forensics + config-audit + upstream-source research (see session summary; memory `av-call-incident-2026-08-01`).

## Why now (the time bomb)

Prod runs `ghcr.io/element-hq/lk-jwt-service:latest` resolved to a **pre-2026-06-03 build**: it logs the "defaulting to wildcard (*)" warning, which v0.5.0+ replaced with a **hard startup failure** when `LIVEKIT_FULL_ACCESS_HOMESERVERS` is unset. Consequences:

1. **Today:** wildcard default → any user of any federated homeserver can obtain full-access LiveKit tokens (open-relay exposure, S2).
2. **Any future `docker compose pull` / image prune + `up -d`:** the newer image refuses to boot without the var → **all calling breaks** (C1/C2).

## Hypothesis register

| ID | If | Then | Assumptions | Verification |
|----|----|------|-------------|--------------|
| H1 | `LIVEKIT_FULL_ACCESS_HOMESERVERS: "matrix.inblock.io"` is set and lk-jwt is pinned ≥ v0.5.0 | service boots; local users full access; foreign homeservers denied room-create | server_name is `matrix.inblock.io`; upstream tag available | dev logs the parsed allowlist at startup — `LIVEKIT_FULL_ACCESS_HOMESERVERS: [dev.matrix.inblock.io]`, NOT `[*]` — container stays up (no restart loop), local user's call sets up |
| H2 | lk-jwt + synapse images pinned by tag (digest recorded) | `compose pull` can no longer change call behavior unannounced | pinned tags exist on GHCR/Docker Hub | `docker image inspect` digest matches pin after pull on dev |
| H3 | placeholder `keys:` block deleted from `config/livekit.yaml` | livekit boots and verifies tokens purely from `LIVEKIT_KEYS` (env REPLACES file keys — verified in livekit source) | `LIVEKIT_KEYS` set in all envs | e2e call succeeds; livekit logs no key errors |
| H4 | UDP range moved to 20100–20200 in `livekit.yaml` **and** compose **and** host firewall | media flows on the new range; ephemeral-port squatting hazard gone | firewall change applied on dev before validation; prod at promotion | e2e/dev test call; `ss -ulnp` shows 101 bindings in new range; livekit rtpStats packets > 0 |
| H5 | `/livekit/sfu/twirp/*` blocked for public clients AND lk-jwt's RoomService calls routed internally | public `ListRooms` → 403 while call setup still works | **lk-jwt's hairpin arrives at Caddy with a PRIVATE source address** (no CS-API override exists — see T6; this assumption is not testable off-box and is the single way this change can break calling) | curl twirp from the internet → 403; on the box, lk-jwt's CreateRoom succeeds and Caddy's access log shows a private `remote_ip` for it |
| H6 | SFU route also matches bare `/livekit/sfu` | bare path stops 404ing | Caddy matcher semantics as documented | `curl -w '%{http_code}'` → not 404 |
| H7 | MatrixRTC/rc yq block moved out of the first-boot guard | restarted container re-asserts config; no more manual `yq` after template changes | yq assignments are idempotent (they are) | e2e: remove a key from generated homeserver.yaml, restart, key restored |
| H8 | `element_call.url` removed from `element-config.json` | zero behavior change on EW 1.12.20 (key is not read; widget is bundled, backend comes from `.well-known` rtc_foci) | EW stays on 1.12.x until revisited | dev browser: widget URL is `/widgets/element-call/…`; call connects |

## Tasks

### T1 — lk-jwt-service: explicit access allowlist + pin (C1/C2/S2) — **Hypotheses:** H1, H2
`docker-compose.yml` (lk-jwt-service): add `LIVEKIT_FULL_ACCESS_HOMESERVERS: "matrix.inblock.io"` (verify server_name vs `${MATRIX_HOST}` in env templates); pin `image:` to the newest upstream release tag (record digest in a comment). Document the var in `env.example`/`.env-template`. **Ordering note for every environment: the env var must be present before the pinned image first boots.**

### T2 — Pin Synapse base image (C3) — **Hypotheses:** H2
`dockerfiles/Dockerfile`, `real-stack/Dockerfile.synapse`: `FROM matrixdotorg/synapse:v<currently-running prod version>` — pin to what prod runs today (no accidental upgrade); upgrades become deliberate.

### T3 — livekit.yaml hygiene (C9/S1) — **Hypotheses:** H3
Delete the `keys: placeholder:` block from `config/livekit.yaml` (matching `livekit.e2e.yaml`); confirm no `development: true` anywhere.

### T4 — Move UDP media range out of the ephemeral range (C6) — **Hypotheses:** H4
`config/livekit.yaml` + `docker-compose.yml`: 50100–50200 → 20100–20200 (matching e2e). Execution includes opening 20100:20200/udp on the **dev** firewall before validation. Prod firewall change goes into the promotion runbook only.

### T5 — Caddy: block public Twirp + fix bare SFU path (S3, latent-404) — **Hypotheses:** H5, H6 — *lands together with T6*
`Caddyfile.production` (+ `.e2e`/`.local` parity): 403 `/livekit/sfu/twirp/*` for non-internal clients; make the SFU route match bare `/livekit/sfu` as well (LiveKit's Twirp management API shares port 7880 with signaling, JWT-only auth, no upstream disable flag — proxy block is the only mitigation).

### T6 — Route lk-jwt's RoomService calls internally (C7) — **Hypotheses:** H5
**Outcome: NOT POSSIBLE at v0.5.0 — fallback taken.** `LIVEKIT_URL` is the only
LiveKit-facing URL the binary has; it is both the client-facing SFU URL and the
endpoint of the server-side RoomService client, and no released version exposes an
override for the latter (`LIVEKIT_CS_API_URL_OVERRIDES` on `main` is the Matrix
CS-API, not LiveKit). Pointing it at `http://livekit:7880` would fix the hairpin
and break every client. So `LIVEKIT_URL` stays public and T5's Twirp block is
scoped to non-private `remote_ip` instead of an unconditional 403.

**This leaves ONE unverifiable assumption, and it gates promotion.** The 403 is
correct only if lk-jwt's hairpin (container → public DNS name → back into the same
host → Caddy) presents a private source address to Caddy. Docker's NAT normally
makes it so, but a floating/anchor IP or an egress path that leaves and re-enters
the network would present a public one — and then **full-access room creation
starts 403ing and calls break**. It cannot be tested off-box. **MANDATORY on
dev-staging before any prod promotion:** start a call as a local user, confirm
lk-jwt's CreateRoom succeeds, and confirm the `remote_ip` Caddy saw for that Twirp
request is private. If it is public, the block must become path/method-scoped or
move to an `extra_hosts` + internal-listener arrangement before promotion.

### T7 — Re-assert Synapse MatrixRTC config on every boot (C5) — **Hypotheses:** H7
`entrypoints/matrix_server.sh`: move the MatrixRTC/msc/rc yq block out of the `if [ ! -f /data/homeserver.yaml ]` guard into an always-run idempotent section. (Prod values are live today; this prevents the documented recurrence where template changes silently never apply.)

### T8 — element-config cleanup (C4-phantom) — **Hypotheses:** H8
Remove `element_call.url` from `config/element-config.json` (no-op at EW 1.12.20, prevents a future version silently loading the third-party widget). Keep `use_exclusively: true`.

### T9 — livekit healthcheck + dependency (C10) — no hypothesis, quality
Compose: HTTP healthcheck on livekit 7880; add `livekit` to lk-jwt-service `depends_on`.

### T10 — Validation gate (dev-staging + e2e)
1. Local hermetic e2e harness run (`e2e-harness/up.sh`) green.
2. Dev-staging: apply config to the dev stack (stack dir is **not** a git checkout — configs are scp'd/bind-mounted), open dev firewall for the new UDP range, converge, then run the checklist below.
3. Only then: write the prod promotion runbook (digest pin, env-var-before-pull ordering, UFW change, verification curls). **Prod deployment itself is manual and out of scope.**

## Review status (2026-08-01, review lead)

Verified locally during review — no dev-staging evidence needed:

- **H2 (lk-jwt half):** GHCR tag `0.5.0` resolves to `sha256:29918567…`; `v0.5.0` does not exist as a tag. Same digest as `latest` today, so the pin is byte-identical to what prod runs.
- **H1 (startup half):** the pinned digest exits immediately with `LIVEKIT_FULL_ACCESS_HOMESERVERS environment variable must be set` when the var is absent, and echoes the parsed list at startup when present. The old "wildcard warning" is gone at this version, so its *absence* proves nothing — check the echoed value instead.
- **H3:** livekit v1.12.0 boots clean from the `keys:`-less `config/livekit.yaml` with only `LIVEKIT_KEYS` in the env.
- **H4 (config half):** the same boot logs `rtc.portICERange [20100, 20200]`. The firewall/media half is still live-only.
- **H5 (Caddy half) + H6:** `caddy validate` passes on all three Caddyfiles; the adapted JSON puts `/livekit/sfu/twirp/*` ahead of `/livekit/sfu/*` in one mutually-exclusive group, and `private_ranges` expands to 10/8, 172.16/12, 192.168/16, 127.0.0.1/8, fd00::/8, ::1. Live-served: bare `/livekit/sfu` reaches the upstream as `/` (it is NOT matched by `/livekit/sfu/*`), twirp paths strip correctly, and the `remote_ip` matcher fires as expected in both directions. What remains unverifiable is only H5's source-address assumption (T6).
- **T9:** the healthcheck command works against the real image; LiveKit answers `406` on `GET /` until its first node-stats tick (~8s from container start, mostly the `use_external_ip` STUN lookup), then `200 OK`. `start_period: 30s` covers it.

Scope added during review (defects found against the plan):

- `docker-compose.dev-staging.yml` mounts the SAME `config/livekit.yaml` but still published `50100-50200/udp` — that alone would have killed media on the box the validation gate runs on. Given the same pin, healthcheck and `depends_on` as production so dev validates what prod will run.
- `docker-compose.e2e.yml` published `50100-50200/udp` against a `20100-20200` config (pre-existing drift; the live `up.sh` path was already correct).
- Stale `50100-50200` in `CLAUDE.md`, `skills/matrix-rtc-transport-specialist.md` (which also still taught the `keys:` placeholder) and the dev-aquafire ufw runbook.

Known, deliberately not fixed here:

- `e2e-harness/up.sh` still runs `lk-jwt-service:latest` unpinned with `LIVEKIT_FULL_ACCESS_HOMESERVERS="*"`. Harmless in a hermetic single-homeserver harness, but it means the harness does not exercise the pinned binary. Pinning it invalidates any earlier green run, so it belongs with the next harness run, not this diff.
- `docker-compose.local.yml` has no `livekit`/`lk-jwt-service` service at all, so `Caddyfile.local`'s `/livekit/*` routes (old and new) point at upstreams that do not exist there. Pre-existing.
- **T7 reaches a deployed box only through a rebuilt Synapse image.** `entrypoints/matrix_server.sh` is baked in at build time, so the re-assert does nothing until the synapse image is rebuilt and its digest promoted.

## Dev-staging validation checklist

- [ ] `ufw allow 20100:20200/udp` applied BEFORE converging; old 50100 rule left until calls pass.
- [ ] lk-jwt logs `LIVEKIT_FULL_ACCESS_HOMESERVERS: [dev.matrix.inblock.io]` — an explicit host, not `[*]` — and the container is not restart-looping.
- [ ] `docker image inspect` digests match the pins for lk-jwt and synapse after a `compose pull`.
- [ ] `docker compose ps` shows livekit `healthy` and lk-jwt started after it (the new `depends_on` gate).
- [ ] `ss -ulnp` shows the SFU bound across 20100-20200 and nothing left on 50100-50200; a test call moves rtpStats packets > 0.
- [ ] **Twirp hairpin (T6, gates promotion):** a local-user call sets up, lk-jwt's CreateRoom succeeds, and Caddy saw a PRIVATE `remote_ip` for that `/livekit/sfu/twirp/*` request.
- [ ] `curl` `/livekit/sfu/twirp/livekit.RoomService/ListRooms` from off-box → 403.
- [ ] `curl -w '%{http_code}' https://dev.matrix.inblock.io/livekit/sfu` → 200, not 404.
- [ ] After a `docker compose restart matrix_synapse` on a REBUILT synapse image: the MatrixRTC block is re-asserted (delete `rc_message` from the live `homeserver.yaml`, restart, confirm it is back).
- [ ] Element browser check: the call widget URL is the bundled `/widgets/element-call/…`, and a call connects (H8).

## Boundary conditions
- Work in a fresh git worktree off `main`; do not touch the dirty `fix/4s-tombstone-probe` checkout.
- Config/deploy files only; no service source code.
- Nothing is applied to prod by this pipeline. Dev-staging changes are reversible and coordinated (firewall additions additive).
- Never `mv`/`sed -i` the bind-mounted portal Caddyfile on prod (promotion runbook must respect this).
- Out of scope: TURN/coturn for legacy VoIP (legacy is disabled via `use_exclusively`), LiveKit embedded TURN enablement (needs 443/5349 planning — record as future work), the mis-nested Synapse retention block (separate known issue, needs Tim's intent), apex-domain `.well-known` 404, focus_selection interop divergence (upstream, tracking only).
