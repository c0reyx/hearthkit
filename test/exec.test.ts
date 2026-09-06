import { describe, expect, it } from 'vitest';
import { FakeExec, RealExec } from '../src/core/exec.js';

describe('RealExec', () => {
  it('captures stdout and exit code', async () => {
    const r = await new RealExec().run(process.execPath, ['-e', 'process.stdout.write("hi"); process.exit(3)']);
    expect(r.stdout).toBe('hi');
    expect(r.code).toBe(3);
  });
  it('passes stdin input', async () => {
    const r = await new RealExec().run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'echo' });
    expect(r.stdout).toBe('echo');
  });
  it('returns code 127 for a missing command instead of throwing', async () => {
    const r = await new RealExec().run('definitely-not-a-command-xyz', []);
    expect(r.code).toBe(127);
  });
});

describe('FakeExec', () => {
  it('matches on command and argument prefix and records calls', async () => {
    const fake = new FakeExec().on('git', ['remote', 'get-url'], { stdout: 'git@github.com:acme/crm.git\n' });
    const r = await fake.run('git', ['remote', 'get-url', 'origin'], { cwd: '/x' });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('acme/crm');
    expect(fake.calls[0]?.args).toEqual(['remote', 'get-url', 'origin']);
  });
  it('returns 127 for unscripted commands', async () => {
    const r = await new FakeExec().run('gh', ['--version']);
    expect(r.code).toBe(127);
  });
});
