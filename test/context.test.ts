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
