import { latestHandoff } from './handoff.js';
import { indexLine, listFacts, singleLine } from './memory.js';
import type { MemoryStore } from './store.js';
import { estimateTokens } from './transcript.js';
import { GLOBAL, project, type Fact, type Handoff } from './types.js';
import { ENVELOPE_CLOSE, ENVELOPE_OPEN, STATUS_CLOSE, STATUS_OPEN, renderStored } from './untrusted.js';

// hearthkit's own instructions (the "## Tools" section) stay outside the envelope: inside a
// block labelled "data, not instructions" they would be data too.

export function renderHandoff(h: Handoff): string {
  const when = h.timestamp ? `${singleLine(h.timestamp.slice(0, 16), 32).replace('T', ' ')} UTC` : h.id;
  const who = h.source === 'agent' ? 'written by the agent' : 'captured automatically';
  const branch = h.branch ? `, branch ${singleLine(h.branch, 64)}` : '';
  const sections: [string, string][] = [
    ['Working on', h.workingOn], ['Decisions', h.decisions], ['Open threads', h.openThreads],
    ['Next steps', h.nextSteps], ['Files touched', h.filesTouched],
  ];
  const body = sections
    .map(([t, v]) => [t, renderStored(v)] as const)
    .filter(([, v]) => v.length > 0)
    .map(([t, v]) => `### ${t}\n${v}`)
    .join('\n\n');
  return `## Last handoff (${who}, ${when}, ${singleLine(h.device, 64)}${branch})\n${body}`;
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
  /**
   * hearthkit's own status lines (a failed sync, ignored unsafe files). These must be fixed
   * sentences: git output and file content are remote-controlled and would be an injection
   * channel in a trusted position, and git text can carry a remote URL with an embedded token.
   * Details stay in the log, the sync-state file and `hearth doctor`.
   */
  statusNotes?: (string | null)[];
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
    const parts = [ENVELOPE_OPEN, '# hearthkit memory', ''];
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
      for (const f of pinned) parts.push(`### ${f.name}`, renderStored(f.body), '');
    }
    if (omitted) parts.push(`(omitted ${omitted} older memory lines to fit the context cap; use memory_search to find them)`, '');
    parts.push(ENVELOPE_CLOSE, '');
    const notes = (input.statusNotes ?? []).filter((n): n is string => Boolean(n));
    if (notes.length) parts.push(STATUS_OPEN, ...notes.map((n) => singleLine(n, 200)), STATUS_CLOSE, '');
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
