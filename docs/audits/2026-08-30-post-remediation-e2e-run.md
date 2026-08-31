# Post-remediation e2e orchestrator run — 2026-08-30

**Verdict: `overall: pass`, 17/17, exit 0.** This is the post-fix orchestrator run
that the Phase 3 audit recorded as missing (gap 5: "Task 5 did not re-run the
hermetic `e2e-harness/run.sh` orchestrator").

## Why this document exists instead of a committed artifact

`e2e-harness/.gitignore` says `artifacts/` — *"Run output from run.sh — never
tracked."* Zero artifacts are tracked in git. So the durable evidence has to live
in a doc; the raw artifact stays on disk at
`e2e-harness/artifacts/20260830-220504/` on the machine that produced it.

This also corrects a premise worth writing down: the claim that *"the repo's only
durable evidence says fail"* was about a file on disk, not in git. **The repo has
never contained any run evidence at all.** That is arguably the bigger gap, and it
is why this file exists.

## What was under test — recorded by the run itself

`summary.json` now carries its own provenance (added in the same remediation):

```json
"under_test": {
  "harness":    "dev @ dbd722b (dirty)",
  "siwx_oidc":  "worktree-agent-ab72f96f6f3690a04 @ 5f47a9b",
  "connector":  "main @ 924efdd (dirty)",
  "siwx_oidc_image": "localhost/siwx-oidc:e2eh-5f47a9b (built 2026-08-30 19:58:14 +0000) [running container matches: 71381068aac1]"
},
"settings": { "strict_skips": "1" },
"counts":   { "total": 17, "pass": 17, "fail": 0, "known_flagged": 0, "harness_error": 0 }
```

`E2E_EXPECT_SHA=5f47a9b` was set, so every adapter *asserted* the revision rather
than merely recording it. `strict_skips: 1` means an in-test early-return would
have failed the check (rc 4), not passed silently.

## Results

| check | status | rc |
|---|---|---|
| connector.e2ee_bidirectional_messaging | pass | 0 |
| connector.e2ee_media_exchange | pass | 0 |
| connector.rtc_member_advertise | pass | 0 |
| connector.rtc_jwt_handshake | pass | 0 |
| connector.rtc_room_alias_matches_element_call | pass | 0 |
| av-check | pass | 0 |
| device-code.grant_end_to_end | pass | 0 |
| siwx-oidc.msc3861.full_lifecycle | pass | 0 |
| siwx-oidc.msc3861.refresh_token_flow | pass | 0 |
| siwx-oidc.msc3861.returning_user_new_device | pass | 0 |
| **siwx-oidc.msc4191_live.device_management_live** | **pass** | 0 |
| **siwx-oidc.msc4191_live.cross_signing_reset_round_trip_live** | **pass** | 0 |
| **siwx-oidc.cross_signing_reset.legA_roundtrip** | **pass** | 0 |
| **siwx-oidc.cross_signing_reset.stale_window_wedge** | **pass** | 0 |
| **siwx-oidc.cross_signing_reset.no_master_completed** | **pass** | 0 |
| siwx-oidc.session_teardown | pass | 0 |
| **siwx-oidc.msc3861.msc4191_metadata_advertised_and_forwarded** | **pass** | 0 |

Bold = the checks this remediation was required to move. The first five are Task
3's acceptance criterion (`device_management_live` + the cross-signing-reset
family), which the pre-fix baseline had red. The last is the check whose `FLAG:`
prefix was retired — it was flagged for a "Synapse 1.154 re-export limitation"
that no longer exists on a 1.159.0 stack, and it passes.

## The pre-fix baseline proves less than it appeared to

`artifacts/20260830-165441/summary.json` (`overall: fail`, 13 pass / 4 fail) was
treated as the legitimate pre-fix baseline. It is weaker than that:

**It was recorded against a five-week-old siwx-oidc binary.** The harness defaulted
to `SIWX_OIDC_IMAGE_REF=localhost/siwx-oidc:local-grace`, built **2026-07-25**. The
Task 2 admin-token mint and the Task 3 `synapse_client` port were committed
2026-08-30 18:35 — an hour and a half *after* the container running that baseline
was created (16:54). Neither change was in the image.

So those 4 red checks could not have gone green no matter what the test code said,
and the baseline is evidence about an old binary, not about the Task 3 port. It is
the same defect class as the stale `OIDC_E2EH_DIR` default: the harness testing
something other than what it claimed. `run.sh` now refuses to run when the image
predates the HEAD commit of the checkout under test, and when the running container
does not match the configured ref.

## One check went red during remediation, and it was mine

The first post-fix attempt (`artifacts/20260830-220101/`) came back
`12 pass / 0 fail / 5 harness-error`. All five connector checks returned rc=2:

```
ADAPTER PRECONDITION FAILED: test target 'e2e' not found at
/home/waldknoten-01/aqua-matrix-agent/tests/e2e.rs.
```

Not a product failure — a bug in the precondition I had just added to
`connector.sh`. The connector is a cargo **workspace**; the target lives at
`crates/aqua-matrix-agent/tests/e2e.rs`, and `cargo test --test e2e` from the
workspace root resolves it fine. The check now searches for `*/tests/e2e.rs`
excluding `target/`, so it is layout-agnostic.

Worth recording because the guard behaved correctly under a wrong premise: it
refused to report a verdict it could not justify, and said exactly why, in the
artifact. Before this remediation the same five checks had **no** zero-tests guard
at all, so a genuinely missing target would have been five silent passes.

## Reproducing

```bash
cd <siwx-oidc-matrix-server>
export SIWX_OIDC_DIR=<siwx-oidc checkout>
export SIWX_OIDC_IMAGE_REF=localhost/siwx-oidc:e2eh-$(git -C "$SIWX_OIDC_DIR" rev-parse --short HEAD)
export E2E_EXPECT_SHA=$(git -C "$SIWX_OIDC_DIR" rev-parse --short HEAD)
podman build -t "$SIWX_OIDC_IMAGE_REF" -f Dockerfile "$SIWX_OIDC_DIR"   # image must not predate HEAD
e2e-harness/down.sh && e2e-harness/up.sh
e2e-harness/run.sh full
```

`E2E_STRICT_SKIPS` defaults to 1. Setting it to 0 to obtain a green run means the
run was never green.
