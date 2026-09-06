import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_BYTES = 1_000_000;

export async function appendLog(home: string, entry: Record<string, unknown>): Promise<void> {
  const dir = join(home, 'logs');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'hearth.log');
  try {
    if ((await stat(file)).size > MAX_BYTES) await rename(file, `${file}.1`);
  } catch {
    // no file yet
  }
  await appendFile(file, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, 'utf8');
}
