# hearthkit

Memory and session handoffs for Claude Code that follow you to every machine.

Claude Code forgets between machines and between sessions. hearthkit stores what it learns as plain markdown in a private git repo you own, loads it automatically at the start of every session, and captures where you left off when a session ends.

## What you get

- **Global memory**: facts about you, loaded in every session, everywhere.
- **Project memory**: facts about one codebase, loaded in the folder linked to it on this machine.
- **Handoffs**: when a session ends, what you were working on is saved; the next session in that project starts with it, even on another laptop.
- **Tools for the agent**: search, read, write, promote, and hand off, over MCP.
- **Your files, your repo**: one fact per markdown file, synced with git. No database, no service.

## Requirements

- Claude Code, logged in
- git
- Node 20 or newer (`node --version`)
- A private git remote for memory: a free GitHub account is enough, or any private git URL

## Install

Inside Claude Code:

```
/plugin marketplace add c0reyx/hearthkit
/plugin install hearth@hearthkit
```

Installs come from the tagged release the marketplace points at, so you get a tested build.

Restart Claude Code once, then run:

```
/hearth:setup
```

Claude walks you through the rest: it checks your machine, creates (or connects) your private memory repo, and asks a few questions to seed your memory.

## Daily use

You mostly do nothing. Memory loads at session start; the agent writes facts as it learns them; a handoff is captured when you quit.

- Say **"write a handoff"** or run `/hearth:handoff` before you stop, for a better handoff than the automatic one.
- Run `/hearth:sync` to push and pull right now. Sync also runs in the background after each session.
- Ask **"where were we?"** in a new session; the handoff is already in context.

## Command line

The same tool is available in a terminal after `npm install -g hearthkit`, or directly from the plugin folder shown by `hearth where`.

| Command | What it does |
|---|---|
| `hearth init [--remote <url>]` | create or connect the memory repo |
| `hearth doctor` | check everything, print fixes |
| `hearth where` | show every path hearthkit and Claude Code use |
| `hearth list` | layers, fact counts, handoffs, conflicts |
| `hearth sync` | pull, merge, push |
| `hearth memory add <layer> "text" [--name] [--type] [--pin]` | add a fact (`global`, `project`, `project:<slug>`) |
| `hearth memory search <query>` | find facts and handoffs |
| `hearth memory show <layer> <name>` | print a fact |
| `hearth memory delete <layer> <name>` | delete a fact |
| `hearth memory promote <name>` | move a project fact to global |
| `hearth project show` | the project slug, the folder it is linked to, and whether this one matches |
| `hearth project link` | link this project's memory to the current folder on this machine |
| `hearth handoff write --working-on "..." [...]` | write a handoff by hand |
| `hearth handoff list [project]` | list handoffs |
| `hearth handoff delete <id> [project]` | delete a handoff |

## Where everything lives

| Path | What |
|---|---|
| `~/.hearth/config.json` | config: repo location, device name, context cap |
| `~/.hearth/projects.json` | which folder on this machine owns each project layer (never synced) |
| `~/.hearth/sync-state.json` | the outcome of the last sync; a failure is flagged at session start |
| `~/.hearth/memory/` | memory repo (local clone); syncs with your remote |
| `~/.hearth/memory/projects/<slug>/` | this project's layer: facts and `handoffs/` |
| `~/.hearth/logs/hearth.log` | logs (hook, sync, MCP; no transcript text) |
| `~/.claude/plugins/…/hearth/` | the plugin: bundled `dist/hearth.js` and `dist/mcp.js` |
| `~/.claude/settings.json` | Claude Code: marketplace and plugin registration |
| `~/.claude/plugins/` | Claude Code: installed plugin copies |
| `~/.claude/projects/<folder-slug>/` | Claude Code transcripts for the current folder; read by handoff capture, never written |
| the running `hearth` entry point | the CLI that is executing (npm global or the plugin's dist) |

`hearth where` prints this with live values, including which folder this project's layer is linked to. Set `HEARTH_HOME` to move `~/.hearth`. Global facts live in `~/.hearth/memory/global/`.

## Linking a project

A project's memory lives under a slug derived from its git `origin`, so every machine agrees on the name. Which *folder* that memory belongs to is decided per machine, because any repository can claim any `origin` in its `.git/config`.

- The first folder you open a project in claims it, as long as that project has no memory on this machine yet.
- A layer that already has memory here — one that arrived over sync, for example on a new machine — is never claimed automatically. hearthkit says so at session start; run `hearth project link` in the right folder once.
- A second clone, a git worktree, or a checkout you moved needs `hearth project link` too. Linking is exclusive: the folder you link becomes the only one that reads and writes that layer, and the previous one has to be linked back.
- Until a folder is linked, that project's facts and handoffs are neither loaded nor written there. Global memory is unaffected. `hearth project show` prints the current state.

## Conflicts

If the same fact is edited on two machines, sync keeps both: the other machine's version keeps the name, yours becomes `<name>.conflict-<device>.md`. `hearth doctor` lists them; delete the one you do not want.

## Privacy

The memory repo must be private; `hearth init` refuses a public GitHub repo. Automatic handoffs contain only what you and Claude said, never tool output or file contents. Anything can be deleted with the CLI or in the repo. hearth doctor also checks the repo's visibility on GitHub and tells you if it is not private.

## What hearthkit trusts

Everything under the memory repo is treated as untrusted input, because it can arrive from another machine over sync. Worth knowing:

- **Memory is re-injected into future prompts.** Facts and the last handoff are printed into the model's context at session start, inside a `<hearth-memory>` block labelled "data, not instructions". A poisoned memory can still try to steer a session, so inspect what is stored — `hearth list`, `hearth memory show <layer> <name>` — and delete anything you did not intend with `hearth memory delete <layer> <name>`.
- **Automatic handoffs quote conversation text.** What you and Claude said in the last ~30 turns is stored verbatim, including anything you pasted into the chat, and the background sync pushes it to your remote unattended. Write your own handoff (`/hearth:handoff`) if you would rather choose the words.
- **The memory repo must be private, and its token is a machine credential.** Anyone who can push to that remote can put text — and file names — in front of your agent on every machine you use.
- **`HEARTH_HOME` is read from the environment**, so a project-scope `.claude/settings.json` in a repository you have trusted can move where hearthkit reads its config and memory from.
- **Frontmatter is YAML only**, files under the memory root must be ordinary files (`hearth sync` and `hearth doctor` refuse a symlink there), and memory files hearthkit creates are `0600`.

### Behaviour changes to know about

- Project memory is loaded and written only in the folder linked to that project on this machine; see "Linking a project" above. On a machine that already has synced project memory, run `hearth project link` once per project.
- `hearth sync` stops and reports instead of continuing when `git commit` fails, when the working tree would be overwritten, or when anything under the memory root is not an ordinary file. A failed sync is flagged at the next session start; the git error itself goes to `~/.hearth/logs/hearth.log` and `hearth doctor`.
- Frontmatter is parsed as YAML only. A memory file whose frontmatter is anything else is shown as an unparseable fact rather than being interpreted.
- Memory files hearthkit writes are created `0600` (owner read/write only).

## Uninstall

`/plugin uninstall hearth@hearthkit`, then delete `~/.hearth` if you want the local clone gone. Your memory repo on GitHub is untouched.

## Developing hearthkit itself

When you run Claude Code inside this repo, Claude Code also reads the repo's own `.mcp.json` as a project config, where `${CLAUDE_PLUGIN_ROOT}` is not set, so that copy of the `hearth` server cannot start. The committed `.claude/settings.json` disables that duplicate; the plugin's own server (loaded with `claude --plugin-dir .`) still works. This only affects this folder.

## Roadmap

v1.1: per-agent memory, activity history, Codex CLI support, optional semantic search. v1.2: prompt library. v2: hosted team hub with a web dashboard and remote MCP for Claude.ai and ChatGPT.

## Licence

MIT
