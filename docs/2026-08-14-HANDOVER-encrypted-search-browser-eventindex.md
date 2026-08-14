# Handover — Encrypted-room search in Element Web (browser EventIndex)

Date: 2026-08-14
Owner: security / product (inblock.io Chat)
Target: **dev-staging only** (`dev.element.inblock.io` / `dev.matrix.inblock.io`)
Prod: **out of scope until an explicit, separate go-ahead** after staging UX + audit are green.

Hello, and thank you for picking this up.

This note is the starting brief for a **marathon implementation** of human
message search in our hosted Element Web. It is written so you do not have to
re-derive the architecture. The decisions below are closed. Implement them.
Do not reopen Desktop, a Seshat WASM port, or an agent-facing search pipe
unless new evidence falsifies a listed invariant.

We are building **production-ready** code, staged on dev. Shipping a clever
demo that leaks plaintext after logout, or that agents can scrape, is a fail.

---

## Purpose (one sentence)

Give a logged-in human, in `dev.element.inblock.io`, working full-text search
over **E2EE rooms they can already decrypt**, with a client-side index that is
**useless when the session is locked or gone**, and **prove** that with UX
end-to-end tests plus a security audit — without touching prod and without
giving agents a back door.

---

## Why this exists

All inblock rooms are E2EE. Element Web’s Search UI says the feature is N/A
and “only available on desktop apps.” That is upstream policy, not a bug in
our config.

Desktop already has this via **Seshat** (`matrix-org/seshat` → native Node
addon `matrix-seshat`). Our product client is **not** Desktop. It is hosted
Element Web (`element.inblock.io` / `dev.element.inblock.io`) with SIWX OIDC,
passkeys, `force_verification`, branding, and vendored patches. Sending people
to stock Desktop would split login, recovery, and support. Rejected.

A WASM compile of Seshat was evaluated and **rejected**. Seshat is a native
program: SQLCipher via rusqlite, Tantivy 0.12 on a real filesystem, a
`std::thread` writer + r2d2 pool, Neon N-API `cdylib`. Element’s own docs say
native modules exist for things a browser cannot do. A “port” would replace
every I/O layer. That is a new EventIndex, not a Seshat build. Do not try it.

Agents are **out of this feature**. An agent is a Matrix user. Invite it into
the rooms it may see. It works with events it can decrypt **from invite
forward**. E2EE history does not follow the invite; that is load-bearing, not
a bug. Do **not** share the human search index with agents. Do **not** scrape
Element. Agent FTS, if ever needed, lives in `aqua-matrix-agent`.

---

## Settled decisions (do not re-litigate)

| # | Decision | Why |
|---|---|---|
| D1 | Human search is a **browser EventIndex** that implements Element’s existing platform hook (`EventIndexPeg` / `supportsEventIndexing()`), so the **stock Search UX** lights up. | Replaces the N/A banner instead of inventing a parallel UI. |
| D2 | **No Seshat WASM.** Reuse Seshat *semantics* (fields, historic crawl checkpoints, `m.replace` / edits). Replace storage, indexer, and threading. | Native I/O cannot run in the page. |
| D3 | **No Desktop strategy.** Optional personal workaround only. | Product is hosted Web. |
| D4 | **No server-side search, no Synapse plaintext, no searchable-encryption MSC.** Index never leaves the origin. | E2EE scope is client-side only. |
| D5 | **No agent integration** in this work. Invite = ACL. | Separate trust boundary. XSS in Element must not become an agent dump. |
| D6 | Deploy and test on **dev-staging only**. Prod needs a later, explicit confirm. | Standing prod-deploy rule. |
| D7 | Code is production-grade on staging: wipe paths, threat model, tests, audit. No “we’ll harden later.” | Security-product bar. |

---

## Security invariants (fail the PR if any break)

These are the product. Features that violate them do not ship.

1. **Ciphertext at rest.** The on-disk / OPFS / IndexedDB index is encrypted
   (AES-GCM or equivalent). Plaintext event bodies do not persist after the
   wrapping key leaves memory.
2. **Session-bound key.** The wrapping key exists only while the Matrix
   session is unlocked in this origin. It is not in `localStorage`. Prefer a
   non-extractable `CryptoKey`. Derive or wrap from material that dies on
   logout / lock. Leftover ciphertext after a failed wipe must be inert.
3. **Logout = dead index.** Logout, “clear credentials,” and account switch
   must wipe the index **and** drop the key. Same lifecycle as the crypto
   store. Add an explicit wipe on `beforeunload` only as defense-in-depth,
   never as the only path.
4. **No extraction when the app is closed or the user is logged out.** A later
   visit, another origin, or a copied OPFS/IndexedDB dump without the live
   session must not yield message bodies. Physical access to a *locked*
   profile must not yield bodies. (An *unlocked* logged-in tab is in-scope
   for the user; XSS in that tab is the residual risk — same class as the
   existing crypto store. Mitigate with CSP we already ship; do not pretend
   XSS is solved.)
5. **Same-origin, this user, this device only.** No sync of the index to
   another device or to the homeserver. No export API except what Element’s
   EventIndex already exposes to its own UI.
6. **Least data.** Index the same event classes Seshat does for search
   (message body, name, topic — confirm against Seshat `Event` / Desktop
   EventIndex). Do not persist attachments, media bytes, or megolm keys in
   the search store.
7. **No new network observers.** Search queries do not hit Synapse, a sidecar,
   or analytics. Telemetry of query strings is forbidden.
8. **Agents cannot read it.** No `postMessage` wildcard, no localhost daemon,
   no “debug dump” in production builds.

Residual risk you must **document in the audit**, not hand-wave: a logged-in
unlocked tab + XSS can read whatever the page can decrypt. That is already
true of Element’s crypto store. This feature must not make the residual
*worse* (e.g. a plaintext replica that survives logout).

---

## What to build (implementation shape)

Hook **Element’s EventIndex**, do not fork the Search UI.

- Web platform today: `supportsEventIndexing()` is false → N/A banner.
- Desktop: `SeshatIndexManager` behind the same TypeScript interface.
- Our job: a web backend that makes `supportsEventIndexing()` true on
  `dev.element.inblock.io`, so room search and global search use the stock
  screens.

Likely placement (confirm against the **pinned Element tag** in
`dockerfiles/Dockerfile.element`, currently in the 1.12.x line — paths moved
in the monorepo):

- `EventIndexPeg` / platform `getEventIndexingManager()`
- Historic crawl via `/messages` (already how Seshat backfills)
- Live events from the sync / timeline the client already decrypts

Storage/indexer: choose the **smallest** stack that satisfies the invariants.
Candidates to evaluate in that order (Elon: do not add a WASM search engine
if a few-MB in-memory index plus encrypted OPFS blob is enough for our room
sizes):

1. Encrypted OPFS/IndexedDB blob + in-page full text (e.g. MiniSearch) if
   measured memory/CPU is acceptable on a large inblock room.
2. A **wasm-native** indexer (modern Tantivy wasm or equivalent), not Seshat
   0.12.
3. Web Worker so indexing does not jank the UI — only if (1) or (2) needs it.

Reuse Seshat semantics: crawl checkpoints, commit batching, skip replaced
events (`m.replace`). Read `matrix-org/seshat` `Event` + Element Desktop
`SeshatIndexManager` as the contract, not as code to compile.

This lives in `siwx-oidc-matrix-server` the same way other Element deltas do:
a **vendored patch** and/or a small module loaded by the Element image, plus
any `config.json` flag. Prefer a patch that implements the official interface
over a CSS/JS overlay that fakes a search box.

Config is bind-mounted. Images are CI-built. **`ci-deploy.sh` on
dev-aquafire pulls images only; it does not sync `config/` or `entrypoints/`.**
A code change needs a `:dev` image (push `dev` → CI) **and** any bind-mount
edits copied to `/home/dev/matrix-staging/` then `element-web` recreated.
See `docs/2026-07-30-dev-staging-dev-aquafire.md`. Do not `git pull` on the
box (it is not a clean clone). Do not overwrite live `docker-compose` beyond
the lines you need.

---

## Marathon plan (staging)

Work in a feature branch off `dev`. Name suggestion:
`feat/ew-encrypted-search-eventindex`.

### Phase 0 — confirm hook (hours, not days)

- Locate EventIndex types in the **exact Element tag we build**.
- Spike: `supportsEventIndexing() === true` with a stub manager → N/A banner
  gone, Search UI opens, stub results render.
- If the interface cannot be implemented without rewriting Element Search,
  stop and report. Do not invent a side UI.

### Phase 1 — encrypted store + live index

- Persist only ciphertext.
- Index events the client decrypts on sync.
- Search returns EventIndex-shaped hits the stock UI can jump to.

### Phase 2 — historic crawl

- Backfill via the same checkpoint model Seshat uses.
- Progress must be honest in the Security & Privacy “Message search” settings
  (Element already has this pane for Desktop).

### Phase 3 — session lifecycle

- Enable/disable in settings (default: **off** until the user opts in — or
  on if product decides; record the choice in the audit).
- Logout / lock / account switch wipe.
- Failed wipe leaves ciphertext inert.

### Phase 4 — staging deploy

- Image + bind mounts on **dev-aquafire only**.
- Recreate **element-web only**. Do not bounce Synapse, LiveKit, or siwx-oidc.

### Phase 5 — UX e2e (blocking)

Use a **fresh incognito / throwaway account** on `dev.element.inblock.io`.
Existing Playwright under `~/siwx-oidc/e2e/element/` is the home if a spec
fits; otherwise a recorded manual script with screenshots is acceptable for
the first pass, then automate the happy path.

Must pass:

| ID | Test |
|----|------|
| UX1 | Encrypted room: Search is offered (no “desktop only” dead end). |
| UX2 | Send a unique token in a message → search finds it → click opens that event. |
| UX3 | Edit (`m.replace`): search finds **new** body, not the replaced body (or matches Seshat’s documented behaviour — record which). |
| UX4 | After logout + same profile revisit (logged out): search is unavailable; no leftover UI that implies an index. |
| UX5 | After logout, DevTools Application storage: no plaintext bodies in IndexedDB/OPFS/localStorage. Ciphertext blobs optional; must not decode without the session. |
| UX6 | Second account on the same browser profile cannot search the first account’s messages. |
| UX7 | Reload while logged in: index still works (or rebuilds transparently without lying). |
| UX8 | Login / OIDC golden path unchanged (one `/token`, no CORS/issuer errors). Search must not regress SIWX. |

### Phase 6 — security audit (blocking)

Write `docs/audits/2026-MM-DD-encrypted-search-eventindex-audit.md` with:

- Threat model (tab XSS, leftover profile, shared machine, malicious extension,
  stolen OPFS dump, confused-deputy `postMessage`, service worker).
- For each invariant I1–I8: evidence (code pointer + live check on staging).
- Explicit **accepted residuals** (unlocked-tab XSS).
- Confirmation agents have **no** API to the index.
- Confirmation nothing is uploaded to `dev.matrix.inblock.io` except ordinary
  client-server traffic the stock app already does.

Do not mark the marathon done without this file.

---

## Acceptance criteria

| # | Criterion |
|---|-----------|
| AC1 | On `dev.element.inblock.io`, a logged-in user can search E2EE rooms via the **stock Element Search UX** and land on the hit. |
| AC2 | Invariants I1–I8 hold; audit doc signed off in-repo. |
| AC3 | UX1–UX8 pass on staging. |
| AC4 | Prod `element.inblock.io` **unchanged**. |
| AC5 | No agent, Synapse, or well-known change required for search. |
| AC6 | Rollback = previous element-web image + previous bind mounts; index wipe is local to the browser. |

---

## Boundary conditions

- Do **not** deploy to `agentic.inblock.io` / `element.inblock.io`.
- Do **not** `docker compose down` the staging stack. Recreate `element-web` only.
- Do **not** edit the shared Caddyfile unless a security header is *required*
  for this feature (unexpected). If you must, inode-safe edit only
  (`skills/deploy.md`).
- Do **not** weaken CSP to make the indexer easier.
- Do **not** store the wrapping key in `localStorage` or in the service worker.
- Do **not** add `permalink_prefix` / OIDC / theme work to this branch.
- Do **not** invite production consultants into staging test rooms as the
  e2e method; use throwaway accounts.

---

## Context the implementer should open first

| What | Where |
|------|--------|
| This brief | `docs/2026-08-14-HANDOVER-encrypted-search-browser-eventindex.md` |
| Element image / patches | `dockerfiles/Dockerfile.element`, `patches/element-web/README.md` |
| Staging runbook | `docs/2026-07-30-dev-staging-dev-aquafire.md` |
| Staging SSH | `ssh -p 8022 -i ~/.ssh/id_inblock_deploy dev@207.154.209.103` |
| Staging Element | `https://dev.element.inblock.io` |
| Seshat (semantics only) | https://github.com/matrix-org/seshat — `src/database/mod.rs`, `src/events.rs` |
| Desktop native module docs | https://github.com/element-hq/element-desktop/blob/develop/docs/native-node-modules.md |
| Prior Element e2e | `~/siwx-oidc/e2e/element/` |
| Prod-deploy memory | never promote without a new explicit confirm |

---

## Success looks like

A colleague on staging types a phrase they remember, hits Search, and lands
on the encrypted message — without installing Desktop, without the server
learning the query, and without a logged-out browser still holding the
conversation.

When that is true and the audit is in-tree, stop. Ask before any prod
conversation.

Welcome aboard. Build it like the messages are ours.
