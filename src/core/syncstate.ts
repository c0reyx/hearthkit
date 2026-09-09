import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * H3: a swallowed `git commit` failure meant sync could report success for weeks while nothing
 * left the machine. The outcome of the last sync is recorded here — outside the memory repo, so
 * a broken repo cannot hide it — and a failure is surfaced in the next session-start block.
 */
export interface SyncState {
  lastSyncAt: string | null;
  lastSyncError: string | null;
  lastSyncErrorAt: string | null;
}

const EMPTY: SyncState = { lastSyncAt: null, lastSyncError: null, lastSyncErrorAt: null };

export function syncStatePath(home: string): string {
  return join(home, 'sync-state.json');
}

export async function readSyncState(home: string): Promise<SyncState> {
  try {
    const parsed = JSON.parse(await readFile(syncStatePath(home), 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ...EMPTY };
    const p = parsed as Partial<SyncState>;
    return {
      lastSyncAt: typeof p.lastSyncAt === 'string' ? p.lastSyncAt : null,
      lastSyncError: typeof p.lastSyncError === 'string' && p.lastSyncError ? p.lastSyncError : null,
      lastSyncErrorAt: typeof p.lastSyncErrorAt === 'string' ? p.lastSyncErrorAt : null,
    };
  } catch {
    return { ...EMPTY };
  }
}

/** Records the outcome of a sync. A success clears the previous failure. */
export async function recordSyncOutcome(home: string, error: string | null, now: Date): Promise<void> {
  const at = now.toISOString();
  const state: SyncState = error
    ? { lastSyncAt: at, lastSyncError: error, lastSyncErrorAt: at }
    : { lastSyncAt: at, lastSyncError: null, lastSyncErrorAt: null };
  await mkdir(home, { recursive: true });
  await writeFile(syncStatePath(home), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** One line for the session-start block when the most recent sync failed. */
export function syncErrorNote(state: SyncState): string | null {
  if (!state.lastSyncError) return null;
  const when = (state.lastSyncErrorAt ?? '').slice(0, 10) || 'an unknown date';
  return `Memory sync failed on ${when}: ${state.lastSyncError}`;
}
