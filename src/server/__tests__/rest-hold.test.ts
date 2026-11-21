/**
 * T#1025: a Beast at rest gets no doorbells, for a bounded time. These pin the
 * predicate the drain and the Tier-2 fallback share, including the fail-open
 * cases. The call sites are pinned by pane-guard.test.ts (real drain cycle and
 * Tier-2 against a private tmux server).
 */
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { isBeastAtRest, restHoldState, REST_HOLD_MAX_MS } from '../../notify.ts';

const NOW = 1_800_000_000_000;

function db(rows: Array<[string, string | null, number | null]>): Database {
  const d = new Database(':memory:');
  d.run("CREATE TABLE beast_profiles (name TEXT PRIMARY KEY, rest_status TEXT DEFAULT 'active', rest_since INTEGER)");
  for (const r of rows) d.prepare('INSERT INTO beast_profiles (name, rest_status, rest_since) VALUES (?, ?, ?)').run(...r);
  return d;
}

describe('restHoldState (T#1025)', () => {
  const d = db([
    ['karo', 'rest', NOW - 60_000],
    ['boro', 'rest', NOW - REST_HOLD_MAX_MS],
    ['sable', 'rest', null],
    ['gnarl', 'active', null],
    ['rax', null, null],
  ]);

  test('rest, started a minute ago: held', () => expect(restHoldState(d, 'karo', NOW)).toBe('held'));
  test('name is matched lowercase', () => expect(isBeastAtRest(d, 'Karo', NOW)).toBe(true));
  test('rest past the bound: lapsed, delivers', () => {
    expect(restHoldState(d, 'boro', NOW)).toBe('lapsed');
    expect(isBeastAtRest(d, 'boro', NOW)).toBe(false);
  });
  test('the bound is 60 min by default', () => expect(REST_HOLD_MAX_MS).toBe(60 * 60 * 1000));
  test('rest with no rest_since: delivers (fail-open)', () => expect(restHoldState(d, 'sable', NOW)).toBe('awake'));
  test('active delivers', () => expect(restHoldState(d, 'gnarl', NOW)).toBe('awake'));
  test('null status delivers', () => expect(restHoldState(d, 'rax', NOW)).toBe('awake'));
  test('unknown Beast delivers', () => expect(restHoldState(d, 'nobody', NOW)).toBe('awake'));
  test('no db handle delivers (fail-open)', () => expect(restHoldState(null, 'karo', NOW)).toBe('awake'));
  test('a db without the column delivers (fail-open)', () => {
    const old = new Database(':memory:');
    old.run("CREATE TABLE beast_profiles (name TEXT PRIMARY KEY, rest_status TEXT)");
    old.run("INSERT INTO beast_profiles VALUES ('karo', 'rest')");
    expect(restHoldState(old, 'karo', NOW)).toBe('awake');
  });
});
