/**
 * Shared HTTP client for Oracle CLI
 *
 * All HTTP-based commands use this to talk to the Oracle server.
 * Auto-starts the server if not running.
 */

import { ensureServerRunning } from '../ensure-server.ts';
import { PORT } from '../config.ts';

const BASE_URL = `http://localhost:${PORT}`;

export interface FetchOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | undefined>;
}

export async function oracleFetch<T = any>(path: string, options?: FetchOptions): Promise<T> {
  const ok = await ensureServerRunning({ timeout: 15000 });
  if (!ok) {
    throw new Error('Failed to start Oracle server. Run "oracle server status" for details.');
  }

  const url = new URL(path, BASE_URL);
  if (options?.query) {
    for (const [k, v] of Object.entries(options.query)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, v);
    }
  }

  const fetchOpts: RequestInit = { method: options?.method || 'GET' };
  if (options?.body) {
    fetchOpts.headers = { 'Content-Type': 'application/json' };
    fetchOpts.body = JSON.stringify(options.body);
  }

  const res = await fetch(url.toString(), fetchOpts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}
