// Drill rounds parser (frontend/src/study/drillParse.ts, Gorn 11-16). Pure functions, run here
// because the frontend has no unit runner (its `test` is Playwright).
import { describe, expect, test } from 'bun:test';
import { drillEntries, drillKeyFor, mergeEntries, pruneDeleted, toRounds } from '../../../frontend/src/study/drillParse';

const msg = (id: number, sender: string, message: string) => ({ id, sender, message, created_at: '2026-11-16T04:00:00Z' });

describe('drillEntries', () => {
  test('picks up tagged answers and grades for this drill only', () => {
    const msgs = [
      msg(1, 'gorn', '[Study: Bootcamp › LLM › Drill 1]\n[Drill llm-basics:0]\nfirst try'),
      msg(2, 'karo', '[Drill llm-basics:0 fix]\nmissing sampling'),
      msg(3, 'gorn', '[Study: Bootcamp › LLM › Drill 2]\n[Drill llm-basics:1]\nother drill'),
      msg(4, 'karo', '[Lab llm-basics:0 pass]\na LAB grade with the same key shape'),
      msg(5, 'gorn', '[Study: Bootcamp › LLM › Lab]\n[Lab llm-basics:0]\n```\ncode\n```'),
      msg(6, 'gorn', 'untagged question about drill 1'),
    ];
    const e = drillEntries(msgs, 'llm-basics:0');
    expect(e.map(x => [x.id, x.kind, x.ok ?? null, x.text])).toEqual([
      [1, 'answer', null, 'first try'],
      [2, 'grade', false, 'missing sampling'],
    ]);
  });

  test('a grade tag from Gorn is not a grade, and an answer tag from Karo is not an answer', () => {
    const msgs = [msg(1, 'gorn', '[Drill a:0 pass]\nself-graded'), msg(2, 'karo', '[Drill a:0]\nnot an answer')];
    expect(drillEntries(msgs, 'a:0')).toEqual([]);
  });

  test('the tag must open the body: a quoted tag mid-message does not count', () => {
    expect(drillEntries([msg(1, 'gorn', 'I typed [Drill a:0] in the middle')], 'a:0')).toEqual([]);
  });
});

describe('mergeEntries + toRounds', () => {
  const a = { id: 1, kind: 'answer' as const, text: 'r1', at: '' };
  const g1 = { id: 2, kind: 'grade' as const, ok: false, text: 'fix', at: '' };
  const b = { id: 3, kind: 'answer' as const, text: 'r2', at: '' };
  const g2 = { id: 4, kind: 'grade' as const, ok: true, text: 'pass', at: '' };

  test('cached rounds survive when they fall out of the 40-message window', () => {
    const cached = [a, g1];
    const window = [b, g2];
    const merged = mergeEntries(cached, window);
    expect(merged.map(x => x.id)).toEqual([1, 2, 3, 4]);
    const rounds = toRounds(merged);
    expect(rounds.length).toBe(2);
    expect(rounds[0].answer.text).toBe('r1');
    expect(rounds[0].grades.map(g => g.ok)).toEqual([false]);
    expect(rounds[1].grades.map(g => g.ok)).toEqual([true]);
  });

  test('the same message seen twice is one entry', () => {
    expect(mergeEntries([a, g1], [a, g1]).length).toBe(2);
  });

  test('a grade with no answer before it is dropped, an ungraded answer is an open round', () => {
    const rounds = toRounds([g1, b]);
    expect(rounds.length).toBe(1);
    expect(rounds[0].grades).toEqual([]);
  });
});

describe('pruneDeleted (Bertus, PR 150: a deleted DM must leave the card too)', () => {
  const e = (id: number) => ({ id, kind: 'answer' as const, text: String(id), at: '' });
  const window = [msg(10, 'gorn', 'x'), msg(12, 'karo', 'y'), msg(13, 'gorn', 'z')];

  test('an entry inside the fetched window but missing from it was deleted, so it goes', () => {
    expect(pruneDeleted([e(10), e(11), e(12)], window).map(x => x.id)).toEqual([10, 12]);
  });

  test('entries older than the window are only out of view, so they stay', () => {
    expect(pruneDeleted([e(3), e(7), e(12)], window).map(x => x.id)).toEqual([3, 7, 12]);
  });

  test('an empty fetch (load error) prunes nothing', () => {
    expect(pruneDeleted([e(10), e(11)], []).map(x => x.id)).toEqual([10, 11]);
  });
});

describe('drillKeyFor (Gnarl, PR 150: the two tracks share module ids)', () => {
  test('the same module and drill on two tracks get different keys', () => {
    expect(drillKeyFor('ai', 'rag', 0)).not.toBe(drillKeyFor('boot', 'rag', 0));
  });

  test('a cross-track answer and grade never land on the other track card', () => {
    const msgs = [
      msg(1, 'gorn', `[Study: Interview block › RAG › Drill 1]\n[Drill ${drillKeyFor('ai', 'rag', 0)}]\ninterview answer`),
      msg(2, 'karo', `[Drill ${drillKeyFor('ai', 'rag', 0)} pass]\nok`),
    ];
    expect(drillEntries(msgs, drillKeyFor('boot', 'rag', 0))).toEqual([]);
    expect(drillEntries(msgs, drillKeyFor('ai', 'rag', 0)).length).toBe(2);
  });

  test('every real key fits the tag charset, so the regexes stay tight', () => {
    for (const k of [drillKeyFor('ai', 'llm-basics', 0), drillKeyFor('boot', 'evals', 12)]) {
      expect(drillEntries([msg(1, 'gorn', `[Drill ${k}]\nx`)], k).length).toBe(1);
    }
  });
});
