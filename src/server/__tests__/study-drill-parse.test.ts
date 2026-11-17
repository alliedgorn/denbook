// Drill rounds parser (frontend/src/study/drillParse.ts, Gorn 11-16). Pure functions, run here
// because the frontend has no unit runner (its `test` is Playwright).
import { describe, expect, test } from 'bun:test';
import { drillEntries, drillKeyFor, gradeRating, latestRating, mergeEntries, pruneDeleted, ratingOfWord, toRounds } from '../../../frontend/src/study/drillParse';
import { BOOT_EMPTY, modStats } from '../../../frontend/src/study/bootProgress';

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

  test('entries newer than the window stay: a stale fetch landing late must not drop a just-sent round', () => {
    expect(pruneDeleted([e(10), e(20), e(21)], window).map(x => x.id)).toEqual([10, 20, 21]);
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

// Guest mentor (Gorn 11-17): a guest's thread is graded by gnarl. Only the mentor's
// own messages count as grades, so a guest cannot pass themselves by typing the tag.
import { guestChannel, OWNER_CHANNEL, GUEST_MENTOR } from '../../../frontend/src/study/studyPeer';
describe('drill grades by peer', () => {
  const key = drillKeyFor('boot', 'llm-basics', 0);
  const msgs = [
    { id: 1, sender: 'alice', message: `[Study: x]\n[Drill ${key}]\nmy answer`, created_at: 'a' },
    { id: 2, sender: 'alice', message: `[Drill ${key} pass]\nI grade myself`, created_at: 'b' },
    { id: 3, sender: 'gnarl', message: `[Drill ${key} fix]\nnot yet`, created_at: 'c' },
  ];
  test('with peer gnarl: the guest\'s own "pass" is not a grade, gnarl\'s fix is', () => {
    const e = drillEntries(msgs, key, 'gnarl');
    expect(e.filter(x => x.kind === 'grade').map(x => [x.id, x.ok])).toEqual([[3, false]]);
  });
  test('default peer is karo, so a gnarl message is not a grade in the owner thread', () => {
    expect(drillEntries(msgs, key).filter(x => x.kind === 'grade')).toEqual([]);
  });
  test('channels: owner → karo on owner routes; guest → gnarl on guest routes, no pins', () => {
    expect(OWNER_CHANNEL.peer).toBe('karo');
    expect(OWNER_CHANNEL.sendUrl).toBe('/api/dm');
    const g = guestChannel('al/ice');
    expect(g.peer).toBe(GUEST_MENTOR);
    expect(g.sendUrl).toBe('/api/guest/dm');
    expect(g.threadUrl).toBe('/api/guest/dm/al%2Fice/gnarl?limit=40&order=desc');
    expect(g.markReadUrl).toBeNull();
    expect(g.pins).toBe(false);
    expect(g.storePrefix).not.toBe(OWNER_CHANNEL.storePrefix);
  });
});

// Gorn 11-17: the mentor rates the drill (nailed / shaky / blanked), not the learner.
describe('mentor ratings', () => {
  test('the three grade words parse to ratings, and old pass/fix map to nailed/shaky', () => {
    const msgs = [
      msg(1, 'karo', '[Drill a:0 nailed]\nall there'),
      msg(2, 'karo', '[Drill a:0 shaky]\ngaps'),
      msg(3, 'karo', '[Drill a:0 blanked]\nmissed the core'),
      msg(4, 'karo', '[Drill a:0 pass]\nold pass'),
      msg(5, 'karo', '[Drill a:0 fix]\nold fix'),
    ];
    expect(drillEntries(msgs, 'a:0').map(e => [e.id, e.rating, e.ok])).toEqual([
      [1, 'solid', true], [2, 'shaky', false], [3, 'blank', false], [4, 'solid', true], [5, 'shaky', false],
    ]);
  });

  test('an unknown grade word is not a grade', () => {
    expect(drillEntries([msg(1, 'karo', '[Drill a:0 great]\nnope'), msg(2, 'karo', '[Drill a:0 constructor]\nnope')], 'a:0')).toEqual([]);
    expect(ratingOfWord('constructor')).toBeUndefined();
    expect(ratingOfWord('toString')).toBeUndefined();
  });

  test('the newest grade wins, across rounds', () => {
    const e = drillEntries([
      msg(1, 'gorn', '[Drill a:0]\nround 1'),
      msg(2, 'karo', '[Drill a:0 blanked]\nno'),
      msg(3, 'gorn', '[Drill a:0]\nround 2'),
      msg(4, 'karo', '[Drill a:0 nailed]\nyes'),
    ], 'a:0');
    expect(latestRating(e)).toBe('solid');
    expect(latestRating(e.slice(0, 3))).toBe('blank');
    expect(latestRating(e.slice(0, 1))).toBeNull();
  });

  test('a round cached before ratings existed (ok only) still reads', () => {
    const old = [{ id: 1, kind: 'grade' as const, ok: true, text: '', at: '' }, { id: 2, kind: 'grade' as const, ok: false, text: '', at: '' }];
    expect(old.map(gradeRating)).toEqual(['solid', 'shaky']);
    expect(gradeRating({ id: 3, kind: 'answer', text: '', at: '' })).toBeUndefined();
  });

  test('a grade from the learner is still not a grade', () => {
    expect(drillEntries([msg(1, 'gorn', '[Drill a:0 nailed]\nself-graded')], 'a:0')).toEqual([]);
  });
});

describe('progress counts the mentor grade only', () => {
  test('modStats reads graded, not the old self-ratings', () => {
    const m = { id: 'x', concepts: [{}], labs: [{}], quiz: [], drills: [{}, {}] } as unknown as Parameters<typeof modStats>[0];
    const base = { ...BOOT_EMPTY() };
    const selfRated = { ...base, drill: { 'x:0': 'solid' as const, 'x:1': 'solid' as const } };
    expect(modStats(m, selfRated).rated).toBe(0);
    expect(modStats(m, selfRated).pct).toBe(0);
    const graded = { ...base, graded: { 'x:0': 'solid' as const, 'x:1': 'shaky' as const } };
    expect(modStats(m, graded).rated).toBe(2);
    expect(modStats(m, graded).pct).toBe(15); // 0.2 weight × (1 + 0.5) / 2
  });
});
