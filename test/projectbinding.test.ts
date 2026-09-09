import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildProgram, runCli, type CliDeps } from '../src/cli/program.js';
import { defaultConfig, saveConfig } from '../src/core/config.js';
import { RealExec } from '../src/core/exec.js';
import { canonicalPath } from '../src/core/project.js';
import { createMcpServer } from '../src/mcp/server.js';
import { mkTmpDir } from './helpers/tmp.js';

const exec = new RealExec();
const NOW = new Date('2026-09-09T12:00:00Z');

async function hearth(home: string, cwd: string, argv: string[], input = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    exec, home, cwd, env: {},
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    readStdin: async () => input,
    spawnDetached: () => undefined,
    now: () => NOW,
  };
  const code = await runCli(buildProgram(deps), ['node', 'hearth', ...argv], (s) => err.push(s));
  return { code, stdout: out.join(''), stderr: err.join('') };
}

function textOf(result: unknown): string {
  return (result as { content: { text?: string }[] }).content.map((c) => c.text ?? '').join('\n');
}

async function mcpClient(home: string, cwd: string): Promise<Client> {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ exec, home, cwd, now: () => NOW });
  await server.connect(serverT);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientT);
  return client;
}

/**
 * H1: the project layer used to be chosen by the `origin` URL of whatever repository the
 * session happened to be sitting in, and `.git/config` is attacker-controlled content in any
 * repo you clone. Slugs are still derived from origin (so two machines agree), but each slug is
 * now bound to one directory per machine.
 */
describe('project binding (H1)', () => {
  const tmp = mkTmpDir();
  const home = join(tmp.dir, 'home');
  const real = join(tmp.dir, 'real-crm');
  const hostile = join(tmp.dir, 'hostile');

  beforeAll(async () => {
    await saveConfig(home, { ...defaultConfig(home), device: 'mac' });
    for (const dir of [real, hostile]) {
      await exec.run('git', ['init', '-q', dir]);
      // Both repos claim to be acme/crm; only one of them is the checkout you work in.
      await exec.run('git', ['remote', 'add', 'origin', 'git@github.com:acme/crm.git'], { cwd: dir });
    }
    await hearth(home, real, ['memory', 'add', 'project', 'Prod DB host is db.internal:5432.', '--name', 'prod-db', '--pin']);
    await hearth(home, real, ['handoff', 'write', '--working-on', 'Retry logic for 429s']);
  });
  afterAll(() => tmp.cleanup());

  it('does not disclose the bound checkout\'s facts or handoff to another repo with the same origin', async () => {
    const ctx = await hearth(home, hostile, ['memory', 'context'], JSON.stringify({ cwd: hostile }));
    expect(ctx.code).toBe(0);
    expect(ctx.stdout).not.toContain('prod-db');
    expect(ctx.stdout).not.toContain('db.internal');
    expect(ctx.stdout).not.toContain('Retry logic for 429s');
    expect(ctx.stdout).toContain('is not linked');
    expect(ctx.stdout).toContain('hearth project link');
  });

  it('refuses CLI and MCP writes to the project layer from an unlinked checkout', async () => {
    const add = await hearth(home, hostile, ['memory', 'add', 'project', 'planted by the hostile repo', '--name', 'planted']);
    expect(add.code).toBe(1);
    expect(add.stderr).toContain('is not linked');

    const client = await mcpClient(home, hostile);
    const write = (await client.callTool({ name: 'memory_write', arguments: { layer: 'project', text: 'planted via MCP', name: 'planted-mcp' } })) as { isError?: boolean };
    expect(write.isError).toBe(true);
    expect(textOf(write)).toContain('is not linked');
    const handoff = (await client.callTool({ name: 'memory_handoff', arguments: { working_on: 'planted handoff' } })) as { isError?: boolean };
    expect(handoff.isError).toBe(true);
    await client.close();

    const list = await hearth(home, real, ['memory', 'context'], JSON.stringify({ cwd: real }));
    expect(list.stdout).not.toContain('planted');
  });

  it('project show reports the binding, and project link hands the layer to this checkout', async () => {
    const show = await hearth(home, hostile, ['project', 'show']);
    expect(show.stdout).toContain('slug:        acme-crm');
    expect(show.stdout).toContain(`bound to:    ${await canonicalPath(real)}`);
    expect(show.stdout).toContain('NOT linked');
    expect(show.stdout).toContain('this checkout at');

    const link = await hearth(home, hostile, ['project', 'link']);
    expect(link.code, link.stderr).toBe(0);
    expect(link.stdout).toContain(`Linked acme-crm to ${await canonicalPath(hostile)}`);
    expect(link.stdout).toContain(`Was bound to ${await canonicalPath(real)}`);

    const ctx = await hearth(home, hostile, ['memory', 'context'], JSON.stringify({ cwd: hostile }));
    expect(ctx.stdout).toContain('db.internal');
    expect(ctx.stdout).toContain('Retry logic for 429s');

    // The moved-checkout case: same slug, different path, so the old directory now needs linking.
    const moved = await hearth(home, real, ['memory', 'context'], JSON.stringify({ cwd: real }));
    expect(moved.stdout).toContain('is not linked');
    expect(moved.stdout).not.toContain('db.internal');
    await hearth(home, real, ['project', 'link']);
    expect((await hearth(home, real, ['memory', 'context'], JSON.stringify({ cwd: real }))).stdout).toContain('db.internal');

    const bindings = JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8')) as Record<string, { path: string }>;
    expect(bindings['acme-crm']?.path).toBe(await canonicalPath(real));
  });

  it('still loads the project layer in the linked checkout, and global memory everywhere', async () => {
    await hearth(home, real, ['memory', 'add', 'global', 'Corey prefers tables.', '--name', 'likes-tables']);
    const good = await hearth(home, real, ['memory', 'context'], JSON.stringify({ cwd: real }));
    expect(good.stdout).toContain('db.internal');
    expect(good.stdout).toContain('Retry logic for 429s');
    const bad = await hearth(home, hostile, ['memory', 'context'], JSON.stringify({ cwd: hostile }));
    expect(bad.stdout).toContain('- likes-tables:');
  });

  it('binds the no-remote fallback slug too, so two unrelated folders of the same name do not share a layer', async () => {
    const one = join(tmp.dir, 'one', 'api');
    const two = join(tmp.dir, 'two', 'api');
    for (const dir of [one, two]) await exec.run('git', ['init', '-q', dir]);
    await hearth(home, one, ['memory', 'add', 'project', 'first api', '--name', 'first']);
    const refused = await hearth(home, two, ['memory', 'add', 'project', 'second api', '--name', 'second']);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('Project memory for api is bound to');
    expect((await hearth(home, two, ['memory', 'context'], JSON.stringify({ cwd: two }))).stdout).not.toContain('first api');
  });
});

/**
 * Round 1: two bypasses the independent review verified against the first H1 fix.
 */
describe('project binding closes the first-sight and explicit-slug bypasses (H1)', () => {
  const tmp = mkTmpDir();
  const home = join(tmp.dir, 'home');
  const memory = join(home, 'memory');
  const hostile = join(tmp.dir, 'hostile');

  beforeAll(async () => {
    await saveConfig(home, { ...defaultConfig(home), device: 'mac' });
    // A layer that arrived over sync: present on disk, not yet bound to any folder here.
    mkdirSync(join(memory, 'projects', 'acme-crm', 'handoffs'), { recursive: true });
    writeFileSync(
      join(memory, 'projects', 'acme-crm', 'prod-db.md'),
      '---\nname: prod-db\ndescription: Prod DB host\nmetadata:\n  pinned: true\n---\nProd DB host is db.internal:5432.\n',
    );
    writeFileSync(
      join(memory, 'projects', 'acme-crm', 'handoffs', '2026-09-08-1000-other.md'),
      '---\ndevice: other\nsource: agent\nsession: s\nbranch: main\ntimestamp: 2026-09-08T10:00:00.000Z\n---\n## Working on\nRetry logic for 429s\n',
    );
    await exec.run('git', ['init', '-q', hostile]);
    await exec.run('git', ['remote', 'add', 'origin', 'git@github.com:acme/crm.git'], { cwd: hostile });
  });
  afterAll(() => tmp.cleanup());

  it('never auto-binds a slug whose layer already holds memory on this machine', async () => {
    const ctx = await hearth(home, hostile, ['memory', 'context'], JSON.stringify({ cwd: hostile }));
    expect(ctx.code).toBe(0);
    expect(ctx.stdout).not.toContain('db.internal');
    expect(ctx.stdout).not.toContain('Retry logic for 429s');
    expect(ctx.stdout).toContain('already has memory on this machine but is not linked');
    expect(ctx.stdout).toContain('hearth project link');
    // Nothing may have been recorded, so the real checkout can still claim the slug.
    expect(existsSync(join(home, 'projects.json'))).toBe(false);
  });

  it('refuses an explicit projects/<slug> layer over MCP from an unlinked checkout', async () => {
    const client = await mcpClient(home, hostile);
    for (const call of [
      { name: 'memory_list', arguments: { layer: 'projects/acme-crm' } },
      { name: 'memory_read', arguments: { layer: 'projects/acme-crm', name: 'prod-db' } },
      { name: 'memory_write', arguments: { layer: 'projects/acme-crm', text: 'planted', name: 'planted' } },
      { name: 'memory_promote', arguments: { name: 'prod-db', from_project: 'acme-crm' } },
    ]) {
      const r = (await client.callTool(call)) as { isError?: boolean };
      expect(r.isError, `${call.name} should be refused`).toBe(true);
      expect(textOf(r)).toMatch(/not linked|already has memory/);
    }
    await client.close();
    expect(existsSync(join(memory, 'projects', 'acme-crm', 'planted.md'))).toBe(false);
    expect(existsSync(join(memory, 'global', 'prod-db.md'))).toBe(false);
  });
});

/**
 * Round 1 (H4): a hostile entry must degrade to a message, not kill the command. The CLI
 * harness above is reused here because these are whole-command behaviours.
 */
describe('CLI degrades on unsafe memory entries (H4)', () => {
  const tmp = mkTmpDir();
  const home = join(tmp.dir, 'home');
  const memory = join(home, 'memory');
  const repo = join(tmp.dir, 'repo');

  beforeAll(async () => {
    await saveConfig(home, { ...defaultConfig(home), device: 'mac' });
    mkdirSync(join(memory, 'global'), { recursive: true });
    writeFileSync(join(memory, 'global', 'good.md'), '---\ndescription: a real fact\n---\nbody\n');
    writeFileSync(join(tmp.dir, 'victim-rc'), 'original\n');
    symlinkSync(join(tmp.dir, 'victim-rc'), join(memory, 'global', 'evil.md'));
    await exec.run('git', ['init', '-q', repo]);
  });
  afterAll(() => tmp.cleanup());

  it('memory context still renders, says entries were ignored, and quotes no paths', async () => {
    const ctx = await hearth(home, repo, ['memory', 'context'], JSON.stringify({ cwd: repo }));
    expect(ctx.code).toBe(0);
    expect(ctx.stdout).toContain('- good: a real fact');
    expect(ctx.stdout).toContain('<hearth-status>');
    expect(ctx.stdout).toContain('not an ordinary file');
    expect(ctx.stdout).toContain('run `hearth doctor`');
    expect(ctx.stdout).not.toContain('victim-rc');
  });

  it('hearth list flags the entry and hearth memory delete can clear it', async () => {
    const list = await hearth(home, repo, ['list']);
    expect(list.code, list.stderr).toBe(0);
    expect(list.stdout).toContain('global/evil.md');
    const del = await hearth(home, repo, ['memory', 'delete', 'global', 'evil']);
    expect(del.code, del.stderr).toBe(0);
    expect(existsSync(join(memory, 'global', 'evil.md'))).toBe(false);
    expect(readFileSync(join(tmp.dir, 'victim-rc'), 'utf8')).toBe('original\n');
  });
});
