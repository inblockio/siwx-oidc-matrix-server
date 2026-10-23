#!/usr/bin/env bash
#
# run-tests.sh: run the inblock_directory module tests (docs/directory-search.md) in
# Synapse's own test framework, at the Synapse tag the Dockerfile pins.
#
# WHY. The module calls a few Synapse internals (listed at the top of
# inblock_directory/module.py). They can change in any release, so these tests are a
# step of the Synapse bump procedure (patches/synapse/README.md, rule 4, risk R1): a
# bump is not merged while they are red.
#
# HOW. Clones element-hq/synapse at the tag (shallow), makes a venv, installs Synapse
# with its test extras, and runs the tests with `trial` from the checkout, with
# synapse-modules/ on PYTHONPATH. Nothing is installed into the system Python and
# nothing is copied into the checkout. The first run builds Synapse's Rust extension
# (a minute or two); later runs reuse the venv.
#
# Usage:
#   synapse-modules/run-tests.sh                  # all tests
#   synapse-modules/run-tests.sh inblock_directory_tests.test_directory_module.DirectoryModuleTestCase.test_term_bounds
#                                                 # arguments replace the default target and go to trial
#   SYNAPSE_TAG=v1.164.0 synapse-modules/run-tests.sh   # a tag other than the Dockerfile's
#
# Needs: git, network on the first run, a Rust toolchain (cargo) for the extension, and
# either `uv` (preferred) or python3.13 with venv. The image runs Python 3.13.
# Env:
#   SYNAPSE_TAG                tag to test against (default: the FROM line of dockerfiles/Dockerfile)
#   SIWX_DIRECTORY_TESTS_DIR   where the checkout, venv and trial output live, on disk and
#                              never tmpfs (default ~/.cache)
#
# Exit code: trial's.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "${1:-}" in
  -h|--help) sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

TAG="${SYNAPSE_TAG:-$(sed -n 's#^FROM matrixdotorg/synapse:\(v[0-9][0-9.]*\)@.*#\1#p' "${REPO_ROOT}/dockerfiles/Dockerfile" | head -n1)}"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "cannot determine the Synapse tag (got '${TAG}')" >&2; exit 2; }

BASE="${SIWX_DIRECTORY_TESTS_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}}"
SRC="${BASE}/synapse-${TAG}"
VENV="${BASE}/synapse-${TAG}-venv"
STAMP="${VENV}/.inblock-directory-tests-installed"
TRIAL_TMP="${BASE}/synapse-${TAG}-trial-temp"

case "$BASE" in /tmp|/tmp/*) echo "refusing to build under /tmp (RAM-backed): set SIWX_DIRECTORY_TESTS_DIR" >&2; exit 2 ;; esac

if [ ! -d "${SRC}/.git" ]; then
  mkdir -p "$BASE"
  git clone -q --depth 1 --branch "$TAG" https://github.com/element-hq/synapse "$SRC"
fi
[ "$(git -C "$SRC" describe --tags --exact-match 2>/dev/null)" = "$TAG" ] \
  || { echo "${SRC} is not a checkout of ${TAG}" >&2; exit 2; }

if [ ! -f "$STAMP" ]; then
  if command -v uv >/dev/null; then
    uv venv --clear --python 3.13 "$VENV"
    VIRTUAL_ENV="$VENV" uv pip install -e "${SRC}[test]"
  else
    command -v python3.13 >/dev/null || { echo "need uv or python3.13" >&2; exit 2; }
    python3.13 -m venv "$VENV"
    "${VENV}/bin/pip" install -e "${SRC}[test]"
  fi
  touch "$STAMP"
fi

# trial runs from the checkout so that Synapse's `tests` package (the framework) imports.
cd "$SRC"
[ "$#" -gt 0 ] || set -- inblock_directory_tests
PYTHONPATH="${REPO_ROOT}/synapse-modules${PYTHONPATH:+:${PYTHONPATH}}" \
  exec "${VENV}/bin/python" -m twisted.trial --temp-directory "$TRIAL_TMP" \
  "$@"
