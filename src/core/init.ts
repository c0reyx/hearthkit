import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defaultConfig, loadConfig, saveConfig, type Config } from './config.js';
import type { Exec } from './exec.js';
import { currentBranch, isGitRepo, parseOwnerRepo, remoteUrl } from './git.js';
import { HearthError } from './types.js';

export interface InitOptions {
  remote?: string;
  allowPublic?: boolean;
  repoName?: string;
}

export interface InitResult {
  memoryDir: string;
  remote: string;
  createdRepo: boolean;
  clonedNow: boolean;
  pushed: boolean;
}

const README = `# hearth memory

Private memory for [hearthkit](https://github.com/c0reyx/hearthkit). One person, one repo.

- \`global/\` — facts true in any project
- \`projects/<slug>/\` — facts about one codebase, plus \`handoffs/\`

One fact per file. \`MEMORY.md\` files are generated; do not edit them by hand.
`;

export async function initMemory(
  exec: Exec,
  home: string,
  opts: InitOptions,
  log: (msg: string) => void = () => undefined,
): Promise<InitResult> {
  const cfg: Config = (await loadConfig(home)) ?? defaultConfig(home);
  const memoryDir = cfg.memoryDir;
  await mkdir(dirname(memoryDir), { recursive: true });
  const env = { GIT_TERMINAL_PROMPT: '0' };
  let createdRepo = false;
  let clonedNow = false;
  let remote: string;

  if (await isGitRepo(exec, memoryDir)) {
    const existing = await remoteUrl(exec, memoryDir);
    if (!existing) {
      throw new HearthError(`${memoryDir} is a git repo without an "origin" remote.\nAdd one: git -C ${memoryDir} remote add origin <url>`, 2);
    }
    remote = existing;
    log(`Using the existing memory repo at ${memoryDir}`);
  } else if (opts.remote) {
    const clone = await exec.run('git', ['clone', '-q', opts.remote, memoryDir], { env });
    if (clone.code !== 0) {
      throw new HearthError(`Could not clone ${opts.remote}: ${clone.stderr.trim()}\nCheck the URL and that this machine can authenticate to it.`, 2);
    }
    remote = opts.remote;
    clonedNow = true;
    log(`Cloned ${opts.remote} to ${memoryDir}`);
  } else {
    const auth = await exec.run('gh', ['auth', 'status']);
    if (auth.code === 127) {
      throw new HearthError(
        'GitHub CLI (gh) is not installed, so hearth cannot create a repo for you.\nEither install it (brew install gh; gh auth login) or create a private repo yourself and run: hearth init --remote <url>',
        2,
      );
    }
    if (auth.code !== 0) throw new HearthError('GitHub CLI is not logged in. Run: gh auth login   then re-run hearth init', 2);
    const name = opts.repoName ?? 'hearth-memory';
    const create = await exec.run('gh', ['repo', 'create', name, '--private', '--description', 'hearthkit memory (private, one person)']);
    if (create.code !== 0 && !/already exists/i.test(create.stderr)) {
      throw new HearthError(`gh repo create failed: ${create.stderr.trim()}`, 2);
    }
    createdRepo = create.code === 0;
    const view = await exec.run('gh', ['repo', 'view', name, '--json', 'nameWithOwner', '--jq', '.nameWithOwner']);
    if (view.code !== 0) throw new HearthError(`Could not look up ${name} on GitHub: ${view.stderr.trim()}`, 2);
    const nameWithOwner = view.stdout.trim();
    const clone = await exec.run('gh', ['repo', 'clone', nameWithOwner, memoryDir]);
    if (clone.code !== 0) throw new HearthError(`Could not clone ${nameWithOwner}: ${clone.stderr.trim()}`, 2);
    clonedNow = true;
    remote = (await remoteUrl(exec, memoryDir)) ?? `https://github.com/${nameWithOwner}.git`;
    log(`${createdRepo ? 'Created' : 'Found'} ${nameWithOwner} and cloned it to ${memoryDir}`);
  }

  await assertPrivate(exec, remote, opts.allowPublic === true);
  await ensureStructure(memoryDir);

  const git = (...args: string[]) => exec.run('git', args, { cwd: memoryDir, env });
  const branch = await currentBranch(exec, memoryDir);
  if (!branch || branch === 'HEAD') await git('checkout', '-q', '-B', 'main');
  await git('add', '-A');
  if ((await git('diff', '--cached', '--quiet')).code !== 0) await git('commit', '-q', '-m', 'hearth: initialise memory repo');
  const push = await git('push', '-q', '-u', 'origin', 'HEAD');
  if (push.code !== 0) log(`Warning: could not push yet (${push.stderr.trim() || 'no details'}). hearth sync will retry.`);

  await saveConfig(home, { ...cfg, remote });
  return { memoryDir, remote, createdRepo, clonedNow, pushed: push.code === 0 };
}

async function assertPrivate(exec: Exec, remote: string, allowPublic: boolean): Promise<void> {
  if (allowPublic || !/github\.com/i.test(remote)) return;
  const parsed = parseOwnerRepo(remote);
  if (!parsed) return;
  const r = await exec.run('gh', ['repo', 'view', `${parsed.owner}/${parsed.repo}`, '--json', 'visibility', '--jq', '.visibility']);
  if (r.code !== 0) return; // gh missing or offline: cannot verify here; doctor will report
  const vis = r.stdout.trim().toUpperCase();
  if (vis && vis !== 'PRIVATE') {
    throw new HearthError(
      `${parsed.owner}/${parsed.repo} is ${vis}. Memory must be private.\nMake it private in the GitHub repo settings, or pass --allow-public if you really mean it.`,
    );
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function ensureStructure(dir: string): Promise<void> {
  for (const rel of ['global/.gitkeep', 'projects/.gitkeep']) {
    const p = join(dir, rel);
    if (!(await exists(p))) {
      await mkdir(dirname(p), { recursive: true });
      await writeFile(p, '', 'utf8');
    }
  }
  const readme = join(dir, 'README.md');
  if (!(await exists(readme))) await writeFile(readme, README, 'utf8');
}
