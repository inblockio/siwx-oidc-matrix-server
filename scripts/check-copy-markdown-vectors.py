#!/usr/bin/env python3
"""Prove that the Copy Markdown conformance vectors exist once, in two places.

Why this exists
---------------
Copy Markdown (patch entry 11) turns a Matrix message into Markdown from the raw
event alone, so that every implementation gives byte-identical output: Element Web
(the vendored patch) and any SDK port an agent uses. The contract between them is
a JSON file of conformance vectors (raw event content -> expected Markdown).

Element's tests read the copy the patch adds as
`apps/web/src/utils/eventToMarkdown.vectors.json`; a port reads the canonical copy
at `docs/copy-markdown/vectors.json`. This check fails when the two differ by a
single byte, so neither can drift from the other.

Hermetic: reads the working tree only. Usage:
    python3 scripts/check-copy-markdown-vectors.py
Exit 0 if identical, 1 otherwise.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PATCH = ROOT / "patches/element-web/copy-markdown.patch"
TARGET = "apps/web/src/utils/eventToMarkdown.vectors.json"
CANONICAL = ROOT / "docs/copy-markdown/vectors.json"


def file_from_patch(patch: str, path: str) -> bytes | None:
    """The content of a file the patch creates, rebuilt from its added lines."""
    lines = patch.split("\n")
    out: list[str] = []
    inside = False
    in_body = False
    no_final_newline = False
    for line in lines:
        if line.startswith("diff --git "):
            if inside:
                break
            inside = line.endswith(f" b/{path}")
            in_body = False
            continue
        if not inside:
            continue
        if line.startswith("@@"):
            in_body = True
            continue
        if not in_body:
            if line.startswith("--- ") and line != "--- /dev/null":
                # The patch modifies the file instead of creating it: not supported.
                return None
            continue
        if line.startswith("+"):
            out.append(line[1:])
        elif line.startswith("\\"):
            no_final_newline = True
        elif line.startswith((" ", "-")):
            return None
    if not out:
        return None
    text = "\n".join(out) + ("" if no_final_newline else "\n")
    return text.encode("utf-8")


def main() -> int:
    in_patch = file_from_patch(PATCH.read_text(encoding="utf-8"), TARGET)
    if in_patch is None:
        print(f"FAIL: {PATCH.relative_to(ROOT)} does not create {TARGET}")
        return 1
    if not CANONICAL.exists():
        print(f"FAIL: {CANONICAL.relative_to(ROOT)} is missing")
        return 1
    canonical = CANONICAL.read_bytes()
    if in_patch != canonical:
        print(
            f"FAIL: {CANONICAL.relative_to(ROOT)} differs from the {TARGET} the patch adds "
            f"({len(canonical)} vs {len(in_patch)} bytes); copy the patch's file over it"
        )
        return 1
    print(f"OK: {CANONICAL.relative_to(ROOT)} equals the patch's {TARGET} ({len(canonical)} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
