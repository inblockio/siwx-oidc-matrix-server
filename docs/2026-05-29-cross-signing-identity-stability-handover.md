# Cross-Signing Identity Stability — Investigation Handover

**Date:** 2026-05-29
**Status:** Investigation complete, grounded in source + live data. No code changed. Ready to plan + implement.
**Symptom that started this:** On login, Element shows **"You need to reset your digital identity"** even on what the user believed was a brand-new account's first login.

---

## TL;DR for the next session

- The reset prompt is **not** a login/provisioning failure. Login works; a session and device are always created.
- "Reset your digital identity" is Element's **client-side** cross-signing branch. It appears when a fresh client/session faces an account that **already has a master cross-signing key it cannot access** (no local keys, no recovery key entered).
- Root cause is **identity churn** created by siwx-oidc: it deletes the user's device on every login and on every logout, and calls `allow_cross_signing_reset` on every login. Each new session is therefore a fresh Olm device with an empty crypto store facing a pre-existing master key.
- **Key finding that shrinks the fix:** siwx-oidc *already* extracts and honors the client-proposed device_id on the Element Web path (`oidc.rs:1408-1420`). The fix is mostly **deleting churn code**, not adding plumbing. This is a complexity-collapse win.
- Recommended fix = **MAS-canonical pattern**: stable client-owned device_id, set up cross-signing once, reuse via secret storage (4S). Stop deleting devices except on explicit sign-out.

---

## How encryption onboarding actually works here (grounded)

Cross-signing identity is **per-user**, not per-device (matrix-spec `end_to_end_encryption.md:1030`: each user has master/self-signing/user-signing keypairs; the master key "serves as the user's identity"). Devices come and go under one stable master key.

The reset prompt is decided entirely client-side:

- `MatrixChat.postLoginSetup` (element-web `apps/web/src/components/structures/MatrixChat.tsx:449-465`):
  - if `userHasCrossSigningKeys()` is **true** → `Views.COMPLETE_SECURITY` (the screen offering "Verify with another device / recovery key / **Reset**").
  - if **false** → `InitialCryptoSetupStore.startInitialCryptoSetup` runs `createCrossSigning` + `resetKeyBackup` **silently** (`stores/InitialCryptoSetupStore.ts:104-109`).
- `userHasCrossSigningKeys()` does a **live server query** (matrix-js-sdk `rust-crypto/rust-crypto.ts:519-527`): true iff a master key is published server-side for this user right now.
- Server side, MSC3861 does **not** block first-time key upload: Synapse `rest/client/keys.py:403` only rejects `device_signing/upload` when `is_cross_signing_setup AND not master_key_updatable_without_uia`. For a virgin account `check_cross_signing_setup` returns `exists=False` (`handlers/e2e_keys.py:1468-1469`), so first-time setup is allowed with no UIA.
- `allow_cross_signing_reset` on a **virgin** account is a **no-op**: it updates the row `WHERE keytype='master'`; with no master key `rowcount==0` and the MAS admin endpoint raises "User has no master cross-signing key" (`storage/.../end_to_end_keys.py:1679-1716`, `rest/admin/users.py:1290-1318`). The replacement window is `REPLACEMENT_PERIOD_MS = 10 min` (`users.py:1293`). **The window only matters on re-login/reset of an already-bootstrapped account.**

### Conclusion
On a genuinely first-ever login, Element silently bootstraps and the reset button never appears. The reset button only appears when a master key already exists and this session cannot access it. That state is manufactured by the churn below.

---

## The churn engine (siwx-oidc source, verified)

`src/oidc.rs` `provision_synapse_device` (`oidc.rs:1187-1236`), called by the Element Web auth-code path at `oidc.rs:1413`:

1. `oidc.rs:1197-1201` — deletes the Redis-tracked device on **every** login.
2. `oidc.rs:1203-1208` — uses client-proposed device_id if present (it is, for Element Web — see below), else mints `SIWX_{uuid}`.
3. `oidc.rs:1231` — calls `allow_cross_signing_reset` on **every** login.
4. `src/compat.rs:48-60` (revoke) and the logout handler — call `delete_device` on **logout**.
5. `src/db/redis.rs:337-350` — `device_ids/{did}` mapping that drives the delete in step 1.

**Element Web DOES send a stable device_id** in the OAuth scope, and siwx-oidc already extracts it:
- `oidc.rs:1408-1420` — auth-code path reads `session_entry.scope` and calls `extract_device_id_from_scope`, passing it to `provision_synapse_device` as `proposed_device_id`.
- `oidc.rs:1168-1179` — extractor handles both `urn:matrix:client:device:` and `urn:matrix:org.matrix.msc2967.client:device:` (MSC2967).
- Device-code/QR path (Element X) does the same at `oidc.rs:573-600`.

So the device_id plumbing is already correct. The damage is the **delete-on-login + delete-on-logout + reset-every-login** behavior that churns around the stable id.

### Why the churn breaks cross-signing
Synapse's `delete_device` (MAS endpoint `rest/synapse/mas/devices.py:80-117` → `storage/databases/main/devices.py:389-458`) deletes from `devices`, `e2e_device_keys_json`, OTKs, etc., but **NOT** `e2e_cross_signing_signatures`. And the signature-upload handler still **skips** uploads when a signature already exists (`handlers/e2e_keys.py:1226-1231`, verified in v1.153.0). So deleting-then-recreating a device leaves an orphaned/stale self-signing signature, and the new key cannot be re-signed → unverifiable device → Element offers only Reset → new master generation. This is the same root cause as the 2026-05-19 device-verification analysis; fresh-device-per-login traded a recoverable bug for unrecoverable identity churn.

---

## Live server evidence (read-only, `deploy@agentic.inblock.io`, Synapse v1.153.0)

Query path (no `sqlite3` binary in container; use python3):
```bash
ssh -i ~/.ssh/id_ed25519 deploy@agentic.inblock.io \
  'cd /home/deploy/matrix/stack && docker compose exec -T matrix_synapse python3 -c "import sqlite3; ..."'
```
DB: `/data/homeserver.db`. **Read-only only — never mutate production from here.**

- **Master-key generations per user** (each = one identity reset): distribution `{1:14 users, 2:2, 3:1, 4:2, 13:1}`. One user reset their identity 13 times. This is the churn signature.
- **Key backup versions:** ~32 total, ~12 marked deleted; several users have many (one had versions 1–6, most deleted).
- **Orphan devices:** top user has ~43 device rows; others 19/15/15/10. Logout cleanup is not keeping pace.
- **Users with zero cross-signing keys:** ~6–10 (count drifts as logins happen) — people who hit the reset prompt and abandoned it.
- **Freshest fully-provisioned DID** `@did-pkh-eip155-1-0xb13e70df…`: has full SSSS (`io.element.recovery`, `m.cross_signing.*`, `m.megolm_backup.v1`, `m.secret_storage.default_key` + key) AND **both** an Element X and an Element Web device. This is the "set up on one client, second client sees existing identity → Reset" sequence in the data.

---

## Open question to confirm before/while implementing

The reported "first login" was almost certainly a **second client/session**, not a virgin account (see the dual-client DID above). Confirm with the user:

> When you saw the reset prompt, was it the **very first client that DID had ever touched**, or had you already logged in once (Element X mobile, or an earlier browser)?

- If second client → root cause above is correct; proceed with the fix.
- If truly the first client ever AND still reset → different cause: `createCrossSigning`'s `uiAuthCallback` failing under password-less MSC3861 (element-web `CreateCrossSigning.ts`). Verify by querying `e2e_cross_signing_keys` for that user **before** they click anything; if zero master rows and reset still shows, chase the SDK UIA path instead.

---

## Recommended fix (Option A — complexity collapse)

Align with the MAS-canonical pattern. MAS never deletes/regenerates device_ids on login; the client owns a stable device_id passed in scope and MAS just `upsert_device`s it (`matrix-authentication-service crates/handlers/src/oauth2/token.rs:573-589` and `:986-998`). siwx-oidc already receives the id — stop sabotaging it.

Changes (mostly deletions):
1. **Stop deleting the device on login** — remove/guard `oidc.rs:1197-1201`. Reuse the client-proposed device_id as-is; `upsert_device` is idempotent for an unchanged device.
2. **Stop deleting the device on logout** — `compat.rs` revoke/logout should NOT `delete_device`. Reserve device deletion for an explicit "sign out this device / sign out everywhere" action only.
3. **Stop calling `allow_cross_signing_reset` on every login** — `oidc.rs:1231`. First-time upload needs no UIA (`keys.py:403`); only a genuine identity *reset* needs the window. Either drop it entirely or gate it behind "master key already exists AND user explicitly chose reset."
4. **Retire the `device_ids/{did}` Redis mapping** (`redis.rs:337-350`) once nothing deletes by it.

This collapses three moving parts (delete-on-login, delete-on-logout, reset-every-login + Redis mapping) into "honor the stable device_id the client already sends." Stable device + stable master key → Element hits the silent secret-storage import branch (matrix-js-sdk `rust-crypto/CrossSigningIdentity.ts:89-118`) instead of the reset screen.

### Residual constraint to respect
Device-id **recycling with new keys** is still broken upstream (stale signatures, `e2e_keys.py:1226-1231` in v1.153.0). Option A avoids recycling naturally (same device keeps its keys), so the constraint stops being relevant rather than being worked around. **If** any code path still deletes a device that may be recreated, it MUST also clean `e2e_cross_signing_signatures` for that device.

### Lower-ranked alternatives (rejected)
- **(B) Force recovery-key reuse, keep current churn:** fragile, still churns master key whenever the user skips the prompt. Does not fix generation pile-up.
- **(C) Device dehydration (MSC3814):** not enabled here; orthogonal; most invasive, least targeted.

---

## Implementation plan (next session)

1. **Confirm the open question** with the user (first-ever client vs second client).
2. **Capture the real Element Web `/authorize` scope** once, to prove the device_id is present and stable across re-logins from the same browser (grep siwx-oidc logs for `using client-proposed device_id from scope` at `oidc.rs:1204`). This is the last assumption to close.
3. Draft the change with `writing-plans`; implement against `../siwx-oidc` (`oidc.rs`, `compat.rs`, `redis.rs`). Remember: **all Docker images are built via GitHub Actions CI/CD, never locally.**
4. Add/adjust tests around `provision_synapse_device` (device reuse, no-delete-on-login, no-reset-when-master-exists).
5. Deploy via `/deploy` (`deploy.sh --build --restart`, SSH as `deploy@`). Tag-based.
6. **Verify outcome:** fresh DID first login → silent setup, no reset button; logout + re-login from same browser → still verified, no reset, master generation count stays at 1.

---

## One-time production cleanup (describe only — do NOT run blind)

After the fix is deployed and stable:
- **Orphan devices:** prune `devices` rows lacking `e2e_device_keys_json` (see `skills/siwx-matrix-device-verify.md` §stale device accumulation).
- **Dead key-backup versions:** collapse to one active version per user.
- **Multi-generation masters:** the ~6 users with >1 master generation (one has 13) each need a one-time nuclear cross-signing reset + a clean re-login choosing "Set up encryption" (device-verify skill §nuclear reset).
- **Zero-key users:** benign; resolve on next proper setup.

---

## Risks / unverified assumptions

1. **Element Web device_id stability across re-logins** — strongly expected (matrix-js-sdk persists it in localStorage) and the extractor is wired, but capture one real `/authorize` scope to be certain (step 2 above). If Element sends none/random, derive a deterministic device_id from DID + client.
2. **The reported account was a second client, not virgin** — high confidence from the dual-client DID, but confirm with the user (open question).
3. **Changing logout to not delete devices** could leave more orphans if there is no explicit "sign out everywhere" path — add one as part of the change.

---

## References

### Source citations
- **siwx-oidc** (`/home/system-001/siwx-oidc`): `src/oidc.rs:1168-1179` (extractor), `:1187-1236` (`provision_synapse_device`; delete `1197-1201`, id choice `1203-1208`, reset `1231`), `:1408-1420` (Element Web callsite), `:573-600` (device-code path); `src/compat.rs:48-60` (revoke/logout delete); `src/db/redis.rs:337-350` (device_ids mapping); `src/synapse_client.rs:63-139` (MAS calls).
- **Synapse v1.153.0:** `rest/client/keys.py:384-431` (first-time allowed at `:403`), `handlers/e2e_keys.py:1453-1471` (`check_cross_signing_setup`) & `:1226-1231` (signature-upload skip), `storage/databases/main/end_to_end_keys.py:1679-1716` (replacement window) & `:1609-1647` (`delete_e2e_keys_by_device`), `storage/databases/main/devices.py:389-458` (`delete_devices` omits cross-signing sigs), `rest/admin/users.py:1290-1318` (10-min window), `rest/synapse/mas/devices.py:80-117` (MAS delete_device).
- **element-web (develop):** `apps/web/src/components/structures/MatrixChat.tsx:449-465` (the branch), `stores/InitialCryptoSetupStore.ts:104-118`, `stores/SetupEncryptionStore.ts`, `CreateCrossSigning.ts`, `utils/crypto/shouldSkipSetupEncryption.ts`.
- **matrix-js-sdk (develop):** `rust-crypto/rust-crypto.ts:503-543` (`userHasCrossSigningKeys`), `rust-crypto/CrossSigningIdentity.ts:45-168` (import branch `89-118`).
- **matrix-authentication-service (main):** `crates/handlers/src/oauth2/token.rs:573-589` and `:986-998` (upsert client device_id, no delete/regen).
- **matrix-spec:** `data/api/.../end_to_end_encryption.md:1030` (per-user cross-signing), `:18-39` (verification mechanisms).

### Local context
- `docs/2026-05-19-device-verification-analysis.md` — original stale-signature root cause that motivated fresh-device-per-login.
- `skills/siwx-matrix-device-verify.md` — UIA window, generation mismatch, nuclear reset, cleanup procedures.
- `CLAUDE.md` → "MSC3861 Delegated Auth" and "Device lifecycle" sections.

### Subagent threads (resumable)
- Seamless first-login investigation: agent `a347255ae8459d23a`.
- Recurrence/stability investigation: agent `a57a459b43b42dd66`.

### Environment
- Production: `deploy@agentic.inblock.io` (139.59.144.60), stack at `/home/deploy/matrix/stack`, container `matrix_synapse`, project `matrix`. SSH key `~/.ssh/id_ed25519`. Synapse v1.153.0.
- siwx-oidc source is the companion repo at `../siwx-oidc`. Images built via GitHub Actions CI/CD only.
