import { existsSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

const shim = "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);";
const entries = [
  { entry: 'src/cli/index.ts', out: 'dist/hearth.js', shebang: true },
  { entry: 'src/mcp/index.ts', out: 'dist/mcp.js', shebang: false },
];

await mkdir('dist', { recursive: true });
for (const e of entries) {
  if (!existsSync(e.entry)) continue;
  await build({
    entryPoints: [e.entry],
    outfile: e.out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    banner: { js: `${e.shebang ? '#!/usr/bin/env node\n' : ''}${shim}` },
    logLevel: 'error',
  });
  if (e.shebang) await chmod(e.out, 0o755);
}
