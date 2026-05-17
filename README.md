# siwx-oidc-matrix-server

Docker Compose deployment stack that runs a Synapse Matrix homeserver fronted by
siwx-oidc (CAIP-122 OIDC provider) so agents and wallets can authenticate with
EIP-191, Ed25519, or P-256 keys. Includes a self-hosted Element Web client with
automatic SIWX login (zero-click wallet authentication).

## Table of Contents

1. [Quick Start](#quick-start)
2. [Services](#services)
3. [Parameters](#parameters)
4. [Security](#security)
5. [Examples](#examples)
6. [Element Web Client](#element-web-client)
7. [Mobile Wallet Usage](#mobile-wallet-usage)
8. [Issues/Integrations](#issuesintegrations)
9. [Contributing](#contributing)

## Quick Start

```bash
./start-matrix.sh \
  --MATRIX_HOST matrix.example.com \
  --SIWEOIDC_HOST siwx-oidc.example.com \
  --CLIENT_HOST element.example.com \
  --LETSENCRYPT_EMAIL admin@example.com
```

This provisions TLS certificates automatically via Let's Encrypt, starts all
services, and makes the Element Web client available at `https://element.example.com`.

## Services

| Service | Image | Purpose |
|---|---|---|
| `matrix_synapse` | `matrixdotorg/synapse` | Matrix homeserver (federation on port 8448) |
| `siwx-oidc` | `ghcr.io/inblockio/siwx-oidc` | CAIP-122 OIDC provider (wallet-based auth) |
| `redis` | `redis` | Session store for siwx-oidc |
| `element-web` | `vectorim/element-web` (custom layer) | Web client with auto-SIWX login |
| `proxy` | `nginxproxy/nginx-proxy` | Reverse proxy with TLS termination |
| `letsencrypt` | `nginxproxy/acme-companion` | Auto-provisions Let's Encrypt certificates |

## Parameters

### General

#### --LETSENCRYPT_EMAIL **Required**

Email address for Let's Encrypt certificate notifications (expiry warnings,
security updates). Use a valid, monitored address.

#### --ENABLE_DEBUG

Enables debug mode: disables detached Docker Compose, sets siwx-oidc log level
to debug for real-time log output.

#### --stop

Stop all containers.

#### --reset

**Destroys all data.** Removes containers, volumes, and the `.env` file. Irreversible.

### SIWX-OIDC Config

> **Note:** Environment variable names use the `SIWEOIDC_` prefix for backward
> compatibility with configuration tooling.

#### --SIWEOIDC_HOST **Required**

Hostname for the siwx-oidc OIDC provider (e.g., `siwx-oidc.example.com`).

#### --SIWEOIDC_CLIENT_ID

Client ID for OIDC authentication. Auto-generated if not set.

#### --SIWEOIDC_SECRET_ID

Client secret for OIDC authentication. Auto-generated if not set.

#### --SIWEOIDC_PORT

Port for the siwx-oidc service. Default: `8081`.

#### --SIWEOIDC_DEFAULT_CLIENTS

Pre-configured OIDC client list. Auto-generated if not set.

### Matrix

#### --MATRIX_HOST **Required**

Hostname for the Matrix server (e.g., `matrix.example.com`).

#### --MATRIX_PORT

Port for the Matrix server. Default: `8080`.

#### --MATRIX_MESSAGE_LIFETIME

Duration messages are retained before automatic deletion. Default: `4w`.

#### --MATRIX_REPORT_STATS

Enable/disable Matrix server usage statistics reporting. Default: `no`.

### Element Web Client

#### --CLIENT_HOST **Required**

Hostname for the self-hosted Element Web client (e.g., `element.example.com`).
The client auto-redirects unauthenticated users to the SIWX wallet login flow.

## Security

### .env file permissions

The `.env` file contains secrets and is created with restricted permissions:

```bash
chmod 600 .env
```

`start-matrix.sh` sets this automatically. Do not relax these permissions.

### OIDC signing key

An EC P-256 signing key is auto-generated on first run and stored in `.env`
(never as a separate file on disk). Do not delete it; tokens become invalid
if the key changes.

## Examples

### Start (production):

```bash
./start-matrix.sh \
  --MATRIX_HOST matrix.example.com \
  --SIWEOIDC_HOST siwx-oidc.example.com \
  --CLIENT_HOST element.example.com \
  --LETSENCRYPT_EMAIL admin@example.com
```

### Stop:

```bash
./start-matrix.sh --stop
```

### Reset (destroys all data):

```bash
./start-matrix.sh --reset
```

### Debug mode:

```bash
./start-matrix.sh --ENABLE_DEBUG \
  --MATRIX_HOST matrix.example.com \
  --SIWEOIDC_HOST siwx-oidc.example.com \
  --CLIENT_HOST element.example.com \
  --LETSENCRYPT_EMAIL admin@example.com
```

## Element Web Client

A self-hosted Element Web instance is included in the stack, accessible at
`https://<CLIENT_HOST>`. It provides a zero-click SIWX login experience:

1. User visits `https://element.example.com`
2. A branded splash screen appears briefly
3. The wallet popup opens automatically (no buttons to click)
4. After signing, the user lands directly in the chat

The client is pre-configured to connect to the local Synapse instance. No
homeserver configuration is needed by the user.

The redirect logic lives in `config/siwx-redirect.js`. The branded splash
screen is in `config/siwx-splash.html`. Both are injected into Element's
`index.html` at container start by `entrypoints/element_entrypoint.sh`.

No Element Web fork is required. The stock `vectorim/element-web` image is
used as a base with a thin configuration layer on top.

## Mobile Wallet Usage

For mobile, use the self-hosted Element Web client (`https://<CLIENT_HOST>`)
in combination with a mobile wallet browser (e.g.,
[Phantom Wallet](https://phantom.app/) on iOS).

## Issues/Integrations

### Element Android

https://github.com/element-hq/element-meta/discussions/2556

## Contributing

Open contribution requests (new integrations, features, and services) are
tracked in the [request-for-contribution](https://github.com/inblockio/request-for-contribution)
repo. Browse open requests there if you want to help or propose new work.
