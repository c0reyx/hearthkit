import { readFile } from 'node:fs/promises';
import type { Exec } from './exec.js';
import { currentBranch } from './git.js';
import { listHandoffs, writeHandoff } from './handoff.js';
import { projectSlug, resolveProject } from './project.js';
import type { MemoryStore } from './store.js';
import { type Handoff } from './types.js';
import { parseTranscript, renderTurns, tailTurns } from './transcript.js';

/** An agent handoff newer than this suppresses the automatic one for the same project. */
const AGENT_HANDOFF_WINDOW_MS = 10 * 60_000;

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
  /** When given, the project slug must be bound to this directory on this machine (H1). */
  home?: string;
  readFile?: (path: string) => Promise<string>;
  now?: Date;
}

export async function captureHandoff(payload: HookPayload, deps: CaptureDeps): Promise<Handoff | null> {
  if (!payload.transcript_path) return null;
  const cwd = payload.cwd ?? process.cwd();
  let slug: string;
  if (deps.home === undefined) {
    slug = await projectSlug(deps.exec, cwd);
  } else {
    // An automatic handoff must never land in a layer this checkout is not linked to: that is
    // how a hostile repo would plant text that a real session reads back later.
    const ref = await resolveProject({ exec: deps.exec, home: deps.home, cwd, now: deps.now });
    if (!ref.linked) return null;
    slug = ref.slug;
  }
  const session = payload.session_id ?? '';
  const existing = await listHandoffs(deps.store, slug);
  if (session && existing.some((h) => h.session === session)) return null;

  // The agent may have written a handoff without the tool call this hook can see (e.g. via the
  // CLI), and hook payloads do not always carry a session id. A fresh agent handoff wins.
  const now = deps.now ?? new Date();
  const newest = existing[0];
  if (newest && newest.source === 'agent' && now.getTime() - Date.parse(newest.timestamp) < AGENT_HANDOFF_WINDOW_MS) {
    return null;
  }

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
