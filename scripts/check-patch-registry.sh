#!/usr/bin/env bash
# check-patch-registry.sh — keep the vendored-patch registries honest.
#
# For every patches/<dir>/ this proves that ONE ordered list of patches is the
# same in four places:
#
#   1. on disk       patches/<dir>/*.patch
#   2. the registry  the numbered entry headings of patches/<dir>/README.md
#                    (`## 1. \`name.patch\` — ...`), numbered 1..N
#   3. the build     the Dockerfile that owns <dir> (OWNER below) COPYs each
#                    patch and a later RUN applies the copy (`git apply` or
#                    `patch -...`). A glob or directory COPY counts for every
#                    file it matches, in the shell's sorted glob order.
#   4. the README    the `(patches/<dir>/name.patch)` links in the root
#                    README's "Upstream deviations" lists
#
# and that 2 and 4 follow the order of 3. Both documents claim Dockerfile
# order, and it is load-bearing: several Element patches only apply on top of
# an earlier one.
#
# Where a directory is listed in NEEDS_MARKERS (Element Web), it also proves that
# patches/<dir>/markers.tsv, the served-artifact markers the build and
# scripts/element-patch-markers.sh check, is well formed, has at least one row for
# every numbered registry entry and none for an entry that does not exist, and that
# the owning Dockerfile still reads it.
#
# WHY. The registries are markdown that nothing builds. The only check was a
# loop in the README that grepped each file name anywhere in the text, so a
# patch named once in prose passed, and nothing noticed a registry entry whose
# file was gone or a patch the Dockerfile never applied.
#
# Hermetic: reads the working tree only (no network, no container runtime),
# so CI runs it on every pull request (.github/workflows/checks.yml).
#
# Usage: scripts/check-patch-registry.sh    (exit 0 consistent, 1 not)
set -euo pipefail
export LC_ALL=C

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# The Dockerfile that applies each patches/<dir>/. A new patch directory must be
# added here, or the check fails: a patch no build applies is not a deviation
# anyone ships, it is dead text.
declare -A OWNER=(
  [synapse]=dockerfiles/Dockerfile
  [element-web]=dockerfiles/Dockerfile.element
)

# Directories whose patches must be provable in the built artifact: each needs a
# patches/<dir>/markers.tsv with a row for every numbered registry entry.
declare -A NEEDS_MARKERS=(
  [element-web]=1
)

FAILS=0
fail() { printf 'FAIL  %s\n' "$*"; FAILS=$((FAILS + 1)); }

# Dockerfile instructions, one per line: comment lines dropped, backslash
# continuations joined.
instructions() {
  awk '
    /^[ \t]*#/ { next }
    {
      line = $0
      if (line ~ /\\[ \t]*$/) { sub(/\\[ \t]*$/, "", line); buf = buf line " "; next }
      print buf line; buf = ""
    }
    END { if (buf != "") print buf }' "$1"
}

# Prints "A <name>" for every patches/<dir>/ patch the Dockerfile applies, in
# apply order, and "P <message>" for anything it COPYs but never applies.
applied_patches() {
  local d="$1" df="$2" line kw t i n src dest pat tok hit
  local -a toks args pend_kind=() pend_dest=() pend_files=()
  local glob_re='[][*?]'
  while IFS= read -r line; do
    read -r -a toks <<<"$line" || true
    [ "${#toks[@]}" -gt 0 ] || continue
    kw="${toks[0]^^}"
    case "$kw" in
      COPY|ADD)
        args=()
        for t in "${toks[@]:1}"; do [[ $t == --* ]] || args+=("$t"); done
        n=${#args[@]}
        [ "$n" -ge 2 ] || continue
        if [[ ${args[0]} == \[* ]]; then
          [[ $line == *patches/"$d"* ]] && echo "P $df: JSON-form $kw of patches/$d/ is not parsed by this check: $line"
          continue
        fi
        dest="${args[n - 1]}"
        for ((i = 0; i < n - 1; i++)); do
          src="${args[i]#./}"
          if [[ $src == patches/"$d" || $src == patches/"$d"/ || ($src == patches/"$d"/* && $src =~ $glob_re) ]]; then
            pat="$src"
            [[ $pat == patches/"$d" || $pat == patches/"$d"/ ]] && pat="patches/$d/*.patch"
            pend_kind+=(dir)
            pend_dest+=("${dest%/}")
            pend_files+=("$(compgen -G "$pat" | grep '\.patch$' | sort | xargs -r -n1 basename | tr '\n' ' ' || true)")
          elif [[ $src == patches/"$d"/*.patch ]]; then
            pend_kind+=(file)
            if [[ $dest == */ ]]; then pend_dest+=("$dest${src##*/}"); else pend_dest+=("$dest"); fi
            pend_files+=("${src##*/}")
          fi
        done
        ;;
      RUN)
        [[ $line =~ git[[:space:]]+apply || $line =~ (^|[^[:alnum:]_.-])patch[[:space:]]+- ]] || continue
        for i in "${!pend_dest[@]}"; do
          [ -n "${pend_dest[i]}" ] || continue
          hit=0
          while IFS= read -r tok; do
            if [ "${pend_kind[i]}" = file ]; then
              [ "$tok" = "${pend_dest[i]}" ] && hit=1
            else
              [[ $tok == "${pend_dest[i]}" || $tok == "${pend_dest[i]}"/* ]] && hit=1
            fi
          done < <(tr -s " \t;&|<>()\"'=" '\n' <<<"$line")
          [ "$hit" = 1 ] || continue
          for t in ${pend_files[i]}; do echo "A $t"; done
          pend_dest[i]=""
        done
        ;;
    esac
  done < <(instructions "$df")
  for i in "${!pend_dest[@]}"; do
    [ -z "${pend_dest[i]}" ] || echo "P $df: COPYs ${pend_files[i]% } to ${pend_dest[i]}, but no later RUN applies it"
  done
}

# "<number> <file>" per numbered registry entry heading, in document order.
registry_entries() {
  awk '
    match($0, /^##+[ \t]+[0-9]+\.[ \t]+`[^`]+\.patch`/) {
      h = substr($0, RSTART, RLENGTH)
      num = h; sub(/^#+[ \t]+/, "", num); sub(/\..*$/, "", num)
      f = h; sub(/^[^`]*`/, "", f); sub(/`$/, "", f)
      print num, f
    }' "$1"
}

# One line per row of a markers file: the entry number, or "!<message>" for a row that
# is not entry<TAB>path<TAB>string with a supported served path. Comment (#) and blank
# lines are skipped. Keep the path grammar in step with scripts/element-patch-markers.sh.
marker_rows() {
  awk -F'\t' '
    /^[ \t]*$/ || /^#/ { next }
    NF != 3 { printf "!line %d: want entry<TAB>path<TAB>string, found %d field(s)\n", NR, NF; next }
    $1 !~ /^[0-9]+$/ { printf "!line %d: entry \"%s\" is not a number\n", NR, $1; next }
    $2 !~ /^(index\.html|sw\.js|sw-boot\.js|bundles\/\*\/[A-Za-z0-9_.-]+|i18n\/[A-Za-z0-9_-]+\.json)$/ {
      printf "!line %d: unsupported served path \"%s\"\n", NR, $2; next }
    $3 == "" { printf "!line %d: empty marker string\n", NR; next }
    { print $1 + 0 }' "$1"
}

# Patch files the root README links to under patches/<dir>/, first mention wins.
readme_links() {
  grep -oE "\(patches/$1/[^)/]+\.patch\)" README.md | sed -E 's#^\(patches/[^/]+/##; s#\)$##' | awk '!seen[$0]++' || true
}

# Set difference: lines of $1 not in $2 (both newline-separated).
minus() { comm -23 <(printf '%s\n' "$1" | sed '/^$/d' | sort -u) <(printf '%s\n' "$2" | sed '/^$/d' | sort -u); }

[ -f README.md ] || { fail "README.md not found at the repository root"; exit 1; }

for d in "${!OWNER[@]}"; do
  [ -d "patches/$d" ] || fail "OWNER maps patches/$d/, which does not exist; drop the stale entry"
done

for dir in patches/*/; do
  d="$(basename "$dir")"
  before=$FAILS
  disk="$(find "patches/$d" -maxdepth 1 -type f -name '*.patch' -printf '%f\n' | sort)"
  registry_md="patches/$d/README.md"
  df="${OWNER[$d]:-}"

  if [ -z "$df" ]; then
    [ -z "$disk" ] || fail "patches/$d/ holds patches but has no owning Dockerfile in OWNER ($0)"
    continue
  fi
  [ -f "$df" ] || { fail "patches/$d/: owning Dockerfile $df does not exist"; continue; }
  [ -f "$registry_md" ] || { fail "patches/$d/: registry $registry_md does not exist"; continue; }

  entries="$(registry_entries "$registry_md")"
  reg="$(awk '{ print $2 }' <<<"$entries" | sed '/^$/d')"
  raw="$(applied_patches "$d" "$df")"
  applied="$(sed -n 's/^A //p' <<<"$raw")"
  while IFS= read -r msg; do [ -z "$msg" ] || fail "$msg"; done < <(sed -n 's/^P //p' <<<"$raw")
  linked="$(readme_links "$d")"

  # 1-2: disk <-> registry
  while IFS= read -r f; do [ -z "$f" ] || fail "patches/$d/$f has no numbered entry in $registry_md"; done < <(minus "$disk" "$reg")
  while IFS= read -r f; do [ -z "$f" ] || fail "$registry_md has an entry for $f, but patches/$d/$f does not exist"; done < <(minus "$reg" "$disk")
  while IFS= read -r f; do [ -z "$f" ] || fail "$registry_md has more than one entry for $f"; done < <(sed '/^$/d' <<<"$reg" | sort | uniq -d)
  want=1
  while read -r num f; do
    [ -n "${num:-}" ] || continue
    [ "$num" = "$want" ] || fail "$registry_md: entry for $f is numbered $num, expected $want (entries must run 1..N in order)"
    want=$((want + 1))
  done <<<"$entries"

  # 3: disk <-> Dockerfile
  while IFS= read -r f; do [ -z "$f" ] || fail "patches/$d/$f is not applied by $df"; done < <(minus "$disk" "$applied")
  while IFS= read -r f; do [ -z "$f" ] || fail "$df applies patches/$d/$f, which does not exist"; done < <(minus "$applied" "$disk")
  while IFS= read -r f; do [ -z "$f" ] || fail "$df applies patches/$d/$f more than once"; done < <(sed '/^$/d' <<<"$applied" | sort | uniq -d)

  # 4: disk <-> README
  while IFS= read -r f; do [ -z "$f" ] || fail "patches/$d/$f is not listed in README.md (Upstream deviations)"; done < <(minus "$disk" "$linked")
  while IFS= read -r f; do [ -z "$f" ] || fail "README.md links patches/$d/$f, which does not exist"; done < <(minus "$linked" "$disk")

  # 5: registry <-> markers (served-artifact markers; spec layer L2)
  markers_note=""
  mf="patches/$d/markers.tsv"
  if [ -f "$mf" ] || [ -n "${NEEDS_MARKERS[$d]:-}" ]; then
    if [ ! -f "$mf" ]; then
      fail "$mf does not exist; every numbered entry in $registry_md needs a marker row"
    else
      mrows="$(marker_rows "$mf")"
      while IFS= read -r msg; do [ -z "$msg" ] || fail "$mf: ${msg#!}"; done < <(sed -n 's/^!//p' <<<"$mrows")
      m_entries="$(grep -v '^!' <<<"$mrows" | sed '/^$/d' | sort -u || true)"
      r_entries="$(awk '{ print $1 + 0 }' <<<"$entries" | sed '/^$/d' | sort -u)"
      while read -r num f; do
        [ -n "${num:-}" ] || continue
        grep -qx "$((10#$num))" <<<"$m_entries" || fail "$mf has no row for entry $num ($f); a patch with no marker cannot be proved present in the artifact"
      done <<<"$entries"
      while IFS= read -r n; do
        [ -z "$n" ] || fail "$mf has a row for entry $n, which has no numbered entry in $registry_md"
      done < <(minus "$m_entries" "$r_entries")
      if [ -n "${NEEDS_MARKERS[$d]:-}" ]; then
        # Into a variable first: `instructions | grep -q` can die of SIGPIPE under pipefail.
        df_text="$(instructions "$df")"
        grep -qF "$mf" <<<"$df_text" || fail "$df never reads $mf, so the build would not fail when a patch's marker is missing"
      fi
      markers_note=", $(grep -vc '^!' <<<"$mrows" || true) marker row(s) cover every entry"
    fi
  fi

  # Order, once the sets agree (a set mismatch above already says what is wrong).
  if [ "$FAILS" -eq "$before" ]; then
    [ "$reg" = "$applied" ] || fail "$registry_md lists its entries in a different order than $df applies them:
      registry:   $(tr '\n' ' ' <<<"$reg")
      Dockerfile: $(tr '\n' ' ' <<<"$applied")"
    [ "$linked" = "$applied" ] || fail "README.md lists patches/$d/ in a different order than $df applies them:
      README:     $(tr '\n' ' ' <<<"$linked")
      Dockerfile: $(tr '\n' ' ' <<<"$applied")"
  fi

  if [ "$FAILS" -eq "$before" ]; then
    printf 'OK    patches/%s/: %d patch(es) registered, applied by %s and listed in README.md, in one order%s\n' \
      "$d" "$(sed '/^$/d' <<<"$disk" | wc -l)" "$df" "$markers_note"
  fi
done

if [ "$FAILS" -gt 0 ]; then
  printf '\n%d problem(s). Every patch needs a numbered registry entry, an apply step in its Dockerfile and a README line, in Dockerfile order; every Element Web entry also needs a row in markers.tsv.\n' "$FAILS"
  exit 1
fi
