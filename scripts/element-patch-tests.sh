#!/usr/bin/env bash
# element-patch-tests.sh - run the unit tests our vendored Element Web patches
# carry, on the upstream tag tree with every patch applied.
#
#   scripts/element-patch-tests.sh <tree> [--patches-dir DIR] [--known-red FILE]
#                                  [--junit DIR] [--workers N] [--retry N]
#                                  [--skip-browser] [--no-prepare] [--list]
#
#   <tree>           an element-web checkout with the patches ALREADY applied and
#                    `pnpm install --frozen-lockfile` done (dockerfiles/Dockerfile.element,
#                    target `patch-tests`, builds exactly that and runs this script).
#   --patches-dir    the *.patch files to derive the test list from
#                    (default: patches/element-web next to this script's repo root).
#   --known-red      tests that are red on the UNPATCHED upstream tree too
#                    (default: <patches-dir>/patch-tests-known-red.txt when present).
#   --junit DIR      also write DIR/element-patch-tests.xml (JUnit, both runners).
#   --workers N      runner worker count (default 2: this runs next to builds).
#   --retry N        vitest re-runs a failing test up to N more times (default 2, 0 = off).
#                    Several carried tests assert wall-clock budgets (a 64 KiB body in
#                    under 500 ms, a flush under 10 ms) that miss on a loaded host. A real
#                    regression fails every attempt; a test that passes only on a retry is
#                    listed as FLAKY and does not fail the run. jest has no CLI retry and
#                    needs none: its one carried suite asserts no timing.
#   --skip-browser   do not run a patch-added vitest browser config (needs Chromium).
#   --no-prepare     do not build the workspace packages the runners import first.
#   --list           print the derived plan (file, runner, patch) and stop.
#
# Exit: 0 every test green or listed known-red; 1 any other red, a test file no
# runner would execute, a file that ran 0 tests, or a runner that died; 2 usage
# or an unusable tree.
#
# WHAT RUNS. The files are derived from the patches' `+++ b/` paths, never listed
# by hand: every file a patch adds or modifies whose name says it is a test
# (*.test.ts(x), *-test.ts(x), *.spec.*, *.test.browser.*), except Playwright
# specs under playwright/ (those are e2e, not unit tests). Whole files run, so
# the upstream cases inside a file a patch touches run too.
#
# WHO OWNS A FILE. Asked of the runners, not guessed from the name: a file is
# vitest's when `vitest list --filesOnly --config vitest.config.ts` names it, and
# jest's when `jest --listTests` does (apps/web at this tag: vitest takes
# src/**/*.test.{ts,tsx}, jest takes test/**/*-test.*). A test file neither
# runner would execute is an ERROR, not a skip: a silently unrun test is the
# failure this harness exists to prevent. A vitest config a patch ADDS
# (apps/web/vitest*.config.ts, e.g. Copy Markdown's real-Chromium
# vitest.browser.copy-md.config.ts) is run as its own runner, with the
# `-t "<name>"` filter its header comment names.
#
# KNOWN-RED. patches/element-web/patch-tests-known-red.txt (format in its header).
# A test only goes there when it is red on the unpatched tag too. Red ONLY with
# our patches is our defect and fails this script.
#
# ONE HARNESS FIXUP. At v1.12.29 jest cannot load any suite that imports
# matrix-js-sdk: content-type@3 is ESM and missing from the config's
# transformIgnorePatterns allowlist (registry entry 8). Without a fixup the
# Spotlight cases entry 8 carries would run nowhere, so this script adds
# `content-type` to the allowlist on the command line (jest --showConfig gives the
# effective pattern; nothing in the tree is edited). It does nothing once
# upstream lists the package itself, and warns if the pattern's shape changed.
set -euo pipefail
export LC_ALL=C

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d; s/^# \{0,1\}//' >&2; exit 2; }
die() { printf 'element-patch-tests: %s\n' "$*" >&2; exit 2; }

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TREE=""
PATCHES_DIR="$REPO/patches/element-web"
KNOWN_RED=""
JUNIT=""
WORKERS=2
RETRY=2
SKIP_BROWSER=0
PREPARE=1
LIST_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --patches-dir) [ $# -ge 2 ] || usage; PATCHES_DIR="$2"; shift 2 ;;
    --known-red)   [ $# -ge 2 ] || usage; KNOWN_RED="$2"; shift 2 ;;
    --junit)       [ $# -ge 2 ] || usage; JUNIT="$2"; shift 2 ;;
    --workers)     [ $# -ge 2 ] || usage; WORKERS="$2"; shift 2 ;;
    --retry)       [ $# -ge 2 ] || usage; RETRY="$2"; shift 2 ;;
    --skip-browser) SKIP_BROWSER=1; shift ;;
    --no-prepare)  PREPARE=0; shift ;;
    --list)        LIST_ONLY=1; shift ;;
    -h|--help)     usage ;;
    -*)            die "unknown option $1" ;;
    *)             [ -z "$TREE" ] || die "more than one tree given"; TREE="$1"; shift ;;
  esac
done
[ -n "$TREE" ] || usage
[[ "$WORKERS" =~ ^[1-9][0-9]*$ ]] || die "--workers needs a positive integer"
[[ "$RETRY" =~ ^[0-9]+$ ]] || die "--retry needs a non-negative integer"
[ -d "$TREE/apps/web" ] || die "$TREE has no apps/web (not an element-web checkout)"
TREE="$(cd "$TREE" && pwd)"
WEB="$TREE/apps/web"
[ -d "$WEB/node_modules" ] || die "$WEB/node_modules is missing: run 'pnpm install --frozen-lockfile' in $TREE first"
[ -d "$PATCHES_DIR" ] || die "patches dir $PATCHES_DIR does not exist"
PATCHES_DIR="$(cd "$PATCHES_DIR" && pwd)"
if [ -z "$KNOWN_RED" ] && [ -f "$PATCHES_DIR/patch-tests-known-red.txt" ]; then
  KNOWN_RED="$PATCHES_DIR/patch-tests-known-red.txt"
fi
[ -z "$KNOWN_RED" ] || [ -f "$KNOWN_RED" ] || die "known-red file $KNOWN_RED does not exist"
[ -z "$JUNIT" ] || mkdir -p "$JUNIT"
if [ -n "$KNOWN_RED" ]; then
  awk -F'\t' -v f="$KNOWN_RED" '
    /^[[:space:]]*(#|$)/ { next }
    { bad = (NF < 6); for (i = 1; i <= 6 && !bad; i++) if ($i ~ /^[[:space:]]*$/) bad = 1
      if (bad) { printf "element-patch-tests: %s: malformed row %d (want 6 tab-separated, non-empty columns: entry, runner, file, test, reason, evidence)\n", f, NR > "/dev/stderr"; exit 2 } }' \
    "$KNOWN_RED" || exit 2
fi

# Deterministic test mode: no watch, no snapshot writes (a missing snapshot is red,
# not silently created), no colour in the logs.
export CI="${CI:-true}" NO_COLOR=1 NX_DAEMON=false NX_NO_CLOUD=true

WORK="$(mktemp -d "${TMPDIR:-/tmp}/element-patch-tests.XXXXXX")"
: >"$WORK/plan.tsv"; : >"$WORK/runs.tsv"; : >"$WORK/entries.tsv"
say() { printf '%s\n' "$*"; }

# ---------------------------------------------------------------------------
# 1. Derive the test files from the patches.
# ---------------------------------------------------------------------------
shopt -s nullglob
patch_files=("$PATCHES_DIR"/*.patch)
shopt -u nullglob
[ "${#patch_files[@]}" -gt 0 ] || die "no *.patch in $PATCHES_DIR"

# Registry numbers: "### 11. `copy-markdown.patch`" -> "copy-markdown.patch<TAB>11".
if [ -f "$PATCHES_DIR/README.md" ]; then
  sed -nE 's/^##+[[:space:]]+([0-9]+)\.[[:space:]]+`([^`]+\.patch)`.*/\2\t\1/p' "$PATCHES_DIR/README.md" >"$WORK/entries.tsv"
fi

# "A|M<TAB>path" for every file a patch adds (--- /dev/null) or modifies.
patch_paths() {
  awk '
    /^--- / { have = 1; old = $2; next }
    have && /^\+\+\+ / {
      have = 0; p = $2
      if (p ~ /^b\//) { sub(/^b\//, "", p); print (old == "/dev/null" ? "A" : "M") "\t" p }
      next
    }
    { have = 0 }' "$1"
}

is_test_file() {
  local f="$1"
  [[ "$f" == playwright/* || "$f" == */playwright/* ]] && return 1
  [[ "$f" =~ (\.test|-test|\.spec)(\.browser)?\.[cm]?[jt]sx?$ ]]
}

declare -A CARRIED=()     # test file (repo-relative) -> "patch1.patch patch2.patch"
declare -A EXTRA_CFG=()   # patch-added vitest config (apps/web-relative) -> patch
for p in "${patch_files[@]}"; do
  pn="$(basename "$p")"
  while IFS=$'\t' read -r kind path; do
    [ -n "${path:-}" ] || continue
    if is_test_file "$path"; then
      CARRIED["$path"]="${CARRIED[$path]:+${CARRIED[$path]} }$pn"
    elif [ "$kind" = A ] && [[ "$path" =~ ^apps/web/(vitest[^/]*\.config\.[cm]?[jt]s)$ ]]; then
      EXTRA_CFG["${BASH_REMATCH[1]}"]="$pn"
    fi
  done < <(patch_paths "$p")
done
[ "${#CARRIED[@]}" -gt 0 ] || die "the patches in $PATCHES_DIR carry no test file (nothing to run is an error)"

# ---------------------------------------------------------------------------
# 2. Ask the runners which of those files they own.
# ---------------------------------------------------------------------------
say "element-patch-tests: tree=$TREE"
say "element-patch-tests: ${#CARRIED[@]} test file(s) derived from ${#patch_files[@]} patch(es) in $PATCHES_DIR"

VITEST_OWNS="$WORK/vitest-owns.txt"; JEST_OWNS="$WORK/jest-owns.txt"
( cd "$WEB" && pnpm exec vitest list --filesOnly --config vitest.config.ts 2>"$WORK/vitest-list.err" ) >"$VITEST_OWNS" \
  || { cat "$WORK/vitest-list.err" >&2; die "vitest list failed in $WEB"; }
( cd "$WEB" && pnpm exec jest --listTests 2>"$WORK/jest-list.err" ) | sed "s#^$WEB/##" >"$JEST_OWNS" \
  || { cat "$WORK/jest-list.err" >&2; die "jest --listTests failed in $WEB"; }
[ -s "$VITEST_OWNS" ] && [ -s "$JEST_OWNS" ] || die "a runner listed no test files; is $WEB installed?"

declare -a VITEST_FILES=() JEST_FILES=()
ORPHANS=0
while IFS= read -r f; do
  patches="${CARRIED[$f]}"
  rel="${f#apps/web/}"
  if [ "$rel" = "$f" ]; then
    printf '%s\t%s\t%s\n' "$f" "none: outside apps/web" "$patches" >>"$WORK/plan.tsv"
    ORPHANS=$((ORPHANS + 1)); continue
  fi
  if [ ! -f "$WEB/$rel" ]; then
    printf '%s\t%s\t%s\n' "$rel" "none: file missing from the tree" "$patches" >>"$WORK/plan.tsv"
    ORPHANS=$((ORPHANS + 1)); continue
  fi
  if grep -qxF -- "$rel" "$VITEST_OWNS"; then
    VITEST_FILES+=("$rel"); printf '%s\t%s\t%s\n' "$rel" vitest "$patches" >>"$WORK/plan.tsv"
  elif grep -qxF -- "$rel" "$JEST_OWNS"; then
    JEST_FILES+=("$rel"); printf '%s\t%s\t%s\n' "$rel" jest "$patches" >>"$WORK/plan.tsv"
  else
    printf '%s\t%s\t%s\n' "$rel" "none: no runner owns it" "$patches" >>"$WORK/plan.tsv"
    ORPHANS=$((ORPHANS + 1))
  fi
done < <(printf '%s\n' "${!CARRIED[@]}" | sort)

BROWSER_CFGS=()
for cfg in $(printf '%s\n' "${!EXTRA_CFG[@]}" | sort); do
  [ -f "$WEB/$cfg" ] || die "patch ${EXTRA_CFG[$cfg]} adds $cfg but the tree has no such file"
  BROWSER_CFGS+=("$cfg")
  printf '%s\t%s\t%s\n' "(files named by the config's include)" "vitest:$cfg" "${EXTRA_CFG[$cfg]}" >>"$WORK/plan.tsv"
done

say "element-patch-tests: plan"
awk -F'\t' '{ if ($2 ~ /^none/) printf "  %-9s %s  <- %s  (%s)\n", "NO RUNNER", $1, $3, substr($2, 7); else printf "  %-9s %s  <- %s\n", $2, $1, $3 }' "$WORK/plan.tsv" | sort -k1,1 -k2,2
if [ "$LIST_ONLY" = 1 ]; then
  [ "$ORPHANS" -eq 0 ] || { say "element-patch-tests: $ORPHANS test file(s) no runner would execute"; exit 1; }
  exit 0
fi

# ---------------------------------------------------------------------------
# 3. Build what the runners import, then run.
# ---------------------------------------------------------------------------
if [ "$PREPARE" = 1 ]; then
  proj="$(node -p "require('$WEB/package.json').name")"
  say "element-patch-tests: building workspace packages (nx run $proj:test:unit:prepare)"
  ( cd "$TREE" && pnpm exec nx run "$proj:test:unit:prepare" ) >"$WORK/prepare.log" 2>&1 \
    || { tail -40 "$WORK/prepare.log" >&2; die "workspace prepare failed (log: $WORK/prepare.log)"; }
fi

record_run() { printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$5" "$6" >>"$WORK/runs.tsv"; }

if [ "${#VITEST_FILES[@]}" -gt 0 ]; then
  say "element-patch-tests: vitest, ${#VITEST_FILES[@]} file(s)"
  rc=0
  ( cd "$WEB" && pnpm exec vitest run --config vitest.config.ts --maxWorkers="$WORKERS" --retry="$RETRY" \
      --reporter=default --reporter=json --outputFile.json="$WORK/vitest.json" "${VITEST_FILES[@]}" ) \
    >"$WORK/vitest.log" 2>&1 || rc=$?
  record_run vitest vitest "$WORK/vitest.json" "$rc" "$WORK/vitest.log" "vitest.config.ts"
fi

if [ "${#JEST_FILES[@]}" -gt 0 ]; then
  say "element-patch-tests: jest, ${#JEST_FILES[@]} file(s)"
  jest_extra=()
  fix="$( cd "$WEB" && pnpm exec jest --showConfig 2>/dev/null | node -e '
      let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
        const pats = JSON.parse(s).configs[0].transformIgnorePatterns || [];
        if (pats.some(p => p.includes("content-type"))) { process.stdout.write("ALREADY"); return; }
        if (pats.length !== 1 || !pats[0].includes("(?!(")) { process.stdout.write("SHAPE"); return; }
        process.stdout.write(pats[0].replace("(?!(", "(?!(content-type|"));
      });' || true )"
  case "$fix" in
    ALREADY) say "element-patch-tests: jest already transforms content-type; no fixup" ;;
    SHAPE|"") say "element-patch-tests: WARNING jest transformIgnorePatterns changed shape; running without the content-type fixup (jest suites that import matrix-js-sdk may not load)" ;;
    *) jest_extra=(--transformIgnorePatterns="$fix"); say "element-patch-tests: jest fixup: content-type added to the transform allowlist" ;;
  esac
  rc=0
  ( cd "$WEB" && pnpm exec jest --ci --maxWorkers="$WORKERS" --json --outputFile="$WORK/jest.json" \
      "${jest_extra[@]}" --runTestsByPath "${JEST_FILES[@]}" ) >"$WORK/jest.log" 2>&1 || rc=$?
  record_run jest jest "$WORK/jest.json" "$rc" "$WORK/jest.log" "jest.config.ts"
fi

for cfg in "${BROWSER_CFGS[@]}"; do
  id="vitest:$cfg"
  if [ "$SKIP_BROWSER" = 1 ]; then
    say "element-patch-tests: SKIP $cfg (--skip-browser)"
    record_run "$id" vitest SKIPPED 0 - "$cfg"
    continue
  fi
  # The config's own header comment names the invocation: `-t "<name>"`.
  name_filter="$(sed -nE 's/^.*[[:space:]]-t "([^"]+)".*$/\1/p' "$WEB/$cfg" | head -n1)"
  t_args=(); [ -z "$name_filter" ] || t_args=(-t "$name_filter")
  say "element-patch-tests: vitest browser mode, $cfg${name_filter:+ -t \"$name_filter\"}"
  safe="${cfg//[^A-Za-z0-9.]/_}"
  rc=0
  ( cd "$WEB" && pnpm exec vitest run --config "$cfg" --retry="$RETRY" --reporter=default --reporter=json \
      --outputFile.json="$WORK/$safe.json" "${t_args[@]}" ) >"$WORK/$safe.log" 2>&1 || rc=$?
  record_run "$id" vitest "$WORK/$safe.json" "$rc" "$WORK/$safe.log" "$cfg${name_filter:+ -t \"$name_filter\"}"
done

# ---------------------------------------------------------------------------
# 4. Judge.
# ---------------------------------------------------------------------------
set +e
node - "$WORK" "${KNOWN_RED:-}" "${JUNIT:-}" "$WEB" "$ORPHANS" <<'NODE'
const fs = require("fs"), path = require("path");
const [work, knownRedPath, junitDir, web, orphanCount] = process.argv.slice(2);
const strip = (s) => String(s || "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const rows = (p) => fs.existsSync(p)
  ? fs.readFileSync(p, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.split("\t"))
  : [];
const plan = rows(`${work}/plan.tsv`);     // file | runner id or "none: why" | patches
const runs = rows(`${work}/runs.tsv`);     // id | kind | json | exit | log | label
const entryOf = new Map(rows(`${work}/entries.tsv`));
const label = (patches) => patches.split(" ").map((p) => (entryOf.has(p) ? `entry ${entryOf.get(p)} ${p.replace(/\.patch$/, "")}` : p)).join(", ");

// Known-red: entry | runner | file | test ("*" = the file fails to load/run) | reason | evidence
const knownRed = new Map();
if (knownRedPath) {
  rows(knownRedPath).forEach((c, i) => {
    if (c.length < 6 || c.slice(0, 6).some((x) => !x.trim())) {
      console.error(`element-patch-tests: ${knownRedPath}: malformed row ${i + 1} (want 6 tab-separated, non-empty columns: entry, runner, file, test, reason, evidence)`);
      process.exit(2);
    }
    knownRed.set(`${c[1]}\t${c[2]}\t${c[3]}`, { entry: c[0], reason: c[4], evidence: c[5], used: false });
  });
}

const files = [];   // { runner, file, patches, passed, skipped, failed: [{name,msg,known}], error }
let runnerNotes = [];
const planned = new Map(plan.filter((p) => !p[1].startsWith("none") && !p[1].startsWith("vitest:")).map((p) => [`${p[1]}\t${p[0]}`, p[2]]));
const seen = new Set();

for (const [id, kind, json, exitCode, log, lbl] of runs) {
  if (json === "SKIPPED") { runnerNotes.push(`SKIPPED  ${id}  (${lbl})`); continue; }
  let report = null;
  try { report = JSON.parse(fs.readFileSync(json, "utf8")); } catch (_) { /* handled below */ }
  const wild = id.startsWith("vitest:");
  const patchesOf = wild ? (plan.find((p) => p[1] === id) || [, , ""])[2] : null;
  if (!report || !Array.isArray(report.testResults)) {
    const tail = fs.existsSync(log) ? strip(fs.readFileSync(log, "utf8")).split("\n").slice(-25).join("\n") : "(no log)";
    const targets = wild ? [`(${id})`] : [...planned.keys()].filter((k) => k.startsWith(id + "\t")).map((k) => k.split("\t")[1]);
    for (const f of targets) files.push({ runner: id, file: f, patches: wild ? patchesOf : planned.get(`${id}\t${f}`), passed: 0, passedNames: [], flaky: [], skipped: 0, failed: [], error: `runner exited ${exitCode} without a result file; log tail:\n${tail}` });
    continue;
  }
  let failedInRun = 0;
  for (const tr of report.testResults) {
    const rel = path.relative(web, tr.name);
    const key = `${id}\t${rel}`;
    if (!wild && !planned.has(key)) continue;            // a filter matched an unrelated file: not ours to judge
    seen.add(key);
    const f = { runner: id, file: rel, patches: wild ? patchesOf : planned.get(key), passed: 0, passedNames: [], flaky: [], skipped: 0, failed: [], error: null };
    const cases = tr.assertionResults || [];
    for (const t of cases) {
      if (t.status === "passed") {
        f.passed++; f.passedNames.push(t.fullName || t.title);
        // vitest keeps the earlier attempts' failure messages on a test that passed on a retry.
        if ((t.failureMessages || []).length) f.flaky.push({ name: t.fullName || t.title, msg: strip(t.failureMessages[0]).split("\n")[0] });
      }
      else if (t.status === "failed") f.failed.push({ name: t.fullName || t.title, msg: strip((t.failureMessages || []).join("\n")) });
      else f.skipped++;
    }
    if (cases.length === 0 && tr.status === "failed") f.failed.push({ name: "*", msg: strip(tr.message || "suite failed to run") });
    for (const x of f.failed) {
      const kr = knownRed.get(`${id}\t${rel}\t${x.name}`) || knownRed.get(`${id}\t${rel}\t*`);
      if (kr) { x.known = kr; kr.used = true; }
    }
    failedInRun += f.failed.length;
    files.push(f);
  }
  if (Number(exitCode) !== 0 && failedInRun === 0)
    runnerNotes.push(`FAIL  ${id}: exited ${exitCode} with no failing test (unhandled error? see ${log})`);
}
// Planned files no runner reported at all.
for (const [key, patches] of planned) {
  if (seen.has(key)) continue;
  const [runner, file] = key.split("\t");
  if (files.some((f) => f.runner === runner && f.file === file)) continue;
  files.push({ runner, file, patches, passed: 0, passedNames: [], flaky: [], skipped: 0, failed: [], error: "the runner never reported this file" });
}
for (const p of plan.filter((p) => p[1].startsWith("none")))
  files.push({ runner: "-", file: p[0], patches: p[2], passed: 0, passedNames: [], flaky: [], skipped: 0, failed: [], error: p[1].replace(/^none: /, "no runner executes it: ") });

const verdict = (f) =>
  f.error ? "FAIL"
  : f.failed.some((x) => !x.known) ? "FAIL"
  : f.passed + f.failed.length === 0 ? "FAIL"
  : f.failed.length ? "KNOWN-RED" : "PASS";

console.log("");
files.sort((a, b) => (a.file < b.file ? -1 : 1));
const wRun = Math.max(6, ...files.map((f) => f.runner.length)) + 2;
const wFile = Math.max(4, ...files.map((f) => f.file.length)) + 2;
console.log(`${"RESULT".padEnd(11)}${"RUNNER".padEnd(wRun)}${"FILE".padEnd(wFile)}DETAIL`);
let nFail = 0, nKnown = 0, nPass = 0, tPassed = 0, tFailed = 0, tKnown = 0, tSkipped = 0;
for (const f of files) {
  const v = verdict(f);
  const bad = f.failed.filter((x) => !x.known).length, kn = f.failed.length - bad;
  const parts = [`${f.passed} passed`];
  if (bad) parts.push(`${bad} FAILED`);
  if (kn) parts.push(`${kn} known-red`);
  if (f.skipped) parts.push(`${f.skipped} skipped`);
  if (f.error) parts.push(f.error.split("\n")[0]);
  else if (f.passed + f.failed.length === 0) parts.push("ran 0 tests");
  console.log(`${v.padEnd(11)}${f.runner.padEnd(wRun)}${f.file.padEnd(wFile)}${parts.join(", ")}  [${label(f.patches || "")}]`);
  if (v === "FAIL") nFail++; else if (v === "KNOWN-RED") nKnown++; else nPass++;
  tPassed += f.passed; tSkipped += f.skipped; tFailed += bad; tKnown += kn;
}

const detail = files.filter((f) => verdict(f) === "FAIL");
const frames = (m) => m.split("\n").filter((l) => !/node_modules\/|node:internal|\(<anonymous>\)/.test(l)).slice(0, 14);
for (const f of detail) {
  console.log(`\n--- ${f.file}  (${f.runner}; ${label(f.patches || "")})`);
  if (f.error) console.log(f.error);
  for (const x of f.failed.filter((y) => !y.known)) {
    console.log(`  FAILED  ${x.name}`);
    console.log(frames(x.msg).map((l) => "    " + l).join("\n"));
  }
}
// The JSON reports carry the message but not the diff; the runner's own log has both.
const logOf = new Map(runs.map((r) => [r[0], r[4]]));
for (const id of new Set(detail.filter((f) => f.failed.some((x) => !x.known)).map((f) => f.runner))) {
  const lg = logOf.get(id);
  if (!lg || !fs.existsSync(lg)) continue;
  console.log(`\n=== last 120 lines of the ${id} log (${lg}) ===`);
  console.log(strip(fs.readFileSync(lg, "utf8")).split("\n").slice(-120).join("\n"));
}
const known = files.flatMap((f) => f.failed.filter((x) => x.known).map((x) => ({ f, x })));
const flaky = files.flatMap((f) => f.flaky.map((x) => ({ f, x })));
if (flaky.length) {
  console.log("\nFLAKY (failed an attempt, passed on retry; not a failure, but look if it repeats):");
  for (const { f, x } of flaky) console.log(`  ${f.file} :: ${x.name}\n      ${x.msg}`);
}
if (known.length) {
  console.log("\nknown-red (red on the unpatched tag too, see the known-red list):");
  for (const { f, x } of known) console.log(`  ${f.file} :: ${x.name}  [entry ${x.known.entry}] ${x.known.reason}`);
}
const stale = [...knownRed].filter(([, v]) => !v.used);
const ranRunners = new Set(files.map((f) => f.runner));
for (const [k] of stale) {
  const [runner, file, test] = k.split("\t");
  if (ranRunners.has(runner) && files.some((f) => f.runner === runner && f.file === file))
    console.log(`\nSTALE known-red entry (green or gone now, remove it): ${runner} ${file} :: ${test}`);
}
for (const n of runnerNotes) console.log(`\n${n}`);
const noteFail = runnerNotes.some((n) => n.startsWith("FAIL"));

console.log(`\nelement-patch-tests: ${files.length} file(s): ${nPass} pass, ${nKnown} known-red only, ${nFail} FAIL; ` +
  `${tPassed} test(s) passed, ${tFailed} failed, ${tKnown} known-red, ${tSkipped} skipped, ${flaky.length} flaky`);

if (junitDir) {
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c])).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="element-patch-tests">\n`;
  for (const f of files) {
    const total = f.passed + f.failed.length + f.skipped + (f.error ? 1 : 0);
    xml += `  <testsuite name="${esc(f.runner + " " + f.file)}" tests="${total}" failures="${f.failed.filter((x) => !x.known).length + (f.error ? 1 : 0)}" skipped="${f.skipped + f.failed.filter((x) => x.known).length}">\n`;
    xml += `    <properties><property name="patches" value="${esc(label(f.patches || ""))}"/></properties>\n`;
    for (const x of f.failed) {
      xml += `    <testcase classname="${esc(f.file)}" name="${esc(x.name)}">` +
        (x.known ? `<skipped message="known-red: ${esc(x.known.reason)}"/>` : `<failure message="${esc(x.msg.split("\n")[0])}">${esc(x.msg)}</failure>`) + `</testcase>\n`;
    }
    if (f.error) xml += `    <testcase classname="${esc(f.file)}" name="(file)"><failure message="${esc(f.error.split("\n")[0])}">${esc(f.error)}</failure></testcase>\n`;
    for (const n of f.passedNames) xml += `    <testcase classname="${esc(f.file)}" name="${esc(n)}"/>\n`;
    xml += `  </testsuite>\n`;
  }
  xml += `</testsuites>\n`;
  fs.writeFileSync(path.join(junitDir, "element-patch-tests.xml"), xml);
}
console.log(`element-patch-tests: logs and raw reports in ${work}`);
process.exit(nFail > 0 || noteFail || Number(orphanCount) > 0 ? 1 : 0);
NODE
rc=$?
exit "$rc"
