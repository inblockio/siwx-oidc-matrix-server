# Relay policy

Clients whose address falls in a range listed here get **relay-only ICE over TURN/TLS on
:443 from the first second** of a LiveKit call, instead of trying UDP first. One
server-side rule covers every call client: Element Web, Element X (embedded Element
Call) and any other Element Call or livekit-client app all apply LiveKit's `forceRelay`
and its TURN list.

Two reasons put a client here. Networks that filter UDP media (VoIP blocking), where a
call otherwise fails slowly or is cut after it connects, and privacy: with relay-only
ICE, call media never leaves the client as plaintext STUN, DTLS or non-443 TURN that
on-path DPI can flag as VoIP; it rides an ordinary TLS connection through the edge, same
certificate and same handshake profile as any other site on the host. Since
`all.yaml` (below) matches every client, that second reason is the default every
deployment ships. Residual, accepted: packet timing and size statistics still look like
real-time media; padding or cover traffic would be the fix and is not built.

It needs our LiveKit image (`dockerfiles/Dockerfile.livekit`, patch
[`patches/livekit/0001-relay-policy.patch`](../../patches/livekit/README.md)) and embedded
TURN with its TLS leg in `config/livekit.yaml` (`turn.enabled`, `turn.domain`,
`tls_port`, behind the `caddy-l4` edge). Without the TLS leg, LiveKit ignores the policy and
logs a warning. The stock image ignores the policy entirely. `docker-compose.yml` mounts
this directory at `/etc/livekit-relay-policy` (`LIVEKIT_RELAY_POLICY_DIR`).

## One file per policy

```yaml
name: ae-carriers              # required, unique across files; LiveKit logs it on a match
description: >-                # free text
  Who these networks are and why they are here.
asns: [5384, 15802]            # one-line list; scripts/relay-policy-refresh reads it
manual_prefixes: []            # hand-maintained CIDRs (IPv4 or IPv6), kept as they are
prefixes:                      # generated from asns; must stay the LAST key
  - 2.48.0.0/14
```

LiveKit matches `prefixes` and `manual_prefixes`. Unknown keys, a bad CIDR or a missing or
duplicate name stop LiveKit at startup. CI loads this directory with the same code on every
pull request (job "LiveKit patch tests and relay policy", `TestRelayPolicyValidateDir`) and
again in the image build, so a broken file fails CI before it reaches a deployment. A
running LiveKit re-checks this directory at most every 30 s and loads a changed or added
file without a restart; a broken change keeps the previous policy and logs an error.

## Adding a country or carrier

1. Find the carriers' ASNs (RIPEstat `country-resource-list` and `as-overview` for the
   country, or the carriers' own peering pages).
2. Add `config/relay-policy/<country>-carriers.yaml` with `name`, `description`, `asns`,
   `manual_prefixes: []` and an empty `prefixes:` as the last line.
3. Fill the prefixes: `go run scripts/relay-policy-refresh/main.go` (Go 1.22 or later,
   standard library only; or in the golang image that `dockerfiles/Dockerfile.livekit`
   pins).
4. Commit and deploy the file. No restart is needed.

## Updating a deployment's copy

A running LiveKit may reload this directory at any moment, so never rewrite a policy file in place on a
deployment (a reload could read half a list, which still parses): write the new file under a name that does not
end in `.yaml` in the same directory and `mv` it over the old one. `scripts/relay-policy-refresh` does the same.

## Keeping the lists current

Carriers announce new ranges over time. `go run scripts/relay-policy-refresh/main.go
-check` exits 1 when a file is out of date; run without `-check` to rewrite the lists, then
commit. The tool refuses to write an empty list for a policy that names ASNs, so an API
outage cannot switch a policy off.

## Policies

| File | Networks |
|---|---|
| `all.yaml` | Every client (`0.0.0.0/0`, `::/0`): the call-media default, see below |
| `ae-carriers.yaml` | United Arab Emirates: e& (Etisalat) AS5384, AS8966; du AS15802, AS57187 |

## The catch-all

`all.yaml` is not a carrier list: `/0` matches every client, so relay-only ICE over
TURN/TLS is the default for every call, everywhere, from the first second. Its purpose is
the privacy half of the intro, not VoIP-blocking workarounds (though it covers those
too). It names no ASNs, so `relay-policy-refresh` leaves it alone
("no asns, left alone"), and its `prefixes` are hand-maintained on purpose: the dir
validation (`TestRelayPolicyValidateDir`) requires a non-empty `prefixes`, which is why
the catch-all lives there and not in `manual_prefixes`.

To revert a deployment to carrier-scoped relay (media quality on lossy links is the
price of the TLS-only default: TCP head-of-line blocking): delete `all.yaml` from that
deployment's policy directory. The hot reload picks it up within 30 s, no restart; an
in-flight call keeps its ICE config until it reconnects.
