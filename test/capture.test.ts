import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { captureHandoff } from '../src/core/capture.js';
import { FakeExec } from '../src/core/exec.js';
import { listHandoffs, writeHandoff } from '../src/core/handoff.js';
import { FileStore } from '../src/core/store.js';
import { mkTmpDir } from './helpers/tmp.js';

const T1 = new Date('2026-09-06T15:30:00Z');

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

  it('skips when the project already has an agent handoff less than ten minutes old', async () => {
    const store = new FileStore(tmp.dir);
    await writeHandoff(store, { slug: 'acme-crm', device: 'mac', source: 'agent', session: 's-agent', branch: '', workingOn: 'agent note', now: T1 });
    const soon = await captureHandoff(
      { session_id: 's-later', transcript_path: '/t.jsonl', cwd: '/repo' },
      { store, exec: exec(), device: 'mac', readFile: fixture('normal'), now: new Date(T1.getTime() + 5 * 60_000) },
    );
    expect(soon).toBeNull();

    const later = await captureHandoff(
      { session_id: 's-later', transcript_path: '/t.jsonl', cwd: '/repo' },
      { store, exec: exec(), device: 'mac', readFile: fixture('normal'), now: new Date(T1.getTime() + 30 * 60_000) },
    );
    expect(later?.source).toBe('auto');
  });

  it('skips on missing path, unreadable file, or no text turns', async () => {
    const store = new FileStore(tmp.dir);
    expect(await captureHandoff({ cwd: '/repo' }, { store, exec: exec(), device: 'mac' })).toBeNull();
    expect(await captureHandoff({ transcript_path: '/nope', cwd: '/repo' }, { store, exec: exec(), device: 'mac', readFile: async () => { throw new Error('ENOENT'); } })).toBeNull();
    expect(await captureHandoff({ transcript_path: '/t', cwd: '/repo' }, { store, exec: exec(), device: 'mac', readFile: fixture('tool-heavy') })).toBeNull();
  });
});
