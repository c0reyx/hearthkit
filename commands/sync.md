---
description: Push and pull hearthkit memory now
---
Call the `hearth_sync` tool (MCP server "hearth") and report its one-line result to the user. If it mentions conflicts kept as extra copies, list them and offer to show both versions with `memory_read` so the user can choose which to keep; delete the loser with the CLI command `hearth memory delete <layer> <name>` only if the user asks.
