import fs from 'fs';
import path from 'path';
import { createHmac, createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';
import { logSecurityEvent } from '../server/security-logger.ts';

// ============================================================================
// Module-level state for Withings auto-sync daemon
// ============================================================================

let moduleSqlite: Database | null = null;
let integrationsStarted = false;

// Withings auto-sync interval (T#523)
const WITHINGS_SYNC_INTERVAL = 60 * 60 * 1000; // 1 hour

// runWithingsAutoSync (daemon) — uses moduleSqlite + integration helpers from inside the register fn.
// We forward-declare via closure: the register fn assigns the helper function to runWithingsAutoSync.
let runWithingsAutoSync: () => Promise<void> = async () => {};

// ============================================================================
// initIntegrations — server startup: capture sqlite + start auto-sync daemon
// ============================================================================

export function initIntegrations(sqliteDb: Database): void {
  moduleSqlite = sqliteDb;
  if (integrationsStarted) return;
  integrationsStarted = true;
  setTimeout(runWithingsAutoSync, 60_000);
  setInterval(runWithingsAutoSync, WITHINGS_SYNC_INTERVAL);
  console.log('[Withings] Auto-sync enabled (1h interval, first run in 60s)');
}

// ============================================================================
// registerIntegrationsRoutes — Withings OAuth + Google OAuth + Gmail proxy
// All constants, helpers, state Maps, and routes live inside the register fn
// (closure-captured sqlite for type safety).
// ============================================================================

interface IntegrationsHelpers {
  hasSessionAuth: (c: Context) => boolean;
  isTrustedRequest: (c: Context) => boolean;
  isForgeAuthorized: (c: any, options?: { mode: 'read' | 'write' }) => boolean;
}

export function registerIntegrationsRoutes(app: OpenAPIHono, sqliteDb: Database, helpers: IntegrationsHelpers): void {
  const { hasSessionAuth, isTrustedRequest, isForgeAuthorized } = helpers;
  const sqlite: Database = sqliteDb;
  // Drop-in: integ_block (constants + helpers + state Maps + routes)
  // AES-256-GCM encryption for OAuth tokens
  const OAUTH_KEY = process.env.OAUTH_ENCRYPTION_KEY; // 32-byte hex string
  const WITHINGS_CLIENT_ID = process.env.WITHINGS_CLIENT_ID || '';
  const WITHINGS_CLIENT_SECRET = process.env.WITHINGS_CLIENT_SECRET || '';
  const WITHINGS_REDIRECT_URI = process.env.WITHINGS_REDIRECT_URI || 'https://denbook.online/api/oauth/withings/callback';

  function encryptToken(token: string): { encrypted: string; iv: string; tag: string } {
    if (!OAUTH_KEY) throw new Error('OAUTH_ENCRYPTION_KEY not set');
    const key = Buffer.from(OAUTH_KEY, 'hex');
    const iv = require('crypto').randomBytes(12);
    const cipher = require('crypto').createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(token, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag().toString('hex');
    return { encrypted, iv: iv.toString('hex'), tag };
  }

  function decryptToken(encrypted: string, ivHex: string, tagHex: string): string {
    if (!OAUTH_KEY) throw new Error('OAUTH_ENCRYPTION_KEY not set');
    const key = Buffer.from(OAUTH_KEY, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const decipher = require('crypto').createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  }

  // Generate HMAC-SHA256 signature for Withings API
  function withingsSign(data: string): string {
    return createHmac('sha256', WITHINGS_CLIENT_SECRET).update(data).digest('hex');
  }

  // Get Withings nonce (required for signed requests)
  async function getWithingsNonce(): Promise<string> {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = withingsSign(`getnonce,${WITHINGS_CLIENT_ID},${timestamp}`);
    const res = await fetch('https://wbsapi.withings.net/v2/signature', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ action: 'getnonce', client_id: WITHINGS_CLIENT_ID, timestamp: String(timestamp), signature }),
    });
    const data = await res.json() as any;
    if (data.status !== 0) throw new Error(`Nonce failed: ${data.error}`);
    return data.body.nonce;
  }

  // Refresh Withings tokens if needed
  async function ensureFreshWithingsToken(): Promise<{ accessToken: string; userId: string } | null> {
    const token = sqlite.prepare("SELECT * FROM oauth_tokens WHERE provider = 'withings' LIMIT 1").get() as any;
    if (!token) return null;

    const now = Math.floor(Date.now() / 1000);
    if (token.expires_at > now + 600) {
      // Token still fresh (>10 min remaining)
      return { accessToken: decryptToken(token.access_token_enc, token.access_iv || token.token_iv, token.access_tag || token.token_tag), userId: token.user_id };
    }

    // Refresh token
    try {
      const refreshToken = decryptToken(token.refresh_token_enc, token.refresh_iv || token.token_iv, token.refresh_tag || token.token_tag);
      const nonce = await getWithingsNonce();
      const signature = withingsSign(`requesttoken,${WITHINGS_CLIENT_ID},${nonce}`);
      const res = await fetch('https://wbsapi.withings.net/v2/oauth2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          action: 'requesttoken', grant_type: 'refresh_token',
          client_id: WITHINGS_CLIENT_ID, client_secret: WITHINGS_CLIENT_SECRET,
          refresh_token: refreshToken, nonce, signature,
        }),
      });
      const data = await res.json() as any;
      if (data.status !== 0) throw new Error(`Refresh failed: ${data.error}`);

      const { access_token, refresh_token, expires_in, userid } = data.body;
      const enc = encryptToken(access_token);
      const refreshEnc = encryptToken(refresh_token);
      sqlite.prepare(
        `UPDATE oauth_tokens SET access_token_enc = ?, refresh_token_enc = ?, access_iv = ?, access_tag = ?, refresh_iv = ?, refresh_tag = ?,
         expires_at = ?, user_id = ?, updated_at = ? WHERE id = ?`
      ).run(enc.encrypted, refreshEnc.encrypted, enc.iv, enc.tag, refreshEnc.iv, refreshEnc.tag, now + expires_in, userid, now, token.id);

      logSecurityEvent({
        eventType: 'token_refreshed',
        severity: 'info',
        actor: 'system',
        actorType: 'system',
        target: 'oauth:withings',
        details: { provider: 'withings', user_id: userid },
      });

      return { accessToken: access_token, userId: userid };
    } catch (err) {
      console.error('[Withings] Token refresh failed:', err);
      return null;
    }
  }

  // CSRF state storage (in-memory, short-lived)
  const oauthStates = new Map<string, number>();

  // GET /api/oauth/withings/authorize — start OAuth flow
  app.get('/api/oauth/withings/authorize', (c) => {
    if (!hasSessionAuth(c)) return c.json({ error: 'Gorn authentication required' }, 403);
    if (!WITHINGS_CLIENT_ID) return c.json({ error: 'Withings not configured (missing WITHINGS_CLIENT_ID)' }, 500);

    const state = require('crypto').randomBytes(16).toString('hex');
    oauthStates.set(state, Date.now());
    // Clean old states (>10 min)
    for (const [k, v] of oauthStates) { if (Date.now() - v > 600000) oauthStates.delete(k); }

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: WITHINGS_CLIENT_ID,
      scope: 'user.info,user.metrics',
      redirect_uri: WITHINGS_REDIRECT_URI,
      state,
    });
    return c.redirect(`https://account.withings.com/oauth2_user/authorize2?${params}`);
  });

  // GET /api/oauth/withings/callback — handle OAuth callback
  app.get('/api/oauth/withings/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const error = c.req.query('error');

    if (error) return c.redirect('/forge?oauth_error=' + encodeURIComponent(error));
    if (!code || !state) return c.json({ error: 'Missing code or state' }, 400);
    if (!oauthStates.has(state)) return c.json({ error: 'Invalid or expired state (CSRF check failed)' }, 403);
    oauthStates.delete(state);

    try {
      // Exchange code for tokens
      const nonce = await getWithingsNonce();
      const signature = withingsSign(`requesttoken,${WITHINGS_CLIENT_ID},${nonce}`);
      const res = await fetch('https://wbsapi.withings.net/v2/oauth2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          action: 'requesttoken', grant_type: 'authorization_code',
          client_id: WITHINGS_CLIENT_ID, client_secret: WITHINGS_CLIENT_SECRET,
          code, redirect_uri: WITHINGS_REDIRECT_URI, nonce, signature,
        }),
      });
      const data = await res.json() as any;
      if (data.status !== 0) return c.redirect('/forge?oauth_error=' + encodeURIComponent(data.error || 'Token exchange failed'));

      const { access_token, refresh_token, expires_in, userid, scope } = data.body;
      const now = Math.floor(Date.now() / 1000);

      // Encrypt tokens
      const accessEnc = encryptToken(access_token);
      const refreshEnc = encryptToken(refresh_token);

      // Store (upsert — replace existing Withings connection)
      sqlite.prepare("DELETE FROM oauth_tokens WHERE provider = 'withings'").run();
      sqlite.prepare(
        `INSERT INTO oauth_tokens (provider, user_id, access_token_enc, refresh_token_enc, access_iv, access_tag, refresh_iv, refresh_tag, expires_at, scopes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('withings', String(userid), accessEnc.encrypted, refreshEnc.encrypted, accessEnc.iv, accessEnc.tag, refreshEnc.iv, refreshEnc.tag, now + expires_in, scope || 'user.info,user.metrics', now, now);

      logSecurityEvent({
        eventType: 'token_created',
        severity: 'info',
        actor: 'gorn',
        actorType: 'human',
        target: 'oauth:withings',
        details: { provider: 'withings', user_id: String(userid) },
      });

      // Subscribe to webhook for weight/body composition (appli=1)
      try {
        await fetch('https://wbsapi.withings.net/notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${access_token}` },
          body: new URLSearchParams({ action: 'subscribe', callbackurl: WITHINGS_REDIRECT_URI.replace('/callback', '').replace('/api/oauth/withings', '/api/webhooks/withings'), appli: '1' }),
        });
      } catch { /* webhook subscription failure is non-critical */ }

      return c.redirect('/forge?withings=connected');
    } catch (err) {
      console.error('[Withings] OAuth callback error:', err);
      return c.redirect('/forge?oauth_error=callback_failed');
    }
  });

  // GET /api/oauth/withings/status — connection status
  app.get('/api/oauth/withings/status', (c) => {
    if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge access required' }, 403);
    const token = sqlite.prepare("SELECT provider, user_id, expires_at, scopes, updated_at FROM oauth_tokens WHERE provider = 'withings' LIMIT 1").get() as any;
    if (!token) return c.json({ connected: false });
    const now = Math.floor(Date.now() / 1000);
    // Last successful sync time — use in-memory tracker (updated every sync, even with 0 new records)
    // Fall back to DB created_at for first load after server restart (T#536)
    let lastSync = withingsLastSyncAt;
    if (!lastSync) {
      const lastSyncRow = sqlite.prepare(
        "SELECT MAX(created_at) as sync_time FROM routine_logs WHERE source = 'withings' AND deleted_at IS NULL"
      ).get() as any;
      lastSync = lastSyncRow?.sync_time || null;
    }
    return c.json({
      connected: true,
      userId: token.user_id,
      tokenExpired: token.expires_at < now,
      lastUpdated: new Date(token.updated_at * 1000).toISOString(),
      lastSync,
      scopes: token.scopes,
    });
  });

  // GET /api/withings/devices — proxy to Withings device list (T#478)
  app.get('/api/withings/devices', async (c) => {
    if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Forge access required' }, 403);
    try {
      const tokenData = await ensureFreshWithingsToken();
      if (!tokenData) return c.json({ error: 'Withings not connected' }, 400);
      const res = await fetch('https://wbsapi.withings.net/v2/user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${tokenData.accessToken}` },
        body: new URLSearchParams({ action: 'getdevice' }),
      });
      const data = await res.json() as any;
      if (data.status !== 0) return c.json({ error: data.error || `Withings API error: ${data.status}` }, 502);
      return c.json({ devices: data.body?.devices || [] });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to fetch devices' }, 500);
    }
  });

  // DELETE /api/oauth/withings/disconnect — revoke connection
  app.delete('/api/oauth/withings/disconnect', async (c) => {
    if (!hasSessionAuth(c)) return c.json({ error: 'Gorn authentication required' }, 403);
    // Revoke webhook if possible
    try {
      const tokenData = await ensureFreshWithingsToken();
      if (tokenData) {
        await fetch('https://wbsapi.withings.net/notify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${tokenData.accessToken}` },
          body: new URLSearchParams({ action: 'revoke', callbackurl: WITHINGS_REDIRECT_URI.replace('/callback', '').replace('/api/oauth/withings', '/api/webhooks/withings'), appli: '1' }),
        });
      }
    } catch { /* best effort */ }
    sqlite.prepare("DELETE FROM oauth_tokens WHERE provider = 'withings'").run();
    const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
    logSecurityEvent({
      eventType: 'token_revoked',
      severity: 'info',
      actor: 'gorn',
      actorType: 'human',
      target: 'oauth:withings',
      details: { provider: 'withings' },
      ipSource: ip,
      requestId: (c.get as any)('requestId'),
    });
    return c.json({ disconnected: true });
  });

  // Withings measurement type mapping
  const WITHINGS_MEASTYPES: Record<number, string> = {
    1: 'weight', 5: 'fat_free_mass', 6: 'body_fat_pct', 8: 'fat_mass',
    9: 'diastolic', 10: 'systolic',
    76: 'muscle_mass', 77: 'hydration', 88: 'bone_mass', 170: 'visceral_fat',
  };

  // Fetch and store Withings measurements for a date range
  async function syncWithingsMeasurements(startdate: number, enddate: number): Promise<{ synced: number; skipped: number }> {
    const tokenData = await ensureFreshWithingsToken();
    if (!tokenData) throw new Error('No Withings connection');

    const params: Record<string, string> = {
      action: 'getmeas',
      meastypes: '1,5,6,8,9,10,76,77,88,170',
      category: '1',
    };
    if (startdate) params.startdate = String(startdate);
    if (enddate) params.enddate = String(enddate);

    const res = await fetch('https://wbsapi.withings.net/measure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${tokenData.accessToken}` },
      body: new URLSearchParams(params),
    });
    const data = await res.json() as any;
    if (data.status !== 0) throw new Error(`Withings API error: ${data.error || data.status}`);

    const measuregrps = data.body?.measuregrps || [];
    let synced = 0, skipped = 0;

    for (const grp of measuregrps) {
      const grpid = grp.grpid;
      // Dedup by withings_grpid (check both weight and measurement types)
      const existing = sqlite.prepare("SELECT id FROM routine_logs WHERE source = 'withings' AND json_extract(data, '$.withings_grpid') = ? AND deleted_at IS NULL LIMIT 1").get(grpid);
      if (existing) { skipped++; continue; }

      const measurements: Record<string, number> = {};
      for (const m of grp.measures || []) {
        const field = WITHINGS_MEASTYPES[m.type];
        if (field) {
          measurements[field] = Math.round(m.value * Math.pow(10, m.unit) * 100) / 100;
        }
      }
      if (Object.keys(measurements).length === 0) continue;

      const loggedAt = new Date(grp.date * 1000).toISOString();
      const now = new Date().toISOString();

      // Store BP as 'blood_pressure' type (Prowl #80 — Omron→Apple Health→Withings path)
      if (measurements.systolic !== undefined || measurements.diastolic !== undefined) {
        const bpData = JSON.stringify({
          systolic: measurements.systolic,
          diastolic: measurements.diastolic,
          source: 'withings',
          withings_grpid: grpid,
        });
        sqlite.prepare(
          'INSERT INTO routine_logs (type, logged_at, data, source, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run('blood_pressure', loggedAt, bpData, 'withings', now);
        delete measurements.systolic;
        delete measurements.diastolic;
      }

      // Store weight as 'weight' type so Forge chart picks it up
      if (measurements.weight) {
        const weightData = JSON.stringify({ value: measurements.weight, unit: 'kg', source: 'withings', withings_grpid: grpid });
        sqlite.prepare(
          'INSERT INTO routine_logs (type, logged_at, data, source, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run('weight', loggedAt, weightData, 'withings', now);
      }

      // Store full body composition as 'measurement' type (only if body-comp fields remain)
      const bodyCompKeys = Object.keys(measurements);
      if (bodyCompKeys.length > 0 && (bodyCompKeys.length > 1 || !measurements.weight)) {
        const logData = JSON.stringify({ ...measurements, withings_grpid: grpid });
        sqlite.prepare(
          'INSERT INTO routine_logs (type, logged_at, data, source, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run('measurement', loggedAt, logData, 'withings', now);
      }
      synced++;
    }

    withingsLastSyncAt = new Date().toISOString(); // Track last successful sync (T#536)
    console.log(`[Withings] Synced ${synced} measurements, skipped ${skipped} duplicates`);
    return { synced, skipped };
  }

  // POST /api/webhooks/withings — receive Withings push notifications (T#415)
  app.post('/api/webhooks/withings', async (c) => {
    // Withings requires 200 response within 2 seconds — respond first, sync async
    const body = await c.req.parseBody();
    const userid = String(body.userid || '');
    const appli = String(body.appli || '');
    const startdate = parseInt(String(body.startdate || '0'), 10);
    const enddate = parseInt(String(body.enddate || '0'), 10);

    console.log(`[Withings] Webhook received: userid=${userid} appli=${appli} startdate=${startdate} enddate=${enddate}`);

    // Validate userid matches stored token
    const token = sqlite.prepare("SELECT user_id FROM oauth_tokens WHERE provider = 'withings' LIMIT 1").get() as any;
    if (!token || token.user_id !== userid) {
      console.log(`[Withings] Webhook rejected: unknown userid ${userid}`);
      return c.text('OK', 200); // Still return 200 to avoid Withings retries
    }

    // Handle body comp (appli=1) + blood pressure (appli=4, Prowl #80)
    if (appli !== '1' && appli !== '4') {
      return c.text('OK', 200);
    }

    // Async sync — don't block the 200 response
    syncWithingsMeasurements(startdate, enddate).catch(err => {
      console.error('[Withings] Async sync failed:', err);
    });

    return c.text('OK', 200);
  });

  // POST /api/oauth/withings/sync — manual sync trigger (T#415)
  app.post('/api/oauth/withings/sync', async (c) => {
    if (!isForgeAuthorized(c, { mode: 'write' })) return c.json({ error: 'Forge access required' }, 403);

    const token = sqlite.prepare("SELECT * FROM oauth_tokens WHERE provider = 'withings' LIMIT 1").get() as any;
    if (!token) return c.json({ error: 'Withings not connected' }, 400);

    try {
      // Get last sync time from most recent Withings log
      const lastLog = sqlite.prepare(
        "SELECT logged_at FROM routine_logs WHERE source = 'withings' AND deleted_at IS NULL ORDER BY logged_at DESC LIMIT 1"
      ).get() as any;

      const now = Math.floor(Date.now() / 1000);
      const full = c.req.query('full') === 'true';
      // Full sync: from 2010 (earliest Withings scales); incremental: from last entry or 30 days
      const startdate = full
        ? 1262304000 // 2010-01-01
        : lastLog
          ? Math.floor(new Date(lastLog.logged_at).getTime() / 1000)
          : now - 30 * 86400;

      const result = await syncWithingsMeasurements(startdate, now);
      return c.json({ success: true, ...result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : 'Sync failed' }, 500);
    }
  });

  // ============================================================================
  // Google OAuth Integration (T#541, Spec #30)
  // ============================================================================

  const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
  const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
  const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'https://denbook.online/api/oauth/google/callback';
  const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/gmail.readonly';

  // PKCE state storage (in-memory, short-lived) — stores state → { timestamp, codeVerifier }
  const googleOauthStates = new Map<string, { ts: number; codeVerifier: string }>();

  // Google access control — Beast allowlist
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS google_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      beast TEXT NOT NULL UNIQUE,
      scopes TEXT NOT NULL,
      granted_by TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  // Google audit log
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS google_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      beast TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      query TEXT,
      message_id TEXT,
      created_at INTEGER NOT NULL
    )
  `);

  // Rate limiting — per-Beast request tracking (in-memory)
  const googleRateLimits = new Map<string, number[]>();
  const GOOGLE_RATE_LIMIT = 30; // requests per minute per Beast

  function checkGoogleRateLimit(beast: string): boolean {
    const now = Date.now();
    const oneMinAgo = now - 60000;
    const timestamps = (googleRateLimits.get(beast) || []).filter(t => t > oneMinAgo);
    if (timestamps.length >= GOOGLE_RATE_LIMIT) return false;
    timestamps.push(now);
    googleRateLimits.set(beast, timestamps);
    return true;
  }

  // PKCE helpers
  function generateCodeVerifier(): string {
    return require('crypto').randomBytes(32).toString('base64url'); // 43 chars
  }

  function generateCodeChallenge(verifier: string): string {
    return require('crypto').createHash('sha256').update(verifier).digest('base64url');
  }

  // Refresh Google tokens if needed
  async function ensureFreshGoogleToken(): Promise<{ accessToken: string; userId: string } | null> {
    const token = sqlite.prepare("SELECT * FROM oauth_tokens WHERE provider = 'google' LIMIT 1").get() as any;
    if (!token) return null;

    const now = Math.floor(Date.now() / 1000);
    if (token.expires_at > now + 600) {
      return { accessToken: decryptToken(token.access_token_enc, token.access_iv || token.token_iv, token.access_tag || token.token_tag), userId: token.user_id };
    }

    // Refresh — Google does NOT rotate refresh tokens
    try {
      const refreshToken = decryptToken(token.refresh_token_enc, token.refresh_iv || token.token_iv, token.refresh_tag || token.token_tag);
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
      });
      const data = await res.json() as any;
      if (data.error) throw new Error(`Refresh failed: ${data.error}`);

      const { access_token, expires_in } = data;
      const enc = encryptToken(access_token);
      // Google keeps same refresh token — only update access token
      sqlite.prepare(
        `UPDATE oauth_tokens SET access_token_enc = ?, access_iv = ?, access_tag = ?,
         expires_at = ?, updated_at = ? WHERE id = ?`
      ).run(enc.encrypted, enc.iv, enc.tag, now + expires_in, now, token.id);

      logSecurityEvent({
        eventType: 'token_refreshed',
        severity: 'info',
        actor: 'system',
        actorType: 'system',
        target: 'oauth:google',
        details: { provider: 'google', user_id: token.user_id },
      });

      return { accessToken: access_token, userId: token.user_id };
    } catch (err) {
      console.error('[Google] Token refresh failed:', err);
      return null;
    }
  }

  // Google access control middleware
  function checkGoogleAccess(beast: string, requiredScope: string = 'gmail.readonly'): { allowed: boolean; error?: string; status?: number } {
    const access = sqlite.prepare("SELECT scopes FROM google_access WHERE beast = ?").get(beast) as any;
    if (!access) return { allowed: false, error: 'Not authorized for Google access', status: 401 };
    const scopes = access.scopes.split(',').map((s: string) => s.trim());
    if (!scopes.includes(requiredScope)) return { allowed: false, error: 'Insufficient Google scope', status: 403 };
    return { allowed: true };
  }

  // Log Google API access
  function logGoogleAccess(beast: string, endpoint: string, query?: string, messageId?: string) {
    const now = Math.floor(Date.now() / 1000);
    sqlite.prepare("INSERT INTO google_audit_log (beast, endpoint, query, message_id, created_at) VALUES (?, ?, ?, ?, ?)").run(beast, endpoint, query || null, messageId || null, now);
  }

  // Wrap email content with untrusted boundary tags (prompt injection defense)
  function tagUntrustedContent(content: string, maxLength: number = 50000): string {
    const truncated = content.length > maxLength ? content.substring(0, maxLength) + '\n[... truncated at 50KB]' : content;
    return `--- BEGIN UNTRUSTED EMAIL CONTENT ---\n${truncated}\n--- END UNTRUSTED EMAIL CONTENT ---`;
  }

  // Sanitize email metadata fields (prompt injection defense)
  function sanitizeMetadata(value: string | undefined, maxLength: number): string {
    if (!value) return '';
    return value.substring(0, maxLength);
  }

  // GET /api/oauth/google/authorize — start OAuth flow with PKCE
  app.get('/api/oauth/google/authorize', (c) => {
    if (!hasSessionAuth(c)) return c.json({ error: 'Gorn authentication required' }, 403);
    if (!GOOGLE_CLIENT_ID) return c.json({ error: 'Google not configured (missing GOOGLE_CLIENT_ID)' }, 500);

    // CSRF state + PKCE code verifier
    const state = require('crypto').randomBytes(16).toString('hex');
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    googleOauthStates.set(state, { ts: Date.now(), codeVerifier });
    // Clean old states (>10 min)
    for (const [k, v] of googleOauthStates) { if (Date.now() - v.ts > 600000) googleOauthStates.delete(k); }

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: GOOGLE_REDIRECT_URI,
      scope: GOOGLE_SCOPES,
      state,
      access_type: 'offline',
      prompt: 'consent', // Ensures refresh token is always returned
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    console.log('[Google] OAuth flow initiated');
    return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  });

  // GET /api/oauth/google/callback — handle OAuth callback with PKCE
  app.get('/api/oauth/google/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    const error = c.req.query('error');

    if (error) return c.redirect('/settings?oauth_error=' + encodeURIComponent(error));
    if (!code || !state) return c.json({ error: 'Missing code or state' }, 400);

    const stateData = googleOauthStates.get(state);
    if (!stateData) return c.json({ error: 'Invalid or expired state (CSRF check failed)' }, 403);
    googleOauthStates.delete(state);

    try {
      // Exchange code for tokens with PKCE code_verifier
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: GOOGLE_REDIRECT_URI,
          grant_type: 'authorization_code',
          code_verifier: stateData.codeVerifier,
        }),
      });
      const data = await res.json() as any;
      if (data.error) return c.redirect('/settings?oauth_error=' + encodeURIComponent(data.error_description || data.error));

      const { access_token, refresh_token, expires_in, scope } = data;
      if (!refresh_token) return c.redirect('/settings?oauth_error=' + encodeURIComponent('No refresh token returned — try disconnecting from Google and reconnecting'));

      const now = Math.floor(Date.now() / 1000);

      // Get user email from Google userinfo
      let userEmail = 'unknown';
      try {
        const infoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${access_token}` },
        });
        const info = await infoRes.json() as any;
        userEmail = info.email || 'unknown';
      } catch { /* non-critical */ }

      // Encrypt tokens
      const accessEnc = encryptToken(access_token);
      const refreshEnc = encryptToken(refresh_token);

      // Store (upsert — replace existing Google connection)
      sqlite.prepare("DELETE FROM oauth_tokens WHERE provider = 'google'").run();
      sqlite.prepare(
        `INSERT INTO oauth_tokens (provider, user_id, access_token_enc, refresh_token_enc, access_iv, access_tag, refresh_iv, refresh_tag, expires_at, scopes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run('google', userEmail, accessEnc.encrypted, refreshEnc.encrypted, accessEnc.iv, accessEnc.tag, refreshEnc.iv, refreshEnc.tag, now + expires_in, scope || GOOGLE_SCOPES, now, now);

      logSecurityEvent({
        eventType: 'token_created',
        severity: 'info',
        actor: 'gorn',
        actorType: 'human',
        target: 'oauth:google',
        details: { provider: 'google', user_id: userEmail },
      });

      console.log(`[Google] OAuth connected: ${userEmail}`);
      return c.redirect('/settings?google=connected');
    } catch (err) {
      console.error('[Google] OAuth callback error:', err);
      return c.redirect('/settings?oauth_error=callback_failed');
    }
  });

  // GET /api/oauth/google/status — connection status
  app.get('/api/oauth/google/status', (c) => {
    if (!isForgeAuthorized(c, { mode: 'read' })) return c.json({ error: 'Authentication required' }, 403);
    const token = sqlite.prepare("SELECT provider, user_id, expires_at, scopes, updated_at FROM oauth_tokens WHERE provider = 'google' LIMIT 1").get() as any;
    if (!token) return c.json({ connected: false });
    const now = Math.floor(Date.now() / 1000);
    return c.json({
      connected: true,
      email: token.user_id,
      tokenExpired: token.expires_at < now,
      lastUpdated: new Date(token.updated_at * 1000).toISOString(),
      scopes: token.scopes,
    });
  });

  // DELETE /api/oauth/google/disconnect — revoke and delete
  app.delete('/api/oauth/google/disconnect', async (c) => {
    if (!hasSessionAuth(c)) return c.json({ error: 'Gorn authentication required' }, 403);
    // Revoke at Google
    try {
      const tokenData = await ensureFreshGoogleToken();
      if (tokenData) {
        await fetch('https://oauth2.googleapis.com/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: tokenData.accessToken }),
        });
        console.log('[Google] Token revoked at Google');
      }
    } catch { /* best effort */ }
    sqlite.prepare("DELETE FROM oauth_tokens WHERE provider = 'google'").run();
    const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
    logSecurityEvent({
      eventType: 'token_revoked',
      severity: 'info',
      actor: 'gorn',
      actorType: 'human',
      target: 'oauth:google',
      details: { provider: 'google' },
      ipSource: ip,
      requestId: (c.get as any)('requestId'),
    });
    return c.json({ disconnected: true });
  });

  // --- Google Access Management (Gorn-only) ---

  // GET /api/google/access — list allowed Beasts
  app.get('/api/google/access', (c) => {
    if (!hasSessionAuth(c)) return c.json({ error: 'Gorn authentication required' }, 403);
    const rows = sqlite.prepare("SELECT beast, scopes, granted_by, created_at FROM google_access ORDER BY created_at").all();
    return c.json({ access: rows });
  });

  // POST /api/google/access — grant Beast access
  app.post('/api/google/access', async (c) => {
    if (!hasSessionAuth(c)) return c.json({ error: 'Gorn authentication required' }, 403);
    const body = await c.req.json() as any;
    const { beast, scopes } = body;
    if (!beast || !scopes) return c.json({ error: 'Missing beast or scopes' }, 400);
    const now = Math.floor(Date.now() / 1000);
    try {
      sqlite.prepare("INSERT OR REPLACE INTO google_access (beast, scopes, granted_by, created_at) VALUES (?, ?, 'gorn', ?)").run(beast.toLowerCase(), scopes, now);
      console.log(`[Google] Access granted: ${beast} (${scopes})`);
      return c.json({ granted: true, beast, scopes });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to grant access' }, 500);
    }
  });

  // DELETE /api/google/access/:beast — revoke Beast access
  app.delete('/api/google/access/:beast', (c) => {
    if (!hasSessionAuth(c)) return c.json({ error: 'Gorn authentication required' }, 403);
    const beast = c.req.param('beast').toLowerCase();
    sqlite.prepare("DELETE FROM google_access WHERE beast = ?").run(beast);
    console.log(`[Google] Access revoked: ${beast}`);
    return c.json({ revoked: true, beast });
  });

  // GET /api/google/audit — view audit log (Gorn-only)
  app.get('/api/google/audit', (c) => {
    if (!hasSessionAuth(c)) return c.json({ error: 'Gorn authentication required' }, 403);
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
    const offset = parseInt(c.req.query('offset') || '0');
    const rows = sqlite.prepare("SELECT * FROM google_audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset);
    const total = (sqlite.prepare("SELECT COUNT(*) as count FROM google_audit_log").get() as any).count;
    return c.json({ logs: rows, total });
  });

  // --- Gmail API Proxy Endpoints ---

  // Helper: resolve Beast identity from request
  function getGmailBeast(c: any): string | null {
    // Browser session = gorn
    if (hasSessionAuth(c)) return 'gorn';
    // Beast API access via ?as= param
    if (isTrustedRequest(c)) {
      const as = (c.req.query('as') || '').toLowerCase();
      return as || null;
    }
    return null;
  }

  // GET /api/google/gmail/profile — email profile
  app.get('/api/google/gmail/profile', async (c) => {
    const beast = getGmailBeast(c);
    if (!beast) return c.json({ error: 'Authentication required' }, 401);
    const access = checkGoogleAccess(beast);
    if (!access.allowed) return c.json({ error: access.error }, access.status as 401 | 403);
    if (!checkGoogleRateLimit(beast)) return c.json({ error: 'Rate limit exceeded (30/min)' }, 429);

    try {
      const tokenData = await ensureFreshGoogleToken();
      if (!tokenData) return c.json({ error: 'Google not connected' }, 401);

      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
        headers: { Authorization: `Bearer ${tokenData.accessToken}` },
      });
      const data = await res.json() as any;
      if (!res.ok) return c.json({ error: data.error?.message || `Gmail API error: ${res.status}` }, 502);

      logGoogleAccess(beast, '/api/google/gmail/profile');
      return c.json(data);
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to fetch profile' }, 500);
    }
  });

  // GET /api/google/gmail/labels — list labels
  app.get('/api/google/gmail/labels', async (c) => {
    const beast = getGmailBeast(c);
    if (!beast) return c.json({ error: 'Authentication required' }, 401);
    const access = checkGoogleAccess(beast);
    if (!access.allowed) return c.json({ error: access.error }, access.status as 401 | 403);
    if (!checkGoogleRateLimit(beast)) return c.json({ error: 'Rate limit exceeded (30/min)' }, 429);

    try {
      const tokenData = await ensureFreshGoogleToken();
      if (!tokenData) return c.json({ error: 'Google not connected' }, 401);

      const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/labels', {
        headers: { Authorization: `Bearer ${tokenData.accessToken}` },
      });
      const data = await res.json() as any;
      if (!res.ok) return c.json({ error: data.error?.message || `Gmail API error: ${res.status}` }, 502);

      logGoogleAccess(beast, '/api/google/gmail/labels');
      return c.json(data);
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to fetch labels' }, 500);
    }
  });

  // GET /api/google/gmail/messages — list messages
  app.get('/api/google/gmail/messages', async (c) => {
    const beast = getGmailBeast(c);
    if (!beast) return c.json({ error: 'Authentication required' }, 401);
    const access = checkGoogleAccess(beast);
    if (!access.allowed) return c.json({ error: access.error }, access.status as 401 | 403);
    if (!checkGoogleRateLimit(beast)) return c.json({ error: 'Rate limit exceeded (30/min)' }, 429);

    try {
      const tokenData = await ensureFreshGoogleToken();
      if (!tokenData) return c.json({ error: 'Google not connected' }, 401);

      const q = c.req.query('q') || '';
      const maxResults = Math.min(parseInt(c.req.query('maxResults') || '20'), 100);
      const pageToken = c.req.query('pageToken') || '';
      const labelIds = c.req.query('labelIds') || '';

      const params = new URLSearchParams({ maxResults: String(maxResults) });
      if (q) params.set('q', q);
      if (pageToken) params.set('pageToken', pageToken);
      if (labelIds) labelIds.split(',').forEach(id => params.append('labelIds', id.trim()));

      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, {
        headers: { Authorization: `Bearer ${tokenData.accessToken}` },
      });
      const data = await res.json() as any;
      if (!res.ok) return c.json({ error: data.error?.message || `Gmail API error: ${res.status}` }, 502);

      logGoogleAccess(beast, '/api/google/gmail/messages', q || undefined);
      return c.json(data);
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to fetch messages' }, 500);
    }
  });

  // GET /api/google/gmail/messages/:id — read a single message
  app.get('/api/google/gmail/messages/:id', async (c) => {
    const beast = getGmailBeast(c);
    if (!beast) return c.json({ error: 'Authentication required' }, 401);
    const access = checkGoogleAccess(beast);
    if (!access.allowed) return c.json({ error: access.error }, access.status as 401 | 403);
    if (!checkGoogleRateLimit(beast)) return c.json({ error: 'Rate limit exceeded (30/min)' }, 429);

    const messageId = c.req.param('id');

    try {
      const tokenData = await ensureFreshGoogleToken();
      if (!tokenData) return c.json({ error: 'Google not connected' }, 401);

      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`, {
        headers: { Authorization: `Bearer ${tokenData.accessToken}` },
      });
      const data = await res.json() as any;
      if (!res.ok) return c.json({ error: data.error?.message || `Gmail API error: ${res.status}` }, 502);

      // Parse message into clean format — text only, no HTML (XSS prevention per Bertus)
      const headers = data.payload?.headers || [];
      const getHeader = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      // Extract plain text body from MIME parts
      let textBody = '';
      function extractText(part: any) {
        if (part.mimeType === 'text/plain' && part.body?.data) {
          textBody += Buffer.from(part.body.data, 'base64url').toString('utf8');
        }
        if (part.parts) part.parts.forEach(extractText);
      }
      if (data.payload) extractText(data.payload);

      const formatted = {
        id: data.id,
        threadId: data.threadId,
        snippet: sanitizeMetadata(data.snippet, 500),
        from: sanitizeMetadata(getHeader('From'), 200),
        to: sanitizeMetadata(getHeader('To'), 200),
        subject: sanitizeMetadata(getHeader('Subject'), 500),
        date: getHeader('Date'),
        labels: data.labelIds || [],
        body: {
          text: tagUntrustedContent(textBody),
        },
      };

      logGoogleAccess(beast, '/api/google/gmail/messages/:id', undefined, messageId);
      return c.json(formatted);
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to fetch message' }, 500);
    }
  });

  // GET /api/google/gmail/threads/:id — read a thread
  app.get('/api/google/gmail/threads/:id', async (c) => {
    const beast = getGmailBeast(c);
    if (!beast) return c.json({ error: 'Authentication required' }, 401);
    const access = checkGoogleAccess(beast);
    if (!access.allowed) return c.json({ error: access.error }, access.status as 401 | 403);
    if (!checkGoogleRateLimit(beast)) return c.json({ error: 'Rate limit exceeded (30/min)' }, 429);

    const threadId = c.req.param('id');

    try {
      const tokenData = await ensureFreshGoogleToken();
      if (!tokenData) return c.json({ error: 'Google not connected' }, 401);

      const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`, {
        headers: { Authorization: `Bearer ${tokenData.accessToken}` },
      });
      const data = await res.json() as any;
      if (!res.ok) return c.json({ error: data.error?.message || `Gmail API error: ${res.status}` }, 502);

      // Format each message in thread — text only, no HTML
      const messages = (data.messages || []).map((msg: any) => {
        const headers = msg.payload?.headers || [];
        const getHeader = (name: string) => headers.find((h: any) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

        let textBody = '';
        function extractText(part: any) {
          if (part.mimeType === 'text/plain' && part.body?.data) {
            textBody += Buffer.from(part.body.data, 'base64url').toString('utf8');
          }
          if (part.parts) part.parts.forEach(extractText);
        }
        if (msg.payload) extractText(msg.payload);

        return {
          id: msg.id,
          snippet: sanitizeMetadata(msg.snippet, 500),
          from: sanitizeMetadata(getHeader('From'), 200),
          to: sanitizeMetadata(getHeader('To'), 200),
          subject: sanitizeMetadata(getHeader('Subject'), 500),
          date: getHeader('Date'),
          labels: msg.labelIds || [],
          body: { text: tagUntrustedContent(textBody) },
        };
      });

      logGoogleAccess(beast, '/api/google/gmail/threads/:id', undefined, threadId);
      return c.json({ id: data.id, messages });
    } catch (err: any) {
      return c.json({ error: err?.message || 'Failed to fetch thread' }, 500);
    }
  });



  // Withings auto-sync daemon body — assigned to module-level forward-declared var.
  // initIntegrations() schedules setInterval/setTimeout against this assignment.
  // Withings daily auto-sync (T#523) — sync every 24h, first run 60s after boot
  const WITHINGS_SYNC_INTERVAL = 60 * 60 * 1000; // 1 hour
  let withingsLastSyncAt: string | null = null; // Tracks last successful sync attempt (T#536)

  async function runWithingsAutoSync() {
    try {
      const token = sqlite.prepare("SELECT * FROM oauth_tokens WHERE provider = 'withings' LIMIT 1").get() as any;
      if (!token) return; // Not connected, skip silently
      const lastLog = sqlite.prepare(
        "SELECT logged_at FROM routine_logs WHERE source = 'withings' AND deleted_at IS NULL ORDER BY logged_at DESC LIMIT 1"
      ).get() as any;
      const now = Math.floor(Date.now() / 1000);
      const startdate = lastLog
        ? Math.floor(new Date(lastLog.logged_at).getTime() / 1000)
        : now - 30 * 86400;
      const result = await syncWithingsMeasurements(startdate, now);
      console.log(`[Withings] Auto-sync: ${result.synced} new, ${result.skipped} skipped`);
    } catch (err) {
      console.error('[Withings] Auto-sync failed:', err instanceof Error ? err.message : err);
    }
  }
  // setInterval/setTimeout/console.log moved to initIntegrations() — see top.

  // ============================================================================
  // Supersede Log Routes (Issue #18, #19)
  // ============================================================================

}
