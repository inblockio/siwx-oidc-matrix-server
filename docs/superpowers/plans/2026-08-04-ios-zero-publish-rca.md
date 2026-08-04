# iOS Element X zero-publish RCA (2026-08-04)

## Symptom

Post-promotion retest by Tim, 2026-08-04 ~09:34–09:46Z, prod (`matrix.inblock.io`):
Element X iOS user `@did-key-zdnaeqmmv7cso26wrcvemkfrwnrzwjaef6ptnvun5clzhnw9u`
establishes no video with an Element Web peer; the web session's own audio+video
are fine.

## Evidence (prod logs)

Three calls this morning; livekit + lk-jwt + synapse logs:

| # | UTC | LK room | iOS side | Peer | Result |
|---|-----|---------|----------|------|--------|
| 1 | 09:34 | `5TLJxNuq…` (RM_eThvh7LqteUX) | `did-pkh…0x4b23` dev `xLAJ/…` | `@did-pkh…0x7a76:dev.matrix.inblock.io` via dev.element.inblock.io (restricted, hashed identity `rW3dXxvdS+…`) | iOS publishes audio only (27 s in); peer publishes nothing; 35 s |
| 2 | 09:36 | same alias (RM_Eb46VHGWKMFE) | same | same dev user (`wOU12…`) | iOS audio only (23 s in); peer nothing; 30 s |
| 3 | **09:42** | `z8YXs2LW…` (RM_mP5DocHiyMNZ) | **`did-key-zdnaeqmmv7…` dev `Z4IxyS5K9m`** | `@did-pkh…0x4b23:matrix.inblock.io` Element Web/Windows (`mhtnfeCX7A`, full access) | **web publishes opus + VP-simulcast (q/h/f) in <1 s; iOS publishes ZERO tracks for 3 m 17 s**; clean leave |

Call 3 (the reported failure), iOS participant:

- ICE/DTLS **healthy**: `participant active` in 923 ms, `connectionType: udp`,
  selected `142.93.168.4:20197` ↔ phone prflx. Single external IP advertised
  (the 2026-08-02 `rtc.ips.excludes` fix is working). Zero establishment DTLS
  timeouts; the 09:45:44 DTLS lines are the known benign teardown signature.
- Token grants: `CanPublish: true`, full access (lk-jwt log + join blob).
- PublisherOffer: 3×audio + 3×video m-lines all `a=recvonly`,
  `AddTrackRequests: []`; **no `AddTrackRequest` and no `mediaTrack published`
  event ever** — the client never signaled intent to publish. In livekit-js,
  `publishTrack()` sends `AddTrackRequest` as its first signaling step, so the
  failure sits **before signaling: no local track ever existed in the EC
  webview → getUserMedia never produced one**.
- Data channels (`_reliable`/`_lossy`/`_data_track`) were open (visible at
  teardown). Client: livekit-js 2.19.2, protocol 17,
  `UseSinglePeerConnection: true`, iOS 26.5.2, WKWebView, EC origin `file://`
  (bundled EC), app `io.element.elementx.ios.prod`.
- Synapse: 5× `PUT /sendToDevice/m.room.encrypted` between both users during
  the call — E2EE call-key transport was operating in both directions.
- The did-key account is **brand-new**: `has no master cross-signing key`,
  `m.megolm_backup.v1` 404, fresh pusher — fresh EX login.
- Server codec config: livekit.yaml has **no `codecs:` section** → defaults
  (opus/VP8/H264/VP9/AV1) — codec config exonerated (and zero-AddTrack rules
  out codec negotiation anyway, which happens after track creation).

Cumulative record: 2026-08-01 five iOS join attempts (audio-intent → opus in
~100 ms twice; video-intent → zero tracks) + today three more. **Element X iOS
has never published a video track on this stack — across two accounts, two
devices/logins, and both pre- and post-fix transports — while every non-iOS
client publishes within ~1 s.**

## Why the 2026-08-02/03 fix didn't fix this

The promoted fix (`rtc.ips.excludes` + TURN UDP/TLS + hardening) targeted the
confirmed transport defect H1/H2 (private-candidate roulette → DTLS timeout →
zero media *after* publish). It works: call 3 shows single external IP, UDP
selected, sub-second media from web. It could never fix H4, the competing
cause the 2026-08-02 audit explicitly left SUPPORTED with this exact
discriminator ("after the prod ICE fix, retry a video call; if video still
never publishes, run the phone-side checklist"). The 2026-08-01 16:42Z window
had both causes overlapping (18 establishment-window DTLS timeouts could mimic
the zero-publish correlation); the fix removed one cause, the retest has now
isolated the other. **H4 branch taken: client-side capture failure on iOS.**

## Verdict

- CONFIRMED (server logs): prod SFU, auth, transport, grants, codecs, and E2EE
  key transport are all healthy for this call. The only missing media is what
  the iOS client never captured: **getUserMedia in Element X's EC WKWebView
  produced no tracks** (call 3: neither video nor audio; calls 1–2: audio only,
  ~25 s late = manual unmute granted mic, camera failed).
- NOT YET DISCRIMINATED (needs the phone, ~2 min): (a) iOS app-level
  Camera/Microphone permission off for Element X, (b) EX/WebKit capture bug on
  iOS 26.5.x, (c) camera held by another app. EC logs `MuteState: handler
  error` without hard-failing the call, which matches the silent 3-minute
  in-call-but-black behavior.

## Remediation plan

Phone-side discriminator (do first, ~2 min, decides everything):
1. iOS Settings → Element X → verify **Camera ON and Microphone ON**. If off:
   enable, retest — likely done.
2. In-app capture sanity check: EX chat → attach → take photo (proves app-level
   AVCapture works).
3. Retest the call. Immediately after a failure, capture a **rageshake**
   (EX Settings → Advanced → Report a problem): the EC webview console carries
   the gUM error name — `NotAllowedError` = permission; `NotFoundError`/
   `AbortError` = WebKit/hardware; nothing = EC/EX bug → escalate to
   element-x-ios with the rageshake, and cross-check with latest EX/TestFlight.
4. Optional server-side confirmation during the retest: set livekit log level
   to debug for the window to record subscription/forwarding for the
   web→iOS direction (rendering on the phone is otherwise invisible to us).

Server-side actions (hygiene, none required for this defect):
5. **Rotate `LIVEKIT_KEY`/`LIVEKIT_SECRET`** (livekit.yaml + lk-jwt env
   together): the pair was accidentally echoed into an agent session on
   2026-08-04 during this audit. The SFU signaling endpoint is public, so the
   secret mints valid join tokens.
6. Cross-env test hygiene: dev.element.inblock.io users on the prod focus get
   *restricted* (room-create-denied, hash-identity) tokens — they CAN publish
   (grants verified; lk-jwt README anchors restricted = no room creation
   only). Keep avoiding mixed prod/dev call tests, or add
   `dev.matrix.inblock.io` to `LIVEKIT_FULL_ACCESS_HOMESERVERS` if cross-env
   calls become a supported flow.
7. Keep the promoted transport stack as-is; nothing in this incident argues
   for rollback.
8. Harness caveat (standing): aqua-e2e uses the Rust SDK's own capture and can
   never detect EX capture failures; EX-on-iOS is only validatable with a real
   phone + rageshake.
