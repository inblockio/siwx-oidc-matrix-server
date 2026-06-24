#!/usr/bin/env bash
# down.sh — tear down the hermetic LOCAL e2e harness (siwx-e2eh-*).
#
# Removes only siwx-e2eh-* objects. NEVER touches siwx-real-* or aqua-agent-*.
# By default the data volumes are PRESERVED (re-up reuses them). Pass --volumes
# to also drop the matrix + redis volumes, and --network to drop the network.
#
# Usage:
#   e2e-harness/down.sh                     # stop+remove containers only
#   e2e-harness/down.sh --volumes           # + drop data volumes
#   e2e-harness/down.sh --volumes --network # + drop the network too
set -euo pipefail

DROP_VOLUMES=0
DROP_NETWORK=0
for arg in "$@"; do
  case "$arg" in
    --volumes) DROP_VOLUMES=1 ;;
    --network) DROP_NETWORK=1 ;;
  esac
done

echo "[down] removing siwx-e2eh-* containers ..."
# Remove the fed-proxy FIRST: it shares siwx-e2eh-lk-jwt's network namespace
# (--network container:siwx-e2eh-lk-jwt), so it must go before the container that
# owns that namespace — otherwise it is orphaned and `podman ps -a` still lists it.
for c in siwx-e2eh-fed-proxy siwx-e2eh-caddy siwx-e2eh-lk-jwt siwx-e2eh-livekit siwx-e2eh-synapse siwx-e2eh-oidc siwx-e2eh-redis; do
  podman rm -f "$c" >/dev/null 2>&1 || true
done

if [ "${DROP_VOLUMES}" = "1" ]; then
  echo "[down] dropping data volumes ..."
  podman volume rm siwx-e2eh-matrix-data siwx-e2eh-redis-data >/dev/null 2>&1 || true
fi

if [ "${DROP_NETWORK}" = "1" ]; then
  echo "[down] dropping network siwx-e2eh-net ..."
  podman network rm siwx-e2eh-net >/dev/null 2>&1 || true
fi

echo "[down] done. Remaining siwx-e2eh-* containers:"
podman ps -a --filter "name=siwx-e2eh-" --format '  {{.Names}}\t{{.Status}}' || true
