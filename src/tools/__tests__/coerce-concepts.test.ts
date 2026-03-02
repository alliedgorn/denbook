import { describe, expect, it } from 'bun:test';
import { coerceConcepts } from '../learn.ts';

describe('coerceConcepts', () => {
  it('handles proper string array', () => {
    expect(coerceConcepts(['coconut', 'brewing'])).toEqual(['coconut', 'brewing']);
  });

  it('handles comma-separated string (the bug)', () => {
    expect(coerceConcepts('coconut, beer-cocktail, pina-colada')).toEqual([
      'coconut',
      'beer-cocktail',
      'pina-colada',
    ]);
  });

  it('handles single string without commas', () => {
    expect(coerceConcepts('brewing')).toEqual(['brewing']);
  });

  it('handles undefined', () => {
    expect(coerceConcepts(undefined)).toEqual([]);
  });

  it('handles null', () => {
    expect(coerceConcepts(null)).toEqual([]);
  });

  it('handles empty array', () => {
    expect(coerceConcepts([])).toEqual([]);
  });

  it('handles empty string', () => {
    expect(coerceConcepts('')).toEqual([]);
  });

  it('trims whitespace from comma-separated values', () => {
    expect(coerceConcepts('  foo ,  bar  , baz ')).toEqual(['foo', 'bar', 'baz']);
  });

  it('filters empty entries from trailing commas', () => {
    expect(coerceConcepts('foo, , bar,')).toEqual(['foo', 'bar']);
  });
});
