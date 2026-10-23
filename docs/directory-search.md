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
- `term`: a string, 1 to 64 characters after trimming, no control characters. The trimmed
  value is what Synapse searches for.
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
| Requester not in `admitted_services`, or its account is missing, deactivated, locked or guest-typed, or the account lookup fails | `403 M_FORBIDDEN` |
| Body too large | `413 M_TOO_LARGE` |
| Body not JSON or not an object | `400 M_NOT_JSON` / `400 M_BAD_JSON` |
| `asker`, `term` or `limit` out of bounds | `400 M_INVALID_PARAM` |
| `user_directory.enabled` is false | `{"results": [], "limited": false}` |
| Asker not a local user, or missing, deactivated, locked or guest-typed (or the lookup fails) | `{"results": [], "limited": false}`, and the search is not run |
| Per-asker rate limit exceeded | `429 M_LIMIT_EXCEEDED` |
| The search itself fails | `500 M_UNKNOWN`, fixed text |

The **account check** reads the `users` row: it must exist, not be deactivated, not be
locked, and its `user_type` must not be `io.inblock.guest` (our guest marker; Synapse's own
guest flag is never set under delegated auth). Synapse's token check does not look at
locked or deactivated accounts, which is why the module does. The guest marker is fixed
here; if a deployment changes the guest policy's `GUEST_POLICY_USER_TYPE`, this check no
longer matches it.

The empty answer for a bad asker is identical to "no match" on purpose: a service cannot
learn which askers exist. Without that check Synapse would still return the members of
public rooms for an asker that does not exist.

The **rate limit** is Synapse's own limiter with the `rc_user_directory` settings, one
bucket per asker.

## Configuration

```yaml
modules:
  - module: inblock_directory.DirectoryModule
    config:
      admitted_services: ["@dir-service:example.org"]
      max_limit: 20
```

- `admitted_services` (required): non-empty list of Matrix user IDs. Every entry must be
  well formed and a user of this homeserver; otherwise Synapse refuses to start. The list
  is per environment and public: it names accounts, not secrets.
- `max_limit` (optional, default 20): 1 to 50 (Element's own search clamps at 50).
- Any other key is refused.

The Synapse image bakes the module in (`dockerfiles/Dockerfile`) and
`entrypoints/matrix_server.sh::apply_directory_search` registers it on every boot, from
environment variables (they reach the container through `.env`; see `env.example`):

| Variable | Meaning |
|---|---|
| `DIRECTORY_ADMITTED_SERVICES` | Comma separated MXIDs; spaces around a comma are ignored. Unset or empty: the module is **not** registered and an entry from an earlier boot is removed. Any malformed entry, or a module that cannot be imported, refuses to start. |
| `DIRECTORY_MAX_LIMIT` | Optional, 1 to 50. |

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
(`patches/synapse/README.md`, rule 4).
