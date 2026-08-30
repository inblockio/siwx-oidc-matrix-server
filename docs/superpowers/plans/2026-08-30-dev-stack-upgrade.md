# Dev-staging full stack upgrade (Synapse 1.159 + MAS migration + 3 pins)

Date: 2026-08-30 · Owner: Tim · Process: `/process-pipeline`
Target: **dev-aquafire only** (`ssh -p 8022 dev@207.154.209.103`). Prod (142.93.168.4) is OUT OF SCOPE.

## Why now

Synapse **1.157.2 is a security release** (6 high / 3 moderate / 2 low), flagged for servers in
open federation. There is **no backport to 1.156.x**, and **1.157.0 removed
`experimental_features.msc3861`** — so the security fix is only reachable through the MAS
migration. Secondary driver: every server whose events `beta2.matrix.org` policyserv signs runs
Synapse >= 1.157.2; we are on 1.154.0 and are the only one refused (see H10).

## Hypothesis Register

| ID | If | Then | Assumptions | Verification |
|----|----|------|-------------|--------------|
| H1 | we capture pre-migration `homeserver.yaml` + DB snapshot + current image digests, and **restore-drill them into a scratch stack** | a failed migration is fully recoverable | volume snapshot is consistent while Synapse is stopped | scratch stack boots 1.154.0 from the artifacts and serves a login |
| H2 | siwx-oidc mints a short-TTL token whose introspection response carries `urn:synapse:admin:*` | Synapse 1.159 accepts it on `/_synapse/admin/*` | `is_server_admin()` remains scope-based in 1.159 | `GET /_synapse/admin/v2/users/{u}/devices` with minted token → 200; without → 401 |
| H3 | `delete_device` / `deactivate_user` / `reactivate_user` are ported to `/_synapse/mas/*` | MSC4191 `device_delete` and account deactivate/erase/reactivate work on 1.159 | MAS endpoints accept the shared secret and cover `erase` | e2e: each action end-to-end, asserting Synapse-side state changed |
| H4 | `list_devices` / `get_device` use the H2 token | `devices_list` / `device_view` do not regress | no MAS device-list endpoint appears | `/account?action=devices_list` returns the real device list |
| H5 | `matrix-storage-controller.sh` uses the H2 token | media retention + WARN/CRIT server notices keep working | script can reach the mint endpoint | controller run: `purge_media_cache` 200, media delete 200, notice delivered |
| H6 | `matrix_authentication_service:` replaces `experimental_features.msc3861` | Synapse 1.159 boots and login works end-to-end | siwx-oidc discovery already satisfies the stable path | full login e2e green on migrated stack |
| H7 | Element Web 1.12.26 builds with all 6 vendored patches | browser surface works, no patch silently regresses | upstream has not fixed `setup-encryption-busy-wedge` (confirmed: still applies) | build succeeds + browser e2e walk |
| H8 | LiveKit 1.13.6 replaces 1.12.0 | A/V calls still establish, incl. embedded TURN | 1.13.1 TURN-auth compat removal does not bite (we already run post-change semantics) | live call on dev-staging; TURN relay observed |
| H9 | lk-jwt 0.6.0 replaces 0.5.0 | JWT issuance works via `.well-known` discovery | dev-staging `.well-known` is reachable from the container | `/livekit/jwt/healthz` 200 + real call obtains a token |
| H10 | Synapse >= 1.157.2 replaces 1.154.0 | `beta2.matrix.org` policyserv signs our events (federation send bug resolves) | the refusal is signature-verification, not an MXID filter | replay-trace against beta2 from the upgraded server |
| H11 | the `OIDC_E2EH_DIR` stale default is fixed | oidc/device-code e2e checks actually run instead of silently `exit 2` | — | harness artifacts non-zero; checks report pass/fail, not skip |
| H13 | the entrypoint writes the `matrix_authentication_service` block into an **existing** `homeserver.yaml`, not only a fresh one | dev-staging lands on 1.159 with working auth instead of no auth config at all | the first-boot guard can be made to run on an existing file, or is bypassed deliberately | on a stack with a pre-existing 1.154 config, run the migration entrypoint; assert the resulting yaml contains `matrix_authentication_service`, contains NO `msc3861`, and that a login then succeeds |
| H12 | in-test early-returns that skip past all assertions are made honest (fail-loud or explicitly reported) | a green e2e result actually means the behaviour was exercised | tightening may turn currently-green checks red — that is information, not damage | force each guard's condition true; assert the test now FAILS instead of reporting `ok` |

**H10 is DEMOTED off the critical path (Tim, 2026-08-30).** It is no longer a gate and no longer
mine to verify: Tim will retest the federated send from the dev server himself after the upgrade
lands. Rationale: the upgrade is justified by the security release alone, and further forensics
before upgrading is wasted effort when we are this far behind. No outward-facing join is needed.

## Boundary conditions

- **Invariant:** prod is never contacted for writes. No push to `main`.
- **Invariant:** no migration step runs before H1's restore drill passes.
- **Invariant:** admin-scoped tokens are short-TTL and minted on demand — never a static
  long-lived credential in `.env`.
- **Invariant:** the storage controller must fail LOUDLY on auth failure. Silent media-retention
  failure filling the 100 GB volume is the worst outcome in this plan.
- **Exclusion:** prod promotion. This plan ends at "dev-staging green + digests recorded".
- **Exclusion:** H10 verification. Tim runs it post-upgrade. No dev-staging join of `#element-dev`.
- ~~**Risk 1:** rollback is not an image revert~~ **OVERSTATED — CORRECTED 2026-08-30 (H13 task).**
  Synapse **1.154.0 already ships `config/mas.py` + `api/auth/mas.py`** and honours
  `matrix_authentication_service`. Proven: 1.154.0 booted on a MAS-only config, attached
  `MasResource`, served a login. So a **1.159 -> 1.154 image revert does NOT lose auth and does NOT
  require restoring a pre-migration `homeserver.yaml`** (`whoami` 200 after rollback). Only a
  rollback *below the stable-MAS floor* would. And the UNmigrated path fails **loudly**: 1.159
  raises `ConfigError: experimental_features.msc3861 was removed` and exits 1.
  **NEW Risk 1':** the always-run rewrite re-derives from env every boot, so an **env regression is
  newly destructive** — with `SIWEOIDC_BASE_URL` or `MAS_SHARED_SECRET` empty, unguarded writes
  OVERWROTE a working config with `endpoint: ""` and the last-known-good was gone from disk. One
  `.env` edit triggers it. Mitigated by the skip-guard on `verify/h13-entrypoint-existing-config`.
- **Risk 2:** H2 fails → no admin API path at all → H4/H5 unreachable → upgrade must not ship.
- **Risk 3:** dev-staging `.env`/compose drift — LiveKit and lk-jwt do NOT converge via `:dev`;
  both need a manual edit on the box.

## Tasks

### Task 0: Rollback artifacts + restore drill
**Hypotheses:** H1
- [ ] Stop Synapse on dev-staging; snapshot the data volume + `homeserver.yaml`; record all current image digests
- [ ] Restore into a scratch stack on distinct ports; boot 1.154.0; serve one login
- [ ] **GATE: no further task starts until this passes**

### Task 1: Fix the e2e harness so it can actually judge the rest
**Hypotheses:** H11
- [ ] Fix the `OIDC_E2EH_DIR` stale default; prove oidc/device-code checks run and produce artifacts

### Task 1b: Make skip-passes honest (ADDED 2026-08-30, discovered during execution)
**Hypotheses:** H12
Three tests in the **siwx-oidc** repo early-`return` past all their assertions and cargo reports
them `ok`. Worst: `tests/e2e_session_teardown.rs:352` and `:394`, whose guard is
`device_id.is_none()` — broader than the documented "Synapse introspection 503" rationale used by
sibling files, so ANY whoami non-200 silently converts them to no-op passes.
**Why this is now blocking, not cosmetic:** session teardown is exactly what MSC4191
`device_delete` exercises, and Task 3 ports those very call sites. Without H12, H3 and H4 cannot be
verified — a green run would prove nothing.
- [ ] Make the guards fail loudly (or at minimum hard-fail under the pipeline's strict mode)
- [ ] Prove it: force each guard true, assert the test FAILS rather than reporting `ok`

### Task 2: Admin-scoped token mint in siwx-oidc
**Hypotheses:** H2
- [ ] Mint endpoint authenticated by the MAS shared secret, returns short-TTL `urn:synapse:admin:*` token
- [ ] Introspection renders the scope; negative test: wrong secret → 401, expired token → inactive

### Task 3: Port synapse_client.rs
**Hypotheses:** H3, H4
- [ ] `delete_device`/`deactivate_user`/`reactivate_user` → `/_synapse/mas/*`
- [ ] `list_devices`/`get_device` → admin-scoped token
- [ ] Verify `has_cross_signing_keys` + `has_profile_row` auth still valid on 1.159
- [ ] **Acceptance:** the 4 checks currently red for lack of `admin_token`
      (`device_management_live` + 3 `cross_signing_reset`) go GREEN via the NEW admin-scoped token
      path. They are the natural regression test for this task — do not "fix" them by restoring
      `admin_token`, which no longer exists in 1.159.

### Task 4: Re-auth matrix-storage-controller.sh
**Hypotheses:** H5
- [ ] Obtain token via Task 2; loud failure on auth error
- [ ] Prove purge/delete/notice all 200 against a migrated stack

### Task 5: Synapse 1.159 + MAS config migration
**Hypotheses:** H6, H13
**PRECONDITION — H13 must be proven BEFORE this task migrates anything.**
Observed live during Task 1 (2026-08-30): the e2e Synapse's `homeserver.yaml` contains
`experimental_features: {}` — no `msc3861` block and therefore no `admin_token` — **even though
`synapse_entrypoint.sh:43` is written to set it.** Cause: the entrypoint's first-boot guard does
not repopulate an already-existing config file. This is plan Risk 1, no longer theoretical.
**Why this is dangerous for Task 5:** dev-staging has an existing `homeserver.yaml`. If the same
guard skips the rewrite, dev-staging lands on 1.159 with a stale `msc3861` block that 1.159 no
longer honours and NO `matrix_authentication_service` block — i.e. total auth failure, on the one
release where rollback is hardest. The parked commit `2f7bc92` does touch both entrypoints; that is
necessary but NOT sufficient evidence — prove it against an existing config, not a fresh volume.
- [ ] Prove H13 on a stack seeded with a pre-existing 1.154 config
- [ ] Land the parked `2f7bc92`; full login e2e on the migrated stack

### Task 6: Element Web 1.12.26
**Hypotheses:** H7

### Task 7: LiveKit 1.13.6
**Hypotheses:** H8

### Task 8: lk-jwt 0.6.0
**Hypotheses:** H9

### Task 9: Policy-server retest — OUT OF SCOPE (Tim runs it post-upgrade)
**Hypotheses:** H10 (demoted, not a gate)


## Discovered During Execution (NOT in the original register — audit section)

Per process-pipeline invariant 4, the hypothesis register is immutable during execution; findings
that were not planned hypotheses are recorded here instead.

### D1 — `has_cross_signing_keys` is broken on 1.159 AND fails silently (Task 3, 2026-08-30)
A THIRD broken call, beyond the two the task brief named. `POST /_matrix/client/v3/keys/query`
with the raw shared secret → `401 M_UNKNOWN_TOKEN`; with a minted admin token → `200`.
`KeyQueryServlet.on_POST` calls `get_user_by_req()` unconditionally, so no config makes it
anonymous. **The 401 never surfaced as an error** — it degraded into a `ResetUnconfirmed` readback,
i.e. every cross-signing reset would tell the user *"we could not confirm your reset took effect"*
**while the reset had in fact been granted.** This is the true cause of all three red
`cross_signing_reset` e2e checks. A user-facing silent failure that would have shipped.

### D2 — `has_profile_row` was never broken, and its auth was never load-bearing (Task 3)
`GET /_matrix/client/v3/profile/{mxid}` authenticates only under
`require_auth_for_profile_requests` (default **false**), so it returns 200 with **no** auth header
at all. The shared secret it was sending was being **ignored, not honoured**. Relevant to the
provisioning self-heal documented in memory `provision-retry-hardening`: that check works, but not
for the reason the code comment implies.

### D3 — MAS `delete_user` preserves the erase distinction (Task 3)
Not a deletion: a pass-through to the same `deactivate_account(user_id, erase_data=erase)` handler
the old admin route used. `erase:false` stays reversible, `erase:true` stays GDPR erasure. `erase`
is a required `StrictBool` with **no default**, so omitting it is a validation error rather than a
silent `false` — the collapse-to-false failure mode is not reachable.

### D4 — No MAS device-listing endpoint exists (Task 3, confirms H4's premise)
`sync_devices` looks list-shaped but returns `{}` and never the list. So `list_devices` /
`get_device` genuinely must use the minted admin token; there is no MAS alternative to prefer.

### D5 — Three silent skip-as-pass defect classes in the e2e harness (Task 1/1b)
(a) stale `OIDC_E2EH_DIR` → adapters `exit 2` with 0-byte artifacts; (b) `cargo test` exits **0**
when a name filter matches nothing, so a renamed test was a pass asserting nothing; (c) harness
errors laundered into `known-flagged`, so a check that could not find its repo still exited 0.
Plus in-test early-returns reporting `ok` — a whoami **404** (genuinely broken teardown) produced
three green passes before the fix.

### D6 — `COMPOSE_PROJECT_NAME` in `.env` overrides a compose file's `name:` key (Task 0)
Only an explicit `-p` beats it. Caused a self-inflicted **~90s dev-staging outage** during the
rollback drill. Now a boxed DANGER section in the rollback runbook and a landmine entry in memory.

## Open cleanup items (do not lose these)

From Tasks 6-8 on **dev-staging** (2026-08-30) — throwaway artifacts to remove:
- OIDC client `4b2aac04-9829-44df-a0a5-0fe2c659c349`
- account `@did-key-z6mkmgafz1e8j1ivhssurmxco2qbrrtadcwso9ay6nsfnuxu`
- account `@did-pkh-eip155-1-0x8dd40fe612e00be92b6910608f86f21652af1000`

(Precedent: prod accumulated 15 such probe accounts on 2026-07-31 before a sweep. Clean these
before closing the branch.)

### D7 — lk-jwt 0.6.0's HEALTHCHECK is unconditionally broken (Task 8)
See memory `lk-jwt-060-healthcheck-broken`. Would have failed EVERY future dev-staging converge —
including unrelated deploys — silently stopping the CD sink, and would hit prod on its next manual
deploy. Fixed by disabling the healthcheck in all three composes.

### D8 — H.264 risk is smaller than the changelog implied (Task 7)
Settled from LiveKit PR #4723's actual diff, not the commit message: only H.264 **baseline
`42001f`** left the default offer. **Constrained baseline `42e01f` and high `640032` remain**,
alongside VP8/VP9/AV1. `42e01f` is what browsers and mobile WebRTC actually offer. Smaller risk
than feared — but not zero, and the iOS/Safari leg is where it would show.

### D9 — Storage controller: unmounted-volume blind spot (Task 4) — LATENT PROD BUG
`df` on a directory whose mount has gone away reports the **root** filesystem, not a failure. The
controller would read "roomy", prune nothing, and exit 0 **while the 100 GB volume went entirely
unmonitored**. Independent of this migration; it has presumably always been true. Now fatal via
device comparison (`ALLOW_VOL_ON_ROOT=1` for the documented rollback config).

### D10 — Storage controller: unbounded curl could hang a tick forever (Task 4)
A backend that accepts the connection and never answers hung the tick indefinitely — no fatal line,
no marker, **no exit code at all**, and the next hourly tick may never start. Strictly worse than
any reportable failure. All curls now bounded + `TimeoutStartSec=1800`.

### D11 — Alert-state was committed before delivery (Task 4)
`alert_transition` committed the WARN/CRIT level even when the notice failed, **losing that alert
forever**. Now committed only on delivery, retry proven. Sibling: `announce_recovery` logged ERROR
and returned 0, so a tick whose recovery announcement failed still printed `tick ok` and exited 0.

### D12 — The storage controller is NOT installed on dev-staging (Task 4)
No script, no timer — it is **prod-only**. So H5 is confirmed on a local Synapse 1.159 stack and is
**not exercised by the dev-staging upgrade at all**. The change reaches prod outside this plan's
scope. Carry this limitation into the audit and the promotion runbook.

### D13 — `server_notices` is also written only inside the first-boot guard (Task 4)
Same mechanism as H13, different key: an existing deployment that never had `server_notices`
hand-applied gets 400 forever. Left to H13, which owns `entrypoints/matrix_server.sh`.

### D21 — the branch consolidation itself introduced a silent defect (Task 5)
Merging the three matrix-server branches left **two copies** of the "env-overridable image
refs" block in `e2e-harness/up.sh`. Each branch had added it independently at a slightly
different offset, so `ort` saw two clean additions rather than one and kept both. The copies
DISAGREED — the first pinned `LIVEKIT_IMAGE_REF` to v1.13.6 (what Task 7 shipped and what
dev-staging runs), the second to v1.12.0 — and the later assignment wins. The harness would
have exercised the OLD LiveKit while the branch claimed to have bumped it: a green run
asserting the wrong thing, which is precisely the defect class Task 1b existed to remove.
Found by reading the merged file, not by any test. Fixed in `155c2b2`. A follow-up sweep of
every file touched by all three merges (combined-diff analysis, duplicate shell vars,
duplicate YAML keys, duplicate functions, repeated line-windows) found **no other instance** —
`up.sh` was the only file where git had to interleave hunks from both parents.
**Lesson:** a clean `git merge` with zero conflicts is not evidence of a correct merge.

### D22 — `/_synapse/*` is not reachable at the dev-staging public edge (Task 5)
`tests/e2e_account_lifecycle_live.rs` reads Synapse state back through `MATRIX_HOST`, but
Caddy on dev-staging does not route `/_synapse/admin/*` or `/_synapse/mas/*` publicly — both
return **404** from outside while `/_matrix/client/*` returns 200. Proven not to be a
migration regression: the identical request issued from inside the box answers **200** with a
minted admin token and **401** without one. This is a sibling of D16 (an environmental test
failure, not a code fault), but a distinct one: the fix is to point `MATRIX_HOST` at an
internally-reachable Synapse (an SSH tunnel to the container works) rather than at the public
hostname. Not a defect in the edge config — refusing to expose the admin surface publicly is
the correct posture and should stay.

## Pre-promotion checks for PROD (not this plan, but do not lose)
- `MATRIX_ADMIN_DID` is unset on dev-staging and commented out in both `.env.example`s.
  **Check prod's `.env` before promoting the storage controller**, or set `ALERTS_OPTIONAL=1`.

### D14 — the `device_id` null fix is load-bearing, but NOT for standalone mode (Task 3)
Task 2's `null`-not-`""` fix does not matter for standalone — but not for the reassuring reason.
Standalone never configures `mas_shared_secret`, so `/oauth2/introspect` returns 404 and those
tokens are never introspected by any Synapse; the empty string never reaches one. The genuinely
exposed path is **MSC3861 mode**: `oidc.rs` does `code_entry.device_id.clone().unwrap_or_default()`,
so a token whose device provisioning FAILED carries `device_id: ""` and a truncated
`urn:matrix:client:device:` scope — and that token **is** introspected by a real Synapse, where
pre-fix it was a hard `AuthError(500)`. Proven live: a stored `device_id = ''` now renders
`"device_id": null`. Our docs did not describe this path; now documented in CLAUDE.md.

### D15 — `pub mod synapse_client;` in `src/lib.rs` compiled one file into two crates (Task 3)
Two distinct types sharing one name — the footgun `compat.rs` already documents in a comment.
Nothing outside `src/` consumed the library copy. Removed.

### D16 — 18 e2e failures are environmental, not regressions (Task 3)
`e2e_account_management` (4), `e2e_oauth_binding` (2), `e2e_race_teardown` (12) fail identically on
`ConnectionRefused` to a stub Matrix host at `localhost:8090` — refused before any siwx-oidc request,
so the image under test is irrelevant. They need the `siwx-oidc-matrix-server` harness stub. The 21
unit failures were a missing Redis; with one running, **140 passed / 0 failed**.

## Branch integration debt for Task 5 (consolidation is its own work)
- siwx-oidc: `fix/e2e-honest-skips` (T1b) <- `worktree-agent-a9a9b154945e6ed37` (T2 mint)
  <- `worktree-agent-a31468a63950ea48b` (T3 port, 3 commits, already rebased on T1b)
- siwx-oidc-matrix-server: `fix/e2e-harness-stale-e2eh-dir` (T1), `feat/storage-controller-h5` (T4,
  unpushed), and `origin/dev` already carries T6/T7/T8 as `09f35cb`.


### D17 — the Task 1 `experimental_features: {}` diagnosis was a MISATTRIBUTION (H13 task)
Not "the first-boot guard failed to populate a first write". The baked entrypoint in
`localhost/siwx-real-synapse:local` is the **old** one; the real sequence was
**delete-then-not-restore** — a migrated entrypoint ran against that volume, correctly deleted
`msc3861`, and the old image's guard could not restore it. Consequence: the 4 red checks are
explained by the missing `admin_token` alone (D1 / Task 3), not by broken delegated auth.

### D18 — dev-staging takes an env branch no harness exercises (H13 task)
dev-staging has `SIWEOIDC_INTERNAL_URL` and `SIWEOIDC_PUBLIC_ISSUER` **unset**, so
`apply_mas_config` takes the `SIWEOIDC_BASE_URL` fallback branch — which neither `siwx-h2` nor the
e2e harness ever exercises. Verified against the live box that `SIWEOIDC_BASE_URL` IS set in the
Synapse container (arrives via `env_file: .env`). **Had it been empty, the migration would have
written `endpoint: ""` and dev-staging would not have booted.**

### D19 — the migration silently repairs two live dev-staging drifts (H13 task)
`auth_metadata` starts reporting `account_management_uri = {issuer}/account` and a trailing-slash
issuer, because both knobs stop being Synapse's to hold and come from siwx-oidc's discovery doc.

### D20 — what the first-boot guard owns, and what is frozen (H13 task)
Owns: `server_name`, `public_baseurl`, `listeners[0].{port,resources,tls,type,x_forwarded}` +
`del(listeners[1])`, `serve_server_wellknown`, `retention.enabled`,
`retention.default_policy.allowed_lifetime_max`, `server_notices.*`.
Cross-referenced against dev-staging's live config: **`server_notices` is the only one actually
missing** (D13 confirmed). The rest are correct today but **frozen** — any future template change to
them will never reach dev-staging or prod, including the known `allowed_lifetime_max` misplacement
(see memory `synapse-retention-misconfig`): whenever someone fixes it, the fix will not propagate.

## Decisions escalated to Tim (H13 task declined to take these alone)
1. **`server_notices` (D13):** reconciling it creates a `@notices` user and a "Server Alerts" room —
   a visible, user-facing side effect on dev-staging **and** prod. Left first-boot-only for now.
2. **Shape for the frozen keys.** Recommendation: do **NOT** loosen the guard permanently.
   `server_name` must never be reconciled (rewriting it corrupts the DB) and `retention` has purge
   blast radius. Right shape = a **one-shot versioned migration step** with a
   `/data/.migrations-applied` marker listing applied ids: reaches existing deployments exactly
   once, auditable, never re-asserts over hand edits. Changes prod behaviour beyond this plan.

---

## H8 — two-agent A/V call on dev-staging (2026-08-30, agent-executed)

**Status: CONFIRMED** for the server/SFU/JWT plane. Executed with
`~/aqua-agents/crates/aqua-call-agent` because a live human call was not available.

| Evidence | Result |
|---|---|
| Homeserver targeting | Agent patched `main.rs` to print the SDK-*resolved* homeserver and hard-abort unless it matched `AGENT_REQUIRE_HOMESERVER`; negative-tested the fuse first. Both agents: `https://dev.matrix.inblock.io/`. Post-run audit: 69 refs to dev, **0** to any prod host. |
| Media both directions | Each agent subscribed to the other's video **and** audio (`saw_remote_av=true` both sides); SFU shows 2 `ACTIVE` participants each publishing `VIDEO 640x480 CAMERA` + `AUDIO MICROPHONE`. |
| Byte counters | SFU eth0 **rx +15,169,153 B / 21,341 pkts**, **tx +15,180,543 B / 21,160 pkts** over ~110 s. Control run (A only): rx 7.6 MB but tx just **112 KB** — tx only rises with a subscriber to forward to, which is what makes the numbers meaningful. |
| `m.call.member` | Both published (MSC3757 owned state keys), simultaneous across 12 polls, `foci_preferred` → dev lk-jwt, both cleared to `{}` on leave. |
| lk-jwt / rotated key | Token `iss` = `APIvOWrGBYa6vk` (the key rotated 2026-08-30); SFU accepted both tokens, so lk-jwt and LiveKit share the rotated key. |
| TURN | Edge proven live (TLS 1.3, valid cert, genuine STUN Binding success) but **relay NOT exercised** — ICE chose direct UDP and the Rust SDK gathered no relay candidate. Note: STUN reflexive address came back as `172.18.0.2`, the L4 proxy's own IP, so the TURN server sees Caddy, not the client. |

**Scope limit (stated, not hedged):** the harness uses the Rust SDK's own capture, so it
**cannot** detect the Element-X-on-iOS capture failure class — the 2026-08-04 incident.
This validates the server/SFU/JWT/TURN-edge plane only. EX-on-iOS capture and E2EE
interop with real Element clients remain unverified.

**Cleanup readback:** both throwaway identities `deactivated=1, admin=0`, 0
access_tokens/devices/profiles/user_directory/e2e rows, membership `leave`; server-wide
deactivated 19 → 21; OIDC client deleted (204); private keys shredded; repo restored
clean. One empty room `!SeNjLzVSDMgWhNyVmv:dev.matrix.inblock.io` remains.

### Findings from the H8 run — verified independently

**F1 — dev siwx-oidc ES256 signing key exposed. ROTATED 2026-08-30.**
The agent ran `printenv | cut -d= -f1` inside the siwx-oidc container; the multi-line
`SIWEOIDC_SIGNING_KEY_PEM` body printed as if each line were a variable name. Rotated
the same day: new P-256 PKCS#8 key generated on the box (never transited an agent
context), `.env` rewritten in place preserving inode (600), service recreated.
JWKS `x` moved `J1GgMPd25Y8wPWrfX7_UxoUdD-wcYCMYqv0_o07fmuA` →
`UIiLHO69tUFWc7cSPAfYeWGfICLgOVviVtOBWuhJ6Ws`; old value absent from `/jwk`. Stack
healthy afterwards (all six containers up, Synapse `auth_metadata` intact — the
MSC3861 path is introspection-based, so it never depended on this key).
Residual: the old key persists in ~10 `.env`/compose backups on the dev box.

**F2 — the agent's "admin API is broken on dev" claim is WRONG.** It concluded that
because Synapse's `matrix_authentication_service:` block has no `admin_token`, the
admin API is unreachable. There *is* no such setting on 1.157+ — it was deleted
upstream, which is exactly why `src/admin_token.rs` exists. Verified live: deployed
image revision is `a28cbb01` == `origin/dev` tip, it contains `src/admin_token.rs`,
and an internal `POST /oauth2/admin_token` mints a real token with scope
`urn:matrix:client:api:* urn:synapse:admin:*` for `@siwx-admin:dev.matrix.inblock.io`.
The external 404 the agent hit is the **deliberate** R12 edge restriction in
`Caddyfile.dev-aquafire:401`. The agent's own cleanup section contradicts its claim —
it successfully deactivated both identities.

**F3 — deactivation is not enforced at sign-in. REAL, ours, unfixed.**
Confirmed from source on both sides: `synapse/api/auth/mas.py` (1.159.0) has **zero**
occurrences of `deactivated`; and our tombstone (`is_user_deactivated`) is consulted
**only** on the refresh/mint path (`oidc.rs:537` + the four `probe_revocation` sites),
never at fresh sign-in. Sign-in's only gate is `is_new_identity` =
`is_localpart_available`, which for a deactivated user reads *not available* → treated
as a normal returning account → tokens issued. So `account_deactivate` /
`account_erase` are undone by logging in again. `/_synapse/mas/query_user` already
returns `is_deactivated` (`rest/synapse/mas/users.py:59,80`), so the fix is a sign-in
gate that fails closed, not a config change. **Prod is affected by inference from
source** (no released version has this gate) — not live-tested, prod stays read-only.

**F4 — minor:** rooms created with the `private_chat` preset (`state_default: 50`)
block PL-0 users from publishing `m.call.member`; `logout/all` 404s on dev (not routed
to siwx-oidc).
