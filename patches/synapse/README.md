# Synapse vendored patches — the registry

This directory is the **complete, canonical list of every modification we apply to
upstream Synapse** before running it. `dockerfiles/Dockerfile` is the single build
source for the Synapse image, and it applies exactly the patches listed here with
`patch --forward --batch --fuzz=0`, so **a patch that stops applying fails the image
build loudly** — never silently at runtime.

The rules are the same as `patches/element-web/README.md`, and for the same reason:

1. **No patch without an entry here.** Every entry states *what*, *why*, the
   *evidence* that made it necessary, its *upstream status*, and its *retirement
   condition* — the observable fact that lets us delete it. A patch nobody can
   retire is a fork forever.
2. **No behavioral patch without test coverage.** The entry names the test.
3. **Upstream-first.** Same three classifications: UPSTREAM DEFECT,
   UPSTREAM-TRACKED, POLICY. Only POLICY is permanent.
4. **Bump procedure** — run this for every `FROM matrixdotorg/synapse:vX.Y.Z`
   change, *before* merging the bump:

   ```bash
   # Fetch the two files at the new tag and dry-run every patch against them.
   TAG=v1.161.0
   d=$(mktemp -d); mkdir -p "$d/synapse/config" "$d/synapse/handlers"
   for f in config/experimental handlers/profile; do
     curl -sSf "https://raw.githubusercontent.com/element-hq/synapse/$TAG/synapse/$f.py" \
       -o "$d/synapse/$f.py"
   done
   for p in patches/synapse/*.patch; do
     (cd "$d" && patch -p1 --dry-run --forward --batch --fuzz=0 < "$OLDPWD/$p") \
       && echo "OK   $p" || echo "FAIL $p"
   done; rm -rf "$d"
   ```

   For each failing patch, consult its retirement condition **before**
   forward-porting: a patch that no longer applies often means upstream changed
   that code — check whether they merged it, and if so DROP the patch rather than
   porting it by reflex.

   Then run the patch's own regression tests against an upstream checkout of the
   new tag carrying the patch (a clone under `~/.cache`, never `/tmp`), together
   with upstream's profile suites:

   ```bash
   cd <synapse-checkout-at-TAG>
   patch -p1 --forward --batch --fuzz=0 < "$REPO/patches/synapse/msc4133-profile-field-write-policy.patch"
   cp "$REPO/patches/synapse/tests/test_msc4133_write_policy.py" tests/handlers/
   poetry install    # --extras all needs pg_config; not required for SQLite tests
   poetry run trial -j8 tests.handlers.test_msc4133_write_policy \
     tests.rest.client.test_profile tests.handlers.test_profile \
     tests.storage.test_profile tests.config.test_experimental tests.rest.synapse.mas
   ```
5. **`patch`, not `git apply`.** `matrixdotorg/synapse:v1.159.0` ships neither
   `git` nor `patch` (verified 2026-09-10), and the installed tree under
   `site-packages/` is not a git repository. The Dockerfile installs `patch` and
   resolves the `synapse` package directory at build time via
   `python -c 'import synapse'`, rather than hard-coding `python3.13` — a base
   image that bumps its Python would otherwise silently skip the patch.
6. **Do not COPY whole pre-patched files in.** That would silently pin our stale
   copy of `handlers/profile.py` across a Synapse bump, quietly reverting whatever
   upstream fixed in it — including security fixes. A `.patch` that fails the
   build is the point.

---

## 1. `msc4133-profile-field-write-policy.patch` — allow/deny-list for custom profile fields

**Classification: UPSTREAM-TRACKED** ([element-hq/synapse#19980](https://github.com/element-hq/synapse/pull/19980)).

**What it does.** Adds two config keys, `experimental_features.msc4133_key_allowlist`
and `experimental_features.msc4133_key_denylist`, and a guard in
`ProfileHandler.set_profile_field` and `ProfileHandler.delete_profile_field` that
raises `403 M_FORBIDDEN` when a **non-admin** tries to write or delete a listed
custom profile field. Admins are exempt.

**Why we need it.** siwx-oidc publishes each user's DID into their Matrix profile
under the MSC4133 custom field `io.inblock.did`, as a provider-signed assertion —
it is the one identifier a relying party can trust to name a user. On stock
Synapse 1.159.0 that field is **freely user-writable with no value validation**:
`set_profile_field`'s only check is `if not by_admin and target_user != requester.user`,
which is simply *not an error* when a user writes their own profile. So any user
could overwrite their own `io.inblock.did` with **another user's DID** and
misrepresent their cryptographic identity to every client and every federating
server that reads it. The signed assertion (see the siwx-oidc repo) makes that
tampering *detectable*; this patch makes it *impossible*.

**Evidence** (all read from the v1.159.0 source, 2026-09-10):

- `synapse/handlers/profile.py:700-704` — the only authorization on a custom-field
  write is the ownership check; there is no value validation anywhere in the path.
- `synapse/rest/client/profile.py:100-103` — the stable
  `/_matrix/client/v3/profile/{user}/{field}` route is registered
  **unconditionally**; `msc4133_enabled` gates only a redundant unstable alias. The
  field is writable out of the box.
- `synapse/config/server.py:561-563` — `require_auth_for_profile_requests` defaults
  to `False`, and custom fields federate via `handlers/profile.py:809 on_profile_query`.
  So a tampered value is world-readable and reaches remote servers.
- `synapse/api/auth/mas.py:274-275` — under MSC3861/MAS, `is_server_admin()` is
  literally `"urn:synapse:admin:*" in requester.scope`, which is exactly what
  siwx-oidc's minted admin token carries (`src/admin_token.rs`). Our write lands on
  the `by_admin` branch and is unaffected by the guard.
- `synapse/rest/synapse/mas/users.py:162,178,237,389,434` — the MAS shared-secret
  API passes `by_admin=True` unconditionally, so `provision_user` and the
  displayname writes are likewise unaffected.

**Upstream status.** #19980 (author `Barry3D`, successor to the abandoned #18562 by
`anoadragon453`, both implementing issue
[#18525](https://github.com/element-hq/synapse/issues/18525)) is **OPEN but stalled**:
`CHANGES_REQUESTED` from anoadragon453 on 2026-08-13, last activity 2026-08-14, and
now `mergeable: false` / `dirty` against `develop`. The maintainer has said he may
prefer to stabilise MSC4133 *first*. We should not expect this to land soon, and we
should not open a competing PR while the author is active.

**What we took, and what we deliberately left.** Only the
`synapse/config/experimental.py` and `synapse/handlers/profile.py` hunks, taken from
PR head `d4758f2d2`. Skipped: `synapse/rest/client/capabilities.py`, the three
upstream test files, and the changelog.

- The capability advertisement is **known-broken upstream** — anoadragon453 on
  `r3777635413`: once `allowed` is specified, MSC4133 says the whole thing becomes a
  whitelist, so advertising it would make clients 403 on every *other* custom field.
  That is a spec-level defect and it is the main thing blocking the PR. Skipping it
  insulates us from however upstream resolves it.
- **Accepted consequence:** enforcement without advertisement. A client that tries
  to edit the field gets a raw `M_FORBIDDEN` rather than a greyed-out control. For a
  server-managed field users should never touch, that is acceptable.
- Every skipped line is a line we do not forward-port.

**Take it from head `d4758f2d2` only.** An earlier revision of that branch lacked the
`not by_admin and` prefix (flagged by Copilot in `r3777481806` and fixed in
`f043c26fb`, 2026-08-14). Backporting an older revision would produce a guard that
blocks *our own* admin write.

**Forward-ported to v1.161.0 (2026-09-25).** Two `handlers/profile.py` hunks stopped
applying: upstream #20135 changed the tail of `set_field` (the helper's anchor), and
#20172 inserted a user-existence lookup (`404 M_NOT_FOUND` for a user that does not
exist) directly after the ownership check where our guard sits. The guard code and
its messages are byte-identical to the PR; only the anchors moved. The policy
decision, recorded in the patch header:

- **Our 403 runs before upstream's 404.** A non-admin write of a listed field is
  refused `403 M_FORBIDDEN` whatever the store says about the target user, with no
  database read. Authorization precedes resource lookup (upstream's own ownership
  403 also precedes the 404), and the policy is a property of the field, not of the
  user's row.
- **Admins are unchanged.** `by_admin` is still exempt, so siwx-oidc's minted admin
  token and the MAS API still write `io.inblock.did`; a write for a user that does not
  exist gets upstream's 404 exactly as on stock 1.161.0.
- **The status code stays 403 for PUT and DELETE.** Upstream #20173 moved its own
  "profile changes are disabled" refusals (`enable_set_displayname` /
  `enable_set_avatar_url`) from 400 to 403 per the spec, which is the code this guard
  always used, so we are now consistent with upstream rather than divergent. Upstream's
  own ownership check in `delete_profile_field` still says 400; it precedes our guard
  and is not ours to change.

No other 1.160/1.161 change adds a custom-field write path around the guarded methods
(every caller still funnels through `set_profile_field` / `delete_profile_field`,
replication included).

**Applied cleanly to v1.159.0** (the original backport) — verified, not assumed. The PR's merge base
(`c0357de4e`) carries `handlers/profile.py` and `config/experimental.py`
**byte-identical** to tag `v1.159.0`, so all five hunks land at their exact upstream
offsets under `--fuzz=0`. It does **not** apply to 1.157.x: `handlers/profile.py` is
791 lines there versus 995 at 1.159.0, and the anchors moved substantially.

**Config we set** (`entrypoints/matrix_server.sh`, `apply_did_field_protection`):

```yaml
experimental_features:
  msc4133_key_denylist: ["io.inblock.did"]
```

Denylist, **never** allowlist. `msc4133_key_allowlist` is a hard whitelist over
*every* custom profile field on the homeserver — configuring it would forbid every
other custom field our users might ever set, which is not our call to make for them.
Note also that `[]` is not `None`: an accidentally-empty allowlist bricks all
custom-field writes. Upstream's key names are kept **verbatim** so that adopting the
merged version is a no-op for our config.

**Two limits to know about, neither fixable here:**

1. **Enforcement is prospective, not retroactive.** The guard blocks new writes; it
   does not validate or migrate a value a user set *before* the config was applied.
   Upstream has the same gap (Barry3D, `r3783167037`). We close it from the other
   side: siwx-oidc re-asserts `io.inblock.did` on **every** sign-in, so a value
   written before this shipped self-heals at the user's next login without any
   janitor process.
2. **It does not cover `displayname` or `avatar_url`**, which route through
   `set_field` → `set_displayname`/`set_avatar_url` and reach the store directly,
   never touching the guarded methods. Putting `"displayname"` in the denylist would
   have zero effect. This is *desirable* here: `displayname` is the user's alias and
   must stay user-owned. The three-tier identity model (alias / MXID / DID) is
   therefore enforced structurally, not by convention.

**Test coverage.** `patches/synapse/tests/test_msc4133_write_policy.py` (7 trial
tests, run per the bump procedure above): the real field name on the stable REST route
for PUT and DELETE, the admin exemption, a stored value surviving a user overwrite and
delete, and the 403-before-404 ordering. It fails on unpatched 1.161.0 (3 failures) and
when the guard is moved after the existence lookup (verified by mutation, 2026-09-25).
Upstream's own PR tests (`tests/rest/client/test_profile.py`,
`tests/config/test_experimental.py` from #19980) also pass against the forward-port.
End to end: `siwx-oidc/tests/e2e_did_field_live.rs` (`--ignored`, run against
the local e2e harness): a user token's PUT and DELETE of `io.inblock.did` each answer
403 `M_FORBIDDEN`, while siwx-oidc's minted admin token still writes it successfully,
and an unprotected control field remains user-writable.

### Startup enforcement (added 2026-09-13)

Writing `msc4133_key_denylist` proves nothing on its own: on an **unpatched**
Synapse it is an unknown `experimental_features` key that Synapse silently
ignores, so the DID profile field stays user-writable with no signal anywhere.
`entrypoints/matrix_server.sh` therefore gates startup on three separate facts,
and refuses to start if any fails:

1. the field name satisfies Synapse's Common Namespaced Identifier Grammar (a
   name with a colon or uppercase is unreachable for *everyone*, including
   siwx-oidc's own admin PUT, which would make the denylist inert);
2. the `yq` write succeeded **and** the value is actually on disk at startup —
   re-read as the last step before `/start.py`, after every other `apply_*`
   function has had its turn, because this script runs without `set -e`;
3. the Synapse about to run genuinely enforces the key — probed by grepping
   `msc4133_key_denylist` in **both** `config/experimental.py` and
   `handlers/profile.py`, the two independent halves of "the key is parsed" and
   "the parsed key is read on the write path". The upstream *config key names*
   are the thing this repo commits to keeping verbatim, which is why the probe
   keys on them rather than on a private helper upstream may rename.

| Variable | Default | Meaning |
|---|---|---|
| `SIWX_DID_PROFILE_FIELD` | `io.inblock.did` | The protected field name. A **three-sided wire contract** — it must match siwx-oidc's `did_assertion::DID_PROFILE_FIELD` and the `siwx-oidc-auth` verifier. Changing it on one side alone silently unprotects the live field. |
| `SIWX_ALLOW_UNPROTECTED_DID_FIELD` | unset | Set to `1` to start anyway when the patch is **absent**. Downgrades that one check to a banner printed twice — once at detection and once immediately before `/start.py`, so it is the last thing in the log rather than something that scrolled away. It does **not** downgrade checks 1 or 2: a config write that did not land, or a field name that cannot be addressed, is never an intended deployment shape. |

Covered by `scripts/did-field-guard-accept.sh` (7 cases, 30 assertions), which
falsifies each gate rather than only exercising the happy path — including a `yq`
that exits 0 while writing the wrong value, which an exit-status check cannot see.

**Why a hard default is safe here:** this entrypoint is `COPY`'d into the same
image whose build applies the patch with `--fuzz=0`, so a build that loses the
patch produces no image at all. An image carrying the guard necessarily carries
the patched Synapse. The only way to pair the two is to bind-mount the entrypoint
into a stock image, which is exactly what the acceptance script does on purpose.

**Rollback (1.161.0 to 1.159.0).** Schema-compatible: `SCHEMA_VERSION` 94 and
`SCHEMA_COMPAT_VERSION` 84 at both tags. But 1.161 queues three background updates
that 1.159 has no handler for (`device_lists_changes_in_room_unconverted_idx`,
`e2e_cross_signing_signatures_remove_duplicates`,
`e2e_cross_signing_signatures_add_key_id_to_index`). If they are still pending, 1.159
logs `Error doing update` five times and stops running background updates altogether
(the server keeps serving). Check before rolling back:
the image has no `sqlite3` CLI, so
`docker compose exec matrix_synapse python -c "import sqlite3; print(sqlite3.connect('/data/homeserver.db').execute('SELECT update_name FROM background_updates').fetchall())"`
must not list any of the three.

**Retirement condition.** #19980 (or a successor implementing issue #18525) merges
and ships in a Synapse release we have adopted, with the guard still exempting
`by_admin`. Then delete this patch; the `homeserver.yaml` denylist entry stays. If
upstream lands *different* config key names, the entrypoint's `yq` lines change with
the same commit that drops the patch.
