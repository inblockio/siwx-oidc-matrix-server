# Element Call: Manual Pinning and Video-less Bot Tiles

> **STATUS: INITIAL ASSESSMENT, NEEDS MORE WORK.**
> This is a first exploration based on reading the upstream source (livekit branch,
> 2026-06-12). Line numbers will drift; no patch has been written or tested yet.
> Open questions are listed at the end. Do not treat the effort estimates as commitments.

## Problem

Two related complaints from real calls on agentic.inblock.io:

1. **No manual pin/spotlight.** Element X mobile (and every other client) cannot pin a
   participant's face. Spotlight exists but is automatic (active speaker only).
2. **Transcript agent shrinks everyone.** When a video-less bot (transcription agent,
   no avatar, no camera) joins, it still gets a full equal-sized grid tile. With it in
   the room, all video tiles shrink and people cannot see each other's faces.

Upstream tracking: [element-call #3259](https://github.com/element-hq/element-call/issues/3259)
(Manual pinning, open, labelled Needs Design / Needs Product, no one working on it).

## Why patching our SPA fixes all clients

Element X has no call UI of its own. It embeds our self-hosted Element Call SPA as a
widget (`src/widget.ts`). Widget mode runs the exact same `CallViewModel` and layout
code as the standalone app. Patch the SPA, redeploy the static files, and Element X
iOS/Android, Element Web, and standalone all pick it up immediately, with no app updates.

This repo already carries patches for Element Web under `patches/element-web/`; an
Element Call patch would follow the same pattern under `patches/element-call/`.

## How the upstream layout works (source reading, livekit branch)

State management is RxJS observables in `src/state/CallViewModel/CallViewModel.ts`
(~1,800 lines). Key mechanics:

- **Spotlight is hardcoded to active speaker.** `spotlightSpeaker$` (around line 910)
  picks: current speaker (sticky), else any remote speaker, else last speaker, else
  anyone. Screenshares override it in the `spotlightAndPip$` priority cascade
  (around line 984: ringing, then screenshare, then speaker).
- **Grid tiles sort into bins** (`src/state/media/WrappedUserMediaViewModel.ts`):
  `Presenters < Speakers < HandRaised < Video < NoVideo`. A video-less bot already
  sinks to the bottom bin but still occupies a full equal-sized tile. The grid is
  assembled in one place: `grid$` (around line 946), a plain sort by bin.
- **No pin concept exists anywhere** in the codebase (verified by grep).
- **Per-tile context menu already exists** (`src/tile/GridTile.tsx`, long-press works
  on mobile) and contains a placeholder comment for future menu items, plus an
  existing `ToggleMenuItem` pattern ("always show self") to copy.
- **Settings** (`src/settings/settings.ts`) are one-line `Setting` instances persisted
  to localStorage; easy to add toggles.

## Fix A: hide video-less tiles (small; addresses the bot complaint)

- New setting `hideVideolessTiles` in `src/settings/settings.ts`.
- Filter items in the `NoVideo` bin out of `grid$` when the setting is on. Audio keeps
  playing; only the tile disappears.
- Settings UI checkbox, imitating the existing `showHandRaisedTimer` toggle.

Estimated diff: ~30-50 lines across 3 files.

**Open design question:** a human with their camera off also lands in `NoVideo`.
Options: explicit per-user toggle (simplest), only hide members that never published
video, or match the bot's user ID pattern. Needs a decision before implementation.

## Fix B: manual local pin (moderate; the real feature)

Scope as a **local pin**: only the pinning user's view changes (Zoom "pin" semantics).
Pure client state, zero protocol work. A room-wide synced spotlight would need Matrix
state events and is explicitly out of scope for a first iteration.

Touch points:

1. **State:** `pinnedMedia$` BehaviorSubject plus `togglePin()` on `CallViewModel`.
2. **Spotlight override:** insert a pinned branch into the `spotlightAndPip$` cascade.
   Decide whether pin beats screenshare or sits below it.
3. **Grid ordering:** add a `Pinned` bin above `Speakers` in the `SortingBin` enum.
4. **UI:** "Pin" `ToggleMenuItem` in the `GridTile` context menu placeholder;
   optionally auto-switch layout mode to spotlight when pinning.

Estimated diff: ~150-250 lines across 4-5 files.

## Fork and upstream strategy

Carrying an element-call fork means rebasing the patch on upstream releases. Both
fixes are small and localized; both are plausible upstream contributions (#3259 asks
for pinning; audio-only bots are increasingly common, so the hide-toggle is defensible
too). Landing them upstream would eventually delete the fork.

Suggested order: ship Fix A on our deployment first, then prototype Fix B against
#3259 with upstreaming in mind.

## Open questions / next steps

- [ ] Decide the Fix A hiding criterion (toggle vs never-published-video vs bot ID match).
- [ ] Confirm which element-call version/tag our deployment actually runs and re-anchor
      all line references against it (this assessment reads the upstream livekit branch).
- [ ] Decide pin-vs-screenshare priority for Fix B.
- [ ] Check how our Element Call is built and deployed in this stack (image vs static
      build) and define the `patches/element-call/` workflow accordingly.
- [ ] Prototype, test on Element X iOS and Android plus Element Web, then evaluate
      upstreaming.
