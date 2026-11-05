import { useCallback, useEffect, useRef, useState } from 'react';

// Loads and saves one track's progress at /api/study/progress/:track (T#963).
// The server copy is the source of truth. Nothing is written until the first
// load has succeeded, so a failed load can never overwrite saved progress
// with an empty state.

export type SyncState = 'loading' | 'saved' | 'saving' | 'error' | 'load-error';

const SAVE_DELAY_MS = 800;

export function useStudyProgress<T extends object>(track: string, empty: () => T) {
  const [state, setState] = useState<T>(empty);
  const [sync, setSync] = useState<SyncState>('loading');
  const loaded = useRef(false);
  const latest = useRef<T>(state);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const writing = useRef(false);
  const again = useRef(false);
  const emptyRef = useRef(empty);

  const load = useCallback(async () => {
    setSync('loading');
    try {
      const res = await fetch(`/api/study/progress/${track}`);
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      const next = { ...emptyRef.current(), ...(body.data || {}) } as T;
      latest.current = next;
      setState(next);
      loaded.current = true;
      setSync('saved');
    } catch {
      setSync('load-error');
    }
  }, [track]);

  useEffect(() => { load(); }, [load]);

  const flush = useCallback(async () => {
    if (!loaded.current) return;
    if (writing.current) { again.current = true; return; }
    writing.current = true;
    try {
      const res = await fetch(`/api/study/progress/${track}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: latest.current }),
      });
      if (!res.ok) throw new Error(String(res.status));
      if (!again.current && !timer.current) setSync('saved');
    } catch {
      setSync('error');
    } finally {
      writing.current = false;
      if (again.current) { again.current = false; flush(); }
    }
  }, [track]);

  // Flush a pending save when leaving the page.
  useEffect(() => () => {
    if (timer.current) { clearTimeout(timer.current); flush(); }
  }, [flush]);

  const update = useCallback((fn: (prev: T) => T) => {
    if (!loaded.current) return;
    const next = fn(latest.current);
    latest.current = next;
    setState(next);
    setSync('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; flush(); }, SAVE_DELAY_MS);
  }, [flush]);

  return { state, update, sync, reload: load };
}
