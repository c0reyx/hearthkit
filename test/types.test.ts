import { describe, expect, it } from 'vitest';
import { GLOBAL, HearthError, assertSafeName, layerId, parseLayerId, project } from '../src/core/types.js';

describe('layer ids', () => {
  it('round-trips global and project layers', () => {
    expect(layerId(GLOBAL)).toBe('global');
    expect(layerId(project('acme-crm'))).toBe('projects/acme-crm');
    expect(parseLayerId('global')).toEqual(GLOBAL);
    expect(parseLayerId('projects/acme-crm')).toEqual(project('acme-crm'));
  });
  it('rejects unknown layer ids with a user error', () => {
    expect(() => parseLayerId('agents/x')).toThrow(HearthError);
    expect(() => parseLayerId('projects/../x')).toThrow(HearthError);
  });
});

describe('assertSafeName', () => {
  it('accepts kebab names and rejects path tricks', () => {
    expect(() => assertSafeName('prefers-tables')).not.toThrow();
    expect(() => assertSafeName('a.b_c-1')).not.toThrow();
    expect(() => assertSafeName('../etc')).toThrow(HearthError);
    expect(() => assertSafeName('a/b')).toThrow(HearthError);
    expect(() => assertSafeName('')).toThrow(HearthError);
    expect(() => assertSafeName('.hidden')).toThrow(HearthError);
  });
});
