---
description: Set up hearthkit memory on this machine, step by step
---
You are helping the user set up hearthkit, which gives Claude Code memory and session handoffs that follow them across machines. Be brief and plain; assume the user may not be an engineer.

1. Call the `hearth_doctor` tool (MCP server "hearth"). If that tool is not available, tell the user to quit and reopen Claude Code once so the plugin's MCP server starts, then stop.
2. Summarise the result as a short list: what is ready, what is missing. For each `fail` or `warn` check, explain in one sentence what it is for, then show its `fix` text verbatim in a code block. Wait for the user to do it, then call `hearth_doctor` again.
3. When only the "hearthkit config" or "memory repo" checks fail: ask whether they want hearth to create a private GitHub repo for them (this needs the GitHub CLI logged in) or whether they have a private git URL to paste. Then call `hearth_init` with no arguments, or with `remote` set to their URL. Never pass `allow_public` unless the user explicitly says the repo may be public and understands their memory would be visible to others.
4. After init succeeds, ask two or three short questions to seed memory: what they do, how they like to work with you, and anything about their machine or team you should always know. Save each answer with `memory_write` in layer "global" with type "user" or "feedback". Keep each fact to one to three sentences.
5. Call `hearth_doctor` once more, confirm everything is green, and tell them in two sentences: memory now loads automatically at the start of every session, and they can say "write a handoff" any time before stopping. Mention `/hearth:sync` for pushing manually.
