import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { GLOBAL, HearthError, assertSafeName, layerId, project, type LayerRef } from './types.js';

export interface MemoryStore {
  readonly root: string;
  listLayers(): Promise<LayerRef[]>;
  listFacts(layer: LayerRef): Promise<string[]>;
  readFact(layer: LayerRef, name: string): Promise<string | null>;
  writeFact(layer: LayerRef, name: string, raw: string): Promise<void>;
  deleteFact(layer: LayerRef, name: string): Promise<boolean>;
  readIndex(layer: LayerRef): Promise<string | null>;
  writeIndex(layer: LayerRef, content: string): Promise<void>;
  listHandoffs(slug: string): Promise<string[]>;
  readHandoff(slug: string, id: string): Promise<string | null>;
  writeHandoff(slug: string, id: string, raw: string): Promise<void>;
  deleteHandoff(slug: string, id: string): Promise<boolean>;
}

export const INDEX_FILE = 'MEMORY.md';

/**
 * H4: `assertSafeName` constrains the *name*; it says nothing about what the path resolves to.
 * Git checks out symlinks faithfully, so a hostile remote could commit `global/MEMORY.md` as a
 * symlink to `~/.zshenv` and hearthkit's own index regeneration — which runs after every fact
 * write and for every layer during sync — would write straight through it.
 *
 * Every read, write and delete therefore walks the path below the memory root, refusing any
 * component that is a symlink or is not the kind of entry expected, checks that the deepest
 * existing directory still resolves inside the root, and finally opens the file with
 * O_NOFOLLOW so the last component cannot be swapped for a link after the check.
 */
function symlinkError(path: string): HearthError {
  return new HearthError(
    `Refusing to follow a symlink inside the memory repo: ${path}. ` +
      `Memory files must be ordinary files. Remove it, then run: hearth doctor`,
  );
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Validates every path component under `root`; `target` must be a regular file if it exists.
 * `allowLink` permits the final component to be a symlink, for deletion only.
 */
async function assertInsideRoot(root: string, target: string, opts: { allowLink?: boolean } = {}): Promise<void> {
  const rel = relative(root, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new HearthError(`Refusing to touch ${target}: it is outside the memory repo at ${root}.`);
  }
  const parts = rel.split(sep);
  let cur = root;
  let deepestDir = root;
  for (const [i, part] of parts.entries()) {
    cur = join(cur, part);
    const st = await lstatOrNull(cur);
    if (st === null) break; // nothing below an absent component can exist either
    const last = i === parts.length - 1;
    if (st.isSymbolicLink()) {
      if (last && opts.allowLink) return; // deleting the link itself is safe and necessary
      throw symlinkError(cur);
    }
    if (last) {
      if (!st.isFile()) throw new HearthError(`Refusing to use ${cur}: it is not a regular file.`);
    } else {
      if (!st.isDirectory()) throw new HearthError(`Refusing to use ${cur}: it is not a directory.`);
      deepestDir = cur;
    }
  }
  const [realRoot, realDir] = await Promise.all([realpath(root).catch(() => root), realpath(deepestDir).catch(() => deepestDir)]);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
    throw new HearthError(`Refusing to touch ${target}: ${realDir} resolves outside the memory repo at ${realRoot}.`);
  }
}

async function readOrNull(root: string, path: string): Promise<string | null> {
  await assertInsideRoot(root, path);
  let fh;
  try {
    fh = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw symlinkError(path);
    throw err;
  }
  try {
    return await fh.readFile('utf8');
  } finally {
    await fh.close();
  }
}

async function writeEnsuring(root: string, path: string, content: string): Promise<void> {
  await assertInsideRoot(root, path);
  await mkdir(join(path, '..'), { recursive: true });
  let fh;
  try {
    fh = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw symlinkError(path);
    throw err;
  }
  try {
    await fh.writeFile(content, 'utf8');
  } finally {
    await fh.close();
  }
}

async function removeIfExists(root: string, path: string): Promise<boolean> {
  // allowLink: `rm` does not follow the link, and the user must be able to clear a hostile
  // entry with `hearth memory delete` rather than reaching for git by hand.
  await assertInsideRoot(root, path, { allowLink: true });
  try {
    await rm(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Write a file inside the memory root with the same symlink and containment checks the store
 * applies. For the one writer that does not go through a layer: sync's conflict copy.
 */
export async function writeInsideRoot(root: string, path: string, content: string): Promise<void> {
  await writeEnsuring(root, path, content);
}

/**
 * Every non-regular entry (symlink, fifo, socket, device) under the memory root, relative to it.
 * `hearth doctor` reports these and `sync` refuses to parse a repo that contains any.
 */
export async function findUnsafeEntries(root: string, limit = 50): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (found.length >= limit) return;
      if (prefix === '' && e.name === '.git') continue; // git's own store, not memory content
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isSymbolicLink() || (!e.isFile() && !e.isDirectory())) {
        found.push(rel);
        continue;
      }
      if (e.isDirectory()) await walk(join(dir, e.name), rel);
    }
  };
  await walk(root, '');
  return found;
}

async function listMd(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    // Deliberate: `isFile()` is false for a symlink, so a symlinked "fact" planted by a hostile
    // remote never reaches listings, indexes, search or the session-start context block (H4).
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.md') && e.name !== INDEX_FILE)
      .map((e) => e.name.slice(0, -3))
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export class FileStore implements MemoryStore {
  constructor(readonly root: string) {}

  layerDir(layer: LayerRef): string {
    if (layer.kind === 'project') {
      assertSafeName(layer.slug);
    }
    return join(this.root, layerId(layer));
  }

  private handoffDir(slug: string): string {
    assertSafeName(slug);
    return join(this.root, 'projects', slug, 'handoffs');
  }

  async listLayers(): Promise<LayerRef[]> {
    const layers: LayerRef[] = [];
    // Tolerant by design: a hostile entry (a symlinked `global/`, say) must degrade to "this
    // layer is not usable" so `hearth list`, `hearth doctor` and `memory context` can still
    // report, rather than throwing out of a listing and dying silently under hookSafe (H4).
    const globalUsable = await (async () => {
      try {
        return (await readOrNull(this.root, join(this.root, 'global', '.gitkeep'))) !== null || (await listMd(join(this.root, 'global'))).length > 0;
      } catch {
        return false;
      }
    })();
    if (globalUsable) layers.push(GLOBAL);
    try {
      const entries = await readdir(join(this.root, 'projects'), { withFileTypes: true });
      for (const e of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
        layers.push(project(e.name));
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return layers;
  }

  async listFacts(layer: LayerRef): Promise<string[]> {
    const dir = this.layerDir(layer);
    try {
      await assertInsideRoot(this.root, join(dir, '.probe'));
    } catch {
      return []; // an unsafe layer directory yields no facts instead of throwing
    }
    return listMd(dir);
  }

  async readFact(layer: LayerRef, name: string): Promise<string | null> {
    assertSafeName(name);
    return readOrNull(this.root, join(this.layerDir(layer), `${name}.md`));
  }

  async writeFact(layer: LayerRef, name: string, raw: string): Promise<void> {
    assertSafeName(name);
    await writeEnsuring(this.root, join(this.layerDir(layer), `${name}.md`), raw);
  }

  async deleteFact(layer: LayerRef, name: string): Promise<boolean> {
    assertSafeName(name);
    return removeIfExists(this.root, join(this.layerDir(layer), `${name}.md`));
  }

  async readIndex(layer: LayerRef): Promise<string | null> {
    return readOrNull(this.root, join(this.layerDir(layer), INDEX_FILE));
  }

  async writeIndex(layer: LayerRef, content: string): Promise<void> {
    await writeEnsuring(this.root, join(this.layerDir(layer), INDEX_FILE), content);
  }

  async listHandoffs(slug: string): Promise<string[]> {
    const ids = await listMd(this.handoffDir(slug));
    return ids.sort().reverse();
  }

  async readHandoff(slug: string, id: string): Promise<string | null> {
    assertSafeName(id);
    return readOrNull(this.root, join(this.handoffDir(slug), `${id}.md`));
  }

  async writeHandoff(slug: string, id: string, raw: string): Promise<void> {
    assertSafeName(id);
    await writeEnsuring(this.root, join(this.handoffDir(slug), `${id}.md`), raw);
  }

  async deleteHandoff(slug: string, id: string): Promise<boolean> {
    assertSafeName(id);
    return removeIfExists(this.root, join(this.handoffDir(slug), `${id}.md`));
  }
}
