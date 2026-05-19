---
name: siwx-matrix-device-verify
description: Use when debugging E2EE device verification failures in the Matrix stack. Triggers on "not verified", "verify session", "cross-signing", "device trust", "keys/upload 400", "one time key already exists", "M_UNRECOGNIZED", "VERIFY_THIS_SESSION", "backup decryption key cached but not verified".
---

# siwx-matrix-device-verify: E2EE Device Verification Debugging

## Quick diagnosis flow

```
Device not verified after login?
  |
  +-- keys/upload returns 400 "One time key already exists"
  |     -> Stale device: same device_id reused with new crypto keys
  |     -> Root cause: logout didn't clean up device from Synapse
  |     -> See: STALE DEVICE KEYS
  |
  +-- "Backup decryption key cached" but still VERIFY_THIS_SESSION
  |     -> Cross-signing state is broken
  |     -> Either: SSSS keys don't match Synapse, or signature is
  |        over old device key material
  |     -> See: CROSS-SIGNING MISMATCH
  |
  +-- keys/device_signing/upload returns 403
  |     -> allow_cross_signing_reset not called or expired
  |     -> See: CROSS-SIGNING UPLOAD BLOCKED
  |
  +-- M_UNRECOGNIZED on dehydrated_device
  |     -> Harmless. MSC3814 not enabled. Not the real problem.
  |     -> Look for other errors in the same session.
  |
  +-- Verification works on first login, fails after logout/re-login
        -> Device cleanup not firing on logout path
        -> See: LOGOUT PATH ANALYSIS
```

## Architecture context

### Device lifecycle under MSC3861/siwx-oidc

```
Login:
  1. siwx-oidc resolves device_id (Redis lookup -> deterministic SHA-256 fallback)
  2. delete_device (purge stale keys)  <- added to fix re-login verification
  3. upsert_device (create fresh device in Synapse)
  4. allow_cross_signing_reset (permit key upload without UIA)
  5. Element uploads device keys (POST /keys/upload)
  6. Element sets up cross-signing or restores from SSSS

Logout (two paths):
  OIDC path (Element calls POST /oauth2/revoke):
    - revoke handler: delete_device + delete_device_id + delete token
  Matrix path (siwx-gate.js intercepts DELETE /devices/{id}):
    - logout handler: delete_device + delete_device_id + delete token
```

### Cross-signing trust chain

```
Master key (self-signed)
  |
  +-- signs Self-signing key
  |     |
  |     +-- signs Device keys (makes device "verified")
  |
  +-- signs User-signing key
        |
        +-- signs other users' master keys (cross-user trust)
```

Element considers a device verified when:
1. Device key is signed by the self-signing key
2. Self-signing key is signed by the master key
3. Master key is trusted (via SSSS passphrase/security key)

All three signatures must be cryptographically valid over the CURRENT key material.

## Diagnostic commands

### 1. Check device state

```bash
# SSH into the server first
ssh -i ~/.ssh/id_ed25519 root@agentic.inblock.io

# Run inside the Synapse container
cd /home/matrix
cat << 'SCRIPT' | docker compose exec -T matrix_synapse python3 -
import sqlite3
db = sqlite3.connect("/data/homeserver.db")
USER = "@LOCALPART:matrix.inblock.io"  # <-- replace

devs = db.execute("SELECT device_id FROM devices WHERE user_id = ?", (USER,)).fetchall()
e2e = db.execute("SELECT device_id FROM e2e_device_keys_json WHERE user_id = ?", (USER,)).fetchall()
e2e_set = {r[0] for r in e2e}
stale = [r[0] for r in devs if r[0] not in e2e_set]
print(f"Total devices: {len(devs)}")
print(f"With e2e keys: {e2e_set}")
print(f"Stale (no e2e keys): {stale}")
SCRIPT
```

**Healthy state:** 1 device, 1 e2e key set, 0 stale.
**Problem indicator:** Multiple devices, especially with stale entries.

### 2. Check cross-signing state

```bash
cat << 'SCRIPT' | docker compose exec -T matrix_synapse python3 -
import sqlite3, json
db = sqlite3.connect("/data/homeserver.db")
USER = "@LOCALPART:matrix.inblock.io"  # <-- replace

keys = db.execute("SELECT keytype, stream_id FROM e2e_cross_signing_keys WHERE user_id = ? ORDER BY stream_id", (USER,)).fetchall()
sigs = db.execute("SELECT key_id, target_device_id FROM e2e_cross_signing_signatures WHERE user_id = ?", (USER,)).fetchall()
print(f"Cross-signing keys: {keys}")
print(f"Cross-signing sigs: {sigs}")

# Check if multiple generations exist (problem indicator)
from collections import Counter
gen_counts = Counter(k[0] for k in keys)
for keytype, count in gen_counts.items():
    if count > 1:
        print(f"WARNING: {count} generations of {keytype} key (should be 1)")
SCRIPT
```

**Healthy state:** Exactly 1 master, 1 self_signing, 1 user_signing key. Signature(s) referencing the current device_id.
**Problem indicator:** Multiple generations per keytype, or signatures referencing device IDs that no longer exist.

### 3. Validate cross-signing chain

```bash
cat << 'SCRIPT' | docker compose exec -T matrix_synapse python3 -
import sqlite3, json
db = sqlite3.connect("/data/homeserver.db")
USER = "@LOCALPART:matrix.inblock.io"  # <-- replace
DEVICE = "SIWX_xxxxxxxx"              # <-- replace

# Get current self-signing key ID
ss = db.execute("SELECT keydata FROM e2e_cross_signing_keys WHERE user_id = ? AND keytype = 'self_signing' ORDER BY stream_id DESC LIMIT 1", (USER,)).fetchone()
if ss:
    ss_keys = list(json.loads(ss[0]).get("keys", {}).keys())
    print(f"Current self-signing key: {ss_keys}")
else:
    print("NO SELF-SIGNING KEY - user needs fresh cross-signing setup")

# Check signature on device
sig = db.execute("SELECT key_id FROM e2e_cross_signing_signatures WHERE user_id = ? AND target_device_id = ?", (USER, DEVICE)).fetchone()
if sig:
    print(f"Device signed by: {sig[0]}")
    if ss and sig[0] in ss_keys:
        print("KEY MATCH: signature references current self-signing key")
        print("NOTE: signature may still be invalid if device keys were regenerated")
    else:
        print("KEY MISMATCH: signature is from an old self-signing key generation")
else:
    print("NO SIGNATURE on device - needs signing")
SCRIPT
```

### 4. Check MAS config variant

```bash
docker compose exec -T matrix_synapse python3 -c "
import subprocess, json
# Check which config style is in use
exp = subprocess.check_output(['yq', '-r', '.experimental_features.msc3861.enabled', '/data/homeserver.yaml']).decode().strip()
stable = subprocess.check_output(['yq', '-r', '.matrix_authentication_service.enabled', '/data/homeserver.yaml']).decode().strip()
print(f'experimental_features.msc3861: {exp}')
print(f'matrix_authentication_service: {stable}')
if exp == 'true':
    token = subprocess.check_output(['yq', '-r', '.experimental_features.msc3861.admin_token', '/data/homeserver.yaml']).decode().strip()
    print(f'Admin token (for MAS API): {token[:8]}...')
"
```

This matters because the MAS admin API auth uses different fields depending on the config variant.

## Problem: STALE DEVICE KEYS

**Symptom:** `POST /keys/upload` returns 400 with "One time key already exists. Old key: ... new key: ..."

**Root cause:** The device_id was reused across login sessions but Synapse still holds old crypto keys for that device. Element generates new keys on login, causing a conflict.

**Why it happens:** Element's OIDC logout calls `POST /oauth2/revoke`, not `POST /_matrix/client/v3/logout`. If the revoke handler doesn't perform device cleanup, the device persists in Synapse with stale keys.

**Verify:**
- Both old and new keys in the error are signed by the same device (e.g., `ed25519:SIWX_f4a62d0f`)
- The key material (base64 values) differs between old and new

**Fix (code):** The revoke handler (`siwx-oidc/src/compat.rs`) must call `delete_device` + `delete_device_id` before deleting the token. The login path (`siwx-oidc/src/oidc.rs`) should also defensively call `delete_device` before `upsert_device`.

**Fix (immediate):** User logs out and back in. The login-time `delete_device` purges stale keys.

## Problem: CROSS-SIGNING MISMATCH

**Symptom:** "Backup decryption key cached" in logs, but DeviceListener keeps reporting `VERIFY_THIS_SESSION`. No `keys/signatures/upload` or `keys/device_signing/upload` requests in Synapse logs.

**Root cause (variant A): Multiple cross-signing key generations.** Each logout/re-login cycle may have reset cross-signing keys (because `allow_cross_signing_reset` is called every login). SSSS contains keys from one generation; Synapse has a different (newer) generation. Element detects the mismatch and silently gives up.

**Root cause (variant B): Signature over old device key material.** The device was deleted and recreated (new identity keys), but the cross-signing signature was computed over the OLD key material. The signature references the correct device_id and signing key, but is cryptographically invalid over the new keys.

**Verify variant A:**
- Multiple `master` key entries in `e2e_cross_signing_keys` for the same user
- Count should be exactly 1 per keytype

**Verify variant B:**
- `e2e_cross_signing_signatures` has a signature for the device
- The `key_id` matches the current self-signing key
- But the device keys were regenerated since the signature was created

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

# Restart Synapse to flush caches
docker compose restart matrix_synapse
```

After reset: user must log out, log back in, and go through "Set up Secure Backup" in Element. This creates fresh cross-signing keys synchronized between SSSS and Synapse.

## Problem: STALE DEVICE ACCUMULATION

**Symptom:** User has many devices in `devices` table but only 1 in `e2e_device_keys_json`. Caused by repeated logins without proper logout cleanup.

**Fix (cleanup via sync_devices API):**

```bash
cat << 'SCRIPT' | docker compose exec -T matrix_synapse python3 -
import urllib.request, json, subprocess, sqlite3

db = sqlite3.connect("/data/homeserver.db")
USER = "@LOCALPART:matrix.inblock.io"  # <-- replace
LOCALPART = "LOCALPART"                # <-- replace (without @ and :server)

# Find the MAS admin token
token = subprocess.check_output(["yq", "-r", ".experimental_features.msc3861.admin_token", "/data/homeserver.yaml"]).decode().strip()

# Get active device IDs (those with e2e keys)
active = [r[0] for r in db.execute("SELECT device_id FROM e2e_device_keys_json WHERE user_id = ?", (USER,)).fetchall()]
print(f"Keeping devices: {active}")

# If sync_devices API works, use it
url = "http://localhost:8080/_synapse/mas/sync_devices"
data = json.dumps({"localpart": LOCALPART, "devices": active}).encode()
req = urllib.request.Request(url, data=data, headers={
    "Content-Type": "application/json",
    "Authorization": f"Bearer {token}"
})
try:
    resp = urllib.request.urlopen(req)
    print(f"sync_devices: {resp.status}")
except Exception as e:
    print(f"sync_devices failed: {e}")
    print("Falling back to direct DB cleanup...")
    placeholders = ",".join(["?"] * len(active))
    r = db.execute(f"DELETE FROM devices WHERE user_id = ? AND device_id NOT IN ({placeholders})", (USER, *active))
    db.commit()
    print(f"Deleted {r.rowcount} stale devices from DB")
SCRIPT
```

**Note:** The MAS `sync_devices` and `delete_device` APIs may silently no-op for devices that were created before MSC3861 was enabled. In that case, direct SQLite cleanup is the fallback. Always restart Synapse after direct DB edits to flush caches.

## Problem: CROSS-SIGNING UPLOAD BLOCKED

**Symptom:** `POST /keys/device_signing/upload` returns 403.

**Root cause:** `allow_cross_signing_reset` was not called, or the permission window expired.

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

**Fix:** The `allow_cross_signing_reset` call in `siwx-oidc/src/oidc.rs` runs at login time. If it expired, user must log out and back in to refresh it.

## Problem: LOGOUT PATH ANALYSIS

**Key insight:** Element has two logout paths under MSC3861:

| Path | Trigger | Endpoint | Device cleanup? |
|---|---|---|---|
| OIDC logout | User menu "Sign out" | `POST /oauth2/revoke` | Yes (after fix) |
| siwx-gate intercept | "Sign out" in session list | `POST /_matrix/client/v3/logout` | Yes (always had it) |

If verification works on first login but fails after logout/re-login, check:
1. Which logout path was used (check siwx-oidc logs for `revoke` vs `logout` requests)
2. Whether `delete_device` succeeded (look for `revoke: delete_device failed` or `logout: delete_device failed` warnings)
3. Whether `delete_device_id` succeeded (Redis mapping must be cleared so next login doesn't reuse stale device_id)

## Prevention checklist

After fixing a verification issue, verify these are all true:

- [ ] `revoke` handler in `compat.rs` calls `delete_device` + `delete_device_id` before deleting the token
- [ ] Login path in `oidc.rs` calls `delete_device` before `upsert_device` (belt-and-suspenders)
- [ ] Login path calls `allow_cross_signing_reset` so Element can upload fresh keys
- [ ] Only 1 device per user in Synapse after login (no stale accumulation)
- [ ] Only 1 generation per keytype in `e2e_cross_signing_keys`
- [ ] Caddy routes `/_matrix/client/v3/logout` to siwx-oidc (not Synapse)
