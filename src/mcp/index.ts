import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { hearthHome } from '../core/config.js';
import { RealExec } from '../core/exec.js';
import { createMcpServer } from './server.js';

const server = createMcpServer({ exec: new RealExec(), home: hearthHome(), cwd: process.cwd() });
await server.connect(new StdioServerTransport());
