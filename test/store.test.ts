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
    await expect(store.writeFact(project('../escape'), 'x', 'y')).rejects.toThrow(/Invalid name/);
    await expect(store.listFacts(project('a/b'))).rejects.toThrow(/Invalid name/);
  });
});
