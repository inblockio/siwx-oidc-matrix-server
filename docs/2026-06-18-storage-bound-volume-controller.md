# Bounded Matrix volume + self-regulating storage controller

**Date:** 2026-06-18
**Host:** `agentic.inblock.io` (`deploy@…:8022`, `matrix.inblock.io` → `142.93.168.4`)
**Status:** deployed and verified

## Why

Synapse stored all mutable state (`homeserver.db`, `media_store`, signing key) in the
Docker named volume `matrix_matrix_data` on the **root disk** `/dev/vda1`. Unbounded
media/event growth there can fill root and kill the host. A dedicated 100 GB DigitalOcean
volume now physically bounds Matrix: if it ever fills, only Matrix degrades; the host root
disk is never threatened. Matrix is treated as a **stream-communication service, not
permanent storage**, with native pruning to stay inside the bound.

## What was put in place

### 1. Persistent mount + boot safety
- `/etc/fstab`: `/dev/disk/by-id/scsi-0DO_Volume_volume-matrix-service /mnt/volume_matrix_service ext4 defaults,nofail,discard,noatime 0 0`
  (stable by-id path; `nofail` so a missing volume never blocks boot).
- `/etc/systemd/system/docker.service.d/10-matrix-volume.conf`:
  `RequiresMountsFor=/mnt/volume_matrix_service`. Docker (and therefore Synapse) will
  **not start until the volume is mounted**, so Synapse can never silently write a fresh
  DB onto root. A missing volume yields a loud, safe failure (Matrix down, host safe).

### 2. Data on the volume (bind mount)
- `docker-compose.override.yml` (prod-only, gitignored; template:
  `docker-compose.override.yml.example`) binds `/mnt/volume_matrix_service/matrix_data:/data`.
  Compose v2 merges service `volumes` by target, so this replaces the base
  `matrix_data:/data` named-volume mount without touching the base file (local dev
  unaffected).
- The old `matrix_matrix_data` named volume is **left intact on root** as a rollback backup.

### 3. Dynamic storage controller (one closed-loop)
`scripts/matrix-storage-controller.sh`, run hourly by `matrix-storage-controller.timer`
(`User=deploy`). It collapses guard + monitor + auto-prune + alert into one feedback loop:

- **Measure** utilization `U` of `/mnt/volume_matrix_service` (and root, for alerting).
- **Compute** remote/local media retention windows from `U` via a convex "bonding curve".
- **Prune** old media via the Synapse Admin API (no restart), authed by the msc3861
  `admin_token` (`MAS_SHARED_SECRET`, read from `.env`, never printed):
  - remote cache: `POST /_synapse/admin/v1/purge_media_cache?before_ts=…`
  - local media:  `POST /_synapse/admin/v1/media/<server>/delete?before_ts=…&keep_profiles=true`
- **Log** every tick to journald (`journalctl -u matrix-storage-controller`).
- **Alert** on WARN/CRIT level transitions via a Matrix **server notice** to the operator
  (`MATRIX_ADMIN_DID`), force-creating a "Server Alerts" room.

#### Control law

For each media class with activation `ON`, full-pressure point `FULL`, emergency `EMERG`,
window bounds `Lmax`/`Lmin`, convexity `k`, hard floor `FLOOR`:

```
U < ON          → window = ∞      (no pruning; "permanent" regime)
ON ≤ U < FULL   → p = (U-ON)/(FULL-ON);  window = Lmax − (Lmax−Lmin)·p^k
U ≥ FULL        → window = Lmin
window = max(window, FLOOR)        # never delete media younger than the floor, ever
U ≥ EMERG       → remote: purge ALL (before_ts=now); local: window = Lmin
```

Capacity is re-read live each tick, so **expanding the volume (resize2fs) lowers `U` and the
controller relaxes/deactivates automatically** — "add storage = auto-relax" is free.
Pruning is negative feedback, so the loop self-stabilizes; alerts fire only on transitions.

| Class  | ON  | FULL | EMERG | Lmax | Lmin | floor | k | profiles |
|--------|-----|------|-------|------|------|-------|---|----------|
| Remote | 40% | 90%  | 95%   | 60 d | 1 d  | 1 d   | 2 | n/a (cache) |
| Local  | 50% | 90%  | 95%   | 90 d | 7 d  | 1 d   | 2 | `keep_profiles=true` |

All parameters are env-overridable (set `Environment=` in the service unit or a drop-in).

Alert thresholds: WARN 80%, CRIT 90%, on both the Matrix volume and root.

## Operate

```bash
# Live status: utilization + currently-computed retention windows
/home/deploy/matrix/stack/scripts/matrix-storage-controller.sh status

# Tail controller history
journalctl -u matrix-storage-controller -n 50

# Send a manual test alert
/home/deploy/matrix/stack/scripts/matrix-storage-controller.sh notice "test"

# When the timer fires next
systemctl list-timers matrix-storage-controller.timer
```

**Operator must accept the "Server Alerts" room invite once in Element** (MSC3861 invites
rather than force-joins). After that, all alerts arrive with push.

## Rollback

```bash
cd /home/deploy/matrix/stack
rm docker-compose.override.yml          # back to the root-disk named volume (old data preserved)
docker compose up -d matrix_synapse
```

To revert the controller: `sudo systemctl disable --now matrix-storage-controller.timer`.

## Notes / caveats

- **Local-media deletion is irreversible** under pressure (accepted: stream service, not
  permanent storage), bounded by the hard floor (never < 1 d) and `keep_profiles=true`.
- The first-boot entrypoint (`entrypoints/matrix_server.sh`) now writes the `server_notices`
  block, so **fresh** deploys get alerting automatically; existing deploys had it added live.
- Setting `MATRIX_ADMIN_DID` in `.env` also makes that account a server admin on the next
  Synapse restart (idempotent promotion in the entrypoint).
- Message/event retention is separate and already enabled via the `retention` block.
