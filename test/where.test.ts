import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, saveConfig } from '../src/core/config.js';
import { FakeExec } from '../src/core/exec.js';
import { claudeProjectDir, renderWhere, whereAll } from '../src/core/where.js';
import { mkTmpDir } from './helpers/tmp.js';

describe('where', () => {
  const tmp = mkTmpDir();
  afterEach(() => tmp.cleanup());

  it('maps Claude Code project folders the way Claude Code names them', () => {
    expect(claudeProjectDir('/Users/c/.claude', '/Users/c/Projects/hearthkit')).toBe('/Users/c/.claude/projects/-Users-c-Projects-hearthkit');
    expect(claudeProjectDir('/Users/c/.claude', '/Users/c/.chef')).toBe('/Users/c/.claude/projects/-Users-c--chef');
  });

  it('lists every location with existence, owner, and the project slug', async () => {
    await saveConfig(tmp.dir, { ...defaultConfig(tmp.dir), remote: 'git@github.com:c/m.git' });
    const exec = new FakeExec().on('git', ['remote', 'get-url', 'origin'], { stdout: 'git@github.com:acme/crm.git\n' });
    const w = await whereAll({ home: tmp.dir, cwd: '/repo', exec, claudeHome: join(tmp.dir, 'claude'), pluginRoot: '/plugins/hearthkit' });
    expect(w.slug).toBe('acme-crm');
    const byLabel = Object.fromEntries(w.locations.map((l) => [l.label, l]));
    expect(byLabel.config).toMatchObject({ path: join(tmp.dir, 'config.json'), exists: true, owner: 'hearthkit' });
    expect(byLabel['memory repo (local clone)']).toMatchObject({ exists: false, note: 'syncs with git@github.com:c/m.git' });
    expect(byLabel['this project layer']?.path).toBe(join(tmp.dir, 'memory', 'projects', 'acme-crm'));
    expect(byLabel['this project layer']?.note).toContain('linked to this folder');
    expect(byLabel['project links']?.path).toBe(join(tmp.dir, 'projects.json'));
    expect(byLabel['last sync outcome']?.path).toBe(join(tmp.dir, 'sync-state.json'));
    expect(byLabel['plugin (bundled CLI + MCP server)']?.path).toBe('/plugins/hearthkit');
    expect(byLabel['Claude Code transcripts for this folder']?.path).toBe(join(tmp.dir, 'claude', 'projects', '-repo'));
    const text = renderWhere(w);
    expect(text).toContain('project slug: acme-crm');
    expect(text).toContain('✔ config');
  });
});
