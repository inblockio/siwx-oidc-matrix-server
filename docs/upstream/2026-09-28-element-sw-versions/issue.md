<!--
Draft for element-hq/element-web, "Bug report for the Element web app" template.
Prepared 2026-09-28. Not filed. When filing, copy the title and the sections below
into the template's fields.
-->

# Title

Media fails to load for the lifetime of the service worker after its /versions check gets an error response

# Steps to reproduce

The service worker decides once whether the homeserver supports authenticated media
(MSC3916), by calling `GET /_matrix/client/versions` with the access token it reads from
IndexedDB, and caches the answer for two hours
(`apps/web/src/serviceworker/index.ts`, `tryUpdateServerSupportMap`). The response is
parsed without a status check:

```ts
const versions = await (await fetch(`${clientApiUrl}/_matrix/client/versions`, config)).json();
serverSupportMap[clientApiUrl] = {
    supportsAuthedMedia: Boolean(versions?.versions?.includes("v1.11")),
    cacheExpiryTimeMs: new Date().getTime() + 2 * 60 * 60 * 1000,
};
```

An error response has no `versions`, so it is cached as "no authenticated media
support". From then on the service worker leaves every media request on the legacy
`/_matrix/media/v3/download|thumbnail` endpoints.

The easiest way to get an error response is an expired access token:

1. Use a homeserver that enforces authenticated media (Synapse with
   `enable_authenticated_media: true`, the default since 1.120) and short-lived access
   tokens. With next-generation auth (MAS, MSC3861) access tokens live 5 minutes by
   default.
2. Sign in to Element Web, open a room with images, then leave the tab idle in a
   text-only room for more than 5 minutes, long enough for the access token to expire
   and for the browser to stop the idle service worker (Chromium does this after about
   30 seconds without events; DevTools, Application, Service workers, "Stop" does the
   same).
3. Open a room with an image that has not been displayed yet in this tab.

The first media request starts a fresh service worker instance with an empty cache. It
reads the stored access token, which has expired but has not been refreshed yet (the
app refreshes on its own next 401), and calls `/versions` with it. The server answers
`401 M_UNKNOWN_TOKEN`.

A 5xx from `/versions` at that moment (a homeserver restart, a proxy error) has the
same effect.

# Outcome

## What did you expect?

Media keeps loading. `/versions` does not require authentication, and whether the server
supports authenticated media does not depend on the user's token, so a rejected token or
a transient error should not decide it.

## What happened instead?

The service worker console shows:

```
[ServiceWorker] /versions response for 'https://matrix.example.org': {"errcode":"M_UNKNOWN_TOKEN","error":"Token is not active"}
[ServiceWorker] serverSupportMap update for 'https://matrix.example.org': {"supportsAuthedMedia":false,"cacheExpiryTimeMs":...}
```

and every thumbnail, avatar and file download of that service worker instance goes to
`/_matrix/media/v3/...`, which a server enforcing authenticated media answers with 404.
Images stay broken after re-opening the room and after a normal reload, because the
same service worker instance (and its cache) serves the reloaded page. They come back
only when the browser stops the service worker again, or after two hours.

We see this in production on a server whose access tokens live 5 minutes, and
reproduced it on a staging deployment of Element Web 1.12.29 in headless Chromium: 1/1
runs in each of two configurations for the idle-tab steps above, and every run of an
automated test that answers the service worker's authenticated `/versions` request with
a 401, or one `/versions` check with a 503.

There is a second, smaller symptom in the same window: the one media request sent with
the expired token gets a 401 even when `/versions` is fine, and that image stays blank
until it is rendered again. That one is a separate problem (the service worker cannot
refresh a token) and is not part of the fix proposed here.

Possibly related: #34842 ("All media 404 in Firefox") and #34897 ("After upgrade to
1.12.27, media not loading"); neither names this mechanism.

# Operating system

Linux (also expected on any OS: the code path is browser independent)

# Browser information

Chromium 14x (Playwright headless) and Chrome desktop

# URL for webapp

Self-hosted Element Web

# Application version

Element Web 1.12.29; the code is unchanged on `develop` as of 2026-09-28

# Homeserver

Synapse 1.161.0 with MSC3861 delegated auth (5-minute access tokens), authenticated media enforced

# Will you send logs?

No (the service worker console lines above are the relevant log)
