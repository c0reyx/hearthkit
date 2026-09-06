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
