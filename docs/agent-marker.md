# Agent marker (`inblock_agent_marker`)

A Synapse module that lists self-flagged agent accounts in the room state
`io.element.functional_members` (MSC4171, key `service_members`), so that a client that
honours it (Element Call with our patch 0200) does not ring an agent in a direct chat.
Code: `synapse-modules/inblock_agent_marker`. Tests: `synapse-modules/inblock_agent_marker_tests`.

The module is **inert until a server lists it** in `modules:`. The image carries the code;
`entrypoints/matrix_server.sh` registers it only when `AGENT_MARKER_ENABLED=true`.

## What it does

- The flag is the profile field `io.inblock.agent` (MSC4133) set by the account itself to
  `true`. `1` counts as true too (SQLite stores a JSON true as 1, Postgres as true).
- **Join.** When a local flagged account joins a room, it is added to `service_members`. The
  state event is sent **in the name of whoever invited it**: the module walks from the account's
  current join to the membership event it replaced (through joins that are profile changes), and
  the inviter is the sender of that event if it is an invite; an invite from an earlier stay does
  not count, and no stream ordering is compared (backfilled events have negative ones). Every other key and entry of an existing event is kept.
- **Own chats.** A chat the agent created itself has no inviter; it is marked in the agent's own
  name (`mark_own_rooms`, default `true`; the owner's answer OQ1). The write waits
  `own_room_delay_seconds` (2 s) so that room creation finishes first.
- **On flag.** When an account's flag goes from unset or false to true, the module marks that
  account's existing chats. Other profile changes (a new display name) do nothing, so a mark a
  room admin removed does not come back that way.
- **Start sweep.** At start (after `startup_delay_seconds`), every flagged account is checked, in
  batches of `sweep_batch_size`. It writes only where a flagged, joined agent is missing from the
  list; there is no timer. A mark a person removed by hand therefore comes back at the next start;
  the flag is the truth. Nothing removes a mark (an agent that leaves keeps its entry; a listed
  account that is absent does nothing).
- **Skips.** One log line (INFO, `agent_marker: skip ...`) and no Synapse warning, never another
  member as sender: the inviter may not write the state (power level), has left, is suspended,
  locked, shadow-banned or deactivated (the module's send bypasses those checks, so it makes
  them), is on another server, or there is no invite on record (joined by link). A chat whose
  `service_members` exists but is not a list is skipped too and never overwritten. Such a chat
  stays unmarked. In the start sweep an unexpected error in one chat is logged (with its trace)
  and the sweep goes on with the next.
- The module never sends with a remote sender and never reacts to its own event (it has no event
  trigger).

## Configuration (`modules:` entry `inblock_agent_marker.AgentMarker`)

| Key | Default | Meaning |
|---|---|---|
| `flag_field` | `io.inblock.agent` | the profile field |
| `mark_own_rooms` | `true` | mark chats the agent created, in its own name |
| `own_room_delay_seconds` | `2` | wait before marking a chat that is just being created |
| `join_wait_seconds` | `10` | how long to wait for a join to be stored |
| `startup_delay_seconds` | `5` | delay of the start sweep |
| `sweep_batch_size` / `sweep_pause_seconds` | `25` / `0.2` | sweep pacing |

Entrypoint variables: `AGENT_MARKER_ENABLED` (off unless true), `AGENT_MARKER_FLAG_FIELD`,
`AGENT_MARKER_MARK_OWN_ROOMS`. A malformed value or an import failure refuses to start; the entry
is removed again when the flag is off. The homeserver row belongs to aqua-ops (RULE-OPS-001).

## Synapse internals and the log noise

The module uses six Synapse-internal dependencies, listed at the top of `module.py` and kept
there only. They are why the suite is a step of the Synapse bump procedure
(`patches/synapse/README.md`, rule 4; `synapse-modules/run-tests.sh`, also with `--postgres`).

It does not register `on_new_event`. With that callback registered, Synapse 1.165.0 logs two
logcontext WARNINGs per state event from its own dispatcher (the request that sent the event has
finished by the time the dispatcher awaits the store); a callback cannot avoid it. The module uses
Synapse's join notification instead, which arrives before the join event is stored, so it waits
for the `room_memberships` row. `LogNoiseTestCase` runs one scenario bare, with the module and with
a do-nothing `on_new_event` callback (control) on the same server and counts WARNING lines.

## What it cannot do

A chat is skipped when the inviter may not write the state; an account that flags itself wrongly is
listed in every chat it is in and stays listed (nothing removes a mark). The Aqua guest policy
module sees the module's event like any other (`check_event_allowed`); the suite loads both.
