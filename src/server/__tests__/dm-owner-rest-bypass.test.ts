// T#1025 follow-up (Bertus, PR 192): pin WHO gets the rest-hold bypass at the
// DM level. sendDm decides fromOwner on the STORED sender (auth-derived), never
// on notifyAs, which is only a display label. Under bun test, enqueueNotification
// lands in notifySink (T#981 preload), so nothing reaches a real seat.
import { describe, test, expect, beforeEach } from 'bun:test';
import { sendDm } from '../../dm/handler.ts';
import { notifySink } from '../../notify.ts';
import { sqlite } from '../../db/index.ts';

// The recipient must be in the oracle registry or sendDm skips the notify.
// The registry reads beast_profiles and falls back to a default list that has karo.
try { sqlite.prepare("INSERT OR IGNORE INTO beast_profiles (name) VALUES ('karo')").run(); } catch { /* table absent: default registry */ }

function lastFor(to: string) {
  const hits = notifySink.filter(n => n.via === 'enqueue' && n.target === to);
  expect(hits.length).toBe(1);
  return hits[0];
}

describe('DM rest-hold bypass goes to the owner only (T#1025)', () => {
  beforeEach(() => { notifySink.length = 0; });

  test('a DM from gorn is fromOwner', () => {
    const r = sendDm('gorn', 'karo', 'owner line');
    expect(r.notified).toBe(true);
    expect(lastFor('karo').fromOwner).toBe(true);
  });

  test('stored sender is lowercased first, so "Gorn" is the owner too', () => {
    sendDm('Gorn', 'karo', 'owner line, capitalised');
    expect(lastFor('karo').fromOwner).toBe(true);
  });

  test('a DM from a Beast is not fromOwner', () => {
    sendDm('bertus', 'karo', 'beast line');
    expect(lastFor('karo').fromOwner).toBeUndefined();
  });

  test('a guest DM is not fromOwner', () => {
    sendDm('[Guest] gorn', 'karo', 'guest named gorn');
    expect(lastFor('karo').fromOwner).toBeUndefined();
  });

  test('notifyAs "gorn" does not grant the bypass', () => {
    sendDm('bertus', 'karo', 'beast line shown as gorn', 'gorn');
    const n = lastFor('karo');
    expect(n.fromOwner).toBeUndefined();
    expect(n.text).toContain('[DM from gorn]'); // the label changed, the bypass did not
  });
});
