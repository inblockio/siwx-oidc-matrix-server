# matrix.org's policy server silently refuses our DID-derived user IDs

**Status:** open, remediation in progress via the policyserv channel.
**Severity:** potentially product-level. Scope is NOT yet established, and
establishing it is the next action.

## The finding

Events sent to `#element-dev:matrix.org` from `@did-pkh-eip155-1-0x…` were refused
by that room's policy server (`beta2.matrix.org`). Synapse returned
`400 This message is not allowed by the policy server`. The messages never reached
the room, and **nothing surfaced to the sender in-client**. They simply were not
there, which is how this went unnoticed long enough to look like a moderator
deleting them.

Controlled A/B, same homeserver, same room, minutes apart, only the sender differs:

| Sender | MXID length | localpart length | alphanumeric segments | Result |
|---|---|---|---|---|
| `@did-pkh-eip155-1-0x…` | 82 | 59 | 5 | **`400`, refused** |
| `@inblock:…` | 30 | 7 | 1 | `200`, signed by `beta2.matrix.org` |

The second event came back carrying a real `ed25519:policy_server` signature, so the
policy server will sign for our homeserver. It just will not sign for that **user
ID shape**. Consistent with policyserv's `UserIdLengthFilter` /
`UserIdContainsWordsFilter`, though the configured filter and threshold are not
externally visible.

## Why this is bigger than one dropped message

**Every inblock.io account has a DID-derived localpart.** The auth provider mints
Matrix localparts from DIDs, so they are long and multi-segment for every user
without exception. This is not one account having a bad day; if user-ID shape is a
filtering criterion, it applies to the entire user population.

The failure mode is the dangerous kind: **silent**. No error reaches the user, no
error reaches the room. A user simply appears not to be participating.

## Do this BEFORE deciding whether to escalate

The evidence today covers exactly **one room and one policy server**. That single
fact decides whether this is a footnote or a strategic problem, so establish it
first:

1. Post from a DID-shaped account into several other policy-server-protected
   matrix.org rooms.
2. Determine whether `beta2.matrix.org` is a default for many matrix.org rooms or a
   one-room experiment.

- **Narrow** (one room, one misconfigured threshold): ordinary bug. Never needs an
  escalation.
- **Broad** (policy servers filter by ID shape generally, and adoption is growing):
  Aqua's MXID scheme is structurally incompatible with a spreading part of the
  Matrix ecosystem. That is a design problem, not a bug report.

## Escalation ladder

1. **Now:** the policyserv channel, plus an issue against `matrix-org/policyserv`.
2. **Escalate to Matthew Hodgson only if BOTH hold:**
   - scope is confirmed **broad** per the test above, AND
   - either there has been no substantive response for **3 weeks**, or the answer is
     "working as intended and not changing".

The reason for that specific gate: a misconfigured threshold on one room is a normal
bug and a CEO adds nothing to it. But "policy servers filter on user-ID shape by
design" is a question about whether Matrix intends to accommodate DID-derived
identities at all, and that IS a protocol-direction conversation rather than a
support ticket. Escalating before scope is known spends a personal relationship on
what may be a config typo.

## Design implication to decide either way

If shape-based filtering persists, long multi-segment localparts are a liability
beyond this one policy server. The alternative is a short or hashed localpart with
the DID carried in profile data or account metadata instead. That is a change to how
siwx-oidc mints localparts, so it belongs to that repo's design, not this one.
Worth deciding deliberately rather than discovering later, and worth deciding even
if this particular policy server relents.

## Provenance

Discovered while chasing "why did my messages to `#element-dev` vanish" during the
element-web PR #34718 review thread. The analysis currently lives in a comment on
that PR; this file exists so it is not lost when that thread closes.
