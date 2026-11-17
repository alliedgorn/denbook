// Pure helpers for DrillRounds.tsx (kept out of the component file for React fast refresh).
import { PEER, type Msg } from './studyPeer';
import { DRILL_TAG_RE, DRILL_VERDICT_RE } from './labTags';

const CTX_RE = /^\[Study: [^\]\n]{1,200}\]\n?/;

export interface Entry { id: number; kind: 'answer' | 'grade'; ok?: boolean; text: string; at: string }

// The entries in this thread that belong to this drill.
// peer: who grades in this thread (Karo for the owner, Gnarl for a guest).
export function drillEntries(msgs: Msg[], key: string, peer: string = PEER): Entry[] {
  const out: Entry[] = [];
  for (const m of msgs) {
    if (m.sender === peer) {
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


// Bertus, PR 150 review: the cache must not outlive a deletion (#55 removal, T#975).
// The fetch is a window over the newest messages. A cached entry whose id falls inside
// that window but is not in it was deleted on the server, so drop it. Entries older than
// the window are left alone: they are only out of view, not gone. So are entries NEWER than
// the window (Gnarl): fetches are not ordered, so a stale window can resolve after a newer
// one, and it must not drop the round Gorn just sent.
export function pruneDeleted(cached: Entry[], msgs: Msg[]): Entry[] {
  if (!msgs.length) return cached;
  const ids = new Set(msgs.map(m => m.id));
  const lo = Math.min(...ids);
  const hi = Math.max(...ids);
  return cached.filter(e => e.id < lo || e.id > hi || ids.has(e.id));
}

// Gnarl, PR 150 review: the interview block and the Bootcamp share module ids (rag, agents,
// evals), so the drill key carries its track. It goes into Gorn's DMs on the first round,
// so it has to be right before he uses it: renaming later would orphan every round sent.
export type DrillTrack = 'ai' | 'boot';
export function drillKeyFor(track: DrillTrack, moduleId: string, i: number): string {
  return `${track}-${moduleId}:${i}`;
}
