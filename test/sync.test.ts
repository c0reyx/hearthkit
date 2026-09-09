import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildProgram, runCli, type CliDeps } from '../src/cli/program.js';
import { defaultConfig, saveConfig } from '../src/core/config.js';
import { FakeExec, RealExec } from '../src/core/exec.js';
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
    // No rebase may be left in progress and no file left half-merged.
    expect(existsSync(join(b.root, '.git', 'rebase-merge'))).toBe(false);
    expect(await git(b.root, 'status', '--porcelain')).toBe('');
    await syncRepo(exec, a, { device: 'a' });
    expect(existsSync(join(a.root, 'global', 'shared.conflict-b.md'))).toBe(true);
  });

  it('a fact deleted on one device and edited on another resolves to the surviving edit', async () => {
    const { a, b } = await twoDevices();
    await writeFact(a, { layer: GLOBAL, text: 'original', name: 'f', device: 'a' });
    await syncRepo(exec, a, { device: 'a' });
    await syncRepo(exec, b, { device: 'b' });
    await a.deleteFact(GLOBAL, 'f');
    await syncRepo(exec, a, { device: 'a' });
    await writeFact(b, { layer: GLOBAL, text: 'B still wants this', name: 'f', device: 'b' });
    const rb = await syncRepo(exec, b, { device: 'b' });
    expect(rb.error).toBeNull();
    expect(rb.conflicts).toEqual([]);
    expect(rb.resolved).toEqual(['global/f.md']);
    expect(await b.listFacts(GLOBAL)).toEqual(['f']);
    expect(existsSync(join(b.root, 'global', 'f.conflict-b.md'))).toBe(false);
    expect(await b.readFact(GLOBAL, 'f')).toContain('B still wants this');
    await syncRepo(exec, a, { device: 'a' });
    expect(await a.readFact(GLOBAL, 'f')).toContain('B still wants this');
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

/**
 * H3: `commitAll` returned `c.code === 0` and threw the failure away, so a repo whose git
 * identity is unusable (a fresh machine, gpgsign without a key, a failing pre-commit hook)
 * reported "Synced." forever — and on the "no local commits, remote has commits" path it ran
 * `git reset --hard origin/<branch>`, deleting memory that had never been pushed.
 */
describe('syncRepo when git commit fails (H3)', () => {
  const tmp = mkTmpDir();
  afterEach(() => tmp.cleanup());
  const exec = new RealExec();

  async function remoteWithCommits(): Promise<string> {
    const remote = await makeBareRemote(tmp.dir);
    const seed = join(tmp.dir, 'seed');
    await cloneWithIdentity(remote, seed, 'seed');
    await writeFact(new FileStore(seed), { layer: GLOBAL, text: 'from remote', name: 'from-remote', device: 'seed' });
    await syncRepo(exec, new FileStore(seed), { device: 'seed' });
    return remote;
  }

  /** A hand-initialised memory repo: no commits yet, and an unusable git identity. */
  async function brokenIdentityClone(remote: string): Promise<FileStore> {
    const dir = join(tmp.dir, 'broken');
    await exec.run('git', ['init', '-q', '-b', 'main', dir]);
    await exec.run('git', ['remote', 'add', 'origin', remote], { cwd: dir });
    await exec.run('git', ['config', 'user.email', ''], { cwd: dir });
    await exec.run('git', ['config', 'user.name', ''], { cwd: dir });
    return new FileStore(dir);
  }

  it('reports the git error, pushes nothing, and never discards never-pushed memory', async () => {
    const remote = await remoteWithCommits();
    const broken = await brokenIdentityClone(remote);
    await writeFact(broken, { layer: GLOBAL, text: 'precious local memory never pushed', name: 'precious', device: 'broken' });

    const r = await syncRepo(exec, broken, { device: 'broken' });
    // The data loss first: this file was deleted by `git reset --hard origin/main` before the fix.
    expect(existsSync(join(broken.root, 'global', 'precious.md'))).toBe(true);
    expect(r.error).toMatch(/commit failed/i);
    expect(r.error).toMatch(/who you are|empty ident/i);
    expect(r.committed).toBe(false);
    expect(r.pulled).toBe(false);
    expect(r.pushed).toBe(false);
    expect(existsSync(join(broken.root, 'global', 'precious.md'))).toBe(true);
    expect(await broken.readFact(GLOBAL, 'precious')).toContain('precious local memory');
    // The remote's own file must not have been checked out over the top either.
    expect(existsSync(join(broken.root, 'global', 'from-remote.md'))).toBe(false);
  });

  it('still reports success when there is genuinely nothing to commit', async () => {
    const remote = await makeBareRemote(tmp.dir);
    const a = join(tmp.dir, 'clean');
    await cloneWithIdentity(remote, a, 'clean');
    const store = new FileStore(a);
    const r = await syncRepo(exec, store, { device: 'clean' });
    expect(r.error).toBeNull();
    expect(r.committed).toBe(false);
  });

  it('a failed sync is recorded and surfaces in the next session-start context block', async () => {
    const remote = await remoteWithCommits();
    const broken = await brokenIdentityClone(remote);
    await writeFact(broken, { layer: GLOBAL, text: 'precious local memory never pushed', name: 'precious', device: 'broken' });
    const home = join(tmp.dir, 'home');
    await saveConfig(home, { ...defaultConfig(home), memoryDir: broken.root, device: 'broken' });

    const run = async (argv: string[], input = ''): Promise<{ code: number; stdout: string; stderr: string }> => {
      const out: string[] = [];
      const err: string[] = [];
      const deps: CliDeps = {
        exec, home, cwd: tmp.dir, env: {}, stdout: (s) => out.push(s), stderr: (s) => err.push(s),
        readStdin: async () => input, spawnDetached: () => undefined, now: () => new Date('2026-09-09T12:00:00Z'),
      };
      const code = await runCli(buildProgram(deps), ['node', 'hearth', ...argv], (s) => err.push(s));
      return { code, stdout: out.join(''), stderr: err.join('') };
    };

    const sync = await run(['sync']);
    expect(sync.code).toBe(2);
    expect(sync.stderr).toMatch(/commit failed/i);
    const ctx = await run(['memory', 'context'], JSON.stringify({ cwd: tmp.dir }));
    expect(ctx.stdout).toContain('Memory sync failed on 2026-09-09');
    expect(ctx.stdout).toMatch(/commit failed/i);
  });
});

describe('syncRepo never resets over uncommitted files (H3)', () => {
  const tmp = mkTmpDir();
  afterEach(() => tmp.cleanup());

  it('refuses the "no local commits" checkout of origin when the working tree is not clean', async () => {
    // A repo with no HEAD, a remote that has commits, and files git did not stage: the exact
    // shape in which `git reset --hard origin/main` used to delete never-pushed memory.
    const fake = new FakeExec()
      .on('git', ['add', '-A'], { code: 0 })
      .on('git', ['diff', '--cached', '--quiet'], { code: 0 })
      .on('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdout: 'main\n' })
      .on('git', ['fetch', '-q', 'origin'], { code: 0 })
      .on('git', ['rev-parse', '--verify', '-q', 'HEAD'], { code: 1 })
      .on('git', ['rev-parse', '--verify', '-q', 'origin/main'], { code: 0 })
      .on('git', ['status', '--porcelain'], { stdout: '?? global/precious.md\n' });

    const r = await syncRepo(fake, new FileStore(tmp.dir), { device: 'mac' });
    expect(r.error).toMatch(/refusing to check out origin\/main/);
    expect(r.error).toContain('global/precious.md');
    expect(r.pulled).toBe(false);
    expect(r.pushed).toBe(false);
    expect(fake.calls.some((c) => c.args[0] === 'reset')).toBe(false);
    expect(fake.calls.some((c) => c.args[0] === 'push')).toBe(false);
  });
});

describe('syncRepo audits the memory repo after a pull (H4)', () => {
  const tmp = mkTmpDir();
  afterEach(() => tmp.cleanup());
  const exec = new RealExec();

  it('refuses to parse or push a repo where the remote introduced a symlink', async () => {
    const remote = await makeBareRemote(tmp.dir);
    const hostile = join(tmp.dir, 'hostile');
    const victim = join(tmp.dir, 'victim-rc');
    writeFileSync(victim, 'original contents\n');
    await cloneWithIdentity(remote, hostile, 'hostile');
    // Committed with raw git, the way a hostile remote would arrive: MEMORY.md as a symlink.
    mkdirSync(join(hostile, 'global'), { recursive: true });
    symlinkSync(victim, join(hostile, 'global', 'MEMORY.md'));
    await git(hostile, 'add', '-A');
    await git(hostile, 'commit', '-q', '-m', 'hostile');
    await git(hostile, 'push', '-q', 'origin', 'HEAD:main');

    const victimDevice = join(tmp.dir, 'victim-device');
    await cloneWithIdentity(remote, victimDevice, 'victim');
    const store = new FileStore(victimDevice);
    const r = await syncRepo(exec, store, { device: 'victim' });
    expect(r.error).toContain('symlink inside memory repo: global/MEMORY.md');
    expect(r.pushed).toBe(false);
    expect(readFileSync(victim, 'utf8')).toBe('original contents\n');
  });
});
