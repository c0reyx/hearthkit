# Team agents alongside hearthkit

hearthkit gives every session memory and handoffs. Team agents are ordinary Claude Code plugins in a private marketplace. Any agent installed next to hearthkit gets memory automatically, because the hooks belong to hearthkit, not to the agent.

## 1. Create the marketplace repo

A private GitHub repo, for example `opensense/claude-agents`:

```
claude-agents/
  .claude-plugin/marketplace.json
  plugins/
    support-triage/
      .claude-plugin/plugin.json
      skills/
        triage/SKILL.md
      agents/
        triage.md
      .mcp.json          (optional: MCP servers this agent needs)
```

`.claude-plugin/marketplace.json`:
```json
{
  "name": "opensense-agents",
  "owner": { "name": "Opensense" },
  "plugins": [
    { "name": "support-triage", "source": "./plugins/support-triage", "description": "Triage support tickets the Opensense way", "version": "0.1.0" }
  ]
}
```

`plugins/support-triage/.claude-plugin/plugin.json`:
```json
{ "name": "support-triage", "version": "0.1.0", "description": "Triage support tickets the Opensense way" }
```

Validate with `claude plugin validate .` in the repo root.

## 2. Teammates install it

They need read access to the repo and git credentials on their machine (`gh auth login` covers GitHub). Then:

```
/plugin marketplace add opensense/claude-agents
/plugin install support-triage@opensense-agents
```

To install for everyone automatically, add to a project's `.claude/settings.json`:
```json
{
  "extraKnownMarketplaces": { "opensense-agents": { "source": { "source": "github", "repo": "opensense/claude-agents" } } },
  "enabledPlugins": { "support-triage@opensense-agents": true, "hearthkit@hearthkit": true }
}
```

## 3. Memory stays personal

Each person's memory repo is their own. Facts an agent learns while a teammate uses it go into that teammate's memory, not the agent repo. Anything the whole team must know belongs in the agent's skills or instructions, committed to the marketplace repo.
