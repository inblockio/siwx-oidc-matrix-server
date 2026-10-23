# Directory search module

`inblock_directory` is a Synapse module that lets an admitted **service account** ask
"whom may this person find under this term?" and get exactly the people Synapse's own
user directory would show that person, each with the raw `io.inblock.did` profile field
(the DID and the provider's proof). It is lookup only: it never verifies the proof and it
grants nothing. The caller verifies the proof against siwx-oidc's JWKS.

Code: `synapse-modules/inblock_directory/`. Tests: `synapse-modules/run-tests.sh`.
Design and the consumers (a Rust client, a node's share dialog): aqua-ops
`docs/directory-registry/plan.md` (PR #204), section 4.2 is this contract.

## Endpoint

`POST /_synapse/client/io.inblock/directory/v1/search` on the client listener. POST, so
the search term stays out of access logs. The path reaches Synapse through a proxy
catch-all; no proxy rule is needed. Only POST is served.

Request (JSON object, at most 4 KiB), authenticated with the service's Matrix access
token as `Authorization: Bearer ...`:

```json
{ "asker": "@person:example.org", "term": "ada", "limit": 10 }
```

- `asker`: a Matrix user ID, printable, no spaces, at most 255 characters.
- `term`: a string, 1 to 64 characters after trimming, no control characters, and text that
  UTF-8 can encode (a JSON escape for a lone surrogate such as `\ud800` is refused; a
  surrogate pair is one character and fine). The trimmed value is what Synapse searches for.
- `limit`: an integer from 1 to `max_limit`; default 10 (or `max_limit` when that is lower).

Response `200`:

```json
{ "results": [
    { "user_id": "@ada:example.org", "display_name": "Ada",
      "did_field": { "did": "did:key:z...", "proof": "..." } },
    { "user_id": "@remote:other.example", "display_name": "Remy" } ],
  "limited": false }
```

- Rows come back in Synapse's order, remote users included, so the set equals what
  `/_matrix/client/v3/user_directory/search` returns for the same asker. Synapse's
  `avatar_url` is not passed on.
- `did_field` is the user's `io.inblock.did` profile value as stored (normally
  `{"did", "proof"}`). It is absent for remote users and for users without the field.
  Treat it as untrusted until verified.

## Who gets what

| Case | Answer |
|---|---|
| No token or an invalid token | `401 M_UNKNOWN_TOKEN` (Synapse alone would say `M_MISSING_TOKEN` for no token; the contract says one code) |
| Requester is an application service (an appservice token, whatever `user_id` it names) | `403 M_FORBIDDEN` |
| Requester not in `admitted_services`, or its account is deactivated, locked or guest-typed, or the account lookup fails | `403 M_FORBIDDEN` |
| A valid token whose user has no `users` row, an admitted MXID included | `500 M_FORBIDDEN`, error text `User not found`: Synapse's own auth (`api/auth/mas.py`) answers before the module runs, so this is not the module's 403 |
| Body too large | `413 M_TOO_LARGE` |
| Body not JSON or not an object | `400 M_NOT_JSON` / `400 M_BAD_JSON` |
| `asker`, `term` or `limit` out of bounds, or a `term` that is not encodable as UTF-8 | `400 M_INVALID_PARAM` |
| `user_directory.enabled` is false | `{"results": [], "limited": false}` |
| Asker not a local user, or missing, deactivated, locked or guest-typed (or the lookup fails) | `{"results": [], "limited": false}`, and the search is not run |
| Per-asker rate limit exceeded | `429 M_LIMIT_EXCEEDED` |
| The search itself fails | `500 M_UNKNOWN`, fixed text |

The **account check** reads the `users` row: it must exist, not be deactivated, not be
locked, and its `user_type` must not be the guest marker (Synapse's own guest flag is never
set under delegated auth, so the user type is the only signal). The marker is the
`guest_user_type` setting, `io.inblock.guest` unless the entrypoint passes another value
(`GUEST_POLICY_USER_TYPE`, the one the guest policy module is configured with). Synapse's
token check does not look at locked or deactivated accounts, which is why the module does;
the check runs on every request, so locking an admitted service takes effect at once even
while Synapse still caches the token. A missing row never reaches the module (see the
`500 User not found` row above); the module's own check for it is a second line.

An **application service** token never gets results. An appservice names the user it acts
as with `?user_id=`, so with an admitted service's MXID inside its namespace it would look
like that service; the module refuses any requester that is an application service
(`requester.app_service_id` is set). A service signs in as an ordinary user.

The empty answer for a bad asker has the same body as "no match", **but it does not hide
whether an asker exists, and an admitted service can tell**: a missing, deactivated, locked,
guest-typed or remote asker always gets the empty object, an existing one gets at least the
members of public rooms when there are any, and only an existing asker's bucket ever reaches
the rate limit's `429` (a bad asker returns before the limiter). So a service can learn
whether an MXID is a live local account. That is accepted: whether a DID has an account is
already public through siwx-oidc `GET /resolve`, which anyone can call. The check exists so
that Synapse's search is not run for an asker that does not exist (it would still return the
members of public rooms), not to keep accounts secret.

The **rate limit** is Synapse's own limiter with the `rc_user_directory` settings, one
bucket per asker.

## Configuration

```yaml
modules:
  - module: inblock_directory.DirectoryModule
    config:
      admitted_services: ["@dir-service:example.org"]
      max_limit: 20
      guest_user_type: io.inblock.guest
      did_field: io.inblock.did
```

- `admitted_services` (required): non-empty list of Matrix user IDs. Every entry must be
  well formed and a user of this homeserver; otherwise Synapse refuses to start. The list
  is per environment and public: it names accounts, not secrets.
- `max_limit` (optional, default 20): 1 to 50 (Element's own search clamps at 50).
- `guest_user_type` (optional, default `io.inblock.guest`): the `user_type` that marks a guest
  account, which is neither an admitted service nor an asker. 1 to 255 characters from
  `A-Za-z0-9._-`. It must be the value the guest policy module uses.
- `did_field` (optional, default `io.inblock.did`): the profile field whose raw value
  becomes `did_field` in a row. Synapse's identifier grammar `^[a-z][a-z0-9_.-]{0,254}$`.
  It must be the field siwx-oidc writes and the field protection denylists.
- Any other key is refused.

The Synapse image bakes the module in (`dockerfiles/Dockerfile`) and
`entrypoints/matrix_server.sh::apply_directory_search` registers it on every boot, from
environment variables (they reach the container through `.env`; see `env.example`):

| Variable | Meaning |
|---|---|
| `DIRECTORY_ADMITTED_SERVICES` | Comma separated MXIDs; spaces around a comma are ignored. Unset or empty: the module is **not** registered and an entry from an earlier boot is removed. Any malformed entry, or a module that cannot be imported, refuses to start. |
| `DIRECTORY_MAX_LIMIT` | Optional, 1 to 50. |
| `GUEST_POLICY_USER_TYPE` | Not a setting of this module: read, with the guest policy's default `io.inblock.guest`, and written as `guest_user_type` on every boot. A value outside `A-Za-z0-9._-` (1 to 255 characters) refuses to start. |
| `SIWX_DID_PROFILE_FIELD` | Not a setting of this module: read, with the field protection's default `io.inblock.did`, and written as `did_field` on every boot. A value outside Synapse's identifier grammar refuses to start. |

The two last values are checked only when `DIRECTORY_ADMITTED_SERVICES` is set, and the
refusal never prints them.

The function removes its own `modules:` entry and adds it again, so other modules stay,
and it runs before `apply_did_field_protection`, which stays last.

## Logs

One INFO line per query on the logger `inblock_directory`:

```
directory search: requester=@dir-service:example.org asker=@person:example.org results=3
```

**The term is never logged**, nor the request body, nor an exception message from the
search (an error logs the exception class only). The module does not use Synapse's JSON
body helper because that helper logs the body when it cannot parse it. One thing the
module cannot cover: Synapse's own database logger (`synapse.storage.SQL`) prints query
arguments at DEBUG, which includes the term, as it does for Element's own search. Do not
run that logger at DEBUG in production.

## Cutting a service off

In this order, fastest first: remove it from `DIRECTORY_ADMITTED_SERVICES` and restart
Synapse (immediate); lock or deactivate its account (the module refuses a locked or
deactivated requester at once); delete its device and its siwx-oidc grant. An access token
alone lasts 5 minutes, and Synapse caches a positive token check for 2.

## Tests and Synapse bumps

`synapse-modules/run-tests.sh` runs the tests in Synapse's own test framework at the tag
the Dockerfile pins: delegated auth with a fake introspection endpoint, the module loaded
through `modules:`, every case through the HTTP resource, including "same user set as the
user directory servlet for the same asker". `scripts/directory-search-accept.sh` covers the
entrypoint function. The Dockerfile imports the module with the installed Synapse at build
time.

The module uses a few Synapse internals (listed at the top of
`synapse-modules/inblock_directory/module.py`). They can change in any release, so
`run-tests.sh` is a step of the Synapse bump procedure
(`patches/synapse/README.md`, rule 4), and CI runs it
(`.github/workflows/directory-module-tests.yml`) against the tag the Dockerfile pins, on
pull requests and pushes that touch the module, the Synapse patches, the Dockerfile or the
entrypoint. Three of the internals it covers are looked up per request, so an image that
imports the module can still fail every search; only these tests show that.
