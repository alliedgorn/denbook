import fs from 'fs';
import path from 'path';
import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';
import { SECURITY_RETENTION_DAYS, pruneSecurityEvents } from '../server/security-logger.ts';
import { pruneBeastTokens } from '../server/beast-tokens.ts';
import { ORACLE_DATA_DIR } from '../config.ts';

const UPLOADS_DIR = path.join(ORACLE_DATA_DIR, 'uploads');
const ARCHIVE_DIR = path.join(ORACLE_DATA_DIR, 'uploads', 'archive');

// ============================================================================
// Module-level state — captured via initDaemons()
// ============================================================================

let moduleSqlite: Database | null = null;
let daemonsStarted = false;

// ============================================================================
// Notification Queue Drain (Spec #29, T#497)
// ============================================================================

const DRAIN_INTERVAL = 1000; // Check queues every 1s
const DRAIN_SPACING = 1000; // 1s between sends to same Beast (was 3s — Tier 1 of notification queue smoothness fix, 2026-04-08)
const DRAIN_DIR = '/tmp/den-notify';
const drainLastSent: Map<string, number> = new Map(); // beast → last send timestamp

/**
 * Spec #54 v2 §1 — Per-Beast drain coexistence check.
 * Returns true if the per-Beast drain process owns this queue (server should
 * skip). Returns false if no per-Beast drain or stale/unrelated PID (server
 * should fallback-drain).
 *
 * Two-layer check:
 * 1. signal-0 kill: process exists at all
 * 2. /proc/<pid>/cmdline: process is actually notify-drain.sh (defends against
 *    Linux PID-reuse — kernel.pid_max default 32768, cycle hours-to-days under
 *    load. Without this, OOM/SIGKILL stale-PID + reused-PID = server false-skips
 *    queue indefinitely until next /wakeup. That's the EXACT Decree #66
 *    incident-response continuity gap this spec closes.)
 *
 * Phase 2+ defense-in-depth: write start-time to PID file alongside PID, validate
 * against /proc/<pid>/stat field 22 (process start time). systemd-PIDFile pattern.
 */
function perBeastDrainAlive(pidPath: string): boolean {
  try {
    if (!fs.existsSync(pidPath)) return false;
    const pid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    if (!pid || isNaN(pid)) return false;
    // Layer 1: process exists?
    try { process.kill(pid, 0); }
    catch { return false; } // ESRCH = process gone
    // Layer 2: process is actually notify-drain.sh? (PID-reuse defense)
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
      return cmdline.includes('notify-drain.sh');
    } catch { return false; } // /proc gone or unreadable = treat as dead
  } catch { return false; }
}

function runDrainCycle() {
  try {
    if (!fs.existsSync(DRAIN_DIR)) return;
    const files = fs.readdirSync(DRAIN_DIR).filter(f => f.endsWith('.queue'));

    for (const file of files) {
      const beast = file.replace('.queue', '');
      const queuePath = path.join(DRAIN_DIR, file);
      const lockPath = path.join(DRAIN_DIR, `${beast}.lock`);
      const pidPath = path.join(DRAIN_DIR, `${beast}.pid`);

      // Spec #54 v2 §1 — skip if per-Beast drain owns this queue.
      // perBeastDrainAlive uses signal-0 kill + /proc/<pid>/cmdline check to
      // defend against Linux PID-reuse (Bertus near-blocker §1, promoted from
      // Phase 2 to Phase 1 baseline). Closes the implicit-fallback-drift class
      // that defeats the offline-resilience guarantee.
      if (perBeastDrainAlive(pidPath)) continue;

      // T#738 / Spec #54 Phase 5 Window 2: log-only-warning when server-drain
      // falls back to handling a queue that should be per-Beast-drained.
      // After 7 days of zero warnings → Window 3 removes runDrainCycle entirely.
      console.warn(`[Notify] WINDOW-2-WARNING: server-drain fallback for ${beast} — per-Beast drain NOT alive (pid: ${pidPath})`);

      // Check spacing — don't send to same Beast within DRAIN_SPACING
      const lastSent = drainLastSent.get(beast) || 0;
      if (Date.now() - lastSent < DRAIN_SPACING) continue;

      // Check queue has content
      try {
        const stat = fs.statSync(queuePath);
        if (stat.size === 0) continue;
      } catch { continue; }

      // Read and remove first line atomically via flock
      try {
        const result = Bun.spawnSync(['bash', '-c',
          `flock "${lockPath}" bash -c "head -1 '${queuePath}' && sed -i '1d' '${queuePath}'"`
        ]);
        const encoded = result.stdout.toString().trim();
        if (!encoded) continue;

        // Decode from base64
        const message = Buffer.from(encoded, 'base64').toString('utf-8');
        if (!message) continue;

        // Resolve tmux session name
        const sessionName = beast.charAt(0).toUpperCase() + beast.slice(1);

        // Check session exists — re-queue if Beast is offline
        const hasSession = Bun.spawnSync(['tmux', 'has-session', '-t', sessionName]);
        if (hasSession.exitCode !== 0) {
          // Beast offline — re-append to tail of queue so it retries next cycle
          try {
            Bun.spawnSync(['bash', '-c',
              `umask 0077 && flock "${lockPath}" bash -c "echo '${encoded}' >> '${queuePath}'"`
            ]);
          } catch { /* best effort re-queue */ }
          drainLastSent.set(beast, Date.now()); // avoid spinning on offline Beasts
          continue;
        }

        // Send to tmux
        Bun.spawnSync(['tmux', 'send-keys', '-t', sessionName, '-l', message]);
        // T#714 (follow-up to T#713 scope-miss): sleep 200ms between text-paste
        // and Enter to break the race with Claude Code's Ink TUI renderer.
        // Without this delay, Enter could land mid-frame while the input field
        // was still rendering the paste, and the message would sit stuck in the
        // input instead of submitting. Same pattern landed in notify-drain.sh:42.
        Bun.sleepSync(200);
        Bun.spawnSync(['tmux', 'send-keys', '-t', sessionName, 'Enter']);

        drainLastSent.set(beast, Date.now());
      } catch (err) {
        // Silent — don't spam logs on queue errors
      }
    }
  } catch { /* DRAIN_DIR doesn't exist yet */ }
}

// Startup setInterval/setTimeout for runDrainCycle moved into initDaemons() — see bottom.

// ============================================================================
// DB Maintenance — audit log retention + VACUUM
// ============================================================================

const DB_RETENTION_DAYS = 15;
const DB_MAINTENANCE_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

function runDbMaintenance() {
  if (!moduleSqlite) return;
  const sqlite: Database = moduleSqlite;
  try {
    const cutoff = `-${DB_RETENTION_DAYS} days`;

    // Prune audit_log older than retention period
    const auditResult = sqlite.prepare(
      `DELETE FROM audit_log WHERE timestamp < datetime('now', ?)`
    ).run(cutoff);

    // Prune security_events older than 90-day retention period
    const securityPruned = pruneSecurityEvents();

    // Prune expired/revoked beast tokens older than 7 days (T#546)
    const tokensPruned = pruneBeastTokens();

    const pruned = (auditResult.changes || 0) + securityPruned + tokensPruned;

    if (pruned > 0) {
      // VACUUM to reclaim space after large deletes
      sqlite.exec('VACUUM');
      console.log(`[DB Maintenance] Pruned ${auditResult.changes} audit rows (>${DB_RETENTION_DAYS}d), ${securityPruned} security events (>${SECURITY_RETENTION_DAYS}d), ${tokensPruned} expired tokens. VACUUM complete.`);
    } else {
      console.log(`[DB Maintenance] Nothing to prune.`);
    }
  } catch (err) {
    console.error(`[DB Maintenance] Error: ${err}`);
  }
}


// ── File Archive Cycle (T#533) ──────────────────────────────────────
// Moves soft-deleted files to compressed tar.gz archives after 7-day grace period.
// Nothing is Deleted — files are archived, never permanently removed.

const FILE_ARCHIVE_GRACE_DAYS = 7;
const FILE_ARCHIVE_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours (same as DB maintenance)

function runFileArchive() {
  if (!moduleSqlite) return;
  const sqlite: Database = moduleSqlite;
  try {
    const graceCutoff = Date.now() - (FILE_ARCHIVE_GRACE_DAYS * 24 * 60 * 60 * 1000);

    // Find files deleted more than 7 days ago that haven't been archived yet
    const filesToArchive = sqlite.prepare(
      `SELECT id, filename, original_name, size_bytes FROM files
       WHERE deleted_at IS NOT NULL AND deleted_at < ? AND archived_at IS NULL`
    ).all(graceCutoff) as { id: number; filename: string; original_name: string; size_bytes: number }[];

    if (filesToArchive.length === 0) return;

    // Create archive directory: uploads/archive/YYYY-MM/
    const now = new Date();
    const monthDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const archiveDir = path.join(ARCHIVE_DIR, monthDir);
    if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });

    // Archive filename: archive-YYYY-MM-DD.tar.gz
    const dateStr = now.toISOString().slice(0, 10);
    const archiveName = `archive-${dateStr}.tar.gz`;
    const archivePath = path.join(archiveDir, archiveName);
    const relativeArchivePath = `archive/${monthDir}/${archiveName}`;

    // Collect files that actually exist on disk
    const existingFiles: typeof filesToArchive = [];
    for (const f of filesToArchive) {
      const filePath = path.join(UPLOADS_DIR, f.filename);
      if (fs.existsSync(filePath)) {
        existingFiles.push(f);
      } else {
        // File already gone from disk — mark as archived with no path
        sqlite.prepare('UPDATE files SET archived_at = ? WHERE id = ?').run(Date.now(), f.id);
      }
    }

    if (existingFiles.length === 0) return;

    // Build tar.gz using system tar command
    // If archive already exists for today, append is not supported with gzip,
    // so use a unique suffix
    let finalArchivePath = archivePath;
    if (fs.existsSync(archivePath)) {
      const suffix = Date.now().toString(36);
      finalArchivePath = path.join(archiveDir, `archive-${dateStr}-${suffix}.tar.gz`);
    }
    const finalRelativePath = path.relative(path.join(ORACLE_DATA_DIR, 'uploads'), finalArchivePath);

    // Create a file list for tar
    const fileListPath = path.join(archiveDir, `.archive-list-${Date.now()}.txt`);
    fs.writeFileSync(fileListPath, existingFiles.map(f => f.filename).join('\n'));

    const { execSync } = require('child_process');
    execSync(`tar -czf "${finalArchivePath}" -C "${UPLOADS_DIR}" -T "${fileListPath}"`, {
      timeout: 120_000, // 2 min timeout
    });

    // Clean up file list
    fs.unlinkSync(fileListPath);

    // Verify archive was created
    if (!fs.existsSync(finalArchivePath)) {
      console.error(`[File Archive] Failed to create archive: ${finalArchivePath}`);
      return;
    }

    const archiveSize = fs.statSync(finalArchivePath).size;

    // Update DB: mark files as archived, remove originals
    const archiveTimestamp = Date.now();
    const updateStmt = sqlite.prepare('UPDATE files SET archived_at = ?, archive_path = ? WHERE id = ?');
    let totalFreed = 0;

    for (const f of existingFiles) {
      updateStmt.run(archiveTimestamp, finalRelativePath, f.id);
      const filePath = path.join(UPLOADS_DIR, f.filename);
      try {
        fs.unlinkSync(filePath);
        totalFreed += f.size_bytes;
      } catch (err) {
        console.error(`[File Archive] Failed to remove original: ${f.filename}`, err);
      }
    }

    console.log(`[File Archive] Archived ${existingFiles.length} files → ${finalRelativePath} (${(archiveSize / 1024).toFixed(1)}KB archive, ${(totalFreed / 1024 / 1024).toFixed(1)}MB freed)`);
  } catch (err) {
    console.error(`[File Archive] Error:`, err);
  }
}



// ============================================================================
// initDaemons — server startup entry: capture sqlite + start all daemons once
// ============================================================================

export function initDaemons(sqliteDb: Database): void {
  moduleSqlite = sqliteDb;
  if (daemonsStarted) return;
  daemonsStarted = true;

  // Notification queue drain (1s interval, 3s warmup)
  setInterval(runDrainCycle, DRAIN_INTERVAL);
  setTimeout(runDrainCycle, 3000);
  console.log('[Notify] Queue drain started (1s interval, 3s spacing)');

  // DB maintenance (6h interval, 30s warmup)
  setTimeout(runDbMaintenance, 30_000);
  setInterval(runDbMaintenance, DB_MAINTENANCE_INTERVAL);
  console.log(`[DB Maintenance] Retention: ${DB_RETENTION_DAYS} days, interval: 6h`);

  // File archive (6h interval, 60s warmup)
  setTimeout(runFileArchive, 60_000);
  setInterval(runFileArchive, FILE_ARCHIVE_INTERVAL);
  console.log(`[File Archive] Grace: ${FILE_ARCHIVE_GRACE_DAYS} days, interval: 6h`);
}

// ============================================================================
// Routes — 5 daemon-management endpoints
// ============================================================================

export function registerDaemonRoutes(app: OpenAPIHono, sqliteDb: Database): void {
  // Shadow module-level sqlite (Database | null) with non-null local
  const sqlite: Database = sqliteDb;

  // DB maintenance routes
  // POST /api/db/maintenance — manual trigger (Gorn-only)
  app.post('/api/db/maintenance', (c) => {
    const requester = c.req.query('as');
    if (requester) {
      return c.json({ error: 'forbidden' }, 403);
    }
    runDbMaintenance();
    return c.json({ status: 'ok', retention_days: DB_RETENTION_DAYS });
  });

  // GET /api/db/stats — table sizes and DB info
  app.get('/api/db/stats', (c) => {
    const tables = sqlite.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    ).all() as { name: string }[];

    const stats = tables.map((t) => {
      const row = sqlite.prepare(`SELECT COUNT(*) as cnt FROM "${t.name}"`).get() as { cnt: number };
      return { table: t.name, rows: row.cnt };
    });

    const pageCount = (sqlite.prepare('PRAGMA page_count').get() as any)?.page_count || 0;
    const pageSize = (sqlite.prepare('PRAGMA page_size').get() as any)?.page_size || 0;
    const freePages = (sqlite.prepare('PRAGMA freelist_count').get() as any)?.freelist_count || 0;

    return c.json({
      retention_days: DB_RETENTION_DAYS,
      db_size_bytes: pageCount * pageSize,
      free_pages: freePages,
      tables: stats.sort((a, b) => b.rows - a.rows),
    });
  });

  // Run maintenance on boot (after 30s) and every 6 hours
  setTimeout(runDbMaintenance, 30_000);


  // File archive routes
  // GET /api/files/archive/stats — archive statistics
  app.get('/api/files/archive/stats', (c) => {
    const archived = sqlite.prepare(
      `SELECT COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as original_size FROM files WHERE archived_at IS NOT NULL`
    ).get() as any;

    const pending = sqlite.prepare(
      `SELECT COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as total_size FROM files
       WHERE deleted_at IS NOT NULL AND archived_at IS NULL`
    ).get() as any;

    // List archive bundles on disk
    const bundles: { path: string; size: number; created: string }[] = [];
    if (fs.existsSync(ARCHIVE_DIR)) {
      for (const month of fs.readdirSync(ARCHIVE_DIR)) {
        const monthPath = path.join(ARCHIVE_DIR, month);
        if (!fs.statSync(monthPath).isDirectory()) continue;
        for (const file of fs.readdirSync(monthPath)) {
          if (!file.endsWith('.tar.gz')) continue;
          const stat = fs.statSync(path.join(monthPath, file));
          bundles.push({
            path: `archive/${month}/${file}`,
            size: stat.size,
            created: stat.mtime.toISOString(),
          });
        }
      }
    }

    return c.json({
      archived_files: archived.count,
      original_size_bytes: archived.original_size,
      pending_archive: pending.count,
      pending_size_bytes: pending.total_size,
      grace_days: FILE_ARCHIVE_GRACE_DAYS,
      bundles,
    });
  });

  // POST /api/files/archive/run — manual trigger
  app.post('/api/files/archive/run', (c) => {
    runFileArchive();
    return c.json({ status: 'ok', message: 'Archive cycle completed' });
  });

  // POST /api/files/:id/restore — restore an archived file
  app.post('/api/files/:id/restore', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const file = sqlite.prepare('SELECT * FROM files WHERE id = ?').get(id) as any;
    if (!file) return c.json({ error: 'File not found' }, 404);
    if (!file.deleted_at) return c.json({ error: 'File is not deleted' }, 400);

    if (file.archived_at && file.archive_path) {
      // Extract from archive
      const archiveFullPath = path.join(UPLOADS_DIR, file.archive_path);
      if (!fs.existsSync(archiveFullPath)) {
        return c.json({ error: 'Archive bundle not found on disk' }, 500);
      }

      try {
        const { execSync } = require('child_process');
        execSync(`tar -xzf "${archiveFullPath}" -C "${UPLOADS_DIR}" "${file.filename}"`, {
          timeout: 30_000,
        });
      } catch (err) {
        return c.json({ error: 'Failed to extract file from archive', details: String(err) }, 500);
      }

      if (!fs.existsSync(path.join(UPLOADS_DIR, file.filename))) {
        return c.json({ error: 'File not found in archive bundle' }, 500);
      }
    } else {
      // File was only soft-deleted, not archived — check it still exists
      if (!fs.existsSync(path.join(UPLOADS_DIR, file.filename))) {
        return c.json({ error: 'File not found on disk' }, 500);
      }
    }

    // Clear deleted_at and archived_at
    sqlite.prepare('UPDATE files SET deleted_at = NULL, archived_at = NULL, archive_path = NULL WHERE id = ?').run(id);
    return c.json({ restored: true, id, filename: file.filename, original_name: file.original_name });
  });
}
