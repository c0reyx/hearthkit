import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { Exec } from './exec.js';
import { parseOwnerRepo, remoteUrl } from './git.js';
import { slugify } from './slug.js';
import { HearthError } from './types.js';

export async function projectSlug(exec: Exec, cwd: string): Promise<string> {
  const url = await remoteUrl(exec, cwd);
  if (url) {
    const parsed = parseOwnerRepo(url);
    if (parsed) {
      const s = slugify(`${parsed.owner}-${parsed.repo}`);
      if (s) return s;
    }
  }
  return slugify(basename(cwd)) || 'project';
}

/**
 * H1: the slug is still derived from `origin` so every machine agrees on a project's name, but
 * `.git/config` is attacker-controlled content in any repository you clone, so the slug alone
 * cannot decide which memory layer a session may read and write. Each slug is therefore bound
 * to one directory *per machine*, recorded outside the synced memory repo. A second checkout
 * claiming the same origin is refused until a human runs `hearth project link`.
 */
export interface ProjectBinding {
  path: string;
  linkedAt: string;
}

export type ProjectBindings = Record<string, ProjectBinding>;

/** Deliberately in ~/.hearth, not in the memory repo: bindings are per machine and never synced. */
export function bindingsPath(home: string): string {
  return join(home, 'projects.json');
}

export async function loadBindings(home: string): Promise<ProjectBindings> {
  let raw: string;
  try {
    raw = await readFile(bindingsPath(home), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new HearthError(`Could not read ${bindingsPath(home)}: ${(err as Error).message}`, 2);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: ProjectBindings = {};
    for (const [slug, v] of Object.entries(parsed as Record<string, unknown>)) {
      const b = v as { path?: unknown; linkedAt?: unknown };
      if (typeof b?.path === 'string' && b.path) {
        out[slug] = { path: b.path, linkedAt: typeof b.linkedAt === 'string' ? b.linkedAt : '' };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export async function saveBindings(home: string, bindings: ProjectBindings): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(bindingsPath(home), `${JSON.stringify(bindings, null, 2)}\n`, 'utf8');
}

/** Canonical path for comparison; a directory that does not resolve is used as given. */
export async function canonicalPath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}

export interface ProjectRef {
  slug: string;
  /** Canonical path of the directory this session is running in. */
  path: string;
  /** False when the slug is bound to a different directory on this machine. */
  linked: boolean;
  /** The directory the slug is bound to (equals `path` when linked). */
  boundPath: string;
}

export interface ProjectDeps {
  exec: Exec;
  home: string;
  cwd: string;
  now?: Date;
}

/**
 * Resolve the current directory to a project layer, binding the slug to this directory the
 * first time it is seen on this machine. Never throws on a failed binding write: a read-only
 * or full home directory must not break a session.
 */
export async function resolveProject(deps: ProjectDeps): Promise<ProjectRef> {
  const slug = await projectSlug(deps.exec, deps.cwd);
  const path = await canonicalPath(deps.cwd);
  const bindings = await loadBindings(deps.home);
  const existing = bindings[slug];
  if (!existing) {
    bindings[slug] = { path, linkedAt: (deps.now ?? new Date()).toISOString() };
    await saveBindings(deps.home, bindings).catch(() => undefined);
    return { slug, path, linked: true, boundPath: path };
  }
  return { slug, path, linked: existing.path === path, boundPath: existing.path };
}

/** Rebind a slug to the current directory. An explicit human action; there is no MCP tool for it. */
export async function linkProject(deps: ProjectDeps): Promise<{ slug: string; path: string; previous: string | null }> {
  const slug = await projectSlug(deps.exec, deps.cwd);
  const path = await canonicalPath(deps.cwd);
  const bindings = await loadBindings(deps.home);
  const previous = bindings[slug]?.path ?? null;
  bindings[slug] = { path, linkedAt: (deps.now ?? new Date()).toISOString() };
  await saveBindings(deps.home, bindings);
  return { slug, path, previous };
}

export function unlinkedMessage(ref: ProjectRef): string {
  return `Project memory for ${ref.slug} is bound to ${ref.boundPath}; this checkout at ${ref.path} is not linked. Run: hearth project link`;
}

/** For callers that must not touch an unlinked project layer at all. */
export function assertLinked(ref: ProjectRef): void {
  if (!ref.linked) throw new HearthError(unlinkedMessage(ref));
}
