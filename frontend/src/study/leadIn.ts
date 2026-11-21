import type { Block } from './types';

// A paragraph that opens with a bold lead-in ("Dot product, slowly. ") starts a
// section of the lesson. Returns its label for the "In this lesson" index.
export function leadIn(blk: Block): string | null {
  if (!('p' in blk)) return null;
  const first = blk.p[0];
  if (!first || typeof first === 'string' || !('b' in first)) return null;
  const label = first.b.trim().replace(/[.:]$/, '').trim();
  return label || null;
}

export const sectionId = (prefix: string, i: number) => `${prefix}-s${i}`;
