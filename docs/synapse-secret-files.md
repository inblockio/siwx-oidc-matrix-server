# Synapse secret files (store mode)

The Synapse image can read every secret it needs from a file that the container only
reads, instead of from environment variables and from values written into
`homeserver.yaml`. The mode is explicit and off by default: without the switch below the
image behaves exactly as it always did (`scripts/synapse-secret-store-accept.sh` pins
that, byte for byte).

In store mode:

- the entrypoint writes only `*_path` references into `homeserver.yaml` and deletes every
  inline secret it knows, including the three that `/start.py generate` writes on a first
  boot;
- a secret in the container environment is a start error, named, never its value;
- a missing, empty or unreadable secret file is a start error naming the file, never its
  content;
- Synapse starts with `--no-secrets-in-config`, so an inline secret that still reaches
  `homeserver.yaml` is a start error of Synapse itself;
- the container must run as the Synapse user (`user: "991:991"`), never as root.

The entrypoint never prints a value: no `set -x`, no echo of a secret variable, no `cat`
of a secret file, and `homeserver.yaml` is edited with `yq` only.

## Switch and settings

All of these are non-secret and go in the `environment:` list of the compose file.

| Variable | Default | Meaning |
|---|---|---|
| `SYNAPSE_SECRETS_DIR` | unset (mode off) | The switch. An absolute directory path, normally `/run/secrets`. Set and non-empty turns store mode on. |
| `SYNAPSE_MAS_SECRET_FILE` | `$SYNAPSE_SECRETS_DIR/mas_shared_secret` | The shared secret between Synapse and the auth service (`matrix_authentication_service.secret_path`). |
| `SYNAPSE_MACAROON_SECRET_FILE` | `$SYNAPSE_SECRETS_DIR/macaroon_secret_key` | `macaroon_secret_key_path`. |
| `SYNAPSE_FORM_SECRET_FILE` | `$SYNAPSE_SECRETS_DIR/form_secret` | `form_secret_path`. |
| `SYNAPSE_APPSERVICE_FILES` | `$SYNAPSE_SECRETS_DIR/lk_jwt_as_registration.yaml` | Application-service registration file(s), space or comma separated, listed in `app_service_config_files`. Set to the empty string for none. |
| `SYNAPSE_SECRET_ENV_DENY` | unset | Extra environment variable names (comma separated) that must not be set; added to the built-in list below. |

File contents:

- the three secret files hold the raw value, one line (Synapse strips surrounding
  whitespace);
- the registration file is the YAML registration Synapse expects (`id`, `as_token`,
  `hs_token`, `sender_localpart`, `namespaces`, ...). It is a secret file too: it carries
  both tokens.

Every path must be absolute and made of `[A-Za-z0-9._/-]`.

### What the entrypoint refuses

Each refusal is `REFUSING TO START (secret store mode): <reason>` on stderr and exit 1, before
`/start.py generate` and before anything is written (except the last row).

| Reason | Cause and fix |
|---|---|
| `the environment variable NAME is set` | A secret (or a name from `SYNAPSE_SECRET_ENV_DENY`) is in the container environment, even if empty. Remove it from `env_file` and `environment`. The built-in names are `MAS_SHARED_SECRET`, `LK_JWT_AS_TOKEN`, `LK_JWT_HS_TOKEN`, `SYNAPSE_REGISTRATION_SHARED_SECRET`, `SYNAPSE_MACAROON_SECRET_KEY`, `SIWEOIDC_SIGNING_KEY_PEM`, `LIVEKIT_SECRET`: the first five are the secrets this image consumes, the last two are other services' secrets that reach Synapse when a compose file still gives it `env_file: .env`. |
| `the container runs as root` | Run with `user: "991:991"`. As root, `/start.py` drops privileges with `gosu`, which clears supplementary groups: a file readable only through `group_add` would pass this script's check (root reads everything) and then be unreadable to Synapse. |
| `the environment variable UID is set` | With `UID` set, `/start.py` always calls `gosu`, which a non-root user cannot. Leave `UID` and `GID` unset. |
| `/data is not writable` / `/data/homeserver.yaml is not writable` | `yq -i` writes through a temp file and copies it back, so it needs write permission on the file itself; a `homeserver.yaml` owned by another uid fails with "permission denied" even when `/data` is writable. `chown 991:991` the file once. |
| `secret file PATH (SETTING) does not exist ...`, `is not a regular file`, `is not readable by uid U, gid G, groups ...`, `is empty` | The mount is missing or wrong, or the owner, mode or `group_add` do not give uid 991 read access. The message names the file and the setting, never content. |
| `homeserver.yaml holds an inline secret at KEY` | See "Keys that `--no-secrets-in-config` does not check" below. Also the final re-read (after every writer): an inline key left in the file, or a `*_path` reference that did not land, stops the start. |

## Inventory

Verified against Synapse v1.163.0 (`element-hq/synapse`, tag `v1.163.0`), the version this
image is built on. Paths are in that tag; line numbers are of that tag.

### Environment variables the entrypoint reads

Non-secret settings. In store mode a compose file carries these as an explicit
`environment:` list instead of `env_file`:

| Variable | Used for |
|---|---|
| `SYNAPSE_SERVER_NAME`, `SYNAPSE_REPORT_STATS` | `/start.py generate` (mandatory on a first boot, `docker/start.py:83,175`). Compose-level, not read by the entrypoint itself. |
| `MATRIX_HOST` | `server_name`, the notices display name, the MatrixRTC service URL, admin lookup |
| `MATRIX_BASE_URL`, `MATRIX_PORT` | `public_baseurl` and the listener port (first boot) |
| `SIWEOIDC_BASE_URL`, `SIWEOIDC_INTERNAL_URL` | `matrix_authentication_service.endpoint` |
| `MATRIX_RETENTION_ENABLED`, `MATRIX_RETENTION_MAX_LIFETIME`, `MATRIX_MESSAGE_LIFETIME` | retention (first boot) |
| `MATRIX_ADMIN_DID`, `MATRIX_ADMIN_MXID` | admin promotion (every boot) |
| `SIWX_DID_PROFILE_FIELD`, `SIWX_ALLOW_UNPROTECTED_DID_FIELD` | the DID profile field denylist and its escape hatch |
| `GUEST_POLICY_ENABLED`, `GUEST_POLICY_MODULE_PATH`, `GUEST_POLICY_USER_TYPE`, `GUEST_POLICY_ROOM_STATE_TYPE`, `GUEST_POLICY_ALLOWED_EVENT_TYPES`, `GUEST_POLICY_KNOCK_CAP`, `GUEST_POLICY_KNOCK_WINDOW_SECS`, `GUEST_POLICY_NAME_SUFFIX` | the optional guest policy module (eight variables; `GUEST_POLICY_SRC` is the host path of the mount and is read by compose only) |
| `SYNAPSE_SECRETS_DIR`, `SYNAPSE_MAS_SECRET_FILE`, `SYNAPSE_MACAROON_SECRET_FILE`, `SYNAPSE_FORM_SECRET_FILE`, `SYNAPSE_APPSERVICE_FILES`, `SYNAPSE_SECRET_ENV_DENY` | store mode (this document) |
| `UID`, `GID` | read by `/start.py` (`docker/start.py:239-245`); must stay unset in store mode |
| `SYNAPSE_CONFIG_DIR`, `SYNAPSE_CONFIG_PATH`, `SYNAPSE_DATA_DIR`, `SYNAPSE_ENABLE_METRICS`, `SYNAPSE_WORKER` | optional, read by `/start.py` (`docker/start.py:180-183,247,255,281`) |

Secrets (never in the environment in store mode; each has a file instead):

| Variable | Written into | Store mode |
|---|---|---|
| `MAS_SHARED_SECRET` | `matrix_authentication_service.secret` | `SYNAPSE_MAS_SECRET_FILE`, `matrix_authentication_service.secret_path` |
| `LK_JWT_AS_TOKEN`, `LK_JWT_HS_TOKEN` | `/data/lk-jwt-as.yaml` (rendered, mode 0600, listed in `app_service_config_files`) | the mounted registration file in `SYNAPSE_APPSERVICE_FILES`; `/data/lk-jwt-as.yaml` is neither rendered nor deleted |
| `SYNAPSE_REGISTRATION_SHARED_SECRET`, `SYNAPSE_MACAROON_SECRET_KEY` | read only by `/start.py migrate_config` (`docker/start.py:92-113,253-261`), a mode this image never runs | refused as secrets in the environment |

### Secrets that end up in `homeserver.yaml`

| Secret | Who writes it | `*_path` option in v1.163.0 | `--no-secrets-in-config` | Store mode |
|---|---|---|---|---|
| `macaroon_secret_key` | `/start.py generate` writes it inline (`synapse/config/key.py:228-247`) | `macaroon_secret_key_path` (`key.py:189-195`; docs `config_documentation.md:3362`, added 1.121.0) | yes (`key.py:184`) | inline deleted, `macaroon_secret_key_path` set |
| `form_secret` | `generate`, inline (`key.py:240-243`) | `form_secret_path` (`key.py:218-224`; docs `:3390`, added 1.126.0) | yes (`key.py:210`) | inline deleted, `form_secret_path` set |
| `registration_shared_secret` | `generate`, inline (`synapse/config/registration.py:252-263`) | `registration_shared_secret_path` (`registration.py:78-84`; docs `:2851`) | yes (`registration.py:73`) | both keys deleted: nothing uses them. `macaroon_secret_key` falls back to it only when the macaroon key is unset (`key.py:196-197`), and store mode always sets the macaroon path |
| MAS shared secret | `apply_mas_config` writes `matrix_authentication_service.secret` | `matrix_authentication_service.secret_path` (`synapse/config/mas.py:42`; docs `:697`) | yes (`mas.py:78-82`) | inline deleted, `secret_path` set. See the note on lazy reading below |
| appservice `as_token` / `hs_token` | rendered into `/data/lk-jwt-as.yaml` | none needed: they live in the registration file, which is itself a file (`synapse/config/appservice.py:42-49`) | not applicable | `app_service_config_files` lists the mounted registration file(s) |
| Redis password | not written by this image (Redis here is siwx-oidc's) | `redis.password_path` (`synapse/config/redis.py:59-67`; docs `:4727`, added 1.116.0) | yes (`redis.py:54`) | not applicable |
| TURN shared secret | not written | `turn_shared_secret_path` (`synapse/config/voip.py:47-52`; docs `:2646`) | yes (`voip.py:42`) | not applicable |
| `worker_replication_secret` | not written | `worker_replication_secret_path` (`synapse/config/workers.py:254-262`; docs `:4481`) | yes (`workers.py:249`) | not applicable |
| reCAPTCHA keys | not written | `recaptcha_private_key_path`, `recaptcha_public_key_path` (`synapse/config/captcha.py:51-76`) | yes (`captcha.py:46,65`) | not applicable |
| SMTP password `email.smtp_pass` | not written | none (docs `:753`) | no | refused when present |
| `jwt_config.secret` | not written | none (docs `:3916`) | no | refused when present |
| `password_config.pepper` | not written | none (docs `:3951`) | no | refused when present |
| `turn_password` | not written | none (docs `:2670`) | no | refused when present |
| `database.args.password` | not written | none | no | refused when present |
| `oidc_providers[].client_secret` | not written | `client_secret_path` exists (`synapse/config/oidc.py:297-300`; docs `:3684`) | no | refused when present (use `client_secret_path`) |
| admin token | not written: Synapse 1.157 removed the `admin_token` setting; siwx-oidc mints short-lived admin tokens itself | none | not applicable | not applicable |

#### Keys that `--no-secrets-in-config` does not check

Synapse's flag covers only the keys marked "yes" above (the call sites are the
`allow_secrets_in_config` arguments in `synapse/config/`). The entrypoint additionally
refuses an inline `password_config.pepper`, `email.smtp_pass`, `jwt_config.secret`,
`turn_password`, `database.args.password` and `oidc_providers[].client_secret` in
`homeserver.yaml` (an empty value is not a secret and passes), because store mode promises
that no secret stays inline. The check runs before anything is written and again on the
final re-read.

#### Hazards found in the upstream source

- **The MAS secret file is read lazily.** `secret_path` is validated only as an existing file
  when the config is parsed (`mas.py:42`, pydantic `FilePath`); the content is read at the
  first request that needs it (`synapse/api/auth/mas.py:187,217`) and memoized for the life
  of the process (`synapse/config/experimental.py:35-38`). An unreadable file would
  therefore not stop the start by itself: the entrypoint's own check does. A changed value
  needs a container restart (a recreate; see the compose note on single-file mounts).
- **Duplicate registrations print the token.** Synapse's error for two registration files with
  the same `as_token` includes the token value (`synapse/config/appservice.py:86-95`). In
  store mode the entrypoint removes the old `/data/lk-jwt-as.yaml` entry from
  `app_service_config_files` so that the old file and the mounted one are never listed
  together. The old file itself stays on the volume until the operator deletes it.
- **`/start.py generate` writes secrets inline.** On a first boot in store mode the three
  generated values exist in `homeserver.yaml` for the few seconds before the same
  entrypoint run deletes them; Synapse never starts with them, and they are not the store's
  values.
- **`registration_shared_secret_path` creates its file.** Synapse creates the target if it
  does not exist (`registration.py:267-280`, docs `:2851`). Store mode deletes the option, so
  nothing is created.
- **Passing the flag.** `/start.py run --no-secrets-in-config` works: `run` is the default
  mode, and everything after it is handed to `python -m synapse.app.homeserver`
  (`docker/start.py:263-269`). The start log shows
  `Starting synapse with args -m synapse.app.homeserver --no-secrets-in-config --config-path /data/homeserver.yaml`.

## Compose example

```yaml
services:
  matrix_synapse:
    image: ghcr.io/inblockio/siwx-oidc-matrix-server/synapse@sha256:<digest>
    # Not root: /start.py would drop root with gosu, which clears group_add.
    user: "991:991"
    # The groups that own the secret files (mode 0440, group read only).
    group_add:
      - "5001"
      - "5002"
      - "5003"
    # An explicit list of non-secret settings. No env_file: everything in a .env
    # would reach the container, and a secret in the environment is refused.
    environment:
      SYNAPSE_SERVER_NAME: ${MATRIX_HOST}
      SYNAPSE_REPORT_STATS: ${MATRIX_REPORT_STATS}
      MATRIX_HOST: ${MATRIX_HOST}
      MATRIX_BASE_URL: ${MATRIX_BASE_URL}
      MATRIX_PORT: ${MATRIX_PORT}
      SIWEOIDC_BASE_URL: ${SIWEOIDC_BASE_URL}
      MATRIX_ADMIN_MXID: ${MATRIX_ADMIN_MXID:-}
      SIWX_DID_PROFILE_FIELD: ${SIWX_DID_PROFILE_FIELD:-io.inblock.did}
      SYNAPSE_SECRETS_DIR: /run/secrets
    volumes:
      - matrix_data:/data
      # One long-syntax bind per file. read_only: the container cannot change a
      # secret. create_host_path: false: a missing source fails the start instead of
      # Docker creating an empty directory in its place.
      - type: bind
        source: /path/to/store/mas_shared_secret
        target: /run/secrets/mas_shared_secret
        read_only: true
        bind:
          create_host_path: false
      - type: bind
        source: /path/to/store/macaroon_secret_key
        target: /run/secrets/macaroon_secret_key
        read_only: true
        bind:
          create_host_path: false
      - type: bind
        source: /path/to/store/form_secret
        target: /run/secrets/form_secret
        read_only: true
        bind:
          create_host_path: false
      - type: bind
        source: /path/to/store/lk_jwt_as_registration.yaml
        target: /run/secrets/lk_jwt_as_registration.yaml
        read_only: true
        bind:
          create_host_path: false
```

Notes:

- A single-file bind keeps the old inode when the host file is replaced, and Synapse reads
  each secret once at startup anyway: after a value changes, recreate the container
  (`up -d --force-recreate`), do not just restart or reload it.
- `yq -i` writes a temp file under `/tmp`, so the container's `/tmp` must be writable (it is by
  default). Do not make the root filesystem read-only without a `tmpfs` on `/tmp`.
- The data volume and `homeserver.yaml` must be owned by uid 991 (or be writable by it). A
  container that starts as root edits the config whoever owns it; as 991 it can only edit
  what it may write, and `yq -i` needs write permission on the file itself, not just on
  `/data`. The entrypoint refuses with a clear message instead of failing inside `yq`.
  Synapse's own files (database, media store, signing key) were created by Synapse running as
  991 after the `gosu` drop, so they are 991's unless someone changed them by hand.

## Switching an existing deployment

1. Roll the image that has this mode out first. It changes nothing until `SYNAPSE_SECRETS_DIR`
   is set (the accept script pins the rendered config byte for byte).
2. Create the secret files with the owner, group and mode the consumers need (for example
   `0440`, owned by root, group-readable by a group the container gets with `group_add`).
   Keep the same value as today where other services share it: the MAS secret must equal
   the one siwx-oidc holds, so both consumers are recreated together.
3. Make `/data` and `/data/homeserver.yaml` owned by uid 991, once.
4. Replace `env_file` by the explicit `environment:` list, add `user`, `group_add`,
   `SYNAPSE_SECRETS_DIR` and the file mounts, and recreate the container.
5. Check the log: `Secret store mode: ...` lines, `Starting synapse with args -m
   synapse.app.homeserver --no-secrets-in-config ...`, and `Synapse now listening`.
6. Only after the check passes, delete the old copies: the secret values in `.env`, the
   rendered `/data/lk-jwt-as.yaml`, and any backup of `homeserver.yaml` taken before the
   switch.

What a changed value breaks (Synapse's own documentation): replacing `macaroon_secret_key`
invalidates access tokens of guest users and email unsubscribe links sent before; replacing
`form_secret` can break an open user-consent page. Rolling back to an inline secret needs
the old value, which no longer exists once the old copies are deleted: fix forward.

## Verification

```bash
# logic, no container runtime (needs mikefarah yq v4 and python3)
scripts/synapse-secret-store-accept.sh

# the same against the entrypoint of an older commit, byte for byte with the mode off
SIWX_ACCEPT_BASELINE=/path/to/older/matrix_server.sh scripts/synapse-secret-store-accept.sh

# the real image, as 991:991 with group_add, throwaway volumes, no network
docker build -f dockerfiles/Dockerfile -t synapse-under-test .
scripts/synapse-secret-store-e2e.sh --image synapse-under-test
```

`.github/workflows/checks.yml` runs both on every pull request.
