import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HearthError } from '../src/core/types.js';
import { defaultConfig, hearthHome, loadConfig, requireConfig, saveConfig } from '../src/core/config.js';
import { mkTmpDir } from './helpers/tmp.js';

describe('config', () => {
  const tmp = mkTmpDir();
  afterEach(() => tmp.cleanup());

  it('hearthHome honours HEARTH_HOME and defaults to ~/.hearth', () => {
    expect(hearthHome({ HEARTH_HOME: '/tmp/h' })).toBe('/tmp/h');
    expect(hearthHome({})).toMatch(/\.hearth$/);
  });

  it('defaultConfig points memoryDir inside home with a 4000 token cap', () => {
    const cfg = defaultConfig('/h');
    expect(cfg.memoryDir).toBe(join('/h', 'memory'));
    expect(cfg.contextCapTokens).toBe(4000);
    expect(cfg.device.length).toBeGreaterThan(0);
    expect(cfg.remote).toBeNull();
  });

  it('saves and loads, creating the directory', async () => {
    const home = join(tmp.dir, 'nested', 'home');
    const cfg = { ...defaultConfig(home), remote: 'git@github.com:a/b.git' };
    await saveConfig(home, cfg);
    expect(existsSync(join(home, 'config.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).remote).toBe('git@github.com:a/b.git');
    expect(await loadConfig(home)).toEqual(cfg);
  });

  it('loadConfig returns null when missing; requireConfig throws exit 2', async () => {
    expect(await loadConfig(join(tmp.dir, 'nope'))).toBeNull();
    await expect(requireConfig(join(tmp.dir, 'nope'))).rejects.toMatchObject({ exitCode: 2 });
    await expect(requireConfig(join(tmp.dir, 'nope'))).rejects.toBeInstanceOf(HearthError);
  });
});
