---
description: Promote a Matrix user to server admin by their DID or MXID (e.g. /set-admin did:pkh:eip155:1:0x... or /set-admin @localpart:host)
allowed-tools: Bash, Read
---

Promote the Matrix user identified by `$ARGUMENTS` (a DID, or an MXID) to server admin.

**Never derive the MXID from the DID (2026-09-27).** siwx-oidc gives every NEW DID an opaque
localpart (16 base36 chars, e.g. `@1vo8g4vofiha69ua:host`) and keeps pre-2026-09 accounts on their
legacy `did-...` localpart, so only the server knows which applies.

Follow these steps exactly:

## 1. Validate the argument

An MXID (`@localpart:host`), or a DID: `did:pkh:eip155:<chainId>:0x<40 hex chars>` or
`did:key:z<base58btc>`. Reject anything else immediately with a clear error — do NOT proceed.

```bash
ARG="$ARGUMENTS"
if ! echo "$ARG" | grep -qE '^(@[a-z0-9._=/+-]+:[A-Za-z0-9.:-]+|did:[a-z]+:[a-z0-9]+:[a-z0-9]+:0x[0-9a-fA-F]{40}|did:key:z[1-9A-HJ-NP-Za-km-z]+)$'; then
  echo "ERROR: '$ARG' is neither an MXID nor a valid did:pkh / did:key"
  exit 1
fi
```

## 2. Resolve the MXID (MXID verbatim; a DID via siwx-oidc /resolve)

```bash
MATRIX_HOST=$(grep '^MATRIX_HOST=' .env 2>/dev/null | head -1 | cut -d= -f2 | tr -d "\"' ")
SIWX=$(grep '^SIWEOIDC_BASE_URL=' .env 2>/dev/null | head -1 | cut -d= -f2 | tr -d "\"' ")
if [ -z "$MATRIX_HOST" ]; then
  echo "ERROR: MATRIX_HOST not found in .env — run from the project root directory"
  exit 1
fi

case "$ARG" in
  @*) MATRIX_USER="$ARG" ;;
  *)
    # The public lookup applies siwx-oidc's own grandfathering rule.
    ANSWER=$(curl -s -m 20 -G --data-urlencode "did=$ARG" "${SIWX%/}/resolve" -w '\n%{http_code}')
    CODE=$(printf '%s' "$ANSWER" | tail -n1); BODY=$(printf '%s' "$ANSWER" | sed '$d')
    if [ "$CODE" = "200" ]; then
      MATRIX_USER=$(printf '%s' "$BODY" | sed -n 's/.*"mxid":"\(@[^"]*\)".*/\1/p')
    else
      # /resolve unavailable (404 = siwx-oidc older than c5ed83b). The ONLY safe fallback is
      # the grandfathered legacy account, and step 3 promotes it only if it already EXISTS
      # (siwx-oidc checks legacy first, so an existing legacy account is the DID's account).
      echo "WARN: ${SIWX}/resolve answered HTTP $CODE; trying the grandfathered legacy account only"
      MATRIX_USER="@$(echo "$ARG" | tr ':' '-' | tr '[:upper:]' '[:lower:]'):${MATRIX_HOST}"
    fi
    ;;
esac
[ -n "$MATRIX_USER" ] || { echo "ERROR: could not resolve an MXID for $ARG"; exit 1; }
echo "Target user: $MATRIX_USER"
```

## 3. Promote via SQLite — values passed as env vars, never interpolated into Python source

```bash
MATRIX_USER="$MATRIX_USER" \
docker compose exec -T matrix_synapse python3 << 'PYEOF'
import sqlite3, sys, os

user = os.environ['MATRIX_USER']   # value comes from env, never from shell interpolation

try:
    conn = sqlite3.connect('/data/homeserver.db')
    c = conn.cursor()
    c.execute('SELECT name, admin FROM users WHERE name=?', (user,))
    row = c.fetchone()
    if not row:
        print(f'ERROR: {user} not found in the database.')
        print('The user must complete at least one OIDC login before being promoted.')
        conn.close()
        sys.exit(1)
    if row[1] == 1:
        print(f'{user} is already a server admin.')
        conn.close()
        sys.exit(0)
    c.execute('UPDATE users SET admin=1 WHERE name=?', (user,))
    conn.commit()
    print(f'SUCCESS: {user} is now a server admin.')
    conn.close()
except Exception as e:
    print(f'ERROR: {e}')
    sys.exit(1)
PYEOF
```

## 4. Confirm and advise

Report the result to the user. If successful, remind them that no Synapse restart is needed — admin status is checked from the DB on each relevant request.
