import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { slugify } from './slug.js';
import { HearthError } from './types.js';

export interface Config {
  memoryDir: string;
  device: string;
  contextCapTokens: number;
  remote: string | null;
}

export function hearthHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HEARTH_HOME ?? join(homedir(), '.hearth');
}

export function defaultDevice(): string {
  return slugify(hostname().replace(/\.local$/i, '')) || 'device';
}

export function defaultConfig(home: string): Config {
  return { memoryDir: join(home, 'memory'), device: defaultDevice(), contextCapTokens: 4000, remote: null };
}

function configPath(home: string): string {
  return join(home, 'config.json');
}

export async function loadConfig(home: string): Promise<Config | null> {
  try {
    const raw = await readFile(configPath(home), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Config>;
    return { ...defaultConfig(home), ...parsed };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new HearthError(`Could not read ${configPath(home)}: ${(err as Error).message}`, 2);
  }
}

export async function saveConfig(home: string, cfg: Config): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(configPath(home), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
}

export async function requireConfig(home: string): Promise<Config> {
  const cfg = await loadConfig(home);
  if (!cfg) {
    throw new HearthError(`hearthkit is not set up on this machine. Run: hearth init   (or /hearth:setup inside Claude Code)`, 2);
  }
  return cfg;
}
