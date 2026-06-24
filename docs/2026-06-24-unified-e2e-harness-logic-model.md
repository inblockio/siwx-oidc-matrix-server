# Unified E2E Harness — Logic Model + Execution Plan (scope-locked)

**Date:** 2026-06-24
**Status:** EXECUTION. Scope confirmed by operator.
**Companion:** `docs/2026-06-24-unified-e2e-harness-plan.md` (the survey/P0–P7 reference).
**Method:** logic-model (Kellogg/OECD-DAC results chain; PERT/CPM dependency graph; Ashby requisite-variety → decompose via process-pipeline subagents).

---

## Scope decision (operator-confirmed)

- **Build the Hermetic-core MVP now (A1–A6 + A8-lite).**
- **The MVP MUST establish working audio + video channels** over local LiveKit — **minimally** (A6.5). "Minimal" = a real call is established, an audio track AND a video track are published and subscribed, and each side asserts it received remote audio + remote video. NO Deepgram STT, NO transcript pipeline, NO full 12-check fidelity in the MVP.
- **A7 (full call-MEDIA + the transcript agent) is a SEPARATE agent/workstream** that **crosses over the SIWX harness**: it targets the *same* hermetic `docker-compose.e2e.yml` stack + orchestrator the MVP produces, but is built and run independently and does not block the MVP. Heavy deps (prebuilt libwebrtc `LK_CUSTOM_WEBRTC`, Deepgram, aqua-agents source edits, WSL-UDP media fidelity) live here.
- **Deferred:** full CI gating (A8 keeps local smoke|full tiers + artifact collection, not PR/nightly CI wiring).

---

## GOAL (one sentence)

Stand up one hermetic, podman-local, headless stack + one orchestrator that points the existing **unmodified** siwx-oidc, connector, and call suites at it — covering encrypted messaging+media, RTC signaling, **established audio+video call media (minimal)**, device/account lifecycle, and headless device-code login — with deterministic up→seed→run→collect→teardown.

**Acceptance:** `e2e-harness/run.sh smoke` → stack healthy, ≥1 green test per surface (incl. a minimal AV-establishment check), artifacts under `artifacts/<run-id>/`, clean teardown, **zero prod endpoints touched**.

---

## Defaults (decided, not asking)

- **Canonical siwx-oidc build source:** a **clean `main` checkout** (the `~/siwx-oidc-grace` worktree == `main@3f40485`, with the grace fix), NOT the dirty `../siwx-oidc` audit branch. (Alternatively the prebuilt `localhost/siwx-oidc:local-grace` image; implementer picks whichever yields a reproducible build.)
- **New hermetic stack**, not adoption of the hand-rolled `siwx-real-*`. Leave `siwx-real-*` and all `aqua-agent-*` containers untouched.
- **Distinct ports** (siwx-real-* holds host 8081/8448/8450). Proposed e2e block: Caddy-edge `18080`, siwx-oidc `18081`, Synapse-direct `18448`; LiveKit `7880` internal + publish `7881/tcp` + `50100-50200/udp` (free). Implementer confirms no collision (`ss -ltnp`, `podman port`) and emits matching `.well-known` + Caddyfile.e2e (issuer must byte-match per RFC 8414, trailing slash).
- **Anchor everything in `siwx-oidc-matrix-server`**; it path-invokes the connector + (for A7) aqua-agents test binaries.

---

## Activity chain (falsifiable; dependency-ordered)

| # | Activity → Output | Done-when (OUTCOME, not output) | Deps | Files / where |
|---|---|---|---|---|
| **A1** | `docker-compose.e2e.yml` + `scripts/gen-e2e-env.sh` — full local stack **incl. livekit + lk-jwt-service** (lifted verbatim from prod `docker-compose.yml` + `config/livekit.yaml`), distinct ports, `.env.e2e` (MAS secret, LIVEKIT_KEY/SECRET, ES256 PEM) | `podman compose -f docker-compose.e2e.yml --env-file .env.e2e up -d` → ALL healthy; `curl` siwx-oidc `/.well-known/openid-configuration`, Synapse `/_matrix/client/versions`, LiveKit `:7880`, lk-jwt OK; `.well-known/matrix/client` advertises **local** issuer + **local** `org.matrix.msc4143.rtc_foci` | — | `siwx-oidc-matrix-server/` (new compose, `scripts/gen-e2e-env.sh`, `Caddyfile.e2e`) |
| **A2** | orchestrator `e2e-harness/run.sh` (build → up → wait-healthy → seed → run → collect → down; trap-based teardown; `smoke`\|`full` tiers) | `run.sh smoke` brings stack up, runs 1 test/area, tears down clean (trap fires on failure too); `artifacts/<run-id>/` has logs + per-suite exit codes | A1 | `siwx-oidc-matrix-server/e2e-harness/` |
| **A3** | seed step (provision throwaway identities; make test wallets "existing" via mock `/__seed_user|device` or one-time real login) **+ 1-line `mock_seed_device` fix** in `e2e_account_management.rs::account_action_csrf_mismatch_is_unauthorized` | fresh wallets pass the **new-user gate**; the CSRF test + h9-style device/account tests no longer 400 for lack of seed | A1 | siwx-oidc `tests/`, harness seed helper |
| **A4** | wire connector suite (env only, ZERO code changes): `SIWX_E2E_*` → local stack, isolated `SIWX_E2E_STORE_ROOT` per run | `e2ee_bidirectional_messaging` + `e2ee_media_exchange` + `rtc_jwt_handshake` + `rtc_room_alias_matches_element_call` + `rtc_member_advertise` green vs local | A1, A3 | `aqua-matrix-agent` (invocation only) |
| **A5** | wire siwx-oidc real-stack tests (env only): `SIWEOIDC_HOST=…:18081 MATRIX_HOST=…:18448` → local | `e2e_msc3861` / `e2e_msc4191_live` / `e2e_session_teardown` green vs local Synapse, **no prod** | A1, A3 | siwx-oidc `tests/` (invocation only) |
| **A6** | **NEW** `tests/e2e_device_code.rs` — headless RFC 8628 (reuse wallet helpers from `e2e_race_teardown.rs`) | RED→GREEN: `POST /device_authorization` → wallet-signed `POST /device` approve → poll `POST /token` (device_code grant) → introspect = active + Synapse device provisioned | A1, A3 | siwx-oidc `tests/e2e_device_code.rs` |
| **A6.5** | **NEW (MVP-required) minimal AV-establishment check** — a real call over **local** LiveKit: publish audio+video, subscribe, assert remote audio AND remote video seen. Lightest robust mechanism (prefer LiveKit CLI/`lk` load-test or a thin client against local LiveKit; JWT via lk-jwt-service if cheap, else key/secret-signed). NO Deepgram/transcript. | two participants on the local LiveKit room each report a subscribed **remote audio track AND remote video track** (the `saw_remote_av` invariant), exit 0 | A1 | `siwx-oidc-matrix-server/e2e-harness/` (containerized check) |
| **A8-lite** | tiers + artifacts wired into `run.sh` (smoke = 1/area incl. AV; full = all) | `run.sh full` runs every wired suite, collects machine-readable results + logs; one command | A2, A4–A6.5 | orchestrator |

A3–A6.5 are largely **independent post-A1** (different suites/files) → fan out via process-pipeline subagents; **A1 must land + verify healthy first**, then A3 (seed) early since A4/A5/A6 consume it.

---

## A7 — SEPARATE crossover agent (NOT in the MVP pipeline)

**Scope:** full call-MEDIA + transcript-agent e2e (aqua-agents `aqua-e2e` 12 checks + Deepgram STT + transcript pipeline) pointed at the **same** hermetic e2e stack ("crosses over the SIWX harness").
**Required edits/deps (why it's heavy + separate):** aqua-agents source edits (`aqua_e2e.rs` `agent_config` prod defaults → env-overridable; `jwt.rs` hardcoded LiveKit endpoint → env/getter); prebuilt `LK_CUSTOM_WEBRTC` libwebrtc; `~/.aqua-secrets/deepgram.env` (STT, isolatable sub-check); validating LiveKit UDP media fidelity on the WSL bridge.
**Crossover contract:** consumes the MVP's `docker-compose.e2e.yml` + `.env.e2e` (local Matrix + local lk-jwt/LiveKit) and runs under the same `e2e-harness/run.sh` as an opt-in `--with-calls`/`full+` tier. Built/run independently; does not gate the MVP.

---

## Boundary conditions

- **Invariants:** do NOT rewrite existing tests (env-wiring only) — sole exceptions: the new `e2e_device_code.rs`, the new A6.5 AV check, and the 1-line seed fix. **Never touch prod** (`matrix.inblock.io` / `siwx-oidc.inblock.io`). **Do not disturb** running `siwx-real-*` / `aqua-agent-*` containers. All services in **podman** (WSL SIGKILLs host-bound listeners). E2E stack uses **distinct ports**.
- **Assumptions (annotate edges):** `podman compose` available; LiveKit UDP works on the WSL bridge well enough to subscribe AV (only matters for A6.5/A7); Playwright image pullable; openssl/cargo present; GREEN memory headroom holds (governance: if a subagent spawn is admission-denied, run that step **inline & sequentially**, don't retry).
- **Top risks (assumption inverted):** (1) **port/stack collision** with siwx-real-* → distinct ports + pre-flight check; (2) **new-user gate** blocks fresh wallets → A3 seed is load-bearing for A4/A5/A6; (3) **crypto-store collision** across homeserver URLs → per-run isolated `SIWX_E2E_STORE_ROOT`.
- **Convergence (loop exit):** iterate up→run→fix until `run.sh full` (MVP scope) is green twice consecutively.

---

## Parallelization for process-pipeline

1. **Phase 1 (serial):** A1 → bring stack up → verify healthy (gate). 
2. **Phase 2 (serial, fast):** A3 seed + 1-line fix (unblocks the rest).
3. **Phase 3 (fan-out, parallel):** A4 (connector) ∥ A5 (siwx real-stack) ∥ A6 (device-code test) ∥ A6.5 (minimal AV). Each validates against the live A1 stack; isolated store roots; independent files.
4. **Phase 4 (serial):** A2/A8-lite — fold all into `run.sh` smoke|full + artifacts; run `full` twice to confirm convergence.
5. **Separate:** A7 crossover agent, after/independent.
