import { describe, expect, it } from 'vitest';
import { slugify } from '../src/core/slug.js';

describe('slugify', () => {
  it('lowercases, replaces punctuation, trims dashes', () => {
    expect(slugify('Corey prefers tables & visuals!')).toBe('corey-prefers-tables-visuals');
    expect(slugify('  --Hello World--  ')).toBe('hello-world');
  });
  it('caps length at 60 without a trailing dash', () => {
    const s = slugify('a'.repeat(59) + ' bcd');
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.endsWith('-')).toBe(false);
  });
  it('returns empty string for nothing usable', () => {
    expect(slugify('!!!')).toBe('');
  });
});
