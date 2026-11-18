#!/usr/bin/env bash
# Builds the Rocket.Chat view into <out-dir> (default ./dist), served at /kits/rocketchat/.
# Webpack stats (for tools/boundary-check.sh and tools/licence-check.mjs) always land in ./dist/stats.json.
# Usage: kits/rocketchat/build.sh [out-dir]
set -uo pipefail
C=~/.cache/element-views-track
here=$(cd "$(dirname "$0")" && pwd)
out=$(realpath -m "${1:-$here/dist}")
stats=$here/dist/stats.json
mkdir -p "$C/logs" "$here/dist"
~/bin/resource-guard.sh verdict | grep -q '^RED' && { echo "resource RED, not building"; exit 2; }
cd "$here"
KIT_OUT=$out KIT_PUBLIC_PATH=${KIT_PUBLIC_PATH:-/kits/rocketchat/} /usr/bin/time -v -o "$C/logs/kit-rocketchat-webpack.time" \
	flock "$C/heavy.lock" "$C/rocket.chat/node_modules/.bin/webpack" --config webpack.config.js --json="$stats.tmp" \
	> "$C/logs/kit-rocketchat-webpack.log" 2>&1
rc=$?
mv -f "$stats.tmp" "$stats" 2>/dev/null
# REQ-0008 V3: both notices travel with the build.
[ $rc -eq 0 ] && { cp "$here/NOTICE" "$out/NOTICE" && cp "$C/rocket.chat/LICENSE" "$out/LICENSE.rocketchat.txt" || rc=1; }
grep -E 'Elapsed|Maximum resident' "$C/logs/kit-rocketchat-webpack.time"
node --input-type=module - "$stats" "$(realpath "$here/../../tools/lib/stats-modules.mjs")" <<'JS'
const [stats, lib] = process.argv.slice(2);
const { modulePaths } = await import(lib);
const { readFileSync } = await import('node:fs');
const d = JSON.parse(readFileSync(stats, 'utf8'));
const mods = modulePaths(stats);
const count = (re) => mods.filter((m) => re.test(m)).length;
console.log('stats', stats);
console.log('errors', (d.errors ?? []).length, 'warnings', (d.warnings ?? []).length, 'modules', mods.length,
	'ee', count(/\/ee\//), 'matrix-js-sdk', count(/matrix-js-sdk/));
for (const e of (d.errors ?? []).slice(0, 15)) console.log('-', (e.moduleName ?? '').slice(-80), '|', e.message.slice(0, 260).replace(/\n/g, ' '));
JS
exit $rc
