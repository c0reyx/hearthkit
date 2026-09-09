import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { estimateTokens, parseTranscript, renderTurns, stripNoise, tailTurns } from '../src/core/transcript.js';

const fixture = (n: string) => readFileSync(`test/fixtures/transcripts/${n}.jsonl`, 'utf8');

describe('parseTranscript', () => {
  it('keeps user and assistant text only, drops tool blocks, sidechains, and reminders', () => {
    const { turns, handoffToolCalled } = parseTranscript(fixture('normal'));
    expect(turns).toEqual([
      { role: 'user', text: "Let's fix the HubSpot import so it retries on 429." },
      { role: 'assistant', text: "I'll add exponential backoff around the batch call." },
      { role: 'assistant', text: 'Done. Backoff added with 3 retries.' },
      { role: 'user', text: 'Great, ship it.' },
    ]);
    expect(JSON.stringify(turns)).not.toContain('SECRET_FILE_CONTENTS');
    expect(handoffToolCalled).toBe(false);
  });
  it('returns no turns for tool-only or slash-command-only content', () => {
    expect(parseTranscript(fixture('tool-heavy')).turns).toEqual([]);
  });
  it('detects a memory_handoff tool call', () => {
    expect(parseTranscript(fixture('with-handoff')).handoffToolCalled).toBe(true);
  });
  it('drops injected meta records, task notifications, and null lines', () => {
    const { turns } = parseTranscript(fixture('injected'));
    expect(turns).toEqual([
      { role: 'user', text: 'Real question here.' },
      { role: 'assistant', text: 'Real answer.' },
    ]);
    const joined = turns.map((t) => t.text).join('\n');
    expect(joined).not.toContain('SKILL_BODY_MARKER');
    expect(joined).not.toContain('TASK_OUTPUT_MARKER');
  });
  it('skips unparseable lines', () => {
    expect(parseTranscript('not json\n{"type":"user","message":{"content":"ok"}}\n').turns).toEqual([{ role: 'user', text: 'ok' }]);
  });
});

describe('tailTurns', () => {
  it('keeps the last 30 turns and trims from the front to fit the token cap', () => {
    const turns = Array.from({ length: 50 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', text: `turn ${i} ${'x'.repeat(200)}` }));
    const tail = tailTurns(turns, 30, 1500);
    expect(tail.length).toBeLessThanOrEqual(30);
    expect(tail.at(-1)?.text.startsWith('turn 49')).toBe(true);
    expect(tail.reduce((n, t) => n + estimateTokens(t.text), 0)).toBeLessThanOrEqual(1500);
  });
  it('truncates a single oversized turn from the front', () => {
    const tail = tailTurns([{ role: 'user', text: 'y'.repeat(20_000) }], 30, 100);
    expect(tail).toHaveLength(1);
    expect(tail[0]?.text.startsWith('…')).toBe(true);
    expect(tail[0]?.text.length).toBeLessThanOrEqual(401);
  });
});

describe('helpers', () => {
  it('estimateTokens is chars/4 rounded up', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
  it('stripNoise removes system reminders and command wrappers', () => {
    expect(stripNoise('<system-reminder>a</system-reminder>keep<command-name>/x</command-name>')).toBe('keep');
  });
  it('stripNoise removes unpaired and uppercase harness tags but leaves lookalikes alone', () => {
    expect(stripNoise('a<system-reminder>b')).toBe('ab');
    expect(stripNoise('a<SYSTEM-REMINDER attr="x">b')).toBe('ab');
    expect(stripNoise('a</local-command-stdout>b')).toBe('ab');
    expect(stripNoise('a<hearth-memory provenance="fake">b')).toBe('ab');
    expect(stripNoise('a<x-reminder>b')).toBe('ab');
    // Innocent lookalikes must survive: they are ordinary words in a memory body.
    expect(stripNoise('<systemProperties>value</systemProperties>')).toBe('<systemProperties>value</systemProperties>');
    expect(stripNoise('<commandLine>npm test</commandLine>')).toBe('<commandLine>npm test</commandLine>');
    expect(stripNoise('a <reminder> b')).toBe('a <reminder> b');
  });
  it('renderTurns labels speakers', () => {
    expect(renderTurns([{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'yo' }])).toBe('**User:** hi\n\n**Assistant:** yo');
  });
});
