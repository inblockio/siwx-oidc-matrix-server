# PROMOTION 2026-09-27: siwx-oidc 17d1461 + fresh signing key, edge rate limit on /resolve

Authorized by Tim on 2026-09-27: rotate the dev siwx-oidc signing key, then promote siwx-oidc
17d1461 to prod with a fresh signing key, including edge rate limiting for the public `GET /resolve`.
Trigger: both OIDC signing keys (prod and dev) were exposed to an agent session earlier that day.
Window: 2026-09-27 20:56 to 21:15 UTC. Driven interactively from the ops NUC, one step at a time.

**Result: all gates PASS, nothing rolled back.** Existing users keep their MXIDs, new DIDs get opaque
localparts, no user session was invalidated, and the fleet stayed connected.

---

## 1. What changed

| Where | Item | Before | After |
|---|---|---|---|
| prod | `siwx-oidc` image | 548b543, `ghcr.io/inblockio/siwx-oidc@sha256:458842fae04aa45539bce5040c11017d7c8eb56b13c801a03bbdb442324ee7f1` | 17d1461, `ghcr.io/inblockio/siwx-oidc@sha256:7610f87854625dbe35a5d6e2b76da68ade57c2ca21f1c04f0ca851fea79b807c` (same digest dev ran since 09-13) |
| prod | signing key | kid `2604f2242089db75` (served as `key1` by 548b543), SPKI sha256 `806143f211088b488c86eca7f4ca87861365c0d5838f7bfbb2d60331720ec519` | kid `c8551128d18f71ff`, SPKI sha256 `07fa10f5342cc8c884c3adfd5bd3fa475e03885d31e07bbd712c69f0785a7a5e`. Old key NOT retired (prod had published no proofs, and the key is compromised) |
| prod | edge `portal-caddy-1` | `caddy-l4@sha256:3976e41110fd3f7c92c6d26c9eed3abd8b7223ec0c3f4ab1e119b67a731d9557` | `ghcr.io/inblockio/siwx-oidc-matrix-server/caddy-l4@sha256:1c9825f346b1d45a001c9a7a8d7cf082403da8a0875a3a33064f0372203fabae` |
| prod | `/home/portal/portal/Caddyfile` | no limiter | `rate_limit` zones `siwx_resolve_burst` (60/10s) + `siwx_resolve_sustained` (600/5m), keyed on `{remote_host}`, GET/HEAD `/resolve` only, plus a JSON `handle_errors 429`. Everything else unchanged (the live `/oauth2/admin_token` 404 block stays) |
| dev | signing key | kid `01797b65f97f018b`, SPKI sha256 `047e2cc1fac8dc2f1ed923a4601855d15fad9490b66fd16875559b4e36850220` | kid `4b54128db23d668b`, SPKI sha256 `c506e98b90b50e06a20de81aa6d0031a82899317e90f7db3e1380c7287b53f80`. Old PUBLIC key listed in `SIWEOIDC_RETIRED_SIGNING_KEYS_PEM` |
| dev | edge `caddy_proxy` | local build `caddy-l4:2.11.4-l4v0.1.2` (`sha256:1ceb2c43...`) | same CI digest as prod (`caddy-l4@sha256:1c9825f3...`) |
| dev | `~/caddy-proxy/Caddyfile.dev-aquafire` | no limiter | repo version with the same two zones and 429 handler |

The edge image is the CI build of siwx-oidc-matrix-server main `0a58e7e` (workflow run 36130511403,
job "build-and-push (caddy-l4)"): Caddy v2.11.4, caddy-l4 v0.1.2, caddy-ratelimit
`v0.1.1-0.20260612195517-5625512f24f6`. Module diff against both old edges is `+http.handlers.rate_limit`
only (43 -> 44 non-standard modules). Caddy 2.11.4 is still the newest release; GHCR advisory
GHSA-6365 (forward_auth + reverse_proxy) has no fixed release yet and neither edge uses forward_auth.

Keys were generated ON the servers (`openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8
-topk8 -nocrypt`), written into `.env` in place by a script that prints only public fingerprints, and
the temporary PEM was shredded. Keys are identified here only by kid (first 16 hex of SHA-256 over the
SEC1 uncompressed point, i.e. what `/jwk` serves) and by SHA-256 of the SPKI DER.

Watchtower on prod (`matrix-watchtower-1`) is scoped `WATCHTOWER_SCOPE=matrix` and scans exactly one
container (itself). Neither `matrix-siwx-oidc-1` nor `portal-caddy-1` carries a watchtower label, and
both are digest-pinned, so the pins hold.

## 2. What the signing key signs (why no session broke)

Read from 17d1461 source: the ES256 key signs only ID tokens (authorization-code / device-code
responses) and the `io.inblock.did` DID assertions. Access tokens (`mat_`) and refresh tokens (`mcr_`)
are opaque Redis entries that Synapse introspects. A rotation therefore invalidates no session. Only
freshly minted ID tokens and proofs change kid. Verified on dev before prod: an access token issued
before the rotation still returned 200 on `/whoami`, and its refresh grant returned 200 with the same
device after it. Element users did NOT have to re-login.

## 3. Dev rehearsal (20:56-21:05 UTC)

- Dev had 17 published `io.inblock.did` proofs, all under kid `01797b65f97f018b`. siwx-oidc has no
  re-publish tool; a proof is re-asserted only on the user's next sign-in. So the old PUBLIC key was
  listed as retired. **Trade-off:** old proofs stay verifiable, but anyone holding the exposed private
  key can also mint "old-kid" proofs that verify. Accepted for dev (non-prod, key exposed to one
  session transcript, not known to be abused). Drop the retired entry once those users have signed in
  again, or immediately if abuse is suspected; the next sign-in re-asserts under the new kid.
- The retired variable is listed in the dev compose only. An EMPTY `SIWEOIDC_RETIRED_SIGNING_KEYS_PEM`
  is a startup panic, so it must never be added to a compose file whose `.env` does not set it.
- `up -d --no-deps siwx-oidc` only. A full `up` would also recreate Synapse (it `depends_on`
  siwx-oidc); the dry run showed that.
- Results: `/jwk` = `[4b54128db23d668b, 01797b65f97f018b]`; pre-rotation session refresh 200, same
  device; old-kid proofs verify through the retired entry; `/resolve` correct; e2e 13/13 before and
  after; the e2e identities' proofs were re-asserted under the new kid on their fresh login; 0
  WARN/ERROR in siwx-oidc.
- Edge: image swap (healthy in ~7 s), then Caddyfile written in place (inode unchanged), validated in
  the running container, reloaded (`load complete`). All 8 dev vhosts and the TURN SNI split identical
  to the pre-change probe. Burst: 60 x 200 then 429.

## 4. Prod pre-flight

- Backup bundle `/home/deploy/matrix-backups/20260927T2103Z-siwx-promo/` (0700): `env`,
  `docker-compose.yml`, `docker-compose.override.yml`, `Caddyfile.portal`, `ROLLBACK_DIGESTS.txt`,
  `redis_data.tar.gz` (after `BGSAVE`, status ok), `REDIS_COUNTS.txt` (DBSIZE 905), `MANIFEST.sha256`.
  Plus in place: `/home/deploy/matrix/stack/.env.bak-20260927-pre-siwx-17d1461` and
  `/home/portal/portal/Caddyfile.bak-20260927-pre-ratelimit`.
- Synapse two-step order: the RUNNING container's `/data/homeserver.yaml` has
  `msc4133_key_denylist: [io.inblock.did]` (step 1 done on 09-25).
- e2e baseline `prod-siwxpromo-baseline-20260927`: 13/13.
- Live calls: `active_rooms=0 participants=0` before each disruptive step.
- RUSTSEC on 17d1461's `Cargo.lock` (see §7): nothing auth-bypass class; not blocking.

## 5. Prod execution and verification (21:06-21:15 UTC)

**Edge.** Gates: new image lists `layer4` + `http.handlers.rate_limit`; the LIVE Caddyfile validates
under it; the NEW Caddyfile validates under it and is rejected by the old image (proves the order).
`docker stop portal-caddy-1` (hit the 10 s timeout, exit 137), rename to `portal-caddy-rollback`,
`docker run` with the documented args and the new digest: gap about 15 s. All 10 HTTP vhosts
(matrix 302, siwx-oidc 200, element 200, openwitness.org 200, timestamps 301, agentic 303, audit 401,
viewer 401, projects 401, aqua-registry 200) and the TURN SNI split (`CN=turn.matrix.inblock.io`,
verify 0; plain HTTP to turn hangs with 000) were identical to the baseline. Then the Caddyfile was
written in place (inode 560125 unchanged), validated inside the container, reloaded (`load complete`),
and probed again: identical. Burst of 64 parallel GETs: exactly 60 passed, then 429 with
`Content-Type: application/json`, the JSON body, `Retry-After`, and a single
`Access-Control-Allow-Origin: https://element.inblock.io`. `/jwk`, discovery, OPTIONS preflight (204)
and `/oauth2/admin_token` (404) unaffected. Note: a SERIAL burst from the NUC at prod RTT takes more
than 10 s and slides under the 60/10s window; that is the window working, not a failure.

**siwx-oidc.** New key generated on the box, `.env` rewritten in place, `SIWX_OIDC_IMAGE_REF` set to
the 17d1461 digest. `docker compose config --hash '*'` changed for `siwx-oidc` only.
`docker compose up -d --no-deps siwx-oidc` at 21:10:01; healthy 21:10:20 (siwx-oidc unavailable
about 13 s). Synapse, Redis, Element, LiveKit StartedAt unchanged. Final `.env` sha256 starts
`319ffd8beb3dbe06`, `docker-compose.yml` unchanged (`d436a6298bf1cbf6`).

| Check | Result |
|---|---|
| `/jwk` | `["c8551128d18f71ff"]` (old binary served `key1`) |
| `/resolve?did=did:pkh:eip155:1:0x4b23da593596d94035c57adf6c2454216449b1b2` (Tim, from `MATRIX_ADMIN_DID`, matches the Scribe `AGENT_TARGET`) | `@did-pkh-eip155-1-0x4b23da593596d94035c57adf6c2454216449b1b2:matrix.inblock.io`, `exists:true` |
| `/resolve?did=did:key:z6MkntoHyaUZjBJ5vQF34MxHSyd65QDzx2fg5mBrcfEYgaff` (prepared new Scribe DID, NOT logged in) | `@2cgdqqsrh06pgjp9:matrix.inblock.io`, `exists:false` |
| notify-tim forced fresh login (`[session]` moved aside, backup `~/.aqua-matrix-notify-agent/config.toml.bak-20260927-siwxpromo`), DM "siwx-oidc promoted (test, ignore)" | delivered 21:10:34; SAME MXID `@did-key-z6mktiprz8x5am2muxjsrhhehp4slbnz4sbkgkyhockgmwnm`, SAME device `AQUA_b8b77e4439fb` |
| First prod `io.inblock.did` proof (notify-tim) | ES256 signature VALID against `/jwk`, kid `c8551128d18f71ff`, `mxid`/`sub`/`iss` binding OK; `/resolve` now `attested:true` |
| Consultant fleet (21 `aqua-agent-*`) | all 21 logged `refresh grant succeeded` through the new binary by 21:14:31; 0 `exiting`, 0 refresh failures, 0 restarts; crash-loop and activity watchers silent |
| Scribe (`aqua-transcript-agent.service`) | active, NRestarts 0, refresh grant 200 at 21:11:02, same device `AQUA_8b7401df40c9`; only the pre-existing backfill UTD warnings |
| siwx-oidc log since start | INFO only, 0 WARN/ERROR |
| e2e `prod-siwxpromo-post-20260927` | 13/13; both e2e identities landed on their legacy `did-key-…` localparts |

Observed side effect (feature behavior, expected): on sign-in 17d1461 replaces a raw `did:…`
displayname with an alias. The two e2e identities were renamed; notify-tim was not (it has a real
displayname). 84 prod profiles still carry a raw `did:` displayname and will be aliased on their next
sign-in. Profiles with a published proof: 3 (notify-tim + 2 e2e).

## 6. Rollback

Rollback triggers were: an existing identity on a NEW localpart, failing logins, fleet not reconnected
within ~15 min, any vhost down. None fired.

Rewritten 2026-09-29 after the housekeeping in section 11. Only the paths below still exist.
**A key-restoring rollback no longer exists, by design:** every copy of the exposed old signing keys
(prod `.env.bak-20260927-pre-siwx-17d1461`, the bundle's `env`, dev
`.env.bak-20260927T205631Z-signingkeyrot-leak`) was shredded, so the old keys cannot and must not come
back. A rollback keeps the new keys (prod kid `c8551128d18f71ff`, dev kid `4b54128db23d668b`). If a
new key itself were ever the problem, the answer is another fresh key, not the old one. The
`portal-caddy-rollback` container was removed too; the edge rolls back by recreating the container
from the previous image digest.

```bash
# [prod] siwx-oidc: IMAGE ONLY, keeps the new key. The old binary (548b543) runs fine with it
# (it serves it as kid "key1"). The image is present locally on prod.
cd /home/deploy/matrix/stack
sed -i 's#^SIWX_OIDC_IMAGE_REF=.*#SIWX_OIDC_IMAGE_REF=ghcr.io/inblockio/siwx-oidc@sha256:458842fae04aa45539bce5040c11017d7c8eb56b13c801a03bbdb442324ee7f1#' .env
docker compose up -d --no-deps siwx-oidc          # NEVER a bare `up`: it would recreate Synapse

# [prod] edge. CONFIG FIRST: the old image cannot parse the rate_limit file.
# Previous image (recorded in section 1 and ROLLBACK_DIGESTS.txt, present locally on prod):
#   ghcr.io/inblockio/siwx-oidc-matrix-server/caddy-l4@sha256:3976e41110fd3f7c92c6d26c9eed3abd8b7223ec0c3f4ab1e119b67a731d9557
cd /home/portal/portal
cat Caddyfile.bak-20260927-pre-ratelimit > Caddyfile   # in place, never mv (inode trap)
docker exec portal-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
# Then recreate the hand-run container on the previous image (args as in
# docs/deployment-recovery-reference.md, "The prod edge"). Outage for all vhosts until it is up.
docker rm -f portal-caddy-1
docker run -d --name portal-caddy-1 --restart unless-stopped \
  --network portal-net -p 80:80 -p 443:443 \
  -v /home/portal/portal/Caddyfile:/etc/caddy/Caddyfile \
  -v /home/deploy/caddy/config:/config \
  -v /home/deploy/caddy/data:/data \
  --entrypoint "" \
  ghcr.io/inblockio/siwx-oidc-matrix-server/caddy-l4@sha256:3976e41110fd3f7c92c6d26c9eed3abd8b7223ec0c3f4ab1e119b67a731d9557 \
  caddy run --config /etc/caddy/Caddyfile --adapter caddyfile

# [dev] edge, same order (previous image: local build caddy-l4:2.11.4-l4v0.1.2, sha256:1ceb2c43...,
# still present on dev)
cd ~/caddy-proxy
cat Caddyfile.dev-aquafire.bak-20260927T210029Z-pre-ratelimit > Caddyfile.dev-aquafire
docker exec caddy_proxy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
cp -p docker-compose.caddy-proxy.yml.bak-20260927T210029Z-ratelimit-image docker-compose.caddy-proxy.yml
docker compose -f docker-compose.caddy-proxy.yml up -d caddy

# [dev] siwx-oidc: nothing to roll back. This promotion changed only the dev KEY (the image was
# already 17d1461), and the old dev key is gone by design (see above).
```

Redis was never touched; `redis_data.tar.gz` in the bundle is a belt-and-braces copy only. A rollback
of siwx-oidc does not need it (17d1461 adds no Redis migration; 548b543 reads the same keys).

## 7. RUSTSEC for 17d1461 (`cargo audit` on its Cargo.lock, 2026-09-27)

4 vulnerabilities, none auth-bypass class, so not blocking:
- RUSTSEC-2026-0285 rustls 0.23.37: TLS 1.3 handshake messages accepted across encryption-level
  boundaries (fix >= 0.23.45).
- RUSTSEC-2026-0185 quinn-proto 0.11.14: remote memory exhaustion via out-of-order stream reassembly
  (fix >= 0.11.15).
- RUSTSEC-2026-0220 ruint 1.17.2: wrong overflow flags on shifts (fix >= 1.20.0).
- RUSTSEC-2023-0071 rsa 0.9.10: Marvin timing attack, no fixed release (the provider signs ES256 only).

Warnings: unmaintained `derivative`, `paste`, `proc-macro-error2`; unsound `anyhow` 1.0.102
(`downcast_mut`), `lru` 0.16.3 (`pop` panic safety). A `cargo update` of rustls/quinn-proto/ruint in
siwx-oidc is the cheap follow-up.

## 8. Still open

- Scribe switch-over to `did:key:z6MkntoHyaUZ…` (localpart `2cgdqqsrh06pgjp9`): separate agent, now
  unblocked. Publishing needs Tim's delegation in the node UI.
- Dev retired entry for kid `01797b65f97f018b`: remove once the 15 real dev users have signed in again
  (or at once on any sign of abuse).
- DONE 2026-09-29: every copy of the old exposed keys in the `.env` backups on both boxes was located
  by fingerprint and shredded (27 files on prod, 10 on dev), see section 11.
- DONE 2026-09-29: `portal-caddy-rollback` and `portal-caddy-1-old` removed, see section 11.
- DONE: soak at +2 h (section 9) and +24 h (section 10), both green. The +1 h check was not recorded.
  `caddy_rate_limit_declined_requests_total` stayed unreadable (admin :2019 refused); declines were
  counted from the limiter's log lines instead.
- Converting `portal-caddy-1` into a compose file is still open (see repo
  `docs/deployment-recovery-reference.md`).

## 9. Early soak check (+2 h, 2026-09-27 23:20 UTC)

- siwx-oidc: Up (healthy) since 21:10:13Z, 0 restarts, image sha256:7610f878 (rev 17d1461) matches .env.
- /jwk: single kid c8551128d18f71ff. /resolve for the new Scribe DID: exists:true, attested:true.
- Logs since promotion: siwx-oidc 7,908 lines, all INFO, 0 WARN/ERROR, HTTP 200/201/303 only. Synapse 0 ERROR,
  0 OIDC or introspection warnings (700 WARNING, baseline 635 in the same window the day before).
- e2e `prod-siwxpromo-soak-20260928`: 13/13.
- Fleet: 21/21 up, 0 restarts, 29 to 30 refresh grants each, 0 x 401. Scribe active, 0 restarts. Crash-loop
  watcher quiet (phase ok, 2 ignored one-probe blips).
- Open: rate-limit metric not reachable (admin :2019/metrics returned nothing). The +24 h check is still due
  around 2026-09-28 21:17 UTC.

## 10. +24 h soak check (2026-09-28 23:04 UTC)

Result: GREEN, all checks pass.

- siwx-oidc: container up, 0 restarts, image still 17d1461.
- /jwk: kid c8551128d18f71ff. /resolve answers correctly.
- Logs since promotion: siwx-oidc 6 WARN / 0 ERROR. Synapse 0 OIDC errors.
- e2e `prod-siwxpromo-soak24h-20260928` (`~/.cache/aqua-e2e-logs/prod-siwxpromo-soak24h-20260928.log`): 13/13.
- Fleet: 21/21 connected, 0 x 401. Crash-loop watcher quiet.
- /resolve rate limit: 0 declined requests since promotion, counted from the limiter's log lines. The
  admin endpoint :2019 refused the metrics read and there is no access log, so the counter itself stayed
  unreadable.
- Scribe note (not a siwx-oidc fault): 52 M_UNKNOWN_TOKEN retries in two call windows, 0 refresh
  failures. The cause is Scribe-side ("reconnect returned short TTL", "lock ... dirtied"); follow up in
  aqua-agents.

## 11. Post-soak housekeeping (2026-09-29)

Done on Tim's explicit go, prod and dev. Leaked-key copies were located by fingerprint only: a pattern
set derived from the old PRIVATE key scalar (PEM body windows, JWK `d`, hex) was grepped for, printing
filenames only, never content. Every hit was shredded with `shred -u`. The pattern files were shredded
too. The three prod Redis backup archives were also checked (decompressed, count only): 0 matches, kept.

Prod (old key pubkey sha256 prefix 806143f21108), 27 files shredded:

- `/home/deploy/matrix/stack/.env.bak-20260927-pre-siwx-17d1461`
- `/home/deploy/matrix-backups/20260927T2103Z-siwx-promo/env`
- `/home/deploy/matrix-backups/20260925T2125Z/env.bak`
- `/home/deploy/matrix-backups/20260925T2125Z/env.pre-5.0`
- `/home/deploy/matrix/stack/backups/20260913T020000Z-eventindex/.env.bak`
- `/home/deploy/matrix/stack/backups/20260913T0930Z-bc/.env.bak`
- `/home/deploy/matrix/stack/backups/20260914T0810Z-de/.env.bak`
- `/home/deploy/secrets/env-history/`: all 20 files there (`.env.bak-20260731`, `.env.bak-20260731165137`,
  `.env.bak-20260731171157`, `.env.bak-20260731b`, `.env.bak-20260803-prodav`, `.env.bak-20260804-keyrot`,
  `.env.bak-element-20260831T213747Z`, `.env.bak-ewsearch-20260814T222047Z`,
  `.env.bak-pre-passkey-scope-20260619`, `.env.bak-precutover-20260831T210306Z`,
  `.env.bak-synapse-20260831T213848Z`, `.env.bak.20260611171235`, `.env.bak.20260611171357`,
  `.env.bak.20260618061438`, `.env.bak.20260624073425`, `.env.bak.20260624124910`,
  `.env.bak.20260629071350`, `.env.bak.20260731212458`, `.env.bak.20260731224347`,
  `.env.bak.20260801102400`). The key had been the prod signing key since at least June.
- Live prod `.env` contains the old key: no. Rescan after shredding: 0 matches under `/home/deploy`
  (unreadable to `deploy`, not scanned: `caddy/data`, `caddy/config`, and the Synapse signing key in the
  20260925T2125Z backup).

Dev (old kid 01797b65f97f018b, pubkey sha256 prefix 047e2cc1fac8, matched against the served JWKS), 10
files shredded:

- `~/matrix-staging/.env.bak-20260927T205631Z-signingkeyrot-leak`
- `~/matrix-staging/.env.bak-20260925-pre-main-pin`
- `~/matrix-staging/.env.bak-20260925-pre-synapse-1161`
- `~/matrix-staging/.env.bak-mainswitch-20260831T233955Z`
- `~/matrix-staging/backups/2026-09-25-pre-upgrade-1.161/compose/env.snapshot`
- `~/matrix-staging/backups/20260912-eventindex/.env.bak`
- `~/matrix-staging/backups/20260913-bc/.env.bak`
- `~/matrix-staging/backups/20260913-nonblocking/.env.bak`
- `~/matrix-staging/backups/20260914-de/.env.bak`
- `~/backups/env-20260831-003210.bak`
- Live dev `.env` contains the old private key: no (it carries only the public form in
  `SIWEOIDC_RETIRED_SIGNING_KEYS_PEM`, by design). The remaining older dev `.env.bak-*` files (before
  2026-08-31) do not contain the leaked key; they hold earlier, unexposed dev keys and were kept.

Edge: the stopped containers `portal-caddy-rollback` and `portal-caddy-1-old` were removed on prod
(`docker rm`, images kept). `portal-caddy-1` stays Up; `https://matrix.inblock.io/_matrix/client/versions`
returns 200 afterwards.

Rollback after housekeeping: only the image-only path in section 6 remains. It keeps the new key.
`SIWX_OIDC_IMAGE_REF` is present in the live prod `.env`, and the rollback image
`ghcr.io/inblockio/siwx-oidc@sha256:458842fae04aa45539bce5040c11017d7c8eb56b13c801a03bbdb442324ee7f1`
is present locally on prod. The "full restore" lines in section 6 (prod `.env.bak-20260927-pre-siwx-17d1461`,
dev `.env.bak-20260927T205631Z-signingkeyrot-leak`) and the `portal-caddy-rollback` edge rename are void:
those files and that container no longer exist. The MANIFEST.sha256 in
`/home/deploy/matrix-backups/20260927T2103Z-siwx-promo/` still lists `env`, which is now gone.
