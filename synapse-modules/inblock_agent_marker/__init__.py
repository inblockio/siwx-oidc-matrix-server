# SPDX-License-Identifier: Apache-2.0
#
# Copyright 2026 inblock.io assets GmbH
#
# Synapse module: lists self-flagged agent accounts in the room state
# `io.element.functional_members` (MSC4171). The contract is docs/agent-marker.md; the
# entry Synapse loads is `inblock_agent_marker.AgentMarker`.

from inblock_agent_marker.module import AgentMarker, AgentMarkerConfig

__all__ = ["AgentMarker", "AgentMarkerConfig"]
