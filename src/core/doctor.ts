import { loadConfig } from './config.js';
import type { Exec } from './exec.js';
import { isGitRepo, parseOwnerRepo, remoteUrl } from './git.js';
import { FileStore, findUnsafeEntries } from './store.js';
import { layerId } from './types.js';

export type CheckStatus = 'ok' | 'fail' | 'warn' | 'skip';

export interface Check {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  fix: string | null;
}

export interface DoctorDeps {
  exec: Exec;
  home: string;
  nodeVersion?: string;
  online?: boolean;
}

const mk = (status: CheckStatus) => (id: string, title: string, detail: string, fix: string | null = null): Check => ({ id, title, status, detail, fix });
const ok = mk('ok');
const fail = mk('fail');
const warn = mk('warn');
const skip = mk('skip');

export async function runDoctor(deps: DoctorDeps): Promise<Check[]> {
  const { exec, home } = deps;
  const checks: Check[] = [];

  const nodeVersion = deps.nodeVersion ?? process.version;
  const major = Number(nodeVersion.replace(/^v/, '').split('.')[0]);
  checks.push(major >= 20
    ? ok('node', 'Node.js', nodeVersion)
    : fail('node', 'Node.js', `${nodeVersion} is too old`, 'Install Node 20 or newer from https://nodejs.org (Homebrew: brew install node)'));

  const git = await exec.run('git', ['--version']);
  checks.push(git.code === 0
    ? ok('git', 'git', git.stdout.trim())
    : fail('git', 'git', 'not found', 'Install git (macOS: xcode-select --install, or brew install git)'));

  const claude = await exec.run('claude', ['--version']);
  checks.push(claude.code === 0
    ? ok('claude', 'Claude Code', claude.stdout.trim())
    : fail('claude', 'Claude Code', 'not found on PATH', 'Install Claude Code: https://docs.claude.com/en/docs/claude-code/setup'));

  const gh = await exec.run('gh', ['auth', 'status']);
  if (gh.code === 0) checks.push(ok('gh', 'GitHub CLI', 'installed and logged in'));
  else if (gh.code === 127) checks.push(warn('gh', 'GitHub CLI', 'not installed (optional)', 'Only needed so hearth init can create the memory repo for you: brew install gh && gh auth login. Or run: hearth init --remote <url>'));
  else checks.push(warn('gh', 'GitHub CLI', 'installed but not logged in', 'Run: gh auth login'));

  const cfg = await loadConfig(home);
  if (!cfg) {
    checks.push(fail('config', 'hearthkit config', `no config.json in ${home}`, 'Run: hearth init   (or /hearth:setup inside Claude Code)'));
    return checks;
  }
  checks.push(ok('config', 'hearthkit config', `${home}/config.json (device: ${cfg.device})`));

  const repoOk = await isGitRepo(exec, cfg.memoryDir);
  const remote = repoOk ? await remoteUrl(exec, cfg.memoryDir) : null;
  if (!repoOk || !remote) {
    checks.push(fail('repo', 'memory repo', repoOk ? `${cfg.memoryDir} has no origin remote` : `${cfg.memoryDir} is not a git repo`, 'Run: hearth init'));
    return checks;
  }
  checks.push(ok('repo', 'memory repo', `${cfg.memoryDir} → ${remote}`));

  // visibility check
  const ownerRepo = parseOwnerRepo(remote);
  if (!remote.includes('github.com') || !ownerRepo) {
    checks.push(skip('visibility', 'memory repo is private', 'cannot verify (not a GitHub remote); make sure it is private'));
  } else {
    const { owner, repo } = ownerRepo;
    const visibility = await exec.run('gh', ['repo', 'view', `${owner}/${repo}`, '--json', 'visibility', '--jq', '.visibility']);
    if (visibility.code !== 0) {
      checks.push(skip('visibility', 'memory repo is private', 'cannot verify (GitHub CLI unavailable or offline)'));
    } else {
      const status = visibility.stdout.trim().toUpperCase();
      if (status === 'PRIVATE') {
        checks.push(ok('visibility', 'memory repo is private', 'PRIVATE'));
      } else {
        checks.push(fail('visibility', 'memory repo is private', status, `Make ${owner}/${repo} private in its GitHub settings (Settings → General → Danger Zone → Change visibility).`));
      }
    }
  }

  if (deps.online === false) {
    checks.push(skip('remote', 'remote reachable', 'skipped (offline)'));
  } else {
    const ls = await exec.run('git', ['ls-remote', '--exit-code', '-q', 'origin', 'HEAD'], { cwd: cfg.memoryDir, env: { GIT_TERMINAL_PROMPT: '0' } });
    checks.push(ls.code === 0
      ? ok('remote', 'remote reachable', remote)
      : fail('remote', 'remote reachable', ls.stderr.trim() || 'could not reach origin', `Check your network and git credentials, then: git -C ${cfg.memoryDir} fetch`));
  }

  const status = await exec.run('git', ['status', '--porcelain'], { cwd: cfg.memoryDir });
  const ahead = await exec.run('git', ['rev-list', '--count', '@{u}..HEAD'], { cwd: cfg.memoryDir });
  const dirty = status.stdout.trim().length > 0;
  const unpushed = ahead.code === 0 ? Number(ahead.stdout.trim()) : 0;
  if (ahead.code !== 0) {
    // No upstream yet: git cannot count unpushed commits, so nothing here is provably synced.
    checks.push(warn('pending', 'unsynced changes', 'no upstream branch is configured yet', 'Run: hearth sync'));
  } else if (dirty || unpushed > 0) {
    const parts = [dirty ? 'uncommitted files' : '', unpushed > 0 ? `${unpushed} unpushed commit${unpushed === 1 ? '' : 's'}` : ''].filter(Boolean);
    checks.push(warn('pending', 'unsynced changes', parts.join(' and '), 'Run: hearth sync'));
  } else {
    checks.push(ok('pending', 'unsynced changes', 'none'));
  }

  const store = new FileStore(cfg.memoryDir);
  const conflicts: string[] = [];
  for (const layer of await store.listLayers()) {
    for (const name of await store.listFacts(layer)) if (name.includes('.conflict-')) conflicts.push(`${layerId(layer)}/${name}`);
  }
  checks.push(conflicts.length
    ? warn('conflicts', 'conflicting memory copies', conflicts.join(', '), 'Compare each pair with hearth memory show, then delete the one you do not want: hearth memory delete <layer> <name>')
    : ok('conflicts', 'conflicting memory copies', 'none'));

  // H4: a hostile remote can commit a symlink; writing through one is an arbitrary file write.
  const unsafe = await findUnsafeEntries(cfg.memoryDir);
  checks.push(unsafe.length
    ? fail('symlinks', 'memory files are ordinary files', unsafe.map((p) => `symlink inside memory repo: ${p}`).join(', '),
      `Delete each one (they are not memory and hearthkit refuses to read or write them): git -C ${cfg.memoryDir} rm <path> && hearth sync`)
    : ok('symlinks', 'memory files are ordinary files', 'no symlinks or special files'));

  return checks;
}

export function renderChecks(checks: Check[]): string {
  const icon: Record<CheckStatus, string> = { ok: '✔', fail: '✘', warn: '!', skip: '-' };
  return `${checks.map((c) => `${icon[c.status]} ${c.title}: ${c.detail}${c.fix ? `\n    fix: ${c.fix}` : ''}`).join('\n')}\n`;
}

export function doctorExitCode(checks: Check[]): 0 | 2 {
  return checks.some((c) => c.status === 'fail') ? 2 : 0;
}
