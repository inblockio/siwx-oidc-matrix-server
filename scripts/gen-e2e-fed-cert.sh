#!/usr/bin/env bash
# gen-e2e-fed-cert.sh — generate the self-signed federation cert used by the
# lk-jwt -> Synapse TLS shim in the hermetic LOCAL e2e harness.
#
# lk-jwt-service dials matrix://localhost:8448 (TLS) to validate Matrix OpenID
# tokens; config/fed-proxy.e2e.Caddyfile TLS-terminates that with this cert and
# reverse-proxies plain HTTP to siwx-e2eh-synapse:8008. lk-jwt runs with
# LIVEKIT_INSECURE_SKIP_VERIFY_TLS=YES_I_KNOW_WHAT_I_AM_DOING, so trust does not
# matter — the cert only needs CN/SAN=localhost. IDEMPOTENT: reused if present.
#
# Output (gitignored): e2e-harness/certs/fed.crt + fed.key
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="${REPO_ROOT}/e2e-harness/certs"
CRT="${CERT_DIR}/fed.crt"
KEY="${CERT_DIR}/fed.key"

if [ -f "${CRT}" ] && [ -f "${KEY}" ]; then
  echo "[gen-e2e-fed-cert] ${CRT} already exists — reusing (idempotent)."
  exit 0
fi

command -v openssl >/dev/null 2>&1 || { echo "[gen-e2e-fed-cert] openssl not on PATH" >&2; exit 1; }

mkdir -p "${CERT_DIR}"
umask 077
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "${KEY}" -out "${CRT}" -days 3650 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1

# The cert is mounted :ro into the Caddy shim (runs as a non-root user); make the
# key world-readable enough for that container user while staying out of VCS.
chmod 644 "${CRT}"
chmod 644 "${KEY}"
echo "[gen-e2e-fed-cert] wrote ${CRT} + ${KEY} (self-signed, CN/SAN=localhost)."
