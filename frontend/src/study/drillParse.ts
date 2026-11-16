// Pure helpers for DrillRounds.tsx (kept out of the component file for React fast refresh).
import { PEER, type Msg } from './studyChat';
import { DRILL_TAG_RE, DRILL_VERDICT_RE } from './labTags';

const CTX_RE = /^\[Study: [^\]\n]{1,200}\]\n?/;

export interface Entry { id: number; kind: 'answer' | 'grade'; ok?: boolean; text: string; at: string }

// The entries in this thread that belong to this drill.
export function drillEntries(msgs: Msg[], key: string): Entry[] {
  const out: Entry[] = [];
  for (const m of msgs) {
    if (m.sender === PEER) {
      const v = DRILL_VERDICT_RE.exec(m.message);
      if (v && v[1] === key) out.push({ id: m.id, kind: 'grade', ok: v[2] === 'pass', text: m.message.slice(v[0].length).trim(), at: m.created_at });
    } else {
      const ctx = CTX_RE.exec(m.message);
      const body = ctx ? m.message.slice(ctx[0].length) : m.message;
      const t = DRILL_TAG_RE.exec(body);
      if (t && t[1] === key) out.push({ id: m.id, kind: 'answer', text: body.slice(t[0].length).trim(), at: m.created_at });
    }
  }
  return out;
}

// Merge by message id (newer copy wins), oldest first.
export function mergeEntries(a: Entry[], b: Entry[]): Entry[] {
  const byId = new Map<number, Entry>();
  for (const e of [...a, ...b]) byId.set(e.id, e);
  return [...byId.values()].sort((x, y) => x.id - y.id);
}

// Rounds: each answer opens a round; grades attach to the round before them.
export function toRounds(entries: Entry[]): { answer: Entry; grades: Entry[] }[] {
  const rounds: { answer: Entry; grades: Entry[] }[] = [];
  for (const e of entries) {
    if (e.kind === 'answer') rounds.push({ answer: e, grades: [] });
    else if (rounds.length) rounds[rounds.length - 1].grades.push(e);
  }
  return rounds;
}

