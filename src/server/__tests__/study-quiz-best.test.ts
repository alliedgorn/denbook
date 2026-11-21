// Quiz best vs question count (PR 170, re-count of pre-170 rows: Gorn 20/22 read 100%; Bertus T#1000).
// Pure frontend helper, run in the backend test runner like study-drill-parse.
import { expect, test } from 'bun:test';
import { effectiveBest, recordBest, pinBestCount } from '../../../frontend/src/study/quizBest';
const key = (n: number) => Array.from({ length: n }, () => ({ a: 0 }));
const ans = (n: number, wrong: number[] = []) => Object.fromEntries([...Array(n)].map((_, i) => [i, wrong.includes(i) ? 1 : 0]));
test("Gorn's real row: pre-170, 22 answers with 2 wrong, best 1 → reads 20/22", () => {
  const s: any = { quiz: { m: ans(22, [16, 17]) }, best: { m: 1 } };
  expect(effectiveBest(s, 'm', key(22))).toBeCloseTo(20 / 22);
});
test('pre-170 15/15 on a 22-question quiz reads 15/22', () => {
  expect(effectiveBest({ quiz: { m: ans(15) }, best: { m: 1 } }, 'm', key(22))).toBeCloseTo(15 / 22);
});
test('Bertus T#1000: pre-170 Retake left no answers → not taken, not 100%', () => {
  const s: any = { quiz: {}, best: { m: 1 } };
  expect(effectiveBest(s, 'm', key(22))).toBeNull();
  pinBestCount(s, 'm', key(22));
  expect(s.best.m).toBeUndefined();
});
test('pin before Retake keeps the re-counted score; finishing does not restore 100%', () => {
  const s: any = { quiz: { m: ans(22, [16, 17]) }, best: { m: 1 } };
  pinBestCount(s, 'm', key(22)); delete s.quiz.m;
  expect(effectiveBest(s, 'm', key(22))).toBeCloseTo(20 / 22);
  recordBest(s, 'm', key(22), 18 / 22);
  expect(s.best.m).toBeCloseTo(20 / 22);
  recordBest(s, 'm', key(22), 1);
  expect(s.best.m).toBe(1); expect(s.bestN.m).toBe(22);
});
test('rows with bestN behave as in PR 170', () => {
  expect(effectiveBest({ quiz: {}, best: { m: 1 }, bestN: { m: 10 } }, 'm', key(20))).toBe(0.5);
  expect(effectiveBest({ quiz: {}, best: { m: 0.8 }, bestN: { m: 15 } }, 'm', key(15))).toBe(0.8);
  expect(effectiveBest({ quiz: {}, best: {} }, 'm', key(5))).toBeNull();
});
