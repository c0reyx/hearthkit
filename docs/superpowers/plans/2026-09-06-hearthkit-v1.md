# hearthkit v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship hearthkit v1: a Claude Code plugin, carrying its own bundled CLI, that gives every session on every machine git-synced global and per-project memory plus session handoffs.

**Architecture:** A pure `core/` library does all the work against a `MemoryStore` interface (one file-based implementation over a git clone at `~/.hearth/memory`). Three thin faces sit on it: the `hearth` CLI (also invoked by the plugin's SessionStart/SessionEnd hooks), an MCP stdio server, and plugin manifests. `git` and `gh` are subprocesses behind an `Exec` interface so tests use a fake or real local repos, never the network.

**Tech Stack:** TypeScript (ESM, NodeNext), Node 20+ runtime, commander 15, @modelcontextprotocol/sdk 1.30, gray-matter 4, zod 4, vitest 5, esbuild 0.28.

**Spec:** `docs/superpowers/specs/2026-09-06-hearthkit-design.md`

## Global Constraints

- Runtime floor is Node 20 (`"engines": {"node": ">=20"}`); develop on Node 25.
- Runtime deps are exactly: `commander`, `@modelcontextprotocol/sdk`, `gray-matter`, `zod`. Dev deps: `vitest`, `esbuild`, `typescript`, `tsx`, `@types/node`. No git library, no model SDK.
- `cli/` and `mcp/` contain no business logic. `memory.ts`, `handoff.ts`, `search.ts`, `context.ts` depend only on `MemoryStore`; `sync.ts` is the only module that knows the store is a git clone.
- Hook commands (`hearth memory context`, `hearth handoff capture`) always exit 0. Failures go to `~/.hearth/logs/hearth.log`.
- Fact frontmatter matches Claude Code auto-memory: `name`, `description`, `metadata.type` in `user|feedback|project|reference`, plus `metadata.created`, `metadata.device`, `metadata.pinned`.
- Fact names and slugs match `^[A-Za-z0-9][A-Za-z0-9._-]*$` and never contain `..`.
- Handoff filename: `<YYYY-MM-DD-HHMM>-<device>.md` in UTC. Automatic handoffs hold user and assistant text only, never tool output. Tail = last 30 turns, capped at 1,500 estimated tokens (4 chars per token).
- Session context cap defaults to 4,000 estimated tokens; the handoff is never truncated.
- Handoffs older than 30 days are pruned except the newest per project.
- Memory repo must be private; `hearth init` refuses a public GitHub repo unless `--allow-public`.
- Exit codes: 0 ok, 1 user error, 2 environment error. Errors name the fix.
- Every commit message ends with the trailer lines shown in Task 1 Step 8.
- All paths under `HEARTH_HOME` (env override) default to `~/.hearth`. Tests always set `HEARTH_HOME` to a temp dir.

---

## File structure

```
hearthkit/
  package.json, tsconfig.json, vitest.config.ts, .gitignore
  scripts/build.mjs            esbuild: src/cli/index.ts → dist/hearth.js, src/mcp/index.ts → dist/mcp.js
  scripts/release.mjs          build, force-add dist, commit, tag v<version>
  src/core/
    types.ts       LayerRef, Fact, Handoff, HearthError, layerId/parseLayerId, assertSafeName
    slug.ts        slugify
    exec.ts        Exec interface, RealExec (child_process), FakeExec (scripted, records calls)
    git.ts         remoteUrl, currentBranch, isGitRepo, parseOwnerRepo
    config.ts      Config, hearthHome, load/save/requireConfig, defaultDevice
    project.ts     projectSlug(exec, cwd)
    store.ts       MemoryStore interface + FileStore
    memory.ts      parse/serialize facts, writeFact, listFacts, readFact, deleteFact, indexLine, regenerateIndex, promoteFact
    handoff.ts     handoffId, parse/serialize, writeHandoff, listHandoffs, latestHandoff, pruneHandoffs, captureHandoff
    transcript.ts  parseTranscript, tailTurns, renderTurns, estimateTokens
    context.ts     buildContext
    search.ts      search
    sync.ts        syncRepo
    init.ts        initMemory
    doctor.ts      runDoctor, renderChecks
    where.ts       whereAll
    log.ts         appendLog
  src/cli/
    program.ts     buildProgram(deps) — all commander commands
    index.ts       entry: buildProgram with real deps, parse argv
  src/mcp/
    server.ts      createMcpServer(deps) — six tools
    index.ts       entry: stdio transport
  .claude-plugin/plugin.json, .claude-plugin/marketplace.json
  hooks/hooks.json, .mcp.json
  commands/setup.md, commands/sync.md, commands/handoff.md
  skills/memory-use/SKILL.md
  README.md, docs/ACCEPTANCE.md, docs/TEAM-AGENTS.md
  test/                        one *.test.ts per core module + cli.test.ts, mcp.test.ts, manifests.test.ts
  test/fixtures/transcripts/   *.jsonl fixtures
  test/setup/build.ts          vitest globalSetup: runs scripts/build.mjs once
  test/helpers/tmp.ts          mkTmpDir, writeJson helpers
  test/helpers/gitrepo.ts      makeBareRemote, cloneWithIdentity
```

Task order follows dependencies. Every task ends with passing tests and a commit.

---

### Task 1: Project scaffold, core types, slugify

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/core/types.ts`, `src/core/slug.ts`
- Create: `test/helpers/tmp.ts`, `test/types.test.ts`, `test/slug.test.ts`

**Interfaces:**
- Produces: `LayerRef`, `GLOBAL`, `project(slug)`, `layerId(l)`, `parseLayerId(id)`, `FactType`, `FACT_TYPES`, `Fact`, `Handoff`, `HearthError(message, exitCode)`, `assertSafeName(name)`, `slugify(text, max=60)`, test helper `mkTmpDir(prefix)`.

- [ ] **Step 1: Create package.json**

```json
{
  "name": "hearthkit",
  "version": "0.1.0",
  "description": "Git-synced memory and session handoffs for Claude Code",
  "license": "MIT",
  "type": "module",
  "bin": { "hearth": "dist/hearth.js" },
  "files": ["dist", "README.md", "LICENSE"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "node scripts/build.mjs",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "release": "node scripts/release.mjs"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.30.0",
    "commander": "^15.0.0",
    "gray-matter": "^4.0.3",
    "zod": "^4.5.4"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "esbuild": "^0.28.2",
    "tsx": "^4.23.0",
    "typescript": "^5.9.0",
    "vitest": "^5.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json, vitest.config.ts, .gitignore**

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test", "scripts"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    globalSetup: ['test/setup/build.ts'],
  },
});
```

`.gitignore`:
```
node_modules/
dist/
*.log
.DS_Store
```

(`dist/` is ignored day to day and force-added only by `scripts/release.mjs` in Task 22.)

- [ ] **Step 3: Create the test build hook so vitest can start (it builds nothing yet)**

`test/setup/build.ts`:
```ts
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export default function setup(): void {
  if (existsSync('scripts/build.mjs')) {
    execFileSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
  }
}
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, no errors. Commit `package-lock.json` too.

- [ ] **Step 5: Write failing tests for types and slugify**

`test/helpers/tmp.ts`:
```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function mkTmpDir(prefix = 'hearth-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
```

`test/types.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { GLOBAL, HearthError, assertSafeName, layerId, parseLayerId, project } from '../src/core/types.js';

describe('layer ids', () => {
  it('round-trips global and project layers', () => {
    expect(layerId(GLOBAL)).toBe('global');
    expect(layerId(project('acme-crm'))).toBe('projects/acme-crm');
    expect(parseLayerId('global')).toEqual(GLOBAL);
    expect(parseLayerId('projects/acme-crm')).toEqual(project('acme-crm'));
  });
  it('rejects unknown layer ids with a user error', () => {
    expect(() => parseLayerId('agents/x')).toThrow(HearthError);
    expect(() => parseLayerId('projects/../x')).toThrow(HearthError);
  });
});

describe('assertSafeName', () => {
  it('accepts kebab names and rejects path tricks', () => {
    expect(() => assertSafeName('prefers-tables')).not.toThrow();
    expect(() => assertSafeName('a.b_c-1')).not.toThrow();
    expect(() => assertSafeName('../etc')).toThrow(HearthError);
    expect(() => assertSafeName('a/b')).toThrow(HearthError);
    expect(() => assertSafeName('')).toThrow(HearthError);
    expect(() => assertSafeName('.hidden')).toThrow(HearthError);
  });
});
```

`test/slug.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { slugify } from '../src/core/slug.js';

describe('slugify', () => {
  it('lowercases, replaces punctuation, trims dashes', () => {
    expect(slugify('Corey prefers tables & visuals!')).toBe('corey-prefers-tables-visuals');
    expect(slugify('  --Hello World--  ')).toBe('hello-world');
  });
  it('caps length at 60 without a trailing dash', () => {
    const s = slugify('a'.repeat(59) + ' bcd');
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.endsWith('-')).toBe(false);
  });
  it('returns empty string for nothing usable', () => {
    expect(slugify('!!!')).toBe('');
  });
});
```

- [ ] **Step 6: Run tests to verify they fail**

Run: `npx vitest run`
Expected: FAIL, "Cannot find module '../src/core/types.js'" (and slug).

- [ ] **Step 7: Implement types.ts and slug.ts**

`src/core/types.ts`:
```ts
export type LayerRef = { kind: 'global' } | { kind: 'project'; slug: string };

export const GLOBAL: LayerRef = { kind: 'global' };

export function project(slug: string): LayerRef {
  return { kind: 'project', slug };
}

export class HearthError extends Error {
  constructor(message: string, public readonly exitCode: 1 | 2 = 1) {
    super(message);
    this.name = 'HearthError';
  }
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertSafeName(name: string): void {
  if (!SAFE_NAME.test(name) || name.includes('..')) {
    throw new HearthError(
      `Invalid name "${name}". Use letters, digits, dots, dashes, or underscores, starting with a letter or digit.`,
    );
  }
}

export function layerId(layer: LayerRef): string {
  return layer.kind === 'global' ? 'global' : `projects/${layer.slug}`;
}

export function parseLayerId(id: string): LayerRef {
  if (id === 'global') return GLOBAL;
  const m = /^projects\/(.+)$/.exec(id);
  if (m && m[1] !== undefined) {
    assertSafeName(m[1]);
    return project(m[1]);
  }
  throw new HearthError(`Unknown layer "${id}". Use "global" or "projects/<slug>".`);
}

export type FactType = 'user' | 'feedback' | 'project' | 'reference';
export const FACT_TYPES: readonly FactType[] = ['user', 'feedback', 'project', 'reference'];

export interface Fact {
  name: string;
  description: string;
  type: FactType;
  created: string; // YYYY-MM-DD
  device: string;
  pinned: boolean;
  body: string;
}

export type HandoffSource = 'agent' | 'auto';

export interface Handoff {
  id: string; // filename without .md, e.g. 2026-09-06-1530-coreys-macbook
  device: string;
  source: HandoffSource;
  session: string;
  branch: string;
  timestamp: string; // ISO 8601
  workingOn: string;
  decisions: string;
  openThreads: string;
  nextSteps: string;
  filesTouched: string;
}
```

`src/core/slug.ts`:
```ts
export function slugify(text: string, max = 60): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/-+$/g, '');
}
```

- [ ] **Step 8: Run tests, typecheck, commit**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS, no type errors.

```bash
git add -A
git commit -m "feat: scaffold project with core types and slugify

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Vo11sYWhQUDvQH37Zt5NwK"
```

Every later commit in this plan uses the same two trailer lines.

---

### Task 2: Exec interface with real and fake implementations; git helpers

**Files:**
- Create: `src/core/exec.ts`, `src/core/git.ts`
- Test: `test/exec.test.ts`, `test/git.test.ts`

**Interfaces:**
- Produces: `interface Exec { run(cmd, args, opts?): Promise<ExecResult> }`, `ExecResult {code, stdout, stderr}`, `ExecOptions {cwd?, input?, env?}`, `class RealExec`, `class FakeExec { calls; on(cmd, argPrefix, result): this }`, `remoteUrl(exec, cwd)`, `currentBranch(exec, cwd)`, `isGitRepo(exec, cwd)`, `parseOwnerRepo(url)`.

- [ ] **Step 1: Write failing tests**

`test/exec.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { FakeExec, RealExec } from '../src/core/exec.js';

describe('RealExec', () => {
  it('captures stdout and exit code', async () => {
    const r = await new RealExec().run(process.execPath, ['-e', 'process.stdout.write("hi"); process.exit(3)']);
    expect(r.stdout).toBe('hi');
    expect(r.code).toBe(3);
  });
  it('passes stdin input', async () => {
    const r = await new RealExec().run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'echo' });
    expect(r.stdout).toBe('echo');
  });
  it('returns code 127 for a missing command instead of throwing', async () => {
    const r = await new RealExec().run('definitely-not-a-command-xyz', []);
    expect(r.code).toBe(127);
  });
});

describe('FakeExec', () => {
  it('matches on command and argument prefix and records calls', async () => {
    const fake = new FakeExec().on('git', ['remote', 'get-url'], { stdout: 'git@github.com:acme/crm.git\n' });
    const r = await fake.run('git', ['remote', 'get-url', 'origin'], { cwd: '/x' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('acme/crm');
    expect(fake.calls[0]?.args).toEqual(['remote', 'get-url', 'origin']);
  });
  it('returns 127 for unscripted commands', async () => {
    const r = await new FakeExec().run('gh', ['--version']);
    expect(r.code).toBe(127);
  });
});
```

`test/git.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { FakeExec } from '../src/core/exec.js';
import { currentBranch, isGitRepo, parseOwnerRepo, remoteUrl } from '../src/core/git.js';

describe('parseOwnerRepo', () => {
  it('handles ssh, https, and ssh:// forms', () => {
    expect(parseOwnerRepo('git@github.com:acme/crm.git')).toEqual({ owner: 'acme', repo: 'crm' });
    expect(parseOwnerRepo('https://github.com/acme/crm.git')).toEqual({ owner: 'acme', repo: 'crm' });
    expect(parseOwnerRepo('https://gitlab.com/acme/crm')).toEqual({ owner: 'acme', repo: 'crm' });
    expect(parseOwnerRepo('ssh://git@bitbucket.org/acme/crm.git')).toEqual({ owner: 'acme', repo: 'crm' });
    expect(parseOwnerRepo('/srv/git/memory.git')).toBeNull();
  });
});

describe('git helpers', () => {
  it('remoteUrl returns trimmed url or null', async () => {
    const fake = new FakeExec().on('git', ['remote', 'get-url', 'origin'], { stdout: 'https://x/y/z.git\n' });
    expect(await remoteUrl(fake, '/r')).toBe('https://x/y/z.git');
    expect(await remoteUrl(new FakeExec().on('git', ['remote'], { code: 2 }), '/r')).toBeNull();
  });
  it('currentBranch and isGitRepo', async () => {
    const fake = new FakeExec()
      .on('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdout: 'main\n' })
      .on('git', ['rev-parse', '--is-inside-work-tree'], { stdout: 'true\n' });
    expect(await currentBranch(fake, '/r')).toBe('main');
    expect(await isGitRepo(fake, '/r')).toBe(true);
    expect(await isGitRepo(new FakeExec().on('git', ['rev-parse'], { code: 128 }), '/r')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/exec.test.ts test/git.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement exec.ts**

```ts
import { spawn } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  input?: string;
  env?: Record<string, string>;
}

export interface Exec {
  run(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult>;
}

export class RealExec implements Exec {
  run(cmd: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      const child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('error', (err) => resolve({ code: 127, stdout, stderr: err.message }));
      child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      if (opts.input !== undefined) child.stdin.write(opts.input);
      child.stdin.end();
    });
  }
}

interface FakeRule {
  cmd: string;
  argPrefix: string[];
  result: Partial<ExecResult>;
}

export class FakeExec implements Exec {
  readonly calls: { cmd: string; args: string[]; opts: ExecOptions | undefined }[] = [];
  private readonly rules: FakeRule[] = [];

  on(cmd: string, argPrefix: string[], result: Partial<ExecResult>): this {
    this.rules.push({ cmd, argPrefix, result });
    return this;
  }

  async run(cmd: string, args: string[], opts?: ExecOptions): Promise<ExecResult> {
    this.calls.push({ cmd, args, opts });
    // Last matching rule wins so tests can override earlier defaults.
    const rule = [...this.rules].reverse().find(
      (r) => r.cmd === cmd && r.argPrefix.every((p, i) => args[i] === p),
    );
    if (!rule) return { code: 127, stdout: '', stderr: `FakeExec: no rule for ${cmd} ${args.join(' ')}` };
    return { code: 0, stdout: '', stderr: '', ...rule.result };
  }
}
```

- [ ] **Step 4: Implement git.ts**

```ts
import type { Exec } from './exec.js';

export async function remoteUrl(exec: Exec, cwd: string): Promise<string | null> {
  const r = await exec.run('git', ['remote', 'get-url', 'origin'], { cwd });
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

export async function currentBranch(exec: Exec, cwd: string): Promise<string | null> {
  const r = await exec.run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

export async function isGitRepo(exec: Exec, cwd: string): Promise<boolean> {
  const r = await exec.run('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  return r.code === 0 && r.stdout.trim() === 'true';
}

export function parseOwnerRepo(url: string): { owner: string; repo: string } | null {
  // Matches "...:owner/repo(.git)" and ".../owner/repo(.git)" when a host precedes them.
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@\/]+@)?[^\/:]+[:\/]([^\/:]+)\/([^\/]+?)(?:\.git)?\/?$/.exec(url);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return { owner: m[1], repo: m[2] };
}
```

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `npx vitest run test/exec.test.ts test/git.test.ts && npx tsc --noEmit`
Expected: PASS.

```bash
git add -A
git commit -m "feat: Exec interface with real and fake runners, git helpers"
```
(append the two trailer lines from Task 1 Step 8)

---

### Task 3: Config

**Files:**
- Create: `src/core/config.ts`
- Test: `test/config.test.ts`

**Interfaces:**
- Produces: `interface Config { memoryDir: string; device: string; contextCapTokens: number; remote: string | null }`, `hearthHome(env?)`, `defaultDevice()`, `defaultConfig(home)`, `loadConfig(home)`, `saveConfig(home, cfg)`, `requireConfig(home)` (throws `HearthError` exit 2 when missing).

- [ ] **Step 1: Write failing tests**

`test/config.test.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HearthError } from '../src/core/types.js';
import { defaultConfig, hearthHome, loadConfig, requireConfig, saveConfig } from '../src/core/config.js';
import { mkTmpDir } from './helpers/tmp.js';

describe('config', () => {
  const tmp = mkTmpDir();
  afterEach(() => tmp.cleanup());

  it('hearthHome honours HEARTH_HOME and defaults to ~/.hearth', () => {
    expect(hearthHome({ HEARTH_HOME: '/tmp/h' })).toBe('/tmp/h');
    expect(hearthHome({})).toMatch(/\.hearth$/);
  });

  it('defaultConfig points memoryDir inside home with a 4000 token cap', () => {
    const cfg = defaultConfig('/h');
    expect(cfg.memoryDir).toBe(join('/h', 'memory'));
    expect(cfg.contextCapTokens).toBe(4000);
    expect(cfg.device.length).toBeGreaterThan(0);
    expect(cfg.remote).toBeNull();
  });

  it('saves and loads, creating the directory', async () => {
    const home = join(tmp.dir, 'nested', 'home');
    const cfg = { ...defaultConfig(home), remote: 'git@github.com:a/b.git' };
    await saveConfig(home, cfg);
    expect(existsSync(join(home, 'config.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).remote).toBe('git@github.com:a/b.git');
    expect(await loadConfig(home)).toEqual(cfg);
  });

  it('loadConfig returns null when missing; requireConfig throws exit 2', async () => {
    expect(await loadConfig(join(tmp.dir, 'nope'))).toBeNull();
    await expect(requireConfig(join(tmp.dir, 'nope'))).rejects.toMatchObject({ exitCode: 2 });
    await expect(requireConfig(join(tmp.dir, 'nope'))).rejects.toBeInstanceOf(HearthError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/config.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement config.ts**

```ts
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { slugify } from './slug.js';
import { HearthError } from './types.js';

export interface Config {
  memoryDir: string;
  device: string;
  contextCapTokens: number;
  remote: string | null;
}

export function hearthHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HEARTH_HOME ?? join(homedir(), '.hearth');
}

export function defaultDevice(): string {
  return slugify(hostname().replace(/\.local$/i, '')) || 'device';
}

export function defaultConfig(home: string): Config {
  return { memoryDir: join(home, 'memory'), device: defaultDevice(), contextCapTokens: 4000, remote: null };
}

function configPath(home: string): string {
  return join(home, 'config.json');
}

export async function loadConfig(home: string): Promise<Config | null> {
  try {
    const raw = await readFile(configPath(home), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Config>;
    return { ...defaultConfig(home), ...parsed };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new HearthError(`Could not read ${configPath(home)}: ${(err as Error).message}`, 2);
  }
}

export async function saveConfig(home: string, cfg: Config): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(configPath(home), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

export async function requireConfig(home: string): Promise<Config> {
  const cfg = await loadConfig(home);
  if (!cfg) {
    throw new HearthError(`hearthkit is not set up on this machine. Run: hearth init   (or /hearth:setup inside Claude Code)`, 2);
  }
  return cfg;
}
```

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx vitest run test/config.test.ts && npx tsc --noEmit`
Expected: PASS.

```bash
git add -A
git commit -m "feat: config load/save with HEARTH_HOME override"
```

---

### Task 4: Project slug

**Files:**
- Create: `src/core/project.ts`
- Test: `test/project.test.ts`

**Interfaces:**
- Consumes: `Exec`, `remoteUrl`, `parseOwnerRepo`, `slugify`.
- Produces: `projectSlug(exec, cwd): Promise<string>`.

- [ ] **Step 1: Write failing test**

`test/project.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { FakeExec } from '../src/core/exec.js';
import { projectSlug } from '../src/core/project.js';

describe('projectSlug', () => {
  it('uses owner-repo from the git remote so every machine agrees', async () => {
    const fake = new FakeExec().on('git', ['remote', 'get-url', 'origin'], { stdout: 'git@github.com:Opensense/HubSpot_Import.git\n' });
    expect(await projectSlug(fake, '/Users/x/anything')).toBe('opensense-hubspot-import');
  });
  it('falls back to the directory basename without a remote', async () => {
    const fake = new FakeExec().on('git', ['remote'], { code: 2 });
    expect(await projectSlug(fake, '/Users/x/My Project')).toBe('my-project');
  });
  it('never returns an empty slug', async () => {
    const fake = new FakeExec().on('git', ['remote'], { code: 2 });
    expect(await projectSlug(fake, '/')).toBe('project');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/project.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
import { basename } from 'node:path';
import type { Exec } from './exec.js';
import { parseOwnerRepo, remoteUrl } from './git.js';
import { slugify } from './slug.js';

export async function projectSlug(exec: Exec, cwd: string): Promise<string> {
  const url = await remoteUrl(exec, cwd);
  if (url) {
    const parsed = parseOwnerRepo(url);
    if (parsed) {
      const s = slugify(`${parsed.owner}-${parsed.repo}`);
      if (s) return s;
    }
  }
  return slugify(basename(cwd)) || 'project';
}
```

- [ ] **Step 4: Run tests, commit**

Run: `npx vitest run test/project.test.ts && npx tsc --noEmit`

```bash
git add -A
git commit -m "feat: derive project slug from git remote or directory"
```

---

### Task 5: MemoryStore interface and FileStore

**Files:**
- Create: `src/core/store.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Produces:
```ts
interface MemoryStore {
  readonly root: string;
  listLayers(): Promise<LayerRef[]>;
  listFacts(layer: LayerRef): Promise<string[]>;          // names, sorted, excludes MEMORY.md
  readFact(layer: LayerRef, name: string): Promise<string | null>;   // raw markdown
  writeFact(layer: LayerRef, name: string, raw: string): Promise<void>;
  deleteFact(layer: LayerRef, name: string): Promise<boolean>;
  readIndex(layer: LayerRef): Promise<string | null>;
  writeIndex(layer: LayerRef, content: string): Promise<void>;
  listHandoffs(slug: string): Promise<string[]>;          // ids, newest first
  readHandoff(slug: string, id: string): Promise<string | null>;
  writeHandoff(slug: string, id: string, raw: string): Promise<void>;
  deleteHandoff(slug: string, id: string): Promise<boolean>;
}
class FileStore implements MemoryStore { constructor(root: string); layerDir(layer): string }
```
The store deals only in raw markdown strings. Parsing lives in `memory.ts` and `handoff.ts`.

- [ ] **Step 1: Write failing tests**

`test/store.test.ts`:
```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileStore } from '../src/core/store.js';
import { GLOBAL, project } from '../src/core/types.js';
import { mkTmpDir } from './helpers/tmp.js';

describe('FileStore', () => {
  const tmp = mkTmpDir();
  afterEach(() => tmp.cleanup());

  it('writes, lists, reads, deletes facts per layer and ignores MEMORY.md', async () => {
    const store = new FileStore(tmp.dir);
    await store.writeFact(GLOBAL, 'likes-tables', '---\nname: likes-tables\n---\nbody');
    await store.writeFact(project('acme'), 'uses-pnpm', '---\nname: uses-pnpm\n---\nbody');
    await store.writeIndex(GLOBAL, '# index');
    expect(await store.listFacts(GLOBAL)).toEqual(['likes-tables']);
    expect(await store.listFacts(project('acme'))).toEqual(['uses-pnpm']);
    expect(await store.readFact(GLOBAL, 'likes-tables')).toContain('body');
    expect(await store.readFact(GLOBAL, 'missing')).toBeNull();
    expect(await store.readIndex(GLOBAL)).toBe('# index');
    expect(await store.deleteFact(GLOBAL, 'likes-tables')).toBe(true);
    expect(await store.deleteFact(GLOBAL, 'likes-tables')).toBe(false);
    expect(existsSync(join(tmp.dir, 'projects', 'acme', 'uses-pnpm.md'))).toBe(true);
  });

  it('lists layers that exist', async () => {
    const store = new FileStore(tmp.dir);
    expect(await store.listLayers()).toEqual([]);
    await store.writeFact(project('b'), 'x', 'x');
    await store.writeFact(project('a'), 'x', 'x');
    await store.writeFact(GLOBAL, 'x', 'x');
    expect(await store.listLayers()).toEqual([GLOBAL, project('a'), project('b')]);
  });

  it('stores handoffs under projects/<slug>/handoffs newest first', async () => {
    const store = new FileStore(tmp.dir);
    await store.writeHandoff('acme', '2026-09-05-1000-mac', 'old');
    await store.writeHandoff('acme', '2026-09-06-0900-mac', 'new');
    expect(await store.listHandoffs('acme')).toEqual(['2026-09-06-0900-mac', '2026-09-05-1000-mac']);
    expect(await store.listHandoffs('nothing')).toEqual([]);
    expect(await store.readHandoff('acme', '2026-09-06-0900-mac')).toBe('new');
    expect(await store.deleteHandoff('acme', '2026-09-05-1000-mac')).toBe(true);
    expect(await store.listHandoffs('acme')).toEqual(['2026-09-06-0900-mac']);
  });

  it('rejects unsafe names', async () => {
    const store = new FileStore(tmp.dir);
    await expect(store.writeFact(GLOBAL, '../escape', 'x')).rejects.toThrow(/Invalid name/);
    await expect(store.readHandoff('a/b', 'x')).rejects.toThrow(/Invalid name/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement store.ts**

```ts
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GLOBAL, assertSafeName, layerId, project, type LayerRef } from './types.js';

export interface MemoryStore {
  readonly root: string;
  listLayers(): Promise<LayerRef[]>;
  listFacts(layer: LayerRef): Promise<string[]>;
  readFact(layer: LayerRef, name: string): Promise<string | null>;
  writeFact(layer: LayerRef, name: string, raw: string): Promise<void>;
  deleteFact(layer: LayerRef, name: string): Promise<boolean>;
  readIndex(layer: LayerRef): Promise<string | null>;
  writeIndex(layer: LayerRef, content: string): Promise<void>;
  listHandoffs(slug: string): Promise<string[]>;
  readHandoff(slug: string, id: string): Promise<string | null>;
  writeHandoff(slug: string, id: string, raw: string): Promise<void>;
  deleteHandoff(slug: string, id: string): Promise<boolean>;
}

export const INDEX_FILE = 'MEMORY.md';

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function writeEnsuring(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

async function removeIfExists(path: string): Promise<boolean> {
  try {
    await rm(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function listMd(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== INDEX_FILE)
      .map((e) => e.name.slice(0, -3))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export class FileStore implements MemoryStore {
  constructor(readonly root: string) {}

  layerDir(layer: LayerRef): string {
    return join(this.root, layerId(layer));
  }

  private handoffDir(slug: string): string {
    assertSafeName(slug);
    return join(this.root, 'projects', slug, 'handoffs');
  }

  async listLayers(): Promise<LayerRef[]> {
    const layers: LayerRef[] = [];
    if ((await readOrNull(join(this.root, 'global', '.gitkeep'))) !== null || (await listMd(join(this.root, 'global'))).length > 0) {
      layers.push(GLOBAL);
    }
    try {
      const entries = await readdir(join(this.root, 'projects'), { withFileTypes: true });
      for (const e of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        layers.push(project(e.name));
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return layers;
  }

  listFacts(layer: LayerRef): Promise<string[]> {
    return listMd(this.layerDir(layer));
  }

  readFact(layer: LayerRef, name: string): Promise<string | null> {
    assertSafeName(name);
    return readOrNull(join(this.layerDir(layer), `${name}.md`));
  }

  writeFact(layer: LayerRef, name: string, raw: string): Promise<void> {
    assertSafeName(name);
    return writeEnsuring(join(this.layerDir(layer), `${name}.md`), raw);
  }

  deleteFact(layer: LayerRef, name: string): Promise<boolean> {
    assertSafeName(name);
    return removeIfExists(join(this.layerDir(layer), `${name}.md`));
  }

  readIndex(layer: LayerRef): Promise<string | null> {
    return readOrNull(join(this.layerDir(layer), INDEX_FILE));
  }

  writeIndex(layer: LayerRef, content: string): Promise<void> {
    return writeEnsuring(join(this.layerDir(layer), INDEX_FILE), content);
  }

  async listHandoffs(slug: string): Promise<string[]> {
    const ids = await listMd(this.handoffDir(slug));
    return ids.sort().reverse();
  }

  readHandoff(slug: string, id: string): Promise<string | null> {
    assertSafeName(id);
    return readOrNull(join(this.handoffDir(slug), `${id}.md`));
  }

  writeHandoff(slug: string, id: string, raw: string): Promise<void> {
    assertSafeName(id);
    return writeEnsuring(join(this.handoffDir(slug), `${id}.md`), raw);
  }

  deleteHandoff(slug: string, id: string): Promise<boolean> {
    assertSafeName(id);
    return removeIfExists(join(this.handoffDir(slug), `${id}.md`));
  }
}
```

Note on `listLayers`: the global layer counts as existing if it has a `.gitkeep` (created by `hearth init` in Task 14) or any fact. The test's first `listLayers()` call on an empty root returns `[]`.

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx vitest run test/store.test.ts && npx tsc --noEmit`
Expected: PASS.

```bash
git add -A
git commit -m "feat: MemoryStore interface with file-based implementation"
```

---
### Task 6: Facts: parse, serialize, write, list, index

**Files:**
- Create: `src/core/memory.ts`
- Test: `test/memory.test.ts`

**Interfaces:**
- Consumes: `MemoryStore`, `Fact`, `FactType`, `FACT_TYPES`, `LayerRef`, `layerId`, `HearthError`, `slugify`.
- Produces: `parseFact(name, raw): Fact`, `serializeFact(fact): string`, `firstLine(text, max=100)`, `isoDate(date)`, `interface WriteFactInput {layer, text, name?, description?, type?, pinned?, device, now?}`, `writeFact(store, input): Promise<Fact>`, `readFact(store, layer, name): Promise<Fact|null>`, `listFacts(store, layer): Promise<Fact[]>`, `deleteFact(store, layer, name): Promise<boolean>`, `indexLine(fact): string`, `renderIndex(layer, facts): string`, `regenerateIndex(store, layer): Promise<string>`.

- [ ] **Step 1: Write failing tests**

`test/memory.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import {
  deleteFact, listFacts, parseFact, readFact, regenerateIndex, renderIndex, serializeFact, writeFact,
} from '../src/core/memory.js';
import { FileStore } from '../src/core/store.js';
import { GLOBAL, project } from '../src/core/types.js';
import { mkTmpDir } from './helpers/tmp.js';

const NOW = new Date('2026-09-06T15:30:00Z');

describe('facts', () => {
  const tmp = mkTmpDir();
  afterEach(() => tmp.cleanup());

  it('writes a fact with derived name, description, created date, and regenerates the index', async () => {
    const store = new FileStore(tmp.dir);
    const fact = await writeFact(store, {
      layer: GLOBAL, text: 'Corey prefers tables and visual summaries over long prose.', type: 'user', device: 'mac', now: NOW,
    });
    expect(fact.name).toBe('corey-prefers-tables-and-visual-summaries');
    expect(fact.description).toBe('Corey prefers tables and visual summaries over long prose.');
    expect(fact.created).toBe('2026-09-06');
    expect(fact.pinned).toBe(false);
    const raw = await store.readFact(GLOBAL, fact.name);
    expect(raw).toContain('name: corey-prefers-tables-and-visual-summaries');
    expect(raw).toContain('type: user');
    expect(raw).toContain("created: '2026-09-06'");
    expect(await store.readIndex(GLOBAL)).toContain('- corey-prefers-tables-and-visual-summaries: Corey prefers tables and visual summaries over long prose. [user]');
  });

  it('round-trips through parse and serialize, including pinned', async () => {
    const fact = {
      name: 'uses-pnpm', description: 'Repo uses pnpm', type: 'project' as const, created: '2026-01-02', device: 'mac', pinned: true,
      body: 'Always run pnpm, never npm, in this repo.\n\nSee [[ci-setup]].',
    };
    expect(parseFact('uses-pnpm', serializeFact(fact))).toEqual(fact);
  });

  it('reads Claude Code style files whose dates were written unquoted (YAML parses them as Date)', () => {
    const raw = '---\nname: x\ndescription: d\nmetadata:\n  type: feedback\n  created: 2026-03-04\n---\nbody\n';
    const f = parseFact('x', raw);
    expect(f.created).toBe('2026-03-04');
    expect(f.type).toBe('feedback');
    expect(f.device).toBe('');
  });

  it('updating an existing fact keeps its created date and lets you pin it', async () => {
    const store = new FileStore(tmp.dir);
    await writeFact(store, { layer: GLOBAL, text: 'first version', name: 'thing', device: 'mac', now: NOW });
    const updated = await writeFact(store, {
      layer: GLOBAL, text: 'second version', name: 'thing', device: 'laptop', pinned: true, now: new Date('2026-10-01T00:00:00Z'),
    });
    expect(updated.created).toBe('2026-09-06');
    expect(updated.device).toBe('laptop');
    expect(updated.pinned).toBe(true);
    expect(await store.readIndex(GLOBAL)).toContain('[reference, pinned]');
  });

  it('renders a deterministic, sorted index and flags conflict copies', () => {
    const a = parseFact('b-fact', '---\nname: b-fact\ndescription: B\n---\n');
    const b = parseFact('a-fact', '---\nname: a-fact\ndescription: A\n---\n');
    const c = parseFact('a-fact.conflict-laptop', '---\nname: a-fact.conflict-laptop\ndescription: A2\n---\n');
    const out = renderIndex(project('acme'), [a, b, c]);
    expect(out.split('\n').filter((l) => l.startsWith('- '))).toEqual([
      '- a-fact: A [reference]',
      '- a-fact.conflict-laptop: A2 [reference] (conflict copy)',
      '- b-fact: B [reference]',
    ]);
    expect(out).toContain('# Memory index: projects/acme');
    expect(renderIndex(GLOBAL, [])).toContain('(no facts yet)');
  });

  it('list, read, delete; delete regenerates the index', async () => {
    const store = new FileStore(tmp.dir);
    await writeFact(store, { layer: project('acme'), text: 'one', name: 'one', device: 'mac', now: NOW });
    await writeFact(store, { layer: project('acme'), text: 'two', name: 'two', device: 'mac', now: NOW });
    expect((await listFacts(store, project('acme'))).map((f) => f.name)).toEqual(['one', 'two']);
    expect((await readFact(store, project('acme'), 'one'))?.body).toBe('one');
    expect(await deleteFact(store, project('acme'), 'one')).toBe(true);
    expect(await store.readIndex(project('acme'))).not.toContain('- one:');
    expect(await regenerateIndex(store, project('acme'))).toContain('- two:');
  });

  it('rejects empty text', async () => {
    const store = new FileStore(tmp.dir);
    await expect(writeFact(store, { layer: GLOBAL, text: '   ', device: 'mac' })).rejects.toThrow(/needs some text/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/memory.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement memory.ts**

```ts
import matter from 'gray-matter';
import { slugify } from './slug.js';
import type { MemoryStore } from './store.js';
import { FACT_TYPES, HearthError, layerId, type Fact, type FactType, type LayerRef } from './types.js';

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function firstLine(text: string, max = 100): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function asString(v: unknown): string {
  if (v instanceof Date) return isoDate(v);
  return typeof v === 'string' ? v : '';
}

export function parseFact(name: string, raw: string): Fact {
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;
  const meta = (typeof data.metadata === 'object' && data.metadata ? data.metadata : {}) as Record<string, unknown>;
  const body = parsed.content.trim();
  const type = FACT_TYPES.includes(meta.type as FactType) ? (meta.type as FactType) : 'reference';
  return {
    name: asString(data.name) || name,
    description: asString(data.description) || firstLine(body),
    type,
    created: asString(meta.created),
    device: asString(meta.device),
    pinned: meta.pinned === true,
    body,
  };
}

export function serializeFact(f: Fact): string {
  return matter.stringify(`${f.body}\n`, {
    name: f.name,
    description: f.description,
    metadata: { type: f.type, created: f.created, device: f.device, pinned: f.pinned },
  });
}

export interface WriteFactInput {
  layer: LayerRef;
  text: string;
  name?: string;
  description?: string;
  type?: FactType;
  pinned?: boolean;
  device: string;
  now?: Date;
}

export async function writeFact(store: MemoryStore, input: WriteFactInput): Promise<Fact> {
  const body = input.text.trim();
  if (!body) throw new HearthError('A fact needs some text.');
  const name = input.name ?? slugify(body.split(/\s+/).slice(0, 6).join(' '));
  if (!name) throw new HearthError('Could not derive a name from that text. Pass --name.');
  const existingRaw = await store.readFact(input.layer, name);
  const prev = existingRaw === null ? null : parseFact(name, existingRaw);
  const fact: Fact = {
    name,
    description: input.description ?? firstLine(body),
    type: input.type ?? prev?.type ?? 'reference',
    created: prev?.created || isoDate(input.now ?? new Date()),
    device: input.device,
    pinned: input.pinned ?? prev?.pinned ?? false,
    body,
  };
  await store.writeFact(input.layer, name, serializeFact(fact));
  await regenerateIndex(store, input.layer);
  return fact;
}

export async function readFact(store: MemoryStore, layer: LayerRef, name: string): Promise<Fact | null> {
  const raw = await store.readFact(layer, name);
  return raw === null ? null : parseFact(name, raw);
}

export async function listFacts(store: MemoryStore, layer: LayerRef): Promise<Fact[]> {
  const out: Fact[] = [];
  for (const name of await store.listFacts(layer)) {
    const f = await readFact(store, layer, name);
    if (f) out.push(f);
  }
  return out;
}

export async function deleteFact(store: MemoryStore, layer: LayerRef, name: string): Promise<boolean> {
  const ok = await store.deleteFact(layer, name);
  if (ok) await regenerateIndex(store, layer);
  return ok;
}

export function indexLine(f: Fact): string {
  const flags = `${f.type}${f.pinned ? ', pinned' : ''}`;
  const conflict = f.name.includes('.conflict-') ? ' (conflict copy)' : '';
  return `- ${f.name}: ${f.description} [${flags}]${conflict}`;
}

export function renderIndex(layer: LayerRef, facts: Fact[]): string {
  const sorted = [...facts].sort((a, b) => a.name.localeCompare(b.name));
  const lines = [`# Memory index: ${layerId(layer)}`, '', '<!-- generated by hearthkit; do not edit by hand -->', ''];
  lines.push(...(sorted.length === 0 ? ['(no facts yet)'] : sorted.map(indexLine)));
  return `${lines.join('\n')}\n`;
}

export async function regenerateIndex(store: MemoryStore, layer: LayerRef): Promise<string> {
  const content = renderIndex(layer, await listFacts(store, layer));
  await store.writeIndex(layer, content);
  return content;
}
```

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx vitest run test/memory.test.ts && npx tsc --noEmit`
Expected: PASS. If the `created: '2026-09-06'` assertion fails because js-yaml emitted the date unquoted, parse still works via the `Date` branch; change the assertion to `toContain('created:')` and keep the round-trip test as the real guard.

```bash
git add -A
git commit -m "feat: fact parsing, writing, and index regeneration"
```

---

### Task 7: Promote a fact from a project layer to global

**Files:**
- Modify: `src/core/memory.ts` (append)
- Test: `test/memory.test.ts` (append a describe block)

**Interfaces:**
- Produces: `promoteFact(store, name, from: LayerRef): Promise<Fact>`.

- [ ] **Step 1: Write failing tests** (append to `test/memory.test.ts`; add `promoteFact` and `HearthError` to the imports)

```ts
describe('promoteFact', () => {
  const tmp = mkTmpDir();
  afterEach(() => tmp.cleanup());

  it('moves a fact to global and regenerates both indexes', async () => {
    const store = new FileStore(tmp.dir);
    await writeFact(store, { layer: project('acme'), text: 'Corey is in Central Time.', name: 'timezone', type: 'user', device: 'mac', now: NOW });
    const moved = await promoteFact(store, 'timezone', project('acme'));
    expect(moved.name).toBe('timezone');
    expect(await store.readFact(project('acme'), 'timezone')).toBeNull();
    expect((await readFact(store, GLOBAL, 'timezone'))?.type).toBe('user');
    expect(await store.readIndex(GLOBAL)).toContain('- timezone:');
    expect(await store.readIndex(project('acme'))).not.toContain('- timezone:');
  });

  it('refuses when the name already exists in global, or the source is not a project', async () => {
    const store = new FileStore(tmp.dir);
    await writeFact(store, { layer: GLOBAL, text: 'g', name: 'dup', device: 'mac' });
    await writeFact(store, { layer: project('acme'), text: 'p', name: 'dup', device: 'mac' });
    await expect(promoteFact(store, 'dup', project('acme'))).rejects.toThrow(/already has a fact named "dup"/);
    await expect(promoteFact(store, 'dup', GLOBAL)).rejects.toBeInstanceOf(HearthError);
    await expect(promoteFact(store, 'missing', project('acme'))).rejects.toThrow(/No fact named "missing"/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/memory.test.ts -t promoteFact`
Expected: FAIL, `promoteFact` is not exported.

- [ ] **Step 3: Implement** (append to `src/core/memory.ts`; add `GLOBAL` to the types import)

```ts
export async function promoteFact(store: MemoryStore, name: string, from: LayerRef): Promise<Fact> {
  if (from.kind !== 'project') {
    throw new HearthError('promote moves a fact from a project layer to global. Pass --from project or --from project:<slug>.');
  }
  const fact = await readFact(store, from, name);
  if (!fact) throw new HearthError(`No fact named "${name}" in ${layerId(from)}.`);
  if ((await store.readFact(GLOBAL, name)) !== null) {
    throw new HearthError(`global already has a fact named "${name}". Compare them with: hearth memory show global ${name}`);
  }
  await store.writeFact(GLOBAL, name, serializeFact(fact));
  await store.deleteFact(from, name);
  await regenerateIndex(store, from);
  await regenerateIndex(store, GLOBAL);
  return fact;
}
```

- [ ] **Step 4: Run tests, commit**

Run: `npx vitest run test/memory.test.ts && npx tsc --noEmit`

```bash
git add -A
git commit -m "feat: promote facts from a project layer to global"
```

---

### Task 8: Handoffs: id, parse, serialize, write, list, latest, prune

**Files:**
- Create: `src/core/handoff.ts`
- Test: `test/handoff.test.ts`

**Interfaces:**
- Consumes: `MemoryStore`, `Handoff`, `HandoffSource`, `HearthError`.
- Produces: `handoffId(now, device)`, `serializeHandoff(h)`, `parseHandoff(id, raw)`, `interface HandoffInput {slug, device, source, session, branch, workingOn, decisions?, openThreads?, nextSteps?, filesTouched?, now?}`, `writeHandoff(store, input): Promise<Handoff>`, `listHandoffs(store, slug): Promise<Handoff[]>` (newest first), `latestHandoff(store, slug): Promise<Handoff|null>`, `pruneHandoffs(store, slug, now, maxAgeDays=30): Promise<string[]>`, `pruneAllHandoffs(store, now): Promise<string[]>`.

- [ ] **Step 1: Write failing tests**

`test/handoff.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import {
  handoffId, latestHandoff, listHandoffs, parseHandoff, pruneAllHandoffs, pruneHandoffs, serializeHandoff, writeHandoff,
} from '../src/core/handoff.js';
import { FileStore } from '../src/core/store.js';
import { mkTmpDir } from './helpers/tmp.js';

const T1 = new Date('2026-09-06T15:30:00Z');
const T2 = new Date('2026-09-06T16:45:00Z');

describe('handoffs', () => {
  const tmp = mkTmpDir();
  afterEach(() => tmp.cleanup());

  it('builds ids from UTC time and device', () => {
    expect(handoffId(T1, 'coreys-macbook')).toBe('2026-09-06-1530-coreys-macbook');
  });

  it('round-trips through serialize and parse', () => {
    const h = {
      id: '2026-09-06-1530-mac', device: 'mac', source: 'agent' as const, session: 'abc', branch: 'main',
      timestamp: '2026-09-06T15:30:00.000Z', workingOn: 'HubSpot import script', decisions: 'Use CSV not API',
      openThreads: 'Rate limits unclear', nextSteps: '- test with 500 rows', filesTouched: 'import.py',
    };
    expect(parseHandoff(h.id, serializeHandoff(h))).toEqual(h);
  });

  it('writes, lists newest first, and avoids id collisions in the same minute', async () => {
    const store = new FileStore(tmp.dir);
    const a = await writeHandoff(store, { slug: 'acme', device: 'mac', source: 'agent', session: 's1', branch: 'main', workingOn: 'first', now: T1 });
    const b = await writeHandoff(store, { slug: 'acme', device: 'mac', source: 'agent', session: 's1', branch: 'main', workingOn: 'second', now: T1 });
    const c = await writeHandoff(store, { slug: 'acme', device: 'mac', source: 'auto', session: 's2', branch: 'main', workingOn: 'third', now: T2 });
    expect(a.id).toBe('2026-09-06-1530-mac');
    expect(b.id).toBe('2026-09-06-1530-mac-2');
    expect((await listHandoffs(store, 'acme')).map((h) => h.id)).toEqual([c.id, b.id, a.id]);
    expect(await listHandoffs(store, 'other')).toEqual([]);
  });

  it('latest prefers an agent-written handoff from the same session over a later automatic one', async () => {
    const store = new FileStore(tmp.dir);
    await writeHandoff(store, { slug: 'acme', device: 'mac', source: 'agent', session: 's9', branch: 'main', workingOn: 'agent note', now: T1 });
    await writeHandoff(store, { slug: 'acme', device: 'mac', source: 'auto', session: 's9', branch: 'main', workingOn: 'auto tail', now: T2 });
    expect((await latestHandoff(store, 'acme'))?.workingOn).toBe('agent note');
    await writeHandoff(store, { slug: 'acme', device: 'mac', source: 'auto', session: 's10', branch: 'main', workingOn: 'newer session', now: new Date('2026-09-07T00:00:00Z') });
    expect((await latestHandoff(store, 'acme'))?.workingOn).toBe('newer session');
    expect(await latestHandoff(store, 'nothing')).toBeNull();
  });

  it('prunes handoffs older than 30 days but always keeps the newest', async () => {
    const store = new FileStore(tmp.dir);
    const old1 = await writeHandoff(store, { slug: 'acme', device: 'mac', source: 'auto', session: '', branch: '', workingOn: 'x', now: new Date('2026-06-01T00:00:00Z') });
    const old2 = await writeHandoff(store, { slug: 'acme', device: 'mac', source: 'auto', session: '', branch: '', workingOn: 'x', now: new Date('2026-07-01T00:00:00Z') });
    const only = await writeHandoff(store, { slug: 'solo', device: 'mac', source: 'auto', session: '', branch: '', workingOn: 'x', now: new Date('2025-01-01T00:00:00Z') });
    const now = new Date('2026-09-06T00:00:00Z');
    expect(await pruneHandoffs(store, 'acme', now)).toEqual([old1.id]);
    expect((await listHandoffs(store, 'acme')).map((h) => h.id)).toEqual([old2.id]);
    expect(await pruneAllHandoffs(store, now)).toEqual([]);
    expect((await listHandoffs(store, 'solo')).map((h) => h.id)).toEqual([only.id]);
  });

  it('requires working-on text', async () => {
    const store = new FileStore(tmp.dir);
    await expect(writeHandoff(store, { slug: 'acme', device: 'mac', source: 'agent', session: '', branch: '', workingOn: '  ' })).rejects.toThrow(/working on/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/handoff.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement handoff.ts**

```ts
import matter from 'gray-matter';
import type { MemoryStore } from './store.js';
import { HearthError, type Handoff, type HandoffSource } from './types.js';

export function handoffId(now: Date, device: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}-${device}`;
}

type SectionKey = 'workingOn' | 'decisions' | 'openThreads' | 'nextSteps' | 'filesTouched';
export const HANDOFF_SECTIONS: readonly [SectionKey, string][] = [
  ['workingOn', 'Working on'],
  ['decisions', 'Decisions'],
  ['openThreads', 'Open threads'],
  ['nextSteps', 'Next steps'],
  ['filesTouched', 'Files touched'],
];

function str(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return typeof v === 'string' ? v : '';
}

export function serializeHandoff(h: Handoff): string {
  const body = HANDOFF_SECTIONS.map(([key, title]) => `## ${title}\n${h[key].trim()}\n`).join('\n');
  return matter.stringify(body, {
    device: h.device, source: h.source, session: h.session, branch: h.branch, timestamp: h.timestamp,
  });
}

export function parseHandoff(id: string, raw: string): Handoff {
  const parsed = matter(raw);
  const d = parsed.data as Record<string, unknown>;
  const sections: Record<string, string> = {};
  let current: string | null = null;
  for (const line of parsed.content.split('\n')) {
    const m = /^## (.+)$/.exec(line);
    if (m && m[1] !== undefined) {
      current = m[1].trim();
      sections[current] = '';
      continue;
    }
    if (current !== null) sections[current] = `${sections[current] ?? ''}${line}\n`;
  }
  const get = (title: string) => (sections[title] ?? '').trim();
  return {
    id,
    device: str(d.device),
    source: d.source === 'agent' ? 'agent' : 'auto',
    session: str(d.session),
    branch: str(d.branch),
    timestamp: str(d.timestamp),
    workingOn: get('Working on'),
    decisions: get('Decisions'),
    openThreads: get('Open threads'),
    nextSteps: get('Next steps'),
    filesTouched: get('Files touched'),
  };
}

export interface HandoffInput {
  slug: string;
  device: string;
  source: HandoffSource;
  session: string;
  branch: string;
  workingOn: string;
  decisions?: string;
  openThreads?: string;
  nextSteps?: string;
  filesTouched?: string;
  now?: Date;
}

export async function writeHandoff(store: MemoryStore, input: HandoffInput): Promise<Handoff> {
  if (!input.workingOn.trim()) throw new HearthError('A handoff needs at least a "working on" section.');
  const now = input.now ?? new Date();
  const base = handoffId(now, input.device);
  let id = base;
  for (let n = 2; (await store.readHandoff(input.slug, id)) !== null; n++) id = `${base}-${n}`;
  const h: Handoff = {
    id,
    device: input.device,
    source: input.source,
    session: input.session,
    branch: input.branch,
    timestamp: now.toISOString(),
    workingOn: input.workingOn.trim(),
    decisions: (input.decisions ?? '').trim(),
    openThreads: (input.openThreads ?? '').trim(),
    nextSteps: (input.nextSteps ?? '').trim(),
    filesTouched: (input.filesTouched ?? '').trim(),
  };
  await store.writeHandoff(input.slug, id, serializeHandoff(h));
  return h;
}

export async function listHandoffs(store: MemoryStore, slug: string): Promise<Handoff[]> {
  const out: Handoff[] = [];
  for (const id of await store.listHandoffs(slug)) {
    const raw = await store.readHandoff(slug, id);
    if (raw !== null) out.push(parseHandoff(id, raw));
  }
  return out.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id));
}

export async function latestHandoff(store: MemoryStore, slug: string): Promise<Handoff | null> {
  const all = await listHandoffs(store, slug);
  const newest = all[0];
  if (!newest) return null;
  if (newest.source === 'auto' && newest.session) {
    const agentSame = all.find((h) => h.source === 'agent' && h.session === newest.session);
    if (agentSame) return agentSame;
  }
  return newest;
}

export async function pruneHandoffs(store: MemoryStore, slug: string, now: Date, maxAgeDays = 30): Promise<string[]> {
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  const deleted: string[] = [];
  for (const h of (await listHandoffs(store, slug)).slice(1)) {
    const t = Date.parse(h.timestamp);
    if (!Number.isNaN(t) && t < cutoff) {
      await store.deleteHandoff(slug, h.id);
      deleted.push(h.id);
    }
  }
  return deleted;
}

export async function pruneAllHandoffs(store: MemoryStore, now: Date): Promise<string[]> {
  const out: string[] = [];
  for (const layer of await store.listLayers()) {
    if (layer.kind === 'project') out.push(...(await pruneHandoffs(store, layer.slug, now)));
  }
  return out;
}
```

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx vitest run test/handoff.test.ts && npx tsc --noEmit`

```bash
git add -A
git commit -m "feat: handoff write, list, latest selection, pruning"
```

---

### Task 9: Transcript parsing and tail selection

**Files:**
- Create: `src/core/transcript.ts`
- Create: `test/fixtures/transcripts/normal.jsonl`, `test/fixtures/transcripts/tool-heavy.jsonl`, `test/fixtures/transcripts/with-handoff.jsonl`
- Test: `test/transcript.test.ts`

**Interfaces:**
- Produces: `interface Turn {role: 'user'|'assistant'; text: string}`, `interface ParsedTranscript {turns: Turn[]; handoffToolCalled: boolean}`, `parseTranscript(jsonl): ParsedTranscript`, `stripNoise(text)`, `estimateTokens(text)`, `tailTurns(turns, maxTurns=30, maxTokens=1500)`, `renderTurns(turns)`.

Claude Code transcript facts this relies on (verified against a real transcript on 2026-09-06): one JSON object per line; `type` is `user`, `assistant`, or bookkeeping types; `message.content` is a string for typed user prompts or an array of blocks (`{type:'text',text}`, `{type:'tool_use',name,...}`, `{type:'tool_result',...}`, `{type:'thinking',...}`); `isSidechain: true` marks subagent turns. MCP tools appear as `tool_use` blocks named `mcp__<server>__<tool>`.

- [ ] **Step 1: Create fixtures**

`test/fixtures/transcripts/normal.jsonl` (each line one object; no blank lines between):
```
{"type":"user","isSidechain":false,"message":{"role":"user","content":"Let's fix the HubSpot import so it retries on 429."}}
{"type":"assistant","isSidechain":false,"message":{"role":"assistant","content":[{"type":"thinking","thinking":"private"},{"type":"text","text":"I'll add exponential backoff around the batch call."},{"type":"tool_use","id":"t1","name":"Read","input":{"file_path":"import.py"}}]}}
{"type":"user","isSidechain":false,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"SECRET_FILE_CONTENTS"}]}}
{"type":"assistant","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"subagent chatter"}]}}
{"type":"assistant","isSidechain":false,"message":{"role":"assistant","content":[{"type":"text","text":"Done. Backoff added with 3 retries."}]}}
{"type":"user","isSidechain":false,"message":{"role":"user","content":"<system-reminder>ignore me</system-reminder>Great, ship it."}}
{"type":"queue-operation","op":"x"}
```

`test/fixtures/transcripts/tool-heavy.jsonl`:
```
{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"a","content":"tool output only"}]}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"b","name":"Bash","input":{"command":"ls"}}]}}
{"type":"user","message":{"role":"user","content":"<command-name>/clear</command-name>\n<command-message>clear</command-message>"}}
```

`test/fixtures/transcripts/with-handoff.jsonl`:
```
{"type":"user","message":{"role":"user","content":"I'm stopping for today."}}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Writing a handoff."},{"type":"tool_use","id":"h1","name":"mcp__hearth__memory_handoff","input":{"working_on":"x"}}]}}
```

- [ ] **Step 2: Write failing tests**

`test/transcript.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { estimateTokens, parseTranscript, renderTurns, stripNoise, tailTurns } from '../src/core/transcript.js';

const fixture = (n: string) => readFileSync(`test/fixtures/transcripts/${n}.jsonl`, 'utf8');

describe('parseTranscript', () => {
  it('keeps user and assistant text only, drops tool blocks, sidechains, and reminders', () => {
    const { turns, handoffToolCalled } = parseTranscript(fixture('normal'));
    expect(turns).toEqual([
      { role: 'user', text: "Let's fix the HubSpot import so it retries on 429." },
      { role: 'assistant', text: "I'll add exponential backoff around the batch call." },
      { role: 'assistant', text: 'Done. Backoff added with 3 retries.' },
      { role: 'user', text: 'Great, ship it.' },
    ]);
    expect(JSON.stringify(turns)).not.toContain('SECRET_FILE_CONTENTS');
    expect(handoffToolCalled).toBe(false);
  });
  it('returns no turns for tool-only or slash-command-only content', () => {
    expect(parseTranscript(fixture('tool-heavy')).turns).toEqual([]);
  });
  it('detects a memory_handoff tool call', () => {
    expect(parseTranscript(fixture('with-handoff')).handoffToolCalled).toBe(true);
  });
  it('skips unparseable lines', () => {
    expect(parseTranscript('not json\n{"type":"user","message":{"content":"ok"}}\n').turns).toEqual([{ role: 'user', text: 'ok' }]);
  });
});

describe('tailTurns', () => {
  it('keeps the last 30 turns and trims from the front to fit the token cap', () => {
    const turns = Array.from({ length: 50 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `turn ${i} ${'x'.repeat(200)}` }));
    const tail = tailTurns(turns, 30, 1500);
    expect(tail.length).toBeLessThanOrEqual(30);
    expect(tail.at(-1)?.text.startsWith('turn 49')).toBe(true);
    expect(tail.reduce((n, t) => n + estimateTokens(t.text), 0)).toBeLessThanOrEqual(1500);
  });
  it('truncates a single oversized turn from the front', () => {
    const tail = tailTurns([{ role: 'user', text: 'y'.repeat(20_000) }], 30, 100);
    expect(tail).toHaveLength(1);
    expect(tail[0]?.text.startsWith('…')).toBe(true);
    expect(tail[0]?.text.length).toBeLessThanOrEqual(401);
  });
});

describe('helpers', () => {
  it('estimateTokens is chars/4 rounded up', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
  it('stripNoise removes system reminders and command wrappers', () => {
    expect(stripNoise('<system-reminder>a</system-reminder>keep<command-name>/x</command-name>')).toBe('keep');
  });
  it('renderTurns labels speakers', () => {
    expect(renderTurns([{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }])).toBe('**User:** hi\n\n**Assistant:** yo');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/transcript.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement transcript.ts**

```ts
export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ParsedTranscript {
  turns: Turn[];
  handoffToolCalled: boolean;
}

interface Block {
  type?: unknown;
  text?: unknown;
  name?: unknown;
}

const NOISE = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
];

export function stripNoise(text: string): string {
  return NOISE.reduce((t, re) => t.replace(re, ''), text);
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function parseTranscript(jsonl: string): ParsedTranscript {
  const turns: Turn[] = [];
  let handoffToolCalled = false;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let rec: { type?: unknown; isSidechain?: unknown; message?: { content?: unknown } };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue;
    }
    if (rec.type !== 'user' && rec.type !== 'assistant') continue;
    if (rec.isSidechain === true) continue;
    const content = rec.message?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      const blocks = content as Block[];
      if (blocks.some((b) => b?.type === 'tool_use' && typeof b.name === 'string' && b.name.endsWith('memory_handoff'))) {
        handoffToolCalled = true;
      }
      text = blocks
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n');
    }
    text = stripNoise(text).trim();
    if (text) turns.push({ role: rec.type, text });
  }
  return { turns, handoffToolCalled };
}

export function tailTurns(turns: Turn[], maxTurns = 30, maxTokens = 1500): Turn[] {
  let tail = turns.slice(-maxTurns);
  const total = () => tail.reduce((n, t) => n + estimateTokens(t.text), 0);
  while (tail.length > 1 && total() > maxTokens) tail = tail.slice(1);
  const only = tail[0];
  if (tail.length === 1 && only && estimateTokens(only.text) > maxTokens) {
    tail = [{ role: only.role, text: `…${only.text.slice(-(maxTokens * 4))}` }];
  }
  return tail;
}

export function renderTurns(turns: Turn[]): string {
  return turns.map((t) => `**${t.role === 'user' ? 'User' : 'Assistant'}:** ${t.text}`).join('\n\n');
}
```

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `npx vitest run test/transcript.test.ts && npx tsc --noEmit`

```bash
git add -A
git commit -m "feat: parse Claude Code transcripts into text-only turns"
```

---

### Task 10: Automatic handoff capture from the SessionEnd hook payload

**Files:**
- Modify: `src/core/handoff.ts` (append)
- Test: `test/handoff.test.ts` (append)

**Interfaces:**
- Consumes: `projectSlug`, `currentBranch`, `parseTranscript`, `tailTurns`, `renderTurns`, `listHandoffs`, `writeHandoff`.
- Produces: `interface HookPayload {session_id?, transcript_path?, cwd?, hook_event_name?, reason?}`, `interface CaptureDeps {store, exec, device, readFile?, now?}`, `captureHandoff(payload, deps): Promise<Handoff | null>`.

Rules: no transcript path → null. Any existing handoff for this session → null. Transcript shows the agent already called `memory_handoff` → null. Unreadable transcript → null. No text turns → null. Otherwise write `source: 'auto'` with the rendered tail under Working on.

- [ ] **Step 1: Write failing tests** (append to `test/handoff.test.ts`; add imports for `captureHandoff`, `FakeExec` from `../src/core/exec.js`, and `readFileSync` from `node:fs`)

```ts
describe('captureHandoff', () => {
  const tmp = mkTmpDir();
  afterEach(() => tmp.cleanup());
  const exec = () => new FakeExec()
    .on('git', ['remote', 'get-url', 'origin'], { stdout: 'git@github.com:acme/crm.git\n' })
    .on('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdout: 'feature/x\n' });
  const fixture = (n: string) => async () => readFileSync(`test/fixtures/transcripts/${n}.jsonl`, 'utf8');

  it('writes an automatic handoff from the transcript tail with only conversation text', async () => {
    const store = new FileStore(tmp.dir);
    const h = await captureHandoff(
      { session_id: 's1', transcript_path: '/t.jsonl', cwd: '/repo' },
      { store, exec: exec(), device: 'mac', readFile: fixture('normal'), now: T1 },
    );
    expect(h?.source).toBe('auto');
    expect(h?.session).toBe('s1');
    expect(h?.branch).toBe('feature/x');
    expect(h?.workingOn).toContain('**User:** Great, ship it.');
    expect(h?.workingOn).not.toContain('SECRET_FILE_CONTENTS');
    expect((await listHandoffs(store, 'acme-crm')).map((x) => x.id)).toEqual([h?.id]);
  });

  it('skips when the agent already wrote a handoff in this session (tool call seen in transcript)', async () => {
    const store = new FileStore(tmp.dir);
    const h = await captureHandoff({ session_id: 's2', transcript_path: '/t', cwd: '/repo' }, { store, exec: exec(), device: 'mac', readFile: fixture('with-handoff') });
    expect(h).toBeNull();
  });

  it('skips when a handoff for this session id already exists', async () => {
    const store = new FileStore(tmp.dir);
    await writeHandoff(store, { slug: 'acme-crm', device: 'mac', source: 'agent', session: 's3', branch: '', workingOn: 'x' });
    const h = await captureHandoff({ session_id: 's3', transcript_path: '/t', cwd: '/repo' }, { store, exec: exec(), device: 'mac', readFile: fixture('normal') });
    expect(h).toBeNull();
  });

  it('skips on missing path, unreadable file, or no text turns', async () => {
    const store = new FileStore(tmp.dir);
    expect(await captureHandoff({ cwd: '/repo' }, { store, exec: exec(), device: 'mac' })).toBeNull();
    expect(await captureHandoff({ transcript_path: '/nope', cwd: '/repo' }, { store, exec: exec(), device: 'mac', readFile: async () => { throw new Error('ENOENT'); } })).toBeNull();
    expect(await captureHandoff({ transcript_path: '/t', cwd: '/repo' }, { store, exec: exec(), device: 'mac', readFile: fixture('tool-heavy') })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/handoff.test.ts -t captureHandoff`
Expected: FAIL.

- [ ] **Step 3: Implement** (append to `src/core/handoff.ts`; add imports: `readFile` from `node:fs/promises`, `type Exec` from `./exec.js`, `currentBranch` from `./git.js`, `projectSlug` from `./project.js`, `parseTranscript, renderTurns, tailTurns` from `./transcript.js`)

```ts
export interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  reason?: string;
}

export interface CaptureDeps {
  store: MemoryStore;
  exec: Exec;
  device: string;
  readFile?: (path: string) => Promise<string>;
  now?: Date;
}

export async function captureHandoff(payload: HookPayload, deps: CaptureDeps): Promise<Handoff | null> {
  if (!payload.transcript_path) return null;
  const cwd = payload.cwd ?? process.cwd();
  const slug = await projectSlug(deps.exec, cwd);
  const session = payload.session_id ?? '';
  if (session && (await listHandoffs(deps.store, slug)).some((h) => h.session === session)) return null;

  let jsonl: string;
  try {
    jsonl = await (deps.readFile ?? ((p: string) => readFile(p, 'utf8')))(payload.transcript_path);
  } catch {
    return null;
  }
  const parsed = parseTranscript(jsonl);
  if (parsed.handoffToolCalled) return null;
  const tail = tailTurns(parsed.turns);
  if (tail.length === 0) return null;

  const branch = (await currentBranch(deps.exec, cwd)) ?? '';
  return writeHandoff(deps.store, {
    slug,
    device: deps.device,
    source: 'auto',
    session,
    branch,
    workingOn: renderTurns(tail),
    nextSteps: 'Automatic capture: the session ended without a written handoff. Ask the user what to pick up first.',
    now: deps.now,
  });
}
```

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx vitest run test/handoff.test.ts && npx tsc --noEmit`

```bash
git add -A
git commit -m "feat: capture automatic handoffs from session transcripts"
```

---

### Task 11: Session context builder

**Files:**
- Create: `src/core/context.ts`
- Test: `test/context.test.ts`

**Interfaces:**
- Consumes: `latestHandoff`, `listFacts`, `indexLine`, `estimateTokens`, `Handoff`, `Fact`.
- Produces: `renderHandoff(h): string`, `interface ContextInput {store, slug, capTokens}`, `buildContext(input): Promise<string>`.

Order: header, latest handoff (never truncated), global index lines, project index lines, pinned fact bodies, omission note, tool reminder. When over the cap, drop the oldest unpinned project lines first, then the oldest global lines.

- [ ] **Step 1: Write failing tests**

`test/context.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { buildContext } from '../src/core/context.js';
import { writeHandoff } from '../src/core/handoff.js';
import { writeFact } from '../src/core/memory.js';
import { FileStore } from '../src/core/store.js';
import { estimateTokens } from '../src/core/transcript.js';
import { GLOBAL, project } from '../src/core/types.js';
import { mkTmpDir } from './helpers/tmp.js';

describe('buildContext', () => {
  const tmp = mkTmpDir();
  afterEach(() => tmp.cleanup());

  it('puts the handoff first, then global, project, pinned bodies, and the tool reminder', async () => {
    const store = new FileStore(tmp.dir);
    await writeFact(store, { layer: GLOBAL, text: 'Corey likes tables.', name: 'likes-tables', type: 'user', device: 'mac' });
    await writeFact(store, { layer: project('acme'), text: 'Use pnpm here.', name: 'pnpm', type: 'project', pinned: true, device: 'mac' });
    await writeHandoff(store, { slug: 'acme', device: 'mac', source: 'agent', session: 's', branch: 'main', workingOn: 'Retry logic', nextSteps: '- test 429s', now: new Date('2026-09-06T15:30:00Z') });
    const out = await buildContext({ store, slug: 'acme', capTokens: 4000 });
    const idx = (s: string) => out.indexOf(s);
    expect(idx('# hearthkit memory')).toBe(0);
    expect(idx('## Last handoff (written by the agent, 2026-09-06 15:30 UTC, mac, branch main)')).toBeGreaterThan(0);
    expect(idx('Retry logic')).toBeLessThan(idx('## Global memory'));
    expect(idx('- likes-tables: Corey likes tables. [user]')).toBeLessThan(idx('## Project memory: projects/acme'));
    expect(idx('## Pinned facts')).toBeLessThan(idx('Use pnpm here.'));
    expect(idx('## Tools')).toBeGreaterThan(idx('Use pnpm here.'));
    expect(out).toContain('memory_handoff');
    expect(out).toContain('"projects/acme"');
  });

  it('says so when there is no handoff and no facts', async () => {
    const store = new FileStore(tmp.dir);
    const out = await buildContext({ store, slug: 'new', capTokens: 4000 });
    expect(out).toContain('No handoff yet for this project.');
    expect(out).toContain('(none yet)');
  });

  it('drops oldest project lines first to fit the cap, never the handoff, and notes the omission', async () => {
    const store = new FileStore(tmp.dir);
    for (let i = 0; i < 40; i++) {
      await writeFact(store, { layer: project('acme'), text: `project fact ${i} ${'p'.repeat(120)}`, name: `p-${String(i).padStart(2, '0')}`, device: 'mac', now: new Date(2026, 0, 1 + i) });
    }
    await writeFact(store, { layer: GLOBAL, text: 'global keeper', name: 'g-keep', device: 'mac' });
    await writeHandoff(store, { slug: 'acme', device: 'mac', source: 'auto', session: '', branch: '', workingOn: 'H'.repeat(2000) });
    const out = await buildContext({ store, slug: 'acme', capTokens: 900 });
    expect(out).toContain('H'.repeat(2000));
    expect(out).toContain('- g-keep:');
    expect(out).not.toContain('- p-00:');
    expect(out).toContain('- p-39:');
    expect(out).toMatch(/omitted \d+ older memory lines/);
    expect(estimateTokens(out)).toBeLessThanOrEqual(900 + estimateTokens('H'.repeat(2000)));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/context.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement context.ts**

```ts
import { latestHandoff } from './handoff.js';
import { indexLine, listFacts } from './memory.js';
import type { MemoryStore } from './store.js';
import { estimateTokens } from './transcript.js';
import { GLOBAL, project, type Fact, type Handoff } from './types.js';

export function renderHandoff(h: Handoff): string {
  const when = h.timestamp ? `${h.timestamp.slice(0, 16).replace('T', ' ')} UTC` : h.id;
  const who = h.source === 'agent' ? 'written by the agent' : 'captured automatically';
  const branch = h.branch ? `, branch ${h.branch}` : '';
  const sections: [string, string][] = [
    ['Working on', h.workingOn], ['Decisions', h.decisions], ['Open threads', h.openThreads],
    ['Next steps', h.nextSteps], ['Files touched', h.filesTouched],
  ];
  const body = sections.filter(([, v]) => v.trim()).map(([t, v]) => `### ${t}\n${v.trim()}`).join('\n\n');
  return `## Last handoff (${who}, ${when}, ${h.device}${branch})\n${body}`;
}

export interface ContextInput {
  store: MemoryStore;
  slug: string;
  capTokens: number;
}

const byAge = (a: Fact, b: Fact) => a.created.localeCompare(b.created) || a.name.localeCompare(b.name);
const byName = (a: Fact, b: Fact) => a.name.localeCompare(b.name);

export async function buildContext(input: ContextInput): Promise<string> {
  const { store, slug, capTokens } = input;
  const handoff = await latestHandoff(store, slug);
  const globalFacts = await listFacts(store, GLOBAL);
  const projectFacts = await listFacts(store, project(slug));
  const pinned = [...globalFacts, ...projectFacts].filter((f) => f.pinned);
  let gLines = globalFacts.filter((f) => !f.pinned).sort(byAge);
  let pLines = projectFacts.filter((f) => !f.pinned).sort(byAge);
  let omitted = 0;

  const render = (): string => {
    const parts = ['# hearthkit memory', ''];
    parts.push(handoff ? renderHandoff(handoff) : '## Last handoff\nNo handoff yet for this project.', '');
    parts.push(`## Global memory (${globalFacts.length} facts)`);
    parts.push(...(gLines.length ? [...gLines].sort(byName).map(indexLine) : ['(none yet)']), '');
    parts.push(`## Project memory: projects/${slug} (${projectFacts.length} facts)`);
    parts.push(...(pLines.length ? [...pLines].sort(byName).map(indexLine) : ['(none yet)']), '');
    if (pinned.length) {
      parts.push('## Pinned facts');
      for (const f of pinned) parts.push(`### ${f.name}`, f.body, '');
    }
    if (omitted) parts.push(`(omitted ${omitted} older memory lines to fit the context cap; use memory_search to find them)`, '');
    parts.push(
      '## Tools',
      'Memory tools (MCP server "hearth"): memory_search, memory_read, memory_write, memory_list, memory_promote, memory_handoff.',
      `Write to layer "global" for things true in any repo, "projects/${slug}" for this codebase. If a project fact turns out to be general, call memory_promote.`,
      'Before you finish, or when the user says they are stopping, call memory_handoff with what you were working on, decisions, open threads, next steps, and files touched.',
    );
    return `${parts.join('\n')}\n`;
  };

  let text = render();
  while (estimateTokens(text) > capTokens && (pLines.length > 0 || gLines.length > 0)) {
    if (pLines.length > 0) pLines = pLines.slice(1);
    else gLines = gLines.slice(1);
    omitted++;
    text = render();
  }
  return text;
}
```

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx vitest run test/context.test.ts && npx tsc --noEmit`

```bash
git add -A
git commit -m "feat: build capped session-start context with handoff first"
```

---

### Task 12: Keyword search

**Files:**
- Create: `src/core/search.ts`
- Test: `test/search.test.ts`

**Interfaces:**
- Produces: `interface SearchHit {layer, kind: 'fact'|'handoff', name, description, score, created}`, `terms(query): string[]`, `scoreText(terms, name, description, body): number`, `search(store, query, slug: string|null, limit=10): Promise<SearchHit[]>`.

Scoring per term: +3 in name, +2 in description, +1 per body occurrence up to 5. Sort by score desc, then created desc, then name.

- [ ] **Step 1: Write failing tests**

`test/search.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import { writeHandoff } from '../src/core/handoff.js';
import { writeFact } from '../src/core/memory.js';
import { scoreText, search, terms } from '../src/core/search.js';
import { FileStore } from '../src/core/store.js';
import { GLOBAL, project } from '../src/core/types.js';
import { mkTmpDir } from './helpers/tmp.js';

describe('search', () => {
  const tmp = mkTmpDir();
  afterEach(() => tmp.cleanup());

  it('tokenises queries', () => {
    expect(terms('HubSpot import, 429s!')).toEqual(['hubspot', 'import', '429s']);
    expect(terms('a')).toEqual([]);
  });

  it('scores name > description > body and caps body hits', () => {
    expect(scoreText(['pnpm'], 'pnpm', '', '')).toBe(3);
    expect(scoreText(['pnpm'], '', 'use pnpm', '')).toBe(2);
    expect(scoreText(['pnpm'], '', '', 'pnpm '.repeat(20))).toBe(5);
  });

  it('searches global plus the current project, includes handoffs, ranks by score then recency', async () => {
    const store = new FileStore(tmp.dir);
    await writeFact(store, { layer: GLOBAL, text: 'Corey prefers tables.', name: 'tables', device: 'mac', now: new Date('2026-01-01') });
    await writeFact(store, { layer: project('acme'), text: 'HubSpot import retries on 429 with backoff.', name: 'hubspot-retry', device: 'mac', now: new Date('2026-09-01') });
    await writeFact(store, { layer: project('acme'), text: 'The HubSpot portal id is 123.', name: 'portal', device: 'mac', now: new Date('2026-09-02') });
    await writeFact(store, { layer: project('other'), text: 'HubSpot elsewhere', name: 'elsewhere', device: 'mac' });
    await writeHandoff(store, { slug: 'acme', device: 'mac', source: 'agent', session: '', branch: '', workingOn: 'Debugging HubSpot 429 handling', now: new Date('2026-09-05T10:00:00Z') });
    const hits = await search(store, 'hubspot', 'acme');
    expect(hits.map((h) => h.name)).toEqual(['hubspot-retry', 'portal', '2026-09-05-1000-mac']);
    expect(hits[0]?.layer).toBe('projects/acme');
    expect(hits[2]?.kind).toBe('handoff');
    expect(hits.some((h) => h.name === 'elsewhere')).toBe(false);
    expect(await search(store, 'tables', null)).toHaveLength(1);
    expect(await search(store, '', 'acme')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/search.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement search.ts**

```ts
import { listHandoffs } from './handoff.js';
import { firstLine, listFacts } from './memory.js';
import type { MemoryStore } from './store.js';
import { GLOBAL, layerId, project, type LayerRef } from './types.js';

export interface SearchHit {
  layer: string;
  kind: 'fact' | 'handoff';
  name: string;
  description: string;
  score: number;
  created: string;
}

export function terms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2))];
}

export function scoreText(ts: string[], name: string, description: string, body: string): number {
  const n = name.toLowerCase();
  const d = description.toLowerCase();
  const b = body.toLowerCase();
  let score = 0;
  for (const t of ts) {
    if (n.includes(t)) score += 3;
    if (d.includes(t)) score += 2;
    score += Math.min(b.split(t).length - 1, 5);
  }
  return score;
}

export async function search(store: MemoryStore, query: string, slug: string | null, limit = 10): Promise<SearchHit[]> {
  const ts = terms(query);
  if (ts.length === 0) return [];
  const layers: LayerRef[] = slug ? [GLOBAL, project(slug)] : [GLOBAL];
  const hits: SearchHit[] = [];
  for (const layer of layers) {
    for (const f of await listFacts(store, layer)) {
      const score = scoreText(ts, f.name, f.description, f.body);
      if (score > 0) hits.push({ layer: layerId(layer), kind: 'fact', name: f.name, description: f.description, score, created: f.created });
    }
  }
  if (slug) {
    for (const h of await listHandoffs(store, slug)) {
      const text = [h.workingOn, h.decisions, h.openThreads, h.nextSteps, h.filesTouched].join('\n');
      const score = scoreText(ts, h.id, '', text);
      if (score > 0) {
        hits.push({ layer: layerId(project(slug)), kind: 'handoff', name: h.id, description: firstLine(h.workingOn), score, created: h.timestamp.slice(0, 10) });
      }
    }
  }
  return hits
    .sort((a, b) => b.score - a.score || b.created.localeCompare(a.created) || a.name.localeCompare(b.name))
    .slice(0, limit);
}
```

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx vitest run test/search.test.ts && npx tsc --noEmit`

```bash
git add -A
git commit -m "feat: keyword search across memory layers and handoffs"
```

---
### Task 13: Git sync with memory-aware conflict handling

**Files:**
- Create: `src/core/sync.ts`, `test/helpers/gitrepo.ts`
- Test: `test/sync.test.ts`

**Interfaces:**
- Consumes: `Exec`, `currentBranch`, `regenerateIndex`, `pruneAllHandoffs`, `FileStore`, `INDEX_FILE`.
- Produces: `interface SyncResult {committed, pulled, pushed, conflicts: string[], pruned: string[], error: string|null}`, `interface SyncOptions {device, now?, log?}`, `syncRepo(exec, store: FileStore, opts): Promise<SyncResult>`; test helpers `makeBareRemote(dir)`, `cloneWithIdentity(remote, dest, name)`.

Git facts this relies on: during `git rebase`, `--ours` is the upstream (the branch being rebased onto) and index stage `:3:` is the commit being replayed (this device's version). Conflicted paths come from `git diff --name-only --diff-filter=U`.

- [ ] **Step 1: Create the git test helper**

`test/helpers/gitrepo.ts`:
```ts
import { join } from 'node:path';
import { RealExec } from '../../src/core/exec.js';

const exec = new RealExec();

export async function makeBareRemote(dir: string): Promise<string> {
  const bare = join(dir, 'remote.git');
  await exec.run('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  return bare;
}

export async function cloneWithIdentity(remote: string, dest: string, name: string): Promise<void> {
  await exec.run('git', ['clone', '-q', remote, dest]);
  await exec.run('git', ['config', 'user.name', name], { cwd: dest });
  await exec.run('git', ['config', 'user.email', `${name}@example.com`], { cwd: dest });
  await exec.run('git', ['checkout', '-q', '-B', 'main'], { cwd: dest });
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await exec.run('git', args, { cwd });
  return r.stdout;
}
```

- [ ] **Step 2: Write failing tests**

`test/sync.test.ts`:
```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RealExec } from '../src/core/exec.js';
import { listHandoffs, writeHandoff } from '../src/core/handoff.js';
import { writeFact } from '../src/core/memory.js';
import { FileStore } from '../src/core/store.js';
import { syncRepo } from '../src/core/sync.js';
import { GLOBAL } from '../src/core/types.js';
import { cloneWithIdentity, git, makeBareRemote } from './helpers/gitrepo.js';
import { mkTmpDir } from './helpers/tmp.js';

describe('syncRepo', () => {
  const tmp = mkTmpDir();
  afterEach(() => tmp.cleanup());
  const exec = new RealExec();

  async function twoDevices() {
    const remote = await makeBareRemote(tmp.dir);
    const a = join(tmp.dir, 'a');
    const b = join(tmp.dir, 'b');
    await cloneWithIdentity(remote, a, 'a');
    await cloneWithIdentity(remote, b, 'b');
    return { remote, a: new FileStore(a), b: new FileStore(b) };
  }

  it('pushes the first commit and the other device receives it', async () => {
    const { a, b } = await twoDevices();
    await writeFact(a, { layer: GLOBAL, text: 'from a', name: 'from-a', device: 'a' });
    const ra = await syncRepo(exec, a, { device: 'a' });
    expect(ra).toMatchObject({ committed: true, pushed: true, conflicts: [], error: null });
    const rb = await syncRepo(exec, b, { device: 'b' });
    expect(rb.pulled).toBe(true);
    expect(await b.readFact(GLOBAL, 'from-a')).toContain('from a');
  });

  it('two devices adding different facts merge cleanly', async () => {
    const { a, b } = await twoDevices();
    await writeFact(a, { layer: GLOBAL, text: 'x', name: 'x', device: 'a' });
    await syncRepo(exec, a, { device: 'a' });
    await writeFact(b, { layer: GLOBAL, text: 'y', name: 'y', device: 'b' });
    const rb = await syncRepo(exec, b, { device: 'b' });
    expect(rb).toMatchObject({ pulled: true, pushed: true, conflicts: [], error: null });
    await syncRepo(exec, a, { device: 'a' });
    expect(await a.listFacts(GLOBAL)).toEqual(['x', 'y']);
    expect(await a.readIndex(GLOBAL)).toContain('- y:');
    expect(await b.readIndex(GLOBAL)).toContain('- x:');
  });

  it('editing the same fact on both devices keeps both copies and flags the conflict', async () => {
    const { a, b } = await twoDevices();
    await writeFact(a, { layer: GLOBAL, text: 'original', name: 'shared', device: 'a' });
    await syncRepo(exec, a, { device: 'a' });
    await syncRepo(exec, b, { device: 'b' });
    await writeFact(a, { layer: GLOBAL, text: 'A version', name: 'shared', device: 'a' });
    await syncRepo(exec, a, { device: 'a' });
    await writeFact(b, { layer: GLOBAL, text: 'B version', name: 'shared', device: 'b' });
    const rb = await syncRepo(exec, b, { device: 'b' });
    expect(rb.error).toBeNull();
    expect(rb.conflicts).toEqual(['global/shared.md']);
    expect(await b.readFact(GLOBAL, 'shared')).toContain('A version');
    expect(await b.readFact(GLOBAL, 'shared.conflict-b')).toContain('B version');
    expect(await b.readIndex(GLOBAL)).toContain('(conflict copy)');
    expect(rb.pushed).toBe(true);
    await syncRepo(exec, a, { device: 'a' });
    expect(existsSync(join(a.root, 'global', 'shared.conflict-b.md'))).toBe(true);
  });

  it('keeps the local commit and reports an error when the remote is unreachable', async () => {
    const { a } = await twoDevices();
    await exec.run('git', ['remote', 'set-url', 'origin', join(tmp.dir, 'missing.git')], { cwd: a.root });
    await writeFact(a, { layer: GLOBAL, text: 'offline', name: 'offline', device: 'a' });
    const r = await syncRepo(exec, a, { device: 'a' });
    expect(r.committed).toBe(true);
    expect(r.pushed).toBe(false);
    expect(r.error).toMatch(/fetch failed/);
    expect(await git(a.root, 'log', '--oneline')).toContain('hearth: a');
  });

  it('prunes old handoffs during sync and the other device sees the removal', async () => {
    const { a, b } = await twoDevices();
    const old = await writeHandoff(a, { slug: 'acme', device: 'a', source: 'auto', session: '', branch: '', workingOn: 'old', now: new Date('2026-01-01T00:00:00Z') });
    const fresh = await writeHandoff(a, { slug: 'acme', device: 'a', source: 'auto', session: '', branch: '', workingOn: 'new', now: new Date('2026-09-01T00:00:00Z') });
    const ra = await syncRepo(exec, a, { device: 'a', now: new Date('2026-09-06T00:00:00Z') });
    expect(ra.pruned).toEqual([old.id]);
    await syncRepo(exec, b, { device: 'b' });
    expect((await listHandoffs(b, 'acme')).map((h) => h.id)).toEqual([fresh.id]);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/sync.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement sync.ts**

```ts
import { writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Exec, ExecResult } from './exec.js';
import { currentBranch } from './git.js';
import { pruneAllHandoffs } from './handoff.js';
import { regenerateIndex } from './memory.js';
import { INDEX_FILE, type FileStore } from './store.js';

export interface SyncResult {
  committed: boolean;
  pulled: boolean;
  pushed: boolean;
  conflicts: string[];
  pruned: string[];
  error: string | null;
}

export interface SyncOptions {
  device: string;
  now?: Date;
  log?: (msg: string) => void;
}

type Git = (...args: string[]) => Promise<ExecResult>;

const GIT_ENV = { GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' };

export async function syncRepo(exec: Exec, store: FileStore, opts: SyncOptions): Promise<SyncResult> {
  const cwd = store.root;
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => undefined);
  const result: SyncResult = { committed: false, pulled: false, pushed: false, conflicts: [], pruned: [], error: null };
  const git: Git = (...args) => exec.run('git', args, { cwd, env: GIT_ENV });

  result.committed = await commitAll(git, `hearth: ${opts.device} ${now.toISOString()}`);
  const branch = (await currentBranch(exec, cwd)) ?? 'main';

  const fetch = await git('fetch', '-q', 'origin');
  if (fetch.code !== 0) {
    result.error = `fetch failed: ${fetch.stderr.trim() || 'is the network up?'}`;
    log(result.error);
    return result;
  }

  const hasLocal = (await git('rev-parse', '--verify', '-q', 'HEAD')).code === 0;
  const hasRemote = (await git('rev-parse', '--verify', '-q', `origin/${branch}`)).code === 0;

  if (hasRemote && !hasLocal) {
    const reset = await git('reset', '-q', '--hard', `origin/${branch}`);
    if (reset.code !== 0) {
      result.error = `could not check out origin/${branch}: ${reset.stderr.trim()}`;
      return result;
    }
    result.pulled = true;
  } else if (hasRemote && hasLocal) {
    let r = await git('rebase', `origin/${branch}`);
    for (let guard = 0; r.code !== 0 && guard < 100; guard++) {
      const conflicted = (await git('diff', '--name-only', '--diff-filter=U')).stdout
        .split('\n').map((s) => s.trim()).filter(Boolean);
      if (conflicted.length === 0) {
        await git('rebase', '--abort');
        result.error = `rebase failed: ${r.stderr.trim()}`;
        return result;
      }
      for (const file of conflicted) await resolveConflict(git, cwd, file, opts.device, result);
      await git('add', '-A');
      r = await git('rebase', '--continue');
    }
    if (r.code !== 0) {
      await git('rebase', '--abort');
      result.error = 'rebase did not finish; local changes kept, nothing pushed';
      return result;
    }
    result.pulled = true;
  }

  for (const layer of await store.listLayers()) await regenerateIndex(store, layer);
  result.pruned = await pruneAllHandoffs(store, now);
  await commitAll(git, `hearth: post-sync maintenance (${opts.device})`);

  if ((await git('rev-parse', '--verify', '-q', 'HEAD')).code !== 0) return result; // nothing to push yet
  const push = await git('push', '-q', '-u', 'origin', `HEAD:${branch}`);
  if (push.code !== 0) {
    result.error = `push failed: ${push.stderr.trim()}`;
    log(result.error);
    return result;
  }
  result.pushed = true;
  return result;
}

async function commitAll(git: Git, message: string): Promise<boolean> {
  await git('add', '-A');
  const staged = await git('diff', '--cached', '--quiet');
  if (staged.code === 0) return false;
  const c = await git('commit', '-q', '-m', message);
  return c.code === 0;
}

async function resolveConflict(git: Git, cwd: string, file: string, device: string, result: SyncResult): Promise<void> {
  const base = basename(file);
  if (base !== INDEX_FILE && base.endsWith('.md')) {
    const local = await git('show', `:3:${file}`);
    if (local.code === 0) {
      const copy = join(cwd, dirname(file), `${base.slice(0, -3)}.conflict-${device}.md`);
      await writeFile(copy, local.stdout, 'utf8');
    }
    result.conflicts.push(file);
  }
  // Upstream keeps the original name; indexes are regenerated after the rebase.
  const keepUpstream = await git('checkout', '--ours', '--', file);
  if (keepUpstream.code !== 0) await git('checkout', '--theirs', '--', file);
}
```

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `npx vitest run test/sync.test.ts && npx tsc --noEmit`
Expected: PASS. If the conflict test fails because the conflict copy file is missing, print `git status` inside the loop to confirm `:3:` resolves during the rebase, and check that `--diff-filter=U` returned `global/shared.md`.

```bash
git add -A
git commit -m "feat: git sync with keep-both conflict handling and handoff pruning"
```

---

### Task 14: Init: create or connect the private memory repo

**Files:**
- Create: `src/core/init.ts`
- Test: `test/init.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `saveConfig`, `defaultConfig`, `isGitRepo`, `remoteUrl`, `currentBranch`, `parseOwnerRepo`, `HearthError`.
- Produces: `interface InitOptions {remote?, allowPublic?, repoName?}`, `interface InitResult {memoryDir, remote, createdRepo, clonedNow, pushed}`, `initMemory(exec, home, opts, log?): Promise<InitResult>`.

Behaviour: existing clone → reuse. `--remote` → `git clone`. Neither → `gh repo create <name> --private`, then `gh repo clone`. Refuse a public GitHub repo unless `allowPublic`. Ensure `global/.gitkeep`, `projects/.gitkeep`, `README.md`; commit; push; save config with the remote.

- [ ] **Step 1: Write failing tests**

`test/init.test.ts`:
```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/core/config.js';
import { FakeExec, RealExec } from '../src/core/exec.js';
import { initMemory } from '../src/core/init.js';
import { git, makeBareRemote } from './helpers/gitrepo.js';
import { mkTmpDir } from './helpers/tmp.js';

describe('initMemory', () => {
  const tmp = mkTmpDir();
  afterEach(() => tmp.cleanup());

  it('clones a given remote, creates the structure, pushes, saves config, and is idempotent', async () => {
    const remote = await makeBareRemote(tmp.dir);
    const home = join(tmp.dir, 'home');
    const exec = new RealExec();
    const logs: string[] = [];
    const r = await initMemory(exec, home, { remote }, (m) => logs.push(m));
    expect(r.clonedNow).toBe(true);
    expect(r.pushed).toBe(true);
    expect(existsSync(join(r.memoryDir, 'global', '.gitkeep'))).toBe(true);
    expect(existsSync(join(r.memoryDir, 'projects', '.gitkeep'))).toBe(true);
    expect(existsSync(join(r.memoryDir, 'README.md'))).toBe(true);
    expect((await loadConfig(home))?.remote).toBe(remote);
    expect(await git(remote, 'log', '--oneline')).toContain('hearth: initialise memory repo');
    const again = await initMemory(exec, home, {}, (m) => logs.push(m));
    expect(again.clonedNow).toBe(false);
    expect(again.remote).toBe(remote);
  });

  it('creates a private GitHub repo through gh when no remote is given', async () => {
    const home = join(tmp.dir, 'home2');
    const fake = new FakeExec()
      .on('git', [], { code: 0 })
      .on('git', ['rev-parse', '--is-inside-work-tree'], { code: 128 })
      .on('gh', ['auth', 'status'], { code: 0 })
      .on('gh', ['repo', 'create'], { stdout: 'https://github.com/corey/hearth-memory\n' })
      .on('gh', ['repo', 'view', 'hearth-memory', '--json', 'nameWithOwner'], { stdout: 'corey/hearth-memory\n' })
      .on('gh', ['repo', 'clone'], { code: 0 })
      .on('git', ['remote', 'get-url', 'origin'], { stdout: 'https://github.com/corey/hearth-memory.git\n' })
      .on('gh', ['repo', 'view', 'corey/hearth-memory', '--json', 'visibility'], { stdout: 'PRIVATE\n' });
    const r = await initMemory(fake, home, {});
    expect(r.createdRepo).toBe(true);
    expect(r.remote).toBe('https://github.com/corey/hearth-memory.git');
    expect(fake.calls.some((c) => c.cmd === 'gh' && c.args.join(' ').startsWith('repo create hearth-memory --private'))).toBe(true);
    expect((await loadConfig(home))?.remote).toBe('https://github.com/corey/hearth-memory.git');
  });

  it('refuses a public GitHub repo unless allowed', async () => {
    const home = join(tmp.dir, 'home3');
    const fake = new FakeExec()
      .on('git', [], { code: 0 })
      .on('git', ['rev-parse', '--is-inside-work-tree'], { code: 128 })
      .on('gh', ['repo', 'view', 'acme/notes', '--json', 'visibility'], { stdout: 'PUBLIC\n' });
    await expect(initMemory(fake, home, { remote: 'https://github.com/acme/notes.git' })).rejects.toThrow(/is PUBLIC/);
    await expect(initMemory(fake, home, { remote: 'https://github.com/acme/notes.git', allowPublic: true })).resolves.toBeTruthy();
  });

  it('explains what to do when gh is missing or logged out', async () => {
    const home = join(tmp.dir, 'home4');
    const missing = new FakeExec().on('git', ['rev-parse', '--is-inside-work-tree'], { code: 128 }).on('gh', ['auth', 'status'], { code: 127 });
    await expect(initMemory(missing, home, {})).rejects.toMatchObject({ exitCode: 2, message: expect.stringMatching(/brew install gh|--remote/) });
    const loggedOut = new FakeExec().on('git', ['rev-parse', '--is-inside-work-tree'], { code: 128 }).on('gh', ['auth', 'status'], { code: 1 });
    await expect(initMemory(loggedOut, home, {})).rejects.toThrow(/gh auth login/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/init.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement init.ts**

```ts
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defaultConfig, loadConfig, saveConfig, type Config } from './config.js';
import type { Exec } from './exec.js';
import { currentBranch, isGitRepo, parseOwnerRepo, remoteUrl } from './git.js';
import { HearthError } from './types.js';

export interface InitOptions {
  remote?: string;
  allowPublic?: boolean;
  repoName?: string;
}

export interface InitResult {
  memoryDir: string;
  remote: string;
  createdRepo: boolean;
  clonedNow: boolean;
  pushed: boolean;
}

const README = `# hearth memory

Private memory for [hearthkit](https://github.com/c0reyx/hearthkit). One person, one repo.

- \`global/\` — facts true in any project
- \`projects/<slug>/\` — facts about one codebase, plus \`handoffs/\`

One fact per file. \`MEMORY.md\` files are generated; do not edit them by hand.
`;

export async function initMemory(
  exec: Exec,
  home: string,
  opts: InitOptions,
  log: (msg: string) => void = () => undefined,
): Promise<InitResult> {
  const cfg: Config = (await loadConfig(home)) ?? defaultConfig(home);
  const memoryDir = cfg.memoryDir;
  await mkdir(dirname(memoryDir), { recursive: true });
  const env = { GIT_TERMINAL_PROMPT: '0' };
  let createdRepo = false;
  let clonedNow = false;
  let remote: string;

  if (await isGitRepo(exec, memoryDir)) {
    const existing = await remoteUrl(exec, memoryDir);
    if (!existing) {
      throw new HearthError(`${memoryDir} is a git repo without an "origin" remote.\nAdd one: git -C ${memoryDir} remote add origin <url>`, 2);
    }
    remote = existing;
    log(`Using the existing memory repo at ${memoryDir}`);
  } else if (opts.remote) {
    const clone = await exec.run('git', ['clone', '-q', opts.remote, memoryDir], { env });
    if (clone.code !== 0) {
      throw new HearthError(`Could not clone ${opts.remote}: ${clone.stderr.trim()}\nCheck the URL and that this machine can authenticate to it.`, 2);
    }
    remote = opts.remote;
    clonedNow = true;
    log(`Cloned ${opts.remote} to ${memoryDir}`);
  } else {
    const auth = await exec.run('gh', ['auth', 'status']);
    if (auth.code === 127) {
      throw new HearthError(
        'GitHub CLI (gh) is not installed, so hearth cannot create a repo for you.\nEither install it (brew install gh; gh auth login) or create a private repo yourself and run: hearth init --remote <url>',
        2,
      );
    }
    if (auth.code !== 0) throw new HearthError('GitHub CLI is not logged in. Run: gh auth login   then re-run hearth init', 2);
    const name = opts.repoName ?? 'hearth-memory';
    const create = await exec.run('gh', ['repo', 'create', name, '--private', '--description', 'hearthkit memory (private, one person)']);
    if (create.code !== 0 && !/already exists/i.test(create.stderr)) {
      throw new HearthError(`gh repo create failed: ${create.stderr.trim()}`, 2);
    }
    createdRepo = create.code === 0;
    const view = await exec.run('gh', ['repo', 'view', name, '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
    if (view.code !== 0) throw new HearthError(`Could not look up ${name} on GitHub: ${view.stderr.trim()}`, 2);
    const nameWithOwner = view.stdout.trim();
    const clone = await exec.run('gh', ['repo', 'clone', nameWithOwner, memoryDir]);
    if (clone.code !== 0) throw new HearthError(`Could not clone ${nameWithOwner}: ${clone.stderr.trim()}`, 2);
    clonedNow = true;
    remote = (await remoteUrl(exec, memoryDir)) ?? `https://github.com/${nameWithOwner}.git`;
    log(`${createdRepo ? 'Created' : 'Found'} ${nameWithOwner} and cloned it to ${memoryDir}`);
  }

  await assertPrivate(exec, remote, opts.allowPublic === true);
  await ensureStructure(memoryDir);

  const git = (...args: string[]) => exec.run('git', args, { cwd: memoryDir, env });
  const branch = await currentBranch(exec, memoryDir);
  if (!branch || branch === 'HEAD') await git('checkout', '-q', '-B', 'main');
  await git('add', '-A');
  if ((await git('diff', '--cached', '--quiet')).code !== 0) await git('commit', '-q', '-m', 'hearth: initialise memory repo');
  const push = await git('push', '-q', '-u', 'origin', 'HEAD');
  if (push.code !== 0) log(`Warning: could not push yet (${push.stderr.trim() || 'no details'}). hearth sync will retry.`);

  await saveConfig(home, { ...cfg, remote });
  return { memoryDir, remote, createdRepo, clonedNow, pushed: push.code === 0 };
}

async function assertPrivate(exec: Exec, remote: string, allowPublic: boolean): Promise<void> {
  if (allowPublic || !/github\.com/i.test(remote)) return;
  const parsed = parseOwnerRepo(remote);
  if (!parsed) return;
  const r = await exec.run('gh', ['repo', 'view', `${parsed.owner}/${parsed.repo}`, '--json', 'visibility', '--jq', '.visibility']);
  if (r.code !== 0) return; // gh missing or offline: cannot verify here; doctor will report
  const vis = r.stdout.trim().toUpperCase();
  if (vis && vis !== 'PRIVATE') {
    throw new HearthError(
      `${parsed.owner}/${parsed.repo} is ${vis}. Memory must be private.\nMake it private in the GitHub repo settings, or pass --allow-public if you really mean it.`,
    );
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureStructure(dir: string): Promise<void> {
  for (const rel of ['global/.gitkeep', 'projects/.gitkeep']) {
    const p = join(dir, rel);
    if (!(await exists(p))) {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, '', 'utf8');
    }
  }
  const readme = join(dir, 'README.md');
  if (!(await exists(readme))) await writeFile(readme, README, 'utf8');
}
```

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx vitest run test/init.test.ts && npx tsc --noEmit`
Expected: PASS. Note the FakeExec catch-all rule `.on('git', [], {code: 0})` is listed first so specific rules added later override it (last match wins).

```bash
git add -A
git commit -m "feat: hearth init creates or connects the private memory repo"
```

---

### Task 15: Doctor

**Files:**
- Create: `src/core/doctor.ts`
- Test: `test/doctor.test.ts`

**Interfaces:**
- Produces: `type CheckStatus = 'ok'|'fail'|'warn'|'skip'`, `interface Check {id, title, status, detail, fix: string|null}`, `interface DoctorDeps {exec, home, nodeVersion?, online?}`, `runDoctor(deps): Promise<Check[]>`, `renderChecks(checks): string`, `doctorExitCode(checks): 0|2`.

Check ids in order: `node`, `git`, `claude`, `gh`, `config`, `repo`, `remote`, `pending`, `conflicts`. `config` failing stops the list (nothing below it can be checked).

- [ ] **Step 1: Write failing tests**

`test/doctor.test.ts`:
```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, saveConfig } from '../src/core/config.js';
import { doctorExitCode, renderChecks, runDoctor } from '../src/core/doctor.js';
import { FakeExec } from '../src/core/exec.js';
import { mkTmpDir } from './helpers/tmp.js';

function healthyExec(): FakeExec {
  return new FakeExec()
    .on('git', ['--version'], { stdout: 'git version 2.50.0\n' })
    .on('claude', ['--version'], { stdout: '2.1.0 (Claude Code)\n' })
    .on('gh', ['auth', 'status'], { code: 0 })
    .on('git', ['rev-parse', '--is-inside-work-tree'], { stdout: 'true\n' })
    .on('git', ['remote', 'get-url', 'origin'], { stdout: 'git@github.com:c/m.git\n' })
    .on('git', ['ls-remote'], { code: 0 })
    .on('git', ['status', '--porcelain'], { stdout: '' })
    .on('git', ['rev-list', '--count'], { stdout: '0\n' });
}

describe('runDoctor', () => {
  const tmp = mkTmpDir();
  afterEach(() => tmp.cleanup());

  it('is all green on a healthy machine', async () => {
    await saveConfig(tmp.dir, defaultConfig(tmp.dir));
    const checks = await runDoctor({ exec: healthyExec(), home: tmp.dir, nodeVersion: 'v22.1.0' });
    expect(checks.map((c) => c.id)).toEqual(['node', 'git', 'claude', 'gh', 'config', 'repo', 'remote', 'pending', 'conflicts']);
    expect(checks.every((c) => c.status === 'ok')).toBe(true);
    expect(doctorExitCode(checks)).toBe(0);
  });

  it('stops after a missing config and tells the user to run init', async () => {
    const checks = await runDoctor({ exec: healthyExec(), home: tmp.dir, nodeVersion: 'v22.1.0' });
    expect(checks.at(-1)).toMatchObject({ id: 'config', status: 'fail', fix: expect.stringContaining('hearth init') });
    expect(doctorExitCode(checks)).toBe(2);
  });

  it('flags old node, missing claude, and gh states with fixes', async () => {
    const exec = healthyExec().on('claude', ['--version'], { code: 127 }).on('gh', ['auth', 'status'], { code: 127 });
    const checks = await runDoctor({ exec, home: tmp.dir, nodeVersion: 'v18.20.0' });
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId.node).toMatchObject({ status: 'fail', fix: expect.stringContaining('nodejs.org') });
    expect(byId.claude).toMatchObject({ status: 'fail', fix: expect.stringContaining('Install Claude Code') });
    expect(byId.gh).toMatchObject({ status: 'warn', fix: expect.stringContaining('brew install gh') });
  });

  it('warns on unsynced changes and conflict copies; skips the network check offline', async () => {
    const cfg = defaultConfig(tmp.dir);
    await saveConfig(tmp.dir, cfg);
    mkdirSync(join(cfg.memoryDir, 'global'), { recursive: true });
    writeFileSync(join(cfg.memoryDir, 'global', 'x.md'), '---\nname: x\n---\n');
    writeFileSync(join(cfg.memoryDir, 'global', 'x.conflict-laptop.md'), '---\nname: x\n---\n');
    const exec = healthyExec().on('git', ['status', '--porcelain'], { stdout: ' M global/x.md\n' }).on('git', ['rev-list', '--count'], { stdout: '2\n' });
    const checks = await runDoctor({ exec, home: tmp.dir, nodeVersion: 'v22.0.0', online: false });
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId.remote?.status).toBe('skip');
    expect(byId.pending).toMatchObject({ status: 'warn', detail: expect.stringContaining('2 unpushed'), fix: 'Run: hearth sync' });
    expect(byId.conflicts).toMatchObject({ status: 'warn', detail: expect.stringContaining('global/x.conflict-laptop') });
    expect(renderChecks(checks)).toContain('fix: Run: hearth sync');
    expect(doctorExitCode(checks)).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/doctor.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement doctor.ts**

```ts
import { loadConfig } from './config.js';
import type { Exec } from './exec.js';
import { isGitRepo, remoteUrl } from './git.js';
import { FileStore } from './store.js';
import { layerId } from './types.js';

export type CheckStatus = 'ok' | 'fail' | 'warn' | 'skip';

export interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  fix: string | null;
}

export interface DoctorDeps {
  exec: Exec;
  home: string;
  nodeVersion?: string;
  online?: boolean;
}

const mk = (status: CheckStatus) => (id: string, title: string, detail: string, fix: string | null = null): Check => ({ id, title, status, detail, fix });
const ok = mk('ok');
const fail = mk('fail');
const warn = mk('warn');
const skip = mk('skip');

export async function runDoctor(deps: DoctorDeps): Promise<Check[]> {
  const { exec, home } = deps;
  const checks: Check[] = [];

  const nodeVersion = deps.nodeVersion ?? process.version;
  const major = Number(nodeVersion.replace(/^v/, '').split('.')[0]);
  checks.push(major >= 20
    ? ok('node', 'Node.js', nodeVersion)
    : fail('node', 'Node.js', `${nodeVersion} is too old`, 'Install Node 20 or newer from https://nodejs.org (Homebrew: brew install node)'));

  const git = await exec.run('git', ['--version']);
  checks.push(git.code === 0
    ? ok('git', 'git', git.stdout.trim())
    : fail('git', 'git', 'not found', 'Install git (macOS: xcode-select --install, or brew install git)'));

  const claude = await exec.run('claude', ['--version']);
  checks.push(claude.code === 0
    ? ok('claude', 'Claude Code', claude.stdout.trim())
    : fail('claude', 'Claude Code', 'not found on PATH', 'Install Claude Code: https://docs.claude.com/en/docs/claude-code/setup'));

  const gh = await exec.run('gh', ['auth', 'status']);
  if (gh.code === 0) checks.push(ok('gh', 'GitHub CLI', 'installed and logged in'));
  else if (gh.code === 127) checks.push(warn('gh', 'GitHub CLI', 'not installed (optional)', 'Only needed so hearth init can create the memory repo for you: brew install gh && gh auth login. Or run: hearth init --remote <url>'));
  else checks.push(warn('gh', 'GitHub CLI', 'installed but not logged in', 'Run: gh auth login'));

  const cfg = await loadConfig(home);
  if (!cfg) {
    checks.push(fail('config', 'hearthkit config', `no config.json in ${home}`, 'Run: hearth init   (or /hearth:setup inside Claude Code)'));
    return checks;
  }
  checks.push(ok('config', 'hearthkit config', `${home}/config.json (device: ${cfg.device})`));

  const repoOk = await isGitRepo(exec, cfg.memoryDir);
  const remote = repoOk ? await remoteUrl(exec, cfg.memoryDir) : null;
  if (!repoOk || !remote) {
    checks.push(fail('repo', 'memory repo', repoOk ? `${cfg.memoryDir} has no origin remote` : `${cfg.memoryDir} is not a git repo`, 'Run: hearth init'));
    return checks;
  }
  checks.push(ok('repo', 'memory repo', `${cfg.memoryDir} → ${remote}`));

  if (deps.online === false) {
    checks.push(skip('remote', 'remote reachable', 'skipped (offline)'));
  } else {
    const ls = await exec.run('git', ['ls-remote', '--exit-code', '-q', 'origin', 'HEAD'], { cwd: cfg.memoryDir, env: { GIT_TERMINAL_PROMPT: '0' } });
    checks.push(ls.code === 0
      ? ok('remote', 'remote reachable', remote)
      : fail('remote', 'remote reachable', ls.stderr.trim() || 'could not reach origin', `Check your network and git credentials, then: git -C ${cfg.memoryDir} fetch`));
  }

  const status = await exec.run('git', ['status', '--porcelain'], { cwd: cfg.memoryDir });
  const ahead = await exec.run('git', ['rev-list', '--count', '@{u}..HEAD'], { cwd: cfg.memoryDir });
  const dirty = status.stdout.trim().length > 0;
  const unpushed = ahead.code === 0 ? Number(ahead.stdout.trim()) : 0;
  if (dirty || unpushed > 0) {
    const parts = [dirty ? 'uncommitted files' : '', unpushed > 0 ? `${unpushed} unpushed commit${unpushed === 1 ? '' : 's'}` : ''].filter(Boolean);
    checks.push(warn('pending', 'unsynced changes', parts.join(' and '), 'Run: hearth sync'));
  } else {
    checks.push(ok('pending', 'unsynced changes', 'none'));
  }

  const store = new FileStore(cfg.memoryDir);
  const conflicts: string[] = [];
  for (const layer of await store.listLayers()) {
    for (const name of await store.listFacts(layer)) if (name.includes('.conflict-')) conflicts.push(`${layerId(layer)}/${name}`);
  }
  checks.push(conflicts.length
    ? warn('conflicts', 'conflicting memory copies', conflicts.join(', '), 'Compare each pair with hearth memory show, then delete the one you do not want: hearth memory delete <layer> <name>')
    : ok('conflicts', 'conflicting memory copies', 'none'));

  return checks;
}

export function renderChecks(checks: Check[]): string {
  const icon: Record<CheckStatus, string> = { ok: '✔', fail: '✘', warn: '!', skip: '-' };
  return `${checks.map((c) => `${icon[c.status]} ${c.title}: ${c.detail}${c.fix ? `\n    fix: ${c.fix}` : ''}`).join('\n')}\n`;
}

export function doctorExitCode(checks: Check[]): 0 | 2 {
  return checks.some((c) => c.status === 'fail') ? 2 : 0;
}
```

- [ ] **Step 4: Run tests, typecheck, commit**

Run: `npx vitest run test/doctor.test.ts && npx tsc --noEmit`

```bash
git add -A
git commit -m "feat: hearth doctor with plain-language fixes"
```

---

### Task 16: Where everything lives, and the log file

**Files:**
- Create: `src/core/where.ts`, `src/core/log.ts`
- Test: `test/where.test.ts`, `test/log.test.ts`

**Interfaces:**
- Produces: `interface Location {label, path, exists, owner: 'hearthkit'|'Claude Code'|'npm', note}`, `interface WhereDeps {home, cwd, exec, claudeHome?, pluginRoot?, execPath?}`, `claudeProjectDir(claudeHome, cwd)`, `whereAll(deps): Promise<{slug, locations}>`, `renderWhere(result): string`, `appendLog(home, entry): Promise<void>`.

- [ ] **Step 1: Write failing tests**

`test/where.test.ts`:
```ts
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, saveConfig } from '../src/core/config.js';
import { FakeExec } from '../src/core/exec.js';
import { claudeProjectDir, renderWhere, whereAll } from '../src/core/where.js';
import { mkTmpDir } from './helpers/tmp.js';

describe('where', () => {
  const tmp = mkTmpDir();
  afterEach(() => tmp.cleanup());

  it('maps Claude Code project folders the way Claude Code names them', () => {
    expect(claudeProjectDir('/Users/c/.claude', '/Users/c/Projects/hearthkit')).toBe('/Users/c/.claude/projects/-Users-c-Projects-hearthkit');
    expect(claudeProjectDir('/Users/c/.claude', '/Users/c/.chef')).toBe('/Users/c/.claude/projects/-Users-c--chef');
  });

  it('lists every location with existence, owner, and the project slug', async () => {
    await saveConfig(tmp.dir, { ...defaultConfig(tmp.dir), remote: 'git@github.com:c/m.git' });
    const exec = new FakeExec().on('git', ['remote', 'get-url', 'origin'], { stdout: 'git@github.com:acme/crm.git\n' });
    const w = await whereAll({ home: tmp.dir, cwd: '/repo', exec, claudeHome: join(tmp.dir, 'claude'), pluginRoot: '/plugins/hearthkit' });
    expect(w.slug).toBe('acme-crm');
    const byLabel = Object.fromEntries(w.locations.map((l) => [l.label, l]));
    expect(byLabel.config).toMatchObject({ path: join(tmp.dir, 'config.json'), exists: true, owner: 'hearthkit' });
    expect(byLabel['memory repo (local clone)']).toMatchObject({ exists: false, note: 'syncs with git@github.com:c/m.git' });
    expect(byLabel['this project layer']?.path).toBe(join(tmp.dir, 'memory', 'projects', 'acme-crm'));
    expect(byLabel['plugin (bundled CLI + MCP server)']?.path).toBe('/plugins/hearthkit');
    expect(byLabel['Claude Code transcripts for this folder']?.path).toBe(join(tmp.dir, 'claude', 'projects', '-repo'));
    const text = renderWhere(w);
    expect(text).toContain('project slug: acme-crm');
    expect(text).toContain('✔ config');
  });
});
```

`test/log.test.ts`:
```ts
import { readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendLog } from '../src/core/log.js';
import { mkTmpDir } from './helpers/tmp.js';

describe('appendLog', () => {
  const tmp = mkTmpDir();
  afterEach(() => tmp.cleanup());

  it('appends one JSON line with a timestamp', async () => {
    await appendLog(tmp.dir, { command: 'x', ok: true });
    const lines = readFileSync(join(tmp.dir, 'logs', 'hearth.log'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ command: 'x', ok: true, time: expect.stringMatching(/^\d{4}-/) });
  });

  it('rotates when the file passes 1 MB', async () => {
    mkdirSync(join(tmp.dir, 'logs'), { recursive: true });
    writeFileSync(join(tmp.dir, 'logs', 'hearth.log'), 'x'.repeat(1_000_001));
    await appendLog(tmp.dir, { command: 'y' });
    expect(existsSync(join(tmp.dir, 'logs', 'hearth.log.1'))).toBe(true);
    expect(statSync(join(tmp.dir, 'logs', 'hearth.log')).size).toBeLessThan(1000);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/where.test.ts test/log.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement where.ts**

```ts
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import type { Exec } from './exec.js';
import { projectSlug } from './project.js';

export interface Location {
  label: string;
  path: string;
  exists: boolean;
  owner: 'hearthkit' | 'Claude Code' | 'npm';
  note: string;
}

export interface WhereDeps {
  home: string;
  cwd: string;
  exec: Exec;
  claudeHome?: string;
  pluginRoot?: string | null;
  execPath?: string;
}

export interface WhereResult {
  slug: string;
  locations: Location[];
}

export function claudeProjectDir(claudeHome: string, cwd: string): string {
  return join(claudeHome, 'projects', cwd.replace(/[/.]/g, '-'));
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function whereAll(deps: WhereDeps): Promise<WhereResult> {
  const claudeHome = deps.claudeHome ?? join(homedir(), '.claude');
  const cfg = await loadConfig(deps.home);
  const slug = await projectSlug(deps.exec, deps.cwd);
  const memoryDir = cfg?.memoryDir ?? join(deps.home, 'memory');
  const items: Omit<Location, 'exists'>[] = [
    { label: 'config', path: join(deps.home, 'config.json'), owner: 'hearthkit', note: 'repo location, device name, context cap' },
    { label: 'memory repo (local clone)', path: memoryDir, owner: 'hearthkit', note: cfg?.remote ? `syncs with ${cfg.remote}` : 'not set up yet (hearth init)' },
    { label: 'this project layer', path: join(memoryDir, 'projects', slug), owner: 'hearthkit', note: 'facts and handoffs for the current folder' },
    { label: 'logs', path: join(deps.home, 'logs', 'hearth.log'), owner: 'hearthkit', note: 'hook, sync, and MCP logs (no transcript text)' },
    { label: 'plugin (bundled CLI + MCP server)', path: deps.pluginRoot ?? '(not running inside the plugin)', owner: 'Claude Code', note: 'dist/hearth.js and dist/mcp.js live here' },
    { label: 'Claude Code settings', path: join(claudeHome, 'settings.json'), owner: 'Claude Code', note: 'marketplace and plugin registration' },
    { label: 'Claude Code plugins', path: join(claudeHome, 'plugins'), owner: 'Claude Code', note: 'installed plugin copies' },
    { label: 'Claude Code transcripts for this folder', path: claudeProjectDir(claudeHome, deps.cwd), owner: 'Claude Code', note: 'read by handoff capture, never written' },
    { label: 'hearth CLI (this process)', path: deps.execPath ?? process.argv[1] ?? '', owner: 'npm', note: 'the entry point that is running now' },
  ];
  const locations: Location[] = [];
  for (const it of items) locations.push({ ...it, exists: await exists(it.path) });
  return { slug, locations };
}

export function renderWhere(w: WhereResult): string {
  const lines = [`project slug: ${w.slug}`, ''];
  for (const l of w.locations) {
    lines.push(`${l.exists ? '✔' : '·'} ${l.label}`, `    ${l.path}`, `    ${l.owner} — ${l.note}`);
  }
  return `${lines.join('\n')}\n`;
}
```

- [ ] **Step 4: Implement log.ts**

```ts
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_BYTES = 1_000_000;

export async function appendLog(home: string, entry: Record<string, unknown>): Promise<void> {
  const dir = join(home, 'logs');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'hearth.log');
  try {
    if ((await stat(file)).size > MAX_BYTES) await rename(file, `${file}.1`);
  } catch {
    // no file yet
  }
  await appendFile(file, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, 'utf8');
}
```

- [ ] **Step 5: Run tests, typecheck, commit**

Run: `npx vitest run test/where.test.ts test/log.test.ts && npx tsc --noEmit`

```bash
git add -A
git commit -m "feat: hearth where location map and rotating log"
```

---

### Task 17: Build script and the CLI (all non-hook commands)

**Files:**
- Create: `scripts/build.mjs`, `src/cli/program.ts`, `src/cli/index.ts`
- Test: `test/cli.test.ts`

**Interfaces:**
- Produces: `interface CliDeps {exec, home, cwd, env, stdout, stderr, readStdin, spawnDetached, now?}`, `buildProgram(deps): Command`, `runCli(program, argv, stderr): Promise<number>`, `resolveLayer(arg, deps)`, `openStore(deps)`. Built artefacts `dist/hearth.js` (and `dist/mcp.js` once Task 19 adds the entry).

Layer argument grammar for every CLI command: `global`, `project` (current folder), `project:<slug>`, or `projects/<slug>`.

- [ ] **Step 1: Create scripts/build.mjs**

```js
import { existsSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

const shim = "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);";
const entries = [
  { entry: 'src/cli/index.ts', out: 'dist/hearth.js', shebang: true },
  { entry: 'src/mcp/index.ts', out: 'dist/mcp.js', shebang: false },
];

await mkdir('dist', { recursive: true });
for (const e of entries) {
  if (!existsSync(e.entry)) continue;
  await build({
    entryPoints: [e.entry],
    outfile: e.out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    banner: { js: `${e.shebang ? '#!/usr/bin/env node\n' : ''}${shim}` },
    logLevel: 'error',
  });
  if (e.shebang) await chmod(e.out, 0o755);
}
```

- [ ] **Step 2: Write the failing CLI test**

`test/cli.test.ts`:
```ts
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RealExec } from '../src/core/exec.js';
import { makeBareRemote } from './helpers/gitrepo.js';
import { mkTmpDir } from './helpers/tmp.js';

const BIN = join(process.cwd(), 'dist', 'hearth.js');

function hearth(args: string[], opts: { home: string; cwd?: string; input?: string }) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, HEARTH_HOME: opts.home, HEARTH_NO_BACKGROUND_SYNC: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

describe('hearth CLI (end to end against a local bare remote)', () => {
  const tmp = mkTmpDir();
  const home = join(tmp.dir, 'home');
  const crm = join(tmp.dir, 'crm');
  let remote = '';
  const exec = new RealExec();

  beforeAll(async () => {
    remote = await makeBareRemote(tmp.dir);
    await exec.run('git', ['init', '-q', crm]);
    await exec.run('git', ['remote', 'add', 'origin', 'git@github.com:acme/crm.git'], { cwd: crm });
  });
  afterAll(() => tmp.cleanup());

  it('where works before setup; list explains how to set up', async () => {
    const w = await hearth(['where'], { home, cwd: crm });
    expect(w.code).toBe(0);
    expect(w.stdout).toContain('project slug: acme-crm');
    expect(w.stdout).toContain('· config');
    const l = await hearth(['list'], { home });
    expect(l.code).toBe(2);
    expect(l.stderr).toContain('hearth init');
  });

  it('init with --remote clones and configures', async () => {
    const r = await hearth(['init', '--remote', remote], { home });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Pushed the initial commit.');
    expect(existsSync(join(home, 'config.json'))).toBe(true);
    expect(existsSync(join(home, 'memory', 'global', '.gitkeep'))).toBe(true);
  });

  it('memory add/show/search/promote and handoff write/list', async () => {
    let r = await hearth(['memory', 'add', 'global', 'Corey prefers tables.', '--type', 'user'], { home });
    expect(r.stdout).toContain('Saved global/corey-prefers-tables.md');
    r = await hearth(['memory', 'add', 'project', 'Use pnpm in this repo.', '--name', 'pnpm', '--pin'], { home, cwd: crm });
    expect(r.stdout).toContain('Saved projects/acme-crm/pnpm.md');
    r = await hearth(['memory', 'show', 'global', 'corey-prefers-tables'], { home });
    expect(r.stdout).toContain('type: user');
    r = await hearth(['memory', 'search', 'pnpm'], { home, cwd: crm });
    expect(r.stdout).toContain('projects/acme-crm/pnpm');
    r = await hearth(['memory', 'promote', 'pnpm'], { home, cwd: crm });
    expect(r.stdout).toContain('Promoted pnpm from projects/acme-crm to global.');
    expect((await hearth(['memory', 'show', 'global', 'pnpm'], { home })).code).toBe(0);
    r = await hearth(['handoff', 'write', '--working-on', 'Retry logic for 429s', '--next-steps', 'test with 500 rows'], { home, cwd: crm });
    expect(r.stdout).toContain('Wrote handoff projects/acme-crm/handoffs/');
    r = await hearth(['handoff', 'list'], { home, cwd: crm });
    expect(r.stdout).toContain('agent');
    expect(r.stdout).toContain('Retry logic for 429s');
    r = await hearth(['list'], { home });
    expect(r.stdout).toMatch(/global\s+2 facts/);
    expect(r.stdout).toMatch(/projects\/acme-crm\s+0 facts\s+1 handoffs/);
  });

  it('sync pushes to the remote and doctor reports config and repo ok', async () => {
    const s = await hearth(['sync'], { home });
    expect(s.code, s.stderr).toBe(0);
    expect(s.stdout).toContain('Synced.');
    const log = await exec.run('git', ['log', '--oneline'], { cwd: remote });
    expect(log.stdout).toMatch(/hearth: /);
    const d = await hearth(['doctor', '--offline', '--json'], { home });
    const checks = JSON.parse(d.stdout) as { id: string; status: string }[];
    const byId = Object.fromEntries(checks.map((c) => [c.id, c.status]));
    expect(byId.config).toBe('ok');
    expect(byId.repo).toBe('ok');
    expect(byId.pending).toBe('ok');
    expect([0, 2]).toContain(d.code); // 2 only when claude/git are absent on this machine
  });

  it('bad input is a user error with a helpful message', async () => {
    const r = await hearth(['memory', 'add', 'bogus', 'x'], { home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Unknown layer "bogus"');
    const t = await hearth(['memory', 'add', 'global', 'x', '--type', 'nope'], { home });
    expect(t.code).toBe(1);
    expect(t.stderr).toContain('Unknown type');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run test/cli.test.ts`
Expected: FAIL (globalSetup builds nothing yet because `src/cli/index.ts` does not exist; `dist/hearth.js` missing → spawn error code 1).

- [ ] **Step 4: Implement src/cli/program.ts**

```ts
import { Command } from 'commander';
import { requireConfig, type Config } from '../core/config.js';
import { doctorExitCode, renderChecks, runDoctor } from '../core/doctor.js';
import type { Exec } from '../core/exec.js';
import { currentBranch } from '../core/git.js';
import { listHandoffs, writeHandoff } from '../core/handoff.js';
import { initMemory } from '../core/init.js';
import { deleteFact, listFacts, promoteFact, writeFact } from '../core/memory.js';
import { projectSlug } from '../core/project.js';
import { search } from '../core/search.js';
import { FileStore } from '../core/store.js';
import { syncRepo } from '../core/sync.js';
import { FACT_TYPES, HearthError, layerId, parseLayerId, project, type FactType, type LayerRef } from '../core/types.js';
import { renderWhere, whereAll } from '../core/where.js';

export interface CliDeps {
  exec: Exec;
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  readStdin: () => Promise<string>;
  spawnDetached: (args: string[]) => void;
  now?: () => Date;
}

export async function openStore(deps: CliDeps): Promise<{ cfg: Config; store: FileStore }> {
  const cfg = await requireConfig(deps.home);
  return { cfg, store: new FileStore(cfg.memoryDir) };
}

export async function resolveLayer(arg: string, deps: CliDeps): Promise<LayerRef> {
  if (arg === 'project') return project(await projectSlug(deps.exec, deps.cwd));
  if (arg.startsWith('project:')) return parseLayerId(`projects/${arg.slice('project:'.length)}`);
  return parseLayerId(arg);
}

function factType(v: string | undefined): FactType | undefined {
  if (v === undefined) return undefined;
  if ((FACT_TYPES as readonly string[]).includes(v)) return v as FactType;
  throw new HearthError(`Unknown type "${v}". Use one of: ${FACT_TYPES.join(', ')}`);
}

const LAYER_HELP = 'global | project (current folder) | project:<slug> | projects/<slug>';

export function buildProgram(deps: CliDeps): Command {
  const out = deps.stdout;
  const now = () => deps.now?.() ?? new Date();
  const program = new Command()
    .name('hearth')
    .description('Git-synced memory and session handoffs for Claude Code')
    .exitOverride()
    .configureOutput({ writeOut: deps.stdout, writeErr: deps.stderr });

  program
    .command('init')
    .description('Create or connect the private memory repo and write config')
    .option('--remote <url>', 'existing private git remote to use instead of creating one on GitHub')
    .option('--allow-public', 'allow a public remote (not recommended)')
    .option('--repo-name <name>', 'name for the GitHub repo hearth creates', 'hearth-memory')
    .action(async (o: { remote?: string; allowPublic?: boolean; repoName: string }) => {
      const r = await initMemory(deps.exec, deps.home, { remote: o.remote, allowPublic: o.allowPublic, repoName: o.repoName }, (m) => out(`${m}\n`));
      out(`Memory repo: ${r.memoryDir}\nRemote:      ${r.remote}\n${r.pushed ? 'Pushed the initial commit.' : 'Not pushed yet; hearth sync will retry.'}\nNext: start a Claude Code session, or run: hearth doctor\n`);
    });

  program
    .command('doctor')
    .description('Check this machine and the memory repo; print fixes')
    .option('--json', 'machine-readable output')
    .option('--offline', 'skip the network check')
    .action(async (o: { json?: boolean; offline?: boolean }) => {
      const checks = await runDoctor({ exec: deps.exec, home: deps.home, online: o.offline ? false : undefined });
      out(o.json ? `${JSON.stringify(checks, null, 2)}\n` : renderChecks(checks));
      if (doctorExitCode(checks) !== 0) throw new HearthError('', 2);
    });

  program.command('where').description('Show where everything lives').action(async () => {
    const w = await whereAll({ home: deps.home, cwd: deps.cwd, exec: deps.exec, pluginRoot: deps.env.CLAUDE_PLUGIN_ROOT ?? null, execPath: process.argv[1] });
    out(renderWhere(w));
  });

  program.command('list').description('Layers, fact counts, handoffs, conflicts').action(async () => {
    const { store } = await openStore(deps);
    const lines: string[] = [];
    for (const layer of await store.listLayers()) {
      const facts = await listFacts(store, layer);
      const conflicts = facts.filter((f) => f.name.includes('.conflict-')).length;
      const handoffs = layer.kind === 'project' ? (await store.listHandoffs(layer.slug)).length : null;
      lines.push(
        `${layerId(layer).padEnd(40)} ${String(facts.length).padStart(3)} facts` +
          (handoffs === null ? '' : `  ${String(handoffs).padStart(3)} handoffs`) +
          (conflicts ? `  ! ${conflicts} conflict cop${conflicts === 1 ? 'y' : 'ies'}` : ''),
      );
    }
    out(lines.length ? `${lines.join('\n')}\n` : 'No memory yet. Start a Claude Code session, or run: hearth memory add global "..."\n');
  });

  program
    .command('sync')
    .description('Pull, merge, and push the memory repo')
    .option('--quiet', 'print nothing unless there is an error')
    .action(async (o: { quiet?: boolean }) => {
      const { cfg, store } = await openStore(deps);
      const r = await syncRepo(deps.exec, store, { device: cfg.device, now: now() });
      if (r.error) {
        throw new HearthError(`Sync incomplete: ${r.error}${r.committed ? '\nYour changes are committed locally and will push next time.' : ''}`, 2);
      }
      if (o.quiet) return;
      const bits = [r.committed ? 'Committed local changes.' : '', r.pulled ? 'Pulled.' : '', r.pushed ? 'Pushed.' : 'Nothing to push.'].filter(Boolean);
      const extra = [
        r.conflicts.length ? `Conflicts kept as extra copies: ${r.conflicts.join(', ')}. Run hearth doctor to review them.` : '',
        r.pruned.length ? `Pruned ${r.pruned.length} old handoff(s).` : '',
      ].filter(Boolean);
      out(`Synced. ${bits.join(' ')}${extra.length ? `\n${extra.join('\n')}` : ''}\n`);
    });

  const memory = program.command('memory').description('Work with facts');

  memory
    .command('add <layer> <text>')
    .description(`Add a fact. <layer>: ${LAYER_HELP}`)
    .option('--name <name>', 'kebab-case id (derived from the text if omitted)')
    .option('--type <type>', FACT_TYPES.join('|'))
    .option('--pin', 'include the full fact in every session start')
    .action(async (layerArg: string, text: string, o: { name?: string; type?: string; pin?: boolean }) => {
      const { cfg, store } = await openStore(deps);
      const layer = await resolveLayer(layerArg, deps);
      const f = await writeFact(store, { layer, text, name: o.name, type: factType(o.type), pinned: o.pin ? true : undefined, device: cfg.device, now: now() });
      out(`Saved ${layerId(layer)}/${f.name}.md\n`);
    });

  memory
    .command('search <query>')
    .option('--project <slug>', 'search a specific project layer instead of the current folder')
    .action(async (query: string, o: { project?: string }) => {
      const { store } = await openStore(deps);
      const slug = o.project ?? (await projectSlug(deps.exec, deps.cwd));
      const hits = await search(store, query, slug);
      out(hits.length ? `${hits.map((h) => `${h.layer}/${h.name}  (${h.kind}, score ${h.score})\n    ${h.description}`).join('\n')}\n` : 'No matches.\n');
    });

  memory.command('show <layer> <name>').description(`Print one fact. <layer>: ${LAYER_HELP}`).action(async (layerArg: string, name: string) => {
    const { store } = await openStore(deps);
    const layer = await resolveLayer(layerArg, deps);
    const raw = await store.readFact(layer, name);
    if (raw === null) throw new HearthError(`No fact "${name}" in ${layerId(layer)}.`);
    out(raw.endsWith('\n') ? raw : `${raw}\n`);
  });

  memory.command('delete <layer> <name>').description('Delete one fact (used to clear conflict copies)').action(async (layerArg: string, name: string) => {
    const { store } = await openStore(deps);
    const layer = await resolveLayer(layerArg, deps);
    if (!(await deleteFact(store, layer, name))) throw new HearthError(`No fact "${name}" in ${layerId(layer)}.`);
    out(`Deleted ${layerId(layer)}/${name}.md\n`);
  });

  memory
    .command('promote <name>')
    .description('Move a fact from a project layer to global')
    .option('--from <layer>', 'project or project:<slug>', 'project')
    .action(async (name: string, o: { from: string }) => {
      const { store } = await openStore(deps);
      const from = await resolveLayer(o.from, deps);
      await promoteFact(store, name, from);
      out(`Promoted ${name} from ${layerId(from)} to global.\n`);
    });

  const handoff = program.command('handoff').description('Project handoffs');

  handoff
    .command('write')
    .description('Write a handoff for the current project')
    .requiredOption('--working-on <text>', 'what was in progress')
    .option('--decisions <text>')
    .option('--open-threads <text>')
    .option('--next-steps <text>')
    .option('--files-touched <text>')
    .action(async (o: { workingOn: string; decisions?: string; openThreads?: string; nextSteps?: string; filesTouched?: string }) => {
      const { cfg, store } = await openStore(deps);
      const slug = await projectSlug(deps.exec, deps.cwd);
      const h = await writeHandoff(store, {
        slug, device: cfg.device, source: 'agent', session: '', branch: (await currentBranch(deps.exec, deps.cwd)) ?? '',
        workingOn: o.workingOn, decisions: o.decisions, openThreads: o.openThreads, nextSteps: o.nextSteps, filesTouched: o.filesTouched, now: now(),
      });
      out(`Wrote handoff projects/${slug}/handoffs/${h.id}.md\n`);
    });

  handoff.command('list [project]').description('List handoffs, newest first').action(async (slugArg?: string) => {
    const { store } = await openStore(deps);
    const slug = slugArg ?? (await projectSlug(deps.exec, deps.cwd));
    const all = await listHandoffs(store, slug);
    out(all.length ? `${all.map((h) => `${h.id}  ${h.source}  ${h.timestamp}\n    ${h.workingOn.split('\n')[0] ?? ''}`).join('\n')}\n` : `No handoffs for ${slug}.\n`);
  });

  handoff.command('delete <id> [project]').description('Delete one handoff').action(async (id: string, slugArg?: string) => {
    const { store } = await openStore(deps);
    const slug = slugArg ?? (await projectSlug(deps.exec, deps.cwd));
    if (!(await store.deleteHandoff(slug, id))) throw new HearthError(`No handoff ${id} in ${slug}.`);
    out(`Deleted handoff ${id}.\n`);
  });

  return program;
}

export async function runCli(program: Command, argv: string[], stderr: (s: string) => void): Promise<number> {
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    if (err instanceof HearthError) {
      if (err.message) stderr(`${err.message}\n`);
      return err.exitCode;
    }
    const e = err as { code?: string; exitCode?: number; message?: string };
    if (typeof e.code === 'string' && e.code.startsWith('commander.')) return e.exitCode ?? 1; // help, version, usage errors already printed
    stderr(`Unexpected error: ${e.message ?? String(err)}\n`);
    return 1;
  }
}
```

- [ ] **Step 5: Implement src/cli/index.ts**

```ts
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hearthHome } from '../core/config.js';
import { RealExec } from '../core/exec.js';
import { buildProgram, runCli } from './program.js';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function spawnDetached(args: string[]): void {
  if (process.env.HEARTH_NO_BACKGROUND_SYNC) return;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
}

const program = buildProgram({
  exec: new RealExec(),
  home: hearthHome(),
  cwd: process.cwd(),
  env: process.env,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  readStdin,
  spawnDetached,
});

process.exitCode = await runCli(program, process.argv, (s) => process.stderr.write(s));
```

- [ ] **Step 6: Build, run the CLI tests, typecheck, commit**

Run: `npm run build && npx vitest run test/cli.test.ts && npx tsc --noEmit`
Expected: PASS. If `dist/hearth.js` fails at startup with a `require is not defined` error from gray-matter's dependencies, confirm the esbuild banner shim in `scripts/build.mjs` is present.

```bash
git add -A
git commit -m "feat: hearth CLI with init, doctor, where, list, sync, memory, and handoff commands"
```

---

### Task 18: Hook commands: `memory context` and `handoff capture`

**Files:**
- Modify: `src/cli/program.ts`
- Test: `test/cli.test.ts` (append a describe block)

**Interfaces:**
- Consumes: `buildContext`, `captureHandoff`, `HookPayload`, `appendLog`, `loadConfig`.
- Produces: `parsePayload(raw): HookPayload`; commands `hearth memory context` and `hearth handoff capture`, both reading the hook JSON from stdin and always exiting 0.

- [ ] **Step 1: Write failing tests** (append to `test/cli.test.ts`; the `hearth` helper, `home`, and `crm` from the earlier block are reused, so place this inside the same top-level `describe` after the existing `it` blocks)

```ts
  it('memory context prints a setup hint when not configured, and the context block when configured', async () => {
    const fresh = join(tmp.dir, 'fresh-home');
    const hint = await hearth(['memory', 'context'], { home: fresh, input: JSON.stringify({ cwd: crm }) });
    expect(hint.code).toBe(0);
    expect(hint.stdout).toContain('/hearth:setup');
    const ctx = await hearth(['memory', 'context'], { home, input: JSON.stringify({ cwd: crm, hook_event_name: 'SessionStart' }) });
    expect(ctx.code).toBe(0);
    expect(ctx.stdout.startsWith('# hearthkit memory')).toBe(true);
    expect(ctx.stdout).toContain('Retry logic for 429s');
    expect(ctx.stdout).toContain('"projects/acme-crm"');
  });

  it('handoff capture stores an automatic handoff from a transcript and never fails the hook', async () => {
    const transcript = join(process.cwd(), 'test', 'fixtures', 'transcripts', 'normal.jsonl');
    const r = await hearth(['handoff', 'capture'], { home, input: JSON.stringify({ session_id: 'sess-1', transcript_path: transcript, cwd: crm, hook_event_name: 'SessionEnd' }) });
    expect(r.code).toBe(0);
    const list = await hearth(['handoff', 'list'], { home, cwd: crm });
    expect(list.stdout).toContain('auto');
    expect(list.stdout).not.toContain('SECRET_FILE_CONTENTS');
    const log = readFileSync(join(home, 'logs', 'hearth.log'), 'utf8');
    expect(log).toContain('"command":"handoff capture"');
    const bad = await hearth(['handoff', 'capture'], { home, input: 'not json at all' });
    expect(bad.code).toBe(0);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run build && npx vitest run test/cli.test.ts`
Expected: FAIL, "unknown command 'context'".

- [ ] **Step 3: Implement** (edit `src/cli/program.ts`)

Add imports:
```ts
import { loadConfig } from '../core/config.js';
import { buildContext } from '../core/context.js';
import { captureHandoff, type HookPayload } from '../core/handoff.js';
import { appendLog } from '../core/log.js';
```

Add these helpers above `buildProgram`:
```ts
export function parsePayload(raw: string): HookPayload {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'object' && v !== null ? (v as HookPayload) : {};
  } catch {
    return {};
  }
}

// Hook commands must never break a Claude Code session: swallow errors into the log and exit 0.
async function hookSafe(deps: CliDeps, command: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    await appendLog(deps.home, { command, error: err instanceof Error ? err.message : String(err) }).catch(() => undefined);
  }
}
```

Add inside `buildProgram`, after the other `memory` subcommands:
```ts
  memory
    .command('context')
    .description('Print the session-start context block (used by the SessionStart hook; reads hook JSON on stdin)')
    .action(() => hookSafe(deps, 'memory context', async () => {
      const payload = parsePayload(await deps.readStdin());
      const cwd = payload.cwd ?? deps.cwd;
      const cfg = await loadConfig(deps.home);
      if (!cfg) {
        out('hearthkit is installed but not set up on this machine yet. Run /hearth:setup to connect your memory repo.\n');
        return;
      }
      const store = new FileStore(cfg.memoryDir);
      const slug = await projectSlug(deps.exec, cwd);
      out(await buildContext({ store, slug, capTokens: cfg.contextCapTokens }));
    }));
```

And after the other `handoff` subcommands:
```ts
  handoff
    .command('capture')
    .description('Capture an automatic handoff from the SessionEnd hook payload on stdin, then sync in the background')
    .action(() => hookSafe(deps, 'handoff capture', async () => {
      const payload = parsePayload(await deps.readStdin());
      const cfg = await loadConfig(deps.home);
      if (!cfg) return;
      const store = new FileStore(cfg.memoryDir);
      const h = await captureHandoff(payload, { store, exec: deps.exec, device: cfg.device, now: now() });
      await appendLog(deps.home, { command: 'handoff capture', session: payload.session_id ?? null, wrote: h?.id ?? null });
      deps.spawnDetached(['sync', '--quiet']);
    }));
```

- [ ] **Step 4: Build, run all tests, typecheck, commit**

Run: `npm run build && npx vitest run && npx tsc --noEmit`
Expected: all PASS.

```bash
git add -A
git commit -m "feat: SessionStart context and SessionEnd capture hook commands"
```

---
### Task 19: MCP server

**Files:**
- Create: `src/mcp/server.ts`, `src/mcp/index.ts`
- Test: `test/mcp.test.ts`

**Interfaces:**
- Consumes: everything in `core/` plus `@modelcontextprotocol/sdk` (`McpServer`, `StdioServerTransport`) and `zod`.
- Produces: `interface McpDeps {exec, home, cwd, now?}`, `createMcpServer(deps): McpServer` registering nine tools: `memory_search`, `memory_list`, `memory_read`, `memory_write`, `memory_promote`, `memory_handoff`, `hearth_doctor`, `hearth_init`, `hearth_sync`. Entry `dist/mcp.js` speaks stdio.

The three `hearth_*` tools exist so `/hearth:setup` and `/hearth:sync` never depend on shell path expansion inside command markdown; the agent calls tools instead.

- [ ] **Step 1: Write failing tests**

`test/mcp.test.ts`:
```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, saveConfig } from '../src/core/config.js';
import { FakeExec } from '../src/core/exec.js';
import { FileStore } from '../src/core/store.js';
import { createMcpServer } from '../src/mcp/server.js';
import { mkTmpDir } from './helpers/tmp.js';

const EXPECTED_TOOLS = [
  'hearth_doctor', 'hearth_init', 'hearth_sync',
  'memory_handoff', 'memory_list', 'memory_promote', 'memory_read', 'memory_search', 'memory_write',
];

function textOf(result: unknown): string {
  const r = result as { content: { type: string; text?: string }[]; isError?: boolean };
  return r.content.map((c) => c.text ?? '').join('\n');
}

describe('MCP server', () => {
  const tmp = mkTmpDir();
  afterEach(() => tmp.cleanup());

  async function connected() {
    const home = join(tmp.dir, 'home');
    await saveConfig(home, { ...defaultConfig(home), device: 'mac' });
    const exec = new FakeExec()
      .on('git', ['remote', 'get-url', 'origin'], { stdout: 'git@github.com:acme/crm.git\n' })
      .on('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdout: 'main\n' });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ exec, home, cwd: '/repo', now: () => new Date('2026-09-06T15:30:00Z') });
    await server.connect(serverT);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientT);
    return { client, home, store: new FileStore(join(home, 'memory')) };
  }

  it('lists the nine tools', async () => {
    const { client } = await connected();
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(EXPECTED_TOOLS);
  });

  it('write, list, read, search, promote, handoff round trip', async () => {
    const { client } = await connected();
    let r = await client.callTool({ name: 'memory_write', arguments: { layer: 'global', text: 'Corey prefers tables.', type: 'user' } });
    expect(textOf(r)).toBe('Saved global/corey-prefers-tables.md');
    r = await client.callTool({ name: 'memory_write', arguments: { layer: 'project', text: 'Use pnpm here.', name: 'pnpm', pinned: true } });
    expect(textOf(r)).toBe('Saved projects/acme-crm/pnpm.md');
    expect(textOf(await client.callTool({ name: 'memory_list', arguments: { layer: 'project' } }))).toContain('- pnpm: Use pnpm here. [reference, pinned]');
    expect(textOf(await client.callTool({ name: 'memory_read', arguments: { layer: 'global', name: 'corey-prefers-tables' } }))).toContain('type: user');
    expect(textOf(await client.callTool({ name: 'memory_search', arguments: { query: 'pnpm' } }))).toContain('projects/acme-crm/pnpm');
    expect(textOf(await client.callTool({ name: 'memory_promote', arguments: { name: 'pnpm' } }))).toBe('Promoted pnpm to global.');
    r = await client.callTool({ name: 'memory_handoff', arguments: { working_on: 'Retry logic', next_steps: 'test 429s' } });
    expect(textOf(r)).toBe('Wrote handoff projects/acme-crm/handoffs/2026-09-06-1530-mac.md');
  });

  it('returns isError results with the HearthError message instead of throwing', async () => {
    const { client } = await connected();
    const r = (await client.callTool({ name: 'memory_read', arguments: { layer: 'global', name: 'nope' } })) as { isError?: boolean };
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('No fact "nope" in global.');
  });

  it('hearth_doctor returns the checks as JSON', async () => {
    const { client } = await connected();
    const checks = JSON.parse(textOf(await client.callTool({ name: 'hearth_doctor', arguments: {} }))) as { id: string }[];
    expect(checks.map((c) => c.id)).toContain('config');
  });

  it('dist/mcp.js speaks MCP over stdio', async () => {
    const home = join(tmp.dir, 'home-stdio');
    await saveConfig(home, defaultConfig(home));
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'dist', 'mcp.js')], env: { ...process.env, HEARTH_HOME: home } as Record<string, string> });
    const client = new Client({ name: 'smoke', version: '0.0.0' });
    await client.connect(transport);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    await client.close();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/mcp.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement src/mcp/server.ts**

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requireConfig } from '../core/config.js';
import { runDoctor } from '../core/doctor.js';
import type { Exec } from '../core/exec.js';
import { currentBranch } from '../core/git.js';
import { writeHandoff } from '../core/handoff.js';
import { initMemory } from '../core/init.js';
import { listFacts, promoteFact, renderIndex, writeFact } from '../core/memory.js';
import { projectSlug } from '../core/project.js';
import { search } from '../core/search.js';
import { FileStore } from '../core/store.js';
import { syncRepo } from '../core/sync.js';
import { HearthError, layerId, parseLayerId, project, type LayerRef } from '../core/types.js';

export interface McpDeps {
  exec: Exec;
  home: string;
  cwd: string;
  now?: () => Date;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

async function guarded(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: await fn() }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

const LAYER_DESC =
  'Layer: "global" for facts true in any repo (who the user is, preferences, environment), "project" for the current codebase, or "projects/<slug>" for a specific one.';

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'hearth', version: '0.1.0' });
  const now = () => deps.now?.() ?? new Date();

  const open = async () => {
    const cfg = await requireConfig(deps.home);
    return { cfg, store: new FileStore(cfg.memoryDir), slug: await projectSlug(deps.exec, deps.cwd) };
  };
  const layerOf = (layer: string, slug: string): LayerRef => (layer === 'project' ? project(slug) : parseLayerId(layer));

  server.registerTool(
    'memory_search',
    {
      description: 'Search hearthkit memory (global and current-project facts and handoffs) by keywords. Use it before asking the user something they may have told you before.',
      inputSchema: { query: z.string().describe('keywords to look for') },
    },
    ({ query }) => guarded(async () => {
      const { store, slug } = await open();
      const hits = await search(store, query, slug);
      return hits.length ? hits.map((h) => `${h.layer}/${h.name} (${h.kind}, score ${h.score}): ${h.description}`).join('\n') : 'No matches.';
    }),
  );

  server.registerTool(
    'memory_list',
    { description: `List the facts in one memory layer. ${LAYER_DESC}`, inputSchema: { layer: z.string() } },
    ({ layer }) => guarded(async () => {
      const { store, slug } = await open();
      const l = layerOf(layer, slug);
      return renderIndex(l, await listFacts(store, l));
    }),
  );

  server.registerTool(
    'memory_read',
    { description: `Read one fact in full. ${LAYER_DESC}`, inputSchema: { layer: z.string(), name: z.string() } },
    ({ layer, name }) => guarded(async () => {
      const { store, slug } = await open();
      const l = layerOf(layer, slug);
      const raw = await store.readFact(l, name);
      if (raw === null) throw new HearthError(`No fact "${name}" in ${layerId(l)}.`);
      return raw;
    }),
  );

  server.registerTool(
    'memory_write',
    {
      description: `Save a durable fact worth remembering in future sessions (not task chatter). ${LAYER_DESC} Rule of thumb: if it would still be true in a different repo, it belongs in "global".`,
      inputSchema: {
        layer: z.string(),
        text: z.string().describe('the fact, one to three sentences'),
        name: z.string().optional().describe('kebab-case id; derived from the text if omitted'),
        type: z.enum(['user', 'feedback', 'project', 'reference']).optional(),
        pinned: z.boolean().optional().describe('true to include the full text at every session start; use sparingly'),
      },
    },
    ({ layer, text, name, type, pinned }) => guarded(async () => {
      const { cfg, store, slug } = await open();
      const l = layerOf(layer, slug);
      const f = await writeFact(store, { layer: l, text, name, type, pinned, device: cfg.device, now: now() });
      return `Saved ${layerId(l)}/${f.name}.md`;
    }),
  );

  server.registerTool(
    'memory_promote',
    {
      description: 'Move a fact from the current project layer to global because it turned out to be generally true.',
      inputSchema: { name: z.string(), from_project: z.string().optional().describe('project slug; defaults to the current project') },
    },
    ({ name, from_project }) => guarded(async () => {
      const { store, slug } = await open();
      await promoteFact(store, name, project(from_project ?? slug));
      return `Promoted ${name} to global.`;
    }),
  );

  server.registerTool(
    'memory_handoff',
    {
      description: 'Write a project handoff so the next session, on any machine, knows what was going on. Call it before finishing a task or when the user says they are stopping.',
      inputSchema: {
        working_on: z.string().describe('what was in progress, 1-3 sentences'),
        decisions: z.string().optional().describe('choices made and why'),
        open_threads: z.string().optional().describe('unresolved questions'),
        next_steps: z.string().optional().describe('concrete next actions, in order'),
        files_touched: z.string().optional().describe('paths changed or important'),
      },
    },
    (a) => guarded(async () => {
      const { cfg, store, slug } = await open();
      const h = await writeHandoff(store, {
        slug, device: cfg.device, source: 'agent', session: '', branch: (await currentBranch(deps.exec, deps.cwd)) ?? '',
        workingOn: a.working_on, decisions: a.decisions, openThreads: a.open_threads, nextSteps: a.next_steps, filesTouched: a.files_touched, now: now(),
      });
      return `Wrote handoff projects/${slug}/handoffs/${h.id}.md`;
    }),
  );

  server.registerTool(
    'hearth_doctor',
    { description: 'Check whether hearthkit is set up on this machine. Returns each check with a plain-language fix. Used by /hearth:setup.', inputSchema: {} },
    () => guarded(async () => JSON.stringify(await runDoctor({ exec: deps.exec, home: deps.home }), null, 2)),
  );

  server.registerTool(
    'hearth_init',
    {
      description: 'Create (via GitHub CLI) or connect (via a remote URL) the private memory repo and write config. Ask the user before calling.',
      inputSchema: { remote: z.string().optional().describe('existing private git remote URL'), allow_public: z.boolean().optional() },
    },
    ({ remote, allow_public }) => guarded(async () => {
      const msgs: string[] = [];
      const r = await initMemory(deps.exec, deps.home, { remote, allowPublic: allow_public }, (m) => msgs.push(m));
      return [...msgs, `Memory repo: ${r.memoryDir}`, `Remote: ${r.remote}`, r.pushed ? 'Pushed.' : 'Not pushed yet; sync will retry.'].join('\n');
    }),
  );

  server.registerTool(
    'hearth_sync',
    { description: 'Pull, merge, and push the memory repo now. Reports conflicts kept as extra copies.', inputSchema: {} },
    () => guarded(async () => {
      const { cfg, store } = await open();
      const r = await syncRepo(deps.exec, store, { device: cfg.device, now: now() });
      if (r.error) throw new HearthError(`Sync incomplete: ${r.error}`);
      return `Synced.${r.committed ? ' Committed local changes.' : ''}${r.pulled ? ' Pulled.' : ''}${r.pushed ? ' Pushed.' : ' Nothing to push.'}${r.conflicts.length ? `\nConflicts kept as extra copies: ${r.conflicts.join(', ')}` : ''}`;
    }),
  );

  return server;
}
```

- [ ] **Step 4: Implement src/mcp/index.ts**

```ts
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { hearthHome } from '../core/config.js';
import { RealExec } from '../core/exec.js';
import { createMcpServer } from './server.js';

const server = createMcpServer({ exec: new RealExec(), home: hearthHome(), cwd: process.cwd() });
await server.connect(new StdioServerTransport());
```

- [ ] **Step 5: Build, test, typecheck, commit**

Run: `npm run build && npx vitest run test/mcp.test.ts && npx tsc --noEmit`
Expected: PASS. If `registerTool` complains about the empty `inputSchema: {}`, use `inputSchema: { _: z.string().optional() }` for the two no-argument tools and ignore the argument.

```bash
git add -A
git commit -m "feat: MCP server with memory, handoff, and setup tools"
```

---

### Task 20: Plugin manifests, commands, and the memory-use skill

**Files:**
- Create: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json`, `.mcp.json`, `commands/setup.md`, `commands/sync.md`, `commands/handoff.md`, `skills/memory-use/SKILL.md`, `LICENSE`
- Test: `test/manifests.test.ts`

**Interfaces:**
- Consumes: `dist/hearth.js`, `dist/mcp.js`.
- Produces: an installable Claude Code plugin whose hooks and MCP server run the bundled code via `${CLAUDE_PLUGIN_ROOT}`.

- [ ] **Step 1: Write the failing manifest test**

`test/manifests.test.ts`:
```ts
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8');
const json = (p: string) => JSON.parse(read(p)) as Record<string, any>;

describe('plugin manifests', () => {
  it('agree on name and version and reference the built files', () => {
    const pkg = json('package.json');
    const plugin = json('.claude-plugin/plugin.json');
    const market = json('.claude-plugin/marketplace.json');
    expect(plugin.name).toBe('hearthkit');
    expect(plugin.version).toBe(pkg.version);
    expect(market.name).toBe('hearthkit');
    expect(market.plugins[0].name).toBe('hearthkit');
    expect(market.plugins[0].version).toBe(pkg.version);

    const hooks = json('hooks/hooks.json');
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toBe('node "${CLAUDE_PLUGIN_ROOT}/dist/hearth.js" memory context');
    expect(hooks.hooks.SessionEnd[0].hooks[0].command).toBe('node "${CLAUDE_PLUGIN_ROOT}/dist/hearth.js" handoff capture');

    const mcp = json('.mcp.json');
    expect(mcp.hearth.command).toBe('node');
    expect(mcp.hearth.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/dist/mcp.js']);

    expect(existsSync('dist/hearth.js')).toBe(true);
    expect(existsSync('dist/mcp.js')).toBe(true);
  });

  it('commands and the skill have frontmatter descriptions', () => {
    const cmds = readdirSync('commands').sort();
    expect(cmds).toEqual(['handoff.md', 'setup.md', 'sync.md']);
    for (const f of cmds) expect(read(`commands/${f}`)).toMatch(/^---\ndescription: .+\n---\n/);
    expect(read('skills/memory-use/SKILL.md')).toMatch(/^---\nname: memory-use\ndescription: .+\n---\n/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/manifests.test.ts`
Expected: FAIL, files missing.

- [ ] **Step 3: Create the manifests**

`.claude-plugin/plugin.json`:
```json
{
  "name": "hearthkit",
  "version": "0.1.0",
  "description": "Git-synced memory and session handoffs for Claude Code, on every machine.",
  "author": { "name": "Corey Smith" },
  "homepage": "https://github.com/c0reyx/hearthkit",
  "repository": "https://github.com/c0reyx/hearthkit",
  "license": "MIT",
  "keywords": ["memory", "handoff", "continuity", "sync", "git"]
}
```

`.claude-plugin/marketplace.json`:
```json
{
  "name": "hearthkit",
  "owner": { "name": "Corey Smith" },
  "description": "hearthkit: git-synced memory and session handoffs for Claude Code",
  "plugins": [
    {
      "name": "hearthkit",
      "source": "./",
      "description": "Git-synced memory and session handoffs for Claude Code, on every machine.",
      "version": "0.1.0",
      "category": "productivity"
    }
  ]
}
```

`hooks/hooks.json`:
```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|clear|compact",
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/hearth.js\" memory context", "timeout": 20 }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/dist/hearth.js\" handoff capture", "timeout": 30 }
        ]
      }
    ]
  }
}
```

`.mcp.json`:
```json
{
  "hearth": {
    "command": "node",
    "args": ["${CLAUDE_PLUGIN_ROOT}/dist/mcp.js"]
  }
}
```

`LICENSE`: the MIT licence text with `Copyright (c) 2026 Corey Smith`.

- [ ] **Step 4: Create the commands**

`commands/setup.md`:
```markdown
---
description: Set up hearthkit memory on this machine, step by step
---
You are helping the user set up hearthkit, which gives Claude Code memory and session handoffs that follow them across machines. Be brief and plain; assume the user may not be an engineer.

1. Call the `hearth_doctor` tool (MCP server "hearth"). If that tool is not available, tell the user to quit and reopen Claude Code once so the plugin's MCP server starts, then stop.
2. Summarise the result as a short list: what is ready, what is missing. For each `fail` or `warn` check, explain in one sentence what it is for, then show its `fix` text verbatim in a code block. Wait for the user to do it, then call `hearth_doctor` again.
3. When only the "hearthkit config" or "memory repo" checks fail: ask whether they want hearth to create a private GitHub repo for them (this needs the GitHub CLI logged in) or whether they have a private git URL to paste. Then call `hearth_init` with no arguments, or with `remote` set to their URL. Never pass `allow_public` unless the user explicitly says the repo may be public and understands their memory would be visible to others.
4. After init succeeds, ask two or three short questions to seed memory: what they do, how they like to work with you, and anything about their machine or team you should always know. Save each answer with `memory_write` in layer "global" with type "user" or "feedback". Keep each fact to one to three sentences.
5. Call `hearth_doctor` once more, confirm everything is green, and tell them in two sentences: memory now loads automatically at the start of every session, and they can say "write a handoff" any time before stopping. Mention `/hearth:sync` for pushing manually.
```

`commands/sync.md`:
```markdown
---
description: Push and pull hearthkit memory now
---
Call the `hearth_sync` tool (MCP server "hearth") and report its one-line result to the user. If it mentions conflicts kept as extra copies, list them and offer to show both versions with `memory_read` so the user can choose which to keep; delete the loser with the CLI command `hearth memory delete <layer> <name>` only if the user asks.
```

`commands/handoff.md`:
```markdown
---
description: Write a handoff for this project now
---
Write a handoff for the current project by calling the `memory_handoff` tool. Fill in: `working_on` (what we were doing, one to three sentences), `decisions` (choices made and why), `open_threads` (unresolved questions), `next_steps` (concrete, in order), `files_touched` (paths). Base it on this conversation only; do not invent. Then tell the user in one line that the handoff is saved and will load at the start of the next session in this folder, on any machine.
```

- [ ] **Step 5: Create the skill**

`skills/memory-use/SKILL.md`:
```markdown
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

## Searching
When the user refers to something you may have discussed before, or asks "where were we", call `memory_search` before asking them to repeat themselves.
```

- [ ] **Step 6: Validate with Claude Code, run tests, commit**

Run: `npm run build && claude plugin validate . && npx vitest run test/manifests.test.ts`
Expected: validate reports the plugin and marketplace manifests as valid; test PASS. If validate rejects `"source": "./"` in the marketplace, change it to `{ "source": "github", "repo": "c0reyx/hearthkit" }` and update the test's expectation for `market.plugins[0].source`; local development still works via `claude --plugin-dir ~/Projects/hearthkit`.

```bash
git add -A
git commit -m "feat: plugin manifests, hooks, MCP config, setup/sync/handoff commands, memory-use skill"
```

---

### Task 21: User documentation and the acceptance protocol

**Files:**
- Create: `README.md`, `docs/ACCEPTANCE.md`, `docs/TEAM-AGENTS.md`

- [ ] **Step 1: Write README.md**

```markdown
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
/plugin install hearthkit@hearthkit
```

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
| `~/.hearth/config.json` | repo location, device name, context cap |
| `~/.hearth/memory/` | your memory repo (a git clone) |
| `~/.hearth/memory/global/` | global facts |
| `~/.hearth/memory/projects/<slug>/` | project facts and `handoffs/` |
| `~/.hearth/logs/hearth.log` | logs (no transcript text) |
| `~/.claude/plugins/…/hearthkit/` | the plugin, including the bundled CLI |

`hearth where` prints this with live values. Set `HEARTH_HOME` to move `~/.hearth`.

## Conflicts

If the same fact is edited on two machines, sync keeps both: the other machine's version keeps the name, yours becomes `<name>.conflict-<device>.md`. `hearth doctor` lists them; delete the one you do not want.

## Privacy

The memory repo must be private; `hearth init` refuses a public GitHub repo. Automatic handoffs contain only what you and Claude said, never tool output or file contents. Anything can be deleted with the CLI or in the repo.

## Uninstall

`/plugin uninstall hearthkit@hearthkit`, then delete `~/.hearth` if you want the local clone gone. Your memory repo on GitHub is untouched.

## Roadmap

v1.1: per-agent memory, activity history, Codex CLI support, optional semantic search. v1.2: prompt library. v2: hosted team hub with a web dashboard and remote MCP for Claude.ai and ChatGPT.

## Licence

MIT
```

- [ ] **Step 2: Write docs/ACCEPTANCE.md**

```markdown
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
```

- [ ] **Step 3: Write docs/TEAM-AGENTS.md**

```markdown
# Team agents alongside hearthkit

hearthkit gives every session memory and handoffs. Team agents are ordinary Claude Code plugins in a private marketplace. Any agent installed next to hearthkit gets memory automatically, because the hooks belong to hearthkit, not to the agent.

## 1. Create the marketplace repo

A private GitHub repo, for example `opensense/claude-agents`:

```
claude-agents/
  .claude-plugin/marketplace.json
  plugins/
    support-triage/
      .claude-plugin/plugin.json
      skills/
        triage/SKILL.md
      agents/
        triage.md
      .mcp.json          (optional: MCP servers this agent needs)
```

`.claude-plugin/marketplace.json`:
```json
{
  "name": "opensense-agents",
  "owner": { "name": "Opensense" },
  "plugins": [
    { "name": "support-triage", "source": "./plugins/support-triage", "description": "Triage support tickets the Opensense way", "version": "0.1.0" }
  ]
}
```

`plugins/support-triage/.claude-plugin/plugin.json`:
```json
{ "name": "support-triage", "version": "0.1.0", "description": "Triage support tickets the Opensense way" }
```

Validate with `claude plugin validate .` in the repo root.

## 2. Teammates install it

They need read access to the repo and git credentials on their machine (`gh auth login` covers GitHub). Then:

```
/plugin marketplace add opensense/claude-agents
/plugin install support-triage@opensense-agents
```

To install for everyone automatically, add to a project's `.claude/settings.json`:
```json
{
  "extraKnownMarketplaces": { "opensense-agents": { "source": { "source": "github", "repo": "opensense/claude-agents" } } },
  "enabledPlugins": { "support-triage@opensense-agents": true, "hearthkit@hearthkit": true }
}
```

## 3. Memory stays personal

Each person's memory repo is their own. Facts an agent learns while a teammate uses it go into that teammate's memory, not the agent repo. Anything the whole team must know belongs in the agent's skills or instructions, committed to the marketplace repo.
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: README, acceptance protocol, team agents guide"
```

---

### Task 22: Release script, first tag, and the acceptance run

**Files:**
- Create: `scripts/release.mjs`
- Modify: `.gitignore` is unchanged; `dist/` is force-added by the script.

- [ ] **Step 1: Create scripts/release.mjs**

```js
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const plugin = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8')).version;
if (plugin !== version) {
  console.error(`package.json is ${version} but plugin.json is ${plugin}. Make them match first.`);
  process.exit(1);
}
run('npm', ['test']);
run('node', ['scripts/build.mjs']);
run('git', ['add', '-f', 'dist']);
try {
  run('git', ['commit', '-m', `release: v${version}\n\nCo-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01Vo11sYWhQUDvQH37Zt5NwK`]);
} catch {
  console.log('dist unchanged; nothing to commit');
}
run('git', ['tag', '-f', `v${version}`]);
console.log(`Tagged v${version}. Push with: git push && git push -f origin v${version}`);
```

- [ ] **Step 2: Run the full suite, then release locally**

Run: `npm test && npm run typecheck && npm run release`
Expected: all tests pass; a `release: v0.1.0` commit exists with `dist/` in it; tag `v0.1.0` exists (`git tag`).

- [ ] **Step 3: Load the working tree as a plugin and run the local acceptance scenarios**

Run (in a terminal, from any test repo): `claude --plugin-dir ~/Projects/hearthkit`
Then follow `docs/ACCEPTANCE.md` scenarios A1 (using the `--plugin-dir` variant), A2, A3, A4, A5, A7, A8, A9. Fix anything that fails as a bug with a new failing test first.

- [ ] **Step 4: Publish to GitHub (ask Corey first: this creates a public repository)**

Once Corey confirms:
```bash
gh repo create c0reyx/hearthkit --public --source=. --description "Git-synced memory and session handoffs for Claude Code" --push
git push -f origin v0.1.0
```
Then run A1 the real way (`/plugin marketplace add c0reyx/hearthkit`), A6 with a second home, and A10.

- [ ] **Step 5: Commit any acceptance fixes and re-tag**

```bash
npm run release
git push && git push -f origin v0.1.0
```

---

## Self-review

**Spec coverage** (spec section → task):

- §2 items 1–5: memory layers (T5–T7), handoffs (T8–T10), automatic delivery (T11, T18, T20 hooks), guided setup (T19 `hearth_doctor`/`hearth_init` + T20 `commands/setup.md`), CLI (T17–T18).
- §3 baseline checks → T15 doctor. §4.2 location map → T16. §4.3 plugin-is-the-tool → T17 build, T20 manifests. §4.5 data flow → T17–T20.
- §5.1–5.5 → T4 slug, T6 facts, T8–T10 handoffs, T11 context, T12 search. §6 sync → T13. §7 CLI → T17–T18 (plus `memory delete`, `handoff delete`, `handoff capture`). §8 MCP tools → T19. §9 sharing → T21 TEAM-AGENTS.md. §10 stack/build/release → T1, T17, T22. §11 testing → every task; manifest test T20. §12 acceptance → T21 ACCEPTANCE.md, run in T22. §13 security → private check T14, text-only capture T9–T10, safe names T1/T5, cap T11, no transcript text in logs T18.

**Spec amendments this plan makes** (recorded here so the spec can be updated to match):

1. Source layout adds `exec.ts`, `transcript.ts`, `context.ts`, `log.ts` as separate files rather than folding them into `git.ts`/`memory.ts`.
2. MCP gains `hearth_doctor`, `hearth_init`, `hearth_sync` so slash commands never rely on `${CLAUDE_PLUGIN_ROOT}` expanding inside command markdown.
3. CLI gains `memory delete` and `handoff delete`; `handoff write` takes flags instead of interactive prompts in v1.
4. Automatic capture skips when the transcript shows a `memory_handoff` tool call, since the MCP server does not know the session id; agent-written handoffs carry an empty `session`.
5. `HEARTH_NO_BACKGROUND_SYNC=1` disables the detached post-session sync (used by tests).

**Placeholder scan:** no TBD/TODO; every code step has code; every test step has the test.

**Type consistency:** `writeFact(store, {layer, text, name?, description?, type?, pinned?, device, now?})` is used identically in T6, T7, T11, T12, T17, T19. `writeHandoff(store, {slug, device, source, session, branch, workingOn, ...})` identical in T8, T10, T17, T19. `syncRepo(exec, store: FileStore, {device, now?, log?})` in T13, T17, T19. `runDoctor({exec, home, nodeVersion?, online?})` in T15, T17, T19. `captureHandoff(payload, {store, exec, device, readFile?, now?})` in T10, T18. `HookPayload` fields `session_id`, `transcript_path`, `cwd` in T10, T18. `FakeExec.on(cmd, argPrefix, result)` with last-match-wins in T2 and used in T4, T10, T14, T15, T16, T19.
