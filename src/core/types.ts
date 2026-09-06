export type LayerRef = { kind: 'global' } | { kind: 'project'; slug: string };

export const GLOBAL: LayerRef = { kind: 'global' };

export function project(slug: string): LayerRef {
  return { kind: 'project', slug };
}

export class HearthError extends Error {
  constructor(message: string, public readonly exitCode: 1 | 2 = 1) {
    super(message);
    this.name = 'HearthError';
  }
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertSafeName(name: string): void {
  if (!SAFE_NAME.test(name) || name.includes('..')) {
    throw new HearthError(
      `Invalid name "${name}". Use letters, digits, dots, dashes, or underscores, starting with a letter or digit.`,
    );
  }
}

export function layerId(layer: LayerRef): string {
  return layer.kind === 'global' ? 'global' : `projects/${layer.slug}`;
}

export function parseLayerId(id: string): LayerRef {
  if (id === 'global') return GLOBAL;
  const m = /^projects\/(.+)$/.exec(id);
  if (m && m[1] !== undefined) {
    assertSafeName(m[1]);
    return project(m[1]);
  }
  throw new HearthError(`Unknown layer "${id}". Use "global" or "projects/<slug>".`);
}

export type FactType = 'user' | 'feedback' | 'project' | 'reference';
export const FACT_TYPES: readonly FactType[] = ['user', 'feedback', 'project', 'reference'];

export interface Fact {
  name: string;
  description: string;
  type: FactType;
  created: string; // YYYY-MM-DD
  device: string;
  pinned: boolean;
  body: string;
}

export type HandoffSource = 'agent' | 'auto';

export interface Handoff {
  id: string; // filename without .md, e.g. 2026-09-06-1530-coreys-macbook
  device: string;
  source: HandoffSource;
  session: string;
  branch: string;
  timestamp: string; // ISO 8601
  workingOn: string;
  decisions: string;
  openThreads: string;
  nextSteps: string;
  filesTouched: string;
}
