# Cross-Signing Identity Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop siwx-oidc from churning Matrix devices and resetting cross-signing on every login/logout, and make Element Web recovery (4S) setup mandatory, so a user's E2EE identity is stable and device loss is non-catastrophic.

**Architecture:** The "reset your digital identity" prompt recurs because siwx-oidc (a) deletes the user's device on logout/revoke, (b) deletes the prior device and (c) calls `allow_cross_signing_reset` on every login. Removing these three behaviors makes login idempotent (a plain `upsert_device` against a client-supplied stable device_id). Once nothing deletes by the Redis `device_ids/{did}` mapping, that mapping is dead and is retired. With those deletions gone, `provision_synapse_device` and `provision_synapse_device_additive` become identical and collapse into a single function. Separately, `force_verification: true` in element-config.json forces every fresh login through a non-dismissible recovery-setup flow so a lost device can always be recovered. The legitimate user-initiated reset path already exists in `account.rs` (`ACTION_CROSS_SIGNING_RESET`), so removing per-login resets loses no capability.

**Tech Stack:** Rust (axum, redis, openidconnect), Synapse MAS HTTP endpoints, Element Web config JSON. All Docker images built via GitHub Actions CI/CD, never locally.

---

## Hypothesis Register

| ID | If | Then | Assumptions | Verification |
|----|-----|------|-------------|--------------|
| H1 | siwx-oidc stops calling `delete_device` on revoke/logout (compat.rs:55, :89) | A user's verified device + cross-signing identity survive token-refresh and logout cycles; no churn-driven "reset identity" prompt | revoke/logout are the only logout-path deleters; explicit "sign out this device" is a separate future flow | grep: no `delete_device` calls remain in compat.rs; `cargo build` |
| H2 | `provision_synapse_device` no longer deletes the prior device (oidc.rs:1197-1202) and re-uses the client-supplied device_id | Re-login with the same device_id is a pure `upsert_device` (idempotent), preserving the device's E2EE keys | Element Web sends a stable `urn:matrix:client:device:` in scope; Element X sends its own device_id | `test_resolve_device_id` passes; `cargo test`; code review |
| H3 | Per-login `allow_cross_signing_reset` is removed (oidc.rs:1231, :1267) while `account.rs` reset path stays | Cross-signing is never silently reset by a login, but a user can still explicitly reset via `GET /account?action=org.matrix.cross_signing_reset` | account.rs reset flow is wired and reachable | grep: only `account.rs::execute_action` calls `allow_cross_signing_reset`; `cargo build` |
| H4 | Nothing reads/writes Redis `device_ids/{did}` after H2 | The `get/set/delete_device_id` trait methods + impls + `KV_DEVICE_PREFIX` can be deleted with no compile break | No other caller exists (confirmed: only oidc.rs:1197/1210) | grep: zero non-definition hits; `cargo build` |
| H5 | element-config.json sets `force_verification: true` | A first-ever login is forced through a non-dismissible COMPLETE_SECURITY flow requiring cross-signing readiness (recovery) before app entry | element-web image is 1.12.x with confirmed behavior (Lifecycle.ts sets `must_verify_device` on fresh login; CompleteSecurity hides skip button; onCompleteSecurityE2eSetupFinished blocks until `isCrossSigningReady`) | JSON valid; deploy + manual first-login test shows non-skippable recovery setup |
| H6 | (Item #4, deferred) A periodic prune deletes only devices with no uploaded keys AND stale `last_seen` | Stale orphan devices are reclaimed without disrupting active or mid-setup sessions | Synapse admin API exposes device list with `last_seen` + key presence; heuristic is safe | New admin API + integration test (NOT in this plan's core scope) |

---

## File Structure

- `../siwx-oidc/src/compat.rs` — remove two `delete_device` calls (revoke, logout). [H1]
- `../siwx-oidc/src/oidc.rs` — merge the two provisioning functions into one; remove delete-on-login, Redis device_id read/write, and per-login `allow_cross_signing_reset`; add a unit-testable `resolve_device_id` seam; update both callsites. [H2, H3]
- `../siwx-oidc/src/db/mod.rs` — remove `KV_DEVICE_PREFIX` and the three `*_device_id` trait methods. [H4]
- `../siwx-oidc/src/db/redis.rs` — remove the three `*_device_id` impls. [H4]
- `config/element-config.json` (this repo) — add `"force_verification": true`. [H5]

**Out of scope (this plan):** Item #4 orphan-device cleanup (H6) is documented as a deferred follow-up task at the end — it is the only net-new subsystem, needs a new Synapse admin-API integration, and its urgency drops once churn stops and recovery is mandatory.

---

## Task 1: Stop device deletion on logout/revoke (Item #1, H1)

**Files:**
- Modify: `../siwx-oidc/src/compat.rs:48-64` (revoke) and `:82-99` (logout)

- [ ] **Step 1: Read the two handlers in full**

Run: read `../siwx-oidc/src/compat.rs` lines 40-105 to confirm surrounding context (the `meta` lookup and the `synapse` guard).

- [ ] **Step 2: Remove the `delete_device` call in `revoke`**

In `revoke` (around line 55), delete the block:

```rust
            if let Err(e) = synapse.delete_device(&meta.username, &meta.device_id).await {
                warn!("revoke: delete_device failed: {}", e);
            }
```

Token revocation must still delete the opaque token from Redis (leave that untouched). Only the Synapse device-deletion is removed. If removing this leaves an `if let Some(synapse) = ...` guard with an empty body, collapse the now-dead guard too, but keep the token deletion logic intact.

- [ ] **Step 3: Remove the `delete_device` call in `logout`**

In `logout` (around line 89), delete the block:

```rust
                if let Err(e) = synapse.delete_device(&meta.username, &meta.device_id).await {
                    warn!("logout: delete_device failed: {}", e);
                }
```

Same rule: keep token invalidation; remove only the device deletion. Collapse any guard left with an empty body.

- [ ] **Step 4: Verify no `delete_device` calls remain in compat.rs**

Run: `cd ../siwx-oidc && grep -n "delete_device" src/compat.rs`
Expected: no output (zero matches).

- [ ] **Step 5: Build**

Run: `cd ../siwx-oidc && cargo build 2>&1 | tail -5`
Expected: compiles. Fix any unused-import warnings for `SynapseClient`/`warn` only if they become hard errors; otherwise leave for Task 2's wider sweep.

- [ ] **Step 6: Commit**

```bash
cd ../siwx-oidc
git add src/compat.rs
git commit -m "fix(compat): stop deleting Synapse device on logout/revoke

Device deletion on every logout/revoke churned the user's E2EE
identity. Reserve deletion for an explicit sign-out flow."
```

---

## Task 2: Collapse provisioning into one idempotent function (Items #2, #3, H2, H3)

**Files:**
- Modify: `../siwx-oidc/src/oidc.rs:1181-1272` (the two provisioning fns → one)
- Modify: `../siwx-oidc/src/oidc.rs:1413-1419` (Element Web callsite)
- Modify: `../siwx-oidc/src/oidc.rs:593-599` (device_code / Element X callsite)
- Test: `../siwx-oidc/src/oidc.rs` (`#[cfg(test)]` module near line 1935)

- [ ] **Step 1: Write the failing test for the device_id resolver**

Add to the existing test module (near `test_extract_device_id_from_scope`, ~line 1935):

```rust
    #[test]
    fn test_resolve_device_id_uses_proposed() {
        let id = resolve_device_id(Some("2VeUcPZUV5"));
        assert_eq!(id, "2VeUcPZUV5");
    }

    #[test]
    fn test_resolve_device_id_mints_when_absent() {
        let id = resolve_device_id(None);
        assert!(id.starts_with("SIWX_"));
        assert_eq!(id.len(), "SIWX_".len() + 8);
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd ../siwx-oidc && cargo test resolve_device_id 2>&1 | tail -20`
Expected: FAIL — `cannot find function 'resolve_device_id'`.

- [ ] **Step 3: Add the `resolve_device_id` helper**

Insert directly above `provision_synapse_device` (replacing the old doc comment block at 1181-1186):

```rust
/// Resolve the device_id to provision: use the client-proposed id when present,
/// otherwise mint a fresh `SIWX_{uuid8}`.
fn resolve_device_id(proposed_device_id: Option<&str>) -> String {
    match proposed_device_id {
        Some(proposed) => proposed.to_string(),
        None => format!("SIWX_{}", &Uuid::new_v4().to_string()[..8]),
    }
}
```

- [ ] **Step 4: Replace BOTH provisioning functions with one merged function**

Delete `provision_synapse_device` (1187-1236) AND `provision_synapse_device_additive` (1238-1272) entirely, and replace with this single function:

```rust
/// Provision a Synapse user+device for a DID. Best-effort: failures are logged
/// but never fail the auth flow. Idempotent: re-provisioning the same device_id
/// is a plain upsert that preserves the device's E2EE keys. Never deletes an
/// existing device and never resets cross-signing — those are explicit,
/// user-initiated actions (see `account.rs`).
///
/// `proposed_device_id`: the client-supplied device_id from the OAuth scope
/// (stable for Element Web and Element X). When `None`, a fresh `SIWX_{uuid}`
/// is minted.
pub async fn provision_synapse_device(
    did: &str,
    synapse_client: Option<&SynapseClient>,
    display_name: &str,
    proposed_device_id: Option<&str>,
) -> Option<String> {
    let synapse = synapse_client?;
    let localpart = did_to_localpart(did);
    let dev_id = resolve_device_id(proposed_device_id);
    debug!("provisioning device_id={} for did={}", dev_id, did);

    match synapse.is_localpart_available(&localpart).await {
        Ok(true) => {
            if let Err(e) = synapse.provision_user(&localpart, did).await {
                warn!("provision_user failed: {}", e);
            }
        }
        Ok(false) => {}
        Err(e) => warn!("is_localpart_available check failed: {}", e),
    }

    if let Err(e) = synapse
        .upsert_device(&localpart, &dev_id, Some(display_name))
        .await
    {
        warn!("upsert_device failed: {}", e);
    }

    Some(dev_id)
}
```

Note: this removes the Redis `get_device_id`/`set_device_id` calls (Item #2 + sets up #5), the `delete_device` cleanup (Item #2), and both `allow_cross_signing_reset` calls (Item #3). The `db_client` parameter is gone.

- [ ] **Step 5: Update the Element Web callsite (oidc.rs ~1413)**

Replace:

```rust
    let device_id = provision_synapse_device(
        &did,
        synapse_client,
        db_client,
        "Element Web",
        proposed_device_id.as_deref(),
    )
    .await;
```

with (drop the `db_client` argument):

```rust
    let device_id = provision_synapse_device(
        &did,
        synapse_client,
        "Element Web",
        proposed_device_id.as_deref(),
    )
    .await;
```

- [ ] **Step 6: Update the device_code / Element X callsite (oidc.rs ~593)**

Replace:

```rust
            provision_synapse_device_additive(
                &did,
                synapse_client,
                db_client,
                &dev_id,
                "Element X",
            )
            .await;
```

with (call the merged fn; pass the already-resolved `dev_id` as the proposed id):

```rust
            provision_synapse_device(
                &did,
                synapse_client,
                "Element X",
                Some(&dev_id),
            )
            .await;
```

- [ ] **Step 7: Run the resolver tests — verify pass**

Run: `cd ../siwx-oidc && cargo test resolve_device_id 2>&1 | tail -20`
Expected: PASS (2 tests).

- [ ] **Step 8: Build and verify no `allow_cross_signing_reset` / deletion remains on login paths**

Run:
```bash
cd ../siwx-oidc && cargo build 2>&1 | tail -10
grep -n "allow_cross_signing_reset" src/oidc.rs
grep -n "provision_synapse_device_additive\|get_device_id\|set_device_id" src/oidc.rs
```
Expected: build OK; zero matches for all greps (the only remaining `allow_cross_signing_reset` call lives in `account.rs`).

- [ ] **Step 9: Confirm the explicit reset path still exists (H3)**

Run: `cd ../siwx-oidc && grep -n "allow_cross_signing_reset\|cross_signing_reset" src/account.rs`
Expected: `ACTION_CROSS_SIGNING_RESET` and the `execute_action` call to `allow_cross_signing_reset` are present.

- [ ] **Step 10: Commit**

```bash
cd ../siwx-oidc
git add src/oidc.rs
git commit -m "refactor(oidc): make device provisioning idempotent, drop per-login reset

Merge provision_synapse_device + _additive into one function. Stop
deleting the prior device on login and stop calling
allow_cross_signing_reset per login (the explicit reset path in
account.rs remains). Re-login is now a plain upsert that preserves
E2EE keys."
```

---

## Task 3: Retire the Redis `device_ids/{did}` mapping (Item #5, H4)

**Files:**
- Modify: `../siwx-oidc/src/db/mod.rs:14` (remove `KV_DEVICE_PREFIX`) and `:138-145` (remove the three trait methods + their doc comments)
- Modify: `../siwx-oidc/src/db/redis.rs:337-350` (remove the three impls)

- [ ] **Step 1: Confirm the mapping is now dead**

Run: `cd ../siwx-oidc && grep -rn "get_device_id\|set_device_id\|delete_device_id\|KV_DEVICE_PREFIX" src/`
Expected: matches ONLY in `db/mod.rs` (definitions) and `db/redis.rs` (impls + const usage). No call sites elsewhere.

- [ ] **Step 2: Remove the trait methods in `db/mod.rs`**

Delete the `// -- Device ID persistence --` section (the doc comments + these three method declarations) around lines 138-145:

```rust
    /// Look up the persistent device ID for a DID.
    async fn get_device_id(&self, did: &str) -> Result<Option<String>>;
    /// Store a persistent device ID for a DID (no TTL).
    async fn set_device_id(&self, did: &str, device_id: &str) -> Result<()>;
    /// Remove the persistent device ID for a DID.
    async fn delete_device_id(&self, did: &str) -> Result<()>;
```

- [ ] **Step 3: Remove the `KV_DEVICE_PREFIX` const in `db/mod.rs`**

Delete line 14:

```rust
const KV_DEVICE_PREFIX: &str = "device_ids";
```

- [ ] **Step 4: Remove the three impls in `db/redis.rs`**

Delete the three method implementations (around lines 337-350) `get_device_id`, `set_device_id`, `delete_device_id`. After deletion, verify no dangling reference to `KV_DEVICE_PREFIX` remains in this file.

- [ ] **Step 5: Build**

Run: `cd ../siwx-oidc && cargo build 2>&1 | tail -10`
Expected: compiles cleanly. If the compiler flags `KV_DEVICE_PREFIX` as still-used or still-defined, resolve that match.

- [ ] **Step 6: Run the full test suite**

Run: `cd ../siwx-oidc && cargo test 2>&1 | tail -20`
Expected: all tests pass.

- [ ] **Step 7: Clippy (no new warnings)**

Run: `cd ../siwx-oidc && cargo clippy --all-targets 2>&1 | tail -20`
Expected: no new warnings introduced by these changes.

- [ ] **Step 8: Commit**

```bash
cd ../siwx-oidc
git add src/db/mod.rs src/db/redis.rs
git commit -m "refactor(db): retire device_ids/{did} mapping

Nothing recycles or deletes by the Redis device_id mapping now that
provisioning is idempotent, so remove the trait methods, impls, and
KV_DEVICE_PREFIX."
```

---

## Task 4: Make Element Web recovery (4S) setup mandatory (config item, H5)

**Files:**
- Modify: `config/element-config.json` (this repo)

- [ ] **Step 1: Add `force_verification` to the top-level config object**

In `config/element-config.json`, add a top-level key alongside `disable_guests` / `sso_redirect_options`:

```json
  "force_verification": true,
```

Place it after `"sso_redirect_options": { "immediate": true },` so the diff is minimal. Do NOT nest it inside `setting_defaults` — `force_verification` is read via `SdkConfig.get("force_verification")` at the top level.

- [ ] **Step 2: Validate the JSON**

Run: `cd /home/system-001/siwx-oidc-matrix-server && python3 -c "import json; json.load(open('config/element-config.json')); print('valid')"`
Expected: `valid`.

- [ ] **Step 3: Confirm the key placement**

Run: `cd /home/system-001/siwx-oidc-matrix-server && python3 -c "import json; print(json.load(open('config/element-config.json')).get('force_verification'))"`
Expected: `True` (top-level, not under setting_defaults).

- [ ] **Step 4: Commit**

```bash
cd /home/system-001/siwx-oidc-matrix-server
git add config/element-config.json
git commit -m "feat(element): force mandatory verification/recovery setup

Set force_verification:true so every fresh login is pushed through a
non-dismissible recovery (4S) setup flow, making device loss
recoverable instead of catastrophic."
```

---

## Verification (post-merge, before deploy)

These confirm the hypothesis register without a live deploy:

- [ ] `cd ../siwx-oidc && cargo build && cargo test && cargo clippy --all-targets` — all green
- [ ] `grep -rn "delete_device\b" ../siwx-oidc/src/` — only the `synapse_client.rs` definition + the `account.rs`-adjacent explicit flows remain; NO login/logout/revoke callers
- [ ] `grep -rn "allow_cross_signing_reset" ../siwx-oidc/src/` — definition in `synapse_client.rs` + single caller in `account.rs` only
- [ ] `python3 -c "import json; assert json.load(open('config/element-config.json'))['force_verification'] is True"` — passes

Live verification (requires CI build + deploy via `deploy.sh --build --restart`, SSH `deploy@`):

- [ ] Fresh-browser, new-wallet first login → forced, non-skippable recovery setup; record the recovery key
- [ ] Log out and back in (same browser) → NO "reset your digital identity" prompt; same device retained
- [ ] Trigger token refresh (leave session idle past access-token TTL) → identity stable, no reset prompt

---

## Deferred Follow-up (Item #4, H6 — NOT in this plan's core scope)

**Orphan device cleanup.** Once logout no longer deletes devices (Task 1), genuinely abandoned sessions leave stale device rows. A safe reclaim would:

1. Add a Synapse admin-API client method to list a user's devices with `last_seen_ts` (e.g. `GET /_synapse/admin/v2/users/{user_id}/devices`).
2. Detect "keyless" devices (never uploaded device/cross-signing keys) that are also stale (`last_seen_ts` older than a threshold).
3. Delete only those via the existing `delete_device`, on a periodic background task.

This is deliberately deferred because: (a) it is the only net-new subsystem and needs a new admin-API surface + integration tests; (b) its urgency drops sharply once churn stops (Tasks 1-3) and recovery is mandatory (Task 4); (c) a too-aggressive heuristic risks deleting a device mid-setup. Recommend implementing as its own plan after the core fix is verified in production.
