import { join } from 'node:path';
import { RealExec } from '../../src/core/exec.js';

const exec = new RealExec();

export async function makeBareRemote(dir: string): Promise<string> {
  const bare = join(dir, 'remote.git');
  await exec.run('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  return bare;
}

export async function cloneWithIdentity(remote: string, dest: string, name: string): Promise<void> {
  await exec.run('git', ['clone', '-q', remote, dest]);
  await exec.run('git', ['config', 'user.name', name], { cwd: dest });
  await exec.run('git', ['config', 'user.email', `${name}@example.com`], { cwd: dest });
  await exec.run('git', ['checkout', '-q', '-B', 'main'], { cwd: dest });
}

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await exec.run('git', args, { cwd });
  return r.stdout;
}
