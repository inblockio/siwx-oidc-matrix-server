---
name: siwx-matrix-device-verify
description: E2EE device verification, cross-signing key lifecycle, key backup trust, and generation mismatch debugging for the siwx-oidc Matrix stack. Use when debugging "not verified", "verify session", "cross-signing", "device trust", "keys/upload 400", "one time key already exists", "M_UNRECOGNIZED", "VERIFY_THIS_SESSION", "backup decryption key cached but not verified", "backup not trusted", generation mismatch, stale signatures, or key backup failures.
---

# siwx-matrix-device-verify: E2EE Architecture and Troubleshooting

## Section 1: Architecture Reference

### Cross-signing trust chain

```
Master key (self-signed)
  +-- signs Self-signing key
  |     +-- signs Device keys (makes device "verified")
  +-- signs User-signing key
        +-- signs other users' master keys
```

Element considers a device verified when:
1. Device key is signed by the self-signing key
2. Self-signing key is signed by the master key
3. Master key is trusted (via SSSS passphrase/security key)

All three signatures must be cryptographically valid over the CURRENT key material.

### Key generation lifecycle

- Cross-signing keys are user-level, NOT device-level
- Each "generation" = a complete set of master + self_signing + user_signing keys
- SSSS (Secure Secret Storage and Sharing) stores private keys encrypted with the recovery key
- The server stores public keys (queryable via `/keys/query`)
- Generations MUST match between SSSS and server for verification to work
- A mismatch between SSSS generation and server generation causes persistent verification failures

### Device lifecycle with siwx-oidc (delegated auth)

The lifecycle is implemented in siwx-oidc; its
[Matrix integration guide](https://github.com/inblockio/siwx-oidc/blob/main/docs/matrix-integration.md)
("Accounts and devices") is the reference. In short:

Sign-in (`oidc::provision_synapse_device`, both the browser flow and the device-code/QR
grant):
1. Provision the account if it is new (`provision_user`).
2. Publish the `io.inblock.did` profile field.
3. `upsert_device`: the device ID the client requested in its scope
   (`urn:matrix:client:device:<id>` or the MSC2967 unstable form), otherwise a fresh
   `SIWX_…` ID. An upsert never deletes a device and keeps an existing device's keys.
4. `allow_cross_signing_reset` (opens a window in which the client may upload new
   cross-signing keys without interactive auth).
5. Element uploads device keys (POST /keys/upload), then checks cross-signing state and
   restores from SSSS or creates new keys.

Teardown (the policy keys on intent, not on the endpoint's transport):
- `POST /oauth2/revoke` (RFC 7009): revokes the session's tokens and **never** deletes the
  device. Clients call it on token rotation and when dialogs close; deleting the device
  there raced key uploads and broke users' cross-signing identity in a June 2026 incident.
- `POST /_matrix/client/v3/logout`: revokes the tokens and deletes this session's device.
- `POST /_matrix/client/v3/logout/all`: deletes every device of the user and revokes all
  tokens; it does not deactivate the account.
- MSC4191 `device_delete` on `/account`: deletes the named device and revokes its tokens.

**Critical design decision:** sign-in never deletes a device, and never deletes and then
reuses a device ID. This prevents stale cross-signing signatures (see Synapse limitation
below). Deleting a device that is ending (logout) is safe because siwx-oidc does not use
its ID again; a client that later requests the same ID in its scope gets it re-created
(see STALE DEVICE KEYS).

### Synapse signature limitation (known, upstream)

`POST /_synapse/mas/delete_device` does NOT remove rows from `e2e_cross_signing_signatures`
(device deletion clears the device's own keys only). Additionally,
`POST /keys/signatures/upload` SKIPS a device signature when the stored device already
carries a signature from the same self-signing key (`synapse/handlers/e2e_keys.py:1226-1231`
at v1.161.0; lines 1127-1132 in earlier releases).

Synapse 1.161 ([#19915](https://github.com/element-hq/synapse/pull/19915)) added a unique
index on `(user_id, target_user_id, target_device_id, key_id)` to
`e2e_cross_signing_signatures` (built by background updates) and made the store upsert.
That lets a new signature of a user's **master key** replace an old one; a **device**
signature still stops at the handler's skip above.

This means: if a device_id is recycled (same ID, new keys), the old stale signature persists
and can never be replaced through normal client operations. The workaround is to never recycle
device_ids, which is why siwx-oidc never deletes and then re-creates a device at sign-in.

### Key backup trust model

- Backup is "trusted" when EITHER:
  a. auth_data.signatures verified by current master key, OR
  b. local decryption key matches backup's public_key
- Untrusted backup = no uploads, no downloads
- Each cross-signing reset potentially invalidates backup trust
- Backup version number increments with each reset (version > 1 signals prior resets)

### The UIA safeguard (and how MSC3861 bypasses it)

- Standard Matrix: cross-signing reset requires password re-entry (UIA)
- MSC3861: no password exists; uses allow_cross_signing_reset (10-min window)
- siwx-oidc calls allow_cross_signing_reset on every sign-in, so a client halfway through
  a key reset can publish replacement keys

## Section 2: Quick Diagnosis Flow

```
Device not verified after login?
  |
  +-- Cross-signing signature exists but INVALID over current device keys
  |     -> STALE SIGNATURE (was the #1 issue before fresh-device-id fix)
  |     -> Should not occur with current code (no device_id is re-created)
  |     -> If it recurs: check if device_id is being recycled somehow
  |     -> See: STALE SIGNATURE
  |
  +-- Backup version > 1 AND "backup not trusted" in logs
  |     -> CROSS-SIGNING GENERATION MISMATCH
  |     -> Multiple resets have occurred; SSSS has old keys
  |     -> See: GENERATION MISMATCH
  |
  +-- keys/upload returns 400 "One time key already exists"
  |     -> STALE DEVICE KEYS (should not occur: sign-in never re-creates a device)
  |
  +-- "Backup decryption key cached" but still VERIFY_THIS_SESSION
  |     -> CROSS-SIGNING MISMATCH (single generation drift)
  |
  +-- keys/device_signing/upload returns 403
  |     -> CROSS-SIGNING UPLOAD BLOCKED
  |
  +-- M_UNRECOGNIZED on dehydrated_device
  |     -> Harmless (MSC3814 not enabled)
  |     -> Look for other errors in the same session
  |
  +-- No signature at all on the device
        -> Element's bootstrapCrossSigning failed or was skipped
        -> Check if allow_cross_signing_reset window expired
        -> See: CROSS-SIGNING UPLOAD BLOCKED
```

## Section 3: Problem Patterns

### STALE SIGNATURE (historically #1 cause, now prevented)

**Context:** This was the primary verification failure mode before the 2026-05-19 fix.

**Mechanism:** Synapse's `delete_device` (MAS API) removes e2e keys but not
cross-signing signatures. When the same device_id was recycled with new keys,
the old signature persisted and was cryptographically invalid over the new key material.
Synapse's signature-upload handler skips a device signature when one from the same
self-signing key is already stored (`e2e_keys.py:1226-1231` at v1.161.0), so the new
signature is never written and the state cannot be repaired by the client.

**Prevention (current code):** siwx-oidc never deletes a device at sign-in, and never
deletes and then re-creates a device ID, so sign-in cannot leave a stale signature.

**If it recurs despite the fix:**
1. Check which siwx-oidc image runs (`docker compose images siwx-oidc`) and that it is
   a current build
2. Check whether something else deletes and re-creates devices with the same ID (a
   script, an admin tool, a client that reuses a device ID after logout)
3. Use the nuclear reset below to clear the state

### GENERATION MISMATCH

**Symptoms:**
- Device not verified even after entering recovery key
- Backup version > 1 (each reset increments)
- "backup not trusted" in logs
- "Not saving backup key to secret storage: no backup key"
- Some messages decrypt, others don't (partial recovery from matching generations)

**Root cause chain:**
1. allow_cross_signing_reset fires every login
2. Fresh session can't access SSSS without recovery key
3. Element bootstrap creates new cross-signing keys (gen N+1) during 10-min window
4. SSSS retains generation N
5. Recovery key imports gen N; server has gen N+1
6. Mismatch: device unverified

**Diagnosis:**

```bash
# On the host, check cross-signing key generations.
# `docker compose exec` resolves the running container by service name, so it
# survives Docker renaming the container on a name-conflict restart (the
# compose-generated name matrix-matrix_synapse-1 is not stable) — stay in
# this directory for the rest of this session's docker compose commands.
cd <stack-dir>   # the directory holding docker-compose.yml and .env
cat << 'SCRIPT' | docker compose exec -T matrix_synapse python3 -
import sqlite3
from collections import Counter
db = sqlite3.connect("/data/homeserver.db")
USER = "@LOCALPART:matrix.example.org"  # <-- replace

keys = db.execute("SELECT keytype, stream_id FROM e2e_cross_signing_keys WHERE user_id = ? ORDER BY stream_id", (USER,)).fetchall()
gen_counts = Counter(k[0] for k in keys)
print(f"Cross-signing keys: {keys}")
for keytype, count in gen_counts.items():
    if count > 1:
        print(f"PROBLEM: {count} generations of {keytype} key")
    else:
        print(f"OK: 1 generation of {keytype}")

# Check backup versions
versions = db.execute("SELECT version, algorithm FROM e2e_room_keys_versions WHERE user_id = ? ORDER BY version", (USER,)).fetchall()
print(f"Backup versions: {versions}")
if len(versions) > 1:
    print(f"PROBLEM: {len(versions)} backup versions (expected 1)")
SCRIPT
```

**Fix (nuclear reset):**

```bash
cat << 'SCRIPT' | docker compose exec -T matrix_synapse python3 -
import sqlite3
db = sqlite3.connect("/data/homeserver.db")
USER = "@LOCALPART:matrix.example.org"  # <-- replace

r1 = db.execute("DELETE FROM e2e_cross_signing_signatures WHERE user_id = ?", (USER,))
r2 = db.execute("DELETE FROM e2e_cross_signing_keys WHERE user_id = ?", (USER,))
print(f"Deleted {r1.rowcount} sigs, {r2.rowcount} cross-signing keys")
db.commit()
SCRIPT
docker compose restart matrix_synapse
```

After reset: user must log out, clear browser data, log back in, and choose "Set up encryption" (NOT "Enter recovery key"). This creates a fresh generation 1 with a new recovery key.

### STALE DEVICE KEYS

**Symptom:** `POST /keys/upload` returns 400 with "One time key already exists"

**Should not occur with current code**: sign-in never deletes and re-creates a device,
so a device ID never gets new keys on top of old ones.

If it occurs, check whether:
1. siwx-oidc is running a current image
2. The client reused a device ID it had logged out with (logout deletes the device, and
   a later sign-in with the same requested ID creates it anew)
3. Some other process created the device before siwx-oidc's `upsert_device`

### MANY DEVICES

Several devices per user are normal: every signed-in client, browser profile and agent
has its own, and sign-in never deletes one. A device with no uploaded keys is not
necessarily stale either (a client still setting up, or one without E2EE). Remove a
device only when it is known to be unused, and only through a supported path, never by
editing `homeserver.db`: Synapse caches device and key state, and a row deleted under a
running server leaves those caches and the device-list stream out of step.

- **The user:** the account page on siwx-oidc,
  `https://siwx-oidc.example.org/account?action=org.matrix.devices_list`, then
  `org.matrix.device_delete` for the device (MSC4191). siwx-oidc deletes the Synapse
  device and revokes that device's tokens.
- **A server admin:** Synapse's admin API with a minted admin token (Synapse 1.157+ takes
  no other admin credential). The admin API is not exposed at the edge, so run it inside
  the Synapse container; the token never leaves it:

  ```bash
  cd <stack-dir>   # the directory holding docker-compose.yml and .env
  docker compose exec -T -e MXID='@LOCALPART:matrix.example.org' matrix_synapse sh -c '
    tok=$(curl -fsS -X POST -H "Authorization: Bearer $MAS_SHARED_SECRET" \
            "http://siwx-oidc:${SIWEOIDC_PORT:-8081}/oauth2/admin_token" \
          | python3 -c "import json, sys; print(json.load(sys.stdin)[\"access_token\"])")
    curl -fsS -H "Authorization: Bearer $tok" \
      "http://localhost:${MATRIX_PORT:-8080}/_synapse/admin/v2/users/$MXID/devices"'
  ```

  Delete one with `DELETE /_synapse/admin/v2/users/<mxid>/devices/<device_id>` (or
  several with `POST /_synapse/admin/v2/users/<mxid>/delete_devices`) the same way. That
  path does not revoke the device's tokens in siwx-oidc; Synapse refuses them anyway,
  because it rejects a token whose device no longer exists.

### CROSS-SIGNING UPLOAD BLOCKED

**Symptom:** `POST /keys/device_signing/upload` returns 403.

**Root cause:** `allow_cross_signing_reset` was not called, or the 10-minute permission window expired.

**Verify:**
```bash
cat << 'SCRIPT' | docker compose exec -T matrix_synapse python3 -
import sqlite3, time
db = sqlite3.connect("/data/homeserver.db")
USER = "@LOCALPART:matrix.example.org"  # <-- replace

row = db.execute("SELECT updatable_without_uia_before_ms FROM e2e_cross_signing_keys WHERE user_id = ? AND keytype = 'master' ORDER BY stream_id DESC LIMIT 1", (USER,)).fetchone()
if row and row[0]:
    expires = row[0] / 1000
    now = time.time()
    if expires > now:
        print(f"Cross-signing reset allowed for {int(expires - now)}s more")
    else:
        print(f"Cross-signing reset EXPIRED {int(now - expires)}s ago")
else:
    print("No cross-signing keys or no UIA bypass set")
SCRIPT
```

**Fix:** User must sign in again (the sign-in calls `allow_cross_signing_reset`, which
refreshes the 10-minute window), or re-authenticate at
`/account?action=org.matrix.cross_signing_reset` on siwx-oidc.

### LOGOUT PATH ANALYSIS

Every path that ends a session revokes its tokens. Which ones also delete a Synapse
device (siwx-oidc's
[Matrix integration guide](https://github.com/inblockio/siwx-oidc/blob/main/docs/matrix-integration.md),
"Session teardown" and "Account management"):

| Path | Typical trigger | Endpoint | Device deleted? |
|---|---|---|---|
| OAuth token revocation | token rotation, closing a dialog, some sign-out flows | `POST /oauth2/revoke` | **No**, tokens only |
| Matrix logout | "Sign out" of a session | `POST /_matrix/client/v3/logout` | Yes, this session's device |
| Matrix logout of all sessions | "Sign out of all sessions" | `POST /_matrix/client/v3/logout/all` | Yes, every device of the user |
| Session manager, legacy routes | removing sessions in the client's session list | `DELETE /_matrix/client/v3/devices/{id}`, `POST /_matrix/client/v3/delete_devices` | Yes, the named devices of the caller's own account |
| Account page (MSC4191) | `org.matrix.device_delete` / `org.matrix.session_end` | `/account` on siwx-oidc | Yes, the named device |
| Account deactivation or erasure | `org.matrix.account_deactivate` / `org.matrix.account_erase` | `/account` on siwx-oidc | Yes: Synapse deletes every device when it deactivates the account |

If verification works on first login but fails after logout/re-login, check:
1. Which path was used (siwx-oidc's request log names the path)
2. Whether the proxy routes `/_matrix/client/v3/logout` to siwx-oidc (not Synapse)
3. Which device ID the new sign-in used (the client's requested ID, or a new `SIWX_…`)

## Section 4: Server-Wide Health Check

Run this to audit all users at once:

```bash
cat << 'SCRIPT' | docker compose exec -T matrix_synapse python3 -
import sqlite3
from collections import Counter

db = sqlite3.connect("/data/homeserver.db")
users = db.execute("SELECT DISTINCT user_id FROM devices").fetchall()

problems = []
for (user_id,) in users:
    devs = db.execute("SELECT COUNT(*) FROM devices WHERE user_id = ?", (user_id,)).fetchone()[0]
    e2e = db.execute("SELECT COUNT(*) FROM e2e_device_keys_json WHERE user_id = ?", (user_id,)).fetchone()[0]
    gens = db.execute("SELECT keytype, COUNT(*) FROM e2e_cross_signing_keys WHERE user_id = ? GROUP BY keytype", (user_id,)).fetchall()
    sigs = db.execute("SELECT COUNT(*) FROM e2e_cross_signing_signatures WHERE user_id = ?", (user_id,)).fetchone()[0]
    max_gen = max((c for _, c in gens), default=0)
    without_keys = devs - e2e

    flags = []
    if without_keys > 0: flags.append(f"devices_without_keys={without_keys}")
    if max_gen > 1: flags.append(f"max_gen={max_gen}")

    if flags:
        short = user_id[:55] + "..." if len(user_id) > 55 else user_id
        problems.append(f"  {short}: {', '.join(flags)}")

if problems:
    print(f"TO REVIEW ({len(problems)} users):")
    for p in problems:
        print(p)
else:
    print("NOTHING TO REVIEW")
print(f"\nTotal users checked: {len(users)}")
SCRIPT
```

The script only reads. More than one generation of a cross-signing key type points to a
GENERATION MISMATCH (above). `devices_without_keys` is for review, not a fault: several
devices per user are normal, and a device without keys may still be setting up. Remove
one only through a supported path (MANY DEVICES, above).

## Section 5: Prevention Checklist

After fixing a verification issue, verify:

- [ ] Sign-in never deletes a device, and never deletes and then reuses a device ID
- [ ] `allow_cross_signing_reset` fires on every sign-in
- [ ] `/oauth2/revoke` revokes tokens only and does **not** delete the device
- [ ] `/_matrix/client/v3/logout` deletes the ending session's device
- [ ] Only 1 generation per keytype in `e2e_cross_signing_keys`
- [ ] Only 1 backup version active
- [ ] Caddy routes `/_matrix/client/v3/logout` to siwx-oidc (not Synapse)

## Section 6: Reference

- **Code (sign-in path):** siwx-oidc `src/oidc.rs`, `provision_synapse_device`
- **Code (teardown):** siwx-oidc `src/compat.rs`, `revoke()`, `logout()`, `logout_all()`
  and `TeardownPolicy`
- **Behaviour reference:** siwx-oidc `docs/matrix-integration.md` ("Accounts and devices")
- **Synapse signature handler:** `synapse/handlers/e2e_keys.py:1226-1231` (v1.161.0)
- **Synapse schema:** `e2e_cross_signing_signatures` table; since 1.161
  ([#19915](https://github.com/element-hq/synapse/pull/19915)) a unique index on
  `(user_id, target_user_id, target_device_id, key_id)`, built by background updates, and
  upserts in `store_e2e_cross_signing_signatures`
