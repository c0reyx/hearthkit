import { describe, expect, it } from 'vitest';
import { FakeExec } from '../src/core/exec.js';
import { currentBranch, isGitRepo, parseOwnerRepo, remoteUrl } from '../src/core/git.js';

describe('parseOwnerRepo', () => {
  it('handles ssh, https, and ssh:// forms', () => {
    expect(parseOwnerRepo('git@github.com:acme/crm.git')).toEqual({ owner: 'acme', repo: 'crm' });
    expect(parseOwnerRepo('https://github.com/acme/crm.git')).toEqual({ owner: 'acme', repo: 'crm' });
    expect(parseOwnerRepo('https://gitlab.com/acme/crm')).toEqual({ owner: 'acme', repo: 'crm' });
    expect(parseOwnerRepo('ssh://git@bitbucket.org/acme/crm.git')).toEqual({ owner: 'acme', repo: 'crm' });
    expect(parseOwnerRepo('/srv/git/memory.git')).toBeNull();
  });
});

describe('git helpers', () => {
  it('remoteUrl returns trimmed url or null', async () => {
    const fake = new FakeExec().on('git', ['remote', 'get-url', 'origin'], { stdout: 'https://x/y/z.git\n' });
    expect(await remoteUrl(fake, '/r')).toBe('https://x/y/z.git');
    expect(await remoteUrl(new FakeExec().on('git', ['remote'], { code: 2 }), '/r')).toBeNull();
  });
  it('currentBranch and isGitRepo', async () => {
    const fake = new FakeExec()
      .on('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdout: 'main\n' })
      .on('git', ['rev-parse', '--is-inside-work-tree'], { stdout: 'true\n' });
    expect(await currentBranch(fake, '/r')).toBe('main');
    expect(await isGitRepo(fake, '/r')).toBe(true);
    expect(await isGitRepo(new FakeExec().on('git', ['rev-parse'], { code: 128 }), '/r')).toBe(false);
  });
});
