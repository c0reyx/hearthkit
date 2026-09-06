import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import type { Exec } from './exec.js';
import { projectSlug } from './project.js';

export interface Location {
  label: string;
  path: string;
  exists: boolean;
  owner: 'hearthkit' | 'Claude Code' | 'npm';
  note: string;
}

export interface WhereDeps {
  home: string;
  cwd: string;
  exec: Exec;
  claudeHome?: string;
  pluginRoot?: string | null;
  execPath?: string;
}

export interface WhereResult {
  slug: string;
  locations: Location[];
}

export function claudeProjectDir(claudeHome: string, cwd: string): string {
  return join(claudeHome, 'projects', cwd.replace(/[/.]/g, '-'));
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

export async function whereAll(deps: WhereDeps): Promise<WhereResult> {
  const claudeHome = deps.claudeHome ?? join(homedir(), '.claude');
  const cfg = await loadConfig(deps.home);
  const slug = await projectSlug(deps.exec, deps.cwd);
  const memoryDir = cfg?.memoryDir ?? join(deps.home, 'memory');
  const items: Omit<Location, 'exists'>[] = [
    { label: 'config', path: join(deps.home, 'config.json'), owner: 'hearthkit', note: 'repo location, device name, context cap' },
    { label: 'memory repo (local clone)', path: memoryDir, owner: 'hearthkit', note: cfg?.remote ? `syncs with ${cfg.remote}` : 'not set up yet (hearth init)' },
    { label: 'this project layer', path: join(memoryDir, 'projects', slug), owner: 'hearthkit', note: 'facts and handoffs for the current folder' },
    { label: 'logs', path: join(deps.home, 'logs', 'hearth.log'), owner: 'hearthkit', note: 'hook, sync, and MCP logs (no transcript text)' },
    { label: 'plugin (bundled CLI + MCP server)', path: deps.pluginRoot ?? '(not running inside the plugin)', owner: 'Claude Code', note: 'dist/hearth.js and dist/mcp.js live here' },
    { label: 'Claude Code settings', path: join(claudeHome, 'settings.json'), owner: 'Claude Code', note: 'marketplace and plugin registration' },
    { label: 'Claude Code plugins', path: join(claudeHome, 'plugins'), owner: 'Claude Code', note: 'installed plugin copies' },
    { label: 'Claude Code transcripts for this folder', path: claudeProjectDir(claudeHome, deps.cwd), owner: 'Claude Code', note: 'read by handoff capture, never written' },
    { label: 'hearth CLI (this process)', path: deps.execPath ?? process.argv[1] ?? '', owner: 'npm', note: 'the entry point that is running now' },
  ];
  const locations: Location[] = [];
  for (const it of items) locations.push({ ...it, exists: await exists(it.path) });
  return { slug, locations };
}

export function renderWhere(w: WhereResult): string {
  const lines = [`project slug: ${w.slug}`, ''];
  for (const l of w.locations) {
    lines.push(`${l.exists ? '✔' : '·'} ${l.label}`, `    ${l.path}`, `    ${l.owner} — ${l.note}`);
  }
  return `${lines.join('\n')}\n`;
}
