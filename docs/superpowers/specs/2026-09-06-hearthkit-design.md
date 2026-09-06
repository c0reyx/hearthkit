# hearthkit — Design Spec

**Date:** 2026-09-06 (revision 3)
**Status:** Draft for review
**Working name:** `hearthkit` (npm package), CLI binary `hearth`. Free on npm as of this date. Renaming is a find-and-replace.

## 1. Problem

Corey and his team rebuild the same agent setups repeatedly: Claude Code skills, custom agents, MCP server configs, permission settings, and the facts an agent has learned. These live per machine and, for memory, per project directory. Switching machines or starting a new project means starting over. Leaving a Claude Code session and coming back later means re-explaining what you were working on. Running the same agent on a local model instead of Claude means starting over again. And the team spans technical and non-technical people, so anything that only works from the terminal excludes half of them.

Claude Code already solves part of this. Its plugin system packages skills, agents, hooks, and MCP config into a folder, and a marketplace is a GitHub repo that lists plugins. What it does not do:

1. Sync memory across machines and projects. Auto-memory is stored per project path under `~/.claude/projects/<slug>/memory/`.
2. Carry "what we were working on" from one session to the next across machines or tools.
3. Bootstrap a fresh machine or VPS in one step, with guidance a non-technical teammate can follow.
4. Make switching an agent between Claude and a local model a one-flag operation.
5. Give a visual overview of what is installed, what the agents know, and where it all lives on disk.
6. Offer a local API that other tools can build on.

hearthkit builds only those six things.

## 2. Goals and non-goals

**Goals (v1)**

- Define an agent once as a Claude Code plugin in a private GitHub marketplace repo; install it on any machine with one command.
- Three-layer memory (global, per-agent, per-project) that syncs through a private GitHub repo, loads automatically at the start of every agent session, and is searchable and writable via MCP.
- Project handoffs: when a session ends, what was being worked on is captured, and the next session in that project starts with it, on any machine.
- Model profiles: run any agent against Claude or a local model server (Ollama or any Anthropic-compatible endpoint) with one flag. Local embeddings, when available, improve memory search.
- Setup a non-technical teammate can complete: one line to paste, then a browser page that checks the machine and says what to do next in plain language.
- Every file hearthkit reads or writes has a documented, discoverable location. `hearth where` prints the map.
- A local HTTP API and a dashboard on top of it for setup, browsing agents and memory, checking model profiles, and triggering sync.
- Designed so a team can share an agents marketplace while each person keeps private memory.
- Test-driven; the suite runs without network access and without a real model server.

**Non-goals (v1, explicitly later)**

- Codex CLI and other runtimes as first-class targets (v1.1, §14). The MCP server already works from any MCP-capable tool; what is deferred is generated config and testing for those tools.
- Running agents unattended on a VPS. v1 only guarantees setup works on a Linux box that has `node`, `git`, `gh`, and `claude` installed.
- Exporting agent definitions to the OpenAI API, custom GPTs, or Claude Projects.
- A prompt library (§14).
- A hosted sync service or database. Git is the sync mechanism.
- Building an agent runtime. hearthkit launches Claude Code; it never calls a model API itself except for embeddings and, later, memory tidying.
- Installing Node or Claude Code for the user. The installer detects them and gives the exact command or link when they are missing.
- OAuth to consumer AI subscriptions. Those flows are reserved for the vendors' own clients; hearthkit sits above Claude Code, which handles its own login.

## 3. Architecture

Three repositories owned by the user:

| Repo | Visibility | Contents |
|---|---|---|
| `hearthkit` | public or private | The tool: core library, CLI, API, MCP server, dashboard, `install.sh`. Published to npm. |
| `<user>/hearth-agents` | private (shareable with the team) | A Claude Code marketplace: `.claude-plugin/marketplace.json` plus `plugins/<agent>/`, one plugin per agent. A reserved `prompts/` folder for the later prompt library. |
| `<user>/hearth-memory` | private, never shared | `global/`, `agents/<agent>/`, and `projects/<project>/` fact and handoff files. |

Memory and agents are separate repos from day one because memory is personal and agents are shared. Each teammate has their own memory repo; the team shares one or more marketplace repos. hearthkit supports any number of marketplaces and exactly one memory repo per user.

### 3.1 Where everything lives

| Path | What | Owned by |
|---|---|---|
| `~/.hearth/config.json` | repo locations, model profiles, API port | hearthkit |
| `~/.hearth/agents/` | local clone of the agents marketplace repo | hearthkit (git) |
| `~/.hearth/memory/` | local clone of the memory repo | hearthkit (git) |
| `~/.hearth/cache/embeddings/` | per-machine embedding cache, derived data, never synced | hearthkit |
| `~/.hearth/logs/` | API, sync, and hook logs, rotated | hearthkit |
| `<npm global prefix>/bin/hearth` | the CLI itself, installed by npm | npm |
| `~/.claude/plugins/` | where Claude Code installs plugins from the marketplace | Claude Code |
| `~/.claude/settings.json` | where Claude Code records the marketplace and MCP server registration | Claude Code |
| `~/.claude/projects/<slug>/*.jsonl` | session transcripts; read (never written) by the handoff hook | Claude Code |
| `~/.ollama/models/` | local model weights, when Ollama is used | Ollama |

`hearth where` prints this table with live values (paths resolved, sizes, whether each exists). The dashboard's Status view shows the same. No other locations are used.

### 3.2 Components inside the `hearthkit` package

```
src/
  core/        pure library; all real work happens here
    config.ts    read/write ~/.hearth/config.json, incl. model profiles
    agents.ts    scaffold plugin folders, update marketplace.json, install via claude CLI
    memory.ts    read/write fact files, regenerate MEMORY.md indexes, build session context
    handoff.ts   write handoffs; capture from a transcript; pick the latest for a project
    project.ts   derive the project slug for a working directory
    search.ts    keyword search; semantic re-ranking when an embedding profile is available
    sync.ts      git pull/push for both repos, conflict handling
    profiles.ts  model profiles; launch env for `hearth run`; endpoint health checks
    setup.ts     the setup checklist: each check, its status, and its plain-language next step
    where.ts     the location map from §3.1
    claude.ts    interface + real impl for invoking the `claude` CLI
    git.ts       interface + real impl for invoking `git` and `gh`
    ollama.ts    interface + real impl for the Ollama HTTP API (tags, embed)
  cli/         commander commands; thin wrappers over core
  api/         Hono HTTP server; JSON routes over core; serves dashboard/
  mcp/         MCP stdio server exposing memory + agent tools over core
dashboard/     static HTML/CSS/JS, no build step, talks to api/
install.sh     one-line installer (§11)
test/          vitest; fakes for claude.ts, git.ts, ollama.ts; local bare repos stand in for GitHub
```

Rule: `cli/`, `api/`, and `mcp/` contain no business logic. If two faces need the same behaviour, it lives in `core/`.

### 3.3 Data flow

- **First run:** `install.sh` → `npm i -g hearthkit` → `hearth setup` → starts the API and opens the dashboard Setup view → the user works down the checklist → the final step runs the same actions as `hearth init`.
- **Install an agent:** CLI/API → `core/agents.install(name)` → `claude plugin install <name>@<marketplace>` → `core/memory.ensureLayer(name)` creates `agents/<name>/` in the memory repo.
- **Session starts:** the agent plugin's SessionStart hook runs `hearth memory context --agent <name>` → `core/memory.buildContext(cwd)` → prints the global index, the agent's index, pinned facts, and the latest handoff for this project → Claude Code adds the output to the session's context. The agent starts knowing who you are, what it has learned, and what you were doing.
- **Agent needs detail:** MCP tool `memory_search` → `core/search` → returns matching facts.
- **Agent learns something:** MCP tool `memory_write` → `core/memory.write()` → new fact file → regenerates that layer's `MEMORY.md`.
- **Agent wraps up:** MCP tool `memory_handoff` → `core/handoff.write()` → a handoff file in `projects/<project>/handoffs/`.
- **Session ends:** the plugin's SessionEnd hook runs `hearth handoff capture` with the hook's JSON on stdin → `core/handoff.capture(transcriptPath)` → if the agent did not already write a handoff in this session, store an automatic one built from the transcript tail.
- **Run on a local model:** `hearth run <agent> --profile local-gemma` → `core/profiles.launchEnv()` → spawns `claude` with `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_MODEL` set for that profile, plus `--append-system-prompt` carrying the same context as the hook.
- **Sync:** `core/sync.run()` → for each repo: `git pull --rebase`, resolve, `git push`. See §5.

## 4. Memory model

### 4.1 Layers

- `global/` — facts about the user and their environment that every agent should know.
- `agents/<agent-name>/` — facts a specific agent has learned.
- `projects/<project-slug>/` — facts about one codebase or piece of work, plus its handoffs.

An agent's effective memory in a given directory is `global/` plus its own layer plus the project layer for that directory. Agents do not read other agents' layers.

**Project slug.** Derived by `core/project.ts` from the working directory: the git remote's `owner/repo` when there is one (so the same project has the same slug on every machine), otherwise the directory basename. The slug is shown in `hearth where` and in the dashboard so it is never a mystery.

### 4.2 Fact file format

Identical to Claude Code auto-memory so files can be moved between the two systems by copying, with two optional additions:

```markdown
---
name: short-kebab-slug
description: one-line summary used during search and recall
metadata:
  type: user | feedback | project | reference
  created: 2026-09-06
  device: coreys-macbook
  pinned: false
---

Body: the fact. May link related facts with [[slug]].
```

Filename is `<name>.md`. `created` and `device` are set by the tool. `pinned: true` means the full body, not just the index line, is included in session context. Each layer has a generated `MEMORY.md` index (one line per fact) that the tool regenerates deterministically after every write and after every sync; it is committed but never hand-edited, so index conflicts are resolved by regenerating.

### 4.3 How memory reaches the agent

Memory arrives automatically; the agent does not have to ask.

1. **Session-start hook.** `hearth new` gives every agent plugin a `hooks/hooks.json` with a `SessionStart` hook (matcher `startup|clear|compact`) that runs `hearth memory context --agent <name>`. The command prints, in order: the latest project handoff (§4.5), the global `MEMORY.md`, the agent's `MEMORY.md`, the project layer's `MEMORY.md`, the bodies of pinned facts, and a two-line reminder of the MCP tools. Claude Code injects the output into context. Output is capped (default 4,000 tokens, configurable); the handoff is never truncated; when the rest exceeds the cap the oldest unpinned agent-layer lines are dropped first and the output says so.
2. **`hearth run` belt-and-braces.** When launching via `hearth run`, the same context is also passed with `--append-system-prompt`, so it works where hooks are disabled or under a profile whose server behaves differently.
3. **MCP tools for depth and writing.** `hearth init` registers the hearthkit MCP server with Claude Code at user scope: `memory_search`, `memory_read`, `memory_write`, `memory_list`, `memory_handoff`, `agent_list`. The instructions block in each agent plugin says: write durable facts with `memory_write` under the agent's own layer unless they are about the user (`global`) or this codebase (`project`); before finishing a piece of work, call `memory_handoff`.

Symlinking Claude Code's per-project memory directory into hearth layers is deliberately not in v1.

### 4.4 Search

Two stages, always safe to run:

1. **Keyword** (always available): substring and word match across `name`, `description`, and body, ranked by number of matching terms and recency.
2. **Semantic re-rank** (when an embedding profile is configured and its server answers): embed the query, embed any fact whose file hash is not yet in `~/.hearth/cache/embeddings/`, and re-rank the union of keyword hits and top cosine matches. Cache is keyed by fact file hash so edits re-embed only the changed file.

If the embedding server is unreachable the search silently falls back to stage 1 and the API response carries `semantic: false`, so the dashboard can show it. The default embedding profile targets Ollama's `/api/embed` with `nomic-embed-text`; any profile may override model and endpoint. Search runs across `global/`, the requested agent layer, and the current project layer. Handoffs are searchable too.

### 4.5 Project handoffs

A handoff is a short note about the state of work in one project. Stored at `projects/<slug>/handoffs/<YYYY-MM-DD-HHMM>-<device>.md`:

```markdown
---
agent: hubspot-helper
device: coreys-macbook
source: agent | auto
branch: main
session: <claude session id, when known>
---

## Working on
## Decisions
## Open threads
## Next steps
## Files touched
```

Two writers:

- **Agent-written (`source: agent`).** The agent calls `memory_handoff` with the five sections filled in. The plugin instructions ask for this before finishing a task or when the user says they are stopping. This is the high-quality path.
- **Automatic (`source: auto`).** The plugin's `SessionEnd` hook runs `hearth handoff capture`. Claude Code passes the hook a JSON payload including `transcript_path` and `session_id`. If no agent-written handoff exists for this session, the command reads the transcript, keeps the last 30 user and assistant text turns (tool calls and tool output excluded), caps them at 1,500 tokens, and stores them under `## Working on` with the other sections empty. This is the safety net for closing the window without saying goodbye.

At session start the latest handoff for the project is loaded in full, preferring an agent-written one over an automatic one from the same session. `hearth memory handoffs [project]` lists them; the dashboard shows them under the project. Handoffs older than 30 days, except the most recent per project, are pruned during sync so the repo stays small. Because filenames carry time and device, two machines never conflict on a handoff.

## 5. Sync and conflict handling

`hearth sync` runs for the agents repo, then the memory repo:

1. `git fetch`, then `git pull --rebase`.
2. If the rebase stops on a conflict:
   - **Agents repo:** abort the rebase, leave the working tree clean, and report the conflicting files. Agent definitions are code and deserve a human merge.
   - **Memory repo:** for each conflicting fact file, keep both versions: the remote one keeps the original name, the local one is renamed `<name>.conflict-<device>.md`. Continue the rebase. Regenerate `MEMORY.md`. Conflicted facts are flagged in `hearth list`, in the API, and in the dashboard until the user deletes one.
   - Any conflict in a `MEMORY.md` index is resolved by regeneration.
3. `git push`.
4. Prune old handoffs (§4.5) and commit if anything was removed.

Because facts are one per file and new facts get unique names, the common cross-device case (both devices add facts) never conflicts. The embedding cache is outside the repo and never syncs.

## 6. Model profiles

A profile names a model server and how to reach it. Stored in `~/.hearth/config.json`:

```json
{
  "profiles": {
    "claude":      { "kind": "anthropic" },
    "local-gemma": { "kind": "anthropic-compatible", "baseUrl": "http://127.0.0.1:11434", "model": "gemma3", "authToken": "ollama" }
  },
  "defaultProfile": "claude",
  "embeddings": { "baseUrl": "http://127.0.0.1:11434", "model": "nomic-embed-text" }
}
```

- `kind: anthropic` launches `claude` with no overrides; it uses the user's normal login.
- `kind: anthropic-compatible` launches `claude` with `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, and `ANTHROPIC_MODEL` set. The server must speak the Anthropic Messages API. Ollama and LiteLLM both do; `hearth doctor` verifies by sending a minimal request rather than trusting the label.
- `hearth models` lists what the local server has (`GET /api/tags` on Ollama) and offers to create a profile for one.
- Profiles hold no secrets beyond a local token; cloud API keys are a non-goal.

## 7. CLI

| Command | Behaviour |
|---|---|
| `hearth setup` | Starts the API if needed and opens the dashboard Setup view in the browser. The friendly front door; everything it does is also available as `hearth init` and `hearth doctor`. |
| `hearth init [--agents <repo>] [--memory <repo>]` | Creates `~/.hearth/config.json`. Clones the given repos with `gh repo clone`, or creates them with `gh repo create --private` when omitted. Writes an initial `marketplace.json` for a new agents repo. Runs `claude plugin marketplace add <path>` and `claude mcp add --scope user hearth -- hearth mcp`. Idempotent. |
| `hearth doctor` | Checks `node`, `git`, `gh` auth, `claude` login, both repos clean and reachable, each profile's endpoint answering, embedding server answering. Each failed check prints the fix. Same checks the Setup view shows. |
| `hearth where` | Prints the §3.1 map with live values, including the current directory's project slug. |
| `hearth new <agent>` | Scaffolds `plugins/<agent>/` with `.claude-plugin/plugin.json`, an instructions file containing the memory and handoff block, `hooks/hooks.json` with SessionStart and SessionEnd hooks, empty `skills/`, `agents/`, and `.mcp.json`. Adds the entry to `marketplace.json`. Commits. |
| `hearth install <agent>` | `claude plugin install <agent>@<marketplace>`; ensures `agents/<agent>/` exists in the memory repo. |
| `hearth list` | Agents from all configured marketplaces, install status, fact counts, conflict flags. |
| `hearth run <agent> [--profile <name>] [-- <claude args>]` | Launches `claude` in the current directory with the profile's env and the memory context appended to the system prompt. Extra args pass through to `claude`. |
| `hearth models` | Lists local models and creates profiles. |
| `hearth sync` | §5. |
| `hearth memory add <layer> "<fact>" [--name] [--type] [--pin]` | Writes a fact file; generates a slug from the text if `--name` is omitted. `<layer>` is `global`, `agent:<name>`, or `project[:<slug>]` (defaults to the current directory's project). |
| `hearth memory search <query> [--agent <name>]` | §4.4. |
| `hearth memory show <layer> <name>` | Prints one fact. |
| `hearth memory context --agent <name>` | Prints the session-start context block for the current directory. Used by hooks. |
| `hearth memory handoffs [project]` | Lists handoffs, newest first. |
| `hearth handoff write` | Interactive prompts for the five sections; writes an agent-style handoff by hand. |
| `hearth handoff capture` | Reads the SessionEnd hook payload from stdin and stores an automatic handoff (§4.5). Used by hooks. |
| `hearth serve [--port 7310] [--host 127.0.0.1]` | Starts the API and dashboard. |
| `hearth mcp` | Runs the MCP stdio server. Invoked by Claude Code, not by hand. |

Exit codes: 0 success, 1 user error (message, no stack), 2 environment error (missing `git`, `gh`, `claude`, not logged in, profile endpoint down). Errors name the fix, e.g. "gh is not authenticated. Run: gh auth login". Hook commands (`memory context`, `handoff capture`) never exit non-zero in a way that blocks Claude Code; failures are logged to `~/.hearth/logs/` and the session proceeds.

## 8. HTTP API

Hono server, JSON only, default `127.0.0.1:7310`. Binding to any other host requires `HEARTH_TOKEN` to be set and sent as `Authorization: Bearer <token>`; without the token the server refuses to start on a non-loopback host.

| Method + path | Purpose |
|---|---|
| `GET /api/setup` | the setup checklist: each check with `status` (`ok`, `todo`, `optional`), a plain-language `next` step, and a copyable `command` when there is one |
| `POST /api/setup/:step` | run a step the tool can do itself (create repos, register marketplace and MCP) |
| `GET /api/agents` | list with install status and fact counts |
| `POST /api/agents` | `{name}` → scaffold (same as `hearth new`) |
| `POST /api/agents/:name/install` | install |
| `GET /api/memory/:layer` | list facts in a layer (`global`, `agents/<name>`, `projects/<slug>`) |
| `GET /api/memory/:layer/:name` | one fact |
| `PUT /api/memory/:layer/:name` | create or update a fact (incl. `pinned`) |
| `DELETE /api/memory/:layer/:name` | remove a fact (used to clear conflicts) |
| `GET /api/projects` | known project slugs with handoff counts and last activity |
| `GET /api/projects/:slug/handoffs` | handoffs, newest first |
| `GET /api/search?q=&agent=&project=` | search; response includes `semantic: true|false` |
| `GET /api/profiles` | model profiles and each endpoint's last health result |
| `GET /api/models` | models reported by the local server |
| `POST /api/sync` | run sync; returns per-repo result and conflicts |
| `GET /api/status` | config, §3.1 map with live values, last sync, pending changes |
| `GET /` and static | dashboard |

Errors are `{error: string}` with 400 for bad input, 404 for unknown layer/fact, 409 for sync conflicts that need attention, 502 when a model endpoint is unreachable, 500 otherwise.

## 9. MCP server

Stdio transport via the official `@modelcontextprotocol/sdk`. Tools:

- `memory_search(query, agent?, project?)`
- `memory_list(layer)`
- `memory_read(layer, name)`
- `memory_write(layer, name?, type, text, pinned?)`
- `memory_handoff(working_on, decisions?, open_threads?, next_steps?, files_touched?, project?)`
- `agent_list()`

Each tool is a direct call into `core/`. Tool descriptions tell the model when to use `global`, an agent layer, or the project layer, and when to write a handoff. Any MCP-capable runtime, not only Claude Code, can use this server. That is how Codex or a local-model tool reaches the same memory today, ahead of first-class support in v1.1.

## 10. Dashboard

Static files served by the API. Vanilla HTML, CSS, and JavaScript using `fetch`; no bundler, so every file is readable and editable directly. Five views:

1. **Setup** — shown first until every required check passes, reachable any time after. A checklist in plain language: Claude Code installed and logged in; GitHub CLI installed and logged in; agents repo and memory repo (with a "create for me" button); Claude Code registration (button); optional local models (link to Ollama's installer, then a copyable `ollama pull` command, then a "make a profile" button). Each unmet item says exactly what to do and offers a copy button for any command. Written for someone who has never opened a terminal on purpose.
2. **Agents** — cards per agent: description, installed or not, skills, MCP servers, fact count; buttons for install and open-in-GitHub; a "run with profile" dropdown that shows the exact `hearth run` command to copy.
3. **Memory** — layer picker (global, agent, project), search box (shows whether semantic ranking is active), fact list, click to read and edit inline, pin toggle, conflict badge with side-by-side resolve. Under a project: its handoffs, newest first, with "agent-written" or "automatic" labels.
4. **Models** — profiles with health indicators, local models available, create-profile form.
5. **Status** — the §3.1 map with live values and sizes, current project slug, both repos' pending changes, a Sync button, last result, doctor output.

Visual design follows the `ux-foundations` and `frontend-design` skills when built. Light and dark themes via `prefers-color-scheme`.

## 11. Installer and stack

**`install.sh`**, served from the hearthkit repo, so the team instruction is one line:

```
curl -fsSL https://raw.githubusercontent.com/<user>/hearthkit/main/install.sh | sh
```

It: checks for Node 20 or newer and, if missing, prints the nodejs.org link and the Homebrew command and stops; runs `npm install -g hearthkit`; checks for `git`, `gh`, and `claude` and prints install links for any that are missing without stopping; then runs `hearth setup`, which opens the Setup view where the remaining steps are guided. The script is idempotent and passes `shellcheck`. It never uses `sudo`.

**Stack.**

- Node 25 for development, Node 20+ at runtime. TypeScript, ESM. `tsx` for dev, `tsc` for build.
- Runtime deps: `commander`, `hono`, `@hono/node-server`, `@modelcontextprotocol/sdk`, `gray-matter`, `zod` (input validation shared by CLI, API, MCP).
- Dev deps: `vitest`, `typescript`, `tsx`, `@types/node`.
- `git`, `gh`, and `claude` are invoked as subprocesses through the `git.ts` and `claude.ts` interfaces. Ollama is reached with `fetch` through the `ollama.ts` interface. No git library, no model SDK.

## 12. Testing

- **Core:** vitest against temp directories. Sync tests use a local bare repo as the "remote" and two working clones as "devices", so cross-device conflict cases are exercised without network. `claude.ts` is replaced with a fake that records calls. `ollama.ts` is replaced with a fake that serves canned tags and deterministic embeddings, plus an "unreachable" mode to prove fallback.
- **Handoffs:** capture is tested against fixture transcripts (`.jsonl`) covering a normal session, a session with an agent-written handoff already present, tool-heavy turns that must be excluded, and an over-long tail that must be capped. Slug derivation is tested with and without a git remote. Selection of "latest, prefer agent-written" is tested.
- **Setup:** each check is tested in ok, todo, and optional states with the fakes; the `next` text and `command` are snapshot-tested because they are user-facing copy.
- **Search:** keyword ranking tests; semantic re-rank tests with the fake embedder; cache invalidation on file edit.
- **Profiles:** `hearth run` is tested by asserting the env and args passed to the fake `claude`, never by launching a model.
- **CLI:** spawn the built binary with `HOME` pointed at a temp dir; assert stdout, exit codes, and resulting files. `hearth memory context` output is snapshot-tested including the token cap and handoff-first ordering.
- **Installer:** `shellcheck` in CI; a smoke test runs it with a temp npm prefix and a fake `npm` on `PATH`.
- **API:** start the Hono app in-process; call routes with `fetch`; assert JSON and status codes, including the token requirement on non-loopback hosts.
- **MCP:** call the tool handlers directly (they are thin over core); one smoke test spawns `hearth mcp` and performs a `tools/list` handshake.
- **Dashboard:** manual verification in v1, plus a test that every route the dashboard calls exists in the API.

Every feature is built test-first.

## 13. Security

- API is loopback-only unless a token is configured.
- No cloud credentials are stored; git and GitHub auth come from `gh`, Claude auth from `claude`. Local-server tokens in profiles are plain strings because local servers do not authenticate meaningfully.
- Memory repo is created private. `hearth init` refuses to proceed if the memory repo it is told to use is public, with an override flag.
- Fact and handoff writes reject path separators in names and slugs.
- Session-start hook output is bounded (§4.3) so a large memory cannot flood a context window.
- Automatic handoffs store only user and assistant text, never tool output, so file contents and command results from a session do not leak into the memory repo by accident. Users can delete any handoff from the dashboard.
- The installer never elevates privileges and prints every command before running it.

## 14. Phasing

**v1 (this spec):** core, CLI, MCP, API, dashboard with Setup view, three memory layers with handoffs, model profiles, semantic search, installer, tests.

**v1.1:**
- Codex CLI as a first-class target: `hearth new` also emits an `AGENTS.md` block and Codex MCP config; `hearth run --runtime codex`; tests against a fake `codex`.
- `hearth memory tidy`: use a local chat model to propose merges of near-duplicate facts; show proposals; apply only on confirmation. Deferred to keep v1 bounded and because it needs embeddings first.
- Auto-sync on a timer or on write.

**v1.2, prompt library:**
- `prompts/<name>.md` in the agents repo, frontmatter for tags and intended model, body is the prompt with `{{variables}}`.
- `hearth prompt list|show|use <name>` (fills variables, copies to clipboard or pipes into `hearth run`).
- Dashboard **Prompts** view; MCP tool `prompt_get`. The `prompts/` folder is reserved in the repo layout now so nothing moves later.

**v2:** shared team memory layer that is opt-in per agent; exporters for other runtimes; VPS agent runner using Claude Code headless mode.

## 15. Open decisions resolved

- **Own bundle format vs. Claude Code plugins:** plugins. Less code, native install, and team sharing already works.
- **Memory storage:** git-backed markdown, one fact per file. Human-readable, merge-friendly, no server.
- **Memory delivery:** automatic at session start via plugin hook, capped; MCP tools for depth and writing.
- **Session continuity:** a per-project handoff layer, written by the agent when it can and captured from the transcript when it cannot. Project identity comes from the git remote so it matches across machines.
- **Non-technical setup:** a one-line installer that hands off to a browser checklist. The terminal is touched once.
- **Local models:** hearthkit never becomes a runtime. It launches Claude Code against Anthropic-compatible local servers via env, and uses a local embedding model only for search. Both degrade gracefully when the server is off.
- **Language:** Node + TypeScript, matching the Claude Code ecosystem and the installed toolchain.
- **Dashboard build tooling:** none. Readability wins for a learning project.
