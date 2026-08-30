---
name: siwx-matrix-device-verify
description: E2EE device verification, cross-signing key lifecycle, key backup trust, and generation mismatch debugging for the siwx-oidc Matrix stack. Use when debugging "not verified", "verify session", "cross-signing", "device trust", "keys/upload 400", "one time key already exists", "M_UNRECOGNIZED", "VERIFY_THIS_SESSION", "backup decryption key cached but not verified", "backup not trusted", generation mismatch, stale signatures, or key backup failures.
---

# siwx-matrix-device-verify: E2EE Architecture and Troubleshooting

**Findings document:** `docs/2026-05-19-device-verification-analysis.md` contains the full
root-cause analysis with cryptographic proof, server state snapshots, and the dependency chain.
Read it first for deep context on verification failures.

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

### Device lifecycle under MSC3861/siwx-oidc (current, post-fix)

Login flow:
1. siwx-oidc checks Redis for old device_id
2. If found: delete_device on Synapse (cleanup old device + e2e keys)
3. Generate fresh SIWX_{uuid} device_id (never recycled)
4. Store new device_id in Redis (for logout cleanup)
5. upsert_device (create device in Synapse)
6. allow_cross_signing_reset (permits key upload without UIA)
7. Element uploads device keys (POST /keys/upload)
8. Element checks cross-signing state, restores from SSSS or creates new

Logout flow (both paths now do device cleanup):
- OIDC path (POST /oauth2/revoke): look up token metadata, delete_device, delete token
- Matrix path (POST /_matrix/client/v3/logout): look up token metadata, delete_device, delete token

**Critical design decision:** Device IDs are never recycled. Each login gets a fresh UUID.
This prevents stale cross-signing signatures (see Synapse limitation below).

### Synapse signature limitation (known, upstream)

`DELETE /_synapse/mas/delete_device` does NOT remove rows from `e2e_cross_signing_signatures`.
Additionally, `POST /keys/signatures/upload` SKIPS uploads when a signature already exists
for the same `(user_id, key_id, target_device_id)` tuple (`e2e_keys.py:1127-1132`).

This means: if a device_id is recycled (same ID, new keys), the old stale signature persists
and can never be replaced through normal client operations. The workaround is to never recycle
device_ids, which is why siwx-oidc generates a fresh UUID on every login.

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
- siwx-oidc calls allow_cross_signing_reset on every login (intentional, since every device is new)

## Section 2: Quick Diagnosis Flow

```
Device not verified after login?
  |
  +-- Cross-signing signature exists but INVALID over current device keys
  |     -> STALE SIGNATURE (was the #1 issue before fresh-device-id fix)
  |     -> Should not occur with current code (fresh device_ids)
  |     -> If it recurs: check if device_id is being recycled somehow
  |     -> See: STALE SIGNATURE
  |
  +-- Backup version > 1 AND "backup not trusted" in logs
  |     -> CROSS-SIGNING GENERATION MISMATCH
  |     -> Multiple resets have occurred; SSSS has old keys
  |     -> See: GENERATION MISMATCH
  |
  +-- keys/upload returns 400 "One time key already exists"
  |     -> STALE DEVICE KEYS (should not occur with fresh device_ids)
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
See `docs/2026-05-19-device-verification-analysis.md` for the full root-cause analysis
with cryptographic proof.

**Mechanism:** Synapse's `delete_device` (MAS API) removes e2e keys but not
cross-signing signatures. When the same device_id was recycled with new keys,
the old signature persisted and was cryptographically invalid over the new key material.
Synapse's signature-upload handler (`e2e_keys.py:1127`) refuses to replace existing
signatures, making the state unrecoverable.

**Prevention (current code):** siwx-oidc generates a fresh SIWX_{uuid} device_id on
every login. No device_id is ever reused, so no stale signatures can accumulate.

**If it recurs despite the fix:**
1. Verify siwx-oidc is running the fixed code (check for "cleaning up old device_id" in logs)
2. Check if something else is recycling device_ids (e.g., a cached Redis mapping)
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
# SSH to server, check cross-signing key generations
ssh root@agentic.inblock.io
# `docker compose exec` resolves the running container by service name, so it
# survives Docker renaming the container on a name-conflict restart (the
# compose-generated name matrix-matrix_synapse-1 is not stable) — stay in
# this directory for the rest of this session's docker compose commands.
cd /home/deploy/matrix/stack
cat << 'SCRIPT' | docker compose exec -T matrix_synapse python3 -
import sqlite3
from collections import Counter
db = sqlite3.connect("/data/homeserver.db")
USER = "@LOCALPART:matrix.inblock.io"  # <-- replace

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
USER = "@LOCALPART:matrix.inblock.io"  # <-- replace

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

**Should not occur with current code** (fresh device_ids mean no pre-existing keys).

If it occurs, check whether:
1. siwx-oidc is running the fixed code
2. The `delete_device` call succeeded (check logs for warnings)
3. Some other process created the device before siwx-oidc's `upsert_device`

### STALE DEVICE ACCUMULATION

**Symptom:** User has many devices in `devices` table but only 1 in `e2e_device_keys_json`.

**Diagnosis and cleanup:**

```bash
cat << 'SCRIPT' | docker compose exec -T matrix_synapse python3 -
import sqlite3
db = sqlite3.connect("/data/homeserver.db")
USER = "@LOCALPART:matrix.inblock.io"  # <-- replace

devs = db.execute("SELECT device_id FROM devices WHERE user_id = ?", (USER,)).fetchall()
e2e = db.execute("SELECT device_id FROM e2e_device_keys_json WHERE user_id = ?", (USER,)).fetchall()
active_ids = [r[0] for r in e2e]
stale = [d[0] for d in devs if d[0] not in set(active_ids)]
print(f"Total devices: {len(devs)}, Active (with e2e keys): {len(active_ids)}, Stale: {len(stale)}")

if stale and active_ids:
    placeholders = ",".join(["?"] * len(active_ids))
    r = db.execute(f"DELETE FROM devices WHERE user_id = ? AND device_id NOT IN ({placeholders})", (USER, *active_ids))
    db.commit()
    print(f"Deleted {r.rowcount} stale devices")
elif stale:
    r = db.execute("DELETE FROM devices WHERE user_id = ?", (USER,))
    db.commit()
    print(f"Deleted {r.rowcount} stale devices (no active devices)")
else:
    print("No stale devices to clean up")
SCRIPT
```

### CROSS-SIGNING UPLOAD BLOCKED

**Symptom:** `POST /keys/device_signing/upload` returns 403.

**Root cause:** `allow_cross_signing_reset` was not called, or the 10-minute permission window expired.

**Verify:**
```bash
cat << 'SCRIPT' | docker compose exec -T matrix_synapse python3 -
import sqlite3, time
db = sqlite3.connect("/data/homeserver.db")
USER = "@LOCALPART:matrix.inblock.io"  # <-- replace

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

**Fix:** User must log out and back in. The login flow calls `allow_cross_signing_reset` which refreshes the 10-minute window.

### LOGOUT PATH ANALYSIS

Element has two logout paths under MSC3861 (both now do device cleanup):

| Path | Trigger | Endpoint | Device cleanup |
|---|---|---|---|
| OIDC logout | User menu "Sign out" | `POST /oauth2/revoke` | Yes (looks up token, calls delete_device) |
| Matrix logout | Session list "Sign out" | `POST /_matrix/client/v3/logout` | Yes (looks up token, calls delete_device) |

If verification works on first login but fails after logout/re-login, check:
1. Which logout path was used (check siwx-oidc logs for `revoke` vs `logout` requests)
2. Whether `delete_device` succeeded (look for `revoke: delete_device failed` or `logout: delete_device failed` warnings)
3. Whether siwx-oidc generated a fresh device_id (look for `new device_id=SIWX_...` in logs)

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
    stale = devs - e2e

    flags = []
    if stale > 0: flags.append(f"stale_devs={stale}")
    if max_gen > 1: flags.append(f"max_gen={max_gen}")

    if flags:
        short = user_id[:55] + "..." if len(user_id) > 55 else user_id
        problems.append(f"  {short}: {', '.join(flags)}")

if problems:
    print(f"PROBLEMS FOUND ({len(problems)} users):")
    for p in problems:
        print(p)
else:
    print("ALL USERS HEALTHY")
print(f"\nTotal users checked: {len(users)}")
SCRIPT
```

Healthy state per user: 1 device, 1 e2e key set, 0 stale devices, 1 generation per keytype.

## Section 5: Prevention Checklist

After fixing a verification issue, verify:

- [ ] siwx-oidc generates a fresh device_id on every login (no recycling)
- [ ] `allow_cross_signing_reset` fires on every login
- [ ] Revoke handler calls `delete_device` before deleting the token
- [ ] Logout handler calls `delete_device` before deleting the token
- [ ] Login path deletes old device before creating new one
- [ ] Only 1 generation per keytype in `e2e_cross_signing_keys`
- [ ] Only 1 backup version active
- [ ] Device count matches e2e key count (no stale devices)
- [ ] Caddy routes `/_matrix/client/v3/logout` to siwx-oidc (not Synapse)

## Section 6: Reference

- **Full root-cause analysis:** `docs/2026-05-19-device-verification-analysis.md`
- **Code (login path):** `siwx-oidc/src/oidc.rs` lines 1084-1131
- **Code (logout handlers):** `siwx-oidc/src/compat.rs` revoke() and logout()
- **Code (device trait):** `siwx-oidc/src/db/mod.rs` DBClient trait
- **Synapse signature handler:** `synapse/handlers/e2e_keys.py:1127-1132`
- **Synapse schema:** `e2e_cross_signing_signatures` table (no unique constraint)
