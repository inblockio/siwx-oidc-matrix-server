# Redis password

Redis is siwx-oidc's store: sessions, grants, clients and the opaque access and refresh
tokens. The key NAMES of that store are the raw tokens, so whoever can talk to Redis can
read every live token. `docker-compose.yml` therefore gives Redis a password and puts it on
an internal network, `redis-net`, that only siwx-oidc joins. No other service of the stack
can reach Redis, and nothing can reach it without the password.

## Where the password lives

In the stack directory (the one with `docker-compose.yml`), in `secrets/`, which is
gitignored:

| File | Content | Mode | Read by |
|---|---|---|---|
| `secrets/` | the two files below | `0700`, the stack user | |
| `secrets/redis.conf` | `requirepass <password>` | `0600`, the stack user | Redis |
| `secrets/siwx-oidc.toml` | `redis_url = "redis://:<password>@redis"` | `0640`, the stack user, group `STACK_SECRETS_GID` (default 1000) | siwx-oidc |

Both files carry the same password; `scripts/redis-secret.sh` writes them together. The
password is 48 random bytes from `openssl rand`, in base64 without `/`, `+` and `=`: about
64 characters of `[A-Za-z0-9]`, which needs no quoting in either file.

It is not in `.env` on purpose. `matrix_synapse` loads `.env` whole through `env_file`, so
a password there would also sit in Synapse's environment, and every variable a container
gets is shown by `docker inspect`.

How the containers read it, without the password on any command line or in any
`docker inspect` output:

- **Redis** starts as `redis-server - --appendonly yes` with `secrets/redis.conf` on stdin:
  Redis reads its config from stdin when `-` is the first argument. The shell that opens
  the file runs as root, before the image entrypoint drops Redis to the `redis` user, so
  the file can stay `0600`. Keep `-` first: the entrypoint appends `--loadmodule` flags.
  The healthcheck signs in with the same file, so `healthy` also means the password works.
- **siwx-oidc** reads `siwx-oidc.toml` from its working directory (`/siwx-oidc`), where the
  file is mounted. It runs as uid 10001 and reads the file through the group that
  `group_add` gives it, `STACK_SECRETS_GID`. That must be the file's group. Do not set
  `SIWEOIDC_REDIS_URL` or `SIWXOIDC_REDIS_URL` in its `environment`: the environment beats
  the file, and siwx-oidc would then connect without the password.

The files are mounted with Compose `secrets:` (read-only bind mounts). If one is missing,
Docker refuses to create the container, so a stack cannot start without its password.

## Create

`start-matrix.sh` runs `scripts/redis-secret.sh init` before every start. `init` creates
both files when neither exists and leaves them alone otherwise. By hand, from the stack
directory, as the stack user:

```bash
scripts/redis-secret.sh init
scripts/redis-secret.sh check      # owner, modes, group, and both files agree
```

`check` prints a fingerprint, a short SHA-256 prefix of the password, to compare two
copies without showing the password. It never prints the password.

If the stack user's primary group is not 1000, set `STACK_SECRETS_GID=$(id -g)` in `.env`
before `init`.

## Turn it on for a running deployment

Turning on the password changes no data: Redis keeps its AOF and RDB files, and every
session survives. Recreate Redis and siwx-oidc together, nothing else:

1. Check that Redis is safe to restart: `INFO persistence` shows `aof_enabled:1`,
   `aof_rewrite_in_progress:0` and `aof_last_write_status:ok`. Note `DBSIZE`. Do this
   before the change with plain `docker compose exec redis redis-cli ...`, after it with
   `scripts/redis-cli.sh ...`.
2. Back up `docker-compose.yml`, then take the new one.
3. `scripts/redis-secret.sh init` and `scripts/redis-secret.sh check`.
4. `docker compose up -d --no-deps redis siwx-oidc`. Compose recreates Redis first and
   starts siwx-oidc once Redis is healthy. For those seconds, token introspection fails
   with a 5xx, which clients retry; siwx-oidc never turns a store error into an
   inactive token, so nobody is signed out.
5. Verify: `docker compose exec redis redis-cli ping` answers `NOAUTH`;
   `scripts/redis-cli.sh ping` answers `PONG`; `scripts/redis-cli.sh DBSIZE` matches the
   number from step 1 (within normal churn); both containers are healthy; a sign-in works.

## Use redis-cli

`scripts/redis-cli.sh <command>` runs redis-cli in the stack's Redis container, signed in
with the password from the mounted file. The password stays inside the container.

```bash
scripts/redis-cli.sh ping
scripts/redis-cli.sh INFO persistence
scripts/redis-cli.sh DBSIZE
```

Never list keys (`KEYS`, `SCAN`, `--scan`, `MONITOR`) into a terminal or a log: the names
are tokens. Count them: `scripts/redis-cli.sh --scan --pattern 'x/*' | wc -l`.

## Rotate

Rotating changes no data and signs nobody out. Redis and siwx-oidc restart together, which
costs a few seconds of failed introspection as above.

```bash
scripts/redis-secret.sh rotate     # new password in both files, the old ones as *.bak-<stamp>
scripts/redis-secret.sh check
docker compose up -d --no-deps --force-recreate redis siwx-oidc
scripts/redis-cli.sh ping          # PONG
```

`--force-recreate` is needed: Compose does not notice a changed secret file. After a sign-in
works, delete the `secrets/*.bak-<stamp>` files. To roll back, move them back over the two
files and run the same `up` command.

Rotate after the password may have leaked: a file copied somewhere unprotected, printed in
a terminal, or left on a machine that is given away.

## Back up

A backup of the stack must include `secrets/`, or a restored stack has data it cannot open
without rotating. Keep the backup as protected as `.env`: both hold live secrets. The Redis
data itself (the `redis_data` volume) holds the tokens in clear and is not protected by
this password, so a Redis data backup leaves the host only encrypted.

Without the files, nothing is lost: run `rotate` (or `init` when both are gone) and
recreate both services. The password guards access; it does not encrypt the data.

## Move to another machine

Either copy the password or make a new one on the target. Both keep all data.

**Copy.** From the old machine, with the stack user on both ends and the stack directory
as the working directory on each, so the password crosses only the SSH connection:

```bash
# rm first: `cat >` into an existing file would keep that file's (maybe looser) mode
ssh <target> 'umask 077; mkdir -p <stack-dir>/secrets && rm -f <stack-dir>/secrets/redis.conf <stack-dir>/secrets/siwx-oidc.toml'
for f in redis.conf siwx-oidc.toml; do
  ssh <target> "umask 077; cat > <stack-dir>/secrets/$f" < secrets/$f
done
ssh <target> 'cd <stack-dir> && chmod 0700 secrets && chmod 0600 secrets/redis.conf \
  && chmod 0640 secrets/siwx-oidc.toml'
sha256sum secrets/redis.conf secrets/siwx-oidc.toml
ssh <target> 'cd <stack-dir> && sha256sum secrets/redis.conf secrets/siwx-oidc.toml \
  && scripts/redis-secret.sh check'
```

The two `sha256sum` outputs must be equal, and `check` must say OK. The copied
`siwx-oidc.toml` gets the target user's primary group; if `check` reports a group mismatch,
set `STACK_SECRETS_GID` in the target's `.env` to that group (or `chgrp` the file to it). Hashes are safe to show;
the files are not. Do not use `scp -p` or `rsync -p` from a machine where the modes or the
group differ, and never paste a file's content into a terminal or a chat.

**Make a new one.** On the target, before the first start: `scripts/redis-secret.sh init`
(or `rotate`, if the files were copied with the rest of the stack). Redis takes the new
password at its first start on the target and the data volume is unaffected. Then delete
the copies of the old files that travelled with the stack backup, if any.

Either way, once the stack runs on the target: `scripts/redis-secret.sh check`,
`scripts/redis-cli.sh ping` (`PONG`), `DBSIZE` as on the old machine, and a sign-in.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| siwx-oidc logs `NOAUTH` or `WRONGPASS`, requests fail with 5xx | the two files disagree, or a `*_REDIS_URL` variable in siwx-oidc's environment wins over the file | `scripts/redis-secret.sh check`; remove the variable; recreate both services |
| siwx-oidc exits at start reading its config | it cannot read `siwx-oidc.toml`: the file's group is not `STACK_SECRETS_GID`, or its mode is not `0640` | `scripts/redis-secret.sh check` names it; `chgrp`/`chmod`, or set `STACK_SECRETS_GID` |
| `bind source path does not exist: .../secrets/...` | the files were never created | `scripts/redis-secret.sh init` |
| Redis stays `unhealthy` | the healthcheck cannot sign in | `docker compose logs redis`; `scripts/redis-secret.sh check` |
| `redis-cli` answers `NOAUTH` | plain redis-cli has no password | use `scripts/redis-cli.sh` |
