import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePayload } from '../src/cli/program.js';
import { RealExec } from '../src/core/exec.js';
import { makeBareRemote } from './helpers/gitrepo.js';
import { mkTmpDir } from './helpers/tmp.js';

const BIN = join(process.cwd(), 'dist', 'hearth.js');

function hearth(args: string[], opts: { home: string; cwd?: string; input?: string }) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, HEARTH_HOME: opts.home, HEARTH_NO_BACKGROUND_SYNC: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

describe('hearth CLI (end to end against a local bare remote)', () => {
  const tmp = mkTmpDir();
  const home = join(tmp.dir, 'home');
  const crm = join(tmp.dir, 'crm');
  const site = join(tmp.dir, 'site');
  let remote = '';
  const exec = new RealExec();

  beforeAll(async () => {
    remote = await makeBareRemote(tmp.dir);
    await exec.run('git', ['init', '-q', crm]);
    await exec.run('git', ['remote', 'add', 'origin', 'git@github.com:acme/crm.git'], { cwd: crm });
    await exec.run('git', ['init', '-q', site]);
    await exec.run('git', ['remote', 'add', 'origin', 'git@github.com:acme/site.git'], { cwd: site });
  });
  afterAll(() => tmp.cleanup());

  it('where works before setup; list explains how to set up', async () => {
    const w = await hearth(['where'], { home, cwd: crm });
    expect(w.code).toBe(0);
    expect(w.stdout).toContain('project slug: acme-crm');
    expect(w.stdout).toContain('· config');
    const l = await hearth(['list'], { home });
    expect(l.code).toBe(2);
    expect(l.stderr).toContain('hearth init');
  });

  it('init with --remote clones and configures', async () => {
    const r = await hearth(['init', '--remote', remote], { home });
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain('Pushed the initial commit.');
    expect(existsSync(join(home, 'config.json'))).toBe(true);
    expect(existsSync(join(home, 'memory', 'global', '.gitkeep'))).toBe(true);
  });

  it('memory add/show/search/promote and handoff write/list', async () => {
    let r = await hearth(['memory', 'add', 'global', 'Corey prefers tables.', '--type', 'user'], { home });
    expect(r.stdout).toContain('Saved global/corey-prefers-tables.md');
    r = await hearth(['memory', 'add', 'project', 'Use pnpm in this repo.', '--name', 'pnpm', '--pin'], { home, cwd: crm });
    expect(r.stdout).toContain('Saved projects/acme-crm/pnpm.md');
    r = await hearth(['memory', 'show', 'global', 'corey-prefers-tables'], { home });
    expect(r.stdout).toContain('type: user');
    r = await hearth(['memory', 'search', 'pnpm'], { home, cwd: crm });
    expect(r.stdout).toContain('projects/acme-crm/pnpm');
    r = await hearth(['memory', 'promote', 'pnpm'], { home, cwd: crm });
    expect(r.stdout).toContain('Promoted pnpm from projects/acme-crm to global.');
    expect((await hearth(['memory', 'show', 'global', 'pnpm'], { home })).code).toBe(0);
    r = await hearth(['handoff', 'write', '--working-on', 'Retry logic for 429s', '--next-steps', 'test with 500 rows'], { home, cwd: crm });
    expect(r.stdout).toContain('Wrote handoff projects/acme-crm/handoffs/');
    r = await hearth(['handoff', 'list'], { home, cwd: crm });
    expect(r.stdout).toContain('agent');
    expect(r.stdout).toContain('Retry logic for 429s');
    r = await hearth(['list'], { home });
    expect(r.stdout).toMatch(/global\s+2 facts/);
    expect(r.stdout).toMatch(/projects\/acme-crm\s+0 facts\s+1 handoffs/);
  });

  it('sync pushes to the remote and doctor reports config and repo ok', async () => {
    const s = await hearth(['sync'], { home });
    expect(s.code, s.stderr).toBe(0);
    expect(s.stdout).toContain('Synced.');
    const log = await exec.run('git', ['log', '--oneline'], { cwd: remote });
    expect(log.stdout).toMatch(/hearth: /);
    // A background (--quiet) sync prints nothing, so its outcome has to reach the log.
    const q = await hearth(['sync', '--quiet'], { home });
    expect(q.code, q.stderr).toBe(0);
    expect(q.stdout).toBe('');
    expect(readFileSync(join(home, 'logs', 'hearth.log'), 'utf8')).toContain('"command":"sync"');
    const d = await hearth(['doctor', '--offline', '--json'], { home });
    const checks = JSON.parse(d.stdout) as { id: string; status: string }[];
    const byId = Object.fromEntries(checks.map((c) => [c.id, c.status]));
    expect(byId.config).toBe('ok');
    expect(byId.repo).toBe('ok');
    expect(byId.pending).toBe('ok');
    expect([0, 2]).toContain(d.code); // 2 only when claude/git are absent on this machine
  });

  it('bad input is a user error with a helpful message', async () => {
    const r = await hearth(['memory', 'add', 'bogus', 'x'], { home });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Unknown layer "bogus"');
    const t = await hearth(['memory', 'add', 'global', 'x', '--type', 'nope'], { home });
    expect(t.code).toBe(1);
    expect(t.stderr).toContain('Unknown type');
  });

  it('memory context prints a setup hint when not configured, and the context block when configured', async () => {
    const fresh = join(tmp.dir, 'fresh-home');
    const hint = await hearth(['memory', 'context'], { home: fresh, input: JSON.stringify({ cwd: crm }) });
    expect(hint.code).toBe(0);
    expect(hint.stdout).toContain('/hearth:setup');
    const ctx = await hearth(['memory', 'context'], { home, input: JSON.stringify({ cwd: crm, hook_event_name: 'SessionStart' }) });
    expect(ctx.code).toBe(0);
    expect(ctx.stdout.startsWith('# hearthkit memory')).toBe(true);
    expect(ctx.stdout).toContain('Retry logic for 429s');
    expect(ctx.stdout).toContain('"projects/acme-crm"');
  });

  it('handoff capture stores an automatic handoff from a transcript and never fails the hook', async () => {
    const transcript = join(process.cwd(), 'test', 'fixtures', 'transcripts', 'normal.jsonl');
    const r = await hearth(['handoff', 'capture'], { home, input: JSON.stringify({ session_id: 'sess-1', transcript_path: transcript, cwd: site, hook_event_name: 'SessionEnd' }) });
    expect(r.code).toBe(0);
    const list = await hearth(['handoff', 'list'], { home, cwd: site });
    expect(list.stdout).toContain('auto');
    expect(list.stdout).not.toContain('SECRET_FILE_CONTENTS');
    const log = readFileSync(join(home, 'logs', 'hearth.log'), 'utf8');
    expect(log).toContain('"command":"handoff capture"');
    const bad = await hearth(['handoff', 'capture'], { home, input: 'not json at all' });
    expect(bad.code).toBe(0);
  });

  it('handoff capture defers to the agent handoff written for this project minutes ago', async () => {
    const transcript = join(process.cwd(), 'test', 'fixtures', 'transcripts', 'normal.jsonl');
    const r = await hearth(['handoff', 'capture'], { home, input: JSON.stringify({ session_id: 'sess-2', transcript_path: transcript, cwd: crm, hook_event_name: 'SessionEnd' }) });
    expect(r.code).toBe(0);
    const list = await hearth(['handoff', 'list'], { home, cwd: crm });
    expect(list.stdout).not.toContain('auto');
  });
});

describe('parsePayload', () => {
  it('returns empty object for empty, non-JSON, non-object, and null inputs', () => {
    expect(parsePayload('')).toEqual({});
    expect(parsePayload('not json')).toEqual({});
    expect(parsePayload('[1,2,3]')).toEqual({});
    expect(parsePayload('null')).toEqual({});
    expect(parsePayload('42')).toEqual({});
  });

  it('returns the parsed object for valid JSON objects', () => {
    expect(parsePayload('{"cwd":"/x","session_id":"s"}')).toEqual({ cwd: '/x', session_id: 's' });
  });
});
