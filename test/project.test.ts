import { describe, expect, it } from 'vitest';
import { FakeExec } from '../src/core/exec.js';
import { projectSlug } from '../src/core/project.js';

describe('projectSlug', () => {
  it('uses owner-repo from the git remote so every machine agrees', async () => {
    const fake = new FakeExec().on('git', ['remote', 'get-url', 'origin'], { stdout: 'git@github.com:Opensense/HubSpot_Import.git\n' });
    expect(await projectSlug(fake, '/Users/x/anything')).toBe('opensense-hubspot-import');
  });
  it('falls back to the directory basename without a remote', async () => {
    const fake = new FakeExec().on('git', ['remote'], { code: 2 });
    expect(await projectSlug(fake, '/Users/x/My Project')).toBe('my-project');
  });
  it('never returns an empty slug', async () => {
    const fake = new FakeExec().on('git', ['remote'], { code: 2 });
    expect(await projectSlug(fake, '/')).toBe('project');
  });
});
