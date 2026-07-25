#!/usr/bin/env python3
"""Validate that every unified-diff hunk header in patches/ matches its body.

Why this exists
---------------
`patches/element-web/*.patch` are vendored patches applied at image-build time.
They are edited by hand often enough that a stale `@@ -a,b +c,d @@` line count is
a real hazard: `git apply` rejects the hunk, the Docker build fails late, and the
error points at the patch rather than at the edit that broke it. Worse, a header
that is wrong in the permissive direction can apply the wrong span.

This caught exactly that on 2026-07-25: an edit inside the recovery hunk added 18
lines while the header still claimed the old count.

Usage:  python3 scripts/check-patch-hunks.py [patch ...]
Exit 0 if every hunk is consistent, 1 otherwise. With no arguments it checks
every *.patch under patches/.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
# A new file section resets counting; anything at column 0 that is not a diff
# body marker ends the current hunk.
BOUNDARY = ("@@", "diff --git", "--- ", "+++ ", "index ", "new file", "deleted file")


def check(path: Path) -> list[str]:
    """Return a list of human-readable problems for one patch file."""
    lines = path.read_text().split("\n")
    if lines and lines[-1] == "":
        lines.pop()  # trailing newline is not a context line

    problems: list[str] = []
    i = 0
    hunks = 0
    while i < len(lines):
        m = HUNK.match(lines[i])
        if not m:
            i += 1
            continue
        hunks += 1
        # A hunk header may omit the count when it is 1 (`@@ -5 +5 @@`).
        want_old = int(m.group(2)) if m.group(2) is not None else 1
        want_new = int(m.group(4)) if m.group(4) is not None else 1

        j = i + 1
        old = new = 0
        while j < len(lines):
            line = lines[j]
            if line.startswith(BOUNDARY):
                break
            if line.startswith("\\"):
                j += 1  # "\ No newline at end of file" counts for neither side
                continue
            if line.startswith("-"):
                old += 1
            elif line.startswith("+"):
                new += 1
            elif line.startswith(" ") or line == "":
                old += 1
                new += 1
            else:
                break
            j += 1

        if (old, new) != (want_old, want_new):
            problems.append(
                f"{path}:{i + 1}: header says (-{want_old},+{want_new}) "
                f"but body has (-{old},+{new})"
            )
        i = j

    if hunks == 0:
        problems.append(f"{path}: no hunks found -- is this really a unified diff?")
    return problems


def main(argv: list[str]) -> int:
    if argv:
        targets = [Path(a) for a in argv]
    else:
        root = Path(__file__).resolve().parent.parent
        targets = sorted(root.glob("patches/**/*.patch"))

    if not targets:
        print("no patch files found", file=sys.stderr)
        return 1

    problems: list[str] = []
    for t in targets:
        if not t.is_file():
            problems.append(f"{t}: not a file")
            continue
        problems.extend(check(t))

    for p in problems:
        print(p, file=sys.stderr)

    checked = ", ".join(t.name for t in targets)
    if problems:
        print(f"\nFAIL: {len(problems)} problem(s) across {len(targets)} patch(es)", file=sys.stderr)
        return 1
    print(f"OK: all hunk headers consistent ({checked})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
