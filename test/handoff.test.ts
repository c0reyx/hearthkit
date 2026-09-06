import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureHandoff, handoffId, latestHandoff, listHandoffs, parseHandoff, pruneAllHandoffs, pruneHandoffs, serializeHandoff, writeHandoff,
} from '../src/core/handoff.js';
import { FakeExec } from '../src/core/exec.js';
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
