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
