import { afterEach, describe, expect, it } from 'vitest';
import { parseFrontmatter, stringifyFrontmatter } from '../src/core/frontmatter.js';

const marker = () => (globalThis as Record<string, unknown>).__pwned;
const clear = () => delete (globalThis as Record<string, unknown>).__pwned;

describe('parseFrontmatter', () => {
  afterEach(clear);

  it('does not execute ---js frontmatter (C1 proof of concept)', () => {
    clear();
    const raw = "---js\n(function(){ globalThis.__pwned = true; return {name:'x'} })()\n---\nbody\n";
    const parsed = parseFrontmatter(raw);
    expect(marker()).toBeUndefined();
    expect(parsed.data).toEqual({});
    expect(parsed.content).toBe(raw);
  });

  it('treats every non-YAML opening delimiter as "no frontmatter"', () => {
    for (const open of ['---js', '---javascript', '---json', '--- js', '---coffee', '---yaml']) {
      const raw = `${open}\nname: x\n---\nbody\n`;
      expect(parseFrontmatter(raw)).toEqual({ data: {}, content: raw });
    }
  });

  it('rejects unsafe YAML tags instead of running or throwing them', () => {
    clear();
    const raw = '---\nname: !!js/function "function(){ globalThis.__pwned = true; }"\n---\nbody\n';
    const parsed = parseFrontmatter(raw);
    expect(marker()).toBeUndefined();
    expect(parsed.data).toEqual({});
    expect(parsed.content).toBe(raw);
  });

  it('degrades rather than throwing on malformed YAML', () => {
    const raw = '---\nname: [unclosed\n---\nbody\n';
    expect(() => parseFrontmatter(raw)).not.toThrow();
    expect(parseFrontmatter(raw).data).toEqual({});
  });

  it('ignores frontmatter that is not a mapping', () => {
    expect(parseFrontmatter('---\n- a\n- b\n---\nbody\n').data).toEqual({});
  });

  it('round-trips ordinary YAML frontmatter', () => {
    const raw = stringifyFrontmatter('the body\n', { name: 'uses-pnpm', metadata: { pinned: true } });
    expect(raw.startsWith('---\n')).toBe(true);
    const parsed = parseFrontmatter(raw);
    expect(parsed.data).toEqual({ name: 'uses-pnpm', metadata: { pinned: true } });
    expect(parsed.content.trim()).toBe('the body');
  });

  it('reads a file with no frontmatter at all as pure content', () => {
    expect(parseFrontmatter('just text\n')).toEqual({ data: {}, content: 'just text\n' });
  });

  it('never re-parses the body it is given (C1 round 1)', () => {
    // A body that starts with a delimiter must survive verbatim: gray-matter's stringify used to
    // re-parse a string body, so `---js` threw (breaking promote and conflict re-serialisation
    // permanently) and `---\nfoo: bar\n---` was absorbed into the frontmatter.
    const js = "---js\n(function(){ globalThis.__pwned = true })()\n---\ntail\n";
    const out = stringifyFrontmatter(js, { name: 'weird' });
    expect(marker()).toBeUndefined();
    expect(out).toContain('name: weird');
    expect(parseFrontmatter(out).content).toContain('---js');

    const absorbed = stringifyFrontmatter('---\nfoo: bar\n---\nreal body\n', { name: 'weird2' });
    const back = parseFrontmatter(absorbed);
    expect(back.data).toEqual({ name: 'weird2' });
    expect(back.data.foo).toBeUndefined();
    expect(back.content).toContain('foo: bar');
  });
});
