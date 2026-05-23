---
name: siwx-matrix-setup
description: Use when deploying the Matrix server stack for the first time, configuring a new instance, setting up DNS and reverse proxy, or onboarding a new environment. Triggers on "deploy", "set up", "install", "first time", "new server", "configure".
---

# siwx-matrix-setup: First-Time Deployment

## Prerequisites

- Docker Engine + Docker Compose v2
- A reverse proxy with TLS (Caddy, nginx, or Traefik)
- Three DNS records pointing to your server:
  - `matrix.example.com` (Synapse homeserver)
  - `siwx-oidc.example.com` (OIDC provider)
  - `element.example.com` (Element Web client)
- The `siwx-oidc` repo cloned adjacent to this repo (`../siwx-oidc`)
- The Docker network `portal-net` created: `docker network create portal-net`

## Step 1: Start the stack

```bash
./start-matrix.sh \
  --MATRIX_HOST matrix.example.com \
  --SIWEOIDC_HOST siwx-oidc.example.com \
  --CLIENT_HOST element.example.com
```

This generates `.env` (chmod 600) with:
- `MAS_SHARED_SECRET` (random 64-char string)
- `SIWEOIDC_SIGNING_KEY_PEM` (P-256 EC key, single-line PEM)
- All hostnames and ports

Then runs `docker compose up --build -d`.

## Step 2: Configure reverse proxy

The reverse proxy must handle three hostnames with specific routing rules.

### Caddy example

```caddyfile
matrix.example.com {
    # Matrix well-known endpoints
    handle /.well-known/matrix/server {
        respond `{"m.server": "matrix.example.com:443"}`
    }
    handle /.well-known/matrix/client {
        header Access-Control-Allow-Origin *
        respond `{"m.homeserver": {"base_url": "https://matrix.example.com"}, "m.authentication": {"issuer": "https://siwx-oidc.example.com"}}`
    }

    # MSC3861 compat routes -> siwx-oidc (Synapse disables these)
    handle /_matrix/client/v3/login {
        reverse_proxy siwx-oidc:8081
    }
    handle /_matrix/client/v3/logout {
        reverse_proxy siwx-oidc:8081
    }
    handle /_matrix/client/v3/refresh {
        reverse_proxy siwx-oidc:8081
    }

    # Everything else -> Synapse
    handle {
        reverse_proxy matrix_synapse:8080
    }
}

siwx-oidc.example.com {
    reverse_proxy siwx-oidc:8081
}

element.example.com {
    reverse_proxy element-web:8080
}
```

**Critical**: The proxy must be on the `portal-net` Docker network to reach the containers by service name.

### CORS

- `.well-known/matrix/client` needs `Access-Control-Allow-Origin: *` (federation requirement)
- `siwx-oidc.example.com` needs CORS for `element.example.com` (the Element origin)
- Matrix API endpoints on `matrix.example.com` need CORS for `element.example.com`

## Step 3: Verify

```bash
# OIDC discovery
curl -s https://siwx-oidc.example.com/.well-known/openid-configuration | jq .

# Matrix well-known
curl -s https://matrix.example.com/.well-known/matrix/client | jq .

# Synapse health
curl -s https://matrix.example.com/_matrix/client/versions | jq .

# Element loads
curl -sI https://element.example.com/
```

## Step 4: First login

1. Open `https://element.example.com`
2. Element discovers the OIDC provider and redirects to `siwx-oidc.example.com`
3. Connect wallet (MetaMask, etc.) or use a passkey
4. Sign the CAIP-122 challenge
5. siwx-oidc provisions the user in Synapse and redirects back to Element

## Step 5: Admin promotion (optional)

```bash
# After the target user has logged in at least once:
# Option A: Claude Code skill
/set-admin did:pkh:eip155:1:0xYourAddress

# Option B: env var (auto-promotes on every boot)
echo "MATRIX_ADMIN_DID=did:pkh:eip155:1:0xYourAddress" >> .env
docker compose restart matrix_synapse
```

## Deploying to a remote server

`deploy.sh` clones both repos on the server at a given git ref, then builds and restarts:

```bash
./deploy.sh main --build --restart
```

See `/deploy` skill for full usage, tagging workflow, and troubleshooting.

## Checklist

- [ ] Three DNS records point to server
- [ ] `portal-net` Docker network exists
- [ ] `../siwx-oidc` repo is cloned and on the correct branch
- [ ] `.env` generated (check with `ls -la .env`)
- [ ] Reverse proxy routes configured (especially login/logout/refresh to siwx-oidc)
- [ ] OIDC discovery returns valid JSON
- [ ] `.well-known/matrix/client` returns `m.authentication.issuer`
- [ ] Element loads and redirects to OIDC login
- [ ] Wallet or passkey sign-in completes
- [ ] User appears in Synapse (check via admin API or SQLite)
