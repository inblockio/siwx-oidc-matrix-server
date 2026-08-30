#!/usr/bin/env bash
# =============================================================================
# adapters/_common.sh — shared resolution + honesty guards for the cargo-backed
# adapters (siwx-oidc-realstack.sh, device-code.sh).
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
# TWO HONESTY GUARDS PROVIDED HERE
#   1. resolve_siwx_oidc_dir — locates the checkout by REPO-RELATIVE path (no
#      hardcoded $HOME), and validates it far enough to prove the requested test
#      target actually exists. Every failure is written to the ARTIFACT as well
#      as stderr, so a check that could not run never leaves a zero-byte file.
#   2. assert_tests_actually_ran — `cargo test` exits 0 when a name filter
#      matches NOTHING ("0 passed; ...; N filtered out"). Without this guard a
#      renamed or mistyped test fn is reported by run.sh as a PASS while
#      asserting nothing. Exit code 3 distinguishes "ran but judged nothing"
#      from a real test failure.
#
# EXIT CODE CONTRACT (consumed by run.sh):
#   2 = harness could not run the check (precondition/environment)
#   3 = the check ran but judged nothing (zero tests matched the filter)
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
  adapter_say "$artifact" "adapter: $ran test(s) actually ran (cargo rc=$rc)"
  return "$rc"
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
# Non-fatal by default: turning these into failures changes the pass/fail
# semantics of checks that are currently green, which is a call for a human.
# Set E2E_STRICT_SKIPS=1 to make a detected in-test skip fail the check (rc 4).
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
    if [ "${E2E_STRICT_SKIPS:-0}" = "1" ] && [ "$rc" -eq 0 ]; then
      adapter_say "$artifact" "E2E_STRICT_SKIPS=1 — treating in-test skip as failure."
      return 4
    fi
  fi
  return "$rc"
}
