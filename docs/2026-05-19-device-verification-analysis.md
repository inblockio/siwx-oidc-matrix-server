# Device Verification Failure Analysis

**Date:** 2026-05-19
**System:** siwx-oidc-matrix-server (MSC3861 delegated auth)
**Server:** agentic.inblock.io
**Status:** Root cause confirmed, fix deployed

## Executive Summary

Device verification failed on re-login (logout + login with same Ethereum wallet). First login worked correctly. Recovery key restored message decryption but did NOT restore device verification.

**Root cause:** Stale cross-signing signatures persist in Synapse's `e2e_cross_signing_signatures` table after `delete_device` via the MAS API. When a device_id was recycled (same ID, new keys), the old signature over the previous key material remained, and Synapse's signature-upload handler actively refused to replace it.

**Fix applied:** siwx-oidc now generates a fresh device_id (UUID) on every login instead of recycling. Each device_id is used exactly once, so no stale signatures can accumulate. Both logout handlers (`revoke` and `logout`) now call `delete_device` on Synapse for cleanup.

## Root Cause (Cryptographically Confirmed)

### The Mechanism (pre-fix)

1. User logs in; siwx-oidc calls `delete_device` via Synapse MAS API, then `upsert_device` to create a fresh device
2. `delete_device` removes the device from `devices` table and e2e keys from `e2e_device_keys_json`
3. `delete_device` does NOT remove cross-signing signatures from `e2e_cross_signing_signatures`
4. After device recreation, Element uploads new ed25519 identity keys
5. The old cross-signing signature (computed over previous session's key material) persists in the database
6. Element receives this stale signature via `GET /keys/query`
7. Element verifies the signature cryptographically against the new device keys; verification FAILS
8. Device remains unverified

### Why Recovery Key Could Not Fix It

When the user enters their recovery key, Element decrypts SSSS, recovers cross-signing private keys, and calls `bootstrapCrossSigning`. This attempts to upload a fresh valid signature via `POST /keys/signatures/upload`. However, Synapse's handler (`synapse/handlers/e2e_keys.py:1127-1132`) contains:

```python
if self_signing_key_id in stored_device.get("signatures", {}).get(user_id, {}):
    # we already have a signature on this device, so we
    # can skip it, since it should be exactly the same
    continue
```

Synapse sees the stale signature already exists for this `(user_id, key_id, target_device_id)` tuple and skips the upload entirely. The comment "it should be exactly the same" is false when device keys changed after delete+recreate while the signature persisted.

This creates an unrecoverable state: the stale signature can never be overwritten through normal Matrix client operations.

### Cryptographic Proof

PyNaCl ed25519 signature verification on the live server confirmed:

- Self-signing key `ed25519:5cZUIg7pqkc/wn9J5XT8vuv/6gI0BT7Bz60HnlVByHA` signed device `SIWX_b42e5cba`
- The `key_id` matches the current self-signing key (MATCH)
- The signature bytes are cryptographically INVALID over the current device key material
- Conclusion: the signature was computed over a previous incarnation of the device's keys

### Database Schema Detail

The `e2e_cross_signing_signatures` table has NO unique constraint:

| Column | Type |
|--------|------|
| user_id | TEXT NOT NULL |
| key_id | TEXT NOT NULL |
| target_user_id | TEXT NOT NULL |
| target_device_id | TEXT NOT NULL |
| signature | TEXT NOT NULL |

Only a non-unique index on `(user_id, target_user_id, target_device_id)`. Deduplication is purely at the application layer, which assumes signatures never need to change for the same device.

## Contributing Factors

### 1. Device ID Recycling (now removed)

The previous code reused device_ids across login sessions. When a user had an existing device_id in Redis, siwx-oidc would delete+recreate the device in Synapse with the same ID. This triggered the stale signature problem because:
- `delete_device` cleared e2e keys but not cross-signing signatures
- `upsert_device` recreated the device, Element uploaded new keys
- The old signature (for the same device_id) persisted and was cryptographically invalid

### 2. `is_new_device` Bug (now removed)

Both branches of the device ID resolution set `is_new_device = true`, causing `allow_cross_signing_reset` to fire on EVERY login. This removed the UIA protection against accidental cross-signing key resets, leading to generation accumulation.

### 3. Revoke Handler Missing Device Cleanup (now fixed)

The OIDC revoke handler previously only deleted the token from Redis, not the device from Synapse. This left orphaned devices in Synapse between logout and next login.

### 4. Cross-Signing Generation Accumulation

Server-wide analysis revealed:
- 11 of 17 users with cross-signing state had multiple key generations
- Some agent users had up to 31 generations and 93 stale devices
- Every user had at least some stale devices

## Fix Applied (2026-05-19)

### Code Changes (siwx-oidc)

| File | Change |
|------|--------|
| `oidc.rs` | Always generate fresh UUID-based device_id. Old device (if any) is deleted first. `allow_cross_signing_reset` fires unconditionally since every device is genuinely new. |
| `compat.rs` | Both `revoke` and `logout` handlers now look up token metadata and call `delete_device` on Synapse before deleting the token. |
| `db/mod.rs` | Added `delete_device_id` to DBClient trait. |
| `db/redis.rs` | Implemented `delete_device_id`. |

### New Device Lifecycle

```
Login:
  1. Check Redis for old device_id for this DID
  2. If found: delete_device on Synapse (cleanup)
  3. Generate fresh SIWX_{uuid} device_id
  4. Store new device_id in Redis (for logout cleanup)
  5. upsert_device (create in Synapse)
  6. allow_cross_signing_reset (permit key upload)
  7. Element uploads fresh e2e keys + signs device

Logout (revoke or /logout):
  1. Look up token metadata (device_id, username)
  2. delete_device on Synapse
  3. Delete token from Redis
```

Each device_id is used exactly once, so no stale signatures can accumulate. The Redis mapping (`device_ids/{did}`) is kept only for cleanup purposes (knowing which device to delete on logout or next login).

### Server-Wide Cleanup

Executed on the live server:
- 118 stale cross-signing signatures deleted
- 339 accumulated cross-signing key generations deleted
- 363 orphaned devices deleted
- Synapse restarted to flush caches

All users need to log out, clear browser data, and log back in to establish fresh cross-signing state with the new code.

## Synapse Limitation (Known, Upstream)

`DELETE /_synapse/mas/delete_device` does not remove rows from `e2e_cross_signing_signatures`. This is arguably correct for normal Matrix deployments (devices are not deleted and recreated with the same ID), but breaks under MSC3861 device recycling patterns.

Synapse's `POST /keys/signatures/upload` handler skips signature uploads when any signature already exists for the same `(user_id, key_id, target_device_id)` tuple. Combined with the incomplete cleanup from `delete_device`, this creates an unrecoverable state that can only be resolved by direct database intervention.

**Workaround:** Never recycle device_ids. Generate a new UUID on every login so there is never a pre-existing signature for the new device.

## Confidence Levels

| Claim | Confidence | Evidence |
|-------|------------|----------|
| Stale signature is the proximate cause | 99% | Cryptographic proof via PyNaCl |
| delete_device doesn't clean signatures | 99% | DB inspection confirms signature persists |
| Synapse skips new signature upload when stale one exists | 99% | Source code reading of e2e_keys.py handler |
| Recovery key can never fix the stale state | 99% | Synapse skip logic + no REPLACE/UPSERT in schema |
| Fresh device_id on each login prevents recurrence | 95% | No pre-existing signature for new device_id |

## Dependency Chain

```
delete_device doesn't clean signatures (Synapse limitation)
  + device_id recycling reuses the same ID with new keys (old siwx-oidc behavior)
  = stale signature persists (root cause)
  + Synapse skips duplicate signature uploads (handler logic)
  = recovery key can't fix it (unrecoverable without DB intervention)
  + is_new_device always true (code bug, now removed)
  = allow_cross_signing_reset fires every login (enables generation accumulation)
```
