# Element X Mobile: Matrix Scopes in OIDC Discovery

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Matrix-specific scope URNs to the OIDC discovery `scopes_supported` so Element X mobile clients see full spec-conformant metadata.

**Architecture:** The `SCOPES` constant in `siwx-oidc/src/oidc.rs` is a fixed-size `[Scope; 2]` containing only `openid` and `profile`. The authorize handler already accepts arbitrary scopes (it only requires `openid` to be present), so this is purely a discovery metadata fix. We expand `SCOPES` to a `Vec<Scope>` and add the stable + MSC2967 unstable Matrix scope URNs.

**Tech Stack:** Rust, `openidconnect` crate, `lazy_static`

**Companion repo:** All code changes are in `/home/system-001/siwx-oidc/` (not the matrix-server repo).

---

## Hypothesis Register

| ID | If | Then | Assumptions | Verification |
|----|-----|------|-------------|--------------|
| H1 | We add Matrix URN scopes to the SCOPES constant | Discovery metadata `scopes_supported` includes them | `set_scopes_supported` at line 204 uses `SCOPES.to_vec()` directly | `cargo test discovery_metadata_contains_matrix_scopes` |
| H2 | We change SCOPES from `[Scope; 2]` to `Vec<Scope>` | No downstream breakage; `.to_vec()` on a `Vec` returns a clone | `SCOPES` is only referenced at line 204 via `.to_vec()` | `cargo test` full suite passes |
| H3 | We add a discovery metadata test | Future scope regressions are caught | `oidc::metadata()` returns serializable `CoreProviderMetadata` | Test inspects serialized JSON for expected scope strings |

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/oidc.rs:55-58` | Modify | Expand SCOPES constant with Matrix URN scopes |
| `src/oidc.rs:204` | Modify | Change `.to_vec()` to `.clone()` (Vec, not array) |
| `src/oidc.rs` (tests module) | Modify | Add `discovery_metadata_contains_matrix_scopes` test |

---

### Task 1: Expand SCOPES constant with Matrix scope URNs

**Hypotheses:** H1, H2
**Files:**
- Modify: `src/oidc.rs:55-58` (SCOPES constant)
- Modify: `src/oidc.rs:204` (consumption site)

- [ ] **Step 1: Write the failing test**

Add this test at the end of the `#[cfg(test)] mod tests` block in `src/oidc.rs` (before the closing `}`), after the existing `test_extract_device_id_from_scope` test:

```rust
#[test]
fn discovery_metadata_contains_matrix_scopes() {
    let base = Url::parse("https://siwx-oidc.example.com").unwrap();
    let pm = metadata(base).unwrap();
    let json = serde_json::to_value(&pm).unwrap();
    let scopes = json["scopes_supported"]
        .as_array()
        .expect("scopes_supported must be an array");
    let scope_strings: Vec<&str> = scopes.iter().map(|s| s.as_str().unwrap()).collect();

    // Core OIDC scopes
    assert!(scope_strings.contains(&"openid"), "missing openid");
    assert!(scope_strings.contains(&"profile"), "missing profile");

    // Stable Matrix scopes
    assert!(
        scope_strings.contains(&"urn:matrix:client:api:*"),
        "missing stable urn:matrix:client:api:*"
    );
    assert!(
        scope_strings.contains(&"urn:matrix:client:device:*"),
        "missing stable urn:matrix:client:device:*"
    );

    // MSC2967 unstable Matrix scopes (used by Element X)
    assert!(
        scope_strings.contains(&"urn:matrix:org.matrix.msc2967.client:api:*"),
        "missing unstable urn:matrix:org.matrix.msc2967.client:api:*"
    );
    assert!(
        scope_strings.contains(&"urn:matrix:org.matrix.msc2967.client:device:*"),
        "missing unstable urn:matrix:org.matrix.msc2967.client:device:*"
    );
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/system-001/siwx-oidc && cargo test discovery_metadata_contains_matrix_scopes -- --nocapture 2>&1 | tail -20`
Expected: FAIL with "missing stable urn:matrix:client:api:*"

- [ ] **Step 3: Expand SCOPES constant**

Replace the SCOPES definition at lines 54-59 of `src/oidc.rs`:

Old:
```rust
lazy_static::lazy_static! {
    static ref SCOPES: [Scope; 2] = [
        Scope::new("openid".to_string()),
        Scope::new("profile".to_string()),
    ];
}
```

New:
```rust
lazy_static::lazy_static! {
    static ref SCOPES: Vec<Scope> = vec![
        Scope::new("openid".to_string()),
        Scope::new("profile".to_string()),
        // Stable Matrix scopes (MSC2967 graduated)
        Scope::new("urn:matrix:client:api:*".to_string()),
        Scope::new("urn:matrix:client:device:*".to_string()),
        // MSC2967 unstable prefixes (still used by Element X)
        Scope::new("urn:matrix:org.matrix.msc2967.client:api:*".to_string()),
        Scope::new("urn:matrix:org.matrix.msc2967.client:device:*".to_string()),
    ];
}
```

- [ ] **Step 4: Update SCOPES consumption**

At line 204 of `src/oidc.rs`, change `.to_vec()` to `.clone()` since `SCOPES` is now a `Vec`:

Old:
```rust
    .set_scopes_supported(Some(SCOPES.to_vec()))
```

New:
```rust
    .set_scopes_supported(Some(SCOPES.clone()))
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /home/system-001/siwx-oidc && cargo test discovery_metadata_contains_matrix_scopes -- --nocapture 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `cd /home/system-001/siwx-oidc && cargo test 2>&1 | tail -30`
Expected: All tests pass, including `authorize_accepts_matrix_scopes` and `test_extract_device_id_from_scope`

- [ ] **Step 7: Commit**

```bash
cd /home/system-001/siwx-oidc
git add src/oidc.rs
git commit -m "feat: advertise Matrix scopes in OIDC discovery metadata

Element X mobile clients read scopes_supported from the OIDC discovery
endpoint. Add stable and MSC2967 unstable Matrix scope URNs so clients
see full spec-conformant metadata. The authorize handler already accepts
these scopes; this change only affects discovery advertisement."
```
