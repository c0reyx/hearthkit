# Acceptance protocol

Run this before every release tag. Automated tests prove the code; this proves the experience. Tick each box.

## Setup for testing

- Work from a copy of the plugin: `claude --plugin-dir ~/Projects/hearthkit` loads the working tree directly, no install needed.
- Two "machines" on one Mac: use a second home. In a second terminal, `export HEARTH_HOME=~/.hearth-b` before running `claude` or `hearth`; that shell is Machine B. Machine A is a normal shell.
- Two test repos: `mkdir -p ~/tmp/repo-x ~/tmp/repo-y && for d in x y; do git -C ~/tmp/repo-$d init -q; git -C ~/tmp/repo-$d remote add origin git@github.com:acceptance/repo-$d.git; done`
- Reset between runs: `rm -rf ~/.hearth ~/.hearth-b` and delete the test memory repo on GitHub (or use a throwaway `--remote`).

## A1 Fresh install

- [ ] In Claude Code: `/plugin marketplace add c0reyx/hearthkit` then `/plugin install hearthkit@hearthkit`, restart. (Or `claude --plugin-dir ~/Projects/hearthkit` for the working tree.)
- [ ] Run `/hearth:setup`. Claude calls `hearth_doctor`, explains what is missing in plain words, and offers fixes as code blocks.
- [ ] Choose "create for me". A private repo `hearth-memory` appears on GitHub. Claude asks two or three questions and saves them as global facts.
- [ ] In a terminal, `hearth doctor` is all ✔ (gh may be `!` if you used a URL instead).

## A2 Global memory

- [ ] In `~/tmp/repo-x`, start Claude Code and say: "Remember that I prefer answers as tables." Expect `Saved global/...` in the tool result.
- [ ] `ls ~/.hearth/memory/global/` shows the new file.
- [ ] Quit. In `~/tmp/repo-y`, start Claude Code and ask "How do I like answers formatted?" It answers "tables" without searching or asking.

## A3 Project memory

- [ ] In `~/tmp/repo-x`, say: "Remember that this repo uses pnpm, not npm." Expect `Saved projects/acceptance-repo-x/...`.
- [ ] In `~/tmp/repo-y`, ask "Does this repo use pnpm?" It does not know (and should not claim to).
- [ ] Back in `~/tmp/repo-x`, the fact is in context at start (ask "what package manager here?").

## A4 Agent-written handoff

- [ ] In `~/tmp/repo-x`, do a few minutes of work, then say "I'm stopping for today." Claude calls `memory_handoff`.
- [ ] `hearth handoff list` in that folder shows a `agent` handoff.
- [ ] Quit, start a new session there. The first thing in context is `## Last handoff (written by the agent, ...)`. Ask "where were we?" and get a correct answer without tools.

## A5 Automatic handoff

- [ ] In `~/tmp/repo-y`, chat for a few turns including one that makes Claude read a file, then quit without saying anything.
- [ ] `hearth handoff list` shows an `auto` handoff. `hearth memory show`-style inspection (`cat` the file) shows only **User:** and **Assistant:** lines, none of the file's contents.
- [ ] `tail -3 ~/.hearth/logs/hearth.log` shows a `handoff capture` entry with `wrote` set.

## A6 Two machines

- [ ] Machine B shell: `hearth init --remote <your memory repo url>` then `hearth doctor` is green.
- [ ] Machine A: `hearth memory add global "Test fact from A"`, `hearth sync`. Machine B: `hearth sync`, then `hearth memory show global test-fact-from-a` prints it.
- [ ] Reverse: add on B, sync both, show on A.
- [ ] Conflict: on both machines edit the same fact (`hearth memory add global "A says" --name shared` on A, `... "B says" --name shared` on B). Sync A, then sync B. B reports a conflict; `hearth memory show global shared` is A's, `hearth memory show global shared.conflict-<device>` is B's; `hearth doctor` names the pair. Sync A; A has both files.
- [ ] Resolve: `hearth memory delete global shared.conflict-<device>`, sync both, doctor is green on both.

## A7 Promote

- [ ] In `~/tmp/repo-x`: `hearth memory add project "I am in Central Time" --name timezone`, then `hearth memory promote timezone`.
- [ ] `hearth memory show global timezone` works; `hearth memory show project timezone` says no such fact.
- [ ] A session in `~/tmp/repo-y` now has `timezone` in the global index.

## A8 Offline and failures

- [ ] Turn off Wi-Fi. In `~/tmp/repo-x`, chat briefly and quit. No error appears in Claude Code. `hearth handoff list` shows the new handoff. `hearth doctor --offline` shows `!` unsynced changes and the network check skipped.
- [ ] Turn Wi-Fi on. `hearth sync` pushes. `hearth doctor` is green.
- [ ] `echo 'garbage' | hearth handoff capture; echo $?` prints `0`, and the log has an error entry.

## A9 Where is everything

- [ ] `hearth where` in `~/tmp/repo-x` lists every path with ✔ or ·, the owner, and `project slug: acceptance-repo-x`.
- [ ] Open each ✔ path in Finder (`open <path>`) and confirm it is what the label says.

## A10 Another tool

- [ ] Configure any MCP client (Codex CLI, or `npx @modelcontextprotocol/inspector node ~/Projects/hearthkit/dist/mcp.js`) with `HEARTH_HOME` unset. Call `memory_search` with `pnpm`. The same fact Claude Code sees comes back.

When a scenario fails, open an issue titled `A<number>: <what happened>` with the exact commands and output.
