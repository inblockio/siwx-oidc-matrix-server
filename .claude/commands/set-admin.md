---
description: Promote a Matrix user to server admin by their DID (e.g. /set-admin did:pkh:eip155:1:0x...)
allowed-tools: Bash, Read
---

Promote the Matrix user identified by the DID `$ARGUMENTS` to server admin.

Follow these steps exactly:

## 1. Validate DID format

The DID must match `did:pkh:eip155:<chainId>:0x<40 hex chars>`. Reject anything else immediately with a clear error — do NOT proceed.

```bash
DID="$ARGUMENTS"
if ! echo "$DID" | grep -qE '^did:[a-z]+:[a-z0-9]+:[a-z0-9]+:0x[0-9a-fA-F]{40}$'; then
  echo "ERROR: '$DID' is not a valid DID (expected did:pkh:eip155:<chainId>:0x<address>)"
  exit 1
fi
```

## 2. Derive localpart and read MATRIX_HOST from .env

```bash
LOCALPART=$(echo "$DID" | tr ':' '-' | tr '[:upper:]' '[:lower:]')

MATRIX_HOST=$(grep '^MATRIX_HOST=' .env 2>/dev/null | head -1 | cut -d= -f2 | tr -d "\"' ")
if [ -z "$MATRIX_HOST" ]; then
  echo "ERROR: MATRIX_HOST not found in .env — run from the project root directory"
  exit 1
fi

MATRIX_USER="@${LOCALPART}:${MATRIX_HOST}"
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
