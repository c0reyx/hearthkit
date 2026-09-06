# hearthkit — Design Spec

**Date:** 2026-09-06
**Status:** Draft for review
**Working name:** `hearthkit` (npm package), CLI binary `hearth`. Free on npm as of this date. Renaming is a find-and-replace.

## 1. Problem

Corey rebuilds the same agent setups repeatedly: Claude Code skills, custom agents, MCP server configs, permission settings, and the facts an agent has learned. These live per machine and, for memory, per project directory. Switching machines or starting a new project means starting over.

Claude Code already solves half of this. Its plugin system packages skills, agents, hooks, and MCP config into a folder, and a marketplace is a GitHub repo that lists plugins. What it does not do:

1. Sync memory across machines and projects. Auto-memory is stored per project path under `~/.claude/projects/<slug>/memory/`.
2. Bootstrap a fresh machine or VPS in one step.
3. Give a visual overview of what is installed and what the agents know.
4. Offer a local API that other tools can build on.

hearthkit builds only those four things.

## 2. Goals and non-goals

**Goals (v1)**

- Define an agent once as a Claude Code plugin in a private GitHub marketplace repo; install it on any machine with one command.
- Two-layer memory (global + per-agent) that syncs through a private GitHub repo and is reachable from any Claude Code session via MCP.
- One command bootstraps a new machine or VPS: config, both repos, marketplace registration, MCP registration.
- A local HTTP API and a dashboard on top of it for browsing agents and memory and triggering sync.
- Designed so a team can later share an agents marketplace while each person keeps private memory.
- Test-driven; the suite runs without network access.

**Non-goals (v1, explicitly later)**

- Running agents unattended on a VPS. v1 only guarantees `hearth init` works on a Linux box that has `node`, `git`, `gh`, and `claude` installed.
- Exporting agent definitions to the OpenAI API, custom GPTs, or Claude Projects.
- A hosted sync service or database. Git is the sync mechanism.
- OAuth to consumer AI subscriptions. Those flows are reserved for the vendors' own clients; hearthkit sits above Claude Code, which handles its own login.

## 3. Architecture

Three repositories owned by the user:

| Repo | Visibility | Contents |
|---|---|---|
| `hearthkit` | public or private | The tool: core library, CLI, API, MCP server, dashboard. Published to npm. |
| `<user>/hearth-agents` | private (shareable later) | A Claude Code marketplace: `.claude-plugin/marketplace.json` plus `plugins/<agent>/`, one plugin per agent. |
| `<user>/hearth-memory` | private, never shared | `global/` and `agents/<agent>/` fact files. |

Memory and agents are separate repos from day one because memory is personal and agents may become shared. A team later adds a second marketplace repo; hearthkit supports any number of marketplaces and exactly one memory repo per user.

### 3.1 Components inside the `hearthkit` package

```
src/
  core/        pure library; all real work happens here
    config.ts    read/write ~/.hearth/config.json
    agents.ts    scaffold plugin folders, update marketplace.json, install via claude CLI
    memory.ts    read/write/search fact files, regenerate MEMORY.md indexes
    sync.ts      git pull/push for both repos, conflict handling
    claude.ts    interface + real impl for invoking the `claude` CLI
    git.ts       interface + real impl for invoking `git` and `gh`
  cli/         commander commands; thin wrappers over core
  api/         Hono HTTP server; JSON routes over core; serves dashboard/
  mcp/         MCP stdio server exposing memory + agent tools over core
dashboard/     static HTML/CSS/JS, no build step, talks to api/
test/          vitest; fakes for claude.ts and git.ts; local bare repos stand in for GitHub
```

Rule: `cli/`, `api/`, and `mcp/` contain no business logic. If two faces need the same behaviour, it lives in `core/`.

### 3.2 Data flow

- **Install an agent:** CLI/API → `core/agents.install(name)` → `claude plugin install <name>@<marketplace>` → `core/memory.ensureLayer(name)` creates `agents/<name>/` in the memory repo.
- **Agent reads memory:** Claude Code session → MCP tool `memory_search` → `core/memory.search()` → reads fact files from the local clone.
- **Agent writes memory:** MCP tool `memory_write` → `core/memory.write()` → new fact file → regenerates that layer's `MEMORY.md`. Not pushed until `hearth sync` (or the dashboard sync button, or auto-sync in a later version).
- **Sync:** `core/sync.run()` → for each repo: `git pull --rebase`, resolve, `git push`. See §5.

## 4. Memory model

### 4.1 Layers

- `global/` — facts about the user and their environment that every agent should know.
- `agents/<agent-name>/` — facts a specific agent has learned.

An agent's effective memory is `global/` plus its own layer. Agents do not read other agents' layers.

### 4.2 Fact file format

Identical to Claude Code auto-memory so files can be moved between the two systems by copying:

```markdown
---
name: short-kebab-slug
description: one-line summary used during search and recall
metadata:
  type: user | feedback | project | reference
  created: 2026-09-06
  device: coreys-macbook
---

Body: the fact. May link related facts with [[slug]].
```

Filename is `<name>.md`. `created` and `device` are set by the tool. Each layer has a generated `MEMORY.md` index (one line per fact) that the tool regenerates deterministically after every write and after every sync; it is committed but never hand-edited, so index conflicts are resolved by regenerating.

### 4.3 How agents get memory into context

1. `hearth init` registers the hearthkit MCP server with Claude Code at user scope, so every session has `memory_search`, `memory_read`, `memory_write`, `memory_list`, and `agent_list` tools.
2. `hearth new` puts a short standard block in the agent plugin's instructions: at session start, call `memory_search` for the current task and `memory_list` for the global layer; write durable facts with `memory_write` under the agent's own layer unless they are about the user, in which case use `global`.

Symlinking Claude Code's per-project memory directory into hearth layers is deliberately not in v1. MCP tools cover the need without touching Claude Code internals.

### 4.4 Search

v1 search is substring and word match across `name`, `description`, and body, ranked by number of matching terms and recency. No embeddings. The corpus is small, human-written text and this keeps the tool dependency-free and understandable. Search runs across `global/` plus the requested agent layer.

## 5. Sync and conflict handling

`hearth sync` runs for the agents repo, then the memory repo:

1. `git fetch`, then `git pull --rebase`.
2. If the rebase stops on a conflict:
   - **Agents repo:** abort the rebase, leave the working tree clean, and report the conflicting files. Agent definitions are code and deserve a human merge.
   - **Memory repo:** for each conflicting fact file, keep both versions: the remote one keeps the original name, the local one is renamed `<name>.conflict-<device>.md`. Continue the rebase. Regenerate `MEMORY.md`. Conflicted facts are flagged in `hearth list`, in the API, and in the dashboard until the user deletes one.
   - Any conflict in a `MEMORY.md` index is resolved by regeneration.
3. `git push`.

Because facts are one per file and new facts get unique names, the common cross-device case (both devices add facts) never conflicts.

## 6. CLI

| Command | Behaviour |
|---|---|
| `hearth init [--agents <repo>] [--memory <repo>]` | Creates `~/.hearth/config.json`. Clones the given repos with `gh repo clone`, or creates them with `gh repo create --private` when omitted. Writes an initial `marketplace.json` for a new agents repo. Runs `claude plugin marketplace add <path>` and registers the MCP server (`claude mcp add --scope user hearth -- hearth mcp`). Idempotent: safe to re-run. |
| `hearth new <agent>` | Scaffolds `plugins/<agent>/` with `.claude-plugin/plugin.json`, an instructions file containing the memory block, empty `skills/`, `agents/`, and `.mcp.json`. Adds the entry to `marketplace.json`. Commits with a standard message. |
| `hearth install <agent>` | `claude plugin install <agent>@<marketplace>`; ensures `agents/<agent>/` exists in the memory repo. |
| `hearth list` | Agents from all configured marketplaces, install status, fact counts, conflict flags. |
| `hearth sync` | §5. |
| `hearth memory add <layer> "<fact>" [--name] [--type]` | Writes a fact file; generates a slug from the text if `--name` is omitted. |
| `hearth memory search <query> [--agent <name>]` | §4.4. |
| `hearth memory show <layer> <name>` | Prints one fact. |
| `hearth serve [--port 7310] [--host 127.0.0.1]` | Starts the API and dashboard. |
| `hearth mcp` | Runs the MCP stdio server. Invoked by Claude Code, not by hand. |

Exit codes: 0 success, 1 user error (message, no stack), 2 environment error (missing `git`, `gh`, `claude`, not logged in). Errors name the fix, e.g. "gh is not authenticated. Run: gh auth login".

## 7. HTTP API

Hono server, JSON only, default `127.0.0.1:7310`. Binding to any other host requires `HEARTH_TOKEN` to be set and sent as `Authorization: Bearer <token>`; without the token the server refuses to start on a non-loopback host.

| Method + path | Purpose |
|---|---|
| `GET /api/agents` | list with install status and fact counts |
| `POST /api/agents` | `{name}` → scaffold (same as `hearth new`) |
| `POST /api/agents/:name/install` | install |
| `GET /api/memory/:layer` | list facts in a layer (`global` or `agents/<name>`) |
| `GET /api/memory/:layer/:name` | one fact |
| `PUT /api/memory/:layer/:name` | create or update a fact |
| `DELETE /api/memory/:layer/:name` | remove a fact (used to clear conflicts) |
| `GET /api/search?q=&agent=` | search |
| `POST /api/sync` | run sync; returns per-repo result and conflicts |
| `GET /api/status` | config, repo paths, last sync, pending changes |
| `GET /` and static | dashboard |

Errors are `{error: string}` with 400 for bad input, 404 for unknown layer/fact, 409 for sync conflicts that need attention, 500 otherwise.

## 8. MCP server

Stdio transport via the official `@modelcontextprotocol/sdk`. Tools:

- `memory_search(query, agent?)`
- `memory_list(layer)`
- `memory_read(layer, name)`
- `memory_write(layer, name?, type, text)`
- `agent_list()`

Each tool is a direct call into `core/`. Tool descriptions tell the model when to use `global` versus an agent layer.

## 9. Dashboard

Static files served by the API. Vanilla HTML, CSS, and JavaScript using `fetch`; no bundler, so every file is readable and editable directly. Three views:

1. **Agents** — cards per agent: description, installed or not, skills, MCP servers, fact count; buttons for install and open-in-GitHub.
2. **Memory** — layer picker, search box, fact list, click to read and edit inline, conflict badge with side-by-side resolve.
3. **Sync** — status of both repos, pending local changes, a Sync button, last result.

Visual design follows the `ux-foundations` and `frontend-design` skills when built. Light and dark themes via `prefers-color-scheme`.

## 10. Stack and dependencies

- Node 25, TypeScript, ESM. `tsx` for dev, `tsc` for build.
- Runtime deps: `commander`, `hono`, `@hono/node-server`, `@modelcontextprotocol/sdk`, `gray-matter`, `zod` (input validation shared by CLI, API, MCP).
- Dev deps: `vitest`, `typescript`, `tsx`, `@types/node`.
- `git`, `gh`, and `claude` are invoked as subprocesses through the `git.ts` and `claude.ts` interfaces. No git library.

## 11. Testing

- **Core:** vitest against temp directories. Sync tests use a local bare repo as the "remote" and two working clones as "devices", so cross-device conflict cases are exercised without network. `claude.ts` is replaced with a fake that records calls.
- **CLI:** spawn the built binary with `HOME` pointed at a temp dir; assert stdout, exit codes, and resulting files.
- **API:** start the Hono app in-process; call routes with `fetch`; assert JSON and status codes, including the token requirement on non-loopback hosts.
- **MCP:** call the tool handlers directly (they are thin over core); one smoke test spawns `hearth mcp` and performs a `tools/list` handshake.
- **Dashboard:** manual verification in v1, plus a test that every route the dashboard calls exists in the API.

Every feature is built test-first.

## 12. Security

- API is loopback-only unless a token is configured.
- No credentials are stored; git and GitHub auth come from `gh`, model auth from `claude`.
- Memory repo is created private. `hearth init` refuses to proceed if the memory repo it is told to use is public, with an override flag.
- Fact writes reject path separators in names.

## 13. Phasing

**v1 (this spec):** core, CLI, MCP, API, dashboard, tests.
**v1.1:** auto-sync on a timer or on write; `hearth doctor` for environment checks.
**v2:** team marketplaces with a shared team memory layer that is opt-in per agent; exporters for other runtimes; VPS agent runner using Claude Code headless mode.

## 14. Open decisions resolved

- **Own bundle format vs. Claude Code plugins:** plugins. Less code, native install, and team sharing already works.
- **Memory storage:** git-backed markdown, one fact per file. Human-readable, merge-friendly, no server.
- **Language:** Node + TypeScript, matching the Claude Code ecosystem and the installed toolchain.
- **Dashboard build tooling:** none. Readability wins for a learning project.
