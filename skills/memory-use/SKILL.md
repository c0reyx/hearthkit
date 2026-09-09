---
name: memory-use
description: How and when to use hearthkit memory tools (memory_write, memory_search, memory_promote, memory_handoff). Use when deciding whether something the user said should be remembered, when they refer to earlier work, or when finishing a task.
---
# Using hearthkit memory

## What to save
Save facts that will still matter in a future session: who the user is, how they like to work, corrections they gave you, stable facts about a codebase (tooling, conventions, gotchas), and pointers to external resources. Do not save task chatter, file contents, secrets, or anything obvious from the repo itself.

## Which layer
- `global`: true in any repo. The user's role, preferences, machine, team, tone corrections.
- `project`: true only for this codebase. Build commands, conventions, where things live, known traps.

Rule of thumb: if it would still be true in a different repo, it is global. If you wrote something to `project` and later realise it is general, call `memory_promote`.

## When to write
Right after the user states a preference or corrects you, and after you discover a non-obvious fact about the codebase the hard way. One fact per call, one to three sentences, a clear kebab-case name.

## Pinning
Set `pinned: true` only for facts that must be in front of you every session, such as a rule you keep forgetting or a hard constraint. Pinned facts cost context every time.

## Handoffs
Before you finish a task, and whenever the user says they are stopping or switching machines, call `memory_handoff`. Be concrete: what was in progress, what was decided and why, what is unresolved, exact next steps, files touched. The next session, possibly on another machine, starts with that text.

## When a tool says the project is not linked
`projects/<slug>` on this machine belongs to one folder, and this session's folder is not it. Do not retry with an explicit `projects/<slug>` layer, and do not write the fact to `global` to get around it — global memory is for things true in any repo. Tell the user what happened and that running `hearth project link` in the folder they mean will hand that project's memory to it (`hearth project show` prints the current state). Global memory and search still work meanwhile.

## Searching
When the user refers to something you may have discussed before, or asks "where were we", call `memory_search` before asking them to repeat themselves.
