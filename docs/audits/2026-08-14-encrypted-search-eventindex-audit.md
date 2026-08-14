# Audit — Encrypted-room search (browser EventIndex)

Date: 2026-08-14
Target: `dev.element.inblock.io` only
Image: `ghcr.io/inblockio/siwx-oidc-matrix-server/element-web:dev` after
`feat/ew-encrypted-search-eventindex` merges to `dev`
Prod: not in scope. `element.inblock.io` is gated off in code.

This file is the blocking Phase-6 deliverable of
`docs/2026-08-14-HANDOVER-encrypted-search-browser-eventindex.md`.

## Product choice (recorded)

`enableEventIndexing` stays at Element's upstream default **`true`**
(`apps/web/src/settings/Settings.tsx`). Same as Desktop. A logged-in user on
staging gets search without a settings click. They can disable it in
Settings → Security & Privacy → Message search. Forced off for the whole
deployment via bind-mount:

```json
"features": { "feature_inblock_encrypted_search": false }
```

## What shipped

Vendored patch `patches/element-web/browser-eventindex.patch`:

- `WebPlatform.getEventIndexingManager()` returns a
  `BrowserEventIndexManager` when the host is `dev.element.inblock.io`
  (or localhost / 127.0.0.1), unless the feature flag above is `false`.
- The manager implements every `BaseEventIndexManager` method the stock
  `EventIndex` / Search UX / EventIndexPanel already call. No parallel UI.
- In-page inverted index (no MiniSearch, no Tantivy, no worker, no WASM).
- AES-GCM records in IndexedDB `inblock-ew-eventindex`. DEK is a
  **non-extractable** `CryptoKey` derived with HKDF-SHA-256 from the
  session pickle key + per-user salt. Info string
  `inblock-ew-eventindex-v1|<userId>|<deviceId>`.
- Historic crawl, live events, checkpoints, `m.replace`, redactions, file
  panel (`loadFileEvents`) all go through Element's existing `EventIndex`.

Seshat semantics reused: event classes `m.room.message` / `m.room.name` /
`m.room.topic`; `m.replace` updates the original event id and indexes
`m.new_content.body`; crawler checkpoints; `addHistoricEvents` returns
`true` only when every event in the batch was already present.

## Threat model

| Threat | Residual | Mitigation |
|---|---|---|
| Tab XSS while logged in | **Accepted.** Same class as the rust-crypto store: an unlocked tab can read whatever the page can decrypt. | Existing CSP (`script-src 'self'`, no `unsafe-inline`). Index is not exposed on `window` except via Element's own `mxEventIndexPeg`. No `postMessage` API. Must not make residual *worse* — no plaintext replica that survives logout. |
| Leftover profile after logout | Ciphertext may remain if wipe fails. | DEK is derived from the pickle key. `Lifecycle.logout` calls `destroyPickleKey` **before** `onLoggedOut` → `EventIndexPeg.deleteEventIndex`. Leftover blobs cannot be opened with a later pickle key. Init that fails decrypt wipes the user's records and starts empty. |
| Shared machine / stolen OPFS/IDB dump | Attacker copies `inblock-ew-eventindex`. | No key in the dump. Salt is public. Pickle key lives in `matrix-react-sdk` / `pickleKey` and is deleted on logout. |
| Malicious extension | Can read DOM and JS memory of an unlocked tab. | Same residual as crypto store. Not a new class. |
| Confused-deputy `postMessage` | Service worker already has a `userinfo` reply on WebPlatform. Search index is not on that channel. | No new `postMessage` listener. Search never posts. |
| Service worker | `sw.js` is not given the DEK or search API. | Key is not in Cache API, not in SW scope. |
| Homeserver / sidecar observer | Search is local. | No fetch of query strings. `/messages` crawl is the same traffic Desktop already does for Seshat. |
| Second account on the same profile | Could see leftover records. | IDB keys are per `userId`. DEK info includes `userId\|deviceId`. User B's pickle key cannot decrypt user A's blobs. |
| Agent / localhost daemon | Out of scope by design. | No export, no debug dump, no agent hook. Invite = ACL. |
| Prod deploy of this image | Hostname `element.inblock.io` is not in the allowlist; manager is `null`. | Flag can force on later. Until then Search stays the stock N/A banner. |

## Invariants

### I1 — Ciphertext at rest

**Code:** `encryptJson` / `decryptJson` in the patch
(`BrowserEventIndexManager.ts`). Every persisted event and checkpoint is
`AES-GCM` with a random 12-byte IV. Plaintext `Uint8Array` is zeroed after
encrypt. Meta store holds only `{userId, deviceId, salt, userVersion}` —
no bodies.

**Unit evidence:** `scripts/browser-eventindex-invariants.mjs` —
`I1 ciphertext at rest is not plaintext JSON` (pass, 2026-08-14).

**Live check (staging):** after a logged-in search, DevTools → Application →
IndexedDB `inblock-ew-eventindex` → `events`. Values are `{iv, ct}` base64.
No message body substring in the ct bytes. Recorded after deploy in
§Live staging.

### I2 — Session-bound key

**Code:** `deriveDek(pickleKey, salt, userId, deviceId)` →
`extractable: false`. `PlatformPeg.getPickleKey` is the IKM.
`Lifecycle.logout` (`apps/web/src/Lifecycle.ts:971`) destroys the pickle
key. The DEK is never written to `localStorage`, `sessionStorage`, or the
service worker. If pickle key is missing, a random session-only DEK is
used and **persist is disabled**.

**Unit evidence:** invariants `I2 leftover ciphertext is inert without the
pickle key`, `I2 AAD binds ciphertext to user+event`, `I5 DEK is
non-extractable`.

**Live check:** logout, then dump IDB — blobs remain optional; they must
not decrypt. A later login creates a new pickle key and, if any leftover
fails decrypt, wipes that user's records.

### I3 — Logout = dead index

**Code:** existing Element path, not a new hook:

1. `logout()` → `destroyPickleKey`
2. `onLoggedOut()` → `clearStorage({deleteEverything:true})` →
   `EventIndexPeg.deleteEventIndex()` → `deleteEventIndex()`
3. `stopMatrixClient()` → `EventIndexPeg.stop()` / `unset()` →
   `closeEventIndex()` (drops the in-memory DEK)

`deleteEventIndex` deletes the user's IDB rows (or the whole DB). Wipe
failure is logged; leftover ciphertext is inert (I2). `beforeunload` is
**not** used as a wipe (that would break reload / UX7). Page death already
drops the in-memory key.

**Live check:** UX4 + UX5.

### I4 — No extraction when closed or logged out

**Code:** `closeEventIndex` / `deleteEventIndex` call `dropKey()`
(`this.dek = null`) and `resetMemory()`. Reload while still logged in
re-derives the DEK from the surviving pickle key and reloads ciphertext
(UX7). A logged-out visit has no pickle key → persist disabled, leftover
undecryptable.

### I5 — Same origin, this user, this device

**Code:** DB name `inblock-ew-eventindex` is origin-scoped. Records keyed
by `userId`. HKDF info includes `userId|deviceId`. No sync, no export
API beyond `BaseEventIndexManager` (consumed only by Element Search /
FilePanel / EventIndexPanel).

### I6 — Least data

**Code:** `EventIndex.isValidEvent` already restricts to
`m.room.message` / `m.room.name` / `m.room.topic`. We index
`extractSearchText` only (body / name / topic / `m.new_content.body`).
`eventHasFile` is a boolean for the file panel, not media bytes.
Megolm session keys are never written — we persist the same event JSON
`EventIndex.eventToJson` already hands Seshat (device identity fields
for re-verify, not room keys).

**Unit evidence:** invariants `I6 only Seshat event classes contribute
search text`.

### I7 — No new network observers

**Code:** `searchEventIndex` is in-process. No `fetch`, no analytics, no
query logging (`log` is used for lifecycle / persist errors, never for
the search term). Historic crawl uses `client.createMessagesRequest` —
identical to Desktop Seshat. No well-known / Synapse / sidecar change.

### I8 — Agents cannot read it

**Code:** no `postMessage` wildcard, no localhost daemon, no debug dump
in the bundle. `window.mxEventIndexPeg` is Element's existing peg; it is
not a new agent API. Agents remain ordinary Matrix users: invite them,
they see events from then on.

## Accepted residuals

- Unlocked-tab XSS can read the live index. Same as the crypto store.
  This feature does **not** leave a plaintext replica after logout.
- Historic crawl issues `/messages` like Desktop. The homeserver sees
  that a client is paginating, not the search query.
- Ciphertext size leaks approximate event counts. Accepted.

## Agents

No API. Confirmed by inspection of the patch (no `postMessage`, no
export, no HTTP). `aqua-matrix-agent` is unchanged.

## Homeserver traffic

Nothing is uploaded to `dev.matrix.inblock.io` except ordinary
client-server traffic the stock app already does (sync, `/messages`
pagination for the crawler, media). Search queries stay in the page.

## Tests

| Layer | Where | Result |
|---|---|---|
| Crypto / search invariants | `scripts/browser-eventindex-invariants.mjs` | 8/8 pass (2026-08-14) |
| Manager unit | patch `BrowserEventIndexManager.test.ts` | shipped in image; run in Element vitest |
| Patch apply | Dockerfile order on v1.12.24 | applies after the five existing patches |
| UX1–UX8 | staging, throwaway account | see §Live staging |

`m.replace` behaviour (UX3): **new body is searchable, old body is
not**; the hit keeps the **original** `event_id` so the timeline jump
lands on the edited event. Matches Seshat `get_replaced_event_id`.

## Rollback

Previous `element-web` image digest + previous bind mounts. The index is
local to the browser; rolling back the image does not need a server-side
wipe. Users can also Settings → Message search → disable, or clear site
data.

## Live staging

Filled after `element-web` is recreated on dev-aquafire.

| Check | Result | Evidence |
|---|---|---|
| UX1 Search offered (no desktop-only dead end) | pending | |
| UX2 unique token → hit → click opens event | pending | |
| UX3 edit: new body only | pending | |
| UX4 logout: search unavailable | pending | |
| UX5 no plaintext bodies in storage | pending | |
| UX6 second account cannot search the first | pending | |
| UX7 reload while logged in still searches | pending | |
| UX8 SIWX login golden path unchanged | pending | |
| Prod `element.inblock.io` `supportsEventIndexing` still false | pending | hostname gate + no prod deploy |
| I1 IDB dump is ciphertext | pending | |
| I7 no search request in Network | pending | |
