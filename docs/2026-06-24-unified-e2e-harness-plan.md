# Unified E2E Test Harness — Planning Doc

**Date:** 2026-06-24
**Status:** PLAN ONLY. Execution happens in a NEW session.
**Author context:** produced from a 4-subagent survey of siwx-oidc, aqua-matrix-agent (connector), aqua-agents (call/transcript), siwx-oidc-matrix-server.

> **Core principle (per the request): DO NOT REWRITE existing tests.** Almost the
> entire target surface is ALREADY covered by automated, headless tests. They are
> just **siloed across three repos and pointed at production**. The job is to
> **orchestrate** them against **one hermetic local stack**, fill the **one real
> gap** (a headless device-code / QR login test), and wrap it in best-practice
> init/teardown. Orchestrate, don't re-implement.

---

## 1. What already exists (reflected back)

### siwx-oidc (`~/siwx-oidc-grace` = main)
Three tiers, orchestrated by `e2e/run-all.sh`:
- **Unit** (~45–103 tests, CI-gated): `cargo test --bin siwx-oidc` (needs Redis).
- **HTTP E2E** vs a Python **mock Synapse** (`e2e/synapse_mock.py`, with `/__seed_user`, `/__seed_device`, `/__fail` hooks) brought up by `e2e/up.sh` (podman: Redis + mock + siwx-oidc). Files: `e2e_account_management`, `e2e_race_teardown` (incl. our new `refresh_grace_window_tolerates_replay`), `e2e_oauth_binding`, plus prod-pointing `e2e_msc3861` / `e2e_msc4191_live` / `e2e_session_teardown` / `e2e_messaging`.
- **Browser** (Playwright + CDP WebAuthn virtual authenticator) vs the mock stack: `account.spec.mjs`, `device-lifecycle.spec.mjs` (incl. device-code approval page + new-user gate), `stale-credential.spec.mjs`, `passkey-scoping.spec.mjs`.
- **Real-stack edge:** `e2e/real-stack-edge.sh` (Caddy method-route mirroring prod). The REAL stack itself is the `siwx-oidc-matrix-server` recipe (no single bring-up script today).

### aqua-matrix-agent / aqua-matrix-connector (the "test agents")
**8 automated, headless tests behind `--features e2e`** in `crates/aqua-matrix-agent/tests/e2e.rs`, env-parameterized (`SIWX_E2E_KEY_A/B`, `SIWX_E2E_SIWX_URL`, `SIWX_E2E_MATRIX_URL`, `SIWX_E2E_STORE_ROOT`), **already runnable against a local stack**:
- `e2ee_bidirectional_messaging` (R-K1), `e2ee_device_logout_history_survives` (R-K2, gated `SIWX_E2E_RUN_RK2=1`), `streaming_rollover...`, `durable_journal...`, `e2ee_media_exchange` (image/file/voice), and RTC **signaling**: `rtc_jwt_handshake`, `rtc_room_alias_matches_element_call`, `rtc_member_advertise`.
- `examples/chat_e2e_driver.rs` drives a live daemon (semi-manual; daemon must be running).
- All merged to main. **Calls here are signaling only** (matrix-sdk 0.17 has no WebRTC media).

### aqua-agents (call + transcript)
- **`aqua-e2e` binary** (`crates/aqua-call-agent/src/bin/aqua_e2e.rs`): ONE process drives TWO agent identities through **12 checks** — text/file/image/voice both directions, **plus real audio+video call MEDIA** (publishes I420 video + audio, asserts `CallSummary::saw_remote_av()` = subscribed to remote video AND audio track), **plus Deepgram STT** (≥80% phrase word-coverage). Headless, exit 0/1. Run: `cargo run -p aqua-call-agent --bin aqua-e2e` with `~/.aqua-secrets/deepgram.env` + `LK_CUSTOM_WEBRTC` (prebuilt libwebrtc). **Currently points at prod** `matrix.inblock.io` + Deepgram.
- 280 unit tests (`cargo test --lib`); transcript pipeline tests use real ffmpeg on saved artifacts. All branches merged.

### siwx-oidc-matrix-server (the deployment + stack)
- **`docker-compose.yml`** = full prod stack incl. **LiveKit v1.12.0 + lk-jwt-service**.
- **`docker-compose.local.yml`** = Synapse + siwx-oidc (built from `../siwx-oidc`) + Element + Caddy (HTTP, ports 8080/8081/8088) — **but NO LiveKit** (so calls can't run locally yet).
- `start-matrix.sh` generates `.env` (MAS_SHARED_SECRET, LIVEKIT_KEY/SECRET, ES256 signing key).
- Synapse experimental_features: MSC3861, MSC4108 (QR rendezvous), MSC4143 (MatrixRTC). `.well-known` advertises the LiveKit focus.
- RFC 8628 device-code endpoints all live in siwx-oidc `device_auth.rs` and are HTTP-drivable headlessly (`/device_authorization` → `/device` wallet/passkey approve → `/token` device_code grant).

---

## 2. Coverage matrix vs the target surface

| Surface | Existing automated coverage | Headless? | Runs locally today? | Verdict |
|---|---|---|---|---|
| **E2E encrypted messaging** | connector `e2ee_bidirectional_messaging`, `e2ee_media_exchange`, `streaming_rollover`, `durable_journal`; aqua-e2e text/file/image/voice | Yes | **Yes** (connector via `SIWX_E2E_*`); aqua-e2e against prod | **Covered** — just wire to local stack |
| **Device registration** | siwx-oidc `e2e_race_teardown`/`e2e_msc4191_live`, browser `device-lifecycle.spec`, `synapse_client` units | Yes | mock stack yes; real stack no script | **Covered** (mock) — extend to real local stack |
| **Account/device lifecycle + teardown** | siwx-oidc `e2e_account_management`, `e2e_session_teardown`, `e2e_race_teardown` (H1–H14), R-K2 survival | Yes | mock + prod | **Covered** |
| **Audio call establishment (real media)** | aqua-agents `aqua-e2e` (saw_remote_av audio track) | Yes | **No — prod LiveKit only** | **Covered but prod-bound** → add LiveKit to local stack |
| **Video call establishment (real media)** | aqua-agents `aqua-e2e` (I420 publish + remote video track) | Yes | **No — prod LiveKit only** | **Covered but prod-bound** → add LiveKit to local stack |
| **RTC signaling (JWT/alias/membership)** | connector `rtc_jwt_handshake`, `rtc_room_alias...`, `rtc_member_advertise` | Yes | connector can target local | **Covered** |
| **Headless QR / device-code login** | endpoints exist + browser approval page; RFC 8628 fully drivable | partially | mock browser only | **GAP** — no headless end-to-end device-code test |
| **Call transcripts (STT)** | aqua-e2e Deepgram STT check; aqua-agents unit tests | Yes | needs Deepgram key | Covered (external dep) |

---

## 3. The real gaps (what's actually missing)

1. **No single hermetic local stack that ALL suites target.** Three suites, three invocation styles, three pointing conventions (mock Synapse / `SIWX_E2E_*` / prod). Call media has **no local LiveKit** at all.
2. **No unified orchestrator.** Each repo has its own runner; nothing builds one stack, waits for health, seeds identities, runs all suites against it, collects artifacts, and tears down.
3. **Call tests run against PRODUCTION** (`matrix.inblock.io` + the operator's real room + a prod Deepgram key). Risky and non-hermetic. `local` compose lacks LiveKit + lk-jwt.
4. **No automated device-code / "QR" login test** (the one genuine functional gap). The flow is HTTP-drivable but untested end-to-end headlessly.
5. **Fixtures/secrets/identities are ad hoc** (PEM keys in `/tmp`, prod identities, `~/.aqua-secrets/deepgram.env`). No managed, throwaway, per-run identity set.
6. **E2E tiers are not in CI** (all `#[ignore]` / manual). No smoke-vs-full tiering, no artifact collection.
7. **External dependency: Deepgram** for STT. Call MEDIA (`saw_remote_av`) likely verifiable without it; must confirm STT is an isolatable sub-check.

---

## 4. Target design — one hermetic stack, one orchestrator, zero rewrites

### 4.1 Hermetic local stack: `docker-compose.e2e.yml` (anchor repo: `siwx-oidc-matrix-server`)
Extend `docker-compose.local.yml` with the call services so the WHOLE surface runs locally:
- Redis, **Synapse** (MSC3861/4108/4143), **siwx-oidc** (build from `../siwx-oidc-grace`, or the `siwx-oidc:local-grace` image we just built), Element Web (optional), Caddy (HTTP edge, mirrors prod method-routes for `/refresh` `/logout` etc.).
- **LiveKit v1.12.0 + lk-jwt-service** (lift from prod `docker-compose.yml`), TURN disabled (LAN/bridge only), full UDP range exposed.
- A `.well-known` served by Caddy advertising the LOCAL LiveKit focus + `m.authentication` → local siwx-oidc.
- One generated `.env.e2e` (MAS secret, LiveKit key/secret, ES256 signing key) via a `scripts/gen-e2e-env.sh`.
- **All services in podman containers** (WSL sandbox SIGKILLs host-bound listeners). The test runner also runs in a container or on the host pointing at published ports.

### 4.2 Single orchestrator: `e2e-harness/run.sh` (+ `justfile`/`Makefile` targets)
Phases (each idempotent, health-gated):
1. **build** — `siwx-oidc` image (done: `siwx-oidc:local-grace`), Synapse/Element images, ensure `LK_CUSTOM_WEBRTC` libwebrtc is fetched/cached for aqua-e2e.
2. **up** — `podman compose -f docker-compose.e2e.yml --env-file .env.e2e up -d`.
3. **wait-healthy** — poll healthchecks (Redis ping, siwx-oidc `/.well-known/openid-configuration`, Synapse `/health`, LiveKit `:7880`, lk-jwt) before proceeding.
4. **seed** — provision N throwaway identities (generate PEMs), and where the new-user gate applies, pre-seed via the mock or do a one-time login so device/account suites pass (this is why h9 currently fails — fresh wallet hits the gate).
5. **run** — invoke EACH EXISTING suite pointed at the local stack (see adapters below). Tag tiers: `smoke` (1 messaging + 1 device + 1 call-signaling) vs `full` (everything).
6. **collect** — gather JUnit/exit codes, container logs, recordings/transcripts, into `artifacts/<run-id>/`.
7. **down** — `compose down -v` (deterministic teardown), always runs (trap).

### 4.3 Suite adapters (NO code changes — env wiring only)
| Suite | Invocation (pointed at local stack) |
|---|---|
| siwx-oidc unit + mock E2E | reuse `e2e/up.sh` semantics OR point HTTP tests at the e2e stack; `cargo test --bin siwx-oidc`; `cargo test --test e2e_account_management/e2e_race_teardown/e2e_oauth_binding -- --ignored` |
| siwx-oidc real-stack tests | `SIWEOIDC_HOST=http://localhost:8081 MATRIX_HOST=http://localhost:8080 cargo test --test e2e_msc3861/e2e_msc4191_live/e2e_session_teardown -- --ignored` |
| connector messaging + RTC signaling | `SIWX_E2E_SIWX_URL=… SIWX_E2E_MATRIX_URL=… SIWX_E2E_KEY_A/B=… SIWX_E2E_STORE_ROOT=… cargo test --test e2e --features e2e` (+ `SIWX_E2E_RUN_RK2=1`) |
| aqua-agents call media + STT | point `aqua-e2e` at the local stack (Matrix + local lk-jwt/LiveKit); `cargo run -p aqua-call-agent --bin aqua-e2e` with `LK_CUSTOM_WEBRTC` + (optional) Deepgram env |
| browser (passkey/account/device) | `bash e2e/browser/run.sh` (Playwright container) against the e2e stack |

### 4.4 The one NEW test (fills the gap) — headless device-code / QR login
Add (do not rewrite) a single automated test that drives RFC 8628 end-to-end:
`POST /device_authorization` → simulate approval `POST /device` with a real EIP-191 wallet signature (reuse the wallet helpers already in `e2e_race_teardown.rs`) → poll `POST /token` (device_code grant) → introspect the issued token → assert Synapse device provisioned. Lives in siwx-oidc `tests/e2e_device_code.rs` (mirrors existing harness style). **Note the distinction:** this is the siwx-oidc "Element X QR login" (RFC 8628), which IS headless-automatable; MSC4108 rendezvous (Element Web → Element X key transfer) is Synapse-side and remains a stretch/manual item.

### 4.5 Best-practice spine (industry standard)
- **Hermetic & reproducible:** one compose file, pinned image tags, generated secrets, no prod endpoints in the default path.
- **Health-gated startup** (no `sleep`-based races); **deterministic teardown** via trap + `down -v`.
- **Isolated, throwaway identities** per run; never touch prod accounts/rooms (kills the R-K2 / aqua-e2e prod-logout risk).
- **Tiered runs:** `smoke` (fast PR gate) vs `full` (nightly); each suite emits machine-readable results.
- **Artifact collection** (logs, recordings, transcripts, JUnit) under `artifacts/<run-id>/`.
- **CI-able:** the orchestrator runs in one command; gate `smoke` on PRs, `full` nightly. External deps (Deepgram, libwebrtc) feature-flagged so the core runs without them.
- **One source of truth for endpoints** (the `.env.e2e`), consumed by every adapter.

---

## 5. Phased build plan (for the EXECUTION session) — with falsifiable checks

| Phase | Deliverable | Done-when (verification) |
|---|---|---|
| P0 | `docker-compose.e2e.yml` + `gen-e2e-env.sh` (local stack incl. LiveKit + lk-jwt) | `compose up` healthy; `.well-known` advertises local foci; `curl` siwx-oidc + Synapse + LiveKit OK |
| P1 | Orchestrator `e2e-harness/run.sh` (build/up/wait/seed/run/collect/down) + identity seeding | `run.sh smoke` brings up, runs 1 test/area, tears down clean |
| P2 | Wire connector messaging + RTC-signaling suite to local stack (env only) | `e2ee_bidirectional_messaging` + `rtc_*` green against local Synapse |
| P3 | Wire siwx-oidc real-stack tests (msc3861/msc4191/session_teardown) to local stack | green against local Synapse (no prod) |
| P4 | Add `tests/e2e_device_code.rs` (headless RFC 8628) | RED→GREEN; device provisioned + token introspects active |
| P5 | Point `aqua-e2e` (call media) at local LiveKit; confirm media-only path works without Deepgram | `saw_remote_av()` passes locally; STT sub-check gated on Deepgram key |
| P6 | Seed fix for the new-user gate so device/account suites pass (resolves the current h9-style failure) | full suite green locally |
| P7 | Tiers + artifacts + CI wiring (smoke on PR, full nightly) | one-command `run.sh full`; JUnit + logs collected |

---

## 6. Open decisions / risks (resolve at execution)
- **Deepgram dependency:** confirm `aqua-e2e` call MEDIA assertion (`saw_remote_av`) runs WITHOUT a Deepgram key (STT as a separate, key-gated sub-check). If the call phase hard-requires the key, add a mock STT or a `--no-stt` path.
- **libwebrtc (`LK_CUSTOM_WEBRTC`):** large prebuilt dep for aqua-e2e; cache it in the harness image.
- **LiveKit without TURN:** localhost/bridge only (no NAT). Fine for a single-host harness; document it.
- **new-user gate:** the seed step must make test wallets "existing" (mock `/__seed_user` or a pre-login) so device/account/QR suites don't 400 (this is exactly why `e2e_race_teardown::h9` fails today on real Synapse).
- **Anchor repo & cross-repo wiring:** recommend the harness lives in `siwx-oidc-matrix-server` (owns the stack); it path-invokes the connector and aqua-agents test binaries. Decide whether to vendor a `justfile` at each repo or a top-level meta-repo.
- **E2EE store collisions:** keep per-identity, per-run crypto store roots (known footgun: reusing a store across homeserver URLs corrupts one-time keys).

---

## 7. Deployed → local main delta (requested)

**Deployed prod image:** `ghcr.io/inblockio/siwx-oidc:sha-db79e75`.
**Local/origin main (now):** `3f40485`.
**Delta = 2 commits not yet deployed:**

| Commit | Type | Summary |
|---|---|---|
| `3f40485` | fix | refresh-token grace window (Element-X mobile sign-out) — THIS work, on main now |
| `a074795` | revert | drop server-side passkey method-availability prediction + grey-out |

`git diff db79e75..main --stat`: 13 files, +650/−138 — the webauthn method-prediction revert (`axum_lib.rs`, `webauthn.rs` −72, `App.svelte`, `passkey-scoping.spec.mjs`, a design doc) plus the grace fix (`compat.rs`, `db/mod.rs`, `db/redis.rs`, `oidc.rs`, `tests/e2e_race_teardown.rs`, findings + plan docs, CLAUDE.md TTL correction). A prod deploy of `main` ships BOTH. Code-only; no Redis flush; standard manual deploy on `agentic.inblock.io`.

---

## 8. One-line summary
The surface is ~85% already covered by headless automated tests scattered across three repos and aimed at prod. Build **one hermetic local stack (add LiveKit) + one orchestrator that points the existing suites at it + one new device-code/QR test**, and you have a single, maintainable, CI-able harness covering messaging, audio/video calls, device registration, and headless QR — without rewriting a single existing test.
