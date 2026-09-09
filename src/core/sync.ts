import { basename, dirname, join } from 'node:path';
import type { Exec, ExecResult } from './exec.js';
import { parseFrontmatter, stringifyFrontmatter } from './frontmatter.js';
import { currentBranch } from './git.js';
import { pruneAllHandoffs } from './handoff.js';
import { regenerateIndex } from './memory.js';
import { INDEX_FILE, findUnsafeEntries, writeInsideRoot, type FileStore } from './store.js';

export interface SyncResult {
  committed: boolean;
  pulled: boolean;
  pushed: boolean;
  conflicts: string[];
  /** Files where a modify/delete conflict was settled in favour of the surviving edit. */
  resolved: string[];
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
  const result: SyncResult = { committed: false, pulled: false, pushed: false, conflicts: [], resolved: [], pruned: [], error: null };
  const git: Git = (...args) => exec.run('git', args, { cwd, env: GIT_ENV });

  const firstCommit = await commitAll(git, `hearth: ${opts.device} ${now.toISOString()}`);
  result.committed = firstCommit.committed;
  if (firstCommit.error) {
    // A failed commit used to be silently ignored, which both stopped memory from ever leaving
    // the machine and left the repo without a HEAD — the precondition for the destructive
    // reset below. Stop here: fetch, reset and push must not run.
    result.error = firstCommit.error;
    log(result.error);
    return result;
  }
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
    // `reset --hard` deletes anything not in that commit. With no local commits, everything in
    // the working tree is by definition unpushed, so refuse rather than discard it.
    const dirty = (await git('status', '--porcelain')).stdout.trim();
    if (dirty) {
      result.error =
        `refusing to check out origin/${branch} over uncommitted files in ${cwd}: ` +
        `${dirty.split('\n').slice(0, 5).join('; ')}. Commit or move them, then run hearth sync again.`;
      log(result.error);
      return result;
    }
    const reset = await git('reset', '-q', '--hard', `origin/${branch}`);
    if (reset.code !== 0) {
      result.error = `could not check out origin/${branch}: ${reset.stderr.trim()}`;
      log(result.error);
      return result;
    }
    result.pulled = true;
  } else if (hasRemote && hasLocal) {
    // Anything thrown in here (a failed conflict-copy write, say) would otherwise leave the
    // clone mid-rebase, so abort and report instead of letting the error escape.
    try {
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
    } catch (err) {
      await git('rebase', '--abort');
      result.error = `rebase failed: ${err instanceof Error ? err.message : String(err)}`;
      return result;
    }
    result.pulled = true;
  }

  // A pull can introduce symlinks (H4). Audit before anything is parsed, rendered or written.
  const unsafe = await findUnsafeEntries(cwd);
  if (unsafe.length) {
    result.error =
      `${unsafe.map((p) => `symlink inside memory repo: ${p}`).join(', ')}. ` +
      `Nothing was parsed or pushed. Delete them (git -C ${cwd} rm <path>) and run hearth sync again.`;
    log(result.error);
    return result;
  }

  for (const layer of await store.listLayers()) await regenerateIndex(store, layer);
  result.pruned = await pruneAllHandoffs(store, now);
  const maintenance = await commitAll(git, `hearth: post-sync maintenance (${opts.device})`);
  if (maintenance.error) {
    result.error = maintenance.error;
    log(result.error);
    return result;
  }

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

export interface CommitResult {
  committed: boolean;
  /** Set only for a real failure; "nothing to commit" is not one. */
  error: string | null;
}

const NOTHING_TO_COMMIT = /nothing to commit|nothing added to commit|no changes added to commit/i;

async function commitAll(git: Git, message: string): Promise<CommitResult> {
  await git('add', '-A');
  const staged = await git('diff', '--cached', '--quiet');
  if (staged.code === 0) return { committed: false, error: null };
  const c = await git('commit', '-q', '-m', message);
  if (c.code === 0) return { committed: true, error: null };
  const output = `${c.stderr}\n${c.stdout}`;
  if (NOTHING_TO_COMMIT.test(output)) return { committed: false, error: null };
  const detail = c.stderr.trim() || c.stdout.trim() || `git commit exited ${c.code}`;
  return { committed: false, error: `commit failed: ${detail.split('\n').filter(Boolean).join(' ')}` };
}

async function resolveConflict(git: Git, cwd: string, file: string, device: string, result: SyncResult): Promise<void> {
  const base = basename(file);
  const upstream = await git('show', `:2:${file}`);
  const local = await git('show', `:3:${file}`);
  const editedOnBothSides = upstream.code === 0 && local.code === 0;

  if (!editedOnBothSides) {
    // Modify/delete: one side deleted the file, the other edited it. Memory prefers keeping
    // text, so the surviving edit wins under the original name and no copy is made.
    await keepSurvivingSide(git, file);
    result.resolved.push(file);
    return;
  }

  if (base !== INDEX_FILE && base.endsWith('.md')) {
    // Rewrite the frontmatter name to match the conflict-copy filename; otherwise the copy's
    // own "name: <original>" field wins over the filename in parseFact and the index shows a
    // duplicate entry under the original name instead of a flagged "(conflict copy)" entry.
    const conflictName = `${base.slice(0, -3)}.conflict-${device}`;
    const parsed = parseFrontmatter(local.stdout);
    const rewritten = stringifyFrontmatter(`${parsed.content.trim()}\n`, { ...parsed.data, name: conflictName });
    const copy = join(cwd, dirname(file), `${conflictName}.md`);
    // Guarded like every other write: the copy's name could itself have been planted as a symlink.
    await writeInsideRoot(cwd, copy, rewritten);
    result.conflicts.push(file);
  }
  // Upstream keeps the original name; indexes are regenerated after the rebase.
  await keepSurvivingSide(git, file);
}

async function keepSurvivingSide(git: Git, file: string): Promise<void> {
  const ours = await git('checkout', '--ours', '--', file);
  if (ours.code !== 0) await git('checkout', '--theirs', '--', file);
}
