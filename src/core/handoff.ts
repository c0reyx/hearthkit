import matter from 'gray-matter';
import type { MemoryStore } from './store.js';
import { HearthError, type Handoff, type HandoffSource } from './types.js';

export function handoffId(now: Date, device: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}-${p(now.getUTCMonth() + 1)}-${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}-${device}`;
}

type SectionKey = 'workingOn' | 'decisions' | 'openThreads' | 'nextSteps' | 'filesTouched';
export const HANDOFF_SECTIONS: readonly [SectionKey, string][] = [
  ['workingOn', 'Working on'],
  ['decisions', 'Decisions'],
  ['openThreads', 'Open threads'],
  ['nextSteps', 'Next steps'],
  ['filesTouched', 'Files touched'],
];

function str(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return typeof v === 'string' ? v : '';
}

export function serializeHandoff(h: Handoff): string {
  const body = HANDOFF_SECTIONS.map(([key, title]) => `## ${title}\n${h[key].trim()}\n`).join('\n');
  return matter.stringify(body, {
    device: h.device, source: h.source, session: h.session, branch: h.branch, timestamp: h.timestamp,
  });
}

const SECTION_TITLES = new Set(HANDOFF_SECTIONS.map(([, title]) => title));

export function parseHandoff(id: string, raw: string): Handoff {
  const parsed = matter(raw);
  const d = parsed.data as Record<string, unknown>;
  const sections: Record<string, string> = {};
  let current: string | null = null;
  for (const line of parsed.content.split('\n')) {
    // Only the five known titles start a new section; any other "## …" line is body text,
    // because handoff bodies quote conversation that can contain its own markdown headings.
    const m = /^## (.+)$/.exec(line);
    if (m && m[1] !== undefined && SECTION_TITLES.has(m[1].trim())) {
      current = m[1].trim();
      sections[current] = '';
      continue;
    }
    if (current !== null) sections[current] = `${sections[current] ?? ''}${line}\n`;
  }
  const get = (title: string) => (sections[title] ?? '').trim();
  return {
    id,
    device: str(d.device),
    source: d.source === 'agent' ? 'agent' : 'auto',
    session: str(d.session),
    branch: str(d.branch),
    timestamp: str(d.timestamp),
    workingOn: get('Working on'),
    decisions: get('Decisions'),
    openThreads: get('Open threads'),
    nextSteps: get('Next steps'),
    filesTouched: get('Files touched'),
  };
}

export interface HandoffInput {
  slug: string;
  device: string;
  source: HandoffSource;
  session: string;
  branch: string;
  workingOn: string;
  decisions?: string;
  openThreads?: string;
  nextSteps?: string;
  filesTouched?: string;
  now?: Date;
}

export async function writeHandoff(store: MemoryStore, input: HandoffInput): Promise<Handoff> {
  if (!input.workingOn.trim()) throw new HearthError('A handoff needs at least a "working on" section.');
  const now = input.now ?? new Date();
  const base = handoffId(now, input.device);
  let id = base;
  for (let n = 2; (await store.readHandoff(input.slug, id)) !== null; n++) id = `${base}-${n}`;
  const h: Handoff = {
    id,
    device: input.device,
    source: input.source,
    session: input.session,
    branch: input.branch,
    timestamp: now.toISOString(),
    workingOn: input.workingOn.trim(),
    decisions: (input.decisions ?? '').trim(),
    openThreads: (input.openThreads ?? '').trim(),
    nextSteps: (input.nextSteps ?? '').trim(),
    filesTouched: (input.filesTouched ?? '').trim(),
  };
  await store.writeHandoff(input.slug, id, serializeHandoff(h));
  return h;
}

export async function listHandoffs(store: MemoryStore, slug: string): Promise<Handoff[]> {
  const out: Handoff[] = [];
  for (const id of await store.listHandoffs(slug)) {
    const raw = await store.readHandoff(slug, id);
    if (raw !== null) out.push(parseHandoff(id, raw));
  }
  return out.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id));
}

export async function latestHandoff(store: MemoryStore, slug: string): Promise<Handoff | null> {
  const all = await listHandoffs(store, slug);
  const newest = all[0];
  if (!newest) return null;
  if (newest.source === 'auto' && newest.session) {
    const agentSame = all.find((h) => h.source === 'agent' && h.session === newest.session);
    if (agentSame) return agentSame;
  }
  return newest;
}

export async function pruneHandoffs(store: MemoryStore, slug: string, now: Date, maxAgeDays = 30): Promise<string[]> {
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  const deleted: string[] = [];
  for (const h of (await listHandoffs(store, slug)).slice(1)) {
    const t = Date.parse(h.timestamp);
    if (!Number.isNaN(t) && t < cutoff) {
      await store.deleteHandoff(slug, h.id);
      deleted.push(h.id);
    }
  }
  return deleted;
}

export async function pruneAllHandoffs(store: MemoryStore, now: Date): Promise<string[]> {
  const out: string[] = [];
  for (const layer of await store.listLayers()) {
    if (layer.kind === 'project') out.push(...(await pruneHandoffs(store, layer.slug, now)));
  }
  return out;
}
