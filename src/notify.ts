/**
 * Centralized tmux notification adaptor (Spec #54 v4 — was Spec #29).
 *
 * Server-side thin adaptor: invokes the TARGET Beast's own notify.sh
 * (`/home/gorn/workspace/<beast>/scripts/notify.sh`) instead of a
 * server-owned shell script. Per Spec #54 v4 sovereignty pattern,
 * notify.sh is Beast-owned (lives in Beast brain worktree, ported via
 * Beast Blueprint v0.6.3). Both ends of the notification stack now
 * Beast-sovereign — server is coordinator, not bottleneck.
 *
 * Timestamp stamping moved INTO notify.sh (per spec) — all callers get
 * consistent `[YYYY-MM-DD HH:MM:SS UTC+7] [from <sender>] <message>`
 * format regardless of entry point.
 *
 * Sender attribution via `opts.from` (default 'server'). Honor-system
 * v4 — cryptographic auth is sister-spec follow-up.
 *
 * Drain side: per-Beast `notify-drain.sh` reads `/tmp/den-notify/<beast>.queue`
 * and pastes to tmux session via `tmux send-keys -l` + 200ms race-pause + Enter.
 */

import path from 'path';
import type { Database } from 'bun:sqlite';

const WORKSPACE_ROOT = '/home/gorn/workspace';

/**
 * Beast-name validation: alphanumeric lowercase only. Anti-traversal at
 * the adaptor boundary (defense-in-depth — notify.sh also self-validates
 * via `readlink -f $0` derivation, but adaptor validates before path.join).
 */
const BEAST_NAME_RE = /^[a-z]+$/;

export interface EnqueueOpts {
  /** Sender attribution. Defaults to 'server'. Honor-system v4. */
  from?: string;
  /**
   * Event time. Currently unused — timestamp is stamped by notify.sh on
   * enqueue (Spec #54 v4 design). If a caller cares about sent-time vs
   * enqueue-time (e.g., delayed TG polling), they should incorporate the
   * sent-time into the message body itself. Reserved for future.
   */
  sentAt?: Date;
}

/**
 * Format a UTC+7 timestamp for the fallback path. notify.sh handles its
 * own stamping in the happy path; this is only used when we fall back to
 * direct tmux send-keys (e.g., notify.sh fails or beast worktree missing).
 */
function formatUtc7Timestamp(date: Date): string {
  const utc7 = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const y = utc7.getUTCFullYear();
  const mo = String(utc7.getUTCMonth() + 1).padStart(2, '0');
  const d = String(utc7.getUTCDate()).padStart(2, '0');
  const h = String(utc7.getUTCHours()).padStart(2, '0');
  const mi = String(utc7.getUTCMinutes()).padStart(2, '0');
  const s = String(utc7.getUTCSeconds()).padStart(2, '0');
  return `[${y}-${mo}-${d} ${h}:${mi}:${s} UTC+7]`;
}

/**
 * T#973 (Bertus F5): the process a pane must be running before we type into it.
 * A notification is meant for Claude Code's input box. If the Beast's claude
 * has exited and the pane is back at a bash prompt, bash parses the text and
 * runs it as uid gorn: $( ), backticks and > all work, and a guest DM preview
 * reaches it with no # before the body (T#973 comment 3203).
 */
export const DELIVERY_PANE_COMMAND = 'claude';

/**
 * T#981: test-time notification sink. When DEN_NOTIFY_SINK=memory (set by
 * scripts/test-preload.ts for every `bun test`, never in prod), both delivery
 * paths below push here instead of spawning notify.sh or typing into tmux.
 * Before this, a unit test that reached a notifying handler paged every live
 * seat (2026-11-16 14:31, #20 31944). Tests read this array to assert on
 * notifications; the preload tripwire catches anything that bypasses it.
 */
export const notifySink: Array<{ via: 'enqueue' | 'pane'; target: string; text: string }> = [];
// Both are required: `bun test` sets NODE_ENV=test, and a plain server run does
// not. So a stray DEN_NOTIFY_SINK line in a prod .env cannot silently swallow
// every notification (Gnarl, PR 156).
export const notifySinkOn = (): boolean => process.env.DEN_NOTIFY_SINK === 'memory' && process.env.NODE_ENV === 'test';
const sinkOn = notifySinkOn;

/**
 * T#1025 (Gorn, 2026-11-21): a Beast at rest gets no doorbells. Before this,
 * rest_status='rest' only paused the scheduler, so forum, board, DM and pet
 * notifications kept being typed into the pane while the Beast wrote its
 * handoff. Now the drain leaves a resting Beast's queue alone (held, never
 * dropped) and it drains after /wake.
 *
 * The hold is bounded (Gnarl A1). A /rest that dies before sleep.sh relaunches
 * the seat leaves it at rest while it is awake, and without a bound nothing
 * would ever poke it again. Past REST_HOLD_MAX_MS the hold lapses and delivery
 * resumes, which is itself the poke. A stopped seat needs no hold: the drain
 * already re-queues on 'no-session'.
 *
 * Fail-open everywhere: no db, no row, no rest_since (rested before this
 * column existed) or a read error all count as awake. A wrongly held queue is
 * silent; a wrongly delivered doorbell is only noisy.
 */
export const REST_HOLD_MAX_MS = (parseInt(process.env.REST_HOLD_MAX_MIN || '60', 10) || 60) * 60 * 1000;

export type RestHold = 'awake' | 'held' | 'lapsed';

export function restHoldState(db: Pick<Database, 'prepare'> | null, beast: string, now: number = Date.now()): RestHold {
  if (!db) return 'awake';
  try {
    const row = db.prepare('SELECT rest_status, rest_since FROM beast_profiles WHERE name = ?')
      .get(beast.toLowerCase()) as { rest_status?: string | null; rest_since?: number | null } | null;
    if (row?.rest_status !== 'rest') return 'awake';
    if (typeof row.rest_since !== 'number') return 'awake';
    return now - row.rest_since < REST_HOLD_MAX_MS ? 'held' : 'lapsed';
  } catch {
    return 'awake';
  }
}

export function isBeastAtRest(db: Pick<Database, 'prepare'> | null, beast: string, now: number = Date.now()): boolean {
  return restHoldState(db, beast, now) === 'held';
}

// The Tier-2 fallback below has no queue and no db handle of its own. The
// server sets this at startup (initDaemons), so Tier-2 can refuse at rest too.
let restDb: Pick<Database, 'prepare'> | null = null;
export function setRestDb(db: Pick<Database, 'prepare'> | null): void { restDb = db; }

export type PaneDelivery = 'sent' | 'no-session' | 'not-claude';

/**
 * Type `text` into the Beast's tmux pane and press Enter, but only when that
 * pane is running claude. Anything else is refused without sending a key, and
 * the caller re-queues. Fail-closed: if the pane command can't be read, refuse.
 *
 * `-t sessionName` resolves to the session's active pane for both
 * display-message and send-keys, so the check and the send hit the same pane.
 * There is still a window of milliseconds between check and send in which
 * claude could exit; this closes the standing hole, not that race.
 */
export function deliverToPane(sessionName: string, text: string): PaneDelivery {
  if (sinkOn()) { notifySink.push({ via: 'pane', target: sessionName, text }); return 'sent'; }
  const hasSession = Bun.spawnSync(['tmux', 'has-session', '-t', sessionName]);
  if (hasSession.exitCode !== 0) return 'no-session';

  const pane = Bun.spawnSync(['tmux', 'display-message', '-p', '-t', sessionName, '#{pane_current_command}']);
  if (pane.exitCode !== 0 || pane.stdout.toString().trim() !== DELIVERY_PANE_COMMAND) {
    return 'not-claude';
  }

  Bun.spawnSync(['tmux', 'send-keys', '-t', sessionName, '-l', text]);
  // T#714 (follow-up to T#713 scope-miss): sleep 200ms between text-paste and
  // Enter to break the race with Claude Code's Ink TUI renderer. Without it,
  // Enter can land mid-frame and the message sits stuck in the input box.
  Bun.sleepSync(200);
  Bun.spawnSync(['tmux', 'send-keys', '-t', sessionName, 'Enter']);
  return 'sent';
}

/**
 * Enqueue a notification for a Beast by invoking the target Beast's own notify.sh.
 *
 * Per Spec #54 v4 (Phase 2d): this is a thin adaptor. Target script content
 * lives in the Beast's brain worktree, not in this repo. Beasts can also call
 * each other's notify.sh directly — this adaptor is just the server-originated
 * path. Server-down does not break beast-to-beast notification.
 *
 * Falls back to direct tmux send-keys if the spawn fails.
 */
export function enqueueNotification(beast: string, message: string, opts?: EnqueueOpts): boolean {
  const beastLower = beast.toLowerCase();

  // Anti-traversal at adaptor boundary (Bertus DEN-S54-v4-bertus C-NEW-1 sister)
  if (!BEAST_NAME_RE.test(beastLower)) {
    console.error(`[notify] Invalid beast name: ${beast}`);
    return false;
  }

  if (sinkOn()) { notifySink.push({ via: 'enqueue', target: beastLower, text: message }); return true; }

  const targetScript = path.join(WORKSPACE_ROOT, beastLower, 'scripts', 'notify.sh');
  const sender = opts?.from ?? 'server';

  // Tier 1: per-Beast notify.sh (Spec #54 v4 sovereignty path)
  try {
    const result = Bun.spawnSync(['bash', targetScript, message, '--from', sender]);
    if (result.exitCode === 0) return true;
    console.error(`[notify] Per-Beast notify failed for ${beastLower} (exit ${result.exitCode})`);
  } catch (err) {
    console.error(`[notify] Per-Beast notify error for ${beastLower}:`, err);
  }

  // Tier 2: direct tmux send-keys with synthesized stamp. Final fallback.
  // T#973: only into a pane running claude. There is no queue to put the line
  // back on here, so a refusal is reported as a failed notify.
  // T#1025: never type into a resting Beast's pane. There is no queue here to
  // hold the line, so it is reported as a failed notify; the content itself is
  // already in oracle.db and the Beast reads forum and DMs on wake.
  if (isBeastAtRest(restDb, beastLower)) {
    console.error(`[notify] Tier-2 held for ${beastLower}: at rest (T#1025)`);
    return false;
  }
  try {
    const sessionName = beastLower.charAt(0).toUpperCase() + beastLower.slice(1);
    const stamp = formatUtc7Timestamp(opts?.sentAt ?? new Date());
    const stamped = `${stamp} [from ${sender}] ${message}`;
    const outcome = deliverToPane(sessionName, stamped);
    if (outcome !== 'sent') {
      console.error(`[notify] Tier-2 refused for ${beastLower}: ${outcome}`);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
