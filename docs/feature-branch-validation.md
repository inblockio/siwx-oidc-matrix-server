# Feature-Branch Validation: cross-signing identity stability

Manual validation steps for the `fix/cross-signing-identity-stability` branch
(siwx-oidc device-churn fix + mandatory 4S recovery). Run these AFTER
`./deploy-feature.sh <branch> --build-image --deploy --verify` reports green.

The automated `verify-deployment.sh` proves the endpoints are wired correctly.
These steps prove the *behavior change* a human must confirm: that a returning
user keeps a stable cross-signing identity and is never told to "reset your
digital identity."

> The feature branch deploys to the LIVE stack (matrix.inblock.io /
> siwx-oidc.inblock.io / element.inblock.io). Validate quickly, then either
> merge to main or roll back. Do not leave a feature branch running.

---

## What changed (what you are validating)

1. Logout / token revoke no longer deletes the Synapse device.
2. Login no longer deletes the previous device, and no longer mints a fresh
   `SIWX_{uuid}` when the client proposes its own device_id.
3. `allow_cross_signing_reset` no longer fires on every login (explicit reset
   only).
4. `force_verification: true` makes 4S recovery setup mandatory and
   non-dismissible.

Net effect: a returning user reuses the SAME device + cross-signing identity,
so the master key is stable and no reset prompt appears.

---

## Pre-flight

- [ ] `./deploy-feature.sh <branch> --verify` passes (or `./verify-deployment.sh`).
- [ ] You have a test wallet you can sign with (EIP-191 / Ed25519 / P-256).
- [ ] Use a FRESH browser profile (or full logout + clear site data for
      element.inblock.io) so you exercise a true first login.

---

## Test 1 — First login forces recovery setup (mandatory 4S)

1. [ ] Open `https://element.inblock.io` in a fresh profile.
2. [ ] You are redirected straight to siwx-oidc `/authorize` (no welcome page).
3. [ ] Sign in with the wallet.
4. [ ] Element lands on the **device verification / recovery setup** screen.
5. [ ] Confirm there is **no skip / dismiss button** — setup is mandatory.
6. [ ] Complete recovery: save the Security Key / set a Security Phrase.
7. [ ] You reach the room list (app fully unlocked).

PASS: recovery was required and could not be skipped.

---

## Test 2 — Logout then log back in: NO identity reset

1. [ ] In the signed-in session, note the device under
       Settings -> Sessions (device name / id).
2. [ ] Log out (Element "Sign out").
3. [ ] Log back in with the same wallet.
4. [ ] You are **NOT** shown "Reset your digital identity" / "Verify this
       device" as a forced cross-signing reset.
5. [ ] Recovery unlocks with the SAME Security Key / Phrase from Test 1.
6. [ ] Old messages in encrypted rooms remain readable (keys recovered).

PASS: no reset prompt; the cross-signing identity survived the logout/login.

> Before this fix, logout deleted the device and the next login minted a new one
> + called `allow_cross_signing_reset`, so step 4 would have shown the reset
> prompt. Seeing the reset prompt here is a FAIL.

---

## Test 3 — Two logins in a row stay on the same device

1. [ ] Settings -> Sessions: record the current device id.
2. [ ] Log out and back in once more.
3. [ ] Settings -> Sessions: the active device id is unchanged (Element Web
       reuses its stored device), and stale duplicate `SIWX_*` devices are NOT
       piling up on each login.

PASS: device identity is stable across logins.

---

## Test 4 — Token refresh stability (session longevity)

1. [ ] Stay logged in and idle past the access-token TTL (`mat_`, 300s), or
       force a refresh by leaving the tab open ~6+ minutes.
2. [ ] Send a message / navigate. The session keeps working with no
       re-login and no reset prompt (refresh token rotates transparently).

PASS: refresh rotates without disturbing the device/identity.

---

## Test 5 — Explicit reset still works (negative control)

1. [ ] Settings -> Encryption -> reset cross-signing / identity (the explicit,
       user-initiated path).
2. [ ] Element prompts to set up recovery again and a NEW identity is created.

PASS: explicit reset is still available — we only removed the *automatic*
per-login reset, not the deliberate one.

---

## Outcome

- All tests pass -> merge the branch to `main`, then deploy main:
  ```bash
  # after merging the PR
  ./deploy.sh main --build --restart --test
  ```
- Any test fails -> roll back immediately:
  ```bash
  ./deploy-feature.sh main --rollback
  ```
  then capture logs (`docker compose logs siwx-oidc matrix_synapse`) for triage.
