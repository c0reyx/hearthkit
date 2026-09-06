import { basename } from 'node:path';
import type { Exec } from './exec.js';
import { parseOwnerRepo, remoteUrl } from './git.js';
import { slugify } from './slug.js';

export async function projectSlug(exec: Exec, cwd: string): Promise<string> {
  const url = await remoteUrl(exec, cwd);
  if (url) {
    const parsed = parseOwnerRepo(url);
    if (parsed) {
      const s = slugify(`${parsed.owner}-${parsed.repo}`);
      if (s) return s;
    }
  }
  return slugify(basename(cwd)) || 'project';
}
