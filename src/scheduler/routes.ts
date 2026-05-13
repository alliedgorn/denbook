import path from 'path';
import fs from 'fs';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';
import { handleScheduleAdd, handleScheduleList } from '../tools/schedule.ts';
import type { ToolContext } from '../tools/types.ts';
import { schedule } from '../db/index.ts';

// ============================================================================
// Module-level state — captured via initScheduler()
// ============================================================================

let moduleSqlite: Database | null = null;
let dbDrizzle: any = null;
let repoRoot: string = '';
let wsBroadcast: (event: string, data: any) => void = () => {};
let enqueueNotification: (beast: string, notification: any) => void = () => {};

// Scheduler polling interval (pack vote, thread #75)
const SCHEDULER_INTERVAL = 10_000;
let schedulerLastCheck: string | null = null;
let schedulerStarted = false;

// ============================================================================
// Schedule helpers
// ============================================================================

// Parse interval strings like "540m", "8h", "2d" into seconds
function parseInterval(interval: string): number | null {
  const match = interval.match(/^(\d+)(m|h|d)$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  if (value <= 0) return null;
  const unit = match[2];
  if (unit === 'm') return value * 60;
  if (unit === 'h') return value * 3600;
  if (unit === 'd') return value * 86400;
  return null;
}

// Compute next occurrence of schedule_time (HH:MM) in UTC+7
function computeNextFixedTime(scheduleTime: string, intervalDays: number): string {
  const [hours, minutes] = scheduleTime.split(':').map(Number);
  if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error('Invalid schedule_time format (HH:MM)');
  }
  // Work in UTC+7
  const now = new Date();
  const utc7Now = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  // Build target time today in UTC+7
  const target = new Date(utc7Now);
  target.setUTCHours(hours, minutes, 0, 0);
  // If target is in the past, advance by interval
  if (target <= utc7Now) {
    target.setUTCDate(target.getUTCDate() + intervalDays);
  }
  // Convert back to UTC
  return new Date(target.getTime() - 7 * 60 * 60 * 1000).toISOString();
}

// Compute next_due_at after a run for fixed-time schedules
function computeNextFixedTimeAfterRun(scheduleTime: string, intervalDays: number): string {
  const [hours, minutes] = scheduleTime.split(':').map(Number);
  const now = new Date();
  const utc7Now = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  const target = new Date(utc7Now);
  target.setUTCHours(hours, minutes, 0, 0);
  // Always advance to next occurrence
  target.setUTCDate(target.getUTCDate() + intervalDays);
  return new Date(target.getTime() - 7 * 60 * 60 * 1000).toISOString();
}

// T#706: validate days_of_week (ISO weekday array, 1=Mon..7=Sun)
// Returns parsed sorted unique array, or null if invalid
function parseDaysOfWeek(input: unknown): number[] | null {
  if (!Array.isArray(input)) return null;
  if (input.length === 0 || input.length > 7) return null;
  const set = new Set<number>();
  for (const d of input) {
    if (!Number.isInteger(d)) return null;
    if (d < 1 || d > 7) return null;
    set.add(d);
  }
  return Array.from(set).sort((a, b) => a - b);
}

// T#706: weekday-anchored next-due computation (UTC+7 / Asia/Bangkok)
// Finds the next occurrence of any weekday in `daysOfWeek` at `scheduleTime`,
// strictly AFTER `nowUtc` (use for /run advance). Set `inclusiveToday=true` for
// create-time anchoring (allows today if the time is still future).
function computeNextWeekdayFixedTime(
  scheduleTime: string,
  daysOfWeek: number[],
  inclusiveToday: boolean,
): string {
  const [hours, minutes] = scheduleTime.split(':').map(Number);
  if (isNaN(hours) || isNaN(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error('Invalid schedule_time format (HH:MM)');
  }
  if (!daysOfWeek.length) {
    throw new Error('days_of_week must be non-empty');
  }
  // Work in UTC+7 (Asia/Bangkok, no DST).
  const now = new Date();
  const utc7Now = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  // Walk forward day by day. Bangkok-day weekday: Sun=0..Sat=6 from getUTCDay() of utc7-shifted Date.
  // Convert to ISO 1=Mon..7=Sun.
  const toIso = (jsDay: number) => (jsDay === 0 ? 7 : jsDay);
  // Search up to 8 days forward (covers any 7-day cycle starting today)
  for (let offset = 0; offset < 8; offset++) {
    const candidate = new Date(utc7Now);
    candidate.setUTCDate(candidate.getUTCDate() + offset);
    candidate.setUTCHours(hours, minutes, 0, 0);
    const isoWeekday = toIso(candidate.getUTCDay());
    if (!daysOfWeek.includes(isoWeekday)) continue;
    if (offset === 0) {
      // Today candidate — inclusive only on create-time, and only if still future
      if (!inclusiveToday) continue;
      if (candidate <= utc7Now) continue;
    }
    return new Date(candidate.getTime() - 7 * 60 * 60 * 1000).toISOString();
  }
  // Defensive: should never reach (any non-empty subset of 7 weekdays fires within 7d).
  throw new Error('Failed to compute next weekday-anchored due time');
}



// ============================================================================
// Auto-trigger daemon
// ============================================================================

// ============================================================================
// Scheduler Auto-Trigger Daemon (10s polling)
// ============================================================================


function runSchedulerCycle() {
  if (!moduleSqlite) return;
  const sqlite: Database = moduleSqlite; // narrow null for daemon body
  try {
    const now = new Date().toISOString();
    schedulerLastCheck = now;

    // Find overdue schedules that need triggering:
    // - enabled and overdue (next_due_at <= now)
    // - NULL: never triggered before
    // - 'pending': beast called /run, next_due advanced — re-trigger when next_due passes
    // - 'failed': previous attempt failed — retry after schedule's own interval cooldown
    // - 'triggered': already notified, waiting for beast — do NOT re-trigger (beast will /run when ready)
    // - 'completed': one-time schedule finished — never re-trigger
    // T#658 — Norm #65 — skip beasts at rest (rest_status = 'rest')
    const overdue = sqlite.prepare(
      `SELECT * FROM beast_schedules
       WHERE enabled = 1 AND datetime(next_due_at) <= datetime(?)
       AND trigger_status IS NOT 'completed'
       AND trigger_status IS NOT 'triggered'
       AND beast NOT IN (SELECT name FROM beast_profiles WHERE rest_status = 'rest')
       AND (
         trigger_status IS NULL
         OR trigger_status = 'pending'
         OR (trigger_status = 'failed' AND datetime(last_triggered_at) <= datetime(?, '-' || CAST(interval_seconds AS TEXT) || ' seconds'))
       )
       ORDER BY next_due_at`
    ).all(now, now) as any[];

    for (const schedule of overdue) {
      const sessionName = schedule.beast.charAt(0).toUpperCase() + schedule.beast.slice(1);

      // Check if Beast tmux session exists
      const hasSession = Bun.spawnSync(['tmux', 'has-session', '-t', sessionName]);
      if (hasSession.exitCode !== 0) {
        console.log(`[Scheduler] Skip ${schedule.beast}/${schedule.task}: tmux session '${sessionName}' not found`);
        continue;
      }

      // Send notification via queue
      const notification = `[Scheduler] Due now: ${schedule.task} (schedule ${schedule.id})${schedule.command ? ` | Command: ${schedule.command}` : ''}\nRemember: mark done with /scheduler run ${schedule.id}`;

      try {
        enqueueNotification(schedule.beast, notification);

        // Mark as triggered
        sqlite.prepare(
          `UPDATE beast_schedules SET last_triggered_at = ?, trigger_status = 'triggered', updated_at = datetime('now') WHERE id = ?`
        ).run(now, schedule.id);

        wsBroadcast('schedule_update', { action: 'triggered', id: schedule.id });
        console.log(`[Scheduler] Triggered: ${schedule.beast}/${schedule.task} (#${schedule.id})`);
      } catch (err) {
        console.log(`[Scheduler] Failed to notify ${schedule.beast}: ${err}`);
      }
    }
    // Prowl due-task notifications (T#467 + T#471 + T#473) — notify Sable when tasks are due or reminder fires
    // Also re-notify daily for overdue tasks (T#473)
    // Note: Prowl due_date is stored in local time (from datetime-local picker), so compare with local time
    const d = new Date();
    const localNow = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`;
    const dueProwl = sqlite.prepare(
      `SELECT * FROM prowl_tasks WHERE due_date IS NOT NULL AND status = 'pending'
       AND (
         (notified_at IS NULL AND (
           (remind_before IS NULL AND datetime(due_date) <= datetime(?))
           OR (remind_before = '1m' AND datetime(due_date, '-1 minutes') <= datetime(?))
           OR (remind_before = '5m' AND datetime(due_date, '-5 minutes') <= datetime(?))
           OR (remind_before = '15m' AND datetime(due_date, '-15 minutes') <= datetime(?))
           OR (remind_before = '30m' AND datetime(due_date, '-30 minutes') <= datetime(?))
           OR (remind_before = '1h' AND datetime(due_date, '-1 hours') <= datetime(?))
           OR (remind_before = '1d' AND datetime(due_date, '-1 days') <= datetime(?))
         ))
         OR (notified_at IS NOT NULL AND datetime(due_date) < datetime(?) AND datetime(notified_at) <= datetime(?, '-1 days'))
       )`
    ).all(localNow, localNow, localNow, localNow, localNow, localNow, localNow, localNow, localNow) as any[];

    for (const task of dueProwl) {
      const sessionName = 'Sable';
      const hasSession = Bun.spawnSync(['tmux', 'has-session', '-t', sessionName]);
      if (hasSession.exitCode !== 0) {
        console.log(`[Prowl] Skip notification for task #${task.id}: tmux session 'Sable' not found`);
        continue;
      }

      const priorityEmoji = task.priority === 'high' ? '🔴' : task.priority === 'medium' ? '🟡' : '🟢';
      const reminderLabels: Record<string, string> = { '1m': '1 min', '5m': '5 min', '15m': '15 min', '30m': '30 min', '1h': '1 hour', '1d': '1 day' };
      const isReminder = task.remind_before && !task.notified_at && new Date(task.due_date) > new Date(now);
      const isOverdueRenotify = task.notified_at && new Date(task.due_date) < new Date(now);
      const prefix = isOverdueRenotify ? 'OVERDUE (daily reminder)' : isReminder ? `Reminder (${reminderLabels[task.remind_before] || task.remind_before} before)` : 'Task due';
      const notification = `[Prowl] ${prefix}: ${task.title} (Prowl ${priorityEmoji}${task.id}) — Priority: ${task.priority} — send Telegram to Gorn`;

      try {
        enqueueNotification('sable', notification);

        sqlite.prepare(`UPDATE prowl_tasks SET notified_at = ? WHERE id = ?`).run(localNow, task.id);
        console.log(`[Prowl] Notified Sable: task #${task.id} "${task.title}" is due`);
      } catch (err) {
        console.log(`[Prowl] Failed to notify for task #${task.id}: ${err}`);
      }
    }
  } catch (err) {
    console.error(`[Scheduler] Cycle error: ${err}`);
  }
}

// Startup reset + daemon start happen inside initScheduler() — see below.


// ============================================================================
// initScheduler — server startup entry
// ============================================================================

export function initScheduler(
  sqliteDb: Database,
  drizzleDb: any,
  repoRootPath: string,
  deps: {
    wsBroadcast: (event: string, data: any) => void;
    enqueueNotification: (beast: string, notification: any) => void;
  }
): void {
  moduleSqlite = sqliteDb;
  dbDrizzle = drizzleDb;
  repoRoot = repoRootPath;
  wsBroadcast = deps.wsBroadcast;
  enqueueNotification = deps.enqueueNotification;

  if (schedulerStarted) return;
  schedulerStarted = true;

  // Startup reset: reset all 'triggered' schedules to 'pending' so they fire exactly once
  // Prevents the repeat-fire bug (T#383) where old triggered status + expired cooldown
  // causes schedules to fire multiple times on restart.
  try {
    const resetCount = sqliteDb.prepare(
      `UPDATE beast_schedules SET trigger_status = 'pending', updated_at = datetime('now')
       WHERE trigger_status = 'triggered' AND enabled = 1`
    ).run();
    if (resetCount.changes > 0) {
      console.log(`[Scheduler] Reset ${resetCount.changes} triggered schedules to pending on startup`);
    }
  } catch (err) {
    console.error(`[Scheduler] Startup reset error: ${err}`);
  }

  setInterval(runSchedulerCycle, SCHEDULER_INTERVAL);
  setTimeout(runSchedulerCycle, 5000);
  console.log('[Scheduler] Auto-trigger daemon started (10s interval)');
}

// ============================================================================
// Routes
// ============================================================================

interface SchedulerHelpers {
  hasSessionAuth: (c: Context) => boolean;
  requireBeastIdentity: (c: Context) => string | null;
}

export function registerSchedulerRoutes(app: OpenAPIHono, sqliteDb: Database, helpers: SchedulerHelpers): void {
  const { hasSessionAuth, requireBeastIdentity } = helpers;
  const db = dbDrizzle;
  const REPO_ROOT = repoRoot;
  // Shadow module-level `sqlite` (Database | null) with a non-null local
  // so the plural-block handlers (verbatim from server.ts) keep using bare `sqlite.prepare(...)`.
  const sqlite: Database = sqliteDb;

  // ============================================================================
  // Singular /api/schedule API (drizzle ORM via handleScheduleList/Add)
  // ============================================================================

  // Serve raw schedule.md for frontend rendering
  app.get('/api/schedule/md', (c) => {
    const schedulePath = path.join(process.env.HOME || '/tmp', '.oracle', 'ψ/inbox/schedule.md');
    if (fs.existsSync(schedulePath)) {
      return c.text(fs.readFileSync(schedulePath, 'utf-8'));
    }
    return c.text('', 404);
  });

  app.get('/api/schedule', async (c) => {
    const ctx = { db, sqlite: sqliteDb, repoRoot: REPO_ROOT } as Pick<ToolContext, 'db' | 'sqlite' | 'repoRoot'>;
    const result = await handleScheduleList(ctx as ToolContext, {
      date: c.req.query('date'),
      from: c.req.query('from'),
      to: c.req.query('to'),
      filter: c.req.query('filter'),
      status: c.req.query('status') as 'pending' | 'done' | 'cancelled' | 'all' | undefined,
      limit: c.req.query('limit') ? parseInt(c.req.query('limit')!) : undefined,
    });
    const text = result.content[0]?.text || '{}';
    return c.json(JSON.parse(text));
  });

  app.post('/api/schedule', async (c) => {
    const body = await c.req.json();
    const ctx = { db, sqlite: sqliteDb, repoRoot: REPO_ROOT } as Pick<ToolContext, 'db' | 'sqlite' | 'repoRoot'>;
    const result = await handleScheduleAdd(ctx as ToolContext, body);
    const text = result.content[0]?.text || '{}';
    return c.json(JSON.parse(text));
  });

  app.patch('/api/schedule/:id', async (c) => {
    const id = parseInt(c.req.param('id'));
    const body = await c.req.json();
    const now = Date.now();
    db.update(schedule)
      .set({ ...body, updatedAt: now })
      .where(eq(schedule.id, id))
      .run();
    return c.json({ success: true, id });
  });

  // ============================================================================
  // Plural /api/schedules API (sqlite + auto-trigger system)
  // ============================================================================

  app.get('/api/schedules', (c) => {
    const beast = c.req.query('beast');
    const type = c.req.query('type');
    let query = 'SELECT * FROM beast_schedules';
    const conditions: string[] = [];
    const params: any[] = [];
    if (beast) { conditions.push('beast = ?'); params.push(beast); }
    if (type === 'once') { conditions.push('once = 1'); }
    else if (type === 'recurring') { conditions.push('(once = 0 OR once IS NULL)'); }
    if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
    query += ' ORDER BY beast, next_due_at';
    const rows = sqlite.prepare(query).all(...params) as any[];
    return c.json({ schedules: rows, total: rows.length });
  });

  // GET /api/schedules/due — overdue items for a beast
  app.get('/api/schedules/due', (c) => {
    const beast = c.req.query('beast');
    if (!beast) return c.json({ error: 'beast parameter required' }, 400);
    const now = new Date().toISOString();
    const rows = sqlite.prepare(
      'SELECT * FROM beast_schedules WHERE beast = ? AND enabled = 1 AND next_due_at <= ? ORDER BY next_due_at'
    ).all(beast, now) as any[];
    return c.json({ schedules: rows, total: rows.length });
  });

  // GET /api/schedules/:id — get a single schedule
  app.get('/api/schedules/:id', (c) => {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid schedule ID' }, 400);
    const row = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id);
    if (!row) return c.json({ error: 'Schedule not found' }, 404);
    return c.json(row);
  });

  // POST /api/schedules — create a schedule
  app.post('/api/schedules', async (c) => {
    const data = await c.req.json();
    const { beast, task, command, source } = data;
    const isOnce = !!data.once;

    // For one-off: interval is optional, run_at is required
    // For recurring: interval is required
    if (!beast || !task) {
      return c.json({ error: 'beast and task are required' }, 400);
    }
    if (!isOnce && !data.interval) {
      return c.json({ error: 'beast, task, and interval are required (or set once: true with run_at)' }, 400);
    }
    // Validate task name — only safe characters (alphanumeric, spaces, basic punctuation)
    if (typeof task !== 'string' || task.length > 100 || /[`$\\{}<>|;&]/.test(task)) {
      return c.json({ error: 'Task name contains invalid characters or is too long (max 100 chars, no shell metacharacters)' }, 400);
    }
    // Validate beast name
    if (typeof beast !== 'string' || !/^[a-z][a-z0-9_-]{0,29}$/.test(beast)) {
      return c.json({ error: 'Invalid beast name' }, 400);
    }

    let interval = data.interval || 'once';
    let intervalSeconds = 0;

    if (isOnce) {
      // One-off schedule: run_at required (ISO 8601), interval optional
      if (!data.run_at) {
        return c.json({ error: 'run_at (ISO 8601) is required for one-off schedules' }, 400);
      }
      const runAt = new Date(data.run_at);
      if (isNaN(runAt.getTime())) {
        return c.json({ error: 'run_at must be a valid ISO 8601 datetime' }, 400);
      }
      // schedule_time not compatible with once
      if (data.schedule_time) {
        return c.json({ error: 'schedule_time cannot be used with one-off schedules (use run_at instead)' }, 400);
      }
      interval = 'once';
      intervalSeconds = 0;
    } else {
      // Recurring schedule: validate interval
      const parsed = parseInterval(interval);
      if (!parsed) {
        return c.json({ error: 'Invalid interval. Use format: Nm (minutes), Nh (hours), or Nd (days). Examples: 540m, 8h, 2d' }, 400);
      }
      intervalSeconds = parsed;
    }

    // Prevent duplicate: same beast + same task name + enabled
    const duplicate = sqlite.prepare(
      'SELECT id FROM beast_schedules WHERE beast = ? AND task = ? AND enabled = 1'
    ).get(beast, task) as any;
    if (duplicate) {
      return c.json({ error: `Schedule '${task}' already exists for ${beast} (id: ${duplicate.id}). Disable or delete it first.` }, 409);
    }
    // Fixed-time scheduling (recurring only)
    const scheduleTime = data.schedule_time || null;
    const tz = data.timezone || 'Asia/Bangkok';
    const VALID_TIMEZONES = ['Asia/Bangkok', 'UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo', 'Asia/Singapore'];
    if (scheduleTime) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(scheduleTime)) {
        return c.json({ error: 'schedule_time must be HH:MM format (00:00-23:59)' }, 400);
      }
      if (data.interval !== '1d' && data.interval !== '7d') {
        return c.json({ error: 'schedule_time requires interval of 1d (daily) or 7d (weekly)' }, 400);
      }
    }
    if (data.timezone && !VALID_TIMEZONES.includes(data.timezone)) {
      return c.json({ error: `Invalid timezone. Valid: ${VALID_TIMEZONES.join(', ')}` }, 400);
    }

    // T#706: weekday-anchored recurring (days_of_week). ISO 1=Mon..7=Sun.
    let daysOfWeek: number[] | null = null;
    if (data.days_of_week !== undefined && data.days_of_week !== null) {
      if (isOnce) {
        return c.json({ error: 'days_of_week cannot be used with one-off schedules' }, 400);
      }
      if (data.interval !== '7d') {
        return c.json({ error: "days_of_week requires interval='7d' (weekly cadence with explicit days)" }, 400);
      }
      if (!scheduleTime) {
        return c.json({ error: 'days_of_week requires schedule_time (HH:MM)' }, 400);
      }
      const parsed = parseDaysOfWeek(data.days_of_week);
      if (!parsed) {
        return c.json({ error: 'days_of_week must be a non-empty array of ISO weekday integers (1=Mon..7=Sun), max length 7' }, 400);
      }
      daysOfWeek = parsed;
    }

    let nextDue: string;
    const runAt = data.run_at || null;
    if (isOnce) {
      nextDue = new Date(data.run_at).toISOString();
    } else if (daysOfWeek) {
      nextDue = computeNextWeekdayFixedTime(scheduleTime!, daysOfWeek, true);
    } else if (scheduleTime) {
      const intervalDays = interval === '7d' ? 7 : 1;
      nextDue = computeNextFixedTime(scheduleTime, intervalDays);
    } else {
      const now = new Date();
      nextDue = new Date(now.getTime() + intervalSeconds * 1000).toISOString();
    }

    const result = sqlite.prepare(
      `INSERT INTO beast_schedules (beast, task, command, interval, interval_seconds, next_due_at, schedule_time, timezone, source, once, run_at, days_of_week)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(beast, task, command || null, interval, intervalSeconds, nextDue, scheduleTime, tz, source || null, isOnce ? 1 : 0, runAt, daysOfWeek ? JSON.stringify(daysOfWeek) : null);
    const created = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(result.lastInsertRowid) as any;
    wsBroadcast('schedule_update', { action: 'created', id: (created as any).id });
    return c.json(created, 201);
  });

  // PATCH /api/schedules/:id — update a schedule (owner or Gorn only)
  app.patch('/api/schedules/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
    const existing = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
    if (!existing) return c.json({ error: 'Schedule not found' }, 404);
    const data = await c.req.json();
    const requester = (c.req.query('as') || data.as || data.beast || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
    if (!requester) {
      return c.json({ error: 'Identity required: pass ?as=beast or beast in body' }, 400);
    }
    if (requester !== existing.beast && requester !== 'gorn') {
      return c.json({ error: `Only ${existing.beast} or Gorn can modify this schedule` }, 403);
    }
    const updates: string[] = [];
    const params: any[] = [];
    if (data.task !== undefined) { updates.push('task = ?'); params.push(data.task); }
    if (data.command !== undefined) { updates.push('command = ?'); params.push(data.command); }
    if (data.interval !== undefined) {
      const secs = parseInterval(data.interval);
      if (!secs) return c.json({ error: 'Invalid interval. Use format: Nm (minutes), Nh (hours), or Nd (days). Examples: 540m, 8h, 2d' }, 400);
      updates.push('interval = ?', 'interval_seconds = ?');
      params.push(data.interval, secs);
    }
    if (data.enabled !== undefined) { updates.push('enabled = ?'); params.push(data.enabled ? 1 : 0); }
    if (data.source !== undefined) { updates.push('source = ?'); params.push(data.source); }
    if (data.schedule_time !== undefined) {
      if (data.schedule_time !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(data.schedule_time)) {
        return c.json({ error: 'schedule_time must be HH:MM format (00:00-23:59) or null to clear' }, 400);
      }
      const effectiveInterval = data.interval || existing.interval;
      if (data.schedule_time !== null && effectiveInterval !== '1d' && effectiveInterval !== '7d') {
        return c.json({ error: 'schedule_time requires interval of 1d (daily) or 7d (weekly)' }, 400);
      }
      if (existing.once && data.schedule_time !== null) {
        return c.json({ error: 'schedule_time cannot be used with one-off schedules' }, 400);
      }
      updates.push('schedule_time = ?'); params.push(data.schedule_time);
      // Recompute next_due_at if setting a new schedule_time
      if (data.schedule_time !== null) {
        const intervalDays = (data.interval || existing.interval) === '7d' ? 7 : 1;
        const nextDue = computeNextFixedTime(data.schedule_time, intervalDays);
        updates.push('next_due_at = ?'); params.push(nextDue);
      }
    }
    if (data.timezone !== undefined) {
      const VALID_TIMEZONES = ['Asia/Bangkok', 'UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo', 'Asia/Singapore'];
      if (!VALID_TIMEZONES.includes(data.timezone)) {
        return c.json({ error: `Invalid timezone. Valid: ${VALID_TIMEZONES.join(', ')}` }, 400);
      }
      updates.push('timezone = ?'); params.push(data.timezone);
    }
    // T#706: days_of_week update path
    if (data.days_of_week !== undefined) {
      if (data.days_of_week === null) {
        updates.push('days_of_week = ?'); params.push(null);
      } else {
        if (existing.once) {
          return c.json({ error: 'days_of_week cannot be used with one-off schedules' }, 400);
        }
        const effectiveInterval = data.interval || existing.interval;
        const effectiveScheduleTime = data.schedule_time !== undefined ? data.schedule_time : existing.schedule_time;
        if (effectiveInterval !== '7d') {
          return c.json({ error: "days_of_week requires interval='7d'" }, 400);
        }
        if (!effectiveScheduleTime) {
          return c.json({ error: 'days_of_week requires schedule_time (HH:MM)' }, 400);
        }
        const parsed = parseDaysOfWeek(data.days_of_week);
        if (!parsed) {
          return c.json({ error: 'days_of_week must be a non-empty array of ISO weekday integers (1=Mon..7=Sun), max length 7' }, 400);
        }
        updates.push('days_of_week = ?'); params.push(JSON.stringify(parsed));
        // Recompute next_due_at to honor the new weekday set immediately
        const newNext = computeNextWeekdayFixedTime(effectiveScheduleTime, parsed, true);
        updates.push('next_due_at = ?'); params.push(newNext);
      }
    }
    if (updates.length === 0) return c.json({ error: 'No fields to update' }, 400);
    updates.push("updated_at = datetime('now')");
    params.push(id);
    sqlite.prepare(`UPDATE beast_schedules SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    const updated = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
    wsBroadcast('schedule_update', { action: 'updated', id: (updated as any).id });
    return c.json(updated);
  });

  // PATCH /api/schedules/:id/run — mark a schedule as run (owner or Gorn only)
  app.patch('/api/schedules/:id/run', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
    const existing = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
    if (!existing) return c.json({ error: 'Schedule not found' }, 404);
    const data = await c.req.json().catch(() => ({}));
    // T#718 — derive requester from auth, reject client-asserted mismatch
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    const claimedAs = (c.req.query('as') || data.as || data.beast || '').toLowerCase();
    if (claimedAs && claimedAs !== caller) {
      return c.json({ error: 'Identity spoof blocked. ?as=/body.as/body.beast must match authenticated caller or be omitted.' }, 403);
    }
    const requester = caller;
    if (requester !== existing.beast && requester !== 'gorn') {
      return c.json({ error: `Only ${existing.beast} or Gorn can run this schedule` }, 403);
    }
    // If task failed, don't update last_run (Pip's edge case)
    if (data.failed) {
      sqlite.prepare(`UPDATE beast_schedules SET trigger_status = 'failed', updated_at = datetime('now') WHERE id = ?`).run(id);
      const failedState = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
      return c.json({ ...failedState, message: 'Failed run — not updating last_run_at' });
    }
    const now = new Date();

    // One-off schedules: disable after run instead of advancing
    if (existing.once === 1) {
      sqlite.prepare(
        `UPDATE beast_schedules SET last_run_at = ?, enabled = 0, trigger_status = 'completed', last_triggered_at = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(now.toISOString(), now.toISOString(), id);
      const updated = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
      wsBroadcast('schedule_update', { action: 'run', id: (updated as any).id });
      return c.json(updated);
    }

    let nextDue: string;
    // T#706: weekday-anchored takes precedence over plain weekly fixed-time
    if (existing.days_of_week && existing.schedule_time) {
      let parsedDays: number[] | null = null;
      try {
        const arr = JSON.parse(existing.days_of_week);
        parsedDays = parseDaysOfWeek(arr);
      } catch { /* invalid stored value, fall through */ }
      if (parsedDays) {
        // After-run advance: never include "today" — must move to a strictly-future qualifying weekday
        nextDue = computeNextWeekdayFixedTime(existing.schedule_time, parsedDays, false);
      } else {
        // Stored value corrupt; safely fall back to plain weekly cadence
        nextDue = computeNextFixedTimeAfterRun(existing.schedule_time, 7);
      }
    } else if (existing.schedule_time) {
      const intervalDays = existing.interval === '7d' ? 7 : 1;
      nextDue = computeNextFixedTimeAfterRun(existing.schedule_time, intervalDays);
    } else {
      nextDue = new Date(now.getTime() + existing.interval_seconds * 1000).toISOString();
    }
    sqlite.prepare(
      `UPDATE beast_schedules SET last_run_at = ?, next_due_at = ?, trigger_status = 'pending', last_triggered_at = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(now.toISOString(), nextDue, now.toISOString(), id);
    const updated = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
    wsBroadcast('schedule_update', { action: 'run', id: (updated as any).id });
    return c.json(updated);
  });

  // DELETE /api/schedules/:id — remove a schedule (owner or Gorn only)
  app.delete('/api/schedules/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
    const existing = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
    if (!existing) return c.json({ error: 'Schedule not found' }, 404);
    // Parse body for identity (DELETE can have body)
    const body = await c.req.json().catch(() => ({}));
    const requester = (c.req.query('as') || body.as || body.beast || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
    if (!requester) {
      return c.json({ error: 'Identity required: pass ?as=beast or beast in body' }, 400);
    }
    if (requester !== existing.beast && requester !== 'gorn') {
      return c.json({ error: `Only ${existing.beast} or Gorn can delete this schedule` }, 403);
    }
    sqlite.prepare('DELETE FROM beast_schedules WHERE id = ?').run(id);
    wsBroadcast('schedule_update', { action: 'deleted', id });
    return c.json({ deleted: true, id });
  });

  // POST /api/schedules/:id/execute — manually trigger a schedule (sends tmux notification to Beast)
  app.post('/api/schedules/:id/execute', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
    const schedule = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
    if (!schedule) return c.json({ error: 'Schedule not found' }, 404);

    const sessionName = schedule.beast.charAt(0).toUpperCase() + schedule.beast.slice(1);

    // Check if Beast tmux session exists
    const hasSession = Bun.spawnSync(['tmux', 'has-session', '-t', sessionName]);
    if (hasSession.exitCode !== 0) {
      return c.json({ error: `tmux session '${sessionName}' not found — Beast may be offline` }, 503);
    }

    // Send notification to Beast via queue
    const notification = `[Scheduler] Due now: ${schedule.task} (schedule ${schedule.id})${schedule.command ? ` | Command: ${schedule.command}` : ''}\nRemember: mark done with /scheduler run ${schedule.id}`;

    try {
      enqueueNotification(schedule.beast, notification);

      const now = new Date().toISOString();
      sqlite.prepare(
        `UPDATE beast_schedules SET last_triggered_at = ?, trigger_status = 'triggered', updated_at = datetime('now') WHERE id = ?`
      ).run(now, id);

      wsBroadcast('schedule_update', { action: 'triggered', id });
      return c.json({ success: true, message: `Triggered ${schedule.beast}/${schedule.task}` });
    } catch (err) {
      return c.json({ error: `Failed to send to ${sessionName}: ${err}` }, 500);
    }
  });

  // PATCH /api/schedules/:id/trigger — mark as triggered (owner, Gorn, or server daemon only)
  app.patch('/api/schedules/:id/trigger', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
    const existing = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
    if (!existing) return c.json({ error: 'Schedule not found' }, 404);
    const data = await c.req.json().catch(() => ({}));
    const requester = (c.req.query('as') || data.as || data.beast || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
    if (!requester) {
      return c.json({ error: 'Identity required: pass ?as=beast or beast in body' }, 400);
    }
    if (requester !== existing.beast && requester !== 'gorn' && requester !== 'scheduler') {
      return c.json({ error: `Only ${existing.beast} or Gorn can trigger this schedule` }, 403);
    }
    const now = new Date().toISOString();
    sqlite.prepare(
      `UPDATE beast_schedules SET last_triggered_at = ?, trigger_status = 'triggered', updated_at = datetime('now') WHERE id = ?`
    ).run(now, id);
    const updated = sqlite.prepare('SELECT * FROM beast_schedules WHERE id = ?').get(id) as any;
    wsBroadcast('schedule_update', { action: 'triggered', id: (updated as any).id });
    return c.json(updated);
  });


  // ============================================================================
  // /api/scheduler/health
  // ============================================================================

  // GET /api/scheduler/health — daemon status
  app.get('/api/scheduler/health', (c) => {
    return c.json({ status: 'running', interval_seconds: SCHEDULER_INTERVAL / 1000, last_check: schedulerLastCheck });
  });

}
