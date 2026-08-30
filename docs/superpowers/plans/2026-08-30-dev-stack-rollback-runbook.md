# Dev-staging rollback runbook: restore Synapse 1.154.0

**Scope: dev-aquafire ONLY.** Target box: `ssh -p 8022 -i ~/.ssh/id_inblock_deploy dev@207.154.209.103`.
**Production (142.93.168.4 / agentic.inblock.io) is OUT OF SCOPE. Do not touch it.**

**Why this isn't just "revert the image":** Synapse 1.157.0 REMOVED
`experimental_features.msc3861`. If you point a pre-1.157 image at a volume that
was migrated to 1.157+, the config on disk has no `msc3861` block, and the
image's first-boot entrypoint guard will **not** recreate it — you get a Synapse
that boots but is not delegating auth to siwx-oidc. The captured pre-migration
`homeserver.yaml` (via the volume snapshot in Section 2) is mandatory, not optional.

Validated by an actual restore drill on 2026-08-30. See Section 5 for the evidence.

---

## ⚠️ DANGER: COMPOSE_PROJECT_NAME footgun — read this before running anything in Section 4

**This caused a live incident during the 2026-08-30 drill. It must never happen again.**

`COMPOSE_PROJECT_NAME` is set inside `.env` (and therefore inside the captured
`compose/env.snapshot`). Docker Compose resolves the project name in this order:

1. `-p` CLI flag (highest precedence)
2. `COMPOSE_PROJECT_NAME` env var / value from `--env-file`
3. top-level `name:` key in the compose file
4. directory basename (lowest precedence)

**If you pass `--env-file .../env.snapshot` to a scratch compose file — even one
with its own `name:` key — the env file's `COMPOSE_PROJECT_NAME` wins and your
scratch `up -d` runs inside the LIVE `matrix-staging` project.** It will recreate
the live Synapse container with the scratch service definition. During the drill
this ripped live Synapse off `proxy_net` and rebound its ports, making
dev-staging unreachable through Caddy for ~90 seconds.

**Rules — non-negotiable for any scratch/drill compose invocation:**

- ALWAYS pass an explicit `-p <project>`. The compose file's `name:` key is
  **not** sufficient protection against a `COMPOSE_PROJECT_NAME` set in the env file.
- Strip the project name out of any env file before using it for a scratch stack:

```bash
# What this does: removes COMPOSE_PROJECT_NAME from a copy of env.snapshot so it can't hijack the live project
grep -v '^COMPOSE_PROJECT_NAME=' env.snapshot > interp.env && chmod 600 interp.env
```

- Pre-flight before any scratch `up -d`:

```bash
# What this does: confirms the scratch project has zero pre-existing containers before you bring it up
docker compose -p <project> -f <file> ps
```
Expected output: no container rows (empty table / header only). If ANYTHING is
listed, stop — you are about to touch a project that already exists, possibly `matrix-staging`.

**Recovery if it happens anyway** — get the real Synapse back on the real network immediately:

```bash
# What this does: re-applies the real compose file so Synapse is recreated from the correct service definition
cd /home/dev/matrix-staging && docker compose -f docker-compose.dev-staging.yml --env-file .env up -d matrix_synapse
```
```bash
# What this does: confirms Synapse is back on proxy_net (this is the check that matters — not just "container running")
docker inspect matrix-staging-matrix_synapse-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
```
Expected output: a space-separated network list that **includes `proxy_net`**.

---

## Captured artifacts (all on the dev box, nowhere else)

Base dir: `/home/dev/rollback-drill/artifacts/20260830T145700Z/`

| File | Contents |
|---|---|
| `IMAGE_DIGESTS.txt` | all six service digests (table below) |
| `SYNAPSE_VERSION.txt` | records `matrix-synapse 1.154.0` |
| `MANIFEST.sha256` | 24 entries, all verified OK |
| `synapse/homeserver.yaml` | pre-migration config, mode 600, **CONTAINS SECRETS** |
| `synapse/matrix_data.tar.gz` | consistent snapshot of volume `matrix-staging_matrix_data`, taken with Synapse STOPPED. Tar root = volume root (`./homeserver.yaml`, `./homeserver.db`, `./media_store/`, `./dev.matrix.inblock.io.signing.key`, `./dev.matrix.inblock.io.log.config`) |
| `redis/redis_data.tar.gz` | Redis volume, crash-consistent (BGSAVE, taken live, no downtime) |
| `compose/env.snapshot` | copy of live `.env`, mode 600, **SECRET — never print or cat it** |
| `compose/docker-compose.dev-staging.yml`, `compose/entrypoints/`, `compose/config/`, `compose/ci-deploy.sh` | orchestration config as of capture time |

Capture script: `/home/dev/rollback-drill-capture.sh` (phases: `a` = no-downtime
digests+configs, `b` = stop Synapse + snapshot volume + restart, `manifest` =
checksums). Re-runnable: `TS=<stamp> /home/dev/rollback-drill-capture.sh all`.

## Recorded image digests

| Service | Digest | Notes |
|---|---|---|
| redis | `redis@sha256:077ba791400f390cb96d9d419d90259d5e72e697fca7abc3bbde6d83285d7346` | |
| siwx-oidc | `ghcr.io/inblockio/siwx-oidc@sha256:8126d90e1667b480e7fa2f9f209428380a3d8202df9cce6520582767e3b0537a` | |
| matrix_synapse | `ghcr.io/inblockio/siwx-oidc-matrix-server/synapse@sha256:a0b480cc3f4f9cdc4d141c755584d5b20563a4c226bfd0cea0733a7cd789011a` | = Synapse 1.154.0 |
| element-web | `ghcr.io/inblockio/siwx-oidc-matrix-server/element-web@sha256:7e576a23fe14af59bc6f12ace590f9f67221b28af24a8d6a3ec1c84ae38c42ad` | |
| livekit | `livekit/livekit-server@sha256:b1281e66e35e8f9749ffbcf0fe6ab4d40d1438aa00f36c2ea7e6975e5e261e2e` | v1.12.0 |
| lk-jwt-service | `ghcr.io/element-hq/lk-jwt-service@sha256:29918567e6b7cd920e2853b4cd6848ce01b79947c3d19a9f1ed5b74f0a2a88bf` | 0.5.0 |

---

## Section 1: Before you start — take the deploy lock

The CD timer (`matrix-staging-deploy.timer`, runs every 5 min, `flock`s
`/home/dev/matrix-staging/.deploy.lock`, waits 120s then fails) will race a
manual rollback if you don't hold this lock.

```bash
# What this does: acquires the CD deploy lock so the automatic converge timer can't run underneath you
cd /home/dev/matrix-staging
exec 9>.deploy.lock; flock -w 60 9
```
Expected output: none (silent success). The lock is held for the life of this shell — do the rest of the rollback in the SAME shell/session.

---

## Section 2: Rollback in place (normal case — migration failed, restore 1.154.0 onto the live stack)

**Step 1 — stop Synapse only** (leave siwx-oidc/Redis/Element/LiveKit running):
```bash
# What this does: stops only the Synapse container so its data volume is quiescent for the restore
docker compose -f docker-compose.dev-staging.yml --env-file .env stop matrix_synapse
```
Expected output: `Container matrix-staging-matrix_synapse-1  Stopped`

**Step 2 — back up the CURRENT (broken/migrated) volume first**, so the failed
state is forensically preserved before you overwrite it:
```bash
# What this does: tars the current (post-migration, possibly broken) volume contents before they are wiped
docker run --rm -v matrix-staging_matrix_data:/src:ro -v /home/dev/rollback-drill/artifacts:/dst alpine:3 \
  tar czf /dst/failed-state-$(date -u +%Y%m%dT%H%M%SZ).tar.gz -C /src .
```
Expected output: command exits 0, and a new `failed-state-*.tar.gz` appears under `/home/dev/rollback-drill/artifacts/`.

**Step 3 — wipe and restore the volume from the pre-migration snapshot:**
```bash
# What this does: replaces the live volume's contents with the pre-migration snapshot (config + db + signing key + media_store together, as a set)
docker run --rm -v matrix-staging_matrix_data:/dst \
  -v /home/dev/rollback-drill/artifacts/20260830T145700Z/synapse:/src:ro alpine:3 \
  sh -c 'rm -rf /dst/* /dst/..?* 2>/dev/null; tar xzf /src/matrix_data.tar.gz -C /dst'
```
Expected output: command exits 0, no error text. This restores `homeserver.yaml`
(with the `msc3861` block), `homeserver.db`, the signing key, and `media_store/`
together — they are restored as one atomic set, never partially.

**Expected (do NOT "fix" this): the restored volume has mixed ownership.** After
restore you will see `homeserver.yaml` owned `1000:1000`, `dev.matrix.inblock.io.log.config`
and `homeserver.yaml.bak-*` owned `0:0` (root), and everything Synapse manages
(`homeserver.db`, its `-wal`/`-shm`, the signing key, `media_store/`) owned `991:991`.
This looks wrong but is byte-for-byte identical to the live volume — verified against
`/var/lib/docker/volumes/matrix-staging_matrix_data/_data` on 2026-08-30. The config
files are root/dev-owned because they are placed there by hand; Synapse only needs to
READ them. Do not `chown` them during an incident: matching ownership is evidence the
restore was faithful, and changing it is an untested deviation from the known-good state.

**Step 4 — pin the image back to 1.154.0.** Edit `/home/dev/matrix-staging/.env`
with an editor (`vi`/`nano`), find `SYNAPSE_IMAGE_REF` (or equivalent digest
pin variable), set it to:
```
ghcr.io/inblockio/siwx-oidc-matrix-server/synapse@sha256:a0b480cc3f4f9cdc4d141c755584d5b20563a4c226bfd0cea0733a7cd789011a
```
**Never `sed -i` this file blindly, and never `cat` it — it holds secrets.**

**Step 5 — bring Synapse back:**
```bash
# What this does: recreates the Synapse container on the pinned 1.154.0 digest against the restored volume
docker compose -f docker-compose.dev-staging.yml --env-file .env up -d matrix_synapse
```
Expected output: `Container matrix-staging-matrix_synapse-1  Started`

**Step 6 — verify, in order:**

```bash
# What this does: confirms the running container is actually 1.154.0
docker exec matrix-staging-matrix_synapse-1 pip show matrix-synapse | head -2
```
Expected: `Version: 1.154.0`

```bash
# What this does: confirms the load-bearing msc3861 block is present in the live config
docker exec matrix-staging-matrix_synapse-1 grep -c msc3861 /data/homeserver.yaml
```
Expected: `1`

```bash
# What this does: confirms Synapse's internal health endpoint responds
docker exec matrix-staging-matrix_synapse-1 curl -fsS -o /dev/null -w '%{http_code}\n' http://localhost:8080/health
```
Expected: `200`

```bash
# What this does: confirms Synapse is reachable on the proxy network (the thing that broke during the drill incident)
docker inspect matrix-staging-matrix_synapse-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
```
Expected: output includes `proxy_net`

```bash
# What this does: confirms Synapse is reachable end-to-end through Caddy from outside the box
curl -s -o /dev/null -w '%{http_code}\n' https://dev.matrix.inblock.io/_matrix/client/versions
```
Expected: `200`

```bash
# What this does: confirms the whole stack (not just Synapse) is healthy after the rollback
docker compose -f docker-compose.dev-staging.yml --env-file .env ps
```
Expected: all six services listed, state `running`/`healthy`.

---

## Section 3: Verify a real login actually works (do not skip)

Under MSC3861 there is no password login. The only real proof the rollback
worked is that a fresh OIDC token from siwx-oidc is accepted by Synapse.

```bash
# What this does: registers a throwaway OAuth client for the login check (one-time)
curl -s -X POST https://dev.siwx.inblock.io/register -H 'Content-Type: application/json' -d '{"client_name":"rollback-check","redirect_uris":["http://localhost:9999/callback"],"grant_types":["authorization_code","refresh_token"],"response_types":["code"],"token_endpoint_auth_method":"none","application_type":"native"}'
```
Expected: HTTP 201, JSON body containing `client_id`. Save that `client_id`.

```bash
# What this does: generates a throwaway Ed25519 identity for the check (no wallet needed)
openssl genpkey -algorithm Ed25519 -out drill-identity.pem && chmod 600 drill-identity.pem
```
Expected: file `drill-identity.pem` created, no output.

```bash
# What this does: builds the headless siwx-oidc client (from the siwx-oidc repo checkout)
cargo build -p siwx-oidc-auth --release
```
Expected: exits 0, binary at `target/release/siwx-oidc-auth`.

```bash
# What this does: runs the full CAIP-122-equivalent auth ceremony against the restored server and writes tokens to a file
siwx-oidc-auth --server https://dev.siwx.inblock.io --client-id <id> --redirect-uri http://localhost:9999/callback --device-id ROLLBACK_CHECK --key-file drill-identity.pem > tokens.json
```
Expected: exits 0, `tokens.json` contains `access_token`/`refresh_token`. Requires
`"key"` in `SIWEOIDC_SUPPORTED_DID_METHODS` — dev-staging has `["pkh","key"]`, so this works as-is.

```bash
# What this does: presents the freshly issued token to Synapse and confirms it's accepted
curl -s -H "Authorization: Bearer $(jq -r .access_token tokens.json)" https://dev.matrix.inblock.io/_matrix/client/v3/account/whoami
```
Expected: HTTP 200, JSON body with a `user_id`.

```bash
# What this does: negative control — proves the 200 above means something, not that whoami always returns 200
curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer mat_notarealtoken' https://dev.matrix.inblock.io/_matrix/client/v3/account/whoami
```
Expected: `401`

**Never echo token values into logs or shared terminals.** Access tokens have a 300s TTL; refresh tokens 90d.

---

## Section 4: Isolated scratch drill (rehearse without touching live)

Use this to rehearse the restore in isolation, e.g. to re-validate a snapshot
before trusting it in Section 2. Separate project name, sanitized env file,
loopback-only port, single `matrix_synapse` service pinned by digest, **not**
joined to `proxy_net`.

```bash
# What this does: strips COMPOSE_PROJECT_NAME so the scratch env can never hijack the live matrix-staging project
grep -v '^COMPOSE_PROJECT_NAME=' /home/dev/rollback-drill/artifacts/20260830T145700Z/compose/env.snapshot \
  > /home/dev/rollback-drill/scratch-orch/interp.env && chmod 600 /home/dev/rollback-drill/scratch-orch/interp.env
```
Expected: `interp.env` created, mode 600, no `COMPOSE_PROJECT_NAME` line (`grep COMPOSE_PROJECT_NAME interp.env` returns nothing).

`interp.env` is **deliberately not kept on disk between drills** — it is a copy of
`.env` and therefore secret material, so it is deleted after each drill to keep exactly
one canonical secret copy (`artifacts/.../compose/env.snapshot`, mode 600). If it is
missing, that is expected: this step regenerates it. Delete it again when you're done.

Scratch compose file (`/home/dev/rollback-drill/scratch-orch/docker-compose.drill.yml`):

```yaml
name: matrix-rb-drill-o

services:
  matrix_synapse:
    image: ghcr.io/inblockio/siwx-oidc-matrix-server/synapse@sha256:a0b480cc3f4f9cdc4d141c755584d5b20563a4c226bfd0cea0733a7cd789011a
    restart: "no"
    env_file:
      - /home/dev/rollback-drill/scratch-orch/interp.env
    environment:
      SYNAPSE_SERVER_NAME: ${MATRIX_HOST}
      SYNAPSE_REPORT_STATS: ${MATRIX_REPORT_STATS}
      MATRIX_ADMIN_DID: ${MATRIX_ADMIN_DID:-}
      MAS_SHARED_SECRET: ${MAS_SHARED_SECRET}
    ports:
      - "127.0.0.1:18010:8080"
    volumes:
      - matrix_data:/data
    networks:
      - default

volumes:
  matrix_data:

networks:
  default: {}
```

```bash
# What this does: pre-flight check — confirms the scratch project has nothing running before bring-up (see DANGER section)
docker compose -p matrix-rb-drill-o -f /home/dev/rollback-drill/scratch-orch/docker-compose.drill.yml ps
```
Expected: empty (no containers listed).

```bash
# What this does: brings up the isolated scratch Synapse, explicit -p so it can never resolve to matrix-staging
docker compose -p matrix-rb-drill-o --env-file /home/dev/rollback-drill/scratch-orch/interp.env \
  -f /home/dev/rollback-drill/scratch-orch/docker-compose.drill.yml up -d
```
Expected: `Container matrix-rb-drill-o-matrix_synapse-1  Started`

```bash
# What this does: tears the scratch stack down completely, including its volume, when the drill is done
docker compose -p matrix-rb-drill-o --env-file /home/dev/rollback-drill/scratch-orch/interp.env \
  -f /home/dev/rollback-drill/scratch-orch/docker-compose.drill.yml down -v
```
Expected: containers and volume removed.

**Caveat:** the scratch Synapse shares the real `server_name` and signing key,
and it introspects tokens against the LIVE `https://dev.siwx.inblock.io` — that
is exactly the real rollback topology, which is what makes the drill meaningful.
Keep it short-lived and tear it down promptly.

---

## Section 5: Drill evidence (2026-08-30)

- Snapshot taken with Synapse stopped; downtime window 14:54:04→14:54:19 UTC (15 seconds).
- Archives pass `gzip -t`; `sha256sum -c MANIFEST.sha256` → 24 OK, 0 failing.
- Restored scratch container ran the pinned digest; `pip show matrix-synapse` → `Version: 1.154.0`.
- Boot log confirmed: `synapse.config.logger ... WARNING - main - Server .../homeserver.py version 1.154.0` and `synapse.app._base ... Synapse now listening on TCP port 8080`.
- `grep -c msc3861 /data/homeserver.yaml` inside the restored container → `1` (the load-bearing block survived the restore).
- Restored DB: 73 users, including the account created immediately before the snapshot, and its device `ROLLBACK_DRILL_T0`.
- Real login against the restored stack: `/_matrix/client/v3/account/whoami` → 200, `@did-key-z6mkrejizfc98z7cada9hujwmzqo4qcbjycml8wsysudxlag:dev.matrix.inblock.io`, `device_id: ROLLBACK_DRILL_T0`; `/_matrix/client/v3/sync` → 200; garbage token → 401.
- Live dev-staging verified healthy afterward: all six services up, public `/_matrix/client/versions` 200, Element 200, siwx-oidc discovery 200.
- **Independently reproduced (second-hand evidence — see provenance note).** A second
  operator restored the same `matrix_data.tar.gz` into a separate scratch stack
  (project `matrix-rollback-drill`, port 18008) and reports booting it twice with the
  same result each time: Synapse 1.154.0, `/_matrix/client/versions` 200, `/health` OK,
  `msc3861` present in the restored config, and restored account data in the boot logs.

  **Provenance:** every result in the bullets ABOVE this one was executed and its output
  read first-hand. This bullet is that second operator's report. What was independently
  confirmed here is that their stack existed and ran (container
  `matrix-rollback-drill-matrix_synapse-1`, its own network and volume, correctly NOT on
  `proxy_net`); their version banner and status codes were not personally witnessed.
  Treat the restore as **proven once first-hand and corroborated twice second-hand** —
  strong, but if you need repeatability established beyond one witnessed run before a
  risky migration, re-run the Section 4 drill yourself. It takes about five minutes.

---

## Section 6: Known gaps / caveats

- Artifacts live ONLY on the dev box. They cover a failed-migration rollback,
  not box loss. Copying them off-box means copying secrets (`env.snapshot`,
  `homeserver.yaml`, the signing key) — a deliberate decision, not yet taken.
- Redis snapshot is crash-consistent, not stopped-consistent.
- The drill restored Synapse only. siwx-oidc / Redis / Element / LiveKit /
  lk-jwt-service were not re-instantiated from artifacts; their digests are
  recorded above so they can be pinned back, but that path is unrehearsed.
- The drill proves rollback of a *config+data* state to 1.154.0. It does not
  prove a 1.159 → 1.154 downgrade against a schema-migrated DB — the snapshot
  predates any migration, which is exactly why it must be taken before the
  upgrade task runs, not after.
- **Section 2 (in-place rollback) was NOT executed against the live volume.** The
  drill validated the same restore mechanism — same tar, same `docker run … tar xzf`
  pattern, same digest-pinned image — against an isolated scratch volume, and
  proved it boots and serves a login. Section 2 applies that validated mechanism
  to the live volume. The step that is genuinely unrehearsed on live is the
  `rm -rf /dst/*` wipe in Step 3; Step 2's forensic backup exists precisely so
  that step is reversible.
- The drill's login token was issued by the LIVE `https://dev.siwx.inblock.io`
  and introspected by the restored Synapse over the public URL. That is the real
  rollback topology (only Synapse is rolled back; siwx-oidc keeps running), so
  the login proof is representative rather than a lab artifact.
