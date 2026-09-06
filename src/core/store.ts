import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GLOBAL, assertSafeName, layerId, project, type LayerRef } from './types.js';

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

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function writeEnsuring(path: string, content: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content, 'utf8');
}

async function removeIfExists(path: string): Promise<boolean> {
  try {
    await rm(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function listMd(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
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
    if ((await readOrNull(join(this.root, 'global', '.gitkeep'))) !== null || (await listMd(join(this.root, 'global'))).length > 0) {
      layers.push(GLOBAL);
    }
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
    return listMd(this.layerDir(layer));
  }

  async readFact(layer: LayerRef, name: string): Promise<string | null> {
    assertSafeName(name);
    return readOrNull(join(this.layerDir(layer), `${name}.md`));
  }

  async writeFact(layer: LayerRef, name: string, raw: string): Promise<void> {
    assertSafeName(name);
    await writeEnsuring(join(this.layerDir(layer), `${name}.md`), raw);
  }

  async deleteFact(layer: LayerRef, name: string): Promise<boolean> {
    assertSafeName(name);
    return removeIfExists(join(this.layerDir(layer), `${name}.md`));
  }

  async readIndex(layer: LayerRef): Promise<string | null> {
    return readOrNull(join(this.layerDir(layer), INDEX_FILE));
  }

  async writeIndex(layer: LayerRef, content: string): Promise<void> {
    await writeEnsuring(join(this.layerDir(layer), INDEX_FILE), content);
  }

  async listHandoffs(slug: string): Promise<string[]> {
    const ids = await listMd(this.handoffDir(slug));
    return ids.sort().reverse();
  }

  async readHandoff(slug: string, id: string): Promise<string | null> {
    assertSafeName(id);
    return readOrNull(join(this.handoffDir(slug), `${id}.md`));
  }

  async writeHandoff(slug: string, id: string, raw: string): Promise<void> {
    assertSafeName(id);
    await writeEnsuring(join(this.handoffDir(slug), `${id}.md`), raw);
  }

  async deleteHandoff(slug: string, id: string): Promise<boolean> {
    assertSafeName(id);
    return removeIfExists(join(this.handoffDir(slug), `${id}.md`));
  }
}
