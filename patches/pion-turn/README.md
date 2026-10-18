# pion/turn vendored patches: the registry

This directory is the complete, canonical list of every modification we apply to
pion/turn (the embedded TURN server built into livekit-server, which this repository
builds). `dockerfiles/Dockerfile.livekit` fetches upstream at a pinned commit, applies
exactly the patches listed here with `git apply`, in file name order, runs the patch's
own tests in the patched tree, and replaces the module requirement for that build, so
**a patch that stops applying fails the image build loudly**, never silently at
runtime.

The rules are the same as `patches/livekit/README.md`: every entry states *what*,
*why*, the *evidence*, its *upstream status* and its *retirement condition*, and only
POLICY is permanent. pion/turn is MIT, like this repository's other vendored
dependencies; a file a patch adds is Apache-2.0 compatible as a modification (see
`NOTICE`).

**Bump procedure** (every change of `PION_TURN_TAG`/`PION_TURN_COMMIT` in
`dockerfiles/Dockerfile.livekit`): dry-run each patch against the new tag, then run
the patch tests in the patched tree (no Go on the host needed; the builder's toolchain
image is the one the Dockerfile pins):

```bash
d=$(mktemp -d -p ~/.cache) && git -C "$d" init -q && git -C "$d" fetch -q --depth 1 \
  https://github.com/pion/turn "refs/tags/<new tag>" && git -C "$d" checkout -q FETCH_HEAD \
  && git -C "$d" apply --check "$PWD/patches/pion-turn/0001-downlink-padding.patch" && echo OK
# then, in $d with the patch applied:
podman run --rm -v "$d":/src -w /src -e GOTOOLCHAIN=local <golang image of the Dockerfile> \
  go test -count=1 ./internal/allocation/
```

## 1. `0001-downlink-padding.patch`

**What.** Fixed-size downlink padding for the embedded TURN server. When a target is
configured (only our livekit-server build configures one; upstream and a stock build
behave identically), every media packet the server relays *to a client* is sent as a
STUN Data indication padded up to that many bytes, so the message sizes the client's
connection carries do not reveal call media (audio is normally ~200-byte packets at
50 Hz, video ~1200-byte bursts; a relayed call is then size-uniform, like bulk TLS
traffic on the same host). The knob lives in
[`patches/livekit/0002-turn-downlink-padding.patch`](../livekit/0002-turn-downlink-padding.patch)
(`LIVEKIT_TURN_DOWNLINK_PAD_BYTES`, unset = off).

**How.** The padding rides an unregistered STUN attribute inside the Data indication
(`stunAttrTypePadding`, 0x8070), not bytes between messages: TURN-over-TCP framing is
self-delimiting (`proto.STUNConn`), so anything between messages would corrupt the
stream, and comprehension-optional attribute types (0x8000-0xFFFF) must be ignored by
receivers that do not understand them (RFC 8489 s. 14.2), so no client change is
needed. With padding active the server also stops using ChannelData for
server-to-client media and always sends the Data indication: ChannelData's TCP
framing tolerates at most 3 padding bytes (`consumeSingleTURNFrame` rounds up to 4),
so it cannot be padded, while the Data indication is the base TURN delivery every
client implements. RFC 5766 s. 11.7 says the server sends a ChannelData message when a
channel is bound - a deliberate deviation, accepted for the traffic-shape goal. Only
server-to-client media is padded; client-to-server messages and TURN control traffic
(allocate, refresh, permissions) are untouched, because the client side of those is
the browser's, which this server cannot change.

**Why.** Traffic-shape parity: with the catch-all relay policy
(`config/relay-policy/all.yaml`) every call rides TURN/TLS through the edge like any
other TLS session, but the sizes of the relayed messages still named the flow as
real-time media. POLICY.

**Evidence.** `internal/allocation/allocation.go` `packetConnHandler` (the relayed
write path; ChannelData when a channel is bound, Data indication otherwise, both via
`TurnSocket.WriteTo`), `internal/proto/stun_conn.go` (one `nextConn.Write` per message
= one TLS record at a terminating edge), `internal/proto/chandata.go` `Encode`
(4-byte TCP alignment). Tests: `internal/allocation/downlink_padding_test.go` (padded
size within the target and 4-byte alignment, decodes as a Data indication with the
peer address and payload intact, the declared body length covers the whole message,
a video-sized payload passes unpadded, a non-UDP source falls back to the normal
paths, non-STUN input is never modified), run by the Dockerfile in the patched tree.

**Upstream status.** Not filed. Upstream has no padding concept; the attribute is a
reserved-range type, but the "ignore ChannelData, send indications" deviation makes
the patch unfit for upstream as is.

**Retirement condition.** Call media stops being relayed through this TURN server
(the relay policy is retired), or upstream grows a server-side padding mechanism
that covers the same surface; then drop the patch.
