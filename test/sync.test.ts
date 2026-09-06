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
