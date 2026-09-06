# hearthkit — Design Spec (narrowed v1)

**Date:** 2026-09-06 (revision 5: narrowed v1 plus promote, store interface, acceptance protocol)
**Status:** Draft for review
**Working name:** `hearthkit`. A Claude Code plugin whose slash commands, hooks, and MCP server are all backed by one bundled CLI, `hearth`.

## 1. Problem

Claude Code forgets between machines and between sessions. Its auto-memory is documented as machine-local and per project directory. Leaving a session and coming back on another laptop, or in another folder, means re-explaining who you are and what you were doing. Nothing popular fixes this with plain files you own: the large memory tools (mem0, claude-mem) are database or cloud backed, Anthropic's handoff and cross-device feature requests are open, and the git-based attempts are tiny.

hearthkit is the missing continuity layer: memory and handoffs stored as markdown in a private git repo you control, loaded automatically at the start of every Claude Code session on every machine.

## 2. What v1 is, and is not

**v1 is** one Claude Code plugin, installable from a public marketplace in two commands, that provides:

1. **Two memory layers** synced through a private git repo: `global/` (about you) and `projects/<slug>/` (about one codebase), one fact per markdown file.
2. **Project handoffs**: what you were working on, written by the agent before it stops and captured automatically from the transcript if it does not, then loaded in full at the next session start in that project on any machine.
3. **Automatic delivery**: a session-start hook injects the latest handoff and the memory indexes; a session-end hook captures the handoff; an MCP server lets the agent search, read, and write memory during the session.
4. **Guided setup inside Claude Code**: `/hearth:setup` checks the baseline and walks the user through creating or connecting a private memory repo, conversationally.
5. **A terminal CLI** for the same operations and for diagnosis: `hearth sync`, `hearth doctor`, `hearth where`, `hearth memory …`, `hearth handoff …`.

**v1 is not** (each deliberately deferred, see §12):

- A per-agent memory layer or agent scaffolding. Claude Code marketplaces already distribute agents; hearthkit documents how to use them with hearthkit and adds the agent layer in v1.1.
- Model profiles or local-model launching. Ollama speaks the Anthropic API natively (`ollama launch claude`), and claude-code-router and CCS already manage profiles. Documented, not built.
- A web dashboard or shell installer. The plugin install and `/hearth:setup` are the setup path. A dashboard is v2, once there are users to design it for.
- Semantic search. Keyword search over a small human-written corpus is enough for v1; embeddings return in v1.1 if search quality is actually a complaint.
- A hosted service. Git is the sync. A hosted team layer is the potential paid product in §14, decided later.
- Codex or other runtimes as first-class targets. The MCP server works from any MCP-capable tool today; generated config for them is v1.1.

## 3. Baseline requirements

| Requirement | Why | Checked by |
|---|---|---|
| Claude Code, logged in | it is the host | `/hearth:setup`, `hearth doctor` |
| `git` | sync | same |
| Node 20+ | the bundled CLI runs on it; Claude Code's native binary does not guarantee Node is present | same, with install link |
| A private git remote for memory | GitHub free tier, GitLab, Bitbucket, or a bare repo over SSH | same; `gh` is used when present to create a GitHub repo, otherwise the user pastes a remote URL |

Nothing else. No Python, no Docker, no API keys, no local model.

## 4. Architecture

### 4.1 Repositories

| Repo | Visibility | Contents |
|---|---|---|
| `<corey>/hearthkit` | public | The plugin: `.claude-plugin/plugin.json`, `hooks/`, `.mcp.json`, `skills/` (setup and memory-use guidance), `commands/`, bundled `dist/`, source, tests, docs. Also a one-plugin marketplace (`.claude-plugin/marketplace.json`) pointing at itself, so `claude plugin marketplace add <corey>/hearthkit` works. |
| `<user>/hearth-memory` | private, one per person | `global/`, `projects/<slug>/`, handoffs. Created or connected by `/hearth:setup`. |
| `<team>/agents` (optional, not built by v1) | private, shared | A normal Claude Code marketplace of team agent plugins. hearthkit's docs explain how to make one and how its agents pick up hearthkit memory. |

### 4.2 Where everything lives

| Path | What | Owned by |
|---|---|---|
| `~/.claude/plugins/…/hearthkit/` | the installed plugin, including `dist/hearth.js` and `dist/mcp.js` | Claude Code |
| `~/.hearth/config.json` | memory repo location, device name, context cap | hearthkit |
| `~/.hearth/memory/` | local clone of the memory repo | hearthkit (git) |
| `~/.hearth/logs/` | hook, sync, and MCP logs, rotated | hearthkit |
| `~/.claude/settings.json` | Claude Code's record of the marketplace and enabled plugin | Claude Code |
| `~/.claude/projects/<slug>/*.jsonl` | session transcripts; read, never written, by handoff capture | Claude Code |

`hearth where` prints this with live values and the current directory's project slug.

### 4.3 The plugin is the tool

Hooks and the MCP server invoke code inside the plugin directory via `${CLAUDE_PLUGIN_ROOT}`:

```
hooks/hooks.json     SessionStart → node ${CLAUDE_PLUGIN_ROOT}/dist/hearth.js memory context
                     SessionEnd   → node ${CLAUDE_PLUGIN_ROOT}/dist/hearth.js handoff capture
.mcp.json            hearth → node ${CLAUDE_PLUGIN_ROOT}/dist/mcp.js
commands/setup.md    /hearth:setup — instructs the agent to run `hearth doctor --json` and guide the user
commands/sync.md     /hearth:sync
commands/handoff.md  /hearth:handoff — asks the agent to write a handoff now
skills/memory-use/   when and how to write facts and handoffs (loaded on demand)
dist/                esbuild bundles, committed on release tags; no npm install at install time
```

For terminal use, `hearth` is also published to npm (`npm i -g hearthkit`) from the same source. Both entry points are the same code; the npm install is optional.

### 4.4 Source layout

```
src/
  core/
    store.ts      MemoryStore interface: list/read/write/delete facts and handoffs by layer.
                  v1 ships one implementation, FileStore over ~/.hearth/memory. A hosted
                  store in v2 implements the same interface; nothing above it changes.
    config.ts     ~/.hearth/config.json
    project.ts    project slug from git remote (owner/repo) or directory basename
    memory.ts     fact files, MEMORY.md regeneration, session context builder, promote
    handoff.ts    write; capture from transcript; select latest; prune
    search.ts     keyword search across layers and handoffs
    sync.ts       git pull --rebase / push with memory-specific conflict handling
    doctor.ts     baseline checks with plain-language fixes; --json for the setup command
    where.ts      §4.2 with live values
    git.ts        interface + real impl for `git` and `gh`
    transcript.ts parse Claude Code .jsonl, extract user/assistant text turns
  cli/            commander commands; thin
  mcp/            MCP stdio server; thin
test/             vitest; fakes for git.ts; local bare repos as remotes; fixture transcripts
```

`cli/` and `mcp/` contain no business logic. `memory.ts`, `handoff.ts`, and `search.ts` depend only on the `MemoryStore` interface, never on the filesystem directly; `sync.ts` is the one module that knows the store is a git clone.

### 4.5 Data flow

- **Install:** `claude plugin marketplace add <corey>/hearthkit` → `claude plugin install hearthkit@hearthkit`. The user types `/hearth:setup`. The agent runs `hearth doctor --json`, explains what is missing, and, with the user's confirmation, runs `hearth init` (creates a private GitHub repo via `gh` if available, or connects a pasted remote URL), then commits an initial `global/` fact about the user from a short conversation.
- **Session starts:** SessionStart hook → `hearth memory context` → prints latest project handoff, `global/MEMORY.md`, `projects/<slug>/MEMORY.md`, pinned facts, and a two-line reminder of the tools → Claude Code injects it.
- **During the session:** MCP tools `memory_search`, `memory_read`, `memory_write`, `memory_list`, `memory_handoff`.
- **Session ends:** SessionEnd hook → `hearth handoff capture` (hook JSON on stdin, includes `transcript_path`, `session_id`, `cwd`) → if no agent-written handoff exists for this session, store an automatic one from the transcript tail.
- **Sync:** `hearth sync` or `/hearth:sync`. Also run automatically, best-effort and non-blocking, at the end of `handoff capture`, so a closed laptop has usually pushed before you open the other one. Failures are logged, never surfaced into the session.

## 5. Memory model

### 5.1 Layers

- `global/` — facts about the user and their environment.
- `projects/<slug>/` — facts about one codebase, plus `handoffs/`.

Slug: `owner-repo` from the git remote when present (same on every machine), else the directory basename. Shown by `hearth where`.

### 5.2 Fact file

Same shape as Claude Code auto-memory, so files copy between the two systems:

```markdown
---
name: short-kebab-slug
description: one-line summary used for search and the index
metadata:
  type: user | feedback | project | reference
  created: 2026-09-06
  device: coreys-macbook
  pinned: false
---

The fact. May link related facts with [[slug]].
```

Each layer has a generated `MEMORY.md` index, one line per fact, regenerated deterministically after every write and sync. It is committed but never hand-edited, so any index conflict is resolved by regenerating.

### 5.3 Handoffs

`projects/<slug>/handoffs/<YYYY-MM-DD-HHMM>-<device>.md`:

```markdown
---
device: coreys-macbook
source: agent | auto
session: <claude session id>
branch: main
---

## Working on
## Decisions
## Open threads
## Next steps
## Files touched
```

- **Agent-written** via `memory_handoff` or `/hearth:handoff`. The memory-use skill asks the agent to do this before finishing a task or when the user says they are stopping.
- **Automatic** from the transcript: last 30 user and assistant text turns, tool calls and tool results excluded, capped at 1,500 tokens, placed under `## Working on`. Only when no agent-written handoff exists for the session.

Session start loads the latest handoff in full, preferring agent-written over automatic from the same session. Handoffs older than 30 days, except the newest per project, are pruned during sync. Time-and-device filenames mean two machines never conflict on a handoff.

### 5.4 Session context

Order: handoff, global index, project index, pinned fact bodies, tool reminder. Cap defaults to 4,000 tokens, configurable. The handoff is never truncated; when the rest exceeds the cap, the oldest unpinned project-layer lines are dropped first and the output says so.

### 5.5 Search

Word and substring match across `name`, `description`, body, and handoff text, ranked by matching terms then recency, across `global/` and the current project layer.

## 6. Sync and conflicts

1. `git fetch`; `git pull --rebase`.
2. On conflict, per file: fact files keep both versions, the remote keeps the name and the local becomes `<name>.conflict-<device>.md`; index files are regenerated; the rebase continues.
3. `git push`.
4. Prune old handoffs; commit if anything changed.

Conflicted facts appear in `hearth list` and `hearth doctor` until one copy is deleted. The common cross-device case, both machines adding facts, never conflicts because files are unique.

## 7. CLI

| Command | Behaviour |
|---|---|
| `hearth init [--remote <url>]` | Creates config and the memory clone. With `gh` and no `--remote`, creates a private GitHub repo. Idempotent. Refuses a public remote unless `--allow-public`. |
| `hearth doctor [--json]` | Baseline checks (§3) plus repo health and conflicts. Every failure prints the fix. `--json` is for `/hearth:setup`. |
| `hearth where` | §4.2 with live values and the project slug. |
| `hearth sync` | §6. |
| `hearth list` | Layers, fact counts, handoff counts, conflicts. |
| `hearth memory add <layer> "<text>" [--name] [--type] [--pin]` | `<layer>` is `global` or `project[:<slug>]`. |
| `hearth memory search <query>` | §5.5. |
| `hearth memory show <layer> <name>` | One fact. |
| `hearth memory promote <name> [--from project[:<slug>]]` | Moves a fact from a project layer to `global`, keeping its history in git. Regenerates both indexes. |
| `hearth memory context` | Session-start block for the current directory. Used by the hook. |
| `hearth handoff write` | Interactive five-section handoff. |
| `hearth handoff capture` | Reads hook JSON from stdin; §5.3 automatic path; then best-effort sync. Used by the hook. |
| `hearth handoff list [project]` | Newest first. |
| `hearth mcp` | Stdio MCP server. Used by `.mcp.json`. |

Exit codes: 0 ok, 1 user error, 2 environment error. Hook commands never block Claude Code: they log to `~/.hearth/logs/` and exit 0.

## 8. MCP tools

`memory_search(query)`, `memory_list(layer)`, `memory_read(layer, name)`, `memory_write(layer, name?, type, text, pinned?)`, `memory_handoff(working_on, decisions?, open_threads?, next_steps?, files_touched?)`, `memory_promote(name)`. Descriptions say when a fact belongs in `global` versus `project` (rule of thumb: if it would be true in a different repo, it is global), when to promote, and when to write a handoff. The memory-use skill repeats the rule so facts do not get stranded in a project. Any MCP-capable tool can use the server, which is how Codex reaches the same memory before v1.1.

## 9. Sharing and teams

- **Installing hearthkit:** two commands from the public marketplace, then `/hearth:setup`. A team can add the marketplace and plugin to a project's `.claude/settings.json` so Claude Code installs it for everyone who opens that repo.
- **Memory is per person.** Each teammate creates their own private memory repo during setup. Nothing personal is shared.
- **Team agents** are a separate, ordinary Claude Code marketplace in a private repo. Teammates need read access and git credentials. hearthkit's docs include a template and explain that any agent installed alongside hearthkit gets memory and handoffs automatically, because the hooks are hearthkit's, not the agent's.
- **Shared team memory** is not in v1. It is the natural paid feature (§14).

## 10. Stack, build, release

- TypeScript, ESM, Node 20+ at runtime. Deps: `commander`, `@modelcontextprotocol/sdk`, `gray-matter`, `zod`. Dev: `vitest`, `esbuild`, `typescript`, `tsx`, `@types/node`.
- `git` and `gh` via subprocess behind `git.ts`. No git library.
- `npm run build` bundles `dist/hearth.js` and `dist/mcp.js` with esbuild. `dist/` is committed only on release tags; `marketplace.json` pins the plugin `ref` to the latest tag so installs are reproducible. The same build publishes to npm.

## 11. Testing

- **Core:** vitest against temp dirs. Sync uses a local bare repo as the remote and two clones as devices; covers add/add, edit/edit conflict, index regeneration, prune.
- **Handoffs:** fixture `.jsonl` transcripts: normal session, agent-written already present, tool-heavy turns excluded, over-long tail capped, missing transcript file. Slug derivation with and without a remote. Latest-selection preference.
- **Context:** snapshot tests for ordering, cap behaviour, and the never-truncate-handoff rule.
- **Doctor:** each check in pass and fail states with the fake `git.ts`; the fix text is snapshot-tested because users read it. `--json` shape is asserted.
- **CLI:** spawn the built bundle with `HOME` in a temp dir; assert stdout, exit codes, files. Hook commands are asserted to exit 0 on every failure path.
- **MCP:** handlers called directly; one smoke test spawns `dist/mcp.js` and performs `tools/list`.
- **Plugin manifest:** a test validates `plugin.json`, `hooks.json`, `.mcp.json`, and `marketplace.json` against their schemas and that every referenced file exists in `dist/`.

Every feature is built test-first.

## 12. Acceptance protocol (how Corey tests it by hand)

Automated tests prove the code; this protocol proves the experience. Each scenario is a checklist in `docs/ACCEPTANCE.md`, run before every release tag. "Machine B" can be a second clone of the memory repo under a different `HOME` on the same Mac; the protocol shows how.

| # | Scenario | Pass when |
|---|---|---|
| A1 | Fresh install: two `claude plugin` commands, then `/hearth:setup` | Setup finds what is missing, explains it plainly, creates a private repo, and writes a first global fact from a short conversation. `hearth doctor` is all green. |
| A2 | Memory in session | Ask Claude to remember a preference. A fact file appears in `global/`. In a new session in a different folder, Claude already knows it without being asked. |
| A3 | Project memory | In repo X, ask Claude to remember a fact about X. In repo Y it is not in context. Back in X it is. |
| A4 | Agent-written handoff | Work on something, say "I'm stopping." A `source: agent` handoff appears. Open a new session in X: the first thing in context is that handoff. |
| A5 | Automatic handoff | Work, then quit Claude Code without saying anything. A `source: auto` handoff appears containing only conversation text, no tool output. |
| A6 | Two machines | Add a fact on A, `hearth sync`. On B, `hearth sync`, start a session: the fact is there. Repeat in reverse. Edit the same fact on both: after sync, both copies exist and `hearth doctor` names the conflict. |
| A7 | Promote | A fact written to a project turns out to be general. `hearth memory promote <name>` moves it; it now loads in every repo. |
| A8 | Offline and failures | Disconnect from the network, end a session: the handoff is still saved locally, no error appears in Claude Code, `hearth doctor` says sync is pending. Reconnect, sync, done. |
| A9 | Where is everything | `hearth where` lists every path with a live value; open each one in Finder and confirm it matches. |
| A10 | Another tool | Point Codex (or any MCP client) at `dist/mcp.js`. `memory_search` returns the same facts Claude Code sees. |

Every scenario states the exact commands to type and what to look for, written for someone doing it the first time. When a scenario fails, it becomes a bug with the scenario number in the title.

## 13. Security

- Memory repo must be private; `hearth init` checks and refuses otherwise unless overridden.
- No credentials stored. Git auth comes from the user's git or `gh` setup.
- Automatic handoffs store user and assistant text only, never tool output, so file contents and command results do not leak into the repo. Any handoff can be deleted with `hearth handoff delete` or in the repo.
- Fact names and slugs reject path separators.
- Hook output is capped (§5.4).
- Logs contain no transcript text.

## 14. Phasing and the revenue question

**v1 (this spec):** the plugin, two layers, handoffs, promote, hooks, MCP, setup command, CLI, automated tests, the acceptance protocol, and docs: README for users, `docs/ACCEPTANCE.md`, and a team-agents template.

**v1.1:** per-agent memory layer with `hearth new` scaffolding an agent plugin that declares its name to hearthkit; activity records (per-session history of what was done, from the same transcript capture that feeds handoffs); Codex CLI config generation; optional semantic search via a local embedding model; `hearth memory tidy`.

**v1.2:** prompt library (`prompts/` in a marketplace repo, `/hearth:prompt`).

**v2:** hosted store implementing `MemoryStore`; remote MCP server with per-user login so Claude.ai and ChatGPT on the web reach the same memory; web dashboard with guided setup for people who will not use a terminal; team memory layer.

**Revenue path, decided later, not now.** The plugin stays free and open source; that is what earns adoption and is the honest comparison point against claude-mem and mem0, both of which run this model. The candidate paid product is a hosted "Hearth Hub": shared team memory, a web dashboard, and setup with no GitHub account, aimed at mixed technical and non-technical teams. The decision gate is real usage by Corey's own team on v1. Nothing in v1's design blocks that path: a hub is just another remote for the same files.

## 15. Decisions resolved

- **Scope:** continuity only. Packaging, model profiles, and dashboards are commodity or premature; research on 2026-09-06 confirmed continuity across machines is the uncovered gap.
- **Distribution:** the plugin carries its own CLI; no separate install step. Public one-plugin marketplace in the same repo.
- **Layers in v1:** global and project. Per-agent waits for agent scaffolding in v1.1 so the agent's identity is unambiguous.
- **Setup UX:** conversational, inside Claude Code, via a slash command backed by `hearth doctor --json`.
- **Storage:** git-backed markdown, one fact per file, Claude Code compatible frontmatter.
- **Sync trigger:** manual plus best-effort after session end.
- **Language:** TypeScript on Node 20+, esbuild bundles committed on release tags.
- **Store boundary:** a `MemoryStore` interface from day one, with a single file-based implementation, so the v2 hosted store reuses every line above it.
- **Stranded facts:** solved by `promote` plus explicit guidance on the global-versus-project rule.
