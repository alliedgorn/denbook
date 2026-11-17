// Quiz best score, counted against the questions the quiz has NOW (Gorn 11-17:
// Module 1 went from 15 to 22 questions and still read "best 100%").
//
// best[id] is a fraction (correct / questions). bestN[id] records how many
// questions that fraction was earned on. A best from a shorter quiz only covers
// those questions, so it is scaled down: 15/15 on the old quiz is 15/22 now.
//
// Rows saved before bestN existed have no count. For those, the answers on file
// are the evidence: fewer answers than questions means the best came from a
// shorter quiz, so the answer count stands in for it. (A retake in progress on
// such a row also reads low until it is finished, which then writes bestN.)

export interface QuizBestFields {
  quiz: Record<string, Record<number, number>>;
  best: Record<string, number>;
  bestN?: Record<string, number>;
}

export function effectiveBest(s: QuizBestFields, id: string, len: number): number | null {
  const best = s.best[id];
  if (best == null) return null;
  if (len <= 0) return best;
  let n = s.bestN?.[id];
  if (n == null) {
    const answered = Object.keys(s.quiz[id] || {}).length;
    n = answered > 0 && answered < len ? answered : len;
  }
  return n >= len ? best : (best * n) / len;
}

// Call once every current question is answered. Keeps the better of the old best
// (scaled to today's length) and this run, and records the length it now covers.
export function recordBest(s: QuizBestFields, id: string, len: number, score: number) {
  s.best[id] = Math.max(effectiveBest(s, id, len) ?? 0, score);
  s.bestN = { ...(s.bestN || {}), [id]: len };
}

// Freeze the count on an old row BEFORE its answers change. Answering the last
// new question, or pressing Retake, would otherwise erase the evidence the
// fallback above reads, and the stale best would count as full marks again.
export function pinBestCount(s: QuizBestFields, id: string, len: number) {
  if (s.best[id] == null || s.bestN?.[id] != null) return;
  const answered = Object.keys(s.quiz[id] || {}).length;
  s.bestN = { ...(s.bestN || {}), [id]: answered > 0 && answered < len ? answered : len };
}
