import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string) => readFileSync(p, 'utf8');
const json = (p: string) => JSON.parse(read(p)) as Record<string, any>;

describe('plugin manifests', () => {
  it('agree on name and version and reference the built files', () => {
    const pkg = json('package.json');
    const plugin = json('.claude-plugin/plugin.json');
    const market = json('.claude-plugin/marketplace.json');
    expect(plugin.name).toBe('hearth');
    expect(plugin.version).toBe(pkg.version);
    expect(market.name).toBe('hearthkit');
    expect(market.plugins[0].name).toBe('hearth');
    expect(market.plugins[0].version).toBe(pkg.version);
    expect(market.plugins[0].source).toEqual({ source: 'github', repo: 'c0reyx/hearthkit', ref: 'v0.1.0' });

    const hooks = json('hooks/hooks.json');
    expect(hooks.hooks.SessionStart[0].hooks[0].command).toBe('node "${CLAUDE_PLUGIN_ROOT}/dist/hearth.js" memory context');
    expect(hooks.hooks.SessionEnd[0].hooks[0].command).toBe('node "${CLAUDE_PLUGIN_ROOT}/dist/hearth.js" handoff capture');

    const mcp = json('.mcp.json');
    expect(mcp.mcpServers.hearth.command).toBe('node');
    expect(mcp.mcpServers.hearth.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/dist/mcp.js']);

    expect(existsSync('dist/hearth.js')).toBe(true);
    expect(existsSync('dist/mcp.js')).toBe(true);
  });

  it('the release script bakes in no session trailer; release commits are the owner\'s', () => {
    expect(read('scripts/release.mjs')).not.toContain('Claude-Session');
  });

  it('commands and the skill have frontmatter descriptions', () => {
    const cmds = readdirSync('commands').sort();
    expect(cmds).toEqual(['handoff.md', 'setup.md', 'sync.md']);
    for (const f of cmds) expect(read(`commands/${f}`)).toMatch(/^---\ndescription: .+\n---\n/);
    expect(read('skills/memory-use/SKILL.md')).toMatch(/^---\nname: memory-use\ndescription: .+\n---\n/);
  });
});
