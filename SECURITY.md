# Security policy

siwx-oidc-matrix-server is the Matrix deployment bundle of siwx-oidc, a pathfinder project
run by inblock.io assets GmbH on a non-commercial basis and provided as is, without warranty
(Apache-2.0 §§7–8). There is no support offering, no SLA, and no commitment to maintain it
for third-party deployments. Security reports are welcome and handled best-effort.

## Supported versions

There are no tagged releases yet. Only the latest commit on `main` is supported; fixes land
there and are not backported. CI publishes the images built from `main` to
`ghcr.io/inblockio/siwx-oidc-matrix-server/<image>` (`synapse`, `element-web`, `caddy-l4`)
under the tags `main`, `latest` and `sha-<commit>`. The image defaults in
`docker-compose.yml` pin one such build by digest and are updated deliberately, so they
can lag behind `main`.

## Reporting a vulnerability

Please do **not** open a public issue, discussion or pull request for a vulnerability.

Report privately through GitHub (the repository's **Security** tab → **Report a
vulnerability**), which is the preferred channel, or by email to **hello@inblock.io** with
`SECURITY` in the subject.

Please include:

- what is affected (image, Dockerfile, patch, entrypoint, configuration file or script)
  and the commit you tested;
- steps to reproduce, or a proof of concept;
- the impact as you understand it (for example a user overwriting another user's
  `io.inblock.did`, a Synapse admin or MAS route reachable from outside, a secret written
  somewhere readable);
- whether the issue is already public, and how you would like to be credited.

## What to expect

Reports are acknowledged and handled on a best-effort basis. There are **no guaranteed
response or fix times**, no SLA and no bug bounty. We aim to tell you what we decide to do
about a confirmed issue, and to credit you in the fix unless you ask us not to. Please give
us a reasonable chance to fix the issue before you disclose it.

## Scope

In scope: the content of this repository, that is the Dockerfiles and the images CI builds
from them, the vendored Synapse and Element Web patches, `entrypoints/` (including the
startup guard for the `io.inblock.did` field), `config/` (Element, nginx and LiveKit
configuration, the service-worker boot shim), the Compose files and `Caddyfile.local`, and
`scripts/`.

Out of scope here:

- the siwx-oidc server and its `siwx-oidc-auth` client: report to
  [inblockio/siwx-oidc](https://github.com/inblockio/siwx-oidc);
- vulnerabilities in upstream Synapse, Element Web, LiveKit, lk-jwt-service, Redis or
  Caddy that our patches and configuration do not introduce: report to those projects. If
  you are unsure whether an issue comes from our patch or from upstream, report it here
  and we will route it.

## Existing security material

- [`patches/synapse/README.md`](patches/synapse/README.md): why the `io.inblock.did` field
  needs the MSC4133 write-policy patch, what it covers and what it does not, and the
  startup guard that refuses to run a Synapse without it.
- [`patches/element-web/README.md`](patches/element-web/README.md): every Element Web
  deviation, with its evidence.
- [`docs/audits/`](docs/audits/): dated audits of specific features.
- `config/element-nginx-security-headers.inc` and `scripts/element-deploy-audit.sh`: the
  Element Web security headers and a read-only check of a deployment's headers and caching.
