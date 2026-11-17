import { bootContent } from './bootContent';
import type { AiProgress } from './AiTrack';
import type { BootModule } from './types';
import { effectiveBest } from './quizBest';
import { drillScore } from './drillParse';

// Bootcamp progress shape and scoring (T#967). Kept out of BootcampTrack.tsx so
// that file only exports components (react-refresh).

export interface LogEntry {
  shipped: string;
  ran: boolean;
}

export interface BootProgress extends AiProgress {
  labs: Record<string, true>;
  log: Record<string, LogEntry>;
}

export const BOOT_EMPTY = (): BootProgress => ({
  read: {}, quiz: {}, best: {}, drill: {}, notes: {}, labs: {}, log: {}, updatedAt: 0,
});

export function modStats(m: BootModule, s: BootProgress) {
  const read = m.concepts.filter((_, i) => s.read[`${m.id}:${i}`]).length;
  const labs = m.labs.filter((_, i) => s.labs[`${m.id}:${i}`]).length;
  const best = effectiveBest(s, m.id, m.quiz) || 0;
  const { rated, sum: dsum } = drillScore(m.id, m.drills.length, s.graded); // mentor's grades only
  // Labs carry the most weight: this track is about code that runs.
  const pct = Math.round(100 * (
    0.15 * read / m.concepts.length + 0.5 * labs / m.labs.length + 0.15 * best + 0.2 * dsum / m.drills.length
  ));
  return { read, labs, best, rated, pct };
}

export function bootTrackPct(s: BootProgress) {
  const all = bootContent().modules.map(m => modStats(m, s).pct);
  return Math.round(all.reduce((a, b) => a + b, 0) / all.length);
}
