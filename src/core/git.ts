import type { Exec } from './exec.js';

export async function remoteUrl(exec: Exec, cwd: string): Promise<string | null> {
  const r = await exec.run('git', ['remote', 'get-url', 'origin'], { cwd });
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

export async function currentBranch(exec: Exec, cwd: string): Promise<string | null> {
  const r = await exec.run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

export async function isGitRepo(exec: Exec, cwd: string): Promise<boolean> {
  const r = await exec.run('git', ['rev-parse', '--is-inside-work-tree'], { cwd });
  return r.code === 0 && r.stdout.trim() === 'true';
}

export function parseOwnerRepo(url: string): { owner: string; repo: string } | null {
  // Matches "...:owner/repo(.git)" and ".../owner/repo(.git)" when a host precedes them.
  const m = /^(?:[a-z+]+:\/\/)?(?:[^@\/]+@)?[^\/:]+[:\/]([^\/:]+)\/([^\/]+?)(?:\.git)?\/?$/.exec(url);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return { owner: m[1], repo: m[2] };
}
