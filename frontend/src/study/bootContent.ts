import { useSyncExternalStore } from 'react';
import { BOOT_MODULES, BOOT_PLANNED } from './bootModules';
import { checkBootFile } from './contentGuard';
import type { BootModule, PlannedModule } from './types';

// Bootcamp content, live from the server (Gorn 11-14: content changes without a PR or a
// rebuild). Starts as the bundled copy and swaps to the live file once it loads and
// passes the shape check. Any failure (no file, 403, bad JSON, wrong shape) just keeps
// the bundled copy, so the page never goes blank. Fetched once per page load.

export interface BootContent {
  modules: BootModule[];
  planned: PlannedModule[];
  source: 'bundled' | 'live';
  note?: string;
}

let current: BootContent = { modules: BOOT_MODULES, planned: BOOT_PLANNED, source: 'bundled' };
const subs = new Set<() => void>();
let started = false;

function set(next: BootContent) {
  current = next;
  subs.forEach(f => f());
}

function load() {
  if (started) return;
  started = true;
  fetch('/api/study/content/bootcamp', { cache: 'no-store' })
    .then(r => (r.ok ? r.json() : null))
    .then(j => {
      if (!j) return;
      const out = checkBootFile(j.content);
      if (typeof out === 'string') {
        console.warn(`study: live bootcamp content rejected (${out}); using the bundled copy`);
        set({ ...current, note: `Live content rejected: ${out}. Showing the built-in copy.` });
        return;
      }
      set({ ...out, source: 'live' });
    })
    .catch(() => { /* offline or server down: bundled copy stays */ });
}

// For non-component code (progress maths). Components use the hook so they re-render.
export function bootContent(): BootContent {
  return current;
}

export function useBootContent(): BootContent {
  load();
  return useSyncExternalStore(
    cb => { subs.add(cb); return () => { subs.delete(cb); }; },
    () => current,
  );
}
