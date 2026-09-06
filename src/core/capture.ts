import { readFile } from 'node:fs/promises';
import type { Exec } from './exec.js';
import { currentBranch } from './git.js';
import { listHandoffs, writeHandoff } from './handoff.js';
import { projectSlug } from './project.js';
import type { MemoryStore } from './store.js';
import { type Handoff } from './types.js';
import { parseTranscript, renderTurns, tailTurns } from './transcript.js';

export interface HookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  reason?: string;
}

export interface CaptureDeps {
  store: MemoryStore;
  exec: Exec;
  device: string;
  readFile?: (path: string) => Promise<string>;
  now?: Date;
}

export async function captureHandoff(payload: HookPayload, deps: CaptureDeps): Promise<Handoff | null> {
  if (!payload.transcript_path) return null;
  const cwd = payload.cwd ?? process.cwd();
  const slug = await projectSlug(deps.exec, cwd);
  const session = payload.session_id ?? '';
  if (session && (await listHandoffs(deps.store, slug)).some((h) => h.session === session)) return null;

  let jsonl: string;
  try {
    jsonl = await (deps.readFile ?? ((p: string) => readFile(p, 'utf8')))(payload.transcript_path);
  } catch {
    return null;
  }
  const parsed = parseTranscript(jsonl);
  if (parsed.handoffToolCalled) return null;
  const tail = tailTurns(parsed.turns);
  if (tail.length === 0) return null;

  const branch = (await currentBranch(deps.exec, cwd)) ?? '';
  return writeHandoff(deps.store, {
    slug,
    device: deps.device,
    source: 'auto',
    session,
    branch,
    workingOn: renderTurns(tail),
    nextSteps: 'Automatic capture: the session ended without a written handoff. Ask the user what to pick up first.',
    now: deps.now,
  });
}
