/**
 * T#1025: a Beast at rest gets no doorbells. The drain and the Tier-2
 * fallback both ask isBeastAtRest; these pin its answers, including the
 * fail-open cases.
 */
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { isBeastAtRest } from '../../notify.ts';

function db(rows: Array<[string, string | null]>): Database {
  const d = new Database(':memory:');
  d.run("CREATE TABLE beast_profiles (name TEXT PRIMARY KEY, rest_status TEXT DEFAULT 'active')");
  for (const [n, s] of rows) d.prepare('INSERT INTO beast_profiles (name, rest_status) VALUES (?, ?)').run(n, s);
  return d;
}

describe('isBeastAtRest (T#1025)', () => {
  const d = db([['karo', 'rest'], ['gnarl', 'active'], ['rax', null]]);

  test('rest holds', () => expect(isBeastAtRest(d, 'karo')).toBe(true));
  test('name is matched lowercase', () => expect(isBeastAtRest(d, 'Karo')).toBe(true));
  test('active delivers', () => expect(isBeastAtRest(d, 'gnarl')).toBe(false));
  test('null status delivers', () => expect(isBeastAtRest(d, 'rax')).toBe(false));
  test('unknown Beast delivers', () => expect(isBeastAtRest(d, 'nobody')).toBe(false));
  test('no db handle delivers (fail-open)', () => expect(isBeastAtRest(null, 'karo')).toBe(false));
  test('a broken db delivers (fail-open)', () => {
    const broken = new Database(':memory:'); // no beast_profiles table
    expect(isBeastAtRest(broken, 'karo')).toBe(false);
  });
});
