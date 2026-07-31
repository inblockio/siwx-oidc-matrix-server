# Element / Matrix deployment-hardening audit checklist

Task B1 of `docs/superpowers/plans/2026-07-31-element-hardening-marathon.md` (H5).
Companion script: `scripts/element-deploy-audit.sh`.

Stack in scope: Element Web (source-built, nginx-unprivileged container) behind
Caddy at `element.inblock.io` (prod) / `dev.element.inblock.io` (staging);
Synapse behind Caddy at `matrix.inblock.io` / `dev.matrix.inblock.io`. Cache
correctness is first-class here, on equal footing with security headers,
because of the 2026-07-31 incident (unhashed manifests with no
`Cache-Control` + a wedged service worker broke downloads and i18n labels —
see `docs/superpowers/plans/2026-07-31-sw-hardening-handover.md`).

Live probe date: 2026-07-31. Findings below marked "current state" were taken
with plain `curl -I` against the four live origins on that date; re-run
`scripts/element-deploy-audit.sh` for a current read.

## Sources consulted

| # | Source | URL | One-line takeaway |
|---|--------|-----|--------------------|
| S1 | element-web `apps/web/README.md` — Important Security Notes | https://github.com/element-hq/element-web/blob/develop/apps/web/README.md#important-security-notes | Recommends `X-Frame-Options: SAMEORIGIN`, CSP `frame-ancestors 'self'`, `X-Content-Type-Options: nosniff`, `X-XSS-Protection: 1; mode=block`, and separate client/homeserver domains. |
| S2 | element-web `apps/web/README.md` — Caching requirements | https://github.com/element-hq/element-web/blob/develop/apps/web/README.md#caching-requirements | "Element requires the following URLs not to be cached... `/config.*.json`, `/i18n`, `/version`, `/index.html`"; recommends `Cache-Control: no-cache` for `/`. |
| S3 | element-web `docs/install.md` | https://github.com/element-hq/element-web/blob/develop/docs/install.md | "Familiarise yourself with the Important Security Notes... they apply to all installation methods"; HTTPS required ("for the security of your chats"). |
| S4 | element-web upstream reference nginx template (what the OFFICIAL Docker image actually ships) | https://github.com/element-hq/element-web/blob/v1.12.24/apps/web/docker/nginx-templates/default.conf.template | Ships `Cache-Control: no-cache` on `/index.html`, `/version`, `/i18n/`, `/config*` — and **nothing else**. No security headers at all; the README's header recommendations are opt-in, not defaulted even in Element's own image. |
| S5 | Synapse `docs/reverse_proxy.md` | https://github.com/element-hq/synapse/blob/develop/docs/reverse_proxy.md | Reverse proxy must forward `X-Forwarded-For` and `X-Forwarded-Proto`; "must not canonicalise or normalise the requested URI in any way"; `client_max_body_size` should match `max_upload_size`; every listener exposes `/health` -> 200 OK. |
| S6 | Matrix spec (ratified MSC1929) — `GET /.well-known/matrix/support` | https://spec.matrix.org/latest/client-server-api/#getwell-knownmatrixsupport | Schema: `{"contacts":[{"matrix_id"?, "email_address"?, "role"}], "support_page"?}`, `role` one of `m.role.admin` / `m.role.security` (or a namespaced id); "Rate-limited: No", "Requires authentication: No"; served over HTTPS on the homeserver's hostname (server_name), may be served by a different webserver than the homeserver itself. |
| S7 | nginx official docs — `server_tokens` | https://nginx.org/en/docs/http/ngx_http_core_module.html#server_tokens | `server_tokens on \| off \| build \| string;` default `on`; controls "emitting nginx version on error pages and in the Server response header field." |
| S8 | MDN — `Strict-Transport-Security` | https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Strict-Transport-Security | Preload needs `max-age >= 31536000` + `includeSubDomains`; "each subdomain host should include Strict-Transport-Security headers in its responses even if the superdomain uses includeSubDomains, because a browser may contact a subdomain host before the superdomain" (the includeSubDomains footgun). |
| S9 | RFC 6797 §8.1 (IETF, the HSTS standard) | https://www.rfc-editor.org/rfc/rfc6797.html#section-8.1 | "If a UA receives more than one STS header field in an HTTP response message over secure transport, then the UA MUST process only the first such header field." (first-header-wins; already load-bearing in `Caddyfile.dev-aquafire`'s `(hsts)` snippet, which this checklist reuses). |

No MSC1929 requirement needed the pre-ratification proposal text (S6, the
ratified spec, supersedes it) — the GitHub PR at
`matrix-org/matrix-spec-proposals#1929` was not fetched because the API call
to enumerate its files 401'd (stale/rotating `gh` credential, unrelated to
this task) and the ratified spec page is the better citation anyway.

## Section 1 — Security headers, element origin

| Requirement | Official source | How we check it | Where fixed in our stack |
|---|---|---|---|
| `X-Frame-Options: SAMEORIGIN` | S1: `add_header X-Frame-Options SAMEORIGIN;` | `curl -sI https://<element-origin>/ \| grep -i x-frame-options` | **Not currently set anywhere.** Add in `config/element-nginx.conf` (rides CI, matches S4's own template shape) **or** at the Caddy edge (`Caddyfile.production` / `Caddyfile.dev-aquafire`, `element.inblock.io { }` block) — Caddy is the mandated proxy per this repo's ops directives, and it already carries the equivalent `(hsts)` snippet pattern, so a `(security_headers)` snippet there is the more consistent home. |
| CSP `frame-ancestors 'self'` | S1: "the modern replacement for X-Frame-Options (though both should be included since not all browsers support it yet)" | `curl -sI https://<element-origin>/ \| grep -i content-security-policy` — value must contain `frame-ancestors 'self'` | Same as above. Must not clobber any existing `script-src 'self'` CSP the app itself may later add (S1: "if you are already setting a Content-Security-Policy header elsewhere, you should modify it to include the frame-ancestors directive instead of adding that last line") — currently we set none, so a fresh header is safe. |
| `X-Content-Type-Options: nosniff` | S1: "to disable MIME sniffing" | `curl -sI https://<element-origin>/ \| grep -i x-content-type-options` | Not currently set. Same fix location as above. |
| `X-XSS-Protection: 1; mode=block` | S1: "for basic XSS protection in legacy browsers" | `curl -sI https://<element-origin>/ \| grep -i x-xss-protection` | Legacy header, modern browsers ignore it (Chrome removed the feature); S1 still lists it, so include it for parity with the documented recommendation. Not currently set. |
| HSTS present, `max-age >= 15552000` (180d; 31536000/1y preferred) | S8 (preload baseline 31536000); S9 (single-header semantics, informs the `?`-default Caddy directive) | `curl -sI https://<element-origin>/ \| grep -i strict-transport-security` then check `max-age=` numerically | **dev.element.inblock.io: PASS** (`max-age=31536000`, via `Caddyfile.dev-aquafire`'s `(hsts)` snippet). **element.inblock.io (prod): FAIL** — `Caddyfile.production` has no `(hsts)` import on the `element.inblock.io` block at all. Fix: add the same `?Strict-Transport-Security` default-header snippet used in `Caddyfile.dev-aquafire` to `Caddyfile.production`. |

**No `includeSubDomains`.** Per the task's explicit caution and S8's own
warning, `element.inblock.io` / `matrix.inblock.io` / `dev.*` are per-host
HSTS only (matches current `(hsts)` snippet in `Caddyfile.dev-aquafire`,
verbatim: `header ?Strict-Transport-Security "max-age=31536000"` — no
`includeSubDomains`). Do not add it until every `*.inblock.io` subdomain is
verified HTTPS-only; `preload` is explicitly out of scope for this checklist.

## Section 2 — Cache-Control correctness (equal priority: incident + official)

Columns: **Basis** = OFFICIAL (S1–S4) or INCIDENT-DERIVED (2026-07-31 SW/cache
incident, no upstream doc covers our own `sw-boot.js`/`usercontent/`/stamp
files because they don't exist upstream).

| Path | Required value | Basis | How we check it | Where fixed |
|---|---|---|---|---|
| `/` and `/index.html` | `no-cache` (official minimum) — we go further with `must-revalidate` | OFFICIAL (S2, S4) | `curl -sI https://<element-origin>/index.html \| grep -i cache-control` | `config/element-nginx.conf` `location = /index.html` — **already fixed** (`no-cache, must-revalidate`), confirmed live on dev+prod 2026-07-31. |
| `/version` | `no-cache` | OFFICIAL (S2: listed verbatim; S4: ships `Cache-Control: no-cache`) | `curl -sI https://<element-origin>/version` | `config/element-nginx.conf` `location = /version` — fixed in-repo, **live on dev, NOT yet live on prod** (see deploy-lag note below). |
| `/config.json` (S2's `/config.*.json` pattern) | `no-cache` | OFFICIAL (S2, S4) | `curl -sI https://<element-origin>/config.json` | `config/element-nginx.conf` `location = /config.json` — fixed in-repo, **live on dev, NOT yet live on prod**. |
| `/i18n/languages.json` (S2's `/i18n` pattern) | `no-cache` | OFFICIAL (S2, S4: whole `/i18n/` prefix) | `curl -sI https://<element-origin>/i18n/languages.json` | `config/element-nginx.conf` `location /i18n/` — **already fixed**, confirmed live. This is also the 2026-07-31 dev regression trigger (stale manifest -> 404 on hashed lang file -> raw i18n keys rendered), so it is doubly load-bearing. |
| `/sw-boot.js` | `no-cache, must-revalidate` | INCIDENT-DERIVED — this file does not exist upstream (S4's template has no such location); it is our own same-origin SW-liveness boot shim, injected 2026-07-31. Not grounded in an official source; the *reasoning* (stable-named entry file referenced from `index.html`, same staleness class as `/index.html` itself) directly mirrors S2/S4's rationale but the specific file is ours. | `curl -sI https://<element-origin>/sw-boot.js` | `config/element-nginx.conf` `location = /sw-boot.js` — **already fixed**, confirmed live. |
| `/usercontent/` (download iframe doc, served at `/usercontent/index.html`) | `no-cache, must-revalidate` | INCIDENT-DERIVED — third unhashed entry document found during the 2026-07-31 RCA; not named in S2/S4 because it is not part of upstream's documented cache-sensitive set, but it is structurally identical to `/index.html` (unhashed doc naming a hashed bundle). | `curl -sI https://<element-origin>/usercontent/index.html` | `config/element-nginx.conf` `location = /usercontent/index.html` — **already fixed**, confirmed live. |
| `/bundles/<hash>/*` | Bounded: `public, max-age=14400, must-revalidate` | INCIDENT-DERIVED for the specific ceiling — S2/S4 only mandate *not caching the manifests*; they say nothing about the hashed bundles themselves (correctly: content-hashed paths are safe to cache indefinitely). The 4h bound matches observed `app.element.io` behavior (not independently re-verified as official policy here) and was chosen defensively during the incident response, not sourced from S1–S4. | `curl -sI https://<element-origin>/bundles/<hash>/bundle.js` (script discovers the live hash by scraping `index.html`) | `config/element-nginx.conf` `location /bundles/` — fixed in-repo, **live on dev, NOT yet live on prod**. |
| `/sw.js` | Bounded: `public, max-age=14400, must-revalidate` | INCIDENT-DERIVED (same reasoning as `/bundles/`; browsers bypass the HTTP cache for SW update checks by default per the spec `updateViaCache:"imports"`, so this mainly bounds non-update fetches). | `curl -sI https://<element-origin>/sw.js` | `config/element-nginx.conf` `location = /sw.js` — fixed in-repo, **live on dev, NOT yet live on prod**. |
| `sw.js` per-build byte-identity stamp (`// build: <hash> <UTC ts>` in the tail) | Present, and must differ across consecutive deploys | INCIDENT-DERIVED — the 2026-07-31 wedged-service-worker incident: our source builds otherwise produce byte-identical `sw.js` across deploys, so a wedged `respondWith()` that never settles survives every redeploy silently (no upstream doc addresses this; it is a consequence of building `sw.js` from source rather than using a version-stamped upstream release artifact). | `curl -s https://<element-origin>/sw.js \| tail -c 200 \| grep -q '// build:'` | `dockerfiles/Dockerfile.element` (`RUN test -s /app/sw.js && printf '\n// build: %s %s\n' ...`) — **code present but NOT YET LIVE** on either dev or prod as of the 2026-07-31 probe (`git status` shows this Dockerfile change is still unstaged/undeployed; live `curl` of both `dev.element.inblock.io/sw.js` and `element.inblock.io/sw.js` tails end at `//# sourceMappingURL=sw.js.map` with no stamp). Expected FAIL until Task A2/A3 (dev validation + prod promotion) land. |

### Prod deploy lag (found running the audit script, 2026-07-31)

`git log -- config/element-nginx.conf` shows `1b03eb1 fix(element): full
app.element.io cache-header parity sweep` (the commit that added the `/version`,
`/config.json`, `/bundles/`, `/sw.js` location blocks) landed **2026-07-31
19:23 +0200, today** — after dev-aquafire's CD had already converged (auto-
converge is ~9–17 min per push) but before anyone ran the manual prod deploy
step (`docker compose pull siwx-oidc && ... up -d`, per this repo's CLAUDE.md
"Deploys are MANUAL, not automatic"). Live probe confirms the split exactly:
prod has `Cache-Control: no-cache, must-revalidate` on `/index.html` and
`/i18n/` (older commits, already promoted) but **empty/absent** `Cache-Control`
on `/version`, `/config.json`, `/bundles/*`, `/sw.js` (this commit, not yet
promoted). This is not a config defect — the fix is already correct in
`config/element-nginx.conf` — it is purely a "hasn't been deployed to prod
yet" gap, expected to close once the prod promotion step in the marathon
plan's Task A3/B2 runs.

### "Old bundle retention across deploys" — could not ground in an official source

The task brief asked for upstream guidance on "how new bundles + old bundle
retention should be handled across deploys." Checked S1–S4 in full (fetched
raw `apps/web/README.md` and `docs/install.md` verbatim, 2026-07-31): **no
such guidance exists in current upstream docs.** There is no "Upgrading
Element Web" section, no mention of blue-green deploys, no mention of keeping
previous hashed-bundle directories reachable. Marking this
**INCIDENT-DERIVED / NOT APPLICABLE**, not inventing a citation:

- Our deploy model (source-built, single-stage Docker image, `COPY
  --from=builder /src/apps/web/webapp /app`) has no shared/persistent volume
  across builds — each container image is a fully self-contained,
  from-scratch build. There is no "old bundle" left lying around to retain or
  garbage-collect; the failure mode this concern usually protects against
  (a still-open browser tab requesting a bundle hash that a *live* deploy just
  deleted mid-session) is a real but *separate* risk from what S2's
  no-cache-the-manifest rule already covers (a browser that revalidates
  `index.html`/`languages.json` on next navigation always gets the *current*
  manifest naming *currently-present* bundles — it can never point at a bundle
  the running container doesn't have, because manifest and bundles are shipped
  from the same image). The open residual risk — a tab kept open *across* a
  deploy, mid-session, requesting an old hash after the new container replaces
  the old one — is not mitigated by any documented upstream mechanism and is
  out of scope for this checklist; it would require e.g. a CDN/object-storage
  bundle history, which this stack does not have.

## Section 3 — Matrix/Synapse reverse-proxy correctness

| Requirement | Official source | How we check it | Where fixed |
|---|---|---|---|
| Reverse proxy forwards `X-Forwarded-For` | S5: "you should configure your reverse proxy to forward requests to `/_matrix` or `/_synapse/client` to Synapse, and have it set the `X-Forwarded-For`... request header[]" | Cannot be checked externally with curl alone (it's what WE send, not what we receive back) — verify in Caddy config instead: `grep -c reverse_proxy Caddyfile.production` blocks use Caddy's default behavior, which sets `X-Forwarded-For`/`X-Forwarded-Proto`/`X-Forwarded-Host` automatically (Caddy `reverse_proxy` default; no explicit directive needed, unlike nginx). | Caddy default — **already correct**, no action needed (Caddy's `reverse_proxy` always sets these; nginx would need explicit `proxy_set_header`). Config-review check, not curl-checkable; the audit script does not test this. |
| Reverse proxy must not canonicalise/normalise the request URI | S5: "Your reverse proxy must not canonicalise or normalise the requested URI in any way (for example, by decoding %xx escapes)"; Apache needs `nocanon` | N/A for Caddy (Apache-specific footgun named in S5); Caddy does not canonicalize path-encoded segments by default. Config-review only. | N/A — we run Caddy, not Apache. Documented here so the Apache-specific trap is never reintroduced if the proxy is ever swapped (it will not be — Caddy is the mandated proxy). |
| `client_max_body_size` >= `max_upload_size` | S5: "Increase `client_max_body_size` to match `max_upload_size` defined in `homeserver.yaml`" | Config review: compare Caddy's `request_body { max_size ... }` (if set) against Synapse's `max_upload_size`. Caddy has **no default body-size limit** (unlike nginx's 1MB default), so if `homeserver.yaml` doesn't cap it either, uploads are unbounded at the edge. | `Caddyfile.production`'s `matrix.inblock.io` block sets **no** `request_body` cap (confirmed by reading the file — only the migrated `dev-aquafire` legacy vhosts get `legacy_body_limit`). Verify `max_upload_size` is set in Synapse's `homeserver.yaml`/env and is the effective cap; add a matching Caddy `request_body` limit if defense-in-depth at the edge is wanted. Not curl-checkable without attempting an oversized upload (destructive) — the audit script does not test this; config-review item only. |
| `/health` returns 200 | S5: "Each configured HTTP listener has a `/health` endpoint which always returns 200 OK" | `curl -s -o /dev/null -w '%{http_code}' https://<matrix-origin>/health` | Already reachable through Caddy's catch-all `handle { reverse_proxy matrix_synapse:8080 }` — confirmed live 200 on `dev.matrix.inblock.io` 2026-07-31. Not currently asserted by the audit script (WARN-only informational check would be reasonable; omitted from the delivered script to stay within the requested check list). |
| HSTS present on matrix origin | S8, S9 | `curl -sI https://<matrix-origin>/ \| grep -i strict-transport-security` | **dev.matrix.inblock.io: PASS** (`max-age=31536000` via `Caddyfile.dev-aquafire`'s `(hsts)` import). **matrix.inblock.io (prod): FAIL** — same gap as the prod element origin; `Caddyfile.production`'s `matrix.inblock.io` block has no `(hsts)` import. |

## Section 4 — MSC1929 `/.well-known/matrix/support`

| Requirement | Official source | How we check it | Where fixed |
|---|---|---|---|
| Served at `https://<server_name>/.well-known/matrix/support`, HTTP 200, JSON with a `contacts` array (each with `role` + `matrix_id` and/or `email_address`) and/or `support_page` | S6 (ratified spec): schema + "Rate-limited: No, Requires authentication: No"; may be served by a different webserver than the homeserver itself | `curl -s https://<server_name>/.well-known/matrix/support -w '\n%{http_code}'` then check for `"contacts"` key | **Not served anywhere** — confirmed live 2026-07-31: `matrix.inblock.io/.well-known/matrix/support` -> 404 (Synapse's own "No Such Resource" body, i.e. Synapse itself isn't configured to serve it and nothing intercepts it upstream); `dev.matrix.inblock.io/.well-known/matrix/support` -> same 404. Fix: add a `handle /.well-known/matrix/support { respond \`{...}\` }` block to both Caddyfiles, same pattern already used for `/.well-known/matrix/server` and `/.well-known/matrix/client` in `Caddyfile.production` / `Caddyfile.dev-aquafire`. |
| Same origin as `server_name`; consumed by MSC1929-aware tooling (not the Matrix Federation Tester, which primarily checks `/.well-known/matrix/server`) | S6 ("may be served by another webserver"); observed consumer: `etkecc/go-msc1929` (used by the Matrix Rooms Search project to auto-discover admin/support contacts during room-directory crawls) — https://github.com/etkecc/go-msc1929 | Same curl as above, at the `server_name` origin specifically | In our topology `SYNAPSE_SERVER_NAME` **equals** the matrix origin host (`matrix.inblock.io` / `dev.matrix.inblock.io` — no federation-port-delegation split), confirmed via `docker-compose.yml`/`docker-compose.dev-staging.yml` env (`MATRIX_HOST` feeds both `SYNAPSE_SERVER_NAME` and `SIWEOIDC_MATRIX_SERVER_NAME`). So "matrix origin" and "server-name origin" are the same URL here; the audit script still accepts an explicit `--server-name` override for correctness if that topology ever changes (e.g. a bare `inblock.io` server_name with `.well-known/matrix/server` delegation). |

## Section 5 — Version disclosure

| Requirement | Official source | How we check it | Where fixed |
|---|---|---|---|
| nginx `server_tokens off` (suppress version in `Server` header + error pages) | S7: default is `server_tokens on`; the directive's whole purpose per the official doc is "enables or disables emitting nginx version... in the Server response header field" | `curl -sI https://<element-origin>/ \| grep -i ^server:` — FAIL if it contains a version number | **FAIL, confirmed live 2026-07-31**: both `element.inblock.io` and `dev.element.inblock.io` return `server: nginx/1.31.3`. Fix: add `server_tokens off;` to `config/element-nginx.conf`'s `http`/`server` context (note: the base `nginxinc/nginx-unprivileged` image's `nginx.conf` is NOT replaced by our `default.conf` overlay — confirm the directive lands in a block nginx actually applies, e.g. add it inside the `server { }` block in `config/element-nginx.conf`, valid per S7's context list `http, server, location`). |
| Hide Synapse's `Server` header at the reverse proxy | Not a Synapse config option (Synapse/Twisted has no `server_tokens` equivalent) — this is a reverse-proxy-layer concern, same category as S7's nginx directive but for our actual edge (Caddy) | `curl -sI https://<matrix-origin>/ \| grep -i ^server:` — FAIL if it contains a version number | **FAIL, confirmed live 2026-07-31**: both `matrix.inblock.io` and `dev.matrix.inblock.io` return `server: Synapse/1.154.0`. Fix: `header_down -Server` (or `header_down Server "Synapse"` to replace rather than strip — Caddy syntax already established in this repo's `(strip_upstream_cors)` snippet, e.g. `Caddyfile.production` line 3) in the `matrix.inblock.io` block of both Caddyfiles. |

## Accepted deviations

**Client/server domain separation.** S1 ("Separate domains"): "We do not
recommend running Element from the same domain name as your Matrix
homeserver... risk of XSS... See
https://github.com/element-hq/element-web/issues/1977 for more details."

`element.inblock.io` and `matrix.inblock.io` share the registered domain
`inblock.io` (differ only by subdomain — not the "separate domain name"
upstream means, which is about eTLD+1 separation, e.g. `element.example.com`
vs. `chat.example.org`).

**RECORDED AS ACCEPTED by Tim, 2026-07-31.** No change planned. Revisit only
on a new domain purchase. `element-deploy-audit.sh` prints `SKIP (accepted
deviation, recorded 2026-07-31)` for this item rather than PASS/FAIL/WARN.

## Current-state summary (from actually running `scripts/element-deploy-audit.sh`, 2026-07-31)

| Check | dev.element / dev.matrix | element / matrix (prod) |
|---|---|---|
| XFO / CSP / XCTO | FAIL (none set) | FAIL (none set) |
| HSTS | PASS (31536000, both origins) | **FAIL (absent, both origins)** |
| Cache-Control: `/`, `/index.html`, `/i18n/languages.json`, `/sw-boot.js`, `/usercontent/` | PASS (all 5) | PASS (all 5) |
| Cache-Control: `/version`, `/config.json`, `/bundles/*`, `/sw.js` | PASS (all 4) | **FAIL (all 4 — deploy lag, see above; header absent, not misconfigured)** |
| sw.js build stamp | FAIL (Task A1/A3 not deployed yet) | FAIL (Task A1/A3 not deployed yet) |
| Server banner | FAIL (`nginx/1.31.3` / `Synapse/1.154.0`) | FAIL (`nginx/1.31.3` / `Synapse/1.154.0`) |
| `/.well-known/matrix/support` | FAIL (404) | FAIL (404) |
| `/version` returns content | PASS (`1.12.24`) | PASS (`1.12.24`) |
| Federation `/_matrix/federation/v1/version` | WARN (informational, HTTP 200) | WARN (informational, HTTP 200) |
| Domain separation | SKIP (accepted deviation) | SKIP (accepted deviation) |

**Script totals:** dev = 14 PASS / 1 WARN / 7 FAIL (exit 1). prod = 8 PASS / 1
WARN / 13 FAIL (exit 1). Full raw output of both runs is in the task's return
data; re-run the script for a fresh read.

These are the expected findings for Task B1 (audit only); Task B2 in the
marathon plan fixes them. Prod's larger FAIL count is Real + expected: it
carries both the shared gaps (headers, HSTS, banners, MSC1929) *and* the
deploy-lag gap above that dev has already outrun via CD.
