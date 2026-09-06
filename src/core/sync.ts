import matter from 'gray-matter';
import { writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { Exec, ExecResult } from './exec.js';
import { currentBranch } from './git.js';
import { pruneAllHandoffs } from './handoff.js';
import { regenerateIndex } from './memory.js';
import { INDEX_FILE, type FileStore } from './store.js';

export interface SyncResult {
  committed: boolean;
  pulled: boolean;
  pushed: boolean;
  conflicts: string[];
  pruned: string[];
  error: string | null;
}

export interface SyncOptions {
  device: string;
  now?: Date;
  log?: (msg: string) => void;
}

type Git = (...args: string[]) => Promise<ExecResult>;

const GIT_ENV = { GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' };

export async function syncRepo(exec: Exec, store: FileStore, opts: SyncOptions): Promise<SyncResult> {
  const cwd = store.root;
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => undefined);
  const result: SyncResult = { committed: false, pulled: false, pushed: false, conflicts: [], pruned: [], error: null };
  const git: Git = (...args) => exec.run('git', args, { cwd, env: GIT_ENV });

  result.committed = await commitAll(git, `hearth: ${opts.device} ${now.toISOString()}`);
  const branch = (await currentBranch(exec, cwd)) ?? 'main';

  const fetch = await git('fetch', '-q', 'origin');
  if (fetch.code !== 0) {
    result.error = `fetch failed: ${fetch.stderr.trim() || 'is the network up?'}`;
    log(result.error);
    return result;
  }

  const hasLocal = (await git('rev-parse', '--verify', '-q', 'HEAD')).code === 0;
  const hasRemote = (await git('rev-parse', '--verify', '-q', `origin/${branch}`)).code === 0;

  if (hasRemote && !hasLocal) {
    const reset = await git('reset', '-q', '--hard', `origin/${branch}`);
    if (reset.code !== 0) {
      result.error = `could not check out origin/${branch}: ${reset.stderr.trim()}`;
      return result;
    }
    result.pulled = true;
  } else if (hasRemote && hasLocal) {
    let r = await git('rebase', `origin/${branch}`);
    for (let guard = 0; r.code !== 0 && guard < 100; guard++) {
      const conflicted = (await git('diff', '--name-only', '--diff-filter=U')).stdout
        .split('\n').map((s) => s.trim()).filter(Boolean);
      if (conflicted.length === 0) {
        await git('rebase', '--abort');
        result.error = `rebase failed: ${r.stderr.trim()}`;
        return result;
      }
      for (const file of conflicted) await resolveConflict(git, cwd, file, opts.device, result);
      await git('add', '-A');
      r = await git('rebase', '--continue');
    }
    if (r.code !== 0) {
      await git('rebase', '--abort');
      result.error = 'rebase did not finish; local changes kept, nothing pushed';
      return result;
    }
    result.pulled = true;
  }

  for (const layer of await store.listLayers()) await regenerateIndex(store, layer);
  result.pruned = await pruneAllHandoffs(store, now);
  await commitAll(git, `hearth: post-sync maintenance (${opts.device})`);

  if ((await git('rev-parse', '--verify', '-q', 'HEAD')).code !== 0) return result; // nothing to push yet
  const push = await git('push', '-q', '-u', 'origin', `HEAD:${branch}`);
  if (push.code !== 0) {
    result.error = `push failed: ${push.stderr.trim()}`;
    log(result.error);
    return result;
  }
  result.pushed = true;
  return result;
}

async function commitAll(git: Git, message: string): Promise<boolean> {
  await git('add', '-A');
  const staged = await git('diff', '--cached', '--quiet');
  if (staged.code === 0) return false;
  const c = await git('commit', '-q', '-m', message);
  return c.code === 0;
}

async function resolveConflict(git: Git, cwd: string, file: string, device: string, result: SyncResult): Promise<void> {
  const base = basename(file);
  if (base !== INDEX_FILE && base.endsWith('.md')) {
    const local = await git('show', `:3:${file}`);
    if (local.code === 0) {
      // Rewrite the frontmatter name to match the conflict-copy filename; otherwise the copy's
      // own "name: <original>" field wins over the filename in parseFact and the index shows a
      // duplicate entry under the original name instead of a flagged "(conflict copy)" entry.
      const conflictName = `${base.slice(0, -3)}.conflict-${device}`;
      const parsed = matter(local.stdout);
      const rewritten = matter.stringify(`${parsed.content.trim()}\n`, { ...parsed.data, name: conflictName });
      const copy = join(cwd, dirname(file), `${conflictName}.md`);
      await writeFile(copy, rewritten, 'utf8');
    }
    result.conflicts.push(file);
  }
  // Upstream keeps the original name; indexes are regenerated after the rebase.
  const keepUpstream = await git('checkout', '--ours', '--', file);
  if (keepUpstream.code !== 0) await git('checkout', '--theirs', '--', file);
}
