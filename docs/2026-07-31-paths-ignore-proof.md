# paths-ignore proof (S5 branch-based CI deploys)

This file exists solely to prove that `docker.yml`'s `paths-ignore:
['docs/**', '**.md']` on the `push` trigger works: a docs-only commit
touching only this file must NOT trigger a "Publish Docker" run.

See docs/2026-07-30-dev-staging-dev-aquafire.md §9 for the full branch-flow
writeup.
