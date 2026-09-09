import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { requireConfig } from '../core/config.js';
import { runDoctor } from '../core/doctor.js';
import type { Exec } from '../core/exec.js';
import { currentBranch } from '../core/git.js';
import { writeHandoff } from '../core/handoff.js';
import { initMemory } from '../core/init.js';
import { listFacts, promoteFact, renderIndex, writeFact } from '../core/memory.js';
import { assertLinked, resolveProject, type ProjectRef } from '../core/project.js';
import { search } from '../core/search.js';
import { FileStore } from '../core/store.js';
import { syncRepo } from '../core/sync.js';
import { HearthError, layerId, parseLayerId, project, type LayerRef } from '../core/types.js';

export interface McpDeps {
  exec: Exec;
  home: string;
  cwd: string;
  now?: () => Date;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

async function guarded(fn: () => Promise<string>): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: await fn() }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
  }
}

const LAYER_DESC =
  'Layer: "global" for facts true in any repo (who the user is, preferences, environment), "project" for the current codebase, or "projects/<slug>" for a specific one.';

export function createMcpServer(deps: McpDeps): McpServer {
  const server = new McpServer({ name: 'hearth', version: '0.1.0' });
  const now = () => deps.now?.() ?? new Date();

  const open = async () => {
    const cfg = await requireConfig(deps.home);
    const ref = await resolveProject({ exec: deps.exec, home: deps.home, cwd: deps.cwd, now: deps.now?.() });
    return { cfg, store: new FileStore(cfg.memoryDir), slug: ref.slug, ref };
  };
  // "project" means "the layer bound to this directory on this machine": a checkout that merely
  // claims another project's origin URL gets no access to it (H1). Linking is human-only, via
  // `hearth project link`; there is deliberately no MCP tool for it.
  const layerOf = (layer: string, ref: ProjectRef): LayerRef => {
    if (layer !== 'project') return parseLayerId(layer);
    assertLinked(ref);
    return project(ref.slug);
  };

  server.registerTool(
    'memory_search',
    {
      description: 'Search hearthkit memory (global and current-project facts and handoffs) by keywords. Use it before asking the user something they may have told you before.',
      inputSchema: { query: z.string().describe('keywords to look for') },
    },
    ({ query }) => guarded(async () => {
      const { store, ref } = await open();
      const hits = await search(store, query, ref.linked ? ref.slug : null);
      return hits.length ? hits.map((h) => `${h.layer}/${h.name} (${h.kind}, score ${h.score}): ${h.description}`).join('\n') : 'No matches.';
    }),
  );

  server.registerTool(
    'memory_list',
    { description: `List the facts in one memory layer. ${LAYER_DESC}`, inputSchema: { layer: z.string() } },
    ({ layer }) => guarded(async () => {
      const { store, ref } = await open();
      const l = layerOf(layer, ref);
      return renderIndex(l, await listFacts(store, l));
    }),
  );

  server.registerTool(
    'memory_read',
    { description: `Read one fact in full. ${LAYER_DESC}`, inputSchema: { layer: z.string(), name: z.string() } },
    ({ layer, name }) => guarded(async () => {
      const { store, ref } = await open();
      const l = layerOf(layer, ref);
      const raw = await store.readFact(l, name);
      if (raw === null) throw new HearthError(`No fact "${name}" in ${layerId(l)}.`);
      return raw;
    }),
  );

  server.registerTool(
    'memory_write',
    {
      description: `Save a durable fact worth remembering in future sessions (not task chatter). ${LAYER_DESC} Rule of thumb: if it would still be true in a different repo, it belongs in "global".`,
      inputSchema: {
        layer: z.string(),
        text: z.string().describe('the fact, one to three sentences'),
        name: z.string().optional().describe('kebab-case id; derived from the text if omitted'),
        type: z.enum(['user', 'feedback', 'project', 'reference']).optional(),
        pinned: z.boolean().optional().describe('true to include the full text at every session start; use sparingly'),
      },
    },
    ({ layer, text, name, type, pinned }) => guarded(async () => {
      const { cfg, store, ref } = await open();
      const l = layerOf(layer, ref);
      const f = await writeFact(store, { layer: l, text, name, type, pinned, device: cfg.device, now: now() });
      return `Saved ${layerId(l)}/${f.name}.md`;
    }),
  );

  server.registerTool(
    'memory_promote',
    {
      description: 'Move a fact from the current project layer to global because it turned out to be generally true.',
      inputSchema: { name: z.string(), from_project: z.string().optional().describe('project slug; defaults to the current project') },
    },
    ({ name, from_project }) => guarded(async () => {
      const { store, slug, ref } = await open();
      if (from_project === undefined) assertLinked(ref);
      await promoteFact(store, name, project(from_project ?? slug));
      return `Promoted ${name} to global.`;
    }),
  );

  server.registerTool(
    'memory_handoff',
    {
      description: 'Write a project handoff so the next session, on any machine, knows what was going on. Call it before finishing a task or when the user says they are stopping.',
      inputSchema: {
        working_on: z.string().describe('what was in progress, 1-3 sentences'),
        decisions: z.string().optional().describe('choices made and why'),
        open_threads: z.string().optional().describe('unresolved questions'),
        next_steps: z.string().optional().describe('concrete next actions, in order'),
        files_touched: z.string().optional().describe('paths changed or important'),
      },
    },
    (a) => guarded(async () => {
      const { cfg, store, slug, ref } = await open();
      assertLinked(ref);
      const h = await writeHandoff(store, {
        slug, device: cfg.device, source: 'agent', session: '', branch: (await currentBranch(deps.exec, deps.cwd)) ?? '',
        workingOn: a.working_on, decisions: a.decisions, openThreads: a.open_threads, nextSteps: a.next_steps, filesTouched: a.files_touched, now: now(),
      });
      return `Wrote handoff projects/${slug}/handoffs/${h.id}.md`;
    }),
  );

  server.registerTool(
    'hearth_doctor',
    { description: 'Check whether hearthkit is set up on this machine. Returns each check with a plain-language fix. Used by /hearth:setup.', inputSchema: {} },
    () => guarded(async () => JSON.stringify(await runDoctor({ exec: deps.exec, home: deps.home }), null, 2)),
  );

  server.registerTool(
    'hearth_init',
    {
      description: 'Create (via GitHub CLI) or connect (via a remote URL) the private memory repo and write config. Ask the user before calling.',
      inputSchema: { remote: z.string().optional().describe('existing private git remote URL'), allow_public: z.boolean().optional() },
    },
    ({ remote, allow_public }) => guarded(async () => {
      const msgs: string[] = [];
      const r = await initMemory(deps.exec, deps.home, { remote, allowPublic: allow_public }, (m) => msgs.push(m));
      return [...msgs, `Memory repo: ${r.memoryDir}`, `Remote: ${r.remote}`, r.pushed ? 'Pushed.' : 'Not pushed yet; sync will retry.'].join('\n');
    }),
  );

  server.registerTool(
    'hearth_sync',
    { description: 'Pull, merge, and push the memory repo now. Reports conflicts kept as extra copies.', inputSchema: {} },
    () => guarded(async () => {
      const { cfg, store } = await open();
      const r = await syncRepo(deps.exec, store, { device: cfg.device, now: now() });
      if (r.error) throw new HearthError(`Sync incomplete: ${r.error}`);
      return `Synced.${r.committed ? ' Committed local changes.' : ''}${r.pulled ? ' Pulled.' : ''}${r.pushed ? ' Pushed.' : ' Nothing to push.'}${r.conflicts.length ? `\nConflicts kept as extra copies: ${r.conflicts.join(', ')}` : ''}`;
    }),
  );

  return server;
}
