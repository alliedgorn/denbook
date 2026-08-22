/**
 * Malformed-JSON fail-clean middleware (T#954)
 *
 * A malformed JSON request body returns a clean 400, not a bare 500.
 *
 * Central guard for the ~85 `await c.req.json()` call sites across the route
 * modules: each wraps json() in a handler-local try/catch that returns 500 for
 * ALL throws, so a client-fault malformed body surfaces as a misleading
 * server-fault 500 (with an empty audit detail). T#879 fixed one such site
 * (POST /api/thread) with a per-handler guard; this middleware fixes the whole
 * class centrally.
 *
 * Design (see T#954 thread):
 * - Validates the body via a raw CLONE (`c.req.raw.clone().text()` + JSON.parse),
 *   exactly as the audit middleware clones for its own read. The clone does NOT consume the stream the handler
 *   reads, so this is ORDER-INDEPENDENT — it does not matter whether it runs
 *   before or after the audit middleware (which also clones c.req.raw), and the
 *   handler's own `c.req.json()` still reads the original body fresh.
 *   (The alternative — calling `c.req.json()` here to populate Hono's text
 *   cache — would consume the stream and break the audit middleware's clone if
 *   ordered before it: a fragile hidden ordering constraint we deliberately
 *   avoid.)
 * - Zero handler changes; covers every current + future site by construction —
 *   structural, cannot regress the way 85 hand-copied per-handler guards would.
 * - Gated to requests that actually declare a non-empty JSON payload, so
 *   multipart form uploads (`c.req.parseBody()`) and body-less requests pass
 *   straight through untouched.
 */

import type { Context, Next } from 'hono';

const BODY_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

export function jsonFailClean() {
  return async (c: Context, next: Next) => {
    const method = c.req.method;
    if (!BODY_METHODS.includes(method)) return next();

    const contentType = (c.req.header('content-type') || '').toLowerCase();
    if (!contentType.includes('application/json')) return next();

    // Read the body TEXT off a raw clone. The clone leaves the original stream
    // intact for the handler, and reading text (rather than gating on a
    // content-length header, which is not reliably set on chunked/fetch
    // requests) is what actually decides whether there is a body to validate.
    let raw: string;
    try {
      raw = await c.req.raw.clone().text();
    } catch {
      // Body unreadable here (e.g. already consumed upstream) — do not block;
      // let the handler proceed and surface its own error.
      return next();
    }

    // Empty body → nothing to parse; let the handler decide (it may tolerate an
    // empty body, or 400 on its own). We only fail-clean an actual malformed payload.
    if (raw.trim() === '') return next();

    try {
      JSON.parse(raw);
    } catch (e) {
      // `detail` echoes the caller's own broken bytes back to the same caller —
      // no third-party disclosure (same rationale as T#879).
      return c.json({ error: 'Malformed JSON body', detail: (e as Error).message }, 400);
    }

    return next();
  };
}
