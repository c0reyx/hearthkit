import matter from 'gray-matter';

/**
 * The one place hearthkit parses frontmatter. Everything under the memory root is untrusted
 * input: it can arrive from a compromised sync remote, another machine, or repository content
 * a session quoted. gray-matter resolves the frontmatter language from the text right after the
 * opening delimiter and its default engine map includes a `javascript` engine backed by `eval`,
 * so `---js` in any memory file was arbitrary code execution at every session start.
 *
 * Two independent defences, because either alone is not enough:
 *  1. The file must open with exactly `---` on its own line. `---js`, `---json`, `--- js` are
 *     "no frontmatter at all", so the language is never attacker-chosen.
 *  2. The non-YAML engines are overwritten with throwing stubs. Omitting them is not enough:
 *     gray-matter's `lib/defaults.js` merges its own default engines *under* the ones passed in,
 *     so `engines: { yaml }` leaves the eval-backed engine registered and reachable.
 */

type Engine = { parse: (input: string) => object; stringify?: (data: object) => string };

// gray-matter exposes its engine map at runtime (index.js:137) but not in its type definitions.
const yamlEngine = (matter as unknown as { engines: Record<string, Engine> }).engines.yaml as Engine;

function refuse(language: string): Engine {
  const fail = (): never => {
    throw new Error(`hearthkit: frontmatter must be plain YAML; "${language}" frontmatter is refused`);
  };
  return { parse: fail, stringify: fail };
}

const OPTS = {
  language: 'yaml',
  engines: {
    yaml: yamlEngine,
    javascript: refuse('javascript'),
    coffee: refuse('coffee'),
    json: refuse('json'),
  },
};

/** Exactly `---` on the first line — nothing else counts as frontmatter. */
const YAML_OPEN = /^---\r?\n/;

export interface Frontmatter {
  data: Record<string, unknown>;
  content: string;
}

/**
 * Split YAML frontmatter from the body. Anything that is not plain YAML frontmatter — a
 * different language tag, malformed YAML, an unsafe YAML tag such as `!!js/function` — degrades
 * to "no frontmatter": the caller sees an empty `data` and the whole file as `content`, rather
 * than an exception that would take down the SessionStart hook.
 */
export function parseFrontmatter(raw: string): Frontmatter {
  if (!YAML_OPEN.test(raw)) return { data: {}, content: raw };
  try {
    const parsed = matter(raw, OPTS);
    const data = parsed.data as unknown;
    return {
      data: typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {},
      content: parsed.content,
    };
  } catch {
    return { data: {}, content: raw };
  }
}

/**
 * Write YAML frontmatter above `content`.
 *
 * The body is handed over as a file object, never as a string: `matter.stringify(<string>, …)`
 * re-parses what it is given (index.js:161), so a body that itself begins with `---js` threw
 * through the refusing engine above — fail-closed, but remote-triggerable, and it would have
 * broken `memory promote` and conflict re-serialisation permanently — while a body beginning
 * `---\nfoo: bar\n---` was absorbed into the frontmatter.
 */
export function stringifyFrontmatter(content: string, data: Record<string, unknown>): string {
  const file = { content, data: {} };
  return matter.stringify(file, data, OPTS);
}
