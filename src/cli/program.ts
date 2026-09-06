import { Command } from 'commander';
import { requireConfig, type Config } from '../core/config.js';
import { doctorExitCode, renderChecks, runDoctor } from '../core/doctor.js';
import type { Exec } from '../core/exec.js';
import { currentBranch } from '../core/git.js';
import { listHandoffs, writeHandoff } from '../core/handoff.js';
import { initMemory } from '../core/init.js';
import { deleteFact, listFacts, promoteFact, writeFact } from '../core/memory.js';
import { projectSlug } from '../core/project.js';
import { search } from '../core/search.js';
import { FileStore } from '../core/store.js';
import { syncRepo } from '../core/sync.js';
import { FACT_TYPES, HearthError, layerId, parseLayerId, project, type FactType, type LayerRef } from '../core/types.js';
import { renderWhere, whereAll } from '../core/where.js';

export interface CliDeps {
  exec: Exec;
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  readStdin: () => Promise<string>;
  spawnDetached: (args: string[]) => void;
  now?: () => Date;
}

export async function openStore(deps: CliDeps): Promise<{ cfg: Config; store: FileStore }> {
  const cfg = await requireConfig(deps.home);
  return { cfg, store: new FileStore(cfg.memoryDir) };
}

export async function resolveLayer(arg: string, deps: CliDeps): Promise<LayerRef> {
  if (arg === 'project') return project(await projectSlug(deps.exec, deps.cwd));
  if (arg.startsWith('project:')) return parseLayerId(`projects/${arg.slice('project:'.length)}`);
  return parseLayerId(arg);
}

function factType(v: string | undefined): FactType | undefined {
  if (v === undefined) return undefined;
  if ((FACT_TYPES as readonly string[]).includes(v)) return v as FactType;
  throw new HearthError(`Unknown type "${v}". Use one of: ${FACT_TYPES.join(', ')}`);
}

const LAYER_HELP = 'global | project (current folder) | project:<slug> | projects/<slug>';

export function buildProgram(deps: CliDeps): Command {
  const out = deps.stdout;
  const now = () => deps.now?.() ?? new Date();
  const program = new Command()
    .name('hearth')
    .description('Git-synced memory and session handoffs for Claude Code')
    .exitOverride()
    .configureOutput({ writeOut: deps.stdout, writeErr: deps.stderr });

  program
    .command('init')
    .description('Create or connect the private memory repo and write config')
    .option('--remote <url>', 'existing private git remote to use instead of creating one on GitHub')
    .option('--allow-public', 'allow a public remote (not recommended)')
    .option('--repo-name <name>', 'name for the GitHub repo hearth creates', 'hearth-memory')
    .action(async (o: { remote?: string; allowPublic?: boolean; repoName: string }) => {
      const r = await initMemory(deps.exec, deps.home, { remote: o.remote, allowPublic: o.allowPublic, repoName: o.repoName }, (m) => out(`${m}\n`));
      out(`Memory repo: ${r.memoryDir}\nRemote:      ${r.remote}\n${r.pushed ? 'Pushed the initial commit.' : 'Not pushed yet; hearth sync will retry.'}\nNext: start a Claude Code session, or run: hearth doctor\n`);
    });

  program
    .command('doctor')
    .description('Check this machine and the memory repo; print fixes')
    .option('--json', 'machine-readable output')
    .option('--offline', 'skip the network check')
    .action(async (o: { json?: boolean; offline?: boolean }) => {
      const checks = await runDoctor({ exec: deps.exec, home: deps.home, online: o.offline ? false : undefined });
      out(o.json ? `${JSON.stringify(checks, null, 2)}\n` : renderChecks(checks));
      if (doctorExitCode(checks) !== 0) throw new HearthError('', 2);
    });

  program.command('where').description('Show where everything lives').action(async () => {
    const w = await whereAll({ home: deps.home, cwd: deps.cwd, exec: deps.exec, pluginRoot: deps.env.CLAUDE_PLUGIN_ROOT ?? null, execPath: process.argv[1] });
    out(renderWhere(w));
  });

  program.command('list').description('Layers, fact counts, handoffs, conflicts').action(async () => {
    const { store } = await openStore(deps);
    const lines: string[] = [];
    for (const layer of await store.listLayers()) {
      const facts = await listFacts(store, layer);
      const conflicts = facts.filter((f) => f.name.includes('.conflict-')).length;
      const handoffs = layer.kind === 'project' ? (await store.listHandoffs(layer.slug)).length : null;
      lines.push(
        `${layerId(layer).padEnd(40)} ${String(facts.length).padStart(3)} facts` +
          (handoffs === null ? '' : `  ${String(handoffs).padStart(3)} handoffs`) +
          (conflicts ? `  ! ${conflicts} conflict cop${conflicts === 1 ? 'y' : 'ies'}` : ''),
      );
    }
    out(lines.length ? `${lines.join('\n')}\n` : 'No memory yet. Start a Claude Code session, or run: hearth memory add global "..."\n');
  });

  program
    .command('sync')
    .description('Pull, merge, and push the memory repo')
    .option('--quiet', 'print nothing unless there is an error')
    .action(async (o: { quiet?: boolean }) => {
      const { cfg, store } = await openStore(deps);
      const r = await syncRepo(deps.exec, store, { device: cfg.device, now: now() });
      if (r.error) {
        throw new HearthError(`Sync incomplete: ${r.error}${r.committed ? '\nYour changes are committed locally and will push next time.' : ''}`, 2);
      }
      if (o.quiet) return;
      const bits = [r.committed ? 'Committed local changes.' : '', r.pulled ? 'Pulled.' : '', r.pushed ? 'Pushed.' : 'Nothing to push.'].filter(Boolean);
      const extra = [
        r.conflicts.length ? `Conflicts kept as extra copies: ${r.conflicts.join(', ')}. Run hearth doctor to review them.` : '',
        r.pruned.length ? `Pruned ${r.pruned.length} old handoff(s).` : '',
      ].filter(Boolean);
      out(`Synced. ${bits.join(' ')}${extra.length ? `\n${extra.join('\n')}` : ''}\n`);
    });

  const memory = program.command('memory').description('Work with facts');

  memory
    .command('add <layer> <text>')
    .description(`Add a fact. <layer>: ${LAYER_HELP}`)
    .option('--name <name>', 'kebab-case id (derived from the text if omitted)')
    .option('--type <type>', FACT_TYPES.join('|'))
    .option('--pin', 'include the full fact in every session start')
    .action(async (layerArg: string, text: string, o: { name?: string; type?: string; pin?: boolean }) => {
      const { cfg, store } = await openStore(deps);
      const layer = await resolveLayer(layerArg, deps);
      const f = await writeFact(store, { layer, text, name: o.name, type: factType(o.type), pinned: o.pin ? true : undefined, device: cfg.device, now: now() });
      out(`Saved ${layerId(layer)}/${f.name}.md\n`);
    });

  memory
    .command('search <query>')
    .option('--project <slug>', 'search a specific project layer instead of the current folder')
    .action(async (query: string, o: { project?: string }) => {
      const { store } = await openStore(deps);
      const slug = o.project ?? (await projectSlug(deps.exec, deps.cwd));
      const hits = await search(store, query, slug);
      out(hits.length ? `${hits.map((h) => `${h.layer}/${h.name}  (${h.kind}, score ${h.score})\n    ${h.description}`).join('\n')}\n` : 'No matches.\n');
    });

  memory.command('show <layer> <name>').description(`Print one fact. <layer>: ${LAYER_HELP}`).action(async (layerArg: string, name: string) => {
    const { store } = await openStore(deps);
    const layer = await resolveLayer(layerArg, deps);
    const raw = await store.readFact(layer, name);
    if (raw === null) throw new HearthError(`No fact "${name}" in ${layerId(layer)}.`);
    out(raw.endsWith('\n') ? raw : `${raw}\n`);
  });

  memory.command('delete <layer> <name>').description('Delete one fact (used to clear conflict copies)').action(async (layerArg: string, name: string) => {
    const { store } = await openStore(deps);
    const layer = await resolveLayer(layerArg, deps);
    if (!(await deleteFact(store, layer, name))) throw new HearthError(`No fact "${name}" in ${layerId(layer)}.`);
    out(`Deleted ${layerId(layer)}/${name}.md\n`);
  });

  memory
    .command('promote <name>')
    .description('Move a fact from a project layer to global')
    .option('--from <layer>', 'project or project:<slug>', 'project')
    .action(async (name: string, o: { from: string }) => {
      const { store } = await openStore(deps);
      const from = await resolveLayer(o.from, deps);
      await promoteFact(store, name, from);
      out(`Promoted ${name} from ${layerId(from)} to global.\n`);
    });

  const handoff = program.command('handoff').description('Project handoffs');

  handoff
    .command('write')
    .description('Write a handoff for the current project')
    .requiredOption('--working-on <text>', 'what was in progress')
    .option('--decisions <text>')
    .option('--open-threads <text>')
    .option('--next-steps <text>')
    .option('--files-touched <text>')
    .action(async (o: { workingOn: string; decisions?: string; openThreads?: string; nextSteps?: string; filesTouched?: string }) => {
      const { cfg, store } = await openStore(deps);
      const slug = await projectSlug(deps.exec, deps.cwd);
      const h = await writeHandoff(store, {
        slug, device: cfg.device, source: 'agent', session: '', branch: (await currentBranch(deps.exec, deps.cwd)) ?? '',
        workingOn: o.workingOn, decisions: o.decisions, openThreads: o.openThreads, nextSteps: o.nextSteps, filesTouched: o.filesTouched, now: now(),
      });
      out(`Wrote handoff projects/${slug}/handoffs/${h.id}.md\n`);
    });

  handoff.command('list [project]').description('List handoffs, newest first').action(async (slugArg?: string) => {
    const { store } = await openStore(deps);
    const slug = slugArg ?? (await projectSlug(deps.exec, deps.cwd));
    const all = await listHandoffs(store, slug);
    out(all.length ? `${all.map((h) => `${h.id}  ${h.source}  ${h.timestamp}\n    ${h.workingOn.split('\n')[0] ?? ''}`).join('\n')}\n` : `No handoffs for ${slug}.\n`);
  });

  handoff.command('delete <id> [project]').description('Delete one handoff').action(async (id: string, slugArg?: string) => {
    const { store } = await openStore(deps);
    const slug = slugArg ?? (await projectSlug(deps.exec, deps.cwd));
    if (!(await store.deleteHandoff(slug, id))) throw new HearthError(`No handoff ${id} in ${slug}.`);
    out(`Deleted handoff ${id}.\n`);
  });

  return program;
}

export async function runCli(program: Command, argv: string[], stderr: (s: string) => void): Promise<number> {
  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    if (err instanceof HearthError) {
      if (err.message) stderr(`${err.message}\n`);
      return err.exitCode;
    }
    const e = err as { code?: string; exitCode?: number; message?: string };
    if (typeof e.code === 'string' && e.code.startsWith('commander.')) return e.exitCode ?? 1; // help, version, usage errors already printed
    stderr(`Unexpected error: ${e.message ?? String(err)}\n`);
    return 1;
  }
}
