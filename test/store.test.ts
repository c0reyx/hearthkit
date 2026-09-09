import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { regenerateIndex } from '../src/core/memory.js';
import { FileStore, findUnsafeEntries } from '../src/core/store.js';
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
    await expect(store.writeFact(project('../escape'), 'x', 'y')).rejects.toThrow(/Invalid name/);
    await expect(store.listFacts(project('a/b'))).rejects.toThrow(/Invalid name/);
  });
});

/**
 * H4: path validation constrained the *name*, not the resolved target. Git checks out symlinks
 * faithfully, so a hostile remote could commit global/MEMORY.md as a symlink to ~/.zshenv and
 * hearthkit's own index regeneration would write through it.
 */
describe('FileStore refuses symlinks inside the memory repo (H4)', () => {
  const tmp = mkTmpDir();
  afterEach(() => tmp.cleanup());

  function root(): { store: FileStore; dir: string; victim: string } {
    const dir = join(tmp.dir, 'memory');
    const victim = join(tmp.dir, 'victim-rc');
    mkdirSync(join(dir, 'global'), { recursive: true });
    writeFileSync(victim, 'original contents\n');
    return { store: new FileStore(dir), dir, victim };
  }

  it('refuses to write a fact through a symlinked file, leaving the target untouched', async () => {
    const { store, dir, victim } = root();
    symlinkSync(victim, join(dir, 'global', 'evil.md'));
    await expect(store.writeFact(GLOBAL, 'evil', 'pwned')).rejects.toThrow(/symlink/i);
    await expect(store.readFact(GLOBAL, 'evil')).rejects.toThrow(/symlink/i);
    expect(readFileSync(victim, 'utf8')).toBe('original contents\n');
  });

  it('refuses to regenerate an index that is a symlink', async () => {
    const { store, dir, victim } = root();
    writeFileSync(join(dir, 'global', 'trigger.md'), '---\nname: trigger\ndescription: t\n---\nbody\n');
    symlinkSync(victim, join(dir, 'global', 'MEMORY.md'));
    await expect(regenerateIndex(store, GLOBAL)).rejects.toThrow(/symlink/i);
    expect(readFileSync(victim, 'utf8')).toBe('original contents\n');
  });

  it('refuses a symlinked layer directory', async () => {
    const { store, dir } = root();
    const elsewhere = join(tmp.dir, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(dir, 'projects'));
    await expect(store.writeFact(project('acme'), 'x', 'y')).rejects.toThrow(/symlink/i);
    await expect(store.writeHandoff('acme', '2026-09-09-1200-mac', 'y')).rejects.toThrow(/symlink/i);
    expect(existsSync(join(elsewhere, 'acme'))).toBe(false);
  });

  it('audits the memory root for non-regular files', async () => {
    const { dir, victim } = root();
    symlinkSync(victim, join(dir, 'global', 'evil.md'));
    expect(await findUnsafeEntries(dir)).toEqual(['global/evil.md']);
    expect(await findUnsafeEntries(join(tmp.dir, 'no-such-dir'))).toEqual([]);
  });
});
