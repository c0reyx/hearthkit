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
