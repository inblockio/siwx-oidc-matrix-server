#!/usr/bin/env bash
# =============================================================================
# adapters/_common.sh — shared resolution + honesty guards for ALL suite adapters
# (siwx-oidc-realstack.sh, device-code.sh, connector.sh).
#
# connector.sh did NOT source this file until 2026-08-30. It therefore had no
# zero-tests guard at all, so defect class (b) below was fully live for its 5
# checks -- 5 of the 13 "pass" results in the last recorded full run. Any new
# adapter MUST source this file; that is the whole point of it existing.
#
# WHY THIS FILE EXISTS
#   The siwx-oidc integration-test targets used to live in a dedicated worktree
#   at /home/waldknoten-01/siwx-oidc-e2eh. That worktree was removed on
#   2026-08-02; the targets now live in the primary siwx-oidc checkout. Both
#   adapters carried their own copy of the stale absolute default, so both
#   silently `exit 2` with a ZERO-BYTE artifact — a harness that cannot judge,
#   presenting as a product failure. The resolution logic lives here once so the
#   two adapters cannot drift apart again.
#
# FOUR HONESTY GUARDS PROVIDED HERE
#   0. assert_checkout_revision — refuses to run against an unexpected or DIRTY
#      checkout. Recording the revision (describe_checkout) was never enough:
#      the harness tested whatever branch the sibling checkout happened to be
#      on, which is how a red baseline got recorded against the wrong code.
#   1. resolve_siwx_oidc_dir — locates the checkout by REPO-RELATIVE path (no
#      hardcoded $HOME), and validates it far enough to prove the requested test
#      target actually exists. Every failure is written to the ARTIFACT as well
#      as stderr, so a check that could not run never leaves a zero-byte file.
#   2. assert_tests_actually_ran — `cargo test` exits 0 when a name filter
#      matches NOTHING ("0 passed; ...; N filtered out"). Without this guard a
#      renamed or mistyped test fn is reported by run.sh as a PASS while
#      asserting nothing. Exit code 3 distinguishes "ran but judged nothing"
#      from a real test failure.
#   3. report_skip_markers — surfaces in-test early-returns, and under strict
#      mode (NOW THE DEFAULT) converts them into rc=4 rather than letting a
#      test that asserted nothing report `ok`.
#
# EXIT CODE CONTRACT (consumed by run.sh):
#   2 = harness could not run the check (precondition/environment)
#   3 = the check ran but judged nothing (zero tests matched the filter)
#   4 = the check ran but SKIPPED past its assertions (strict mode)
#   * = cargo's own exit code (real pass/fail)
# =============================================================================

# Emit to both the artifact and stderr, so a failure is never invisible in the
# artifact tree.
adapter_say() {
  local artifact="$1"; shift
  printf '%s\n' "$@" | tee -a "$artifact" >&2
}

# adapter_die <artifact> <exit_code> <message...>
adapter_die() {
  local artifact="$1"; shift
  local code="$1"; shift
  adapter_say "$artifact" "$@"
  exit "$code"
}

# resolve_siwx_oidc_dir <artifact> <test_target>
#   Sets the GLOBAL $SIWX_OIDC_DIR_RESOLVED. Exits 2 (loudly, into the artifact)
#   if the checkout or the requested test target cannot be found.
#
#   NOTE: this deliberately sets a global rather than echoing, because a failure
#   must `exit` the ADAPTER. Inside `$(...)` an exit only kills the subshell and
#   the caller would sail on with an empty path — the exact silent-skip class
#   this file exists to prevent.
#
#   Override precedence: SIWX_OIDC_DIR (preferred) > OIDC_E2EH_DIR (legacy name,
#   still honoured so existing wrapper scripts keep working) > repo-relative
#   default <parent-of-this-repo>/siwx-oidc.
resolve_siwx_oidc_dir() {
  local artifact="$1" target="$2"
  local common_dir harness_dir repo_root default_dir dir

  common_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  harness_dir="$(cd "$common_dir/.." && pwd)"
  repo_root="$(cd "$harness_dir/.." && pwd)"
  default_dir="$(cd "$repo_root/.." && pwd)/siwx-oidc"

  dir="${SIWX_OIDC_DIR:-${OIDC_E2EH_DIR:-$default_dir}}"

  if [ ! -d "$dir" ]; then
    adapter_die "$artifact" 2 \
      "ADAPTER PRECONDITION FAILED: siwx-oidc checkout not found at '$dir'." \
      "  The test targets moved out of the removed siwx-oidc-e2eh worktree (2026-08-02)." \
      "  Set SIWX_OIDC_DIR=/path/to/siwx-oidc, or place the checkout at $default_dir."
  fi
  if [ ! -f "$dir/Cargo.toml" ]; then
    adapter_die "$artifact" 2 \
      "ADAPTER PRECONDITION FAILED: '$dir' exists but has no Cargo.toml — not a Rust checkout."
  fi
  if [ ! -f "$dir/tests/$target.rs" ]; then
    adapter_die "$artifact" 2 \
      "ADAPTER PRECONDITION FAILED: test target '$target' not found at $dir/tests/$target.rs." \
      "  The checkout is present but does not carry this target (wrong branch, or the target was renamed)." \
      "  Available targets: $(ls "$dir/tests" 2>/dev/null | sed 's/\.rs$//' | tr '\n' ' ')"
  fi

  SIWX_OIDC_DIR_RESOLVED="$dir"
}

# describe_checkout <dir> — one line naming exactly which revision is under test.
# A harness that does not record what it tested cannot be audited later.
describe_checkout() {
  local dir="$1" ref sha dirty
  ref="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  sha="$(git -C "$dir" rev-parse --short HEAD 2>/dev/null || echo '?')"
  dirty=""
  [ -n "$(git -C "$dir" status --porcelain 2>/dev/null)" ] && dirty=" (dirty)"
  printf '%s @ %s%s' "$ref" "$sha" "$dirty"
}

# assert_tests_actually_ran <artifact> <cargo_output_file> <cargo_rc>
#   Returns the exit code the adapter should use. Converts cargo's "matched
#   nothing, therefore ok" into an explicit rc=3 so it can never read as a pass.
assert_tests_actually_ran() {
  local artifact="$1" out="$2" rc="$3"
  local ran

  # Sum the "N passed" across every `test result:` line in the output.
  ran="$(grep -Eo 'test result: [a-zA-Z]+\. [0-9]+ passed' "$out" 2>/dev/null \
         | grep -Eo '[0-9]+ passed' | grep -Eo '^[0-9]+' \
         | awk '{s+=$1} END{print s+0}')"

  if [ "$rc" -eq 0 ] && [ "${ran:-0}" -eq 0 ]; then
    adapter_say "$artifact" \
      "ADAPTER JUDGED NOTHING: cargo exited 0 but 0 tests ran (the name filter matched no test)." \
      "  This is a SKIP, not a pass. Check the test fn name in run.sh against the target's actual tests."
    return 3
  fi
  # NOTE on the wording below: `ran` counts only PASSING tests, because that is
  # all cargo's "N passed" field reports. When a test ran and FAILED, `ran` is 0
  # and the old message read "0 test(s) actually ran" -- flatly untrue, and
  # actively misleading during triage of a real failure. It never affected an
  # exit code (the rc!=0 branch above is not reached), but it sent readers
  # hunting a phantom harness bug instead of the actual test failure. Report the
  # passing count as a passing count, and say so explicitly on a failing run.
  if [ "$rc" -eq 0 ]; then
    adapter_say "$artifact" "adapter: $ran test(s) passed (cargo rc=0)"
  else
    adapter_say "$artifact" \
      "adapter: cargo rc=$rc -- at least one test RAN AND FAILED. ($ran passed;" \
      "  a 0 here means no test passed, NOT that no test ran. See the cargo output above.)"
  fi
  return "$rc"
}

# -----------------------------------------------------------------------------
# assert_checkout_revision <artifact> <dir> [label]
#
# WHY: the adapters RECORDED the checkout revision (describe_checkout) but never
# ASSERTED it, so the harness happily tested whatever branch the sibling checkout
# happened to be sitting on. That is exactly how a red baseline came to be
# recorded against the wrong code: the artifact said "fail" while the fix under
# test was on a branch the harness never checked out.
#
# Two assertions:
#   1. If E2E_EXPECT_SHA (or E2E_EXPECT_REF) is set, the checkout MUST match, or
#      the adapter exits 2 (harness error -- never tolerated, not even for a
#      known-flagged check).
#   2. A DIRTY checkout means the artifact does not correspond to any commit and
#      cannot be reproduced. Under strict mode (now the default -- see
#      report_skip_markers) that is a hard error; otherwise a loud warning.
#      Escape hatch: E2E_ALLOW_DIRTY=1.
# -----------------------------------------------------------------------------
#   Expected sha/ref are passed EXPLICITLY (args 4/5) rather than read from a
#   global, because the harness drives two DIFFERENT repos: the siwx-oidc
#   checkout and the connector (aqua-matrix-agent) checkout. A single global
#   E2E_EXPECT_SHA would be asserted against both and could never be satisfied.
assert_checkout_revision() {
  local artifact="$1" dir="$2" label="${3:-checkout}"
  local expect_sha="${4:-}" expect_ref="${5:-}"
  local ref sha dirty untracked

  ref="$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  sha="$(git -C "$dir" rev-parse HEAD 2>/dev/null || echo '?')"
  # TRACKED modifications are the hard blocker: they change what cargo compiles,
  # so the artifact describes code that exists at no commit. UNTRACKED files are
  # only warned about — a stray scratch/.bak file next to the source is not a
  # reason to refuse a run, and hard-failing on it would just teach people to
  # set E2E_ALLOW_DIRTY=1 permanently, disarming the check that matters.
  # (Residual risk, accepted and stated: an untracked *.rs dropped into src/ or
  # tests/ WOULD be compiled. The warning below is what surfaces that.)
  dirty="$(git -C "$dir" status --porcelain --untracked-files=no 2>/dev/null)"
  untracked="$(git -C "$dir" ls-files --others --exclude-standard 2>/dev/null)"

  if [ "$sha" = "?" ]; then
    adapter_die "$artifact" 2 \
      "ADAPTER PRECONDITION FAILED: '$dir' is not a git checkout -- the revision under test cannot be established." \
      "  A run that cannot name what it tested is not evidence."
  fi

  if [ -n "$expect_sha" ] && [ "${sha#"$expect_sha"}" = "$sha" ]; then
    adapter_die "$artifact" 2 \
      "ADAPTER PRECONDITION FAILED: $label revision mismatch." \
      "  expected sha prefix : $expect_sha" \
      "  actual HEAD         : $sha ($ref)" \
      "  Refusing to run: this would test code other than the code under test."
  fi
  if [ -n "$expect_ref" ] && [ "$ref" != "$expect_ref" ]; then
    adapter_die "$artifact" 2 \
      "ADAPTER PRECONDITION FAILED: $label branch mismatch." \
      "  expected ref : $expect_ref" \
      "  actual ref   : $ref ($sha)" \
      "  Refusing to run: this would test a different branch than the one under test."
  fi

  if [ -n "$dirty" ]; then
    if [ "${E2E_ALLOW_DIRTY:-0}" = "1" ]; then
      adapter_say "$artifact" \
        "WARNING: $label is DIRTY at $ref @ ${sha:0:12} (E2E_ALLOW_DIRTY=1)." \
        "  This artifact does NOT correspond to any commit and cannot be reproduced."
    elif [ "${E2E_STRICT_SKIPS:-1}" = "1" ]; then
      adapter_die "$artifact" 2 \
        "ADAPTER PRECONDITION FAILED: $label is DIRTY at $ref @ ${sha:0:12}." \
        "  An artifact produced from uncommitted work names no revision and cannot be" \
        "  reproduced or audited. Commit the work, or set E2E_ALLOW_DIRTY=1 to record" \
        "  an explicitly non-reproducible run." \
        "  Uncommitted paths:" \
        "$(printf '%s\n' "$dirty" | sed 's/^/    /')"
    else
      adapter_say "$artifact" "WARNING: $label is DIRTY at $ref @ ${sha:0:12} -- artifact is not reproducible."
    fi
  fi

  if [ -n "$untracked" ]; then
    adapter_say "$artifact" \
      "WARNING: $label has untracked files (not blocking, but they are not in any commit):" \
      "$(printf '%s\n' "$untracked" | sed 's/^/    /')"
  fi

  adapter_say "$artifact" "adapter: $label revision asserted -- $ref @ ${sha:0:12}$([ -n "$dirty" ] && echo ' (dirty)')"
}

# -----------------------------------------------------------------------------
# report_skip_markers <artifact> <cargo_output_file>
#
# The Rust integration tests contain in-test skip guards that early-`return`
# instead of asserting. A test that returns without panicking is reported by
# cargo as `ok` — a green PASS that asserted nothing. The guards are runtime
# reachability checks (mostly "Synapse introspection returned 503"), so they can
# fire on a healthy-looking run and quietly hollow it out.
#
# The harness cannot fix a guard inside another repo's test, but it MUST NOT let
# one pass unremarked. This surfaces every skip marker found in the run output
# into the artifact, so a "pass" that silently skipped is visible on inspection.
#
# STRICT IS NOW THE DEFAULT (changed 2026-08-30). It previously defaulted to 0
# and was set NOWHERE -- not in run.sh, not in CI -- so the guard existed but
# was never once armed. "A call for a human" had become "a call nobody makes",
# which is indistinguishable from not having the check at all.
#
#   E2E_STRICT_SKIPS unset or 1 -> a detected in-test skip FAILS the check (rc 4)
#   E2E_STRICT_SKIPS=0          -> skips are reported but tolerated (explicit opt-out)
#
# Turning this on is EXPECTED to make some currently-"green" checks go red. That
# is the correct outcome: those checks were passing without exercising the
# behaviour they claim to cover. Diagnose a newly-red check; do not silence it
# by setting E2E_STRICT_SKIPS=0.
# -----------------------------------------------------------------------------
report_skip_markers() {
  local artifact="$1" out="$2" rc="$3"
  local hits n

  hits="$(grep -nEi 'E2E_SKIP|skipping|skipped due to|introspection unavailable' "$out" 2>/dev/null || true)"
  n="$(printf '%s' "$hits" | grep -c . || true)"

  if [ "${n:-0}" -gt 0 ]; then
    {
      echo "----- IN-TEST SKIP MARKERS DETECTED ($n) -----"
      echo "These tests early-returned past assertions. cargo reports them as 'ok'."
      echo "A pass below is therefore PARTIAL — treat it as degraded, not green:"
      printf '%s\n' "$hits"
      echo "----------------------------------------------"
    } | tee -a "$artifact" >&2
    if [ "${E2E_STRICT_SKIPS:-1}" = "1" ] && [ "$rc" -eq 0 ]; then
      adapter_say "$artifact" \
        "E2E_STRICT_SKIPS=1 (default) — treating in-test skip as failure (rc 4)." \
        "  This check did not exercise what it claims to cover. Fix the underlying" \
        "  condition; setting E2E_STRICT_SKIPS=0 only hides it again."
      return 4
    fi
  fi
  return "$rc"
}
