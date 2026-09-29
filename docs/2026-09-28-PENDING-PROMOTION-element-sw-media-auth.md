# PENDING PROMOTION: Element Web service-worker media fix (entries 9 + 10)

Status: **NOT promoted.** Running on dev since 2026-09-28 23:07 UTC. Prod needs Tim's explicit go.
When promoting, turn this file into the promotion record: rename it to
`YYYY-MM-DD-PROMOTION-element-sw-media-auth.md`, fill in section 5, and update the
"What runs on prod today" table in `patches/element-web/README.md` (rows 9 and 10 plus the
`sw-boot.js` runtime delta go from "dev only" to "yes").

**Joint promotion (2026-09-29):** this fix is expected to ship in the SAME element-web image as the
Element DID-search work of session waldknoten-01-36. That branch is rebased on main, so it contains
entries 9 and 10. Joint release notes: `~/handovers/release-notes-next-prod-promotion.md` (section 2 is
this fix). If the DID-search work is not ready, this fix can ship alone with the digest in section 2.
Since 2026-09-28 23:12 UTC dev runs that joint build (`element-web@sha256:4cbcd901...`, rev 5fdc0b0),
which serves all entry 9/10 markers.

**Entry 9 re-vendored (2026-09-29):** main now carries entry 9 re-copied from PR #35242 head
`246724f407` (SonarCloud follow-up, behaviour identical; entry 10 got a header-only refresh). Dev
still runs an image with entry 9 at `4ea5f83813` (the 2e9eb93 image of section 2; the joint build
5fdc0b0 carries the same copy). The promotion target digest in section 2 is unchanged. Moving it to
a newer main digest is optional and Tim's call. No pins were changed.

---

## 1. Release notes

### For users

- **Fixed: images, avatars and file downloads failing with "file not found" or "unable to
  decrypt" after reopening Element or coming back to an idle tab.** Files were never lost; the
  browser was asking for them on an address the server no longer serves. This affected users
  who return to Element more than 5 minutes after last using it, which is the normal case.
- No action needed after the update. A normal page load picks up the new version. If media is
  broken at the moment the update lands, closing every Element tab and reopening clears it.

### For operators

- Element Web stays at **1.12.29**. The image only gains two vendored patches and a boot-shim
  change. Nothing in `config/element-config.json`, nginx config or Synapse changes.
- **New patch, registry entry 9 `sw-versions-no-cache-on-error.patch` (UPSTREAM DEFECT, filed).**
  Upstream Element's service worker parsed `GET /_matrix/client/versions` without a status
  check and cached an error answer as "no authenticated media" for the rest of the service
  worker's life, so every media request went to the legacy `/_matrix/media/v3/*` endpoints,
  which our Synapse answers with 404 (authenticated media is enforced). The patch never caches a
  failed check, retries the check without the token (the answer is a server property), and
  shares one in-flight check per server. Byte-identical to upstream PR
  [element-hq/element-web#35242](https://github.com/element-hq/element-web/pull/35242), issue
  [#35241](https://github.com/element-hq/element-web/issues/35241).
- **New patch, registry entry 10 `sw-media-401-token-retry.patch` (UPSTREAM DEFECT, not filed).**
  When a media request sent with the stored token gets a 401, the service worker waits up to
  5 s (wall clock, one shared wait per rejected token) for the app to store a refreshed token and
  retries once. Trade-off: if the session is really gone, that media request fails about 5 s
  later instead of at once.
- **Boot shim `config/element-sw-boot.js`, guard E (SW liveness canary).** It now waits until
  the app reaches `SYNCING` (a refreshed, stored token) before probing, and after 120 s without
  `SYNCING` it warns and probes anyway. On prod this canary was the request that triggered the
  bug in every observed burst (2026-09-28 forensics), because it fired 3 s after load, before the
  app had refreshed an expired token.
- **Build guards added to `Dockerfile.element`.** The build fails if the built `sw.js` lacks
  either patch's marker, or if the bundle no longer exposes `mxMatrixClientPeg` (guard E depends
  on it).

### Root cause (short)

Stock Element bug (no status check on the service worker's `/versions` probe, still present on
upstream `develop` 2026-09-28) plus our own boot-shim canary as the trigger. siwx-oidc access
tokens live 300 s, the same default as upstream MAS, so an expired token in browser storage is
routine. The RCA, prod log forensics and dev reproduction are in `patches/element-web/README.md`
entries 9 and 10.

## 2. What changes on prod

| Item | Before (prod today) | After |
|---|---|---|
| `matrix-element-web-1` image | `ghcr.io/inblockio/siwx-oidc-matrix-server/element-web@sha256:8cea1873e57402701958100f79bff0f7f9672012c05c33bf1bf4c8972538c393` (rev 0a58e7e, served `sw.js` stamp `4c2ef160... 2026-09-25T11:40:49Z`) | `ghcr.io/inblockio/siwx-oidc-matrix-server/element-web@sha256:18f352e304d53f9e88ccf485c074387f0a0991dd01a58586bee8898c409587e0` (rev 2e9eb93, stamp `aab025c9f0fdbc8aa151 2026-09-28T23:05:33Z`) |

The only Element-relevant changes between 0a58e7e and 2e9eb93 are the two new patches, the
Dockerfile wiring and guards, and `config/element-sw-boot.js`. Checked with
`git log 0a58e7e..2e9eb93 -- dockerfiles/Dockerfile.element patches/ config/element-* entrypoints/element_entrypoint.sh`.

## 3. Procedure (same pattern as the dev deploy)

On `deploy@agentic.inblock.io:8022`, in the matrix stack directory:

1. Back up `.env` (`cp -p .env .env.bak-<date>-element-sw-media-auth`). Edit **in place** (keep
   the inode, never `mv` over it), and change **only** the Element image ref to the digest above.
   `.env` may also be Synapse's `env_file`; if it is, any edit queues a Synapse recreate at the next
   full `up`, so recreate element only.
2. `docker pull <new ref>`, then `up --dry-run` and write down exactly what it would recreate.
3. Check that no calls are active (LiveKit rooms = 0).
4. `up -d --no-deps element-web`. Never do a plain `up`.
5. `up --dry-run` again: element must no longer appear. Anything else it lists is pre-existing
   and must not be applied as part of this promotion.

## 4. Gates

- Served `https://element.inblock.io/sw.js` carries `not caching server support`,
  `retrying without one` and `retrying media request with a refreshed access token` once each, and
  the new build stamp. `sw-boot.js` contains `SYNCING`.
- `scripts/element-deploy-audit.sh https://element.inblock.io https://matrix.inblock.io`: 0 FAIL
  (dev result 2026-09-28: 21 PASS, 1 informational WARN, 0 FAIL).
- A human check on prod: open a room with images after the tab has been closed for more than
  5 minutes; images load, and the Synapse log shows no legacy `/_matrix/media/v3` 404 bursts.
- The Playwright leg `e2e/element/ew-sw-media-auth.spec.mjs` (siwx-oidc `dev` 2f6bc0c) is
  dev-only. Do not run it against prod: it creates an account per run.

## 5. Rollback

Restore the Element image ref from the `.env` backup (in place), then `up -d --no-deps
element-web`. The service worker updates on the next navigation, because the per-build `sw.js`
stamp changes the bytes. Rollback target: `sha256:8cea1873...` (rev 0a58e7e).

Record here when promoting: window, who authorized it, gate results, and anything rolled back.

## 6. After promotion

- Update `patches/element-web/README.md`: the "What runs on prod today" rows for entries 9 and 10
  and the `sw-boot.js` delta.
- Tell the affected user (report of 2026-09-28) that the fix is live. Their Element X Android
  session was signed out by their own action and needs a fresh login.
- Upstream: when #35242 merges and a tag containing it is adopted, drop entry 9 per its
  retirement condition. If maintainer PR #34955 lands first, rebase #35242 and switch #34955's
  test mock to a real `new Response(...)`, as promised in the PR.
