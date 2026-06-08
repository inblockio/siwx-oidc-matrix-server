#!/bin/bash
set -uo pipefail

# verify-theme.sh -- static guard for the Element custom-theme discipline.
#
# No network, no running instance: it checks the repo's source files, so it is
# safe to run in CI and locally before any deploy. It encodes the invariants in
# docs/element-theme-customization.md so a future edit (or an Element version
# bump that tempts someone back into per-token pinning) cannot silently regress
# the online presence dot or the success/critical semantics.
#
# Checks:
#   1. config/element-config.json is valid JSON (a parse error blanks Element).
#   2. The inblock.io themes never override the PROTECTED tokens that keep the
#      online dot + success green by Compound default
#      (icon-accent-primary, any *success* token, any green-* scale token).
#      Nord is exempt by design: it authors its own semantic palette and is the
#      green-accent control case that never showed the orange bug.
#   3. config/element-theme-overrides.css carries the rules it must and none it
#      must not (inspecting CSS RULES, with comments stripped, not prose):
#        - settings-tab-label rule                   PRESENT
#        - .mx_PresenceIconView_online rule           ABSENT  (member-list dot is
#            green by construction via icon-accent-primary; never re-pin it)
#        - .mx_WithPresenceIndicator_icon_online rule PRESENT (room-header dot fix:
#            it is colored by compiled $accent -> text-action-accent, brand orange
#            on custom themes, so it must be repainted green here)
#        - .mx_UserInfo_profile_mxid wrap rule        PRESENT (long DID MXID must
#            wrap inside the profile panel)
#
# Usage:
#   ./verify-theme.sh              # verify the repo
#   ./verify-theme.sh --self-test  # prove the guard FAILS on a bad theme (H5)

ROOT="$(cd "$(dirname "$0")" && pwd)"
CONFIG="${ROOT}/config/element-config.json"
OVERRIDES="${ROOT}/config/element-theme-overrides.css"

# Token-name fragments that must never be painted in the inblock.io themes.
PROTECTED='icon-accent-primary|success|green-'

PASS=0
FAIL=0
pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }

# Strip /* ... */ comments (including multi-line) so the override-CSS checks
# inspect actual CSS rules, not class names that merely appear in comment prose.
# `incmt` is an awk state flag that persists across input lines.
strip_css_comments() {
  awk '{
    s=$0; out=""; i=1; n=length(s)
    while (i<=n) {
      two=substr(s,i,2)
      if (incmt) { if (two=="*/"){incmt=0;i+=2} else {i++} }
      else { if (two=="/*"){incmt=1;i+=2} else {out=out substr(s,i,1);i++} }
    }
    print out
  }' "$1"
}

# Emit the offending protected keys found in inblock.io themes of a config file.
# Empty output == clean.
protected_offenders() {
  jq -r '.setting_defaults.custom_themes[]
           | select(.name | test("^inblock"; "i"))
           | (.compound // {}) | keys[]' "$1" 2>/dev/null \
    | grep -iE "$PROTECTED" || true
}

self_test() {
  echo "=== verify-theme.sh self-test (expect the guard to catch a bad theme) ==="
  local tmp; tmp="$(mktemp)"
  cat > "$tmp" <<'JSON'
{ "setting_defaults": { "custom_themes": [
  { "name": "inblock.io Dark", "compound": { "--cpd-color-icon-success-primary": "#E8611A" } }
] } }
JSON
  local off; off="$(protected_offenders "$tmp")"
  rm -f "$tmp"
  if [ -n "$off" ]; then
    echo "  PASS: guard flags a painted success token ($off)"
    echo "=== self-test OK ==="
    exit 0
  fi
  echo "  FAIL: guard did NOT flag a painted success token"
  echo "=== self-test BROKEN ==="
  exit 1
}

[ "${1:-}" = "--self-test" ] && self_test

if ! command -v jq >/dev/null 2>&1; then
  echo "verify-theme.sh requires jq" >&2
  exit 2
fi

echo "=== verify-theme.sh: Element custom-theme integrity ==="

# -- 1. JSON validity ---------------------------------------------------------
if jq -e . "$CONFIG" >/dev/null 2>&1; then
  pass "element-config.json is valid JSON"
else
  fail "element-config.json is NOT valid JSON (would blank all of Element)"
fi

# -- 2. Protected-token discipline (inblock.io themes) ------------------------
OFFENDERS="$(protected_offenders "$CONFIG")"
if [ -z "$OFFENDERS" ]; then
  pass "inblock.io themes paint no protected token (dot + success stay Compound green)"
else
  fail "inblock.io themes override protected tokens (re-introduces the phantom-fix trap):"
  echo "$OFFENDERS" | sed 's/^/        /'
fi

# -- 3. Override CSS scope (inspect rules, not comments) ----------------------
RULES="$(strip_css_comments "$OVERRIDES")"

if echo "$RULES" | grep -q "mx_TabbedView_tabLabel_active"; then
  pass "override CSS keeps the settings-tab-label rule"
else
  fail "override CSS lost the settings-tab-label rule"
fi

# Member-list dot (PresenceIconView) is green by construction (icon-accent-primary);
# re-pinning it is the redundant phantom-fix trap. It must NOT reappear as a rule.
if echo "$RULES" | grep -q "mx_PresenceIconView_online"; then
  fail "override CSS re-introduced the redundant member-list presence-dot rule"
else
  pass "override CSS has no member-list presence-dot rule (green by construction)"
fi

# Room-header dot (WithPresenceIndicator) is colored by compiled \$accent ->
# text-action-accent (brand orange) on custom themes; it MUST be repainted green.
if echo "$RULES" | grep -q "mx_WithPresenceIndicator_icon_online"; then
  pass "override CSS carries the room-header online-dot rule (forces green)"
else
  fail "override CSS lost the room-header online-dot rule (header dot would go orange)"
fi

# Long DID MXIDs must wrap inside the profile panel.
if echo "$RULES" | grep -q "mx_UserInfo_profile_mxid"; then
  pass "override CSS carries the profile-MXID wrap rule"
else
  fail "override CSS lost the profile-MXID wrap rule (long MXID would overflow)"
fi

echo ""
echo "=== verify-theme: ${PASS} passed, ${FAIL} failed ==="
[ "$FAIL" -gt 0 ] && exit 1
echo "All theme checks passed."
