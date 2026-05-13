import fs from 'fs';
import path from 'path';
import { timingSafeEqual } from 'crypto';
import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';
import { ORACLE_DATA_DIR } from '../config.ts';

// Minimal magic-byte image detector (moved from server.ts duplicate)
function detectImageType(buffer: Buffer): { ext: string; mime: string } | null {
  if (buffer.length < 12) return null;
  // JPEG
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  // PNG
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return { ext: 'png', mime: 'image/png' };
  // GIF
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return { ext: 'gif', mime: 'image/gif' };
  // WebP
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
      buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return { ext: 'webp', mime: 'image/webp' };
  // HEIC
  if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70 &&
      buffer[8] === 0x68 && buffer[9] === 0x65 && buffer[10] === 0x69 && buffer[11] === 0x63) return { ext: 'heic', mime: 'image/heic' };
  return null;
}

// ============================================================================
// Forge — Personal Routine Tracker for Gorn (T#372)
// Phase 1.12 of Library #102 — mechanical extraction, no logic changes.
// ============================================================================

interface ForgeHelpers {
  hasSessionAuth: (c: Context) => boolean;
  isTrustedRequest: (c: Context) => boolean;
  wsBroadcast: (event: string, data: any) => void;
}

// Note: isForgeAuthorized + FORGE_BEAST_MODES kept inside the verbatim register-body
// (used by all forge routes via closure). Cross-domain consumers (e.g. integrations
// for /api/withings/devices auth gate) receive isForgeAuthorized via server.ts's
// surviving copy passed through the helpers DI. T#788 cleanup may dedupe.

export function registerForgeRoutes(app: OpenAPIHono, sqliteDb: Database, helpers: ForgeHelpers): void {
  const { hasSessionAuth, isTrustedRequest, wsBroadcast } = helpers;
  const sqlite: Database = sqliteDb;

  // ============================================================================
  // Forge — Personal Routine Tracker for Gorn (T#372)
  // ============================================================================

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS routine_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      logged_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      data JSON NOT NULL,
      source TEXT DEFAULT 'manual',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      deleted_at DATETIME DEFAULT NULL
    )
  `);

  // Exercise library table (T#410 — Forge redesign backend)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS exercises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      muscle_group TEXT,
      equipment TEXT,
      created_by TEXT DEFAULT 'import',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(name, equipment)
    )
  `);

  // Personal records table — materialized on write (T#410)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS personal_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exercise_name TEXT NOT NULL,
      weight REAL NOT NULL,
      reps INTEGER NOT NULL,
      unit TEXT DEFAULT 'kg',
      achieved_at DATETIME NOT NULL,
      log_id INTEGER REFERENCES routine_logs(id),
      UNIQUE(exercise_name, weight, reps, unit)
    )
  `);

  // Remove CHECK constraint on existing table (allows 'bodyfat' type)
  try {
    sqlite.exec(`
      CREATE TABLE routine_logs_new AS SELECT * FROM routine_logs;
      DROP TABLE routine_logs;
      CREATE TABLE routine_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        logged_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        data JSON NOT NULL,
        source TEXT DEFAULT 'manual',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        deleted_at DATETIME DEFAULT NULL
      );
      INSERT INTO routine_logs SELECT * FROM routine_logs_new;
      DROP TABLE routine_logs_new;
    `);
  } catch { /* already migrated or no constraint to remove */ }

  // T#496: Normalize logged_at to UTC — fix entries stored without Z suffix
  try {
    const fixed = sqlite.prepare("UPDATE routine_logs SET logged_at = logged_at || 'Z' WHERE logged_at NOT LIKE '%Z' AND logged_at NOT LIKE '%+%' AND deleted_at IS NULL").run();
    if ((fixed as any).changes > 0) console.log(`[Forge] Normalized ${(fixed as any).changes} logged_at entries to UTC`);
  } catch { /* table may not exist yet */ }

  // Ensure uploads/routine dir exists
  const ROUTINE_UPLOADS = path.join(ORACLE_DATA_DIR, 'uploads', 'routine');
  if (!fs.existsSync(ROUTINE_UPLOADS)) fs.mkdirSync(ROUTINE_UPLOADS, { recursive: true });

  // Forge beast → mode map. 'write' implies 'read'. Owner session always full write.
  // Library #96 lever 1: scope-for-post-compromise-damage — grant the minimum mode each lane needs.
  const FORGE_BEAST_MODES: Record<string, 'read' | 'write'> = {
    gorn: 'write',   // owner
    sable: 'write',  // gatekeeper — logs meals for bear
    karo: 'write',   // partner — bedrock 04-09 grant
    boro: 'read',    // coach — periodization + progression reads only; writes route through Sable
  };

  // Auth helper: Gorn (session) + allowlisted beasts per FORGE_BEAST_MODES.
  // mode='read' permits any allowlisted beast; mode='write' requires write-mode beast.
  //
  // T#718-aligned: prefers bearer-token-derived actor (set by auth middleware) over
  // the legacy ?as= query param shape. Bearer-token-actor path is checked first;
  // ?as= path retained for backwards-compat with existing callers (Sable TG flows,
  // legacy scripts) until follow-up T# removes it post-migration audit.
  function isForgeAuthorized(c: any, options: { mode: 'read' | 'write' } = { mode: 'write' }): boolean {
    if (hasSessionAuth(c)) return true; // Gorn browser session — owner, full write

    // T#718 path: read requester from authenticated bearer-token actor (no ?as= needed)
    const actor = ((c.get as any)('actor') as string | undefined)?.toLowerCase();
    if (actor) {
      const beastMode = FORGE_BEAST_MODES[actor];
      if (!beastMode) return false;
      if (options.mode === 'read') return true; // either mode satisfies read
      return beastMode === 'write';              // write requires write
    }

    // Backwards-compat: ?as= query param + isTrustedRequest local-network bypass.
    // Retained so existing callers (Sable scripts, legacy curl flows) don't break
    // pre-migration. Follow-up T# removes after callers migrate to bearer-only.
    if (isTrustedRequest(c)) {
      const as = (c.req.query('as') || '').toLowerCase();
      const beastMode = FORGE_BEAST_MODES[as];
      if (!beastMode) return false;
      if (options.mode === 'read') return true;
      return beastMode === 'write';
    }
    return false;
  }

  // T#712 Telegram-cache read auth — DELIBERATELY SEPARATE from FORGE_BEAST_MODES per
  // isTelegramAuthorized + TELEGRAM_READ_MODES moved to src/telegram/routes.ts (T#770)

  // GET /api/routine/logs — list logs
  app.get('/api/routine/logs', (c) => {
    if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
    const type = c.req.query('type');
    const from = c.req.query('from');
    const to = c.req.query('to');
    const limit = Math.min(200, parseInt(c.req.query('limit') || '50', 10));
    const offset = parseInt(c.req.query('offset') || '0', 10);

    let query = 'SELECT * FROM routine_logs WHERE deleted_at IS NULL';
    const params: any[] = [];
    if (type) { query += ' AND type = ?'; params.push(type); }
    if (from) { query += ' AND logged_at >= ?'; params.push(from); }
    if (to) { query += ' AND logged_at <= ?'; params.push(to); }
    query += ' ORDER BY logged_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const logs = sqlite.prepare(query).all(...params);
    const total = (sqlite.prepare('SELECT COUNT(*) as c FROM routine_logs WHERE deleted_at IS NULL').get() as any).c;
    return c.json({ logs, total });
  });

  // GET /api/routine/today — today's logs grouped by type
  app.get('/api/routine/today', (c) => {
    if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
    const today = new Date().toISOString().slice(0, 10);
    const logs = sqlite.prepare(
      "SELECT * FROM routine_logs WHERE deleted_at IS NULL AND date(logged_at) = ? ORDER BY logged_at DESC"
    ).all(today);
    return c.json({ logs, date: today });
  });

  // GET /api/routine/weight — weight history for chart (with time-based grouping)
  app.get('/api/routine/weight', (c) => {
    if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
    const range = c.req.query('range'); // week, month, year, 3y, 10y, all
    let dateFilter = '';
    if (range) {
      const now = new Date();
      const rangeMap: Record<string, number> = {
        week: 7, month: 30, year: 365, '3y': 365 * 3, '10y': 365 * 10,
      };
      const days = rangeMap[range];
      if (days) {
        const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
        dateFilter = ` AND logged_at >= '${from}'`;
      }
    }

    // Grouping strategy per range (Dex/Quill spec, thread #323)
    // week/month/3m: daily points, 6m/year: weekly avg, 3y/10y/all: monthly avg
    const grouping = (['3y', '10y', 'all'].includes(range || ''))
      ? 'monthly'
      : (['year'].includes(range || '') ? 'weekly' : 'daily');

    if (grouping === 'daily') {
      const rows = sqlite.prepare(
        `SELECT id, logged_at, json_extract(data, '$.value') as value, json_extract(data, '$.unit') as unit
         FROM routine_logs WHERE type = 'weight' AND deleted_at IS NULL${dateFilter} ORDER BY logged_at ASC`
      ).all();
      return c.json({ weights: rows, grouping: 'daily' });
    }

    // Grouped query — return avg, min, max per period
    const groupExpr = grouping === 'weekly'
      ? "strftime('%Y-W%W', logged_at)"
      : "strftime('%Y-%m', logged_at)";

    const rows = sqlite.prepare(
      `SELECT ${groupExpr} as period,
              ROUND(AVG(json_extract(data, '$.value')), 1) as value,
              ROUND(MIN(json_extract(data, '$.value')), 1) as min_value,
              ROUND(MAX(json_extract(data, '$.value')), 1) as max_value,
              COUNT(*) as count,
              MIN(logged_at) as logged_at,
              'kg' as unit
       FROM routine_logs
       WHERE type = 'weight' AND deleted_at IS NULL${dateFilter}
       GROUP BY ${groupExpr}
       ORDER BY period ASC`
    ).all();
    return c.json({ weights: rows, grouping });
  });

  // GET /api/routine/blood-pressure — BP history for chart (Prowl #80)
  // Mirrors /api/routine/weight: range filter + time-based grouping
  app.get('/api/routine/blood-pressure', (c) => {
    if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
    const range = c.req.query('range');
    let dateFilter = '';
    if (range) {
      const now = new Date();
      const rangeMap: Record<string, number> = {
        week: 7, month: 30, year: 365, '3y': 365 * 3, '10y': 365 * 10,
      };
      const days = rangeMap[range];
      if (days) {
        const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
        dateFilter = ` AND logged_at >= '${from}'`;
      }
    }

    const grouping = (['3y', '10y', 'all'].includes(range || ''))
      ? 'monthly'
      : (['year'].includes(range || '') ? 'weekly' : 'daily');

    if (grouping === 'daily') {
      const rows = sqlite.prepare(
        `SELECT id, logged_at,
                json_extract(data, '$.systolic') as systolic,
                json_extract(data, '$.diastolic') as diastolic
         FROM routine_logs WHERE type = 'blood_pressure' AND deleted_at IS NULL${dateFilter} ORDER BY logged_at ASC`
      ).all();
      return c.json({ readings: rows, grouping: 'daily' });
    }

    const groupExpr = grouping === 'weekly'
      ? "strftime('%Y-W%W', logged_at)"
      : "strftime('%Y-%m', logged_at)";

    const rows = sqlite.prepare(
      `SELECT ${groupExpr} as period,
              ROUND(AVG(json_extract(data, '$.systolic')), 0) as systolic,
              ROUND(AVG(json_extract(data, '$.diastolic')), 0) as diastolic,
              ROUND(MIN(json_extract(data, '$.systolic')), 0) as systolic_min,
              ROUND(MAX(json_extract(data, '$.systolic')), 0) as systolic_max,
              ROUND(MIN(json_extract(data, '$.diastolic')), 0) as diastolic_min,
              ROUND(MAX(json_extract(data, '$.diastolic')), 0) as diastolic_max,
              COUNT(*) as count,
              MIN(logged_at) as logged_at
       FROM routine_logs
       WHERE type = 'blood_pressure' AND deleted_at IS NULL${dateFilter}
       GROUP BY ${groupExpr}
       ORDER BY period ASC`
    ).all();
    return c.json({ readings: rows, grouping });
  });

  // GET /api/routine/exercise-summary?exercise=<name>
  // One-call 4-dimension read (peak, recent, trend, frequency) for a single exercise.
  // Prowl #83 — Boro coach-lane infra-harden on third read-failure recurrence
  // (Bar Shrug 04-22 / Shoulder Press 04-23 / Bench Press 04-24). Replaces
  // 20-page pull-and-filter workflow with a single structured summary.
  app.get('/api/routine/exercise-summary', (c) => {
    if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
    const exercise = c.req.query('exercise');
    if (!exercise) return c.json({ error: 'exercise query param required' }, 400);
    const needle = exercise.toLowerCase().trim();
    if (!needle) return c.json({ error: 'exercise query param must be non-empty after trim' }, 400);

    const rows = sqlite.prepare(
      `SELECT id, logged_at, data FROM routine_logs
       WHERE type = 'workout' AND deleted_at IS NULL
       ORDER BY logged_at DESC`
    ).all() as any[];

    interface MatchedSession {
      date: string;
      session_title: string;
      sets: Array<{ weight: number; reps: number; unit: string }>;
    }
    const matching: MatchedSession[] = [];

    for (const row of rows) {
      let data: any;
      try { data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data; } catch { continue; }
      const exercises: any[] = data.exercises || [];
      for (const ex of exercises) {
        const rawName = typeof ex === 'string' ? ex : (ex.name || '');
        const { name, equipment } = parseExerciseName(rawName);
        const fullName = (equipment ? `${name} · ${equipment}` : name).trim();
        if (!fullName) continue;
        // Fuzzy match: exact, substring on full, substring on name-only
        const fullLower = fullName.toLowerCase();
        const nameLower = name.toLowerCase();
        if (fullLower === needle || fullLower.includes(needle) || nameLower.includes(needle)) {
          const sets: Array<{ weight: number; reps: number; unit: string }> = [];
          if (Array.isArray(ex.sets)) {
            for (const s of ex.sets) {
              if (typeof s.weight === 'number' && typeof s.reps === 'number') {
                sets.push({ weight: s.weight, reps: s.reps, unit: s.unit || 'kg' });
              }
            }
          }
          if (sets.length > 0) {
            matching.push({
              date: row.logged_at,
              session_title: data.workout_name || 'Workout',
              sets,
            });
          }
        }
      }
    }

    // Helper: convert weight to kg regardless of unit
    const toKg = (weight: number, unit: string): number => {
      return (unit || 'kg').toLowerCase().startsWith('lb') ? weight * 0.4536 : weight;
    };

    if (matching.length === 0) {
      return c.json({
        exercise,
        peak: null,
        recent: [],
        trend: 'cold',
        frequency: { total_sessions: 0, last_session_date: null, sessions_last_30d: 0, sessions_last_90d: 0 },
        note: 'No matching sessions found. Try broader search term or check spelling.',
      });
    }

    // Peak: max weight (kg) across all sets, tiebreak by reps at that weight
    let peak = { weight_kg: 0, reps: 0, date: '', session_title: '' };
    for (const m of matching) {
      for (const s of m.sets) {
        const wKg = Math.round(toKg(s.weight, s.unit) * 10) / 10;
        if (wKg > peak.weight_kg || (wKg === peak.weight_kg && s.reps > peak.reps)) {
          peak = {
            weight_kg: wKg,
            reps: s.reps,
            date: m.date.slice(0, 10),
            session_title: m.session_title,
          };
        }
      }
    }

    // Recent: last 5 sessions (already sorted DESC)
    const recent = matching.slice(0, 5).map(m => ({
      date: m.date.slice(0, 10),
      session_title: m.session_title,
      sets: m.sets,
    }));

    // Frequency
    const now = Date.now();
    const d30 = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    const d90 = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString();
    const sessions_last_30d = matching.filter(m => m.date >= d30).length;
    const sessions_last_90d = matching.filter(m => m.date >= d90).length;

    // Trend: compare last 3 sessions peak-weight to prior 3-6 sessions peak-weight
    let trend: string;
    if (sessions_last_90d === 0) {
      trend = 'cold';
    } else {
      const getPeakWeight = (sessions: MatchedSession[]): number => {
        let max = 0;
        for (const s of sessions) {
          for (const set of s.sets) {
            const w = toKg(set.weight, set.unit);
            if (w > max) max = w;
          }
        }
        return max;
      };
      const recentPeak = getPeakWeight(matching.slice(0, 3));
      const priorPeak = getPeakWeight(matching.slice(3, 9));
      if (priorPeak === 0) {
        trend = matching.length >= 3 ? 'plateau' : 'rising';
      } else {
        const ratio = recentPeak / priorPeak;
        if (ratio > 1.05) trend = 'rising';
        else if (ratio < 0.95) trend = 'dropping';
        else trend = 'plateau';
      }
    }

    return c.json({
      exercise,
      peak,
      recent,
      trend,
      frequency: {
        total_sessions: matching.length,
        last_session_date: matching[0]?.date.slice(0, 10) || null,
        sessions_last_30d,
        sessions_last_90d,
      },
    });
  });

  // GET /api/routine/prs — sibling endpoint per Boro spec (Prowl #83).
  // Alias to /api/routine/personal-records?grouped=true for cleaner call-site naming.
  app.get('/api/routine/prs', (c) => {
    if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
    const range = c.req.query('range');
    let dateFilter = '';
    if (range === 'month') dateFilter = "AND achieved_at >= datetime('now', '-30 days')";
    const records = sqlite.prepare(`
      SELECT pr.* FROM personal_records pr
      INNER JOIN (
        SELECT exercise_name, MAX(weight) as max_weight
        FROM personal_records
        WHERE 1=1 ${dateFilter}
        GROUP BY exercise_name
      ) best ON pr.exercise_name = best.exercise_name AND pr.weight = best.max_weight
      WHERE 1=1 ${dateFilter}
      GROUP BY pr.exercise_name
      ORDER BY pr.weight DESC, pr.reps DESC
    `).all();
    return c.json({ records, total_exercises: records.length });
  });

  // Helper: parse exercise name from Alpha Progression format
  // Input: "1. Lat Pulldowns with Wide Overhand Grip · Machine · 8 reps"
  function parseExerciseName(raw: string): { name: string; equipment: string } {
    const cleaned = raw.replace(/^\d+\.\s*/, '');
    const parts = cleaned.split(' · ');
    return { name: parts[0] || cleaned, equipment: parts[1] || '' };
  }

  // Parse string-format exercises like "Chest Press 190lbs 8/8/6" into sets
  function parseExerciseString(raw: string): { name: string; sets: { weight: number; reps: number; unit: string }[] } {
    // Match: "Exercise Name <weight><unit> <reps>/<reps>/..."
    const match = raw.match(/^(.+?)\s+(\d+(?:\.\d+)?)\s*(kg|lbs?|KG|LBS?)\s+([\d/]+)$/);
    if (!match) return { name: raw, sets: [] };
    const name = match[1].trim();
    const weight = parseFloat(match[2]);
    const unit = match[3].toLowerCase().startsWith('lb') ? 'lbs' : 'kg';
    const repsList = match[4].split('/').map(r => parseInt(r) || 0).filter(r => r > 0);
    return { name, sets: repsList.map(reps => ({ weight, reps, unit })) };
  }

  // GET /api/routine/workout-trends — exercise progress over time (T#397)
  app.get('/api/routine/workout-trends', (c) => {
    if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
    const range = c.req.query('range') || 'year';
    const exercise = c.req.query('exercise'); // optional: filter to specific exercise

    let dateFilter = '';
    const rangeMap: Record<string, number> = {
      week: 7, month: 30, '3m': 90, year: 365, '3y': 365 * 3, '10y': 365 * 10,
    };
    const days = rangeMap[range];
    if (days) {
      const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
      dateFilter = ` AND logged_at >= '${from}'`;
    }

    // Get all workout logs in range
    const rows = sqlite.prepare(
      `SELECT id, logged_at, data FROM routine_logs
       WHERE type = 'workout' AND deleted_at IS NULL${dateFilter}
       ORDER BY logged_at ASC`
    ).all() as any[];

    // Parse exercises from each workout, compute per-exercise stats
    const exerciseData: Map<string, Array<{
      date: string;
      maxWeight: number;
      totalVolume: number;
      totalSets: number;
      totalReps: number;
      unit: string;
    }>> = new Map();

    const exerciseFrequency: Map<string, number> = new Map();

    for (const row of rows) {
      let data: any;
      try { data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data; } catch { continue; }
      const exercises: any[] = data.exercises || [];

      for (const ex of exercises) {
        const rawName = typeof ex === 'string' ? ex : (ex.name || '');
        const { name, equipment } = parseExerciseName(rawName);
        if (!name) continue;
        // Include equipment in the key to split Machine vs Dumbbell etc.
        const displayName = equipment ? `${name} · ${equipment}` : name;

        // Filter by exercise if specified
        if (exercise && displayName.toLowerCase() !== exercise.toLowerCase()) continue;

        exerciseFrequency.set(displayName, (exerciseFrequency.get(displayName) || 0) + 1);

        const sets: any[] = ex.sets || [];
        if (sets.length === 0) continue;

        const unit = sets[0]?.unit || 'KG';
        let maxWeight = 0;
        let totalVolume = 0;
        let totalSets = sets.length;
        let totalReps = 0;

        for (const s of sets) {
          const w = parseFloat(s.weight) || 0;
          const r = parseInt(s.reps) || 0;
          if (w > maxWeight) maxWeight = w;
          totalVolume += w * r;
          totalReps += r;
        }

        if (!exerciseData.has(displayName)) exerciseData.set(displayName, []);
        exerciseData.get(displayName)!.push({
          date: row.logged_at,
          maxWeight,
          totalVolume,
          totalSets,
          totalReps,
          unit,
        });
      }
    }

    // Top 5 by frequency (default selection), but include ALL trend data
    const sortedExercises = [...exerciseFrequency.entries()]
      .sort((a, b) => b[1] - a[1]);
    const topExercises = exercise
      ? [...exerciseData.keys()]
      : sortedExercises.slice(0, 5).map(([name]) => name);

    // Include trend data for ALL exercises so frontend can display any selection
    const trends: Record<string, any[]> = {};
    for (const [name] of exerciseData) {
      trends[name] = exerciseData.get(name) || [];
    }

    return c.json({
      exercises: topExercises,
      trends,
      totalWorkouts: rows.length,
      allExercises: sortedExercises.map(([name, count]) => ({ name, count })),
    });
  });

  // GET /api/routine/body-composition — body comp history from Withings (T#479, Spec #28)
  app.get('/api/routine/body-composition', (c) => {
    if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge access required' }, 403);
    const range = c.req.query('range') || 'month';
    const rangeMap: Record<string, string> = {
      '1w': '-7 days', week: '-7 days', '1m': '-30 days', month: '-30 days',
      '3m': '-90 days', '1y': '-365 days', year: '-365 days',
      '3y': '-1095 days', '10y': '-3650 days', all: '-36500 days',
    };
    const dateOffset = rangeMap[range] || '-30 days';

    const rows = sqlite.prepare(
      `SELECT logged_at, data FROM routine_logs
       WHERE type = 'measurement' AND source = 'withings' AND deleted_at IS NULL
       AND logged_at >= datetime('now', 'localtime', ?)
       ORDER BY logged_at ASC`
    ).all(dateOffset) as any[];

    const measurements = rows.map(r => {
      const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
      return {
        logged_at: r.logged_at,
        weight: d.weight ? Number(d.weight.toFixed(2)) : null,
        body_fat_pct: d.body_fat_pct ? Number(d.body_fat_pct.toFixed(1)) : null,
        fat_mass: d.fat_mass ? Number(d.fat_mass.toFixed(2)) : null,
        fat_free_mass: d.fat_free_mass ? Number(d.fat_free_mass.toFixed(2)) : null,
        muscle_mass: d.muscle_mass ? Number(d.muscle_mass.toFixed(2)) : null,
        bone_mass: d.bone_mass ? Number(d.bone_mass.toFixed(2)) : null,
        hydration: d.hydration ? Number(d.hydration.toFixed(1)) : null,
        visceral_fat: d.visceral_fat ?? null,
      };
    });

    const latest = measurements.length > 0 ? measurements[measurements.length - 1] : null;
    const previous = measurements.length > 1 ? measurements[measurements.length - 2] : null;

    // Compute trends
    const trends: Record<string, { current: number | null; previous: number | null; direction: string }> = {};
    if (latest && previous) {
      for (const key of ['body_fat_pct', 'fat_mass', 'muscle_mass', 'bone_mass', 'hydration', 'visceral_fat'] as const) {
        const curr = (latest as any)[key];
        const prev = (previous as any)[key];
        if (curr != null && prev != null) {
          trends[key] = { current: curr, previous: prev, direction: curr > prev ? 'up' : curr < prev ? 'down' : 'stable' };
        }
      }
    }

    return c.json({ measurements, latest, previous, trends, range, total: measurements.length });
  });

  // GET /api/routine/stats — summary stats
  app.get('/api/routine/stats', (c) => {
    if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
    const totalLogs = (sqlite.prepare('SELECT COUNT(*) as c FROM routine_logs WHERE deleted_at IS NULL').get() as any).c;
    const byType = sqlite.prepare('SELECT type, COUNT(*) as count FROM routine_logs WHERE deleted_at IS NULL GROUP BY type').all();
    const thisWeek = (sqlite.prepare("SELECT COUNT(*) as c FROM routine_logs WHERE deleted_at IS NULL AND type = 'workout' AND logged_at >= datetime('now', '-7 days')").get() as any).c;
    const latestWeight = sqlite.prepare("SELECT json_extract(data, '$.value') as value, logged_at FROM routine_logs WHERE type = 'weight' AND deleted_at IS NULL ORDER BY logged_at DESC LIMIT 1").get() as any;
    return c.json({ total_logs: totalLogs, by_type: byType, workouts_this_week: thisWeek, latest_weight: latestWeight });
  });

  // GET /api/routine/summary — enhanced summary for Stats tab (T#410)
  app.get('/api/routine/summary', (c) => {
    if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
    const range = c.req.query('range') || 'week';
    const rangeMap: Record<string, number> = { week: 7, month: 30, '3m': 90, year: 365 };
    const days = rangeMap[range] || 7;
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const workoutsThisRange = (sqlite.prepare(
      "SELECT COUNT(*) as c FROM routine_logs WHERE deleted_at IS NULL AND type = 'workout' AND logged_at >= ?"
    ).get(from) as any).c;

    // Total volume this range (sum of weight * reps across all sets)
    const workoutRows = sqlite.prepare(
      "SELECT data FROM routine_logs WHERE deleted_at IS NULL AND type = 'workout' AND logged_at >= ?"
    ).all(from) as any[];

    let totalVolume = 0;
    let bestLift = { exercise: '', weight: 0, reps: 0, unit: 'kg' };
    for (const row of workoutRows) {
      try {
        const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
        for (const ex of (data.exercises || [])) {
          if (typeof ex === 'string') {
            const parsed = parseExerciseString(ex);
            for (const s of parsed.sets) {
              totalVolume += s.weight * s.reps;
              if (s.weight > bestLift.weight) {
                bestLift = { exercise: parsed.name, weight: s.weight, reps: s.reps, unit: s.unit };
              }
            }
          } else {
            const { name } = parseExerciseName(ex.name || '');
            for (const s of (ex.sets || [])) {
              const w = parseFloat(s.weight) || 0;
              const r = parseInt(s.reps) || 0;
              totalVolume += w * r;
              if (w > bestLift.weight) {
                bestLift = { exercise: name, weight: w, reps: r, unit: s.unit || 'kg' };
              }
            }
          }
        }
      } catch { /* skip */ }
    }

    const latestWeight = sqlite.prepare(
      "SELECT json_extract(data, '$.value') as value, logged_at FROM routine_logs WHERE type = 'weight' AND deleted_at IS NULL ORDER BY logged_at DESC LIMIT 1"
    ).get() as any;

    const prevWeight = sqlite.prepare(
      "SELECT json_extract(data, '$.value') as value FROM routine_logs WHERE type = 'weight' AND deleted_at IS NULL ORDER BY logged_at DESC LIMIT 1 OFFSET 1"
    ).get() as any;

    const weightTrend = latestWeight && prevWeight ? (latestWeight.value > prevWeight.value ? 'up' : latestWeight.value < prevWeight.value ? 'down' : 'stable') : null;

    return c.json({
      workouts: workoutsThisRange,
      totalVolume: Math.round(totalVolume),
      bestLift: bestLift.weight > 0 ? bestLift : null,
      latestWeight: latestWeight ? { ...latestWeight, trend: weightTrend } : null,
      range,
    });
  });

  // GET /api/routine/exercises — exercise library (T#410)
  app.get('/api/routine/exercises', (c) => {
    if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
    const q = c.req.query('q');
    const muscleGroup = c.req.query('muscle_group');

    let query = 'SELECT * FROM exercises WHERE 1=1';
    const params: any[] = [];
    if (q) { query += ' AND name LIKE ?'; params.push(`%${q}%`); }
    if (muscleGroup) { query += ' AND muscle_group = ?'; params.push(muscleGroup); }
    query += ' ORDER BY name ASC';

    const exercises = sqlite.prepare(query).all(...params);
    return c.json({ exercises });
  });

  // POST /api/routine/exercises — add custom exercise (T#410)
  app.post('/api/routine/exercises', async (c) => {
    if (!isForgeAuthorized(c, { mode: 'write' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
    try {
      const body = await c.req.json();
      const { name, muscle_group, equipment } = body;
      if (!name) return c.json({ error: 'Exercise name is required' }, 400);
      try {
        sqlite.prepare(
          'INSERT INTO exercises (name, muscle_group, equipment, created_by) VALUES (?, ?, ?, ?)'
        ).run(name, muscle_group || null, equipment || null, 'manual');
      } catch (e: any) {
        if (e.message?.includes('UNIQUE')) return c.json({ error: 'Exercise already exists' }, 409);
        throw e;
      }
      const exercise = sqlite.prepare('SELECT * FROM exercises WHERE name = ? AND equipment IS ?').get(name, equipment || null);
      return c.json(exercise, 201);
    } catch { return c.json({ error: 'Invalid request' }, 400); }
  });

  // POST /api/routine/exercises/seed — seed exercise library from existing workout data (T#410)
  app.post('/api/routine/exercises/seed', (c) => {
    if (!isForgeAuthorized(c, { mode: 'write' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);

    const rows = sqlite.prepare(
      "SELECT data FROM routine_logs WHERE type = 'workout' AND deleted_at IS NULL"
    ).all() as any[];

    const seen = new Set<string>();
    let seeded = 0;

    const insert = sqlite.prepare(
      'INSERT OR IGNORE INTO exercises (name, muscle_group, equipment, created_by) VALUES (?, ?, ?, ?)'
    );

    for (const row of rows) {
      try {
        const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
        for (const ex of (data.exercises || [])) {
          const rawName = typeof ex === 'string' ? ex : (ex.name || '');
          const { name, equipment } = parseExerciseName(rawName);
          const key = `${name}|${equipment}`;
          if (!name || seen.has(key)) continue;
          seen.add(key);
          const result = insert.run(name, data.muscle_group || null, equipment || null, 'import');
          if (result.changes > 0) seeded++;
        }
      } catch { /* skip */ }
    }

    return c.json({ seeded, total: seen.size });
  });

  // GET /api/routine/personal-records — personal records list (T#410, T#543)
  app.get('/api/routine/personal-records', (c) => {
    if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
    const exercise = c.req.query('exercise');
    const range = c.req.query('range');
    const grouped = c.req.query('grouped'); // 'true' = best lift per exercise

    if (grouped === 'true') {
      // Best lift per exercise — highest weight, then highest reps at that weight
      let dateFilter = '';
      if (range === 'month') dateFilter = "AND achieved_at >= datetime('now', '-30 days')";
      const records = sqlite.prepare(`
        SELECT pr.* FROM personal_records pr
        INNER JOIN (
          SELECT exercise_name, MAX(weight) as max_weight
          FROM personal_records
          WHERE 1=1 ${dateFilter}
          GROUP BY exercise_name
        ) best ON pr.exercise_name = best.exercise_name AND pr.weight = best.max_weight
        WHERE 1=1 ${dateFilter}
        GROUP BY pr.exercise_name
        ORDER BY pr.weight DESC, pr.reps DESC
      `).all();
      return c.json({ records });
    }

    let query = 'SELECT * FROM personal_records WHERE 1=1';
    const params: any[] = [];
    if (exercise) { query += ' AND exercise_name = ?'; params.push(exercise); }
    if (range === 'month') {
      query += " AND achieved_at >= datetime('now', '-30 days')";
    }
    query += ' ORDER BY weight DESC, reps DESC';

    const records = sqlite.prepare(query).all(...params);
    return c.json({ records });
  });

  // POST /api/routine/personal-records/seed — backfill PRs from all workout logs (T#543)
  app.post('/api/routine/personal-records/seed', (c) => {
    if (!isForgeAuthorized(c, { mode: 'write' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
    const workouts = sqlite.prepare(
      "SELECT id, logged_at, data FROM routine_logs WHERE type = 'workout' AND deleted_at IS NULL"
    ).all() as any[];

    const prInsert = sqlite.prepare(
      'INSERT OR IGNORE INTO personal_records (exercise_name, weight, reps, unit, achieved_at, log_id) VALUES (?, ?, ?, ?, ?, ?)'
    );

    let inserted = 0;
    const insertPR = sqlite.transaction(() => {
      for (const log of workouts) {
        const d = typeof log.data === 'string' ? JSON.parse(log.data) : log.data;
        for (const ex of (d.exercises || [])) {
          if (typeof ex === 'string') {
            // Manual format: "Chest Press 190lbs 8/8/6"
            const parsed = parseExerciseString(ex);
            for (const s of parsed.sets) {
              if (s.weight > 0 && s.reps > 0) {
                const res = prInsert.run(parsed.name, s.weight, s.reps, s.unit, log.logged_at, log.id);
                if ((res as any).changes > 0) inserted++;
              }
            }
          } else {
            // Structured format from Alpha Progression
            const { name } = parseExerciseName(typeof ex === 'string' ? ex : (ex.name || ''));
            if (!name) continue;
            for (const s of (ex.sets || [])) {
              const w = parseFloat(s.weight) || 0;
              const r = parseInt(s.reps) || 0;
              if (w > 0 && r > 0) {
                const unit = (s.unit || 'kg').toLowerCase().startsWith('lb') ? 'lbs' : 'kg';
                const res = prInsert.run(name, w, r, unit, log.logged_at, log.id);
                if ((res as any).changes > 0) inserted++;
              }
            }
          }
        }
      }
    });
    insertPR();

    return c.json({ seeded: inserted, from_workouts: workouts.length });
  });

  // GET /api/routine/photos — photo gallery
  app.get('/api/routine/photos', (c) => {
    if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
    const tag = c.req.query('tag');
    let query = "SELECT * FROM routine_logs WHERE type = 'photo' AND deleted_at IS NULL";
    const params: any[] = [];
    if (tag) { query += " AND json_extract(data, '$.tag') = ?"; params.push(tag); }
    query += ' ORDER BY logged_at DESC';
    const photos = sqlite.prepare(query).all(...params);
    return c.json({ photos });
  });

  // T#710 Bertus P1 fold: extract workout validation so POST + PATCH enforce
  // identically. Also addresses the inconsistency between create-path and
  // edit-path discipline (same shape as T#706 parseDaysOfWeek helper).
  // Mutates workoutData in place to coerce rpe to Number.
  function validateWorkoutData(workoutData: any): { ok: true; data: any } | { ok: false; error: string; hint?: string } {
    if (!workoutData || typeof workoutData !== 'object' || !workoutData.exercises || !Array.isArray(workoutData.exercises)) {
      return {
        ok: false,
        error: 'Workout must include an exercises array.',
        hint: 'Expected format: { exercises: [{ name: "Chest Press", equipment: "Machine", sets: [{ weight: 80, reps: 10, unit: "kg" }] }] }',
      };
    }
    for (let i = 0; i < workoutData.exercises.length; i++) {
      const ex = workoutData.exercises[i];
      if (typeof ex === 'string') {
        return {
          ok: false,
          error: `Exercise ${i + 1} is a string ("${ex.slice(0, 60)}"). Exercises must be objects with name and sets.`,
          hint: 'Expected format: { name: "Chest Press", equipment: "Machine", sets: [{ weight: 80, reps: 10, unit: "kg" }] }',
        };
      }
      if (!ex.name?.trim()) {
        return { ok: false, error: `Exercise ${i + 1}: name is required.`, hint: '{ name: "Bench Press", sets: [{ weight: 80, reps: 10, unit: "kg" }] }' };
      }
      if (!ex.sets || !Array.isArray(ex.sets) || ex.sets.length === 0) {
        return { ok: false, error: `Exercise ${i + 1} ("${ex.name}"): sets array is required with at least one set.`, hint: 'sets: [{ weight: 80, reps: 10, unit: "kg" }]' };
      }
      // T#710: per-exercise notes — optional string
      if (ex.notes != null && typeof ex.notes !== 'string') {
        return { ok: false, error: `Exercise ${i + 1} ("${ex.name}"): notes must be a string if provided.`, hint: 'notes: "felt strong, depth good"' };
      }
      // T#711: hevy_template_id — optional string, cross-link to Hevy exercise library
      if (ex.hevy_template_id != null && typeof ex.hevy_template_id !== 'string') {
        return { ok: false, error: `Exercise ${i + 1} ("${ex.name}"): hevy_template_id must be a string if provided.`, hint: 'hevy_template_id: "D04AC939"' };
      }
      // T#711: superset_id — optional finite number, preserves Hevy superset grouping
      if (ex.superset_id != null) {
        if (typeof ex.superset_id !== 'number' || !Number.isFinite(ex.superset_id)) {
          return { ok: false, error: `Exercise ${i + 1} ("${ex.name}"): superset_id must be a finite number if provided.`, hint: 'superset_id: 0' };
        }
      }
      for (let j = 0; j < ex.sets.length; j++) {
        const s = ex.sets[j];
        if (s.weight == null || s.reps == null) {
          return { ok: false, error: `Exercise ${i + 1} ("${ex.name}"), set ${j + 1}: weight and reps are required.`, hint: '{ weight: 80, reps: 10, unit: "kg" }' };
        }
        // T#710: per-set RPE — optional number 1-10
        if (s.rpe != null) {
          const rpeNum = Number(s.rpe);
          if (isNaN(rpeNum) || rpeNum < 1 || rpeNum > 10) {
            return { ok: false, error: `Exercise ${i + 1} ("${ex.name}"), set ${j + 1}: rpe must be a number between 1 and 10 if provided.`, hint: '{ weight: 80, reps: 10, rpe: 8 }' };
          }
          s.rpe = rpeNum;
        }
        // T#711: per-set type — optional enum (normal|warmup|dropset|failure)
        if (s.type != null) {
          if (typeof s.type !== 'string') {
            return { ok: false, error: `Exercise ${i + 1} ("${ex.name}"), set ${j + 1}: type must be a string if provided.`, hint: 'type: "warmup" | "normal" | "dropset" | "failure"' };
          }
          const t = s.type.toLowerCase();
          if (t !== 'normal' && t !== 'warmup' && t !== 'dropset' && t !== 'failure') {
            return { ok: false, error: `Exercise ${i + 1} ("${ex.name}"), set ${j + 1}: type must be one of normal, warmup, dropset, failure.`, hint: 'type: "warmup"' };
          }
          s.type = t;
        }
      }
    }
    return { ok: true, data: workoutData };
  }

  // POST /api/routine/logs — create log entry
  app.post('/api/routine/logs', async (c) => {
    if (!isForgeAuthorized(c, { mode: 'write' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
    try {
      const data = await c.req.json();
      const { type, logged_at } = data;
      if (!type || !data.data) return c.json({ error: 'type and data required' }, 400);
      if (!['meal', 'workout', 'weight', 'note', 'photo'].includes(type)) {
        return c.json({ error: 'type must be meal, workout, weight, note, or photo' }, 400);
      }
      // Meal macro validation — calories, protein, carbs, fat required (T#423, T#430)
      if (type === 'meal') {
        const mealData = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
        if (mealData.items && Array.isArray(mealData.items)) {
          // T#430: itemized meal — validate each item, auto-sum totals
          if (mealData.items.length === 0) return c.json({ error: 'At least 1 meal item required' }, 400);
          const macroFields = ['calories', 'protein', 'carbs', 'fat'] as const;
          for (let i = 0; i < mealData.items.length; i++) {
            const item = mealData.items[i];
            if (!item.name?.trim()) return c.json({ error: `Item ${i + 1}: name required` }, 400);
            const missing = macroFields.filter(f => item[f] == null || item[f] === '');
            if (missing.length > 0) return c.json({ error: `Item ${i + 1} (${item.name}): macros required: ${missing.join(', ')}` }, 400);
            for (const f of macroFields) {
              const v = Number(item[f]);
              if (isNaN(v) || v < 0) return c.json({ error: `Item ${i + 1} (${item.name}): ${f} must be a non-negative number` }, 400);
              item[f] = v;
            }
          }
          // Auto-compute top-level totals from items
          for (const f of macroFields) {
            mealData[f] = mealData.items.reduce((sum: number, item: any) => sum + (Number(item[f]) || 0), 0);
          }
          // Auto-generate description from items if not provided
          if (!mealData.description) {
            mealData.description = mealData.items.map((item: any) => item.name).slice(0, 3).join(', ') + (mealData.items.length > 3 ? '...' : '');
          }
          data.data = mealData;
        } else {
          // T#483: meal items are now mandatory — no more total-only logging
          return c.json({ error: 'Meal items required. Each meal must include an items array with individual food items and per-item macros (name, calories, protein, carbs, fat).' }, 400);
        }
      }
      // Workout validation — enforce structured exercise format (T#521, T#522, T#710)
      if (type === 'workout') {
        const workoutData = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
        const result = validateWorkoutData(workoutData);
        if (!result.ok) return c.json({ error: result.error, hint: result.hint }, 400);
        data.data = result.data;
      }
      const jsonData = typeof data.data === 'string' ? data.data : JSON.stringify(data.data);
      const now = new Date().toISOString();
      // Normalize logged_at to UTC — datetime-local inputs arrive without timezone
      let normalizedLoggedAt = logged_at || now;
      if (logged_at && !logged_at.endsWith('Z') && !logged_at.includes('+')) {
        normalizedLoggedAt = logged_at + 'Z';
      }
      const result = sqlite.prepare(
        'INSERT INTO routine_logs (type, logged_at, data, source, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run(type, normalizedLoggedAt, jsonData, data.source || 'manual', now);
      const logId = (result as any).lastInsertRowid;
      const log = sqlite.prepare('SELECT * FROM routine_logs WHERE id = ?').get(logId);

      // Update personal records for workout logs (T#410)
      if (type === 'workout') {
        try {
          const workoutData = typeof data.data === 'string' ? JSON.parse(data.data) : data.data;
          const prInsert = sqlite.prepare(
            'INSERT OR IGNORE INTO personal_records (exercise_name, weight, reps, unit, achieved_at, log_id) VALUES (?, ?, ?, ?, ?, ?)'
          );
          for (const ex of (workoutData.exercises || [])) {
            const { name } = parseExerciseName(typeof ex === 'string' ? ex : (ex.name || ''));
            if (!name) continue;
            for (const s of (ex.sets || [])) {
              const w = parseFloat(s.weight) || 0;
              const r = parseInt(s.reps) || 0;
              if (w > 0 && r > 0) {
                prInsert.run(name, w, r, (s.unit || 'kg').toLowerCase(), logged_at || now, logId);
              }
            }
          }
        } catch { /* PR update failure is non-critical */ }
      }

      return c.json(log, 201);
    } catch { return c.json({ error: 'Invalid request' }, 400); }
  });

  // PATCH /api/routine/logs/:id — edit log
  app.patch('/api/routine/logs/:id', async (c) => {
    if (!isForgeAuthorized(c, { mode: 'write' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
    const id = parseInt(c.req.param('id'), 10);
    const existing = sqlite.prepare('SELECT * FROM routine_logs WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!existing) return c.json({ error: 'Log not found' }, 404);
    try {
      const body = await c.req.json();
      const existingData = (existing as any).type;
      const updates: string[] = [];
      const values: any[] = [];
      if (body.data) {
        // Auto-sum meal items on edit (T#430) — items mandatory (T#483)
        if (existingData === 'meal') {
          const mealData = typeof body.data === 'string' ? JSON.parse(body.data) : body.data;
          if (!mealData.items || !Array.isArray(mealData.items) || mealData.items.length === 0) {
            return c.json({ error: 'Meal items required. Each meal must include an items array with individual food items and per-item macros.' }, 400);
          }
          if (mealData.items && Array.isArray(mealData.items) && mealData.items.length > 0) {
            const macroFields = ['calories', 'protein', 'carbs', 'fat'] as const;
            for (const f of macroFields) {
              mealData[f] = mealData.items.reduce((sum: number, item: any) => sum + (Number(item[f]) || 0), 0);
            }
            if (!mealData.description) {
              mealData.description = mealData.items.map((item: any) => item.name).slice(0, 3).join(', ') + (mealData.items.length > 3 ? '...' : '');
            }
            body.data = mealData;
          }
        }
        // T#710 Bertus P1 fold: PATCH must validate workout data the same way
        // POST does — prevents malformed notes/rpe slipping through edit path.
        if (existingData === 'workout') {
          const workoutData = typeof body.data === 'string' ? JSON.parse(body.data) : body.data;
          const result = validateWorkoutData(workoutData);
          if (!result.ok) return c.json({ error: result.error, hint: result.hint }, 400);
          body.data = result.data;
        }
        updates.push('data = ?'); values.push(typeof body.data === 'string' ? body.data : JSON.stringify(body.data));
      }
      if (body.logged_at) {
        let normalizedLoggedAt = body.logged_at;
        if (!body.logged_at.endsWith('Z') && !body.logged_at.includes('+')) {
          normalizedLoggedAt = body.logged_at + 'Z';
        }
        updates.push('logged_at = ?'); values.push(normalizedLoggedAt);
      }
      if (updates.length === 0) return c.json({ error: 'No fields to update' }, 400);
      values.push(id);
      sqlite.prepare(`UPDATE routine_logs SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      return c.json(sqlite.prepare('SELECT * FROM routine_logs WHERE id = ?').get(id));
    } catch { return c.json({ error: 'Invalid request' }, 400); }
  });

  // DELETE /api/routine/logs/:id — soft delete
  app.delete('/api/routine/logs/:id', (c) => {
    if (!isForgeAuthorized(c, { mode: 'write' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
    const id = parseInt(c.req.param('id'), 10);
    const existing = sqlite.prepare('SELECT * FROM routine_logs WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!existing) return c.json({ error: 'Log not found' }, 404);
    sqlite.prepare('UPDATE routine_logs SET deleted_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    return c.json({ success: true, id });
  });

  // GET /api/routine/logs/deleted — list soft-deleted entries for recovery
  app.get('/api/routine/logs/deleted', (c) => {
    if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
    const limit = parseInt(c.req.query('limit') || '50');
    const rows = sqlite.prepare('SELECT * FROM routine_logs WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC LIMIT ?').all(limit);
    return c.json({ logs: rows, total: (rows as any[]).length });
  });

  // PATCH /api/routine/logs/:id/restore — undelete a soft-deleted log
  app.patch('/api/routine/logs/:id/restore', (c) => {
    if (!isForgeAuthorized(c, { mode: 'write' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
    const id = parseInt(c.req.param('id'), 10);
    const existing = sqlite.prepare('SELECT * FROM routine_logs WHERE id = ? AND deleted_at IS NOT NULL').get(id);
    if (!existing) return c.json({ error: 'Deleted log not found' }, 404);
    sqlite.prepare('UPDATE routine_logs SET deleted_at = NULL WHERE id = ?').run(id);
    return c.json({ success: true, id, restored: true });
  });

  // POST /api/routine/photo/upload — upload progress photo
  app.post('/api/routine/photo/upload', async (c) => {
    if (!isForgeAuthorized(c, { mode: 'write' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
    try {
      let formData: FormData;
      try { formData = await c.req.formData(); } catch { return c.json({ error: 'No file provided. Send multipart/form-data with a file field.' }, 400); }
      const file = formData.get('file') as File;
      const tag = formData.get('tag') as string || '';
      const notes = formData.get('notes') as string || '';
      if (!file || !(file instanceof File) || file.size === 0) return c.json({ error: 'No file provided' }, 400);
      if (file.size > 10 * 1024 * 1024) return c.json({ error: 'File too large. Max 10MB' }, 400);

      const buffer = Buffer.from(await file.arrayBuffer());
      const imageType = detectImageType(buffer);
      if (!imageType) return c.json({ error: 'Invalid image. Only JPG, PNG, GIF, WebP allowed.' }, 400);

      // Process with sharp: EXIF rotation + keep date + strip GPS + resize
      let processedBuffer = buffer;
      let ext = imageType.ext;
      let captureDate: string | null = null;
      try {
        const sharp = require('sharp');
        // Extract EXIF date before processing
        const metadata = await sharp(buffer).metadata();
        if (metadata.exif) {
          try {
            // Parse EXIF for DateTimeOriginal (tag 0x9003)
            const exifStr = metadata.exif.toString('binary');
            const dateMatch = exifStr.match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
            if (dateMatch) {
              captureDate = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T${dateMatch[4]}:${dateMatch[5]}:${dateMatch[6]}.000Z`;
            }
          } catch { /* date extraction failed */ }
        }
        processedBuffer = await sharp(buffer)
          .rotate()
          .resize(1920, null, { withoutEnlargement: true })
          .jpeg({ quality: 95 })
          .withMetadata({ orientation: undefined })
          .toBuffer();
        ext = '.jpg';
      } catch { /* sharp not available */ }

      const filename = `${crypto.randomUUID()}${ext}`;
      fs.writeFileSync(path.join(ROUTINE_UPLOADS, filename), processedBuffer);

      // Create log entry — use EXIF capture date if available, otherwise now
      const now = new Date().toISOString();
      const loggedAt = captureDate || now;
      const photoData = JSON.stringify({ url: `/api/routine/photo/${filename}`, tag, notes, captureDate: captureDate || undefined });
      const result = sqlite.prepare(
        'INSERT INTO routine_logs (type, logged_at, data, source, created_at) VALUES (?, ?, ?, ?, ?)'
      ).run('photo', loggedAt, photoData, 'manual', now);
      const log = sqlite.prepare('SELECT * FROM routine_logs WHERE id = ?').get((result as any).lastInsertRowid);
      return c.json(log, 201);
    } catch { return c.json({ error: 'Upload failed' }, 500); }
  });

  // GET /api/routine/photo/:filename — serve routine photo
  app.get('/api/routine/photo/:filename', (c) => {
    if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge is private to Gorn and Sable' }, 403);
    const filename = c.req.param('filename').replace(/[^a-zA-Z0-9._-]/g, '');
    const filePath = path.join(ROUTINE_UPLOADS, filename);
    if (!fs.existsSync(filePath)) return c.json({ error: 'Not found' }, 404);
    const ext = path.extname(filename).toLowerCase();
    const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    return new Response(fs.readFileSync(filePath), { headers: { 'Content-Type': mime, 'Cache-Control': 'public, max-age=86400' } });
  });

  // POST /api/routine/import/alpha-progression — import Alpha Progression CSV (T#389)
  app.post('/api/routine/import/alpha-progression', async (c) => {
    if (!isForgeAuthorized(c, { mode: 'write' })) return c.json({ error: 'Forge access denied' }, 403);

    try {
      const formData = await c.req.formData();
      const file = formData.get('file') as File;
      if (!file) return c.json({ error: 'No file provided' }, 400);

      const text = await file.text();
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

      const sessions: any[] = [];
      let currentSession: any = null;
      let currentExercise: any = null;
      let unit = 'KG';
      let hasRir = false;

      for (const line of lines) {
        // Session header: "Workout Name";"date";"duration"
        if (line.startsWith('"') && line.includes('";"')) {
          const parts = line.split('";').map(s => s.replace(/^"|"$/g, ''));
          if (parts.length >= 3 && parts[1].match(/\d{4}-\d{2}-\d{2}/)) {
            if (currentSession) {
              if (currentExercise) currentSession.exercises.push(currentExercise);
              sessions.push(currentSession);
            }
            currentSession = {
              name: parts[0],
              date: parts[1],
              duration: parts[2],
              exercises: [],
            };
            currentExercise = null;
            continue;
          }
        }

        // Exercise header: "1. Exercise Name · Equipment · N reps"
        if (line.startsWith('"') && line.match(/^"\d+\./)) {
          if (currentExercise && currentSession) currentSession.exercises.push(currentExercise);
          const name = line.replace(/^"|"$/g, '');
          currentExercise = { name, sets: [], unit: 'KG' };
          continue;
        }

        // Unit row: #;KG;REPS or #;LB;REPS or #;KG;REPS;RIR
        if (line.startsWith('#;')) {
          const parts = line.split(';');
          unit = parts[1] || 'KG';
          hasRir = parts.includes('RIR');
          if (currentExercise) currentExercise.unit = unit;
          continue;
        }

        // Set row: 1;220;8 or 1;+0;12 or 1;-;-
        if (currentExercise && line.match(/^\d+;/)) {
          const parts = line.split(';');
          const setNum = parseInt(parts[0], 10);
          const weightStr = parts[1];
          const repsStr = parts[2];
          const rirStr = hasRir ? parts[3] : undefined;

          if (weightStr === '-' || repsStr === '-') continue; // Skip empty sets

          const weight = weightStr.startsWith('+') ? parseFloat(weightStr) : parseFloat(weightStr);
          const reps = parseInt(repsStr, 10);
          if (isNaN(weight) || isNaN(reps)) continue;

          const set: any = { set: setNum, weight, reps, unit };
          if (rirStr && rirStr !== '-') set.rir = rirStr;
          currentExercise.sets.push(set);
        }
      }

      // Push last session
      if (currentSession) {
        if (currentExercise) currentSession.exercises.push(currentExercise);
        sessions.push(currentSession);
      }

      // Filter out exercises with no completed sets
      for (const session of sessions) {
        session.exercises = session.exercises.filter((e: any) => e.sets.length > 0);
      }

      // Check for existing imports in this date range (dedup)
      const existingDates = new Set<string>();
      const existingRows = sqlite.prepare(
        "SELECT logged_at FROM routine_logs WHERE type = 'workout' AND source = 'alpha-progression' AND deleted_at IS NULL"
      ).all() as any[];
      for (const row of existingRows) existingDates.add(row.logged_at);

      // Filter out sessions that already exist (by date)
      const newSessions = sessions.filter((s: any) => {
        const loggedAt = new Date(s.date).toISOString();
        return !existingDates.has(loggedAt);
      });
      const duplicateCount = sessions.length - newSessions.length;

      // Preview mode: return parsed data without importing
      const preview = c.req.query('preview') === 'true';
      if (preview) {
        return c.json({
          sessions: sessions.length,
          new_sessions: newSessions.length,
          duplicates: duplicateCount,
          date_range: sessions.length > 0 ? {
            from: sessions[sessions.length - 1].date,
            to: sessions[0].date,
          } : null,
          total_exercises: newSessions.reduce((sum: number, s: any) => sum + s.exercises.length, 0),
          total_sets: newSessions.reduce((sum: number, s: any) => sum + s.exercises.reduce((esum: number, e: any) => esum + e.sets.length, 0), 0),
          sample: newSessions.slice(0, 3),
        });
      }

      // Import: insert only new sessions
      const now = new Date().toISOString();
      const insert = sqlite.prepare(
        'INSERT INTO routine_logs (type, logged_at, data, source, created_at) VALUES (?, ?, ?, ?, ?)'
      );
      let imported = 0;
      for (const session of newSessions) {
        const loggedAt = new Date(session.date).toISOString();
        const data = JSON.stringify({
          workout_name: session.name,
          duration: session.duration,
          exercises: session.exercises,
        });
        insert.run('workout', loggedAt, data, 'alpha-progression', now);
        imported++;
      }

      return c.json({
        imported,
        duplicates: duplicateCount,
        date_range: newSessions.length > 0 ? {
          from: newSessions[newSessions.length - 1].date,
          to: newSessions[0].date,
        } : null,
        total_exercises: newSessions.reduce((sum: number, s: any) => sum + s.exercises.length, 0),
        total_sets: newSessions.reduce((sum: number, s: any) => sum + s.exercises.reduce((esum: number, e: any) => esum + e.sets.length, 0), 0),
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Import failed' }, 500);
    }
  });

  // POST /api/routine/import/alpha-measurements — import Alpha Progression Measurements CSV (T#392)
  app.post('/api/routine/import/alpha-measurements', async (c) => {
    if (!isForgeAuthorized(c, { mode: 'write' })) return c.json({ error: 'Forge access denied' }, 403);

    try {
      const formData = await c.req.formData();
      const file = formData.get('file') as File;
      if (!file) return c.json({ error: 'No file provided' }, 400);

      const text = await file.text();
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

      const entries: { type: string; date: string; value: number; unit: string }[] = [];
      let currentType = '';
      let currentUnit = '';

      for (const line of lines) {
        // Section header: "Body fat percentage" or Bodyweight
        if (line === '"Body fat percentage"' || line === 'Body fat percentage') {
          currentType = 'bodyfat';
          continue;
        }
        if (line === 'Bodyweight' || line === '"Bodyweight"') {
          currentType = 'weight';
          continue;
        }
        // Unit row: DATE;% or DATE;KG
        if (line.startsWith('DATE;')) {
          currentUnit = line.split(';')[1] || '';
          continue;
        }
        // Data row: "date";value
        if (currentType && line.startsWith('"')) {
          const parts = line.split(';');
          const date = parts[0].replace(/^"|"$/g, '');
          const value = parseFloat(parts[1]);
          if (!isNaN(value)) {
            entries.push({ type: currentType, date, value, unit: currentUnit });
          }
        }
      }

      // Dedup: check existing entries
      const existingDates = new Map<string, Set<string>>();
      const existingRows = sqlite.prepare(
        "SELECT type, logged_at FROM routine_logs WHERE type IN ('weight', 'bodyfat') AND source = 'alpha-progression' AND deleted_at IS NULL"
      ).all() as any[];
      for (const row of existingRows) {
        if (!existingDates.has(row.type)) existingDates.set(row.type, new Set());
        existingDates.get(row.type)!.add(row.logged_at);
      }

      const newEntries = entries.filter(e => {
        const loggedAt = new Date(e.date).toISOString();
        return !existingDates.get(e.type)?.has(loggedAt);
      });
      const duplicateCount = entries.length - newEntries.length;

      const preview = c.req.query('preview') === 'true';
      const bodyfatCount = newEntries.filter(e => e.type === 'bodyfat').length;
      const weightCount = newEntries.filter(e => e.type === 'weight').length;

      if (preview) {
        return c.json({
          total_entries: entries.length,
          new_entries: newEntries.length,
          duplicates: duplicateCount,
          bodyfat: bodyfatCount,
          weight: weightCount,
          date_range: entries.length > 0 ? {
            from: entries[entries.length - 1].date,
            to: entries[0].date,
          } : null,
        });
      }

      // Import
      const now = new Date().toISOString();
      const insert = sqlite.prepare(
        'INSERT INTO routine_logs (type, logged_at, data, source, created_at) VALUES (?, ?, ?, ?, ?)'
      );
      let imported = 0;
      for (const entry of newEntries) {
        const loggedAt = new Date(entry.date).toISOString();
        const data = JSON.stringify({
          value: entry.value,
          unit: entry.unit === '%' ? '%' : 'kg',
        });
        insert.run(entry.type === 'weight' ? 'weight' : 'bodyfat', loggedAt, data, 'alpha-progression', now);
        imported++;
      }

      return c.json({ imported, duplicates: duplicateCount, bodyfat: bodyfatCount, weight: weightCount });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Import failed' }, 500);
    }
  });

  // POST /api/routine/hevy/sync — pull recent workouts from Hevy into Forge (T#703)
  // Owner-session or write-auth forge access.
  // Query: ?days=7 (default window, max 90).
  // Dedupes on hevy workout id stored in data.hevy_id.
  app.post('/api/routine/hevy/sync', async (c) => {
    if (!isForgeAuthorized(c, { mode: 'write' })) return c.json({ error: 'Forge access denied' }, 403);

    const token = process.env.HEVY_API_TOKEN;
    if (!token) return c.json({ error: 'HEVY_API_TOKEN not configured on server' }, 500);

    const daysParam = parseInt(c.req.query('days') || '7', 10);
    const days = Math.min(90, Math.max(1, daysParam));
    const sinceMs = Date.now() - days * 24 * 60 * 60 * 1000;

    try {
      // Fetch pages until we reach workouts older than the window.
      const fetched: any[] = [];
      let page = 1;
      const pageSize = 10;
      while (true) {
        const url = `https://api.hevyapp.com/v1/workouts?page=${page}&pageSize=${pageSize}`;
        const resp = await fetch(url, { headers: { 'api-key': token, 'accept': 'application/json' } });
        if (!resp.ok) return c.json({ error: `Hevy API ${resp.status}: ${await resp.text()}` }, 502);
        const body = await resp.json() as any;
        const workouts = body.workouts || [];
        if (workouts.length === 0) break;

        let hitOld = false;
        for (const w of workouts) {
          const startMs = new Date(w.start_time).getTime();
          if (startMs < sinceMs) { hitOld = true; continue; }
          fetched.push(w);
        }
        if (hitOld || page >= (body.page_count || 1) || page >= 10) break;
        page++;
      }

      // Existing hevy-source workouts — dedupe set on hevy_id.
      const existingIds = new Set<string>();
      const existingRows = sqlite.prepare(
        "SELECT data FROM routine_logs WHERE type = 'workout' AND source = 'hevy' AND deleted_at IS NULL"
      ).all() as any[];
      for (const row of existingRows) {
        try {
          const d = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
          if (d?.hevy_id) existingIds.add(d.hevy_id);
        } catch { /* skip malformed */ }
      }

      const insert = sqlite.prepare(
        'INSERT INTO routine_logs (type, logged_at, data, source, created_at) VALUES (?, ?, ?, ?, ?)'
      );
      let inserted = 0;
      let skipped = 0;
      const nowIso = new Date().toISOString();

      for (const w of fetched) {
        if (existingIds.has(w.id)) { skipped++; continue; }

        // Map Hevy → Forge workout shape.
        const startMs = new Date(w.start_time).getTime();
        const endMs = new Date(w.end_time).getTime();
        const durSec = Math.max(0, Math.round((endMs - startMs) / 1000));
        const h = Math.floor(durSec / 3600);
        const m = Math.floor((durSec % 3600) / 60);
        const duration = h > 0 ? `${h}:${String(m).padStart(2, '0')} hr` : `${m} min`;

        const exercises = (w.exercises || []).map((ex: any, idx: number) => {
          const mapped: any = {
            name: `${idx + 1}. ${ex.title || 'Unknown'}`,
            sets: (ex.sets || []).map((s: any, sIdx: number) => {
              const set: any = {
                set: sIdx + 1,
                weight: s.weight_kg ?? null,
                reps: s.reps ?? null,
                unit: 'KG',
              };
              // T#710: pass through Hevy RPE if present (1-10 numeric).
              if (s.rpe != null) {
                const rpeNum = Number(s.rpe);
                if (!isNaN(rpeNum) && rpeNum >= 1 && rpeNum <= 10) set.rpe = rpeNum;
              }
              // T#711: pass through Hevy set type (normal/warmup/dropset/failure).
              // Silent-drop on unknown per Gnarl/Bertus architect CLEAR — honest-untyped beats
              // inferred-normal for audit fidelity. Noise-log on drop gives observability signal
              // for Hevy drift or mapper gap without polluting storage.
              if (typeof s.type === 'string') {
                const t = s.type.toLowerCase();
                if (t === 'normal' || t === 'warmup' || t === 'dropset' || t === 'failure') {
                  set.type = t;
                } else {
                  console.warn(`[hevy-sync T#711] dropping unknown set.type="${s.type}" on workout ${w.id} exercise ${idx + 1} set ${sIdx + 1}`);
                }
              }
              return set;
            }),
            unit: 'KG',
          };
          // T#710: pass through Hevy exercise notes if present.
          if (typeof ex.notes === 'string' && ex.notes.trim()) {
            mapped.notes = ex.notes;
          }
          // T#711: pass through Hevy exercise_template_id (cross-link to Hevy library).
          if (typeof ex.exercise_template_id === 'string' && ex.exercise_template_id.trim()) {
            mapped.hevy_template_id = ex.exercise_template_id;
          }
          // T#711: pass through Hevy supersets_id (preserve superset grouping; number or null).
          if (typeof ex.supersets_id === 'number' && Number.isFinite(ex.supersets_id)) {
            mapped.superset_id = ex.supersets_id;
          }
          return mapped;
        });

        const data = JSON.stringify({
          workout_name: w.title || 'Untitled',
          duration,
          exercises,
          hevy_id: w.id,
          description: w.description || null,
        });

        insert.run('workout', w.end_time, data, 'hevy', nowIso);
        inserted++;
      }

      return c.json({
        window_days: days,
        fetched: fetched.length,
        inserted,
        skipped_duplicates: skipped,
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Hevy sync failed' }, 500);
    }
  });

  // POST /api/webhooks/hevy — receive Hevy push notifications on workout creation (T#724)
  // Hevy spec: POST { workoutId } body, expects 200 OK within 5 seconds.
  // Auth: HEVY_WEBHOOK_TOKEN env var, Hevy puts in Authorization header as raw token
  // (NO 'Bearer ' prefix — confirmed empirically via webhook.site capture 2026-04-29).
  // Pattern parity with /api/webhooks/withings — respond fast + async sync.
  // Bear T3 stamp: Discord 21:28 BKK 2026-04-26 (Sable Prowl #89 audit).
  app.post('/api/webhooks/hevy', async (c) => {
    // Validate webhook secret (constant-time compare to prevent timing attacks)
    const webhookToken = process.env.HEVY_WEBHOOK_TOKEN;
    if (!webhookToken) {
      console.error('[Hevy webhook] HEVY_WEBHOOK_TOKEN not configured — rejecting');
      return c.text('OK', 200); // Still 200 to avoid Hevy retries
    }
    const authHeader = c.req.header('Authorization') || '';
    // Hevy sends the raw token as the Authorization header value (no 'Bearer ' prefix).
    // Use crypto.timingSafeEqual for canonical constant-time compare
    // (per Pip + Bertus PR #24 review — manual loop leaks length info via loop duration)
    const authBuf = Buffer.from(authHeader);
    const expectedBuf = Buffer.from(webhookToken);
    const valid = authBuf.length === expectedBuf.length && timingSafeEqual(authBuf, expectedBuf);
    if (!valid) {
      return c.json({ error: 'forbidden' }, 401);
    }

    // Parse body
    let workoutId: string;
    try {
      const body = await c.req.json() as any;
      workoutId = String(body.workoutId || '');
      if (!workoutId) {
        console.warn('[Hevy webhook] missing workoutId in body');
        return c.text('OK', 200); // Still 200 — bad payload from Hevy is their concern, not ours
      }
    } catch {
      return c.text('OK', 200);
    }

    // UUID-shape allowlist on workoutId before URL interpolation (per Pip + Bertus
    // PR #24 review — defense-in-depth against forged-bearer with path-traversal
    // attempt; Hevy workoutIds are UUIDs per their spec)
    if (!/^[a-fA-F0-9-]{36}$/.test(workoutId)) {
      console.warn(`[Hevy webhook] invalid workoutId format: ${workoutId}`);
      return c.text('OK', 200);
    }

    console.log(`[Hevy webhook] received workoutId=${workoutId}`);

    // Async sync — respond 200 immediately, fetch + insert in background
    syncSingleHevyWorkout(workoutId).catch(err => {
      console.error(`[Hevy webhook] async sync failed for ${workoutId}:`, err);
    });

    return c.text('OK', 200);
  });

  // Helper: fetch a single Hevy workout by ID and insert into Forge.
  // Reuses the same mapping shape as /api/routine/hevy/sync (T#710 RPE, T#711 set.type/template_id/superset_id).
  // Idempotent — dedupe via existing hevy_id check.
  //
  // Async failures are non-fatal: if sync fails (Hevy API down, malformed response,
  // DB error), the workout silently doesn't sync — Hevy gets 200, no retry.
  // Recovery path: reconcile via POST /api/routine/hevy/sync full-pull endpoint,
  // which is dedupe-safe and will catch any webhook-missed workouts on replay.
  async function syncSingleHevyWorkout(workoutId: string): Promise<void> {
    const apiToken = process.env.HEVY_API_TOKEN;
    if (!apiToken) {
      console.error(`[Hevy webhook sync] HEVY_API_TOKEN not configured — cannot fetch ${workoutId}`);
      return;
    }

    // Check dedupe first — same workoutId webhook re-fires are no-op
    const existing = sqlite.prepare(
      "SELECT id FROM routine_logs WHERE type = 'workout' AND source = 'hevy' AND deleted_at IS NULL AND json_extract(data, '$.hevy_id') = ? LIMIT 1"
    ).get(workoutId) as any;
    if (existing) {
      console.log(`[Hevy webhook sync] workoutId=${workoutId} already exists as routine_log id=${existing.id}, skipping`);
      return;
    }

    // Fetch the workout from Hevy
    const url = `https://api.hevyapp.com/v1/workouts/${workoutId}`;
    const resp = await fetch(url, { headers: { 'api-key': apiToken, 'accept': 'application/json' } });
    if (!resp.ok) {
      console.error(`[Hevy webhook sync] Hevy API ${resp.status} for ${workoutId}: ${await resp.text()}`);
      return;
    }
    const w = await resp.json() as any;
    // Hevy single-workout endpoint may wrap in { workout: ... } — handle both shapes
    const workout = w.workout || w;
    if (!workout || !workout.id) {
      console.error(`[Hevy webhook sync] malformed Hevy response for ${workoutId}`);
      return;
    }

    // Map Hevy → Forge workout shape (mirrors /api/routine/hevy/sync logic).
    const startMs = new Date(workout.start_time).getTime();
    const endMs = new Date(workout.end_time).getTime();
    const durSec = Math.max(0, Math.round((endMs - startMs) / 1000));
    const h = Math.floor(durSec / 3600);
    const m = Math.floor((durSec % 3600) / 60);
    const duration = h > 0 ? `${h}:${String(m).padStart(2, '0')} hr` : `${m} min`;

    const exercises = (workout.exercises || []).map((ex: any, idx: number) => {
      const mapped: any = {
        name: `${idx + 1}. ${ex.title || 'Unknown'}`,
        sets: (ex.sets || []).map((s: any, sIdx: number) => {
          const set: any = {
            set: sIdx + 1,
            weight: s.weight_kg ?? null,
            reps: s.reps ?? null,
            unit: 'KG',
          };
          if (s.rpe != null) {
            const rpeNum = Number(s.rpe);
            if (!isNaN(rpeNum) && rpeNum >= 1 && rpeNum <= 10) set.rpe = rpeNum;
          }
          if (typeof s.type === 'string') {
            const t = s.type.toLowerCase();
            if (t === 'normal' || t === 'warmup' || t === 'dropset' || t === 'failure') {
              set.type = t;
            } else {
              console.warn(`[hevy-webhook T#711] dropping unknown set.type="${s.type}" on workout ${workout.id} exercise ${idx + 1} set ${sIdx + 1}`);
            }
          }
          return set;
        }),
        unit: 'KG',
      };
      if (typeof ex.notes === 'string' && ex.notes.trim()) mapped.notes = ex.notes;
      if (typeof ex.exercise_template_id === 'string' && ex.exercise_template_id.trim()) {
        mapped.hevy_template_id = ex.exercise_template_id;
      }
      if (typeof ex.supersets_id === 'number' && Number.isFinite(ex.supersets_id)) {
        mapped.superset_id = ex.supersets_id;
      }
      return mapped;
    });

    const data = {
      title: workout.title || 'Untitled workout',
      duration,
      exercises,
      hevy_id: workout.id,
      notes: typeof workout.description === 'string' && workout.description.trim() ? workout.description : undefined,
    };

    sqlite.prepare(
      'INSERT INTO routine_logs (type, logged_at, data, source, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run('workout', new Date(workout.start_time).toISOString(), JSON.stringify(data), 'hevy', new Date().toISOString());

    console.log(`[Hevy webhook sync] inserted workoutId=${workoutId} title="${data.title}" exercises=${exercises.length}`);
  }

}
