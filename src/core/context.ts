import { latestHandoff } from './handoff.js';
import { indexLine, listFacts } from './memory.js';
import type { MemoryStore } from './store.js';
import { estimateTokens } from './transcript.js';
import { GLOBAL, project, type Fact, type Handoff } from './types.js';

export function renderHandoff(h: Handoff): string {
  const when = h.timestamp ? `${h.timestamp.slice(0, 16).replace('T', ' ')} UTC` : h.id;
  const who = h.source === 'agent' ? 'written by the agent' : 'captured automatically';
  const branch = h.branch ? `, branch ${h.branch}` : '';
  const sections: [string, string][] = [
    ['Working on', h.workingOn], ['Decisions', h.decisions], ['Open threads', h.openThreads],
    ['Next steps', h.nextSteps], ['Files touched', h.filesTouched],
  ];
  const body = sections.filter(([, v]) => v.trim()).map(([t, v]) => `### ${t}\n${v.trim()}`).join('\n\n');
  return `## Last handoff (${who}, ${when}, ${h.device}${branch})\n${body}`;
}

export interface ContextInput {
  store: MemoryStore;
  slug: string;
  capTokens: number;
  /**
   * Set when this checkout is not the one the slug is bound to on this machine (H1). The
   * project layer is then neither read nor mentioned beyond a line telling the user how to link.
   */
  unlinkedNote?: string | null;
}

const byAge = (a: Fact, b: Fact) => a.created.localeCompare(b.created) || a.name.localeCompare(b.name);
const byName = (a: Fact, b: Fact) => a.name.localeCompare(b.name);

export async function buildContext(input: ContextInput): Promise<string> {
  const { store, slug, capTokens } = input;
  const unlinked = input.unlinkedNote ?? null;
  const handoff = unlinked ? null : await latestHandoff(store, slug);
  const globalFacts = await listFacts(store, GLOBAL);
  const projectFacts = unlinked ? [] : await listFacts(store, project(slug));
  const pinned = [...globalFacts, ...projectFacts].filter((f) => f.pinned);
  let gLines = globalFacts.filter((f) => !f.pinned).sort(byAge);
  let pLines = projectFacts.filter((f) => !f.pinned).sort(byAge);
  let omitted = 0;

  // "1 facts" and a layer whose only fact is pinned printing "(none yet)" were both reported
  // as cosmetic bugs alongside H1.
  const counted = (n: number) => `${n} fact${n === 1 ? '' : 's'}`;
  const lines = (shown: Fact[], total: number): string[] => {
    if (shown.length) return [...shown].sort(byName).map(indexLine);
    return [total > 0 ? '(all pinned; see "Pinned facts" below)' : '(none yet)'];
  };

  const render = (): string => {
    const parts = ['# hearthkit memory', ''];
    if (unlinked) {
      parts.push(`## Project memory: projects/${slug}`, unlinked, '');
    } else {
      parts.push(handoff ? renderHandoff(handoff) : '## Last handoff\nNo handoff yet for this project.', '');
    }
    parts.push(`## Global memory (${counted(globalFacts.length)})`);
    parts.push(...lines(gLines, globalFacts.length), '');
    if (!unlinked) {
      parts.push(`## Project memory: projects/${slug} (${counted(projectFacts.length)})`);
      parts.push(...lines(pLines, projectFacts.length), '');
    }
    if (pinned.length) {
      parts.push('## Pinned facts');
      for (const f of pinned) parts.push(`### ${f.name}`, f.body, '');
    }
    if (omitted) parts.push(`(omitted ${omitted} older memory lines to fit the context cap; use memory_search to find them)`, '');
    parts.push(
      '## Tools',
      'Memory tools (MCP server "hearth"): memory_search, memory_read, memory_write, memory_list, memory_promote, memory_handoff.',
      `Write to layer "global" for things true in any repo, "projects/${slug}" for this codebase. If a project fact turns out to be general, call memory_promote.`,
      'Before you finish, or when the user says they are stopping, call memory_handoff with what you were working on, decisions, open threads, next steps, and files touched.',
    );
    return `${parts.join('\n')}\n`;
  };

  let text = render();
  while (estimateTokens(text) > capTokens && (pLines.length > 0 || gLines.length > 0)) {
    if (pLines.length > 0) pLines = pLines.slice(1);
    else gLines = gLines.slice(1);
    omitted++;
    text = render();
  }
  return text;
}
