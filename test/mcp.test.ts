import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultConfig, saveConfig } from '../src/core/config.js';
import { FakeExec } from '../src/core/exec.js';
import { FileStore } from '../src/core/store.js';
import { createMcpServer } from '../src/mcp/server.js';
import { mkTmpDir } from './helpers/tmp.js';

const EXPECTED_TOOLS = [
  'hearth_doctor', 'hearth_init', 'hearth_sync',
  'memory_handoff', 'memory_list', 'memory_promote', 'memory_read', 'memory_search', 'memory_write',
];

function textOf(result: unknown): string {
  const r = result as { content: { type: string; text?: string }[]; isError?: boolean };
  return r.content.map((c) => c.text ?? '').join('\n');
}

describe('MCP server', () => {
  const tmp = mkTmpDir();
  afterEach(() => tmp.cleanup());

  async function connected() {
    const home = join(tmp.dir, 'home');
    await saveConfig(home, { ...defaultConfig(home), device: 'mac' });
    const exec = new FakeExec()
      .on('git', ['remote', 'get-url', 'origin'], { stdout: 'git@github.com:acme/crm.git\n' })
      .on('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdout: 'main\n' });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = createMcpServer({ exec, home, cwd: '/repo', now: () => new Date('2026-09-06T15:30:00Z') });
    await server.connect(serverT);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientT);
    return { client, home, store: new FileStore(join(home, 'memory')) };
  }

  it('lists the nine tools', async () => {
    const { client } = await connected();
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(EXPECTED_TOOLS);
  });

  it('write, list, read, search, promote, handoff round trip', async () => {
    const { client } = await connected();
    let r = await client.callTool({ name: 'memory_write', arguments: { layer: 'global', text: 'Corey prefers tables.', type: 'user' } });
    expect(textOf(r)).toBe('Saved global/corey-prefers-tables.md');
    r = await client.callTool({ name: 'memory_write', arguments: { layer: 'project', text: 'Use pnpm here.', name: 'pnpm', pinned: true } });
    expect(textOf(r)).toBe('Saved projects/acme-crm/pnpm.md');
    expect(textOf(await client.callTool({ name: 'memory_list', arguments: { layer: 'project' } }))).toContain('- pnpm: Use pnpm here. [reference, pinned]');
    expect(textOf(await client.callTool({ name: 'memory_read', arguments: { layer: 'global', name: 'corey-prefers-tables' } }))).toContain('type: user');
    expect(textOf(await client.callTool({ name: 'memory_search', arguments: { query: 'pnpm' } }))).toContain('projects/acme-crm/pnpm');
    expect(textOf(await client.callTool({ name: 'memory_promote', arguments: { name: 'pnpm' } }))).toBe('Promoted pnpm to global.');
    r = await client.callTool({ name: 'memory_handoff', arguments: { working_on: 'Retry logic', next_steps: 'test 429s' } });
    expect(textOf(r)).toBe('Wrote handoff projects/acme-crm/handoffs/2026-09-06-1530-mac.md');
  });

  it('returns isError results with the HearthError message instead of throwing', async () => {
    const { client } = await connected();
    const r = (await client.callTool({ name: 'memory_read', arguments: { layer: 'global', name: 'nope' } })) as { isError?: boolean };
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('No fact "nope" in global.');
  });

  it('hearth_doctor returns the checks as JSON', async () => {
    const { client } = await connected();
    const checks = JSON.parse(textOf(await client.callTool({ name: 'hearth_doctor', arguments: {} }))) as { id: string }[];
    expect(checks.map((c) => c.id)).toContain('config');
  });

  it('dist/mcp.js speaks MCP over stdio', async () => {
    const home = join(tmp.dir, 'home-stdio');
    await saveConfig(home, defaultConfig(home));
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'dist', 'mcp.js')], env: { ...process.env, HEARTH_HOME: home } as Record<string, string> });
    const client = new Client({ name: 'smoke', version: '0.0.0' });
    await client.connect(transport);
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    await client.close();
  });
});
