#!/bin/sh
# check-alpine-licenses.sh: keeps the license texts an Alpine-based image ships
# in step with the packages it installs. Runs in the FINAL stage of
# dockerfiles/Dockerfile.element and dockerfiles/Dockerfile.caddy-l4, after
# their `alpine_licenses` texts and NOTICE are copied in, and fails the build
# when any of these is false:
#
#   1. Every license a package declares (the L: lines of
#      /lib/apk/db/installed, SPDX expressions) has its text in
#      /usr/share/licenses/alpine/<id>.txt. Two declared values are not SPDX
#      identifiers and are handled by name below.
#   2. Every text in /usr/share/licenses/alpine/ is declared by some package,
#      so a base bump that drops a license also drops its text.
#   3. NOTICE names this Alpine release and its aports source.
#
# The fix for a failure is always in the Dockerfile's `alpine_licenses` stage
# (add or remove an ADD line; the texts come from SPDX license-list-data at a
# pinned tag, each checked against its SHA-256) and, for 3, in NOTICE.
#
# POSIX sh and busybox awk only: it runs inside the image being built.
set -eu

db=/lib/apk/db/installed
dir=/usr/share/licenses/alpine
notice=/usr/share/licenses/siwx-oidc-matrix-server/NOTICE

# Split each value on the SPDX operators rather than on spaces, so that a
# free-text value such as "2-clause BSD-like license" stays one token.
ids=$(awk '/^L:/ {
        v = substr($0, 3)
        gsub(/[()]/, " ", v)
        n = split(v, t, / +(AND|OR|WITH) +/)
        for (i = 1; i <= n; i++) {
            gsub(/^ +| +$/, "", t[i])
            if (t[i] != "") print t[i]
        }
    }' "$db" | sort -u)

problems=""
needed=""
while IFS= read -r id; do
    [ -n "$id" ] || continue
    case "$id" in
        # tzdata and mailcap declare themselves public domain: there is no
        # license text to ship.
        "Public-Domain" | "Public Domain")
            continue
            ;;
        # nginx.org's own nginx package (not an aports package) declares this
        # and ships its license text itself.
        "2-clause BSD-like license")
            [ -f /usr/share/licenses/nginx/COPYRIGHT ] ||
                problems="$problems
  $id: /usr/share/licenses/nginx/COPYRIGHT is missing"
            continue
            ;;
    esac
    needed="$needed $id.txt"
    [ -f "$dir/$id.txt" ] ||
        problems="$problems
  $id: no $dir/$id.txt"
done <<EOF
$ids
EOF

for f in "$dir"/*.txt; do
    [ -e "$f" ] || continue
    case " $needed " in
        *" ${f##*/} "*) ;;
        *) problems="$problems
  ${f##*/}: shipped, but no installed package declares it" ;;
    esac
done

rel=$(cat /etc/alpine-release)
for s in "Alpine Linux $rel" "aports/-/tree/v$rel"; do
    grep -qF "$s" "$notice" ||
        problems="$problems
  NOTICE does not name '$s'"
done

if [ -n "$problems" ]; then
    echo "Alpine $rel: license texts and installed packages disagree:$problems" >&2
    echo "Fix the alpine_licenses stage of this Dockerfile, and NOTICE." >&2
    exit 1
fi
echo "Alpine $rel: one license text per declared license:$needed"
