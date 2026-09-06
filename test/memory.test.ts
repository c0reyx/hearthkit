import { afterEach, describe, expect, it } from 'vitest';
import {
  deleteFact, listFacts, parseFact, promoteFact, readFact, regenerateIndex, renderIndex, serializeFact, writeFact,
} from '../src/core/memory.js';
import { FileStore } from '../src/core/store.js';
import { GLOBAL, HearthError, project } from '../src/core/types.js';
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
