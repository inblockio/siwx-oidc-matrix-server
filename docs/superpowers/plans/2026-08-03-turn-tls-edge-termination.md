# TURN-TLS edge termination via caddy-l4 (dev first)

**Status:** EXECUTED + VERIFIED on dev, 2026-08-03. Gates pre-authorized (operator instruction: build xcaddy image, deploy to dev, e2e via dev.turn.matrix.inblock.io). Successor to `2026-08-02-livekit-embedded-turn.md`.

## Hypothesis trace (2026-08-03, all evidence from commands run this session)

| ID | Status | Evidence |
|----|--------|----------|
| H1 | **Confirmed** | Image `caddy-l4:2.11.4-l4v0.1.2` built on dev box; `caddy list-modules` in it shows 42 layer4.* modules; new Caddyfile validates INSIDE the image (`Valid configuration`) |
| H2 | **Confirmed** | Post-swap vhost regression identical to pre-swap baseline (302 + 7×200 across all 8 vhosts); single edge-owned CORS header on dev.siwx preserved |
| H3 | **Confirmed** | Fresh LE cert (notAfter 2026-11-01) issued via HTTP-01 and served on :443 for the TURN SNI through the l4 tls terminator (off-box openssl) |
| H4 | **Confirmed** | livekit `Starting TURN server {…externalTLS: true…}`; no host 5349 listener; ufw 5349 rule removed; cert-sync timer disabled |
| H5 | **Confirmed for infrastructure; harness media composite blocked by a CLIENT limitation** | TLS-only relay round FAILED (`wait_pc_connection timed out`) — caddy debug logs pin the exact cause: repeated client dials answered with the LE cert, each rejected by the client with `remote error: tls: unknown certificate authority` (the harness's bundled libwebrtc/BoringSSL has no system CA roots — real clients trust LE natively). Infrastructure then proven independently end-to-end: (a) curl probe: HTTPS bytes to the TURN SNI reach the TURN listener (l4 match + proxy verified); (b) `scripts/turnprobe` (pion/turn + system-CA crypto/tls, creds minted with livekit's own base62+sha256 scheme): **TLS 1.3 verified-chain handshake + TURN allocation `207.154.209.103:36451` on-box AND `…:39468` OFF-BOX from the workstation** — the complete turns:443 → caddy-l4 → livekit external_tls → auth → relay-allocation chain works from the open internet |
| H6 | **Confirmed** | Combined state (udp 3478 restored): relay-forced round 13/13 (`round7-dev-combined-relay.log`); final normal round see round8 log |
| H7 | **Confirmed (scoped)** | `caddy reload` fired mid-run during round 7 (16:56:12Z): round still 13/13 — edge reload non-disruptive to in-flight calls incl. signaling websockets. TLS-TURN-session-specific drain untested (harness limitation above); re-verify with a real client at prod graduation |

**Discovered during execution:** (1) livekit rust-sdk 0.7.44's prebuilt libwebrtc cannot validate public-CA TURN-TLS certs (no system roots) — harness relay tests exercise the UDP leg; the TLS leg's gate tool is `scripts/turnprobe` (also the prod-graduation gate: `TURN_PROBE_HOST=turn.matrix.inblock.io`, mint creds on the prod box from its .env, run probe off-box). (2) The curl-to-TURN-SNI probe (times out with 0 bytes = l4 matched and proxied; 200 body = NOT matched) is a fast edge-path discriminator. (3) `caddy fmt` warning at Caddyfile line 52 is pre-existing cosmetic.
**Decision (Tim, 2026-08-03):** variant 2 — terminate TURN-TLS at the edge (caddy-l4), LiveKit `external_tls: true`. DNS created: `turn.matrix.inblock.io` → 142.93.168.4 (prod), `dev.turn.matrix.inblock.io` → 207.154.209.103 (dev).

## NAMING CONVENTION (operator-mandated, document everywhere)
**Dev DNS names put `dev.` FIRST**: `dev.turn.matrix.inblock.io`, NOT `turn.dev.matrix.inblock.io`. Prod is the bare name (`turn.matrix.inblock.io`).

## Verified facts (2026-08-03 research, source-cited in session)
- caddy-l4 `v0.1.2` (2026-07-16) pins caddy `v2.11.4` exactly — the dev edge already runs `caddy:2-alpine` = v2.11.4. Dockerfile: `caddy:2.11.4-builder` + `xcaddy build --with github.com/mholt/caddy-l4@v0.1.2`.
- Mechanism: `servers :443 { listener_wrappers { layer4 { @turn_sni tls sni <host>; route @turn_sni { tls; proxy tcp/livekit:5349 } } tls } }` — layer4 wrapper MUST precede the `tls` wrapper (it reads the raw ClientHello). Caddyfile support is current and documented (l4 docs/servers.md, matchers/tls.md).
- The l4 `tls` handler does no cert management; it uses Caddy's shared cert cache → a dummy site block for the hostname drives automation. TLS-ALPN-01 would be intercepted by the SNI matcher → the dummy site must set `tls { issuer acme { disable_tlsalpn_challenge } }` (HTTP-01 on port 80 is outside the :443-scoped wrapper).
- LiveKit `external_tls: true` opens a BARE TCP listener on tls_port (turn.go: plain `net.Listen`), no PROXY protocol — `proxy tcp/livekit:5349` is correct; cert_file/key_file unused.
- listener_wrappers are TCP-only: h3/QUIC on udp/443 for normal vhosts is untouched. l4 proxy has no idle timeout → long TURN sessions safe. Known upstream caveats: #440 (sni-regex edge case, we use exact match), reload-drain with active l4 sessions untested upstream (we smoke-test it).
- Dev edge recon: caddy_proxy container (compose project `/home/dev/caddy-proxy/`, image caddy:2-alpine, 8 vhosts, admin 127.0.0.1:2019, healthcheck :80, cert volume `caddy-proxy_caddy_data` persists across image swaps, `livekit` resolves+reachable from the container via proxy_net; zero-downtime reload documented; build capability + 99G disk on box).

## Hypothesis register

| ID | If | Then | Assumptions | Verification |
|----|----|------|-------------|--------------|
| H1 | xcaddy image (2.11.4 + l4 v0.1.2) built on dev box | `caddy list-modules` shows layer4.* | builder tag exists (verified) | build log + list-modules grep in new image |
| H2 | new Caddyfile (l4 wrapper + dummy cert site) deployed with the new image | all 8 existing vhosts serve EXACTLY as before (same status codes as pre-swap baseline); h3 unaffected | wrapper only diverts the TURN SNI | `caddy validate` in new image pre-swap; per-vhost curl baseline vs post-swap |
| H3 | dummy site with disable_tlsalpn_challenge | Caddy obtains + serves the LE cert for dev.turn.matrix.inblock.io through the l4 tls handler | port 80 reachable (it is); LE rate limits fine (first issuance) | `openssl s_client -connect dev.turn.matrix.inblock.io:443 -servername dev.turn.matrix.inblock.io` shows LE cert for the name |
| H4 | livekit `external_tls: true`, domain dev.turn.matrix.inblock.io, host publish of 5349 REMOVED | TURN starts; 5349 reachable only via proxy_net; host has no 5349 listener | — | livekit logs; `ss -tlnp` on box shows no 5349; `docker exec caddy_proxy wget`-style TCP probe optional |
| H5 | TLS-only state (turn.udp_port temporarily 0) + relay-forced harness round | 13/13 green ⇒ media rides turns:dev.turn.matrix.inblock.io:443 through caddy-l4 into livekit:5349 | rust SDK dials turns:443; l4 match works | `AQUA_E2E_FORCE_RELAY=1` run; caddy debug logs `layer4` matched + `dial upstream livekit:5349`; livekit relay allocations |
| H6 | restored combined config (udp 3478 back) | relay round AND normal round 13/13 (no regression) | — | two more harness runs |
| H7 | `caddy reload` during an active relay-forced call | session survives (upstream-untested; non-blocking if it drops — record outcome) | l4 #261 drain fix applies to reload | reload mid-call + call still passes |

## Tasks
### T1 — repo (subagent): image + CI + configs + docs — H1..H4 prep
Dockerfile.caddy-l4; CI publish job mirroring the existing image jobs (ghcr.io/inblockio/siwx-oidc-matrix-server/caddy-l4) for prod graduation; Caddyfile.dev-aquafire global `servers :443` l4 block + dummy cert site; repo copy of the caddy-proxy compose (if present) image ref note; config/livekit.dev-staging.yaml → domain dev.turn.matrix.inblock.io + external_tls true (drop cert_file/key_file); compose dev-staging → remove 5349 publish + livekit-tls mount; prod reference blocks (commented) in config/livekit.yaml + Caddyfile.production; skill + convention docs; note cert-sync timer retirement (edge termination makes it unnecessary — keep script/units in repo as the passthrough-variant tooling).
### T2 — deploy dev edge + livekit (orchestrator) — H1..H4
Build image on box; validate; pre-swap vhost baseline; swap; post-swap regression + cert check; livekit config swap + recreate; ufw: delete 5349/tcp rule; disable livekit-turn-cert-sync.timer.
### T3 — staged e2e (orchestrator) — H5..H7
TLS-only round → restore → combined rounds → reload smoke.
### T4 — audit + merge dev + push + report incl. prod graduation.

## Prod graduation (pre-written)
Portal Caddy on prod is a DIFFERENT deployment (bind-mounted /home/portal/portal/Caddyfile, image managed by the portal project) — graduating needs: the CI-built caddy-l4 image adopted for portal-caddy-1, the same global l4 block + `turn.matrix.inblock.io` dummy site added via the bind-mount cp procedure, livekit.yaml turn block enabled with external_tls + domain turn.matrix.inblock.io, NO host publish of 5349, ufw 3478/udp only, then the relay-forced round vs prod (TLS-only state first). Plus the still-pending ICE-fix + TURN-UDP promotion items from the two predecessor plan docs.
