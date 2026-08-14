# UX1–UX8 — staging walk (throwaway account)

Target: `https://dev.element.inblock.io`
Do **not** use a production consultant account. Fresh incognito profile.

Pre: `element-web` on dev-aquafire is the image that contains
`browser-eventindex.patch`. Confirm in the page console after login:

```
EventIndex: Successfully initialized the event index
```

and Settings → Security & Privacy → Message search is **not** the
"only available on desktop apps" banner.

## UX1 — Search is offered

1. Open an encrypted room.
2. Open room search (room header search / `Ctrl+F` in-room, or global Search).
3. Pass: no "desktop only" / N/A dead end. Search field accepts input.

## UX2 — Unique token

1. Send a message containing a unique token, e.g. `ewsearch-20260814-alpha`.
2. Wait a few seconds (live index is sync-path).
3. Search for that token.
4. Click the hit.
5. Pass: timeline lands on that event.

## UX3 — Edit

1. Edit the UX2 message to `ewsearch-20260814-beta`.
2. Search `ewsearch-20260814-alpha` — no hit.
3. Search `ewsearch-20260814-beta` — hit, click lands on the same event.
4. Recorded Seshat behaviour: new body, original event id.

## UX4 — Logout

1. Sign out.
2. Pass: logged-out Element does not offer an index. No "N messages indexed"
   leftover UI. Search is unavailable.

## UX5 — Storage

1. Still logged out, DevTools → Application.
2. Inspect `IndexedDB` `inblock-ew-eventindex`, `localStorage`, `sessionStorage`, OPFS.
3. Pass: no plaintext `ewsearch-20260814-*` bodies. Ciphertext blobs optional.

## UX6 — Second account

1. Log in as a *different* throwaway account on the same profile.
2. Search `ewsearch-20260814-beta`.
3. Pass: no hit (unless that account is in the room *and* crawled its own
   decryptable copy — use a room the second account is **not** in).

## UX7 — Reload

1. Log back in as the first account.
2. Reload the tab.
3. Search `ewsearch-20260814-beta`.
4. Pass: hit still works, or the crawler rebuilds and the hit appears
   without a lying "fully indexed" state.

## UX8 — SIWX golden path

1. One `/token` exchange on login (Network).
2. No CORS / issuer errors in console.
3. Pass: search did not regress OIDC.

Capture screenshots into
`docs/audits/2026-08-14-encrypted-search-eventindex-audit.md` §Live staging.
