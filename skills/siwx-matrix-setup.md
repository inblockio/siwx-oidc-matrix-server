---
name: siwx-matrix-setup
description: Use when deploying the Matrix server stack for the first time, configuring a new instance, setting up DNS and reverse proxy, or onboarding a new environment. Triggers on "deploy", "set up", "install", "first time", "new server", "configure".
---

# siwx-matrix-setup: First-Time Deployment

## Prerequisites

- Docker Engine + Docker Compose v2
- A reverse proxy with TLS on the `portal-net` Docker network (the maintainers use Caddy)
- Three DNS records pointing to your server:
  - `matrix.example.com` (Synapse homeserver)
  - `siwx-oidc.example.com` (OIDC provider)
  - `element.example.com` (Element Web client)
- The Docker network `portal-net` created: `docker network create portal-net`

The images are pulled from GHCR, pinned by digest in `docker-compose.yml`; no sibling
checkout of siwx-oidc is needed (only `docker-compose.local.yml` builds from one).

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
- `LIVEKIT_KEY`, `LIVEKIT_SECRET`
- All hostnames and ports

Then runs `docker compose up --pull always -d`.

## Step 2: Configure reverse proxy

The reverse proxy must handle three hostnames with specific routing rules.
`Caddyfile.local` is the complete, tested route set (HTTP-only, one port per service);
the example below is its hostname-based shape, trimmed, and `caddy adapt` accepts it as
written. Take the MatrixRTC (`/livekit/*`) and QR-login rendezvous routes from
`Caddyfile.local`.

### Caddy example

```caddyfile
# Snippets from Caddyfile.local. siwx-oidc sets its own CORS headers; the proxy
# strips them and sets them once, because two Access-Control-Allow-Origin
# headers make browsers reject the response.
(strip_upstream_cors) {
    header_down -Access-Control-Allow-Origin
    header_down -Access-Control-Allow-Methods
    header_down -Access-Control-Allow-Headers
    header_down -Access-Control-Allow-Credentials
    header_down -Access-Control-Expose-Headers
    header_down -Access-Control-Max-Age
    header_down -Vary
}

(public_cors) {
    @cors_preflight method OPTIONS
    header Access-Control-Allow-Origin "*"
    header Access-Control-Allow-Methods "GET, HEAD, POST, PUT, DELETE, OPTIONS"
    header Access-Control-Allow-Headers "X-Requested-With, Content-Type, Authorization, Date"
    header Access-Control-Max-Age "86400"
    respond @cors_preflight 204
}

matrix.example.com {
    # Matrix well-known endpoints
    handle /.well-known/matrix/server {
        respond `{"m.server": "matrix.example.com:443"}`
    }
    handle /.well-known/matrix/client {
        header Access-Control-Allow-Origin *
        # The issuer must byte-match siwx-oidc's own issuer, trailing slash included.
        respond `{"m.homeserver": {"base_url": "https://matrix.example.com"}, "m.authentication": {"issuer": "https://siwx-oidc.example.com/", "account": "https://siwx-oidc.example.com/account"}}`
    }

    # Client auth routes -> siwx-oidc (Synapse does not serve these under
    # delegated auth).
    @siwx path /_matrix/client/v3/login /_matrix/client/v3/logout /_matrix/client/v3/logout/all /_matrix/client/v3/refresh /_matrix/client/v3/delete_devices
    handle @siwx {
        import public_cors
        reverse_proxy siwx-oidc:8081 {
            import strip_upstream_cors
        }
    }

    # Device deletion -> siwx-oidc. It serves only DELETE on this path, so GET
    # and PUT of a device must fall through to Synapse.
    @siwx_device_delete {
        method DELETE
        path /_matrix/client/v3/devices/*
    }
    handle @siwx_device_delete {
        import public_cors
        reverse_proxy siwx-oidc:8081 {
            import strip_upstream_cors
        }
    }

    # Never expose the Synapse admin API or the MAS provisioning API.
    handle /_synapse/admin/* {
        respond 404
    }
    handle /_synapse/mas/* {
        respond 404
    }

    # Everything else -> Synapse
    handle {
        reverse_proxy matrix_synapse:8080
    }
}

siwx-oidc.example.com {
    import public_cors
    reverse_proxy siwx-oidc:8081 {
        import strip_upstream_cors
    }
}

element.example.com {
    reverse_proxy element-web:8080
}
```

**Critical**: The proxy must be on the `portal-net` Docker network to reach the containers by service name.

### CORS

- `.well-known/matrix/client` needs `Access-Control-Allow-Origin: *` (clients read it
  cross-origin)
- `siwx-oidc.example.com` needs CORS for the Element origin. Strip siwx-oidc's own CORS
  headers in the proxy and set them there once: two `Access-Control-Allow-Origin` headers
  make browsers reject the response
- Matrix API endpoints on `matrix.example.com` need CORS for `element.example.com`

## Step 3: Calls (LiveKit and TURN)

Calls need the `/livekit/jwt` and `/livekit/sfu` routes from `Caddyfile.local` in the
proxy, and 7881/tcp and 20100-20200/udp open in the host firewall; the
`/matrix-rtc-transport-specialist` skill has the rest. `config/livekit.yaml` ships with
LiveKit's embedded TURN **off**, so clients behind symmetric NAT or strict firewalls
cannot connect. To enable TURN:

1. Run the edge on the `caddy-l4` image built here, with the `layer4` SNI split on `:443`
   and a certificate site for the TURN host (the `/matrix-rtc-transport-specialist` skill,
   "Embedded TURN", has the Caddyfile).
2. Add a DNS record for the TURN host, e.g. `turn.example.com`, pointing at the server.
3. In `config/livekit.yaml` set `turn.enabled: true` and `turn.domain` to that host.
4. Allow 3478/udp in the host firewall. Never publish 5349; only the edge reaches it.
5. `docker compose up -d --force-recreate livekit`.

## Step 4: Verify

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

## Step 5: First login

1. Open `https://element.example.com`
2. Element discovers the OIDC provider and redirects to `siwx-oidc.example.com`
3. Connect wallet (MetaMask, etc.) or use a passkey
4. Sign the CAIP-122 challenge
5. siwx-oidc provisions the user in Synapse and redirects back to Element

## Step 6: Admin promotion (optional)

```bash
# After the target user has logged in at least once:
# Option A: Claude Code skill (DID or MXID)
/set-admin did:pkh:eip155:1:0xYourAddress

# Option B: env var (promotes on every boot; MATRIX_ADMIN_MXID is used verbatim)
echo "MATRIX_ADMIN_DID=did:pkh:eip155:1:0xYourAddress" >> .env
docker compose up -d matrix_synapse   # recreate so the new env_file value is read
```

## Deploying to a remote server

This repository ships no remote-deploy tooling; how images reach a server is
site-specific. The published images are on GHCR. Pin each one by digest in the
server's `.env` (`SYNAPSE_IMAGE_REF`, `ELEMENT_IMAGE_REF`, `SIWX_OIDC_IMAGE_REF`),
then pull and recreate on the server:

```bash
docker compose pull && docker compose up -d
```

## Checklist

- [ ] Three DNS records point to server
- [ ] `portal-net` Docker network exists
- [ ] `.env` generated (check with `ls -la .env`)
- [ ] Reverse proxy routes configured (especially login/logout/refresh to siwx-oidc, and
      `/_synapse/admin/*` and `/_synapse/mas/*` not exposed)
- [ ] Calls: firewall open for 7881/tcp and 20100-20200/udp; TURN enabled only with the
      caddy-l4 edge (3478/udp open)
- [ ] OIDC discovery returns valid JSON
- [ ] `.well-known/matrix/client` returns `m.authentication.issuer`
- [ ] Element loads and redirects to OIDC login
- [ ] Wallet or passkey sign-in completes
- [ ] User appears in Synapse (check via admin API or SQLite)
