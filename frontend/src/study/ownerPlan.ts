import { useSyncExternalStore } from 'react';

// The owner's own bootcamp schedule and job-hunt plan (Gorn 11-17, option b of
// Bertus's PR 171 note). This text used to be compiled into the JS bundle, which
// /assets serves to anyone with no cookie. It now lives only in the runtime file
// <contentDir>/bootcamp-plan.json behind GET /api/study/content/bootcamp-plan,
// which answers the owner session only (guests are limited to "bootcamp").
// Nothing here falls back to a bundled copy: no file means no plan sections.

export interface OwnerPlan {
  dayTitle: string;     // section headings live in the file too: they say what the plan is about
  sideTitle: string;
  workingDay: [string, string, string][]; // time, block, what
  ramp: string;
  logNote: string;      // the line after the log colours (owner's coaching note)
  jobHunt: { b?: string; t: string }[];
}

type State = OwnerPlan | 'loading' | 'none';

const MAX = 600;
const str = (x: unknown): x is string => typeof x === 'string' && x.length <= MAX;

// Strings only, short, bounded lists. Rendered as React text, never HTML.
export function checkOwnerPlan(x: unknown): OwnerPlan | null {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const o = x as Record<string, unknown>;
  const wd = o.workingDay, jh = o.jobHunt;
  if (!Array.isArray(wd) || wd.length > 20) return null;
  if (!wd.every(r => Array.isArray(r) && r.length === 3 && r.every(str))) return null;
  if (!str(o.ramp) || !str(o.dayTitle) || !str(o.sideTitle) || !str(o.logNote)) return null;
  if (!Array.isArray(jh) || jh.length > 20) return null;
  const item = (i: unknown) => {
    if (!i || typeof i !== 'object' || Array.isArray(i)) return false;
    const r = i as Record<string, unknown>;
    return str(r.t) && (r.b === undefined || str(r.b));
  };
  if (!jh.every(item)) return null;
  return {
    dayTitle: o.dayTitle as string,
    sideTitle: o.sideTitle as string,
    workingDay: wd as [string, string, string][],
    ramp: o.ramp as string,
    logNote: o.logNote as string,
    jobHunt: (jh as { b?: string; t: string }[]).map(i => (i.b === undefined ? { t: i.t } : { b: i.b, t: i.t })),
  };
}

let current: State = 'loading';
const subs = new Set<() => void>();
let started = false;

function set(next: State) {
  current = next;
  subs.forEach(f => f());
}

function load() {
  if (started) return;
  started = true;
  fetch('/api/study/content/bootcamp-plan', { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null))
    .then(j => {
      const plan = j ? checkOwnerPlan(j.content) : null;
      if (j && !plan) console.warn('study: bootcamp-plan content rejected (wrong shape)');
      set(plan || 'none');
    })
    .catch(() => set('none'));
}

// Only call with enabled=true for the owner: a guest never even asks.
export function useOwnerPlan(enabled: boolean): State {
  if (enabled) load();
  const s = useSyncExternalStore(
    cb => { subs.add(cb); return () => { subs.delete(cb); }; },
    () => current,
  );
  return enabled ? s : 'none';
}
