import { listHandoffs } from './handoff.js';
import { firstLine, listFacts, singleLine } from './memory.js';
import type { MemoryStore } from './store.js';
import { GLOBAL, layerId, project, type LayerRef } from './types.js';

export interface SearchHit {
  layer: string;
  kind: 'fact' | 'handoff';
  name: string;
  description: string;
  score: number;
  created: string;
}

export function terms(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 2))];
}

export function scoreText(ts: string[], name: string, description: string, body: string): number {
  const n = name.toLowerCase();
  const d = description.toLowerCase();
  const b = body.toLowerCase();
  let score = 0;
  for (const t of ts) {
    if (n.includes(t)) score += 3;
    if (d.includes(t)) score += 2;
    score += Math.min(b.split(t).length - 1, 5);
  }
  return score;
}

export async function search(store: MemoryStore, query: string, slug: string | null, limit = 10): Promise<SearchHit[]> {
  const ts = terms(query);
  if (ts.length === 0) return [];
  const layers: LayerRef[] = slug ? [GLOBAL, project(slug)] : [GLOBAL];
  const hits: SearchHit[] = [];
  for (const layer of layers) {
    for (const f of await listFacts(store, layer)) {
      const score = scoreText(ts, f.name, f.description, f.body);
      // Hits are rendered into a tool result, which is model context: same treatment as the
      // session-start block (H2). singleLine strips harness tags and neutralises the envelope.
      if (score > 0) hits.push({ layer: layerId(layer), kind: 'fact', name: f.name, description: singleLine(f.description), score, created: f.created });
    }
  }
  if (slug) {
    for (const h of await listHandoffs(store, slug)) {
      const text = [h.workingOn, h.decisions, h.openThreads, h.nextSteps, h.filesTouched].join('\n');
      const score = scoreText(ts, h.id, '', text);
      if (score > 0) {
        hits.push({ layer: layerId(project(slug)), kind: 'handoff', name: h.id, description: singleLine(firstLine(h.workingOn)), score, created: h.timestamp.slice(0, 10) });
      }
    }
  }
  return hits
    .sort((a, b) => b.score - a.score || b.created.localeCompare(a.created) || a.name.localeCompare(b.name))
    .slice(0, limit);
}
