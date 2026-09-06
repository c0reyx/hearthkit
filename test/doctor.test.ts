import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, saveConfig } from '../src/core/config.js';
import { doctorExitCode, renderChecks, runDoctor } from '../src/core/doctor.js';
import { FakeExec } from '../src/core/exec.js';
import { mkTmpDir } from './helpers/tmp.js';

function healthyExec(): FakeExec {
  return new FakeExec()
    .on('git', ['--version'], { stdout: 'git version 2.50.0\n' })
    .on('claude', ['--version'], { stdout: '2.1.0 (Claude Code)\n' })
    .on('gh', ['auth', 'status'], { code: 0 })
    .on('git', ['rev-parse', '--is-inside-work-tree'], { stdout: 'true\n' })
    .on('git', ['remote', 'get-url', 'origin'], { stdout: 'git@github.com:c/m.git\n' })
    .on('gh', ['repo', 'view', 'c/m', '--json', 'visibility', '--jq', '.visibility'], { stdout: 'PRIVATE\n' })
    .on('git', ['ls-remote'], { code: 0 })
    .on('git', ['status', '--porcelain'], { stdout: '' })
    .on('git', ['rev-list', '--count'], { stdout: '0\n' });
}

describe('runDoctor', () => {
  const tmp = mkTmpDir();
  afterEach(() => tmp.cleanup());

  it('is all green on a healthy machine', async () => {
    await saveConfig(tmp.dir, defaultConfig(tmp.dir));
    const checks = await runDoctor({ exec: healthyExec(), home: tmp.dir, nodeVersion: 'v22.1.0' });
    expect(checks.map((c) => c.id)).toEqual(['node', 'git', 'claude', 'gh', 'config', 'repo', 'visibility', 'remote', 'pending', 'conflicts']);
    expect(checks.every((c) => c.status === 'ok')).toBe(true);
    expect(doctorExitCode(checks)).toBe(0);
  });

  it('stops after a missing config and tells the user to run init', async () => {
    const checks = await runDoctor({ exec: healthyExec(), home: tmp.dir, nodeVersion: 'v22.1.0' });
    expect(checks.at(-1)).toMatchObject({ id: 'config', status: 'fail', fix: expect.stringContaining('hearth init') });
    expect(doctorExitCode(checks)).toBe(2);
  });

  it('flags old node, missing claude, and gh states with fixes', async () => {
    const exec = healthyExec().on('claude', ['--version'], { code: 127 }).on('gh', ['auth', 'status'], { code: 127 });
    const checks = await runDoctor({ exec, home: tmp.dir, nodeVersion: 'v18.20.0' });
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId.node).toMatchObject({ status: 'fail', fix: expect.stringContaining('nodejs.org') });
    expect(byId.claude).toMatchObject({ status: 'fail', fix: expect.stringContaining('Install Claude Code') });
    expect(byId.gh).toMatchObject({ status: 'warn', fix: expect.stringContaining('brew install gh') });
  });

  it('warns on unsynced changes and conflict copies; skips the network check offline', async () => {
    const cfg = defaultConfig(tmp.dir);
    await saveConfig(tmp.dir, cfg);
    mkdirSync(join(cfg.memoryDir, 'global'), { recursive: true });
    writeFileSync(join(cfg.memoryDir, 'global', 'x.md'), '---\nname: x\n---\n');
    writeFileSync(join(cfg.memoryDir, 'global', 'x.conflict-laptop.md'), '---\nname: x\n---\n');
    const exec = healthyExec().on('git', ['status', '--porcelain'], { stdout: ' M global/x.md\n' }).on('git', ['rev-list', '--count'], { stdout: '2\n' });
    const checks = await runDoctor({ exec, home: tmp.dir, nodeVersion: 'v22.0.0', online: false });
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId.remote?.status).toBe('skip');
    expect(byId.pending).toMatchObject({ status: 'warn', detail: expect.stringContaining('2 unpushed'), fix: 'Run: hearth sync' });
    expect(byId.conflicts).toMatchObject({ status: 'warn', detail: expect.stringContaining('global/x.conflict-laptop') });
    expect(renderChecks(checks)).toContain('fix: Run: hearth sync');
    expect(doctorExitCode(checks)).toBe(0);
  });

  it('fails when memory repo is public', async () => {
    const cfg = defaultConfig(tmp.dir);
    await saveConfig(tmp.dir, cfg);
    const exec = healthyExec().on('gh', ['repo', 'view', 'c/m', '--json', 'visibility', '--jq', '.visibility'], { stdout: 'PUBLIC\n' });
    const checks = await runDoctor({ exec, home: tmp.dir, nodeVersion: 'v22.0.0' });
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId.visibility).toMatchObject({ status: 'fail', fix: expect.stringContaining('Change visibility') });
  });

  it('skips visibility check for non-GitHub remotes', async () => {
    const cfg = defaultConfig(tmp.dir);
    await saveConfig(tmp.dir, cfg);
    const exec = healthyExec().on('git', ['remote', 'get-url', 'origin'], { stdout: '/srv/git/memory.git\n' });
    const checks = await runDoctor({ exec, home: tmp.dir, nodeVersion: 'v22.0.0' });
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    expect(byId.visibility).toMatchObject({ status: 'skip', detail: expect.stringContaining('cannot verify') });
  });
});
