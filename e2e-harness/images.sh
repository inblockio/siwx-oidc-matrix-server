#!/usr/bin/env bash
# =============================================================================
# images.sh — the ONE place the harness decides which siwx-oidc and Synapse
# images it runs, and builds them when they are missing.
#
# Sourced by up.sh and run.sh (and scripts/did-field-guard-accept.sh), and also
# runnable on its own:
#
#   e2e-harness/images.sh print    # show the resolved refs and whether they exist
#   e2e-harness/images.sh build    # build whichever default image is missing
#   eval "$(e2e-harness/images.sh env)"   # export the refs (for docker-compose.e2e.yml)
#   E2E_REBUILD=1 e2e-harness/images.sh build   # rebuild even if present
#
# WHY THIS EXISTS (2026-09-27). The defaults used to be hand-built, hand-named
# tags (`localhost/siwx-oidc:e2eh-5f47a9b`, `localhost/siwx-real-synapse:local`)
# hard-coded in up.sh and run.sh. Nothing in the repo could reproduce them, so
# two routine image cleanups (2026-09-12 and 2026-09-25) deleted them and the
# harness stopped starting from its defaults. Worse, `siwx-real-synapse:local`
# had quietly been re-pointed at an image built from dockerfiles/Dockerfile
# (the deployed, MSC4133-patched Synapse) even though its name says
# real-stack/Dockerfile.synapse (unpatched), so no one reading the scripts
# could have rebuilt the right thing. The defaults are now DERIVED from source
# and built on demand; a tag can be deleted at any time and comes back.
#
# DEFAULT REFS
#   siwx-oidc : localhost/siwx-oidc:e2eh-<short HEAD of the siwx-oidc checkout>
#               Built from `git archive HEAD` of that checkout (never the live
#               working tree), so the image holds exactly the commit its tag
#               names: no uncommitted edits, no untracked files, no 700 MB of
#               node_modules / nested worktrees in the build context. The
#               checkout is SIWX_OIDC_DIR > OIDC_E2EH_DIR > ../siwx-oidc, the
#               same resolution the adapters use.
#   synapse   : localhost/siwx-e2eh-synapse:<vX.Y.Z>-<inputs-sha256[:12]>
#               Built from dockerfiles/Dockerfile, the SAME Dockerfile the
#               deployed Synapse is built from (Synapse version pinned in its
#               FROM line, MSC4133 write-policy patch applied, deployed
#               entrypoint). The suffix hashes the Dockerfile plus every file it
#               COPYs, so editing the entrypoint or a patch yields a new tag and
#               a rebuild, and an unchanged tree reuses the existing image.
#               Not real-stack/Dockerfile.synapse: that one carries no MSC4133
#               patch, and the full tier's did_field checks require it.
#
# OVERRIDES (unchanged convention)
#   SIWX_OIDC_IMAGE_REF / SYNAPSE_IMAGE_REF   use this image instead. An
#       overridden ref is never built (the harness cannot know how); if it is
#       missing you get a clear error, not a podman one.
#   E2E_AUTO_BUILD=0   do not build a missing default; print the command.
#   E2E_REBUILD=1      rebuild the default images even if the tag exists.
#   E2EH_BUILD_CACHE   scratch dir for build contexts
#                      (default ~/.cache/siwx-e2eh-build; never /tmp).
# =============================================================================

_E2EH_IMAGES_SELF="${BASH_SOURCE[0]}"
E2EH_HARNESS_DIR="$(cd "$(dirname "$_E2EH_IMAGES_SELF")" && pwd)"
E2EH_REPO_ROOT="$(cd "$E2EH_HARNESS_DIR/.." && pwd)"
E2EH_SIWX_OIDC_DIR="${SIWX_OIDC_DIR:-${OIDC_E2EH_DIR:-$(cd "$E2EH_REPO_ROOT/.." && pwd)/siwx-oidc}}"
E2EH_SYNAPSE_DOCKERFILE="dockerfiles/Dockerfile"   # relative to E2EH_REPO_ROOT
E2EH_BUILD_CACHE="${E2EH_BUILD_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/siwx-e2eh-build}"

_e2eh_say() { printf '[images] %s\n' "$*" >&2; }

# Build-context inputs of the Synapse image: every COPY/ADD source in the
# Dockerfile (flags such as --chown skipped, the destination dropped).
e2eh_synapse_inputs() {
  awk '
    toupper($1) == "COPY" || toupper($1) == "ADD" {
      n = 0
      for (i = 2; i <= NF; i++) if ($i !~ /^--/) args[++n] = $i
      for (i = 1; i < n; i++) { p = args[i]; sub(/^\.\//, "", p); print p }
    }' "$E2EH_REPO_ROOT/$E2EH_SYNAPSE_DOCKERFILE"
}

e2eh_default_synapse_ref() {
  local ver hash f
  ver="$(sed -n 's#^FROM[[:space:]]\{1,\}matrixdotorg/synapse:\(v[0-9][0-9.]*\).*#\1#p' \
           "$E2EH_REPO_ROOT/$E2EH_SYNAPSE_DOCKERFILE" | head -1)"
  [ -n "$ver" ] || { _e2eh_say "cannot read the Synapse version from $E2EH_SYNAPSE_DOCKERFILE"; return 1; }
  for f in $(e2eh_synapse_inputs); do
    [ -e "$E2EH_REPO_ROOT/$f" ] || { _e2eh_say "Synapse build input '$f' (COPYed by $E2EH_SYNAPSE_DOCKERFILE) is missing"; return 1; }
  done
  hash="$(cd "$E2EH_REPO_ROOT" && { echo "$E2EH_SYNAPSE_DOCKERFILE"; e2eh_synapse_inputs; } \
          | xargs -I{} find {} -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -c1-12)"
  printf 'localhost/siwx-e2eh-synapse:%s-%s\n' "$ver" "$hash"
}

e2eh_default_oidc_ref() {
  local sha
  sha="$(git -C "$E2EH_SIWX_OIDC_DIR" rev-parse --short=7 HEAD 2>/dev/null)" || {
    _e2eh_say "siwx-oidc checkout not found (or not a git repo) at '$E2EH_SIWX_OIDC_DIR'."
    _e2eh_say "  Set SIWX_OIDC_DIR=/path/to/siwx-oidc, or SIWX_OIDC_IMAGE_REF=<existing image>."
    return 1
  }
  printf 'localhost/siwx-oidc:e2eh-%s\n' "$sha"
}

# Sets + exports SIWX_OIDC_IMAGE_REF / SYNAPSE_IMAGE_REF, and records whether
# each is the derived default (buildable) or a caller override. The flags are
# exported so a child up.sh started by run.sh still knows a ref it inherits
# through the environment is a default, not an override.
e2eh_resolve_images() {
  if [ -z "${SIWX_OIDC_IMAGE_REF:-}" ]; then
    SIWX_OIDC_IMAGE_REF="$(e2eh_default_oidc_ref)" || return 1
    E2EH_OIDC_IS_DEFAULT=1
  fi
  if [ -z "${SYNAPSE_IMAGE_REF:-}" ]; then
    SYNAPSE_IMAGE_REF="$(e2eh_default_synapse_ref)" || return 1
    E2EH_SYNAPSE_IS_DEFAULT=1
  fi
  E2EH_OIDC_IS_DEFAULT="${E2EH_OIDC_IS_DEFAULT:-0}"
  E2EH_SYNAPSE_IS_DEFAULT="${E2EH_SYNAPSE_IS_DEFAULT:-0}"
  export SIWX_OIDC_IMAGE_REF SYNAPSE_IMAGE_REF E2EH_OIDC_IS_DEFAULT E2EH_SYNAPSE_IS_DEFAULT
}

e2eh_build_oidc() {
  local ref="$1" full ctx
  full="$(git -C "$E2EH_SIWX_OIDC_DIR" rev-parse HEAD)" || return 1
  if [ -n "$(git -C "$E2EH_SIWX_OIDC_DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    _e2eh_say "NOTE: $E2EH_SIWX_OIDC_DIR has uncommitted changes. The image is built from"
    _e2eh_say "      the COMMIT ${full:0:12} only; commit first if the server change matters."
  fi
  ctx="$E2EH_BUILD_CACHE/siwx-oidc-${full:0:12}"
  rm -rf "$ctx" && mkdir -p "$ctx" || return 1
  git -C "$E2EH_SIWX_OIDC_DIR" archive --format=tar "$full" | tar -x -C "$ctx" || { rm -rf "$ctx"; return 1; }
  _e2eh_say "building $ref from siwx-oidc@${full:0:12} (Rust release build, several minutes when uncached) ..."
  podman build \
    --label "io.inblock.e2eh.source=siwx-oidc@$full" \
    -t "$ref" -f "$ctx/Dockerfile" "$ctx" >&2
  local rc=$?
  rm -rf "$ctx"
  return $rc
}

e2eh_build_synapse() {
  local ref="$1" ctx f
  ctx="$E2EH_BUILD_CACHE/synapse-${ref##*:}"
  rm -rf "$ctx" && mkdir -p "$ctx" || return 1
  # A minimal context holding exactly the Dockerfile and what it COPYs, so
  # nothing else in the repo (e.g. .env.e2e secrets, artifacts/) is sent.
  for f in "$E2EH_SYNAPSE_DOCKERFILE" $(e2eh_synapse_inputs); do
    mkdir -p "$ctx/$(dirname "$f")" && cp -a "$E2EH_REPO_ROOT/$f" "$ctx/$f" || { rm -rf "$ctx"; return 1; }
  done
  _e2eh_say "building $ref from $E2EH_SYNAPSE_DOCKERFILE ..."
  podman build \
    --label "io.inblock.e2eh.inputs=${ref##*:}" \
    -t "$ref" -f "$ctx/$E2EH_SYNAPSE_DOCKERFILE" "$ctx" >&2
  local rc=$?
  rm -rf "$ctx"
  return $rc
}

# e2eh_ensure_one <label> <ref> <is_default> <build_fn> <override_var>
e2eh_ensure_one() {
  local label="$1" ref="$2" is_default="$3" build_fn="$4" var="$5"
  if podman image exists "$ref" && { [ "${E2E_REBUILD:-0}" != "1" ] || [ "$is_default" != "1" ]; }; then
    _e2eh_say "$label: $ref (present)"
    return 0
  fi
  if [ "$is_default" != "1" ]; then
    _e2eh_say "FATAL: $label image '$ref' (from $var) does not exist locally."
    _e2eh_say "  Unset $var to use the derived default (built automatically), or build/pull that ref."
    return 1
  fi
  if [ "${E2E_AUTO_BUILD:-1}" != "1" ]; then
    _e2eh_say "FATAL: $label image '$ref' is missing and E2E_AUTO_BUILD=0. Build it with:"
    _e2eh_say "  $E2EH_HARNESS_DIR/images.sh build"
    return 1
  fi
  "$build_fn" "$ref" || { _e2eh_say "FATAL: building $ref failed (see output above)."; return 1; }
  _e2eh_say "$label: $ref (built)"
}

e2eh_ensure_images() {
  e2eh_resolve_images || return 1
  e2eh_ensure_one siwx-oidc "$SIWX_OIDC_IMAGE_REF" "$E2EH_OIDC_IS_DEFAULT" e2eh_build_oidc SIWX_OIDC_IMAGE_REF || return 1
  e2eh_ensure_one synapse   "$SYNAPSE_IMAGE_REF"   "$E2EH_SYNAPSE_IS_DEFAULT" e2eh_build_synapse SYNAPSE_IMAGE_REF || return 1
}

# Executed directly (not sourced): tiny CLI.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -uo pipefail
  case "${1:-print}" in
    print)
      e2eh_resolve_images || exit 1
      for pair in "siwx-oidc:$SIWX_OIDC_IMAGE_REF:$E2EH_OIDC_IS_DEFAULT" "synapse:$SYNAPSE_IMAGE_REF:$E2EH_SYNAPSE_IS_DEFAULT"; do
        label="${pair%%:*}"; rest="${pair#*:}"; def="${rest##*:}"; ref="${rest%:*}"
        state=missing; podman image exists "$ref" && state=present
        src=override; [ "$def" = "1" ] && src=default
        printf '%-9s %-8s %-7s %s\n' "$label" "$src" "$state" "$ref"
      done ;;
    build) e2eh_ensure_images ;;
    env)
      e2eh_resolve_images || exit 1
      printf 'export SIWX_OIDC_IMAGE_REF=%q SYNAPSE_IMAGE_REF=%q\n' "$SIWX_OIDC_IMAGE_REF" "$SYNAPSE_IMAGE_REF" ;;
    -h|--help) sed -n '2,48p' "$0" | sed 's/^# \{0,1\}//' ;;
    *) echo "usage: images.sh [print|build|env]" >&2; exit 2 ;;
  esac
fi
