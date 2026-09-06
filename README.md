# hearthkit

Memory and session handoffs for Claude Code that follow you to every machine.

Claude Code forgets between machines and between sessions. hearthkit stores what it learns as plain markdown in a private git repo you own, loads it automatically at the start of every session, and captures where you left off when a session ends.

## What you get

- **Global memory**: facts about you, loaded in every session, everywhere.
- **Project memory**: facts about one codebase, loaded when you work in it.
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
| `hearth handoff write --working-on "..." [...]` | write a handoff by hand |
| `hearth handoff list [project]` | list handoffs |
| `hearth handoff delete <id> [project]` | delete a handoff |

## Where everything lives

| Path | What |
|---|---|
| `~/.hearth/config.json` | config: repo location, device name, context cap |
| `~/.hearth/memory/` | memory repo (local clone); syncs with your remote |
| `~/.hearth/memory/projects/<slug>/` | this project's layer: facts and `handoffs/` |
| `~/.hearth/logs/hearth.log` | logs (hook, sync, MCP; no transcript text) |
| `~/.claude/plugins/…/hearth/` | the plugin: bundled `dist/hearth.js` and `dist/mcp.js` |
| `~/.claude/settings.json` | Claude Code: marketplace and plugin registration |
| `~/.claude/plugins/` | Claude Code: installed plugin copies |
| `~/.claude/projects/<folder-slug>/` | Claude Code transcripts for the current folder; read by handoff capture, never written |
| the running `hearth` entry point | the CLI that is executing (npm global or the plugin's dist) |

`hearth where` prints this with live values. Set `HEARTH_HOME` to move `~/.hearth`. Global facts live in `~/.hearth/memory/global/`.

## Conflicts

If the same fact is edited on two machines, sync keeps both: the other machine's version keeps the name, yours becomes `<name>.conflict-<device>.md`. `hearth doctor` lists them; delete the one you do not want.

## Privacy

The memory repo must be private; `hearth init` refuses a public GitHub repo. Automatic handoffs contain only what you and Claude said, never tool output or file contents. Anything can be deleted with the CLI or in the repo. hearth doctor also checks the repo's visibility on GitHub and tells you if it is not private.

## Uninstall

`/plugin uninstall hearth@hearthkit`, then delete `~/.hearth` if you want the local clone gone. Your memory repo on GitHub is untouched.

## Roadmap

v1.1: per-agent memory, activity history, Codex CLI support, optional semantic search. v1.2: prompt library. v2: hosted team hub with a web dashboard and remote MCP for Claude.ai and ChatGPT.

## Licence

MIT
