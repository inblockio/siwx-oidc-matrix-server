# 2026-06-11 Call Drop Analysis: MSC4140 Delayed-Leave Expiry

Five 1:1 voice call drops between two users in 15 minutes (19:54 to 20:09
UTC+8, 11:54 to 12:10 UTC), room `RM_zhfD5EMDdniS` on `agentic.inblock.io`.

## Verdict

Every drop was caused by one participant's mobile connectivity going dark for
longer than 18 seconds. The MatrixRTC membership dead-man's switch (MSC4140
delayed leave event, client-chosen 18s expiry) fired as designed; the peer's
client then ended the 1:1 call cleanly. The media layer was never at fault:
LiveKit successfully resumed sessions across network blips and even an IP
change. No server misconfiguration contributed; no rate limiting occurred
(zero 429s in the window).

## Participants

| User | Client | Network |
|---|---|---|
| `did-pkh-eip155-1-0x4b23...` | Element Web, Chrome/Windows | 185.213.83.127 (stable, likely VPN) |
| `did-key-zdnaezp2...` | Element X iOS 26.06.0, iPhone 15 Pro | 2.241.140.247 then 176.4.190.134 (German mobile, hopped mid-session) |

## Evidence chain (call 1, reproduced for all five)

1. 11:54:28 to 11:54:44: both join LiveKit, media published.
2. 11:57:26.9: last heartbeat (`POST .../delayed_events/syd_xtGX.../restart`)
   from the iPhone. Heartbeats had been arriving every ~4s.
3. 11:57:29.2: LiveKit logs `resuming RTC session` and `ice reconnected or
   switched pair` for the iPhone's session. Media handover worked.
4. 11:57:26.9 + 18s = 11:57:44.9: Synapse fires the iPhone's scheduled
   `m.call.member` leave (the membership PUT carried
   `?org.matrix.msc4140.delay=18000`).
5. 11:57:45.3: LiveKit logs `participant closing` with
   `reason=CLIENT_REQUEST_LEAVE` for the web client, and at 11:57:45.4 the web
   client POSTs its own delayed event's `/send` (clean hangup). Its heartbeats
   never gapped: it reacted to the other side's leave.

Drops 2 to 5 show the same signature, with measured iPhone heartbeat gaps of
11s, 18s, and 23s immediately preceding the LiveKit leave events at 12:06:09
and 12:09:15.

## Why the layers disagree

LiveKit tolerates ~20s of absence (`departureTimeout: 20`, plus resume and
full-reconnect tiers), and the resume worked. The MatrixRTC membership
keep-alive is stricter: heartbeat every ~4-5s against an 18s server-side
expiry. The 18s value is chosen by the client SDK; Element Call v0.15.0
deliberately removed the `membership_server_side_expiry_timeout` config
option, so there is no supported way to lengthen it, server- or client-side.
Synapse's `max_event_delay_duration: 24h` is only an upper bound on what
clients may request.

## Server config outcome

Audit of the live `homeserver.yaml` against Element Call's
`docs/self_hosting.md` recommendations:

| Setting | Recommended | Deployed | Action |
|---|---|---|---|
| `max_event_delay_duration` | `24h` | `24h` | none |
| `rc_delayed_event_mgmt` | 1 / 20 | 1 / 20 | none |
| `rc_message` | 0.5 / 30 | unset (Synapse default 0.2 / 10) | added to entrypoint; apply live with yq + restart |
| MSC 4143 / 3266 / 4222 | enabled | enabled | none |

The `rc_message` gap did not cause these drops but is the one documented
hardening that was missing: in-call E2EE key sharing is bursty room-message
traffic and can hit the default limiter in larger or longer calls.

Also pinned `livekit/livekit-server` to `v1.12.0` (the version running in
production) in `docker-compose.yml`: with `:latest`, every `deploy.sh` pull
could jump SFU versions unannounced. Watchtower was verified not to touch
LiveKit (`WATCHTOWER_SCOPE=matrix`, container unlabeled), so no mid-call
auto-restarts were occurring.

## What actually reduces these drops

Client-side stability for the mobile participant: stable WLAN or good LTE,
keep Element X foregrounded during calls. Optional future server hardening
(not implemented, separate decisions): LiveKit TURN over TLS for UDP-hostile
networks, and self-hosting the Element Call widget to pin its version instead
of tracking `call.element.io`.

## Live apply (existing deployment, requires Synapse restart)

```bash
ssh deploy@agentic.inblock.io "cd /home/deploy/matrix/stack && \
  docker compose exec matrix_synapse sh -c '
    yq -i \".rc_message.per_second = 0.5\" /data/homeserver.yaml &&
    yq -i \".rc_message.burst_count = 30\" /data/homeserver.yaml' && \
  docker compose restart matrix_synapse"
```
