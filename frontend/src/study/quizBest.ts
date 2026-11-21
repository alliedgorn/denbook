// Quiz best score, counted against the questions the quiz has NOW (Gorn 11-17:
// Module 1 went from 15 to 22 questions and still read "best 100%").
//
// best[id] is a fraction (correct / questions). bestN[id] records how many
// questions that fraction was earned on. A best from a shorter quiz only covers
// those questions, so it is scaled down: 15/15 on the old quiz is 15/22 now.
//
// Rows saved before bestN existed (PR 170) carry a best that may come from an older,
// shorter quiz, and the old code kept the max across retakes, so it can't be trusted.
// Gorn's own row: 20 of 22 right, finished before 170 shipped, still read 100%.
// For those rows the answers on file are the only evidence, so the score is
// re-counted from them against today's questions (missing answers count as wrong).
// No answers on file (Retake pressed before 170, Bertus T#1000) means no evidence,
// so the row reads as not taken yet instead of keeping the old best.

export interface QuizBestFields {
  quiz: Record<string, Record<number, number>>;
  best: Record<string, number>;
  bestN?: Record<string, number>;
}

export type QuizKey = readonly { a: number }[];

// Score of the answers on file, over every question the quiz has now.
function scoreOnFile(s: QuizBestFields, id: string, key: QuizKey): number | null {
  const ans = s.quiz[id] || {};
  if (!key.length || Object.keys(ans).length === 0) return null;
  return key.filter((q, i) => ans[i] === q.a).length / key.length;
}

export function effectiveBest(s: QuizBestFields, id: string, key: QuizKey): number | null {
  const best = s.best[id];
  if (best == null) return null;
  const len = key.length;
  if (len <= 0) return best;
  const n = s.bestN?.[id];
  if (n == null) return scoreOnFile(s, id, key); // pre-170 row: re-count, don't trust
  return n >= len ? best : (best * n) / len;
}

// Turn a pre-170 row into a counted one BEFORE its answers change (answering a
// question or pressing Retake would otherwise destroy the evidence). Rows that
// already have bestN are left alone.
export function pinBestCount(s: QuizBestFields, id: string, key: QuizKey) {
  if (s.best[id] == null || s.bestN?.[id] != null) return;
  const sc = scoreOnFile(s, id, key);
  if (sc == null) { delete s.best[id]; return; }
  s.best[id] = sc;
  s.bestN = { ...(s.bestN || {}), [id]: key.length };
}

// Call once every current question is answered. Keeps the better of the old best
// (scaled to today's length) and this run, and records the length it now covers.
export function recordBest(s: QuizBestFields, id: string, key: QuizKey, score: number) {
  s.best[id] = Math.max(effectiveBest(s, id, key) ?? 0, score);
  s.bestN = { ...(s.bestN || {}), [id]: key.length };
}
