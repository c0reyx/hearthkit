import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync } from 'node:fs';
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
