export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ParsedTranscript {
  turns: Turn[];
  handoffToolCalled: boolean;
}

interface Block {
  type?: unknown;
  text?: unknown;
  name?: unknown;
}

// Case-insensitive throughout: an uppercase <SYSTEM-REMINDER> used to keep its inner text
// because only the tags were dropped by the unpaired rules below.
const NOISE = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/gi,
  /<command-name>[\s\S]*?<\/command-name>/gi,
  /<command-message>[\s\S]*?<\/command-message>/gi,
  /<command-args>[\s\S]*?<\/command-args>/gi,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gi,
  /<local-command-stderr>[\s\S]*?<\/local-command-stderr>/gi,
  /<task-notification>[\s\S]*?<\/task-notification>/gi,
  /<task-progress>[\s\S]*?<\/task-progress>/gi,
  // Unpaired harness tags, and hearthkit's own blocks, so stored text cannot forge either one.
  // The paired forms above are removed with their content first. Tag names are listed in full
  // and anchored with a lookahead so ordinary words are not mangled: <systemProperties>,
  // <commandLine> and <reminder> are memory content, not harness constructs.
  /<\/?(?:system-reminder|system|command-name|command-message|command-args|local-command-stdout|local-command-stderr|task-notification|task-progress|hearth-memory|hearth-status)(?=[\s/>])[^>]*>/gi,
  /<\/?[a-z]+(?:-[a-z]+)*-reminder(?=[\s/>])[^>]*>/gi,
];

export function stripNoise(text: string): string {
  return NOISE.reduce((t, re) => t.replace(re, ''), text);
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function parseTranscript(jsonl: string): ParsedTranscript {
  const turns: Turn[] = [];
  let handoffToolCalled = false;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let rec: { type?: unknown; isSidechain?: unknown; isMeta?: unknown; message?: { content?: unknown } };
    try {
      rec = JSON.parse(line) as typeof rec;
    } catch {
      continue;
    }
    // A line can legally parse to null or a scalar; only objects carry a turn.
    if (typeof rec !== 'object' || rec === null) continue;
    if (rec.type !== 'user' && rec.type !== 'assistant') continue;
    if (rec.isSidechain === true) continue;
    // isMeta records are harness-injected text (skill bodies, hook output), not conversation.
    if (rec.isMeta === true) continue;
    const content = rec.message?.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      const blocks = content as Block[];
      if (blocks.some((b) => b?.type === 'tool_use' && typeof b.name === 'string' && b.name.endsWith('memory_handoff'))) {
        handoffToolCalled = true;
      }
      text = blocks
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text as string)
        .join('\n');
    }
    text = stripNoise(text).trim();
    if (text) turns.push({ role: rec.type, text });
  }
  return { turns, handoffToolCalled };
}

export function tailTurns(turns: Turn[], maxTurns = 30, maxTokens = 1500): Turn[] {
  let tail = turns.slice(-maxTurns);
  const total = () => tail.reduce((n, t) => n + estimateTokens(t.text), 0);
  while (tail.length > 1 && total() > maxTokens) tail = tail.slice(1);
  const only = tail[0];
  if (tail.length === 1 && only && estimateTokens(only.text) > maxTokens) {
    tail = [{ role: only.role, text: `…${only.text.slice(-(maxTokens * 4))}` }];
  }
  return tail;
}

export function renderTurns(turns: Turn[]): string {
  return turns.map((t) => `**${t.role === 'user' ? 'User' : 'Assistant'}:** ${t.text}`).join('\n\n');
}
