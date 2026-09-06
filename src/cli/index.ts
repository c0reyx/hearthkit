import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hearthHome } from '../core/config.js';
import { RealExec } from '../core/exec.js';
import { buildProgram, runCli } from './program.js';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

function spawnDetached(args: string[]): void {
  if (process.env.HEARTH_NO_BACKGROUND_SYNC) return;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...args], { detached: true, stdio: 'ignore', env: process.env });
  child.unref();
}

const program = buildProgram({
  exec: new RealExec(),
  home: hearthHome(),
  cwd: process.cwd(),
  env: process.env,
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  readStdin,
  spawnDetached,
});

process.exitCode = await runCli(program, process.argv, (s) => process.stderr.write(s));
