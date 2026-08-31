# LiveKit embedded TURN for UDP-hostile networks (dev-staging first)

**Status:** EXECUTED + e2e-VERIFIED on dev-staging, 2026-08-02 (~10:40–10:50Z). Gates pre-authorized (unsupervised operator instruction). Successor to the TURN gap recorded in `2026-08-02-video-call-audit.md`.

## Hypothesis trace (all verified with commands, 2026-08-02)

| ID | Status | Evidence |
|----|--------|----------|
| H1 | **Confirmed** | livekit log `Starting TURN server {…portTLS: 5349…portUDP: 3478, relay_range 30000–40000}`; box `ss` shows 5349/tcp + 3478/udp bound; off-box `openssl s_client :5349` served `CN=dev.matrix.inblock.io` (LE, notAfter 2026-10-28) |
| H2 | **Confirmed** | implied by H3: relay-only clients can only work with valid join-response TURN credentials |
| H3 | **Confirmed** | `AQUA_E2E_FORCE_RELAY=1` round vs dev: 13/13 PASS, STT 100% both ways (`~/.cache/aqua-e2e-logs/round5-dev-relay-1245.log`); livekit `participant active` shows remote candidates exclusively `udp relay 207.154.209.…:3xxxx` in the TURN relay range, selected pairs on those same ports (surfacing as prflx `172.21.0.1:<same-port>` because the relay socket is host-local — expected shape, don't misread it) |
| H4 | **Confirmed** | normal round vs dev with TURN on: 13/13 PASS (`round4-dev-turnon-*.log`) |
| H5 | **Confirmed (expected limitation)** | 443 serves Caddy (healthz 200); advertised `turns:…:443` leg inert until the graduation decision |
| H6 | **Confirmed** | sync run with state removed: change → copy → restart → `verification OK` rc=0; second run `up to date… no restart` rc=0; timer active (daily + boot) |
| H7 | **Confirmed** | relay allocations to the public node IP succeeded; zero permission-denied lines in TURN logs |

**Discovered during execution:** (1) the script's post-restart "single external IP" check originally counted raw IPv4s — a healthy entry is an external/local PAIR, so a green line read as 2; fixed to count ips-array elements (commit in this branch). (2) Relay traffic surfaces at the SFU as peer-reflexive `172.21.0.1:<relay-port>` (bridge gateway) — documented in H3 so future log-readers don't mistake it for a candidate leak.
**Scope:** repo config/scripts/docs + dev-staging live deployment + aqua-e2e relay-forced verification. Prod is NOT touched; graduation checklist at the end.

## Context (evidence, all source-verified 2026-08-02)

- LiveKit guidance: ~10–20% of real-world sessions need TURN; today ICE-TCP 7881 is the only UDP fallback.
- livekit-server v1.12.0 embedded TURN (`pkg/service/turn.go`, `config-sample.yaml` @v1.12.0):
  - `turn.udp_port`/`turn.tls_port` have NO compiled defaults — both must be set explicitly or TURN errors "invalid TURN ports".
  - TURN-TLS terminates in-process from `cert_file`/`key_file` (TLS ≥1.2); **no hot-reload** — cert renewal requires a livekit restart.
  - **`turns:` URL advertisement hardcodes port 443** (`roommanager.go` L1035: `fmt.Sprintf("turns:%s:443?transport=tcp", domain)`) regardless of `tls_port`. Caddy owns 443 on dev and prod ⇒ the TLS leg is inert until an SNI/L4-demux or dedicated-IP decision (graduation gate). No wildcard DNS exists for a `turn.` hostname (probed NXDOMAIN).
  - **TURN-UDP is advertised correctly** as `turn:<node-ip>:<udp_port>?transport=udp` (L1028-1032) — functional immediately.
  - Client credentials are minted per-participant (TTL 300s) and delivered in JoinResponse.ice_servers; Rust SDK 0.7.44 and livekit-client JS merge them automatically when the app sets no own ice_servers.
  - v1.12.0 denies TURN relay to restricted (private/loopback/link-local) peer IPs by default; our SFU advertises only the public node IP (after the `rtc.ips.excludes` fix), so no `allow_restricted_peer_cidrs` needed.
  - Relay hop TURN→SFU is host-local; NO extra firewall ports beyond `tls_port` and `udp_port` (LiveKit's own ports-firewall table omits relay_range).
  - `rtc.ips.excludes` does not touch the TURN paths (separate code path; TURN uses NodeIP).
- Dev box (recon 2026-08-02): Caddy certs for dev.matrix.inblock.io at
  `/var/lib/docker/volumes/caddy-proxy_caddy_data/_data/caddy/certificates/acme-v02.api.letsencrypt.org-directory/dev.matrix.inblock.io/` (700 root:root, notAfter 2026-10-28, SAN exactly dev.matrix.inblock.io); livekit container runs as root (can read root-owned mounts); 5349/3478 free; ufw lacks rules for them; box idiom = systemd timers (root unit needed here); direct file bind-mounts of the cert files would pin renewed-away inodes ⇒ sync-copy design.

## Hypothesis register

| ID | If | Then | Assumptions | Verification |
|----|----|------|-------------|--------------|
| H1 | turn enabled with explicit `tls_port: 5349`, `udp_port: 3478`, `domain: dev.matrix.inblock.io`, certs synced to `config/livekit-tls/` | livekit boots TURN; both ports listen; TLS on 5349 serves the LE cert | cert SAN matches domain; container root can read certs | box `ss -tlnp/-ulnp`; `openssl s_client -connect dev.matrix.inblock.io:5349` shows the LE cert; livekit log |
| H2 | TURN enabled | JoinResponse carries per-participant TURN creds (`turns:domain:443` + `turn:<nodeIP>:3478`) | protocol behavior per source | implied by H3 pass (relay-only cannot work without creds) |
| H3 | harness relay-forced round (`ice_transport_type: Relay`) vs dev | 13/13 green ⇒ media traverses the embedded TURN relay (UDP leg) | rust SDK honors Relay; UDP 3478 reachable off-box | `AQUA_E2E_FORCE_RELAY=1` run; livekit/pion allocation log lines; no permission-denied |
| H4 | TURN enabled | normal round still 13/13 (no regression) | — | plain aqua-e2e run vs dev |
| H5 | Caddy owns 443 | advertised `turns:…:443` leg cannot connect (EXPECTED limitation, documented) | — | curl/openssl against 443 shows Caddy; documented in skill + this doc |
| H6 | cert-sync script + daily root timer | renewed certs propagate; livekit restarted only on checksum change | Caddy renews in place (atomic rename) | manual run ×2 (2nd = no restart); state-file removal simulates change ⇒ restart + TURN re-verified |
| H7 | SFU advertises public IP only | v1.12 restricted-peer default does not block relay | ips.excludes fix stays | H3 pass + absence of TURN permission denials in logs |

## Tasks

### T1 — repo: dev-staging TURN config + cert-sync + docs — H1, H5, H6
- Create `config/livekit.dev-staging.yaml` (= livekit.yaml + `turn:` block enabled, dev domain, `/etc/livekit-turn/tls.{crt,key}`, explicit 5349/3478, comment documenting the 443-advertisement hardcode with source ref).
- `docker-compose.dev-staging.yml` livekit service: mount the new yaml; add `./config/livekit-tls:/etc/livekit-turn:ro`; publish `5349:5349/tcp`, `3478:3478/udp`.
- `config/livekit.yaml` (prod): commented-out turn block + graduation preconditions note (do NOT enable).
- `scripts/livekit-turn-cert-sync.sh` (root; SRC/DST/compose params env-overridable; checksum state; restart livekit only on change; post-restart verification greps) + `systemd/livekit-turn-cert-sync.{service,timer}` (daily + boot).
- `skills/matrix-rtc-transport-specialist.md`: TURN section (schema, 443 gotcha, cert-sync, verification).

### T2 — harness: relay-forced knob — H3
- `aqua-agents` (branch feat/aqua-e2e-hardening): `AQUA_E2E_FORCE_RELAY=1` ⇒ `RoomOptions.rtc_config.ice_transport_type = IceTransportsType::Relay` at the central options seam (`call.rs` ~L252); run-header line; rebuild + lib tests.

### T3 — deploy dev-staging + verify — H1..H7
scp configs; install cert-sync units; run sync once; `ufw allow 5349/tcp`, `3478/udp`; recreate livekit; verify listeners/cert/log; rounds: normal + relay-forced; H6 idempotency/change tests.

### T4 — audit trace + merge to dev + push + report
Hypothesis trace with command evidence; merge feat/livekit-embedded-turn → dev; report with prod-graduation checklist.

## Prod graduation checklist (decision needed from Tim)
1. **The 443 decision** (the only real blocker for TURN-TLS): (a) dedicated IP for TURN with `turn.<host>` DNS + cert, or (b) caddy-l4 SNI passthrough build of the edge proxy + `turn.` hostname + webroot cert issuance. Until then prod gets the same UDP-3478-working / TLS-inert state as dev.
2. Cert-sync script + timer on prod (params: prod cert path, stack dir), ufw 5349/tcp + 3478/udp, DO cloud firewall check.
3. Enable the commented turn block in prod livekit.yaml; `docker compose restart livekit`; verify listeners + `using external IPs` single entry + relay-forced harness round vs prod.
4. Rotate LIVEKIT secret at next livekit-server upgrade (v1.12.0 still accepts pre-TTL TURN creds for backward compat; removed next release).

## Boundary conditions
- No prod changes. Dev-staging changes reversible (config backups, additive ufw, timer removable).
- Never bind-mount the individual Caddy cert files (inode pinning across renewals); always sync-copy.
- The e2e harness's hermetic livekit.e2e.yaml stays TURN-less (harness rides private bridges by design).
