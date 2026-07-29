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
 * Truncate a doorbell preview for delivery through the notification path.
 *
 * T#893. Replaces two byte-identical private `sanitizeForTmux` copies that
 * lived in forum/mentions.ts and dm/handler.ts.
 *
 * WHY IT LOOKS LIKE THIS — three things were measured, not assumed:
 *
 * 1. `String.slice` counts UTF-16 CODE UNITS, so it can cut between the halves
 *    of a surrogate pair and emit a lone surrogate that is not well-formed
 *    UTF-8. Every Den post opens with one signature emoji (2 units, 1
 *    codepoint), which is why the old cap read as "199" — 200 units minus one
 *    astral extra. That number was never a constant: pure ASCII cut at 200, two
 *    leading emoji at 198. Iterating with [...text] yields codepoints and
 *    cannot split a pair.
 *
 * 2. The old quote and backslash substitutions bought NOTHING and cost real
 *    bugs. The transport is base64 end to end (notify.sh encodes, the drain
 *    decodes) and terminates at `tmux send-keys -l "$MSG"` — a quoted argv
 *    element with the literal flag — while enqueueNotification spawns via argv,
 *    never a shell. Quotes, backslashes, `$` and backticks were verified to
 *    survive untouched to the pane by three seats independently. Meanwhile
 *    `\\` -> `\\\\` DOUBLED length before the cut, so backslash-dense text ate
 *    its own preview budget, and the cut could sever an escape pair and leave a
 *    trailing lone backslash. Dropping them fixes both and unbreaks the
 *    scheduler byte-compare rails whose curl payloads contain quotes.
 *
 * 3. Newline -> space is KEPT and is deliberately unchanged. It is not carried
 *    here as an injection defence: the claim that a literal LF submits a line
 *    at `send-keys -l` was proposed, independently "confirmed" by two seats,
 *    and then refuted — the rigs were `cat`, which has no submit semantics in
 *    either tty mode, and ~14 real scheduler doorbells carrying an embedded LF
 *    each arrived as one whole prompt. The mechanism remains UNMEASURED against
 *    a live Ink pane. This keeps existing display behaviour and claims nothing.
 *
 * The marker matters: the old cut was silent, so a stub validated as a complete
 * message and a reader had no way to know they were deciding off a fragment.
 */
export function truncateForTmux(text: string, maxLen: number = 200): string {
  const flat = text.replace(/\r\n|\r|\n/g, ' ');
  const cps = [...flat];
  return cps.length <= maxLen ? flat : cps.slice(0, maxLen).join('') + '…';
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
  try {
    const sessionName = beastLower.charAt(0).toUpperCase() + beastLower.slice(1);
    const stamp = formatUtc7Timestamp(opts?.sentAt ?? new Date());
    const stamped = `${stamp} [from ${sender}] ${message}`;
    Bun.spawnSync(['tmux', 'send-keys', '-t', sessionName, '-l', stamped]);
    // T#714 (follow-up to T#713 scope-miss): sleep 200ms between text-paste and
    // Enter to break the Claude Code Ink-TUI race. Same fix as runDrainCycle.
    Bun.sleepSync(200);
    Bun.spawnSync(['tmux', 'send-keys', '-t', sessionName, 'Enter']);
    return true;
  } catch {
    return false;
  }
}
