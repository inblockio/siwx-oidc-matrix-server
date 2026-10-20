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
- a secret-looking variable in the container environment is a start error, named, never its
  value (what that does and does not recognise is under "What the entrypoint refuses");
- a missing, empty, blank, unreadable or writable secret file is a start error naming the
  file, never its content; so is a file the container user owns, a file in a directory the
  container user can write, and a MAS, macaroon or form secret with a byte outside printable
  ASCII;
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
| `SYNAPSE_APPSERVICE_FILES` | `$SYNAPSE_SECRETS_DIR/lk_jwt_as_registration.yaml` | Application-service registration file(s), separated by comma, space or newline (the whole value is read), listed in `app_service_config_files`. Set to the empty string for none. It is the whole list of this mode's registrations: an entry under `$SYNAPSE_SECRETS_DIR/` that an earlier boot listed and that is no longer named here is removed from `app_service_config_files` (the log says which). Entries elsewhere in the list are left alone. |
| `SYNAPSE_SECRET_ENV_DENY` | unset | Extra environment variable names (separated by comma, space or newline) that must not be set; added to the built-in list below. |

File contents:

- the three secret files hold the raw value, one line: every byte is printable ASCII (0x21 to
  0x7e), so no space, tab, control character or non-ASCII byte anywhere, except one final
  newline (Synapse strips the ends and decodes the rest, a reader that sends the bytes as a
  header or compares them would see another value), and not empty or blank. The registration
  files are YAML and keep only the not-blank rule;
- the registration file is the YAML registration Synapse expects (`id`, `as_token`,
  `hs_token`, `sender_localpart`, `namespaces`, ...). It is a secret file too: it carries
  both tokens. Each registration needs the string fields `id`, `as_token` and `hs_token`, and
  no two registrations (these files, and the others `app_service_config_files` keeps listing)
  may share an `id` or a token. A registration that an existing config lists must be a safe
  path (below) to a readable regular file, or the start is refused: it is never skipped;
- every secret file must be read-only for the container user: mount it with `read_only: true`
  and no write permission for uid 991 (a file the process can write is refused). Two more
  things would let the container user change a secret it only reads, and are refused: the
  container user (991) owns the file (an owner can change the mode), or the directory that
  holds the file, or the directory a link to it resolves into, is writable by 991 (it could
  replace the file). Let root own the files and give uid 991 read access through a group
  (`group_add`), in a directory it cannot write.

Every path must be absolute and made of `[A-Za-z0-9._/-]`.

### What the entrypoint refuses

Each refusal is `REFUSING TO START (secret store mode): <reason>` on stderr and exit 1, before
`/start.py generate` and before anything is written (except the last row).

| Reason | Cause and fix |
|---|---|
| `the environment variable NAME is set` | A secret is in the container environment, even if empty. Three things are recognised, by name only: (1) the built-in names `MAS_SHARED_SECRET`, `LK_JWT_AS_TOKEN`, `LK_JWT_HS_TOKEN`, `SYNAPSE_REGISTRATION_SHARED_SECRET`, `SYNAPSE_MACAROON_SECRET_KEY`, `SIWEOIDC_SIGNING_KEY_PEM`, `LIVEKIT_SECRET` and the names in `SYNAPSE_SECRET_ENV_DENY`; (2) any other variable whose name contains `SECRET`, `TOKEN`, `PASSWORD`, `PASSWD`, `PEM`, `PRIVATE_KEY` or `API_KEY` (case-insensitive), except the store's own settings (`SYNAPSE_SECRETS_DIR`, `SYNAPSE_MAS_SECRET_FILE`, `SYNAPSE_MACAROON_SECRET_FILE`, `SYNAPSE_FORM_SECRET_FILE`, `SYNAPSE_SECRET_ENV_DENY`) and none of the other names this image or `/start.py` reads; (3) `the environment variable NAME is set to a URL that carries a password`: any variable whose value is a URL with a password in its userinfo part (a user, a colon and a password before the `@`; the userinfo ends at the last `@` before the host, so an `@` in the user name or in the password does not hide it). The environment is read from `/proc`, so a name bash cannot import (a dot in it) is seen too. This is a net, not a proof: a secret in a variable with a harmless name and a value that is not such a URL is not recognised. The guarantee comes from the compose file: an explicit `environment:` list, and no `env_file`. Remove the variable and put the value in a file under the secrets directory. |
| `the container runs as root` | Run with `user: "991:991"`. As root, `/start.py` drops privileges with `gosu`, which clears supplementary groups: a file readable only through `group_add` would pass this script's check (root reads everything) and then be unreadable to Synapse. |
| `the environment variable UID is set` | With `UID` set, `/start.py` always calls `gosu`, which a non-root user cannot. Leave `UID` and `GID` unset. |
| `SYNAPSE_CONFIG_DIR is set to something other than /data`, `SYNAPSE_CONFIG_PATH is set to ...` | The entrypoint secures `/data/homeserver.yaml` only. If `/start.py` were pointed at another config, Synapse would run on a file nothing here checked. Leave both unset. |
| `DIR is not a writable directory` (DIR is `$TMPDIR`, default `/tmp`) | `yq -i` writes its temp file there. With a read-only root file system and no writable `/tmp` every edit would fail half way; the check is the first thing the preflight does. Give the container `tmpfs: /tmp`. |
| `/data is not writable` / `/data/homeserver.yaml is not writable` | `yq -i` writes through a temp file and copies it back, so it needs write permission on the file itself; a `homeserver.yaml` owned by another uid fails with "permission denied" even when `/data` is writable. `chown 991:991` the file once. |
| `secret file PATH (SETTING) does not exist ...`, `is not a regular file`, `is not readable by uid U, gid G, groups ...`, `is writable by uid U`, `is owned by uid U`, `sits in the directory DIR, which is writable by uid U`, `is empty`, `holds nothing but whitespace`, `has leading or trailing whitespace`, `holds a byte outside printable ASCII` | The mount is missing or wrong, or the owner, mode or `group_add` do not give uid 991 read access; or the container user can write the file (a setting pointed into `/data`, a mount without `read_only: true` on a file 991 owns); or the container user owns the file, whatever its mode (an owner can chmod it): let root own it and use a group; or the container user can write the directory that holds the file (or the directory a link resolves into), which lets it replace the file; or the content is empty or blank (Synapse strips such a value to nothing, and the macaroon key would silently fall back to one derived from the signing key); or a raw value has leading whitespace or trailing whitespace beyond one final newline, or any byte outside 0x21 to 0x7e (a space, tab, control character, DEL or non-ASCII byte inside it). The registration file is exempt from the last two checks only (it is YAML: spaces, blank lines and non-ASCII text are fine). The message names the file and the setting, never content. |
| `/data/homeserver.yaml lists the entry E in app_service_config_files, and it is not an absolute path ...` / `... it is not a readable regular file` | A registration the existing config lists cannot be read and compared, so a shared `as_token` could hide behind it, and Synapse's error for that prints the token. The start is refused, naming the entry (an unsafe character shown as `?`). Fix the entry (a path of `[A-Za-z0-9._/-]` to a readable file) or remove it. Not affected: the legacy `lk-jwt-as.yaml` and the entries under the secrets directory, which this mode unlists or replaces. |
| `the registration files A and B have the same id / as_token / hs_token`, `the as_token of A is the hs_token of B`, `is not a registration Synapse can load` | Compared before Synapse is started, by `id` and by a sha256 of each token, across the files to be listed and the other registrations that stay listed in an existing `homeserver.yaml`. Synapse refuses a duplicate itself, but its error for a repeated `as_token` prints the token. Only file names are printed. |
| `SYNAPSE_SECRETS_DIR is not set, but /data/homeserver.yaml has KEY` | The mode is off on a config a store-mode boot wrote (`matrix_authentication_service.secret_path`, `macaroon_secret_key_path` or `form_secret_path`). Going on would write the MAS secret inline next to its `secret_path`, which Synapse refuses with an error that prints the secret, and would list a second copy of the registration. Nothing is written. Rolling back is not supported: set `SYNAPSE_SECRETS_DIR` again, or restore a `homeserver.yaml` from before the switch (fix forward). A config that never saw store mode has none of these keys and is untouched. |
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
| `SYNAPSE_CONFIG_DIR`, `SYNAPSE_CONFIG_PATH`, `SYNAPSE_DATA_DIR`, `SYNAPSE_ENABLE_METRICS`, `SYNAPSE_WORKER` | optional, read by `/start.py` (`docker/start.py:180-183,247,255,281`). In store mode `SYNAPSE_CONFIG_DIR` and `SYNAPSE_CONFIG_PATH` must be unset or name `/data` and `/data/homeserver.yaml` |
| `TMPDIR` | optional; where `yq -i` writes its temp file (default `/tmp`). In store mode it must be a writable directory |

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
| `oidc_config.client_secret` (the single-provider form) | not written | `client_secret_path` (same parser as `oidc_providers`, `synapse/config/oidc.py:206-212,297-300`) | no | refused when present |
| `oidc_providers[].client_secret_jwt_key.key` | not written | `client_secret_jwt_key.key_file` (`oidc.py:281-283`; the inline `key` is the alternative, `oidc.py:98-105,285`) | no | refused when present |
| `databases.*.args.password` (the multi-database form) | not written | none | no | refused when present |
| federation signing key | Synapse, on the first boot (`/start.py generate`), into `signing_key_path`, by default `<config dir>/<server_name>.signing.key` in `/data` (read at `synapse/config/key.py:127-137`, generated at `key.py:302-318`) | it is a file already: `signing_key_path`. An inline `signing_key` would also be read (`key.py:127-128`) | not applicable | kept as it is and excluded from the store by design: it is not provisioned from outside, it is the server's federation identity (a new key is a new identity for every remote server), and its value does not change with the switch. It stays a file in the data volume and in the backups of that volume, mode as Synapse wrote it |

#### Keys that `--no-secrets-in-config` does not check

Synapse's flag covers only the keys marked "yes" above (the call sites are the
`allow_secrets_in_config` arguments in `synapse/config/`). The entrypoint additionally
refuses an inline `password_config.pepper`, `email.smtp_pass`, `jwt_config.secret`,
`turn_password`, `database.args.password`, `databases.*.args.password`,
`oidc_config.client_secret`, `oidc_providers[].client_secret` and
`oidc_providers[].client_secret_jwt_key.key` in `homeserver.yaml` (an empty value is not a
secret and passes), because store mode promises that no secret stays inline. The check runs before anything is written and again on the
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
  together, and it compares the registrations itself (by `id` and by a sha256 of the tokens,
  never printing one) and refuses a duplicate, naming the files, before Synapse can print
  the token. The old file itself stays on the volume until the operator deletes it; every
  store-mode boot logs one line naming it while it exists.
- **A dropped or renamed registration would stay listed.** Store mode only ever added entries.
  It now unlists every entry under the secrets directory that `SYNAPSE_APPSERVICE_FILES` does
  not name, so a registration the operator removed is not loaded and a file that is no longer
  mounted does not stop Synapse.
- **Switching back writes the secret beside its path.** With the mode off, `apply_mas_config`
  writes `matrix_authentication_service.secret`; next to a leftover `secret_path`, Synapse's
  `MasConfigModel` refuses the block and its pydantic error repeats the block, the secret
  included. The mode-off entrypoint therefore refuses a config that carries a store-mode
  `*_path` key and says to fix forward.
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
      # The admin to promote (every boot): the DID (production) or an MXID.
      MATRIX_ADMIN_DID: ${MATRIX_ADMIN_DID:-}
      MATRIX_ADMIN_MXID: ${MATRIX_ADMIN_MXID:-}
      SIWX_DID_PROFILE_FIELD: ${SIWX_DID_PROFILE_FIELD:-io.inblock.did}
      # Guest confinement (development stacks that use it). LEAVING THESE OUT TURNS
      # GUEST CONFINEMENT OFF: the module is then not loaded, and an entry from an
      # earlier boot is removed. With ENABLED=true the module checkout must be mounted
      # (below); without the mount the container refuses to start. The other
      # GUEST_POLICY_* settings are optional (README "Guest policy module").
      GUEST_POLICY_ENABLED: ${GUEST_POLICY_ENABLED:-}
      GUEST_POLICY_MODULE_PATH: ${GUEST_POLICY_MODULE_PATH:-/modules/synapse-guest-policy}
      SYNAPSE_SECRETS_DIR: /run/secrets
    # A read-only root file system needs a writable /tmp: yq -i writes its temp file there.
    tmpfs:
      - /tmp
    volumes:
      - matrix_data:/data
      # Development stacks with the guest policy module: its checkout, read-only.
      # - ${GUEST_POLICY_SRC}:/modules/synapse-guest-policy:ro
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
- `yq -i` writes a temp file under `$TMPDIR` (default `/tmp`), so that directory must be
  writable (it is by default). With `read_only: true` on the container, give it a `tmpfs` on
  `/tmp`; the entrypoint refuses to start otherwise, naming the directory.
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
