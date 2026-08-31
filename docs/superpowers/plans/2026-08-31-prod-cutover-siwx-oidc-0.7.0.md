# Production upgrade record, 2026-08-31

**siwx-oidc `b6c8d63` -> `548b543` (aqua-auth 0.7.0) - Element Web 1.12.24 ->
1.12.26 - Synapse 1.154.0 -> 1.159.0**

**Host:** `matrix.inblock.io` / `siwx-oidc.inblock.io` / `element.inblock.io` on
`agentic.inblock.io` (`142.93.168.4`, ssh alias `agentic.inblock.io`, user
`deploy`, port 8022).

**Goal, and it was met:** users do not notice. No logouts, no data loss, no
account loss. Measured interruption was one 502 for siwx-oidc, one for Element,
and ~10 s for Synapse.

**This is a RECORD, not a plan.** All of it shipped on 2026-08-31 between 21:02
and 21:39 UTC. Sections 1-3 are kept because they are the *justification*: the
evidence that made it safe to proceed, and the two gates that were closed first.
Sections 4-6 are what was run and what was measured. **Section 5 (rollback) and
section 7 (follow-ups) are the parts still operationally live** - the rollback
images are still on the box and the follow-up list is still open work.

Verified afterwards by live production traffic: wallet sign-in, passkey sign-in,
and linked-account sign-in. Still without evidence: creating a *new* link
(`link_start`/`link_finish`), whose only change in this upgrade is one appended
`mirror_credential` call that no-ops while the credential store is off.

---

## 1. What is actually changing

Prod runs siwx-oidc image `sha256:5a8be625…`, OCI revision `b6c8d63`, built
2026-07-31. Target is `sha256:458842fa…`, revision `548b543`, built 2026-08-31.
That is **62 commits**, not just the aqua-auth migration: it includes a refresh
-token infrastructure/revocation fix, `provision_user` hardening, the Synapse
admin-auth rewrite, and the deactivation gate.

`548b543` is the exact commit that passed the e2e harness 17/17 in the
2026-08-31 session (`strict_skips=1`, artifact `20260831-025915`).

**The credential store lands OFF.** Prod's compose `environment:` map has no
`AQUA_WEBAUTHN_REDIS_URL`, so day one is a pure code upgrade with no data
migration. Enabling dual-write is a separate, later, independently reversible
step and is NOT part of this runbook.

### The change is one `.env` value

Prod selects the image via `SIWX_OIDC_IMAGE_REF`. No compose edit, no git
operation, no Synapse change, no Redis change.

> **NEVER run `git pull` / `git checkout` / `git stash` in
> `/home/deploy/matrix/stack`.** Four tracked files are modified and uncommitted
> (`config/element-config.json`, `config/livekit.yaml`, `docker-compose.yml`,
> `entrypoints/element_entrypoint.sh`). They carry the live A/V hardening:
> LiveKit UDP port range `20100-20200`, embedded TURN on `3478/udp`, the LiveKit
> healthcheck, and the `lk-jwt-service:0.5.0` pin. A git operation destroys them
> and breaks calls. Commit them to a branch separately, before or after, but not
> as part of this window.

> **Correction, 2026-09-01: the content is NOT at risk, only the deployment
> is.** The warning above stands as an operational rule (a stray `git checkout`
> still reverts prod's live config and breaks calls), but its stated reason was
> wrong. Nothing in that working tree exists only there. Verified by blob
> comparison against `origin/dev`:
>
> | file | prod content |
> |---|---|
> | `config/livekit.yaml` | byte-identical to `origin/dev` @ `60b037b` |
> | `entrypoints/element_entrypoint.sh` | byte-identical to `origin/dev` @ `60b037b` |
> | `docker-compose.yml` | byte-identical to `origin/dev` @ `448cfb4` |
> | `config/element-config.json` | `origin/dev` tip minus the `branding` block |
>
> The original claim was measured against `main`, which is the wrong baseline:
> **`dev` is the integration branch and is 86 commits ahead of `main`.** Prod is
> checked out on `main` @ `f2114ce` and has been hand-patched forward toward
> `dev`, so its tree reads as "modified" while actually being *behind* `dev`
> (prod runs LiveKit v1.12.0 and lk-jwt 0.5.0; `dev` has moved to v1.13.6 and
> 0.6.0). There is therefore nothing to rescue and no capture commit to write.
> The real debt is the `main`/`dev` divergence plus prod tracking the wrong
> branch, which is a separate piece of work.

---

## 2. Evidence the upgrade is safe (all verified 2026-08-31)

| Hypothesis | Verdict | Evidence |
|---|---|---|
| H1 Existing passkeys parse under the new `webauthn-rs 0.6.1-dev` | **CONFIRMED on 100% of prod data** | Prod Redis restored into an isolated container; `migrate-credentials --dry-run` gave `read=57 would_write=57 failed=0`. Re-run with all 7 `webauthn:link/*` keys deleted (forcing DID derivation from every blob) gave the same. Negative control with a valid-base64url, non-`Passkey` body gave `read=58 failed=1`, so the result is not vacuous. |
| H2 The new Synapse client works against prod's Synapse 1.154.0 | **CONFIRMED** | All four MAS routes registered in the running image (`mas/__init__.py:56,59,61,66`); `is_server_admin` is `"urn:synapse:admin:*" in requester.scope` (`msc3861_delegated.py:369-370`); `query_user` returns `is_deactivated` (`mas/users.py:58,79`); `delete_user` accepts `erase: StrictBool` (`mas/users.py:286-288`, `erase_data=body.erase` at `:305`). **Synapse 1.157/1.159 is NOT a prerequisite.** |
| H3 The deactivation gate cuts off nobody | **CONFIRMED** | 27 deactivated accounts. 26 have zero rows in `user_ips` across its full 28-day retention window; last `user_daily_visits` 31 to 105+ days ago. The 1 exception's trace ends in its own deactivation leave events 15.02d ago. No deactivated account has authenticated since being deactivated. |
| H4 A siwx-oidc restart does not log anyone out | **CONFIRMED** | Synapse raises `SynapseError(503)` on introspection failure (`msc3861_delegated.py:509-514`); `M_UNKNOWN_TOKEN` is only raised when introspection *succeeds* and reports inactive (`:521`). Introspection `ResponseCache` TTL 2 min, failures not cached (`:205-211`, `:305`). Measured on dev-staging: a real session saw **zero non-200 responses across 34 samples** through a `--force-recreate`. Actual unreachability ~0.6-1.1 s. |
| H5 Rollback is lossless | **CONFIRMED** | With the flag off the new binary writes nothing the old binary cannot read. No persisted struct changed shape; the only new type derives no serde (`src/db/mod.rs:135-136`). No `aqua:*` key is written. Admin tokens use the existing `token/` prefix and `TokenMetadata`. Critically, **existing passkeys are never re-encoded**: the counter-update path mutates an untyped `serde_json::Value` and re-serializes *that*, not the `Passkey` struct (`src/webauthn.rs:566-590`), so the webauthn-rs version cannot touch a stored credential's encoding. |
| H6 No new config is required | **CONFIRMED** | Every new key has a compiled-in default. `AQUA_WEBAUTHN_REDIS_URL` absent = legacy namespace only (`src/credential_store.rs:64-67`). A *malformed* `SIWEOIDC_ADMIN_TOKEN_TTL_SECS` would panic at boot, but prod does not set it. |

### Pre-flight already completed

- Redis backup: `/home/deploy/backups/redis/data-20260831T204039Z/` — the
  **whole `/data` tree** (`dump.rdb` + `appendonlydir/`). With `appendonly yes`
  Redis loads from `appendonlydir/` and ignores `dump.rdb`, so an RDB-only
  backup would silently restore a stale dataset. **Restore is proven**: this
  artifact was loaded into a scratch container and came up at DBSIZE 962 vs
  live 963 (the delta is expiring 5-minute access tokens).
- GHCR pulls repaired. Prod's stored `ghcr.io` credential was expired, so
  `docker pull` returned `denied` for every tag and the cutover would have
  failed mid-window. All three inblockio packages are public; the stale auth
  entry was removed (`~/.docker/config.json.bak.20260831T204143Z`).
- New image pre-staged on prod, so the recreate window stays ~1 s and a registry
  outage cannot strand the stack.
- Old image `sha256:5a8be625…` confirmed present locally: **rollback needs no
  network.**

---

## 3. Gates that were closed before cutover

### Gate A — `POST /oauth2/admin_token` is publicly exposed (SECURITY)

The upgrade adds an internet-reachable route (`src/axum_lib.rs:1319-1322`)
authenticated by `Authorization: Bearer {MAS_SHARED_SECRET}`
(`src/admin_token.rs:212-243`) that mints a token whose introspected scope
carries `urn:synapse:admin:*`. Prod's Caddy block for `siwx-oidc.inblock.io` is
a bare `handle { reverse_proxy siwx-oidc:8081 }` with **no path matcher**, so
every route is public.

This **invalidates the containment argument in SEC-0006**, which discounted the
leaked `MAS_SHARED_SECRET` on the grounds that `/_synapse/admin/*` and
`/_synapse/mas/*` are 404'd at the edge (SEC-0003) and the secret was therefore
network-local. After this upgrade that secret remotely mints an admin-scoped
principal.

**Mitigation (verified safe):** block the route at the edge. Nothing in
production uses it over HTTP — `synapse_client` mints in-process, and the only
HTTP caller anywhere is the e2e suite
(`tests/e2e_account_lifecycle_live.rs:481`). In `/home/portal/portal/Caddyfile`,
inside the `siwx-oidc.inblock.io` block and **before** the catch-all `handle`,
using the same idiom already used for `/_synapse/admin/*`:

```caddyfile
    handle /oauth2/admin_token {
        respond 404
    }
```

Then `caddy validate` and a graceful `caddy reload` (reload fails closed: an
invalid config is rejected and the running config is kept).

Rotating `MAS_SHARED_SECRET` in the same window is the stronger fix and has nil
user impact under MSC3861 (established by SEC-0002/SEC-0004). Doing both is
preferred.

**CLOSED 2026-08-31 21:02 UTC.** Patch applied to
`/home/portal/portal/Caddyfile` (backup
`Caddyfile.bak-precutover-20260831T210243Z`), `caddy validate` returned
"Valid configuration", graceful `caddy reload` rc=0. Verified after reload:
`/oauth2/admin_token` -> 404 at the edge, `/oauth2/introspect` -> 415 (i.e. it
still reaches the app; Caddy would have returned 404), and
`siwx-oidc` / `matrix` / `element` all still 200. SEC-0006 addendum recorded in
`~/.claude/SECURITY.md`.

### Gate B — backward compatibility of newly registered passkeys

A passkey registered *after* the upgrade must remain readable by the old binary,
or rollback is lossy for that user. Existing credentials are unaffected (H5).

Source analysis says yes: `CredentialID` moved from `HumanBinaryData` to
`Vec<u8>` + `#[serde_as(as = "IfIsHumanReadable<Base64<UrlSafe, Unpadded>>")]`,
the COSE fields `x`/`y`/`n` made the same move with `PickFirst` (which adds read
leniency), no field was added or removed, no type uses
`#[serde(deny_unknown_fields)]`, and a byte-identity round-trip on a real
ceremony-produced credential is asserted in
`passkey_blob_from_webauthn_rs_060dev_still_deserializes_and_derives_same_did`.

**CLOSED 2026-08-31, CONFIRMED empirically.** Two scratch crates were built, one
pinned to `=0.6.1-dev` and one to `=0.6.0-dev`. 26 blobs emitted by 0.6.1-dev
were fed to the 0.6.0-dev reader: **26 parsed, 0 failed, and every one
re-serialized byte-identically**. Four came from REAL ceremonies
(`start_passkey_registration`/`finish_passkey_registration` against
`webauthn-authenticator-rs =0.6.1-dev` `SoftToken`/`SoftPasskey`, two with three
further authentication ceremonies bumping the counter to 3); 21 were synthesized
to cover shapes no soft authenticator can produce (RSA `n`, OKP `x`,
TPM/AndroidKey/SafetyNet metadata, `AttCa`/`AnonCa`/`ECDAA`/`Uncertain`
attestation, `transports` populated and null, counter at `u32::MAX`); 1 was the
0.6.0-dev fixture as a positive control. **Negative control passed 8/8**: missing
`counter`/`cred_id`/`cred`/`attestation`, a string counter, a non-base64
`cred_id`, and two bogus enum variants all exited non-zero.

Mechanism: 0.6.1's `IfIsHumanReadable<Base64<UrlSafe, Unpadded>>` and 0.6.0's
`HumanBinaryData` both emit base64url-unpadded strings in JSON, and 0.6.0's
deserializer accepts a permissive union ("url-safe base64-encoded string, bytes,
or sequence of integers") that strictly subsumes 0.6.1's output. `CredentialV5`
has the same 11 fields in both versions, so 0.6.1 cannot omit a field 0.6.0
requires. Production passkeys are the ES256/EC2/`packed` shape that the real
ceremonies cover directly.

---

## 4. Cutover

Preconditions: gates A and B closed; stack healthy; backup present.

```bash
ssh agentic.inblock.io

# 0. Verify preconditions
cd /home/deploy/matrix/stack
docker ps --filter name=matrix- --format '{{.Names}}\t{{.Status}}'
docker image inspect ghcr.io/inblockio/siwx-oidc@sha256:458842fae04aa45539bce5040c11017d7c8eb56b13c801a03bbdb442324ee7f1 \
  --format '{{index .Config.Labels "org.opencontainers.image.revision"}}'   # must print 548b543...
ls -d /home/deploy/backups/redis/data-20260831T204039Z

# 1. Back up .env (NEVER `git checkout` here)
cp -a .env .env.bak-precutover-$(date -u +%Y%m%dT%H%M%SZ)

# 2. Point SIWX_OIDC_IMAGE_REF at the new digest (edit in place; do not retype the file)
#    SIWX_OIDC_IMAGE_REF=ghcr.io/inblockio/siwx-oidc@sha256:458842fae04aa45539bce5040c11017d7c8eb56b13c801a03bbdb442324ee7f1

# 3. Recreate ONLY siwx-oidc. --no-deps keeps redis and synapse untouched.
docker compose up -d --no-deps siwx-oidc
```

### Verification (all must pass)

```bash
# healthy within ~20s
docker ps --filter name=matrix-siwx-oidc-1 --format '{{.Status}}'

# the flag must report DISABLED — this is the load-bearing line
docker logs matrix-siwx-oidc-1 2>&1 | grep -i "credential store"
# expect: credential store: dual-write DISABLED (AQUA_WEBAUTHN_REDIS_URL unset); legacy namespace only

# running revision
docker inspect matrix-siwx-oidc-1 --format '{{.Config.Image}}'

# discovery + introspection reachable
curl -sS -o /dev/null -w '%{http_code}\n' https://siwx-oidc.inblock.io/.well-known/openid-configuration

# the admin_token route must now 404 at the edge (Gate A)
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://siwx-oidc.inblock.io/oauth2/admin_token
```

Then, the only test that actually matters: **complete one real login** (wallet
and passkey) from Element, and confirm an already-open Element session keeps
syncing without re-authenticating.

Watch for 10 minutes. The specific new failure mode to watch for is
**fail-closed login on Synapse errors**: `reject_if_deactivated` adds a blocking
`GET /_synapse/mas/query_user` to every sign-in and 401s if Synapse errors, so a
Synapse hiccup now blocks logins where it previously did not.

## 5. Rollback

```bash
cd /home/deploy/matrix/stack
cp -a .env .env.bak-prerollback-$(date -u +%Y%m%dT%H%M%SZ)
# restore SIWX_OIDC_IMAGE_REF=ghcr.io/inblockio/siwx-oidc@sha256:5a8be625e31bb704c0259265547d8e7977ba36eb4ee1a67785d42ab3ee2cdfeb
docker compose up -d --no-deps siwx-oidc
```

The old image is already local, so this needs no network. Per H5 no data
migration is required. Per Gate B, check for passkeys registered during the
window before rolling back.

## 6. Execution record — 2026-08-31

| Time (UTC) | Step | Result |
|---|---|---|
| 20:40 | Redis backup + restore rehearsal | `data-20260831T204039Z`, 86 MB; restored to DBSIZE 962 vs live 963 |
| 20:41 | Stale GHCR credential removed, new image pre-staged | pull works; revision `548b543` verified in the image |
| 21:02 | **Gate A**: Caddy edge block applied + reloaded | rc=0; `admin_token` 404, `introspect` 415, all sites 200 |
| 21:03 | `.env` `SIWX_OIDC_IMAGE_REF` -> `sha256:458842fa…` | backup `.env.bak-precutover-20260831T210306Z`; `compose config --images` confirmed only siwx-oidc changed |
| 21:03:34 | `docker compose up -d --no-deps siwx-oidc` | recreated |
| 21:03:45 | container healthy | 6 s after `up` returned |

**Measured user impact: one 502 in 52 edge probes at 0.3 s cadence** (a single
~0.3 s sample at 21:03:44). Everything else 200.

Post-cutover verification, all passing:

- Running revision `548b543401cbcdd1ade383ec919305cd34da9a5d`, container healthy.
- Boot log: `credential store: dual-write DISABLED (AQUA_WEBAUTHN_REDIS_URL unset); legacy namespace only`.
- **48 responses served, all HTTP 200. Zero 4xx, zero 5xx, zero WARN, zero ERROR.**
  Of those, **15 `/oauth2/introspect` and 4 `/token`**, i.e. live sessions were
  being validated and refreshed by the new binary within seconds of boot.
- Redis unchanged and untouched by the new code: `webauthn:credential/*` = 57,
  `webauthn:link/*` = 7, `webauthn:by_did/*` = 30, **`aqua:*` = 0**.
- Synapse healthy, **0** introspection errors in the window.
- Users `total=207 deactivated=27 active=180`, devices `1214` — identical to the
  pre-upgrade inventory. `@siwx-admin` not yet created (it appears on the first
  admin-scoped call).
- Edge: siwx-oidc, matrix, element, element `config.json` all 200;
  `/oauth2/admin_token` 404.

**Acceptance: PASSED.** Wallet and passkey sign-in were both exercised
interactively by the operator, and **linked-account sign-in was proven by live
traffic**: three resolutions of credential `rQaJHP…` to its wallet `did:pkh`
(`src/credential_identity.rs` logs only on the linked branch), each immediately
followed by a successful `verify_credential` returning the **wallet** DID rather
than the passkey's derived `did:key`. That credential's sign counter reached 11
with no `Sign count regression`, so clone detection and the counter-reconciliation
fix are both live. Across the 90-minute post-upgrade window: 1413 x 200, 3 x 201
(dynamic client registration), 6 x 303 (OIDC redirects), 1 x 405 (a stray `GET`
on the POST-only `/token`). No 5xx.

**Still without evidence:** creating a *new* link (`link_start`/`link_finish`),
and unlink/erasure via `purge_identity`. The link write path's only change in
this upgrade is one appended fire-and-forget `mirror_credential` call that
returns immediately while the credential store is off, and the two HTTP handlers
are byte-identical to `b6c8d63`, so the risk is low but untested.

## 7. Follow-ups (deliberately NOT in this window)

1. **Remove the public introspection hairpin.** `homeserver.yaml` sets
   `issuer: https://siwx-oidc.inblock.io` with no `introspection_endpoint`
   override, so Synapse discovers the **public** introspection URL. Every Matrix
   request's auth therefore egresses through public DNS + TLS + `portal-caddy-1`,
   making the edge a single point of failure for all authentication. Setting
   `introspection_endpoint: http://siwx-oidc:8081/oauth2/introspect` keeps it on
   the docker network. Worth doing, but it is a Synapse restart and belongs in
   its own window.
2. **`POST /register` is unauthenticated and public** (dynamic OIDC client
   registration). Unbounded client creation. Gate it at the edge or in-app.
3. **Schedule the Redis backup.** The current one is a manual one-off; there is
   no cron entry, no systemd timer, and no documented restore procedure.
4. **Fix `docs/deployment-recovery-reference.md:243-250`.** It records Redis
   loss as "Active sessions lost; users must re-login". Redis also holds
   `webauthn:credential/*` and `webauthn:link/*`, so the true impact for a
   passkey-only user is **account loss** — they cannot re-login at all.
5. ~~**Commit the four uncommitted A/V-hardening files** so the prod working
   tree stops being load-bearing.~~ **Closed 2026-09-01, no action needed: the
   premise was false.** All four files are reproducible from `origin/dev` (see
   the correction box in section 1). What replaced this item:
   - `.gitignore` now ignores `.env.bak*` and friends. Prod's checkout held 21
     plaintext copies of `SIWEOIDC_SIGNING_KEY_PEM` / `MAS_SHARED_SECRET`,
     untracked *and* unignored, one `git add -A` from a push to a public repo.
   - Those backups were moved out of the git tree to `/home/deploy/secrets/`.
   - The **actual** debt this uncovered: `main` is 86 commits behind `dev`, and
     prod's checkout tracks `main`. Until that is resolved, prod's tree will
     keep looking dirty and any measurement taken against `main` will be wrong.
6. **Synapse 1.159.** Now a free-standing decision rather than a prerequisite.
   1.157.2 is a security release (6 high-severity), so it is still worth doing.
7. **siwx-oidc ignores SIGTERM** (full 10 s SIGKILL grace, in-flight requests
   dropped). Harmless here; a graceful-drain handler would make the window
   cleaner.
8. **Rotations pending:** SEC-0012 (dev-staging OIDC signing key), SEC-0009
   (dev-staging LiveKit), SEC-0010 (prod Synapse `macaroon_secret_key`,
   `form_secret`), SEC-0006 (`MAS_SHARED_SECRET`), SEC-0011 (prod refresh
   tokens), SEC-0001 (GitHub PAT).

---

## 8. Follow-on: Element Web and Synapse upgraded the same evening

Executed 2026-08-31 21:37-21:39 UTC, at the user's request, so the whole stack
could be tested together. Both images come from stack revision `60b037b`, and
**dev-staging was already running byte-identical digests** for both, which is the
proof environment for this pairing.

| Component | From | To | Digest | Outage |
|---|---|---|---|---|
| Element Web | 1.12.24 | **1.12.26** | `sha256:d7ba8b7b…` | 1 x 502 in 26 probes |
| Synapse | 1.154.0 | **1.159.0** | `sha256:1258ee60…` | **~10 s** (18 x 502 at 0.5 s cadence), healthy after 11 s |

### Synapse: the msc3861 -> matrix_authentication_service migration

Synapse 1.157.0 removed `experimental_features.msc3861`, and a leftover non-empty
block is a hard `ConfigError`. `entrypoints/matrix_server.sh:apply_mas_config()`
handles this and runs **unconditionally on every boot** (the first-boot-only
setup block would otherwise leave an already-provisioned `homeserver.yaml`
crash-looping forever).

Pre-flight checks done before executing, because that function has a documented
destructive path: it re-derives `endpoint` and `secret` from the environment
every boot, so an env regression would overwrite a working config with empty
strings and 1.159 would refuse to boot with the last-known-good gone. Verified on
prod first that both inputs were non-empty inside the **Synapse** container
(`MAS_SHARED_SECRET` len 64, `SIWEOIDC_BASE_URL` len 28; `SIWEOIDC_INTERNAL_URL`
unset, so `endpoint` falls back to the public base URL and the existing network
path is preserved exactly).

Result, verified after the restart:

- `grep -c msc3861 /data/homeserver.yaml` = **0**
- `matrix_authentication_service:` present with `enabled: true`,
  `endpoint: https://siwx-oidc.inblock.io`, `secret:`
- `GET /_matrix/client/v1/auth_metadata` -> 200, `issuer`
  `https://siwx-oidc.inblock.io/` (trailing slash intact),
  `account_management_uri` `https://siwx-oidc.inblock.io/account`
- Synapse `ERROR`/`CRITICAL`/`Traceback` since restart: **0**
- siwx-oidc served **86 responses, all 200**, including **52 introspections and
  16 `/token`** in the first 3 minutes, i.e. Synapse is delegating auth and live
  sessions are refreshing.

### Database

**`schema_version` stayed at 94.** 1.159 did not apply a schema migration over
1.154, so the one-way-migration risk did not materialise. Counts identical before
and after: users 207, deactivated 27, devices 1214, events 23417, rooms 234.

A consistent pre-upgrade backup was taken anyway via SQLite's online backup API
(3.9 s, 356 MB): `/home/deploy/backups/synapse/homeserver-20260831T213611Z.db`,
`PRAGMA integrity_check` = `ok`, all counts matching live.

### Element

Config and entrypoint are **host-mounted**
(`./config/element-config.json:/app/config.json.src:ro`,
`./entrypoints/element_entrypoint.sh:/docker-entrypoint.sh:ro`), so the image
bump changed only the app bundle. Verified after the upgrade that every
customisation survived: brand `inblock.io Chat`, `permalink_prefix`
`https://element.inblock.io` (substituted cleanly, no `%%` placeholders left),
`element_call.use_exclusively` with no hardcoded `url` so the local SFU is used,
`feature_inblock_encrypted_search: true`, `force_verification: true`,
`sso_redirect_options.immediate: true`.

### Rollback for these two

Element: restore `ELEMENT_IMAGE_REF` to `sha256:0013c053…`, recreate. Clean.

Synapse: restore `SYNAPSE_IMAGE_REF` to `sha256:60c30d63…` **and** restore
`/data/homeserver.yaml.bak-pre1159-20260831T213830Z`. The config restore is
mandatory, not optional: the entrypoint deleted the `msc3861` block and 1.154
does not understand `matrix_authentication_service`, so rolling the image back
alone leaves Synapse with no delegated-auth config.

Backups from this window: `.env.bak-element-20260831T213747Z`,
`.env.bak-synapse-20260831T213848Z`,
`/data/homeserver.yaml.bak-pre1159-20260831T213830Z`,
`/home/deploy/backups/synapse/homeserver-20260831T213611Z.db`.
