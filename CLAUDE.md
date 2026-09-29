@AGENTS.md

# Claude Code notes for siwx-oidc-matrix-server

The rules above (imported from `AGENTS.md`) apply in full. This file adds only what is
specific to Claude Code; keep project rules in `AGENTS.md` so every agent sees the same set.

## Skills

The task guides in `skills/` are exposed as slash commands through symlinks in
`.claude/commands/`: `/siwx-matrix`, `/siwx-matrix-setup`, `/siwx-matrix-troubleshoot`,
`/siwx-matrix-device-verify`, `/set-admin`, `/matrix-rtc-transport-specialist`,
`/matrix-custom-themes-specialist`, `/element-x-mobile-passkey-first`.

## Private notes

Maintainers keep deployment-specific notes (hosts, stack paths, deploy procedure, the
current state of their deployments, incident records) in `CLAUDE.local.md` at the
repository root. Claude Code loads it automatically. Keep it untracked and never copy its
content into a tracked file; see "Public-repo hygiene" in `AGENTS.md`.

## Working in this repo

- Run `git status` and check the current branch before editing: several sessions may share
  a checkout, and a branch switch by another session looks like your work vanishing.
- Never print `.env` or grep it with broad patterns; anything printed in a session leaves
  the machine. Count keys instead (`grep -c '^KEY=' .env`).
- Do not build images locally to deploy them; deployed images come from CI.
