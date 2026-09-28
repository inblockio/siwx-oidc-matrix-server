<!--
Draft for element-hq/element-web. Prepared 2026-09-28. Not opened.
Head: inblockio/element-web:fix/sw-versions-not-cached-on-error (3 commits on develop 3af3cbec98)
Base: element-hq/element-web:develop
Replace #<ISSUE> once the issue is filed.
CLA: signed as FantasticoFox (license/cla is green on #34718, same author email).
-->

# Title

Fix media failing to load after the service worker's /versions check hits an expired access token

# Description

Fixes #<ISSUE>

The service worker caches, for two hours, whether the homeserver supports authenticated
media, based on one `GET /_matrix/client/versions`. It parsed that response without a
status check, so an error answer (typically a `401` because the access token it read
from storage had expired before the app refreshed it, or a transient 5xx) was cached as
"no authenticated media support", and every media request of that service worker went
to the legacy endpoints, which 404 on servers that enforce authenticated media.

This PR:

- never caches a failed check: a non-`ok` response, or a response without a `versions`
  list, throws, so the request that hit it is handled as any other rewrite error and the
  next media request checks again;
- retries the check without the access token when the server rejects it with the token.
  `/versions` does not require authentication, and authenticated media support is a
  property of the server, not of the user;
- shares one in-flight check per server between concurrent media requests, so a room
  full of thumbnails does not send one `/versions` request each while the cache is
  empty (and retries do not multiply that).

Possibly related: #34842, #34897.

**Note on #34955:** that PR adds `apps/web/src/serviceworker/index.test.ts`, whose
`fetch` mock returns `{ json }` without `ok`, so it would fail with this change. To avoid
a file conflict the tests here are in `apps/web/src/serviceworker/serverSupport.test.ts`
(same harness pattern). There is no textual conflict in `index.ts` with #34955 or #35220.
Whichever lands second, we will rebase, and if #34955 lands first we will update its
mock to return a real `new Response(...)` and fold these tests in if you prefer one file.

**Label:** this is a bug fix, so please apply `T-Defect` (I cannot set labels).

This PR was generated with AI assistance (Claude) and reviewed by me.

# Testing

- New unit tests (`pnpm vitest run apps/web/src/serviceworker/serverSupport.test.ts`),
  7 cases: authenticated media used when supported; authenticated `/versions` 401 is
  retried anonymously, the URL is still rewritten to `/_matrix/client/v1/media` and the
  discarded body is cancelled; a 502 is not cached and the next request checks again; a
  200 without `versions` is not cached; a server without support is cached as before;
  five concurrent requests send one `/versions` request; the shared check is cleared
  after it fails. Five of the seven fail on `develop`.
- Coverage of the changed lines in `index.ts`: 100% (vitest v8 lcov, compared against
  the diff to `develop`).
- `pnpm lint:fmt`, `pnpm lint:js` and `tsc --noEmit` for `apps/web` pass.
- Manually, on a Synapse deployment with 5-minute access tokens and authenticated media
  enforced: stop the idle service worker after the access token has expired (DevTools,
  Application, Service workers, Stop), then open a room with an image not yet shown.
  Before: the service worker console logs the `M_UNKNOWN_TOKEN` body as the `/versions`
  response, caches `supportsAuthedMedia: false`, and the image 404s on
  `/_matrix/media/v3`. After: it logs `returned 401 with a token; retrying without one`,
  caches `supportsAuthedMedia: true`, and media requests go to `/_matrix/client/v1/media`.
  We also run this change in an automated browser test that answers the service
  worker's authenticated `/versions` with a 401, and one `/versions` check with a 503;
  both fail against the stock service worker and pass with this change.

## Checklist

- [x] I have read through [review guidelines](https://github.com/element-hq/element-web/blob/develop/docs/review.md) and [CONTRIBUTING.md](https://github.com/element-hq/element-web/blob/develop/CONTRIBUTING.md).
- [x] I have linked the PR to an issue that describes what needs changing.
- [x] I have written tests for new code (and old code if feasible).
- [x] I have ensured new or updated `public`/`exported` symbols have accurate [TSDoc](https://tsdoc.org/) documentation. (No exported symbols change.)
- [x] I have confirmed linter and other CI checks pass. (Locally: `lint:fmt`, `lint:js`, types, the new tests. CI will confirm.)
- [ ] I have have included screenshots if what the user sees will change. (Not applicable: the visible change is that images load.)
- [x] I have licensed the changes to Element by completing the [Contributor License Agreement (CLA)](https://cla-assistant.io/element-hq/element-web)
- [x] I will no longer force push to this branch
