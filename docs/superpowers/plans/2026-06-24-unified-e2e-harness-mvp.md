# Plan: Unified Local E2E Harness — Hermetic-core MVP

**Date:** 2026-06-24
**Logic model:** `docs/2026-06-24-unified-e2e-harness-logic-model.md`
**Branches:** `siwx-oidc-matrix-server@feat/unified-e2e-harness-mvp`; siwx-oidc tests in worktree `~/siwx-oidc-e2eh@feat/unified-e2e-harness-tests` (based on `main@3f40485`).

## Hypothesis Register

| ID | If | Then | Assumptions | Verification |
|----|-----|------|-------------|--------------|
| H1 | I lift livekit+lk-jwt verbatim into `docker-compose.e2e.yml` (distinct ports) + `gen-e2e-env.sh` + `Caddyfile.e2e` | `compose up` → all services healthy; `.well-known/matrix/client` advertises LOCAL issuer (`:18081/`) + LOCAL `org.matrix.msc4143.rtc_foci` | podman compose works; ports 18080/18081/18448/7880/7881 free; images pullable | `podman compose -f docker-compose.e2e.yml --env-file .env.e2e up -d`; curl: oidc `/.well-known/openid-configuration`=200, synapse `/_matrix/client/versions`=200, livekit `:7880`=ws, lk-jwt reachable, well-known shows local issuer+foci |
| H2 | I write `e2e-harness/run.sh` (build/up/wait-healthy/seed/run/collect/down + trap) | `run.sh smoke` brings up, runs 1 test/area, tears down clean even on failure; `artifacts/<run-id>/` populated | health endpoints stable | `bash e2e-harness/run.sh smoke; echo $?`; `ls artifacts/<run-id>/`; `podman ps` empty after |
| H3 | I add the seed step + 1-line `mock_seed_device` fix in `e2e_account_management.rs::account_action_csrf_mismatch_is_unauthorized` | fresh wallets pass the new-user gate; CSRF test + h9-style device/account tests stop 400ing for lack of seed | mock `/__seed_*` hooks work; real Synapse seed via one-time login | `cargo test --test e2e_account_management account_action_csrf_mismatch_is_unauthorized -- --ignored` PASS |
| H4 | I point `SIWX_E2E_*` at the local stack (isolated store root), zero connector code changes | connector messaging+media+RTC-signaling green | crypto store isolated per run; identities seeded (H3) | `SIWX_E2E_*=… cargo test --test e2e --features e2e` → e2ee_bidirectional_messaging, e2ee_media_exchange, rtc_jwt_handshake, rtc_room_alias_matches_element_call, rtc_member_advertise PASS |
| H5 | I point `SIWEOIDC_HOST`/`MATRIX_HOST` at the local stack | siwx-oidc real-stack tests green vs local Synapse, no prod | seed (H3); Caddy method-routes present | `SIWEOIDC_HOST=http://localhost:18081 MATRIX_HOST=http://localhost:18448 cargo test --test e2e_msc3861/e2e_msc4191_live/e2e_session_teardown -- --ignored` PASS |
| H6 | I write `tests/e2e_device_code.rs` driving RFC 8628 (reusing wallet helpers) | RED→GREEN: device_authorization→wallet-approve→token(device_code)→introspect active + Synapse device provisioned | device-code endpoints live in `device_auth.rs`; wallet helper reusable | `cargo test --test e2e_device_code -- --ignored` PASS |
| H7 | Two participants publish+subscribe audio AND video over LOCAL LiveKit (minimal mechanism) | each asserts a subscribed remote audio track AND remote video track (`saw_remote_av`), exit 0 | LiveKit UDP works on WSL bridge; a minimal client (lk CLI/load-test) is containerizable | run the AV check vs local LiveKit; assert remote audio+video subscribed; exit 0 |
| H8 | All wired suites + AV check folded into `run.sh smoke\|full` | `run.sh full` runs everything, collects results, green twice consecutively | all H1–H7 hold | `bash e2e-harness/run.sh full` ×2 → exit 0 both; artifacts present |

---

## Tasks

### Task A1: Hermetic stack — `docker-compose.e2e.yml` + `gen-e2e-env.sh` + `Caddyfile.e2e`
**Hypotheses:** H1
**Files (create, in `siwx-oidc-matrix-server@feat/unified-e2e-harness-mvp`):** `docker-compose.e2e.yml`, `scripts/gen-e2e-env.sh`, `Caddyfile.e2e`, `config/livekit.e2e.yaml` (or reuse `config/livekit.yaml`).
- Lift `livekit` (`livekit/livekit-server:v1.12.0`, `--config`, `LIVEKIT_KEYS`, 7881/tcp+50100-50200/udp) and `lk-jwt-service` (`ghcr.io/element-hq/lk-jwt-service:latest`, `LIVEKIT_URL`/`KEY`/`SECRET`, `LIVEKIT_JWT_BIND=:8080`, `LIVEKIT_INSECURE_SKIP_VERIFY_TLS=true`) verbatim from prod `docker-compose.yml`.
- siwx-oidc: build from `~/siwx-oidc-e2eh` (== main@3f40485) OR run the `siwx-oidc:local-grace` image; Synapse from `real-stack/Dockerfile.synapse`; redis; caddy(`Caddyfile.e2e`).
- Ports: caddy-edge 18080, oidc 18081, synapse 18448, livekit 7880/7881+udp. `.well-known` issuer `http://localhost:18081/` (trailing slash, byte-match Synapse msc3861.issuer) + `org.matrix.msc4143.rtc_foci → http://localhost:18080/livekit/jwt`.
- `gen-e2e-env.sh`: MAS secret (64 alnum), `LIVEKIT_KEY=API$(openssl rand -hex 8)`, `LIVEKIT_SECRET=$(openssl rand -base64 32)`, ES256 PEM (`openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256` → single-line `\n`).
- **Done-when:** H1 verification all green; do NOT disturb `siwx-real-*`/`aqua-agent-*`.

### Task A3: Seed step + 1-line seed fix
**Hypotheses:** H3
**Files:** harness seed helper (in `e2e-harness/`); `~/siwx-oidc-e2eh/tests/e2e_account_management.rs` (add the missing `mock_seed_device(...)` in `account_action_csrf_mismatch_is_unauthorized`).
- **Done-when:** H3 verification PASS.

### Task A4: Wire connector suite (env-only)
**Hypotheses:** H4
**Files:** none modified — invocation/env only (record in `e2e-harness/adapters/connector.sh`).
- **Done-when:** H4 verification PASS (isolated `SIWX_E2E_STORE_ROOT`).

### Task A5: Wire siwx-oidc real-stack tests (env-only)
**Hypotheses:** H5
**Files:** none modified — invocation/env only (`e2e-harness/adapters/siwx-oidc.sh`).
- **Done-when:** H5 verification PASS.

### Task A6: New headless device-code test (RFC 8628)
**Hypotheses:** H6
**Files (create):** `~/siwx-oidc-e2eh/tests/e2e_device_code.rs` (reuse wallet helpers from `tests/e2e_race_teardown.rs`).
- **Done-when:** H6 verification RED→GREEN.

### Task A6.5: Minimal AV-establishment check (MVP-required)
**Hypotheses:** H7
**Files (create):** `e2e-harness/av-check/` (LiveKit CLI/`lk` load-test or thin client, containerized; JWT via lk-jwt-service or key/secret-signed).
- **Done-when:** H7 verification — remote audio AND remote video subscribed, exit 0. Minimal: NO Deepgram/transcript/libwebrtc-from-source/aqua-agents (that is A7).

### Task A2 + A8-lite: Orchestrator tiers + artifacts
**Hypotheses:** H2, H8
**Files (create):** `e2e-harness/run.sh` + `e2e-harness/adapters/*`.
- Fold A3–A6.5 into `smoke` (1/area incl. AV) and `full` (all); artifact collection; trap teardown.
- **Done-when:** H2 + H8 verification — `run.sh full` green twice consecutively.

---

## Execution order (PERT/CPM)
1. **A1** (serial gate) → verify healthy.
2. **A3** (serial, fast) → unblocks suites.
3. **A4 ∥ {A5→A6} ∥ A6.5** (fan-out; {A5,A6} share one siwx-oidc target dir so run sequentially in one worker; cap concurrency for memory governance).
4. **A2 + A8-lite** (serial) → `run.sh full` ×2.
5. **Audit** (Phase 3): hypothesis trace + acceptance-criteria check.
