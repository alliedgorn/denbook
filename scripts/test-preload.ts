/**
 * Bun test preload — runs before any test module imports.
 *
 * Forces ORACLE_DB_PATH and ORACLE_DATA_DIR to safe in-memory / /tmp values
 * so `bun test <anything>` (script-wrapped OR direct path invocation) cannot
 * touch the production SQLite at ~/.oracle/oracle.db.
 *
 * Wired via bunfig.toml `[test] preload`. Runs once per `bun test` invocation,
 * before src/db/index.ts is imported anywhere. Per-Bun-process scope: every
 * test file in the run sees the same in-memory DB.
 *
 * Background: 2026-04-28 incidents (Karo wiped beast_tokens twice via
 * `bun test src/server/__tests__/beast-tokens.test.ts`). Bear directive:
 * make the test DB a code-level baseline, not a script-level convention.
 *
 * Override path: if a developer explicitly wants to test against a real DB
 * file (e.g. for migration testing), set ORACLE_DB_PATH BEFORE invoking
 * `bun test` — the preload only sets defaults if unset, never overrides.
 */

if (!process.env.ORACLE_DB_PATH) {
  process.env.ORACLE_DB_PATH = ':memory:';
}
if (!process.env.ORACLE_DATA_DIR) {
  process.env.ORACLE_DATA_DIR = '/tmp/oracle-test-data';
}

// Defensive guard: refuse to proceed if ORACLE_DB_PATH points at a real
// production-shaped path. Catches the case where a developer exports
// ORACLE_DB_PATH=~/.oracle/oracle.db in their shell and forgets to unset.
const dbPath = process.env.ORACLE_DB_PATH;
if (
  dbPath !== ':memory:' &&
  !dbPath.startsWith('/tmp/') &&
  !dbPath.startsWith('/var/folders/') && // macOS temp
  !dbPath.includes('/test')
) {
  // eslint-disable-next-line no-console
  console.error(
    `[test-preload] REFUSING to run tests against non-test DB path: ${dbPath}\n` +
    `  Set ORACLE_DB_PATH=:memory: (default) OR a /tmp/* path to proceed.\n` +
    `  See WORKFLOW.md §"Test discipline".`
  );
  process.exit(1);
}

// ============================================================================
// T#981: tests must not reach real seats, real panes, or Gorn.
// 2026-11-16 14:31 a unit test drove the visibility handler on an in-memory DB
// and its "New public thread" fan-out paged every live seat through each
// seat's notify.sh and tmux (#20 31944). The DB guard above made the DB safe;
// nothing made the side effects safe. Two layers (Bertus, Gnarl on T#981):
//   1. The SINK is the fix: notify.ts delivers into an in-process array.
//   2. The TRIPWIRE is the guard: any spawn that names tmux / send-keys /
//      notify.sh, and any fetch to a non-loopback host, is blocked AND
//      recorded. A global afterAll fails the run if anything was recorded,
//      because many call sites catch errors (notify.ts, the pack terminal
//      routes), so a throw alone could be swallowed and pass green.
// ============================================================================
import { afterAll, mock } from 'bun:test';
import * as realChildProcess from 'node:child_process';

// --- Telegram: refuse loud if this shell is armed (Boro, Sable, Rax on #20).
// Every seat's brain .env holds TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID, and the
// standard bearer step `set -a && . .env` exports them into the shell.
const TG_KEYS = ['TELEGRAM_BOTS', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
const armedTg = TG_KEYS.filter(k => process.env[k]);
if (armedTg.length > 0) {
  // eslint-disable-next-line no-console
  console.error(
    `[test-preload] REFUSING to run: ${armedTg.join(', ')} set in this shell (names only).\n` +
    `  A test could message Gorn. Run from a shell that has not sourced a .env, or:\n` +
    `  env -u TELEGRAM_BOTS -u TELEGRAM_BOT_TOKEN -u TELEGRAM_CHAT_ID bun test ...`
  );
  process.exit(1);
}

// --- Notify sink: on by default, and nothing else is accepted.
if (!process.env.DEN_NOTIFY_SINK) process.env.DEN_NOTIFY_SINK = 'memory';
if (process.env.NODE_ENV !== 'test') {
  // eslint-disable-next-line no-console
  console.error(`[test-preload] REFUSING to run: NODE_ENV is '${process.env.NODE_ENV}', expected 'test'. The notify sink is gated on it.`);
  process.exit(1);
}
if (process.env.DEN_NOTIFY_SINK !== 'memory') {
  // eslint-disable-next-line no-console
  console.error(`[test-preload] REFUSING to run: DEN_NOTIFY_SINK must be 'memory' under bun test (got '${process.env.DEN_NOTIFY_SINK}').`);
  process.exit(1);
}

// --- Drain dir: the server drain (daemons/routes.ts) reads DEN_NOTIFY_DIR, so
// in-process code AND any child server inherit a private, empty queue dir
// instead of the real /tmp/den-notify (Gnarl's (b), PR 156).
import { mkdtempSync, rmSync } from 'node:fs';
if (!process.env.DEN_NOTIFY_DIR) process.env.DEN_NOTIFY_DIR = mkdtempSync('/tmp/den-notify-test-');
if (!process.env.DEN_NOTIFY_DIR.startsWith('/tmp/den-notify-test-')) {
  // eslint-disable-next-line no-console
  console.error(`[test-preload] REFUSING to run: DEN_NOTIFY_DIR must be a /tmp/den-notify-test-* dir under bun test.`);
  process.exit(1);
}

// --- Port: tests never talk to the prod server (Bertus, PR 156). On
// 2026-11-16 14:39-14:41, four full-suite review runs sent 1001 unauthenticated
// writes to the live server on 47778 through the local bypass (schedules,
// teams, thread PATCHes). Tests and any child server get a test port instead,
// and the fetch tripwire below refuses 47778 outright.
const PROD_PORT = '47778';
if (!process.env.ORACLE_PORT) process.env.ORACLE_PORT = '47779';
if (process.env.ORACLE_PORT === PROD_PORT) {
  // eslint-disable-next-line no-console
  console.error(`[test-preload] REFUSING to run: ORACLE_PORT is the prod port ${PROD_PORT}.`);
  process.exit(1);
}
process.env.DEN_TEST_BASE_URL = `http://localhost:${process.env.ORACLE_PORT}`;

// --- Tripwire.
export type TripHit = { via: string; what: string };
const tripHits: TripHit[] = [];
(globalThis as any).__denTripwire = { hits: tripHits };
// den-notify: the server drain (daemons/routes.ts runDrainCycle) pops a line
// off a REAL /tmp/den-notify queue with sed and then delivers. Under the sink,
// the delivery "succeeds" into the array and the real seat's line is lost
// without a trace, so the pop itself must be blocked (Gnarl, PR 156).
const DANGER = /\btmux\b|send-keys|notify\.sh|den-notify/;
function trip(via: string, what: string): never {
  tripHits.push({ via, what: what.slice(0, 200) });
  throw new Error(`[test tripwire] ${via} blocked: ${what.slice(0, 120)}`);
}
function cmdText(cmd: unknown, rest?: unknown): string {
  const head = Array.isArray(cmd) ? cmd.join(' ')
    : (cmd && typeof cmd === 'object' && Array.isArray((cmd as any).cmd)) ? (cmd as any).cmd.join(' ')
    : String(cmd ?? '');
  return Array.isArray(rest) ? `${head} ${rest.join(' ')}` : head;
}

// Bun.spawn / Bun.spawnSync: writable, and callers read them at call time.
const realBunSpawn = Bun.spawn;
const realBunSpawnSync = Bun.spawnSync;
(Bun as any).spawn = (cmd: any, opts?: any) => {
  const t = cmdText(cmd); if (DANGER.test(t)) trip('Bun.spawn', t);
  return (realBunSpawn as any)(cmd, opts);
};
(Bun as any).spawnSync = (cmd: any, opts?: any) => {
  const t = cmdText(cmd); if (DANGER.test(t)) trip('Bun.spawnSync', t);
  return (realBunSpawnSync as any)(cmd, opts);
};

// node:child_process: about 50 call sites, including tmux new-session and
// unlink-window in remote/routes.ts. Reassigning properties does not reach
// named imports; mock.module does, and the originals must be snapshotted
// first or the wrapper recurses into itself (Gnarl, probed on bun 1.3.10).
const cpSnap: Record<string, any> = { ...realChildProcess };
const guarded = (name: string) => (...args: any[]) => {
  const t = cmdText(args[0], args[1]); if (DANGER.test(t)) trip(`child_process.${name}`, t);
  return cpSnap[name](...args);
};
const cpWrapped: Record<string, any> = { ...cpSnap };
for (const n of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync']) cpWrapped[n] = guarded(n);
cpWrapped.default = cpWrapped;
mock.module('node:child_process', () => cpWrapped);
mock.module('child_process', () => cpWrapped);

// fetch: loopback only. Telegram is network egress, which neither the sink
// nor a spawn guard covers (Boro).
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const realFetch = globalThis.fetch;
const guardedFetch = ((input: any, init?: any) => {
  let host = '', port = '';
  try {
    const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    host = u.hostname; port = u.port || (u.protocol === 'https:' ? '443' : '80');
  } catch { /* relative: loopback */ }
  if (host && !LOOPBACK.has(host)) {
    tripHits.push({ via: 'fetch', what: host });
    return Promise.reject(new Error(`[test tripwire] fetch blocked: non-loopback host ${host}`));
  }
  if (host && port === PROD_PORT) {
    tripHits.push({ via: 'fetch', what: `${host}:${port}` });
    return Promise.reject(new Error(`[test tripwire] fetch blocked: the prod server port ${PROD_PORT}`));
  }
  return realFetch(input, init);
}) as typeof fetch;
Object.assign(guardedFetch, realFetch);
globalThis.fetch = guardedFetch;

// Fail the run if anything tripped and nobody consumed it. Tests that trip on
// purpose (the negative controls) assert on the hits and then clear them.
afterAll(() => {
  const dir = process.env.DEN_NOTIFY_DIR;
  if (dir && dir.startsWith('/tmp/den-notify-test-')) rmSync(dir, { recursive: true, force: true });
  if (tripHits.length > 0) {
    const list = tripHits.map(h => `${h.via}: ${h.what}`).join('\n  ');
    throw new Error(`[test tripwire] ${tripHits.length} blocked side effect(s) in this run:\n  ${list}`);
  }
});
