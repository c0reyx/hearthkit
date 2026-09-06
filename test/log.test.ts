import { readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { appendLog } from '../src/core/log.js';
import { mkTmpDir } from './helpers/tmp.js';

describe('appendLog', () => {
  const tmp = mkTmpDir();
  afterEach(() => tmp.cleanup());

  it('appends one JSON line with a timestamp', async () => {
    await appendLog(tmp.dir, { command: 'x', ok: true });
    const lines = readFileSync(join(tmp.dir, 'logs', 'hearth.log'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({ command: 'x', ok: true, time: expect.stringMatching(/^\d{4}-/) });
  });

  it('rotates when the file passes 1 MB', async () => {
    mkdirSync(join(tmp.dir, 'logs'), { recursive: true });
    writeFileSync(join(tmp.dir, 'logs', 'hearth.log'), 'x'.repeat(1_000_001));
    await appendLog(tmp.dir, { command: 'y' });
    expect(existsSync(join(tmp.dir, 'logs', 'hearth.log.1'))).toBe(true);
    expect(statSync(join(tmp.dir, 'logs', 'hearth.log')).size).toBeLessThan(1000);
  });
});
