/**
 * Oracle Nightly HTTP Server - Hono.js Version
 *
 * Modern routing with Hono.js on Bun runtime.
 * Same handlers, same DB, just cleaner HTTP layer.
 */

import { type Context, type Next } from 'hono';
import { OpenAPIHono } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
import { healthRoute, authStatusRoute, authLoginRoute, authLogoutRoute, OPENAPI_INFO } from './server/openapi.ts';
import { cors } from 'hono/cors';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { createHmac, timingSafeEqual } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  configure,
  writePidFile,
  removePidFile,
  registerSignalHandlers,
  performGracefulShutdown,
} from './process-manager/index.ts';
import { getVaultPsiRoot } from './vault/handler.ts';

// Config constants (no DB dependency)
import {
  PORT,
  ORACLE_DATA_DIR,
  REPO_ROOT,
  DB_PATH,
} from './config.ts';

import { eq, desc, gt, sql } from 'drizzle-orm';
import {
  db,
  sqlite,
  closeDb,
  getSetting,
  setSetting,
  searchLog,
  learnLog,
  supersedeLog,
  indexingStatus,
  settings,
  schedule,
  getBeastProfile,
  getAllBeastProfiles,
  upsertBeastProfile,
  updateBeastAvatar,
  beastProfiles,
} from './db/index.ts';

import {
  handleSearch,
  handleReflect,
  handleList,
  handleStats,
  handleGraph,
  handleLearn,
  handleSimilar,
  handleMap,
  handleMap3d,
  handleVectorStats
} from './server/handlers.ts';

import { handleRead } from './tools/read.ts';

import {
  handleDashboardSummary,
  handleDashboardActivity,
  handleDashboardGrowth
} from './server/dashboard.ts';

import { handleContext } from './server/context.ts';
import { handleScheduleAdd, handleScheduleList } from './tools/schedule.ts';
import type { ToolContext } from './tools/types.ts';

import {
  handleThreadMessage,
  listThreads,
  getFullThread,
  getMessages,
  updateThreadStatus,
  addMessage,
} from './forum/handler.ts';


import { enqueueNotification } from './notify.ts';
import { rbacMiddleware, getGuestAllowlist } from './server/rbac.ts';
import type { Role } from './server/rbac.ts';
import { registerGovernanceRoutes } from './governance/routes.ts';
import { registerProwlRoutes } from './prowl/routes.ts';
import { registerSettingsRoutes } from './settings/routes.ts';
import { registerRemoteRoutes } from './remote/routes.ts';
import { registerQueueRoutes } from './queue/routes.ts';
import { registerSupersedeRoutes } from './supersede/routes.ts';
import { registerAuditRoutes } from './audit/routes.ts';
import { registerTeamsRoutes } from './teams/routes.ts';
import { registerFilesRoutes } from './files/routes.ts';
import { registerInboxRoutes } from './inbox/routes.ts';
import { registerKnowledgeRoutes } from './knowledge/routes.ts';
import { registerLibraryRoutes } from './library/routes.ts';
import { registerRiskRoutes } from './risk/routes.ts';
import { registerTelegramRoutes } from './telegram/routes.ts';
import { registerSearchRoutes, initSearch, searchIndexUpsert, searchIndexDelete } from './search/routes.ts';
import { registerSchedulerRoutes, initScheduler } from './scheduler/routes.ts';
import { initDaemons, registerDaemonRoutes } from './daemons/routes.ts';
import { registerBoardRoutes } from './board/routes.ts';
import { initIntegrations, registerIntegrationsRoutes } from './integrations/routes.ts';
import { registerSpecsRoutes } from './specs/routes.ts';
import { registerForgeRoutes } from './forge/routes.ts';
import { registerForumRoutes } from './forum/routes.ts';
import { registerDmRoutes } from './dm/routes.ts';
import { registerTraceRoutes } from './trace/routes.ts';
import { registerPackRoutes } from './pack/routes.ts';
import { registerDashboardRoutes } from './dashboard/routes.ts';
import { registerServerRoutes } from './server/routes.ts';
import {
  initGuestTables,
  createGuest,
  listGuests,
  getGuest,
  getGuestByUsername,
  getGuestByDisplayName,
  updateGuest,
  deleteGuest,
  banGuest,
  unbanGuest,
  isGuestActive,
  recordFailedAttempt,
  recordSuccessfulLogin,
  logGuestAction,
  resetGuestPassword,
  changeGuestPassword,
  updateGuestProfile,
} from './server/guest-accounts.ts';
import {
  scanForInjection,
  checkGuestPostRate,
  checkGuestDmRate,
  checkGuestContentLength,
  initGuestSafetyMigrations,
} from './server/guest-safety.ts';

import {
  logSecurityEvent,
  generateRequestId,
} from './server/security-logger.ts';

import {
  createToken,
  validateToken,
  rotateToken,
  selfRotateToken,
  revokeToken,
  revokeBeastChain,
  listTokens,
  pruneBeastTokens,
  getTokenInfo,
} from './server/beast-tokens.ts';

import {
  listTraces,
  getTrace,
  getTraceChain,
  linkTraces,
  unlinkTraces,
  getTraceLinkedChain
} from './trace/handler.ts';

// Reset stale indexing status on startup using Drizzle
try {
  db.update(indexingStatus)
    .set({ isIndexing: 0 })
    .where(eq(indexingStatus.id, 1))
    .run();
  console.log('🔮 Reset indexing status on startup');
} catch (e) {
  // Table might not exist yet - that's fine
}

// Retry helper for SQLite BUSY errors during concurrent writes (task #211)
async function withRetry<T>(fn: () => T | Promise<T>, maxRetries = 3, delayMs = 100): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const isBusy = err?.message?.includes('SQLITE_BUSY') || err?.message?.includes('database is locked');
      if (isBusy && attempt < maxRetries) {
        await new Promise(r => setTimeout(r, delayMs * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error('withRetry: exhausted retries');
}

// Configure process lifecycle management
configure({ dataDir: ORACLE_DATA_DIR, pidFileName: 'oracle-http.pid' });

// Write PID file for process tracking
writePidFile({ pid: process.pid, port: Number(PORT), startedAt: new Date().toISOString(), name: 'oracle-http' });

// Register graceful shutdown handlers
registerSignalHandlers(async () => {
  console.log('\n🔮 Shutting down gracefully...');
  await performGracefulShutdown({
    resources: [
      { close: () => { closeDb(); return Promise.resolve(); } }
    ]
  });
  removePidFile();
  console.log('👋 Oracle Nightly HTTP Server stopped.');
});

// Create Hono app
type AppEnv = { Variables: Record<string, any> };
const app = new OpenAPIHono<AppEnv>();

// Custom 404 with did-you-mean hints for API routes
// Uses HELP_ENDPOINTS (defined below with /api/help) for path matching
function findSimilarPaths(requested: string): string[] {
  const reqParts = requested.toLowerCase().split('/').filter(Boolean);
  const paths = HELP_ENDPOINTS.map(e => e.path);
  const uniquePaths = [...new Set(paths)];
  const scored = uniquePaths.map(p => {
    const parts = p.toLowerCase().split('/').filter(Boolean);
    let score = 0;
    for (const rp of reqParts) {
      if (rp === 'api') continue;
      for (const pp of parts) {
        if (pp.startsWith(':')) continue;
        if (pp === rp) { score += 3; break; }
        if (pp.includes(rp) || rp.includes(pp)) { score += 1; break; }
      }
    }
    return { path: p, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map(s => s.path);
}

app.notFound((c) => {
  const reqPath = c.req.path;
  if (!reqPath.startsWith('/api/')) {
    return c.text('Not Found', 404);
  }
  const suggestions = findSimilarPaths(reqPath);
  return c.json({
    error: 'Not Found',
    path: reqPath,
    method: c.req.method,
    hint: suggestions.length > 0
      ? `Did you mean: ${suggestions.join(', ')}?`
      : 'Use GET /api/help to see all available endpoints, or GET /api/help?q=keyword to search.',
    docs: '/api/help',
  }, 404);
});

// CORS middleware — restricted to known origins (T#502)
app.use('*', cors({
  origin: ['http://localhost:47778', 'http://127.0.0.1:47778', 'https://denbook.online'],
  credentials: true,
}));

// Security headers middleware (T#502 — Talon audit finding, T#503 — CSP)
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Content-Security-Policy', [
    "default-src 'none'",
    "script-src 'self' cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' fonts.googleapis.com",
    "font-src fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
});

// ============================================================================
// Auth Helpers
// ============================================================================

// Session secret - generate once per server run
const SESSION_SECRET = process.env.ORACLE_SESSION_SECRET || crypto.randomUUID();
export const SESSION_COOKIE_NAME = 'oracle_session';
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (owner)
export const GUEST_SESSION_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours (guest)

// Check if request is from local network
export function isLocalNetwork(c: Context): boolean {
  // Check actual client IP — do NOT trust Via header (spoofable).
  // Caddy should be configured to set X-Real-IP to the actual client IP.
  const forwarded = c.req.header('x-forwarded-for');
  const realIp = c.req.header('x-real-ip');
  const ip = forwarded?.split(',')[0]?.trim() || realIp || '127.0.0.1';

  return ip === '127.0.0.1'
      || ip === '::1'
      || ip === 'localhost'
      || ip.startsWith('192.168.')
      || ip.startsWith('10.')
      || ip.startsWith('172.16.')
      || ip.startsWith('172.17.')
      || ip.startsWith('172.18.')
      || ip.startsWith('172.19.')
      || ip.startsWith('172.20.')
      || ip.startsWith('172.21.')
      || ip.startsWith('172.22.')
      || ip.startsWith('172.23.')
      || ip.startsWith('172.24.')
      || ip.startsWith('172.25.')
      || ip.startsWith('172.26.')
      || ip.startsWith('172.27.')
      || ip.startsWith('172.28.')
      || ip.startsWith('172.29.')
      || ip.startsWith('172.30.')
      || ip.startsWith('172.31.');
}

// Generate session token using HMAC-SHA256
// Format: role:data:expires:signature
// role = 'owner' or 'guest', data = '' for owner or 'username' for guest
export function generateSessionToken(role: Role = 'owner', data: string = ''): string {
  const duration = role === 'guest' ? GUEST_SESSION_DURATION_MS : SESSION_DURATION_MS;
  const expires = Date.now() + duration;
  const payload = `${role}:${data}:${expires}`;
  const signature = createHmac('sha256', SESSION_SECRET)
    .update(payload)
    .digest('hex');
  return `${payload}:${signature}`;
}

// Verify session token with timing-safe comparison
// Returns { valid, role, data } or { valid: false }
export interface SessionInfo {
  valid: boolean;
  role?: Role;
  data?: string;
}

function verifySessionToken(token: string): boolean {
  return parseSessionToken(token).valid;
}

export function parseSessionToken(token: string): SessionInfo {
  if (!token) return { valid: false };

  // Support both old format (expires:sig) and new format (role:data:expires:sig)
  const parts = token.split(':');

  if (parts.length === 2) {
    // Legacy format: expires:signature (owner session)
    const [expiresStr, signature] = parts;
    const expires = parseInt(expiresStr, 10);
    if (isNaN(expires) || expires < Date.now()) return { valid: false };

    const expectedSignature = createHmac('sha256', SESSION_SECRET)
      .update(expiresStr)
      .digest('hex');

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expectedBuf.length) return { valid: false };
    if (!timingSafeEqual(sigBuf, expectedBuf)) return { valid: false };

    return { valid: true, role: 'owner', data: '' };
  }

  if (parts.length === 4) {
    // New format: role:data:expires:signature
    const [role, data, expiresStr, signature] = parts;
    const expires = parseInt(expiresStr, 10);
    if (isNaN(expires) || expires < Date.now()) return { valid: false };
    if (role !== 'owner' && role !== 'guest') return { valid: false };

    const payload = `${role}:${data}:${expiresStr}`;
    const expectedSignature = createHmac('sha256', SESSION_SECRET)
      .update(payload)
      .digest('hex');

    const sigBuf = Buffer.from(signature);
    const expectedBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expectedBuf.length) return { valid: false };
    if (!timingSafeEqual(sigBuf, expectedBuf)) return { valid: false };

    return { valid: true, role: role as Role, data };
  }

  return { valid: false };
}

// Check if request has a valid browser session (Gorn)
function hasSessionAuth(c: Context): boolean {
  const sessionCookie = getCookie(c, SESSION_COOKIE_NAME);
  return verifySessionToken(sessionCookie || '');
}

// Check if identity validation can be skipped (local network OR authenticated browser session)
function isTrustedRequest(c: Context): boolean {
  return isLocalNetwork(c) || hasSessionAuth(c);
}

// T#718 — server-derived Beast identity for pack-identity writes.
// Returns the authenticated caller (lowercase) or null if caller cannot be identified.
// Priority: bearer-token actor (T#546 per-Beast tokens) > browser session (gorn) > null.
// Local-bypass alone is NOT sufficient to claim Beast identity — cryptographic auth required.
// Closes Bertus/Flint DM-spoof finding (thread #20 msg #10002): audit log actor + write-path
// identity both derive from this helper instead of client-asserted body.from/body.beast/body.author.
function requireBeastIdentity(c: Context): string | null {
  const actor = (c.get as any)('actor') as string | undefined;
  if (actor) return actor.toLowerCase();
  if (hasSessionAuth(c)) return 'gorn';
  return null;
}

// Check if auth is required and user is authenticated
export function isAuthenticated(c: Context): boolean {
  const authEnabled = getSetting('auth_enabled') === 'true';
  if (!authEnabled) return true; // Auth not enabled, everyone is "authenticated"

  // Check session cookie first — guest sessions take priority over local bypass
  const sessionCookie = getCookie(c, SESSION_COOKIE_NAME);
  if (sessionCookie && verifySessionToken(sessionCookie)) return true;

  const localBypass = getSetting('auth_local_bypass') !== 'false'; // Default true
  if (localBypass && isLocalNetwork(c)) return true;

  return false;
}

// Initialize guest account tables and safety migrations (Spec #32)
initGuestTables(sqlite);
initGuestSafetyMigrations(sqlite);

// ============================================================================
// Auth Middleware (protects /api/* except auth routes)
// ============================================================================

app.use('/api/*', async (c, next) => {
  const path = c.req.path;

  // Skip auth for certain endpoints
  const publicPaths = [
    '/api/auth/status',
    '/api/auth/login',
    '/api/health',
    // Webhook endpoints — third-party callers cannot present Beast bearer tokens
    // (Beast tokens are `den_`-prefixed; provider-issued shared-secrets are not).
    // Each handler validates its own provider-shared-secret via crypto.timingSafeEqual
    // constant-time compare against an env-var token. Middleware bypass is correct
    // shape here — auth still happens, just at the handler layer where the
    // shared-secret lives. Path-level allowlist (not pattern) keeps the surface narrow.
    '/api/webhooks/hevy',
  ];
  if (publicPaths.some(p => path === p)) {
    return next();
  }

  // Bearer token auth (T#546 — Beast API tokens)
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer den_')) {
    const token = authHeader.slice(7); // Strip "Bearer "
    const result = validateToken(token);

    if (result.valid) {
      // Decree #70 Req 8 — expired-grace tokens can ONLY reach /api/auth/rotate
      if (result.expiredGrace && path !== '/api/auth/rotate') {
        return c.json({ error: 'Token expired — self-rotate available at POST /api/auth/rotate', code: 'expired_grace_rotate_only' }, 401);
      }
      // Token validated — set actor identity and skip further auth
      c.set('actor' as any, result.beast);
      c.set('actorType' as any, 'beast');
      c.set('authMethod' as any, 'token');
      c.set('tokenId' as any, result.tokenId);
      c.set('role' as any, 'beast' as Role);
      // Spec #52 Phase 4 — surface rotation_recommended as response header
      // so Beast caller wrappers can call /api/auth/rotate transparently
      // before SELF_ROTATE_WINDOW closes (12h-of-life trigger inside the
      // empirical 17h band-aid cliff envelope).
      if (result.rotationRecommended) {
        c.header('X-Rotation-Recommended', 'true');
      }
      // Spec #52 — surface rotation-grace acceptance for caller telemetry
      // (lets a caller log that it just hit the in-flight grace window).
      if (result.rotationGrace) {
        c.header('X-Rotation-Grace', 'true');
      }
      if (result.expiredGrace) {
        c.header('X-Expired-Grace', 'true');
        logSecurityEvent({
          eventType: 'expired_grace_auth',
          severity: 'info',
          actor: result.beast,
          actorType: 'beast',
          target: path,
          details: { token_id: result.tokenId },
          requestId: (c.get as any)('requestId'),
        });
      }
      return next();
    } else {
      // Invalid/expired token — log and reject
      const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
      logSecurityEvent({
        eventType: 'auth_failure',
        severity: 'warning',
        actor: result.beast || 'unknown',
        actorType: 'beast',
        target: path,
        details: { reason: result.reason, auth_method: 'bearer_token' },
        ipSource: ip,
        requestId: (c.get as any)('requestId'),
      });
      return c.json({ error: 'Invalid or expired token' }, 401);
    }
  }

  if (!isAuthenticated(c)) {
    return c.json({ error: 'Unauthorized', requiresAuth: true }, 401);
  }

  // Set role from session token (owner or guest) or local bypass (owner)
  if (!(c.get as any)('role')) {
    const sessionCookie = getCookie(c, SESSION_COOKIE_NAME);
    const session = parseSessionToken(sessionCookie || '');
    if (session.valid && session.role === 'guest') {
      // Guest session — check expiry/disabled/lockout server-side on every request
      const guest = getGuestByUsername(sqlite, session.data || '');
      if (guest) {
        const status = isGuestActive(guest);
        if (!status.active) {
          return c.json({ error: 'Unauthorized', message: status.reason, requiresAuth: true }, 401);
        }
        c.set('role' as any, 'guest' as Role);
        c.set('guestUsername' as any, session.data);
        c.set('guestId' as any, guest.id);
        // Log guest API access
        logGuestAction(sqlite, guest.id, path, c.req.method);
      } else {
        return c.json({ error: 'Unauthorized', message: 'Guest account not found', requiresAuth: true }, 401);
      }
    } else {
      c.set('role' as any, 'owner' as Role);
    }
  }

  return next();
});

// ============================================================================
// RBAC Authorization Middleware (Spec #32, T#553)
// Runs AFTER auth — checks role against endpoint allowlist.
// Guest role: default-deny, only allowlisted endpoints pass.
// Owner/beast: full access.
// ============================================================================

app.use('/api/*', rbacMiddleware());

// ============================================================================
// Audit Logging Middleware (Task #72 — logs all mutating API requests)
// ============================================================================

const AUDIT_SKIP = ['/api/health', '/api/help', '/api/auth/status', '/api/auth/login', '/api/session/stats'];

app.use('/api/*', async (c, next) => {
  const method = c.req.method;
  const path = c.req.path;

  // Generate request ID for correlation between audit_log and security_events
  const requestId = generateRequestId();
  c.set('requestId' as any, requestId);

  // Skip: GETs (except sensitive), static, health, WS
  const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
  const isSensitiveGet = method === 'GET' && (path.includes('/dm/') || path.includes('/settings') || path.includes('/audit'));
  if (!isMutation && !isSensitiveGet) return next();
  if (AUDIT_SKIP.some(p => path === p)) return next();

  // Clone body BEFORE next() consumes it — extraction after next() fails on consumed streams
  let bodyData: Record<string, unknown> | null = null;
  if (isMutation) {
    try {
      bodyData = await c.req.raw.clone().json().catch(() => null) as Record<string, unknown> | null;
    } catch { /* body parse failed */ }
  }

  await next();

  // Log after handler completes
  try {
    const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
    // Actor extraction chain (T#718 — closes Bertus/Flint #10002 audit-attribution spoof gap):
    // 1. Bearer token identity (set by auth middleware — trusted)
    // 2. Session cookie → "gorn" (browser requests — trusted)
    // 3. Guest session → "[Guest] <username>" (server-set via session — trusted)
    // 4. ?as= query param — logged as legacy signal but NOT used as actor (spoofable)
    // 5. Path patterns for path-identity routes (e.g. /api/dm/<beast>/...)
    // 6. Fallback: "unknown"
    // REMOVED (T#718): body.author / body.beast / body.from as actor fallback — client-asserted,
    // spoofable, no cryptographic binding to the calling process. Audit trail now records
    // true-caller only; forensic integrity preserved per Bertus #10002 + Principle 1.
    const tokenActor = (c.get as any)('actor') as string | undefined;
    const tokenActorType = (c.get as any)('actorType') as string | undefined;
    let actor = tokenActor || '';
    let actorType = tokenActorType || '';

    if (!actor) {
      if (hasSessionAuth(c)) {
        actor = 'gorn';
        actorType = 'human';
      }
    }
    if (!actor) {
      const role = (c.get as any)('role');
      const guestUsername = (c.get as any)('guestUsername');
      if (role === 'guest' && guestUsername) {
        actor = `[Guest] ${guestUsername}`;
        actorType = 'guest';
      }
    }
    if (!actor) {
      // Path-identity routes — /api/dm/<beast>/... has the beast in the path itself
      const pathMatch = path.match(/\/api\/(?:dm|schedules)\/(?!messages|dashboard|due|pending)([a-z][\w-]*)/i);
      if (pathMatch) actor = pathMatch[1];
    }

    // ?as= logged as legacy-usage tracking (not used as actor — spoofable)
    const asParam = c.req.query('as') || '';
    if (asParam) {
      logSecurityEvent({
        eventType: 'settings_changed', // Reuse existing type for legacy tracking
        severity: 'info',
        actor: actor || 'unknown',
        actorType: (actorType as any) || 'unknown',
        target: path,
        details: { auth_method: 'legacy_as_param', as_param_value: asParam, deprecation: 'Use Bearer token auth' },
        ipSource: ip,
        requestId,
      });
    }

    if (!actor) {
      actor = c.req.header('x-beast') || 'unknown';
    }
    if (!actorType) {
      actorType = 'unknown';
    }

    // bodyData kept in scope (null-tolerated) for potential future per-route use;
    // deliberately not consulted here — see REMOVED note above.
    void bodyData;
    const statusCode = c.res.status;

    // Extract resource info from path
    const parts = path.replace('/api/', '').split('/');
    const resourceType = parts[0] || null;
    const resourceId = parts[1] || null;

    sqlite.prepare(
      `INSERT INTO audit_log (actor, actor_type, action, resource_type, resource_id, ip_source, request_method, request_path, status_code, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(actor, actorType, `${method} ${path}`, resourceType, resourceId, ip, method, path, statusCode, requestId);

    // Auto-log 403 permission denials as security events
    if (statusCode === 403) {
      logSecurityEvent({
        eventType: 'permission_denied',
        severity: 'warning',
        actor: actor || undefined,
        actorType: actorType as any,
        target: path,
        details: { method, status_code: statusCode, resource_type: resourceType },
        ipSource: ip,
        requestId,
      });
    }
  } catch { /* never block requests for logging failures */ }
});

// ============================================================================
// Auth — rate-limit infrastructure (route handlers extracted to src/server/routes.ts, T#781)
// ============================================================================

// Login rate limiting persistence
// Login rate limiting: max 5 attempts per IP per 15 minutes
// Persisted to SQLite so restarts don't reset the window (T#594)
export const LOGIN_RATE_LIMIT = 5;
export const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;

sqlite.exec(`CREATE TABLE IF NOT EXISTS login_rate_limits (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  first_attempt_at INTEGER NOT NULL
)`);

// T#712: cache of inbound Telegram messages for reply-to context fetch.
// Gate-coupling: `msg.chat.id === bot.chatId` upstream check (in handleTelegramMessage)
// is the PII containment boundary. Expanding that gate (group chats, multi-sender, etc)
// requires threat-model re-review on telegram_messages.raw_json at the same time.
// Composite PK (chat_id, id) — TG message_id is per-chat-unique per Bot API spec,
// not globally unique. Composite PK survives gate-expansion (Boro chat, group chats,
// sub-bot allowlisting) without migration. v2: TTL cleanup cron, task TBD.
sqlite.exec(`CREATE TABLE IF NOT EXISTS telegram_messages (
  chat_id TEXT NOT NULL,
  id INTEGER NOT NULL,
  from_id TEXT,
  text TEXT,
  caption TEXT,
  photo_file_id TEXT,
  date_unix INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  PRIMARY KEY (chat_id, id)
)`);
// Retention-shape-reserved index for future cleanup cron (Bertus #887 flag 2).
sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_telegram_messages_date_unix ON telegram_messages(date_unix)`);

export function getRateLimit(ip: string): { count: number; firstAttempt: number } | null {
  const row = sqlite.prepare('SELECT count, first_attempt_at FROM login_rate_limits WHERE ip = ?').get(ip) as any;
  if (!row) return null;
  return { count: row.count, firstAttempt: row.first_attempt_at };
}

export function clearRateLimit(ip: string): void {
  sqlite.prepare('DELETE FROM login_rate_limits WHERE ip = ?').run(ip);
}


// ============================================================================
// Settings Routes
// ============================================================================

// Settings routes extracted to src/settings/routes.ts (T#798 P3-A)
registerSettingsRoutes(app, { getSetting, setSetting, logSecurityEvent });

// ============================================================================
// API Routes
// ============================================================================


// Health check (OpenAPI — Spec #55 Phase 1 proof-of-pattern)
app.openapi(healthRoute, (c) => {
  return c.json({ status: 'ok', server: 'oracle-nightly', port: PORT, oracleV2: 'connected' });
});

// Knowledge / docs routes extracted to src/knowledge/routes.ts (T#806 P3-B)
registerKnowledgeRoutes(app, sqlite, { repoRoot: REPO_ROOT });


// ============================================================================
// Dashboard Routes
// ============================================================================


// Guest dashboard — public data only (T#558, Spec #32)
app.get('/api/guest/dashboard', (c) => {
  const guestUsername = (c.get as any)('guestUsername') as string | undefined;

  // Public threads (visibility = public)
  const publicThreads = sqlite.prepare(
    "SELECT id, title, status, created_at, (SELECT COUNT(*) FROM forum_messages WHERE thread_id = forum_threads.id) as msg_count FROM forum_threads WHERE visibility = 'public' ORDER BY updated_at DESC LIMIT 10"
  ).all() as any[];

  // Pack info (Beast profiles)
  const beasts = sqlite.prepare(
    "SELECT name, display_name, animal, role, bio, theme_color FROM beast_profiles ORDER BY name"
  ).all() as any[];

  // Guest DM summary (own conversations only) with unread counts
  let dmSummary: any[] = [];
  let dmUnreadTotal = 0;
  if (guestUsername) {
    const guestDisplayName = getGuestDisplayName(guestUsername);
    const guestTag = `[Guest] ${guestDisplayName}`;
    const convos = sqlite.prepare(
      "SELECT c.id, CASE WHEN participant1 = ? THEN participant2 ELSE participant1 END as other, (SELECT content FROM dm_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_message, (SELECT created_at FROM dm_messages WHERE conversation_id = c.id ORDER BY created_at DESC LIMIT 1) as last_at FROM dm_conversations c WHERE participant1 = ? OR participant2 = ? ORDER BY last_at DESC LIMIT 10"
    ).all(guestTag, guestTag, guestTag) as any[];
    for (const conv of convos) {
      const unread = (sqlite.prepare(
        "SELECT COUNT(*) as c FROM dm_messages WHERE conversation_id = ? AND LOWER(sender) != ? AND read_at IS NULL"
      ).get(conv.id, guestTag.toLowerCase()) as any)?.c || 0;
      dmSummary.push({ other: conv.other, last_message: conv.last_message, last_at: conv.last_at, unread });
      dmUnreadTotal += unread;
    }
  }

  return c.json({
    publicThreads: publicThreads.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      message_count: t.msg_count || 0,
      created_at: new Date(t.created_at).toISOString(),
    })),
    pack: beasts.map(b => ({
      name: b.name,
      displayName: b.display_name,
      animal: b.animal,
      role: b.role,
      bio: b.bio,
      themeColor: b.theme_color,
    })),
    dmSummary,
    dmUnreadTotal,
  });
});

// Guest threads — public only (T#559)
app.get('/api/guest/threads', (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  const rows = sqlite.prepare(
    "SELECT *, (SELECT COUNT(*) FROM forum_messages WHERE thread_id = forum_threads.id) as msg_count FROM forum_threads WHERE visibility = 'public' AND deleted_at IS NULL ORDER BY COALESCE(pinned, 0) DESC, updated_at DESC LIMIT ? OFFSET ?"
  ).all(limit, offset) as any[];

  const total = (sqlite.prepare("SELECT COUNT(*) as total FROM forum_threads WHERE visibility = 'public' AND deleted_at IS NULL").get() as any)?.total || 0;

  return c.json({
    threads: rows.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status || 'active',
      category: t.category || 'discussion',
      pinned: !!(t.pinned),
      message_count: t.msg_count || 0,
      created_at: new Date(t.created_at).toISOString(),
      visibility: 'public',
    })),
    total,
  });
});

// Guest thread detail — public only (T#559)
app.get('/api/guest/thread/:id', (c) => {
  const threadId = parseInt(c.req.param('id'), 10);
  if (isNaN(threadId)) return c.json({ error: 'Invalid thread ID' }, 400);

  const threadRow = sqlite.prepare('SELECT * FROM forum_threads WHERE id = ? AND visibility = ?').get(threadId, 'public') as any;
  if (!threadRow) return c.json({ error: 'Thread not found' }, 404);

  const rawLimit = c.req.query('limit');
  const parsedLimit = rawLimit ? parseInt(rawLimit, 10) : NaN;
  const limit = rawLimit ? (isNaN(parsedLimit) || parsedLimit < 1 ? 50 : parsedLimit) : undefined;
  const rawOffset = parseInt(c.req.query('offset') || '0', 10);
  const offset = isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;
  const order = (c.req.query('order') === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc';

  const threadData = getFullThread(threadId, limit, offset, order);
  if (!threadData) return c.json({ error: 'Thread not found' }, 404);

  return c.json({
    thread: {
      id: threadData.thread.id,
      title: threadData.thread.title,
      status: threadData.thread.status,
      created_at: new Date(threadData.thread.createdAt).toISOString(),
    },
    messages: threadData.messages.map(m => {
      const raw = sqlite.prepare('SELECT reply_to_id FROM forum_messages WHERE id = ?').get(m.id) as any;
      const reactionRows = sqlite.prepare(
        'SELECT emoji, GROUP_CONCAT(beast_name) as beasts, COUNT(*) as count FROM forum_reactions WHERE message_id = ? GROUP BY emoji'
      ).all(m.id) as any[];
      // Resolve guest avatar URL from guest_accounts (T#602)
      let authorAvatarUrl: string | null = null;
      if (m.author?.startsWith('[Guest]')) {
        const guestName = m.author.replace('[Guest] ', '').replace('[Guest]', '').trim();
        const guest = sqlite.prepare('SELECT avatar_url FROM guest_accounts WHERE LOWER(display_name) = ? OR LOWER(username) = ?').get(guestName.toLowerCase(), guestName.toLowerCase()) as any;
        authorAvatarUrl = guest?.avatar_url || null;
      }
      return {
        id: m.id,
        role: m.role,
        content: m.content,
        author: m.author,
        author_avatar_url: authorAvatarUrl,
        reply_to_id: raw?.reply_to_id || null,
        principles_found: m.principlesFound,
        patterns_found: m.patternsFound,
        created_at: new Date(m.createdAt).toISOString(),
        reactions: reactionRows.map(r => ({ emoji: r.emoji, beasts: r.beasts.split(','), count: r.count })),
      };
    }),
    total: threadData.total,
  });
});

// Resolve guest display name from username
function getGuestDisplayName(username: string): string {
  const guest = sqlite.query('SELECT display_name FROM guest_accounts WHERE username = ?').get(username) as any;
  return guest?.display_name || username;
}

// Guest post message — public threads only (T#559)
app.post('/api/guest/thread/:id/message', async (c) => {
  const threadId = parseInt(c.req.param('id'), 10);
  if (isNaN(threadId)) return c.json({ error: 'Invalid thread ID' }, 400);

  const threadRow = sqlite.prepare('SELECT visibility FROM forum_threads WHERE id = ?').get(threadId) as any;
  if (!threadRow || threadRow.visibility !== 'public') {
    return c.json({ error: 'Thread not found' }, 404);
  }

  const guestUsername = (c.get as any)('guestUsername') || 'guest';
  const data = await c.req.json();
  if (!data.message) return c.json({ error: 'Message required' }, 400);

  // Rate limiting
  const rateCheck = checkGuestPostRate(guestUsername);
  if (!rateCheck.allowed) return c.json({ error: rateCheck.error }, 429);

  // Content length
  const lengthCheck = checkGuestContentLength(data.message, 'post');
  if (!lengthCheck.allowed) return c.json({ error: lengthCheck.error }, 400);

  // Injection scan
  const scan = scanForInjection(data.message);
  if (scan.flagged) {
    logSecurityEvent({
      eventType: 'suspicious_content',
      severity: 'warning',
      actor: guestUsername,
      actorType: 'guest',
      target: `/api/guest/thread/${threadId}/message`,
      details: { patterns: scan.patterns, content_preview: data.message.slice(0, 200) },
      ipSource: c.req.header('x-real-ip') || 'local',
      requestId: (c.get as any)('requestId'),
    });
  }

  const guestDisplayName = getGuestDisplayName(guestUsername);
  const author = `[Guest] ${guestDisplayName}`;
  const result = await withRetry(() => handleThreadMessage({
    message: data.message,
    threadId,
    role: 'human',
    author,
  }));

  if (result.messageId) {
    sqlite.prepare('UPDATE forum_messages SET author_role = ? WHERE id = ?').run('guest', result.messageId);
    if (data.reply_to_id) {
      sqlite.prepare('UPDATE forum_messages SET reply_to_id = ? WHERE id = ?').run(data.reply_to_id, result.messageId);
    }
  }

  wsBroadcast('new_message', { thread_id: threadId, message_id: result.messageId, author });
  return c.json({ thread_id: threadId, message_id: result.messageId }, 201);
});

// Guest create thread — new public thread (T#561)
app.post('/api/guest/thread', async (c) => {
  const guestUsername = (c.get as any)('guestUsername') || 'guest';
  const data = await c.req.json();
  if (!data.message) return c.json({ error: 'Message required' }, 400);
  if (!data.title) return c.json({ error: 'Title required for new thread' }, 400);

  // Rate limiting
  const rateCheck = checkGuestPostRate(guestUsername);
  if (!rateCheck.allowed) return c.json({ error: rateCheck.error }, 429);

  // Content length
  const lengthCheck = checkGuestContentLength(data.message, 'post');
  if (!lengthCheck.allowed) return c.json({ error: lengthCheck.error }, 400);

  // Injection scan
  const scan = scanForInjection(data.message + ' ' + data.title);
  if (scan.flagged) {
    logSecurityEvent({
      eventType: 'suspicious_content',
      severity: 'warning',
      actor: guestUsername,
      actorType: 'guest',
      target: '/api/guest/thread',
      details: { patterns: scan.patterns, content_preview: (data.title + ': ' + data.message).slice(0, 200) },
      ipSource: c.req.header('x-real-ip') || 'local',
      requestId: (c.get as any)('requestId'),
    });
  }

  const guestDisplayName = getGuestDisplayName(guestUsername);
  const author = `[Guest] ${guestDisplayName}`;
  const result = await withRetry(() => handleThreadMessage({
    message: data.message,
    title: data.title,
    role: 'human',
    author,
  }));

  // Force visibility to public and set author_role
  if (result.threadId) {
    sqlite.prepare('UPDATE forum_threads SET visibility = ? WHERE id = ?').run('public', result.threadId);

    // T#629: Notify all Beasts when guest creates a new public thread
    if (!data.thread_id) {
      try {
        const { getOracleRegistry, notifyMentioned } = await import('./forum/mentions.ts');
        const registry = getOracleRegistry();
        const threadTitle = data.title || data.message?.slice(0, 50) || 'New thread';
        const allBeasts = Object.keys(registry).filter(name => name !== 'gorn');
        notifyMentioned(allBeasts, result.threadId, threadTitle, author, `New public thread from guest: ${threadTitle}`, undefined, new Set(allBeasts));
      } catch { /* best effort */ }
    }
  }
  if (result.messageId) {
    sqlite.prepare('UPDATE forum_messages SET author_role = ? WHERE id = ?').run('guest', result.messageId);
  }

  wsBroadcast('new_message', { thread_id: result.threadId, message_id: result.messageId, author });
  return c.json({ thread_id: result.threadId, message_id: result.messageId }, 201);
});

// Guest pack — Beast profiles (T#559)
app.get('/api/guest/pack', (c) => {
  const beasts = sqlite.prepare(
    "SELECT name, display_name, animal, role, bio, theme_color, avatar_url, interests, sex, birthdate FROM beast_profiles ORDER BY name"
  ).all() as any[];

  const { tmuxStatus } = getTmuxStatus();

  return c.json({
    beasts: beasts.map(b => {
      const sessionName = b.name.charAt(0).toUpperCase() + b.name.slice(1);
      const rawStatus = tmuxStatus.get(sessionName.toLowerCase()) || tmuxStatus.get(b.name) || 'offline';
      return {
        name: b.name,
        displayName: b.display_name,
        animal: b.animal,
        role: b.role,
        bio: b.bio,
        themeColor: b.theme_color,
        avatarUrl: normalizeAvatarUrl(b.avatar_url),
        interests: b.interests,
        sex: b.sex,
        birthdate: b.birthdate,
        online: rawStatus === 'processing' || rawStatus === 'idle' || rawStatus === 'waiting',
        status: rawStatus,
        sessionName,
      };
    }),
  });
});

// Guest DM — read own conversations (T#559)
app.get('/api/guest/dm/:from/:to', (c) => {
  const fromParam = c.req.param('from');
  const toParam = c.req.param('to');
  const guestUsername = (c.get as any)('guestUsername');
  const guestDisplayName = getGuestDisplayName(guestUsername);
  const guestTag = `[Guest] ${guestDisplayName}`;

  // Guests can only read their own conversations
  if (fromParam !== guestTag && toParam !== guestTag && fromParam !== guestUsername && toParam !== guestUsername) {
    return c.json({ error: 'Access denied' }, 403);
  }

  // Normalize: if from/to is the username, replace with [Guest] tag (DB format)
  const from = (fromParam === guestUsername || fromParam === guestDisplayName) ? guestTag : fromParam;
  const to = (toParam === guestUsername || toParam === guestDisplayName) ? guestTag : toParam;

  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');
  const order = c.req.query('order') || 'asc';
  const data = getDmMessages(from, to, limit, offset, order as 'asc' | 'desc');

  // Map [Guest] tags back to username in response
  const normalizeGuestSender = (s: string) => {
    if (s.toLowerCase() === guestTag.toLowerCase()) return guestUsername;
    return s;
  };

  return c.json({
    conversation_id: data.conversationId,
    participants: data.participants.map(p => normalizeGuestSender(p)),
    messages: data.messages.map(m => ({
      id: m.id,
      sender: normalizeGuestSender(m.sender),
      message: m.content,
      read_at: m.readAt ? new Date(m.readAt).toISOString() : null,
      created_at: new Date(m.createdAt).toISOString(),
    })),
    total: data.total,
  });
});

// Guest DM — send message (T#559)
app.post('/api/guest/dm', async (c) => {
  const guestUsername = (c.get as any)('guestUsername') || 'guest';
  const data = await c.req.json();
  if (!data.to || !data.message) return c.json({ error: 'to and message required' }, 400);

  // Validate recipient exists — guests can only DM beasts or gorn
  const recipientBeast = getBeastProfile(data.to);
  const isOwner = data.to.toLowerCase() === 'gorn';
  if (!recipientBeast && !isOwner) {
    return c.json({ error: `Recipient "${data.to}" not found. Must be a valid beast name.` }, 404);
  }

  // Rate limiting
  const rateCheck = checkGuestDmRate(guestUsername);
  if (!rateCheck.allowed) return c.json({ error: rateCheck.error }, 429);

  // Content length
  const lengthCheck = checkGuestContentLength(data.message, 'dm');
  if (!lengthCheck.allowed) return c.json({ error: lengthCheck.error }, 400);

  // Injection scan
  const scan = scanForInjection(data.message);
  if (scan.flagged) {
    logSecurityEvent({
      eventType: 'suspicious_content',
      severity: 'warning',
      actor: guestUsername,
      actorType: 'guest',
      target: `/api/guest/dm/${data.to}`,
      details: { patterns: scan.patterns, content_preview: data.message.slice(0, 200) },
      ipSource: c.req.header('x-real-ip') || 'local',
      requestId: (c.get as any)('requestId'),
    });
  }

  const guestDisplayName = getGuestDisplayName(guestUsername);
  const guestTag = `[Guest] ${guestDisplayName}`;
  const result = await withRetry(() => sendDm(guestTag, data.to, data.message, `[Guest] ${guestUsername}`));

  if (result.messageId) {
    try {
      sqlite.prepare('UPDATE dm_messages SET author_role = ? WHERE id = ?').run('guest', result.messageId);
    } catch { /* column may not exist */ }
  }

  wsBroadcast('new_dm', { conversation_id: result.conversationId });
  return c.json({ conversation_id: result.conversationId, message_id: result.messageId }, 201);
});

// Guest self-service password change (T#566, Spec #35 alias)
// Password change rate limiting: max 5 attempts per guest per 15 minutes (T#581, Talon finding)
const passwordChangeAttempts = new Map<string, { count: number; firstAttempt: number }>();
const PASSWORD_CHANGE_RATE_LIMIT = 5;
const PASSWORD_CHANGE_RATE_WINDOW_MS = 15 * 60 * 1000;

app.post('/api/guest/change-password', async (c) => {
  const guestUsername = (c.get as any)('guestUsername');
  if (!guestUsername) return c.json({ error: 'Not a guest session' }, 400);

  const guest = getGuestByUsername(sqlite, guestUsername);
  if (!guest) return c.json({ error: 'Guest account not found' }, 404);

  // Rate limit by guest username
  const now = Date.now();
  const attempts = passwordChangeAttempts.get(guestUsername);
  if (attempts) {
    if (now - attempts.firstAttempt > PASSWORD_CHANGE_RATE_WINDOW_MS) {
      passwordChangeAttempts.delete(guestUsername);
    } else if (attempts.count >= PASSWORD_CHANGE_RATE_LIMIT) {
      const retryAfter = Math.ceil((attempts.firstAttempt + PASSWORD_CHANGE_RATE_WINDOW_MS - now) / 1000);
      logSecurityEvent({
        eventType: 'rate_limited',
        severity: 'warning',
        actor: guestUsername,
        actorType: 'guest',
        target: '/api/guest/change-password',
        details: { attempts: attempts.count, window_ms: PASSWORD_CHANGE_RATE_WINDOW_MS },
        ipSource: c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1',
        requestId: (c.get as any)('requestId'),
      });
      return c.json({ error: `Too many password change attempts. Try again in ${Math.ceil(retryAfter / 60)} minutes.` }, 429);
    }
  }

  const body = await c.req.json();
  if (!body.current_password || !body.new_password) {
    return c.json({ error: 'current_password and new_password required' }, 400);
  }

  const result = await changeGuestPassword(sqlite, guest, body.current_password, body.new_password);
  if (!result.success) {
    // Track failed attempts
    const existing = passwordChangeAttempts.get(guestUsername);
    if (existing) {
      existing.count++;
    } else {
      passwordChangeAttempts.set(guestUsername, { count: 1, firstAttempt: now });
    }
    return c.json({ error: result.error }, 400);
  }

  // Success clears rate limit
  passwordChangeAttempts.delete(guestUsername);
  return c.json({ success: true });
});

// Legacy alias (T#566) — same rate limiting as /api/guest/change-password (T#581)
app.post('/api/guest/reset-password', async (c) => {
  const guestUsername = (c.get as any)('guestUsername');
  if (!guestUsername) return c.json({ error: 'Not a guest session' }, 400);

  const guest = getGuestByUsername(sqlite, guestUsername);
  if (!guest) return c.json({ error: 'Guest account not found' }, 404);

  const now = Date.now();
  const attempts = passwordChangeAttempts.get(guestUsername);
  if (attempts) {
    if (now - attempts.firstAttempt > PASSWORD_CHANGE_RATE_WINDOW_MS) {
      passwordChangeAttempts.delete(guestUsername);
    } else if (attempts.count >= PASSWORD_CHANGE_RATE_LIMIT) {
      const retryAfter = Math.ceil((attempts.firstAttempt + PASSWORD_CHANGE_RATE_WINDOW_MS - now) / 1000);
      logSecurityEvent({
        eventType: 'rate_limited',
        severity: 'warning',
        actor: guestUsername,
        actorType: 'guest',
        target: '/api/guest/reset-password',
        details: { attempts: attempts.count, window_ms: PASSWORD_CHANGE_RATE_WINDOW_MS },
        ipSource: c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1',
        requestId: (c.get as any)('requestId'),
      });
      return c.json({ error: `Too many password change attempts. Try again in ${Math.ceil(retryAfter / 60)} minutes.` }, 429);
    }
  }

  const body = await c.req.json();
  if (!body.current_password || !body.new_password) {
    return c.json({ error: 'current_password and new_password required' }, 400);
  }

  const result = await changeGuestPassword(sqlite, guest, body.current_password, body.new_password);
  if (!result.success) {
    const existing = passwordChangeAttempts.get(guestUsername);
    if (existing) { existing.count++; } else { passwordChangeAttempts.set(guestUsername, { count: 1, firstAttempt: now }); }
    return c.json({ error: result.error }, 400);
  }

  passwordChangeAttempts.delete(guestUsername);
  return c.json({ success: true });
});

// Guest profile — own info (T#559, expanded T#574)
app.get('/api/guest/profile', (c) => {
  const guestUsername = (c.get as any)('guestUsername');
  if (!guestUsername) return c.json({ error: 'Not a guest session' }, 400);

  const guest = getGuestByUsername(sqlite, guestUsername);
  if (!guest) return c.json({ error: 'Guest not found' }, 404);

  return c.json({
    username: guest.username,
    display_name: guest.display_name,
    bio: guest.bio || null,
    interests: guest.interests || null,
    avatar_url: guest.avatar_url || null,
    created_at: guest.created_at,
    expires_at: guest.expires_at,
  });
});

// Guest self-service profile update (T#574, Spec #35)
app.patch('/api/guest/profile', async (c) => {
  const guestUsername = (c.get as any)('guestUsername');
  if (!guestUsername) return c.json({ error: 'Not a guest session' }, 400);

  const guest = getGuestByUsername(sqlite, guestUsername);
  if (!guest) return c.json({ error: 'Guest not found' }, 404);

  const body = await c.req.json();

  // Validate display_name length
  if (body.display_name !== undefined && (!body.display_name || body.display_name.length > 50)) {
    return c.json({ error: 'Display name must be 1-50 characters' }, 400);
  }
  // Block reserved names (Beast names, Gorn, Admin) — T#597
  if (body.display_name !== undefined) {
    const RESERVED_NAMES = new Set([
      'karo','rax','mara','leonard','bertus','gnarl','zaghnal','pip','nyx','dex',
      'flint','quill','snap','vigil','talon','sable','gorn','admin','administrator','system',
    ]);
    if (RESERVED_NAMES.has(body.display_name.toLowerCase().trim())) {
      return c.json({ error: 'That display name is reserved' }, 400);
    }
  }
  // Validate bio length
  if (body.bio !== undefined && body.bio.length > 500) {
    return c.json({ error: 'Bio must be under 500 characters' }, 400);
  }
  // Validate interests length
  if (body.interests !== undefined && body.interests.length > 300) {
    return c.json({ error: 'Interests must be under 300 characters' }, 400);
  }

  // avatar_url is only set via /api/guest/avatar upload — never from PATCH body (T#580, Talon finding)
  const updated = updateGuestProfile(sqlite, guest.id, {
    display_name: body.display_name,
    bio: body.bio,
    interests: body.interests,
  });

  if (!updated) return c.json({ error: 'Update failed' }, 500);

  return c.json({
    username: updated.username,
    display_name: updated.display_name,
    bio: updated.bio || null,
    interests: updated.interests || null,
    avatar_url: updated.avatar_url || null,
  });
});

// Guest avatar upload (T#574, Spec #35)
app.post('/api/guest/avatar', async (c) => {
  const guestUsername = (c.get as any)('guestUsername');
  if (!guestUsername) return c.json({ error: 'Not a guest session' }, 400);

  const guest = getGuestByUsername(sqlite, guestUsername);
  if (!guest) return c.json({ error: 'Guest not found' }, 404);

  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  if (!file) return c.json({ error: 'No file provided' }, 400);

  // Validate file type by MIME
  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowedTypes.includes(file.type)) {
    return c.json({ error: 'File must be jpg, png, or webp' }, 400);
  }

  // Validate file size (2MB max)
  if (file.size > 2 * 1024 * 1024) {
    return c.json({ error: 'File must be under 2MB' }, 400);
  }

  // Validate magic bytes — don't trust MIME alone (T#582, Talon finding)
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const isJpeg = bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
  const isWebp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (!isJpeg && !isPng && !isWebp) {
    return c.json({ error: 'File content does not match an allowed image type' }, 400);
  }

  // Save file
  const ext = file.type.split('/')[1] === 'jpeg' ? 'jpg' : file.type.split('/')[1];
  const filename = `guest-${guestUsername}-avatar.${ext}`;
  const filePath = path.join(UPLOADS_DIR, filename);
  await Bun.write(filePath, buffer);

  const avatarUrl = `/api/f/${filename}`;
  updateGuestProfile(sqlite, guest.id, { avatar_url: avatarUrl });

  return c.json({ avatar_url: avatarUrl });
});



// Session stats endpoint - tracks activity from DB (includes MCP usage)
app.get('/api/session/stats', (c) => {
  const since = c.req.query('since');
  const sinceTime = since ? parseInt(since) : Date.now() - 24 * 60 * 60 * 1000; // Default 24h

  const searches = db.select({ count: sql<number>`count(*)` })
    .from(searchLog)
    .where(gt(searchLog.createdAt, sinceTime))
    .get();

  const learnings = db.select({ count: sql<number>`count(*)` })
    .from(learnLog)
    .where(gt(learnLog.createdAt, sinceTime))
    .get();

  return c.json({
    searches: searches?.count || 0,
    learnings: learnings?.count || 0,
    since: sinceTime
  });
});

// Schedule routes (singular API) — extracted to src/scheduler/routes.ts (T#772)

// ============================================================================
// Pack View Routes (Gather-style Beast overview + live terminal)
// ============================================================================

import { execSync } from 'child_process';

// Load all Beast spinner verbs from their settings.local.json configs
// Returns a Set of all configured spinner verbs across all Beasts
function loadAllSpinnerVerbs(): Set<string> {
  const verbs = new Set<string>();
  const workspaceDir = '/home/gorn/workspace';
  try {
    const dirs = fs.readdirSync(workspaceDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    for (const dir of dirs) {
      try {
        const configPath = path.join(workspaceDir, dir, '.claude', 'settings.local.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        const sv = config.spinnerVerbs;
        if (sv) {
          const verbList = Array.isArray(sv) ? sv : (sv.verbs || []);
          for (const v of verbList) {
            if (typeof v === 'string') verbs.add(v);
          }
        }
      } catch { /* skip dirs without config */ }
    }
  } catch { /* workspace not readable */ }
  return verbs;
}

// Cache spinner verbs (reload every 5 minutes)
let cachedSpinnerVerbs: Set<string> | null = null;
let spinnerVerbsLoadedAt = 0;
function getSpinnerVerbs(): Set<string> {
  const now = Date.now();
  if (!cachedSpinnerVerbs || now - spinnerVerbsLoadedAt > 5 * 60 * 1000) {
    cachedSpinnerVerbs = loadAllSpinnerVerbs();
    spinnerVerbsLoadedAt = now;
  }
  return cachedSpinnerVerbs;
}

// Rewrite legacy avatar URLs to /api/f/ format
function normalizeAvatarUrl(url: string | null): string | null {
  if (!url) return null;
  // /api/forum/file/xxx.jpg -> /api/f/xxx.jpg
  if (url.startsWith('/api/forum/file/')) return '/api/f/' + url.slice('/api/forum/file/'.length);
  // /api/files/ID/download -> look up filename from files table, rewrite to /api/f/
  const filesMatch = url.match(/^\/api\/files\/(\d+)\/download$/);
  if (filesMatch) {
    const file = sqlite.prepare('SELECT filename FROM files WHERE id = ?').get(parseInt(filesMatch[1])) as any;
    if (file) return '/api/f/' + file.filename;
  }
  return url;
}

// Shared tmux status detection — used by both /api/pack and /api/guest/pack
function getTmuxStatus(): { tmuxStatus: Map<string, 'processing' | 'idle' | 'waiting' | 'shell' | 'offline'>; contextPctMap: Map<string, number | null> } {
  const tmuxStatus: Map<string, 'processing' | 'idle' | 'waiting' | 'shell' | 'offline'> = new Map();
  const contextPctMap: Map<string, number | null> = new Map();
  try {
    const output = execSync(
      'tmux list-sessions -F "#{session_name}" 2>/dev/null',
      { timeout: 3000 }
    ).toString().trim();
    const sessions = output.split('\n').filter(Boolean);

    for (const session of sessions) {
      try {
        const cmd = execSync(
          `tmux list-panes -t ${JSON.stringify(session)} -F "#{pane_current_command}" 2>/dev/null`,
          { timeout: 2000 }
        ).toString().trim().split('\n')[0];

        if (cmd !== 'claude') {
          tmuxStatus.set(session.toLowerCase(), 'shell');
          continue;
        }

        // Claude is running — check pane content to detect processing vs idle
        // Multi-sample: capture pane content twice to smooth flicker between tool calls
        try {
          const captureCmd = `tmux capture-pane -t ${JSON.stringify(session + ':claude')} -p -S -30 2>/dev/null`;

          const pane1 = execSync(captureCmd, { timeout: 2000 }).toString();

          // Detect processing by checking the line just above the input prompt separator.
          //
          // Claude Code pane layout (bottom):
          //   [active status line]    ← "✻ Crafting…" or "Running…" ONLY during processing
          //   ───────────             ← separator (one above ❯)
          //   ❯ [input]              ← prompt line
          //   ───────────             ← separator (below ❯)
          //   Beast [Model] branch
          //   ██░░░ X% | $Y | Zm
          //   ⏵⏵ bypass permissions
          //
          // When idle, the line above the first separator is response text or "✻ Brewed for".
          // When processing, it's "✻ Crafting…", "Running…", etc.
          //
          // Strategy: find the ❯ prompt, check the 2 lines above its separator.
          const lines = pane1.split('\n');

          // Find the last ❯ prompt line
          let promptIdx = -1;
          for (let i = lines.length - 1; i >= 0; i--) {
            if (/^❯/.test(lines[i].trim())) { promptIdx = i; break; }
          }

          // Check the 2 lines above the ❯ prompt (skip separator)
          let isProcessing = false;
          if (promptIdx > 1) {
            const abovePrompt = lines.slice(Math.max(promptIdx - 3, 0), promptIdx).join('\n');
            // Match processing state using multiple signals:
            // 1. Generic spinner pattern: ✻/✽/· followed by word + ellipsis (…)
            // 2. "esc to interrupt" text (shown during tool execution)
            // 3. Custom Beast spinner verbs from settings.local.json configs
            isProcessing = /[✻✽·]\s+\w+\u2026|esc to interrupt/.test(abovePrompt);

            // If generic match missed, check for configured spinner verbs (handles multi-word verbs, etc.)
            if (!isProcessing) {
              const spinnerVerbs = getSpinnerVerbs();
              for (const verb of spinnerVerbs) {
                if (abovePrompt.includes(verb + '\u2026') || abovePrompt.includes(verb + '...')) {
                  isProcessing = true;
                  break;
                }
              }
            }
          }

          // Extract context % from status bar (e.g. "██░░░ 42% | $1.23 | 5m")
          let contextPct: number | null = null;
          for (let i = lines.length - 1; i >= 0; i--) {
            const pctMatch = lines[i].match(/(\d+)%\s*\|/);
            if (pctMatch) { contextPct = parseInt(pctMatch[1], 10); break; }
          }
          contextPctMap.set(session.toLowerCase(), contextPct);

          // Detect waiting state — Claude is stuck at a permission/choice prompt
          // Only scan lines near the prompt (last 8 lines before ❯) to avoid false positives
          // from notification text or conversation content in the pane buffer
          const promptArea = promptIdx > 0
            ? lines.slice(Math.max(promptIdx - 8, 0), promptIdx).join('\n')
            : '';
          // Match actual Claude permission UI: bordered choice boxes, (y/n) prompts
          const isWaiting = promptArea.length > 0
            && /Allow.*│|│.*Allow|Deny.*│|│.*Deny|Do you want to|trust this|Allow once|Always allow|\(y\/n\)|\(Y\/n\)/.test(promptArea)
            && !isProcessing;

          if (isProcessing) {
            tmuxStatus.set(session.toLowerCase(), 'processing');
          } else if (isWaiting) {
            tmuxStatus.set(session.toLowerCase(), 'waiting');
          } else {
            tmuxStatus.set(session.toLowerCase(), 'idle');
          }
        } catch {
          tmuxStatus.set(session.toLowerCase(), 'idle'); // Claude running but can't read pane
        }
      } catch {
        tmuxStatus.set(session.toLowerCase(), 'shell');
      }
    }
  } catch { /* tmux not running */ }

  return { tmuxStatus, contextPctMap };
}

// Get all beasts with status (processing/idle/offline)

// Get all configured spinner verbs across all Beasts

// Capture live terminal output for a Beast

// Send input to a Beast's terminal

// Send special keys (Enter, Ctrl-C, etc.)

// ============================================================================
// Remote Control — tmux Beast switcher
// ============================================================================

// Remote routes extracted to src/remote/routes.ts (T#799 P3-D)
registerRemoteRoutes(app, { isLocalNetwork, hasSessionAuth });

// ============================================================================
// Beast Profile Routes
// ============================================================================

// Generate SVG avatar for a beast (deterministic, cacheable)

// Seed default avatars for beasts that don't have one

// List all beast profiles

// Migration: add sex column to beast_profiles (T#411)
try { sqlite.prepare('ALTER TABLE beast_profiles ADD COLUMN sex TEXT DEFAULT NULL').run(); } catch { /* exists */ }
// T#658 — Norm #65 (Nap vs Rest) — scheduler-aware rest state
try { sqlite.prepare("ALTER TABLE beast_profiles ADD COLUMN rest_status TEXT DEFAULT 'active'").run(); } catch { /* exists */ }

// Get beast profile by name

// Create or update beast profile

// Partial profile update (edit individual fields)

// Update avatar only

// ============================================================================
// Thread Routes
// ============================================================================

// Mark thread as read for a beast

// Get unread counts for a beast (T#618: excludes muted threads)

// File archive columns (T#533)
try { sqlite.prepare(`ALTER TABLE files ADD COLUMN archived_at INTEGER`).run(); } catch { /* exists */ }
try { sqlite.prepare(`ALTER TABLE files ADD COLUMN archive_path TEXT`).run(); } catch { /* exists */ }

// UPLOADS_DIR + ARCHIVE_DIR kept here — still used by guest avatar upload (line ~2122) and
// telegram routes registration (~line 3497). File-specific constants + magic-byte detection
// moved to src/files/routes.ts as part of T#804 P3-E.
const UPLOADS_DIR = path.join(ORACLE_DATA_DIR, 'uploads');
const ARCHIVE_DIR = path.join(ORACLE_DATA_DIR, 'uploads', 'archive');

// Files + upload routes extracted to src/files/routes.ts (T#804 P3-E)
registerFilesRoutes(app, sqlite, { hasSessionAuth, isTrustedRequest, isLocalNetwork, verifySessionToken, uploadsDir: UPLOADS_DIR, sessionCookieName: SESSION_COOKIE_NAME });

// (stats endpoint moved above :id routes)

// Get attachments for a message

// T#618: Inline migration — add level column to forum_notification_prefs
try { sqlite.exec("ALTER TABLE forum_notification_prefs ADD COLUMN level TEXT NOT NULL DEFAULT 'full'"); } catch { /* exists */ }
try { sqlite.exec("UPDATE forum_notification_prefs SET level = 'muted' WHERE muted = 1 AND level = 'full'"); } catch { /* ignore */ }

// T#622: Inline migration — add deleted_at column to forum_messages for soft delete
try { sqlite.exec("ALTER TABLE forum_messages ADD COLUMN deleted_at TEXT DEFAULT NULL"); } catch { /* exists */ }
try { sqlite.exec("ALTER TABLE forum_messages ADD COLUMN deleted_by TEXT DEFAULT NULL"); } catch { /* exists */ }

// Mute/unmute thread notifications for a beast (alias for subscribe with level muted/full)

// Get muted threads for a beast

// T#618: Subscribe to thread with level (full/summary/muted)

// T#618: Get all subscriptions for a beast

// GET /api/thread/:id/subscribers — list thread subscribers with profiles (T#621, owner-only)

// Link preview — fetch URL metadata

// ============================================================================
// Forum activity feed — recent messages across all threads

// Get all @mentions for a beast across all threads

// Search forum threads and messages

// List threads (with category, pinned, sorted pinned-first)

// Create thread / send message

// Get thread by ID

// Edit message (preserves original in edit history)

// DELETE /api/message/:id — soft delete a forum message (Gorn-only, T#622)

// Get edit history for a message

// Add reaction to message
// Emoji whitelist — DB-backed, any Beast can add (T#385)
try {
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS emoji_whitelist (
    emoji TEXT PRIMARY KEY,
    added_by TEXT,
    created_at INTEGER NOT NULL
  )`).run();
} catch { /* already exists */ }

// Seed defaults if table is empty
const emojiCount = (sqlite.prepare('SELECT COUNT(*) as c FROM emoji_whitelist').get() as any)?.c || 0;
if (emojiCount === 0) {
  const defaults = [
    '👍', '👎', '❤️', '🔥', '👀', '✅', '❌',
    '😂', '😢', '🤔', '💪', '🎉', '🙏', '👏', '💯',
    '🚀', '⭐', '⚠️', '💡', '🏆', '🫡', '🤝',
    '📦', '🐾', '🐴', '🐊', '🐻', '🦘', '🦁', '🦝', '🦦', '🐙', '🐦‍⬛',
  ];
  const insert = sqlite.prepare('INSERT OR IGNORE INTO emoji_whitelist (emoji, added_by, created_at) VALUES (?, ?, ?)');
  const now = Date.now();
  for (const e of defaults) insert.run(e, 'system', now);
}

function getSupportedEmoji(): Set<string> {
  const rows = sqlite.prepare('SELECT emoji FROM emoji_whitelist').all() as any[];
  return new Set(rows.map(r => r.emoji));
}

// Cache — refreshed on add/remove
let SUPPORTED_EMOJI = getSupportedEmoji();

// GET /api/forum/emojis — list whitelist

// POST /api/forum/emojis — add emoji (any Beast)

// DELETE /api/forum/emojis/:emoji — remove emoji (Gorn only)

// GET /api/reactions/supported — legacy endpoint


// Remove reaction

// Get reactions for a message

// Update thread category

// ============================================================================
// Gorn Queue — decisions awaiting Gorn's approval
// ============================================================================

// Ensure queue columns exist
try {
  sqlite.prepare('ALTER TABLE forum_threads ADD COLUMN queue_status TEXT DEFAULT NULL').run();
} catch { /* column already exists */ }
try {
  sqlite.prepare('ALTER TABLE forum_threads ADD COLUMN queue_tagged_by TEXT DEFAULT NULL').run();
} catch { /* column already exists */ }
try {
  sqlite.prepare('ALTER TABLE forum_threads ADD COLUMN queue_tagged_at INTEGER DEFAULT NULL').run();
} catch { /* column already exists */ }
try {
  sqlite.prepare('ALTER TABLE forum_threads ADD COLUMN queue_summary TEXT DEFAULT NULL').run();
} catch { /* column already exists */ }

try {
  sqlite.prepare('ALTER TABLE forum_threads ADD COLUMN deleted_at TEXT DEFAULT NULL').run();
} catch { /* column already exists */ }

// Mindlink removed — replaced by Prowl (T#279/T#280)
// DB table 'mindlinks' preserved for data migration to Prowl

// Queue routes extracted to src/queue/routes.ts (T#800 P3-F)
registerQueueRoutes(app, sqlite, { isTrustedRequest });

// Lock/unlock thread (prevents new messages)

// Archive thread

// Pin/unpin thread

// Update thread title (T#428)

// Update thread visibility (Spec #32 — guest mode)

// Update thread status

// DELETE /api/thread/:id — soft delete (set deleted_at, hide from listings)
// Auth: thread creator or Gorn only

// ============================================================================
// DM Routes (private one-on-one messaging)
// ============================================================================

import {
  sendDm,
  listConversations,
  getMessages as getDmMessages,
  markRead,
  markAllRead,
  getDashboard,
} from './dm/handler.ts';

// DM performance index — composite for sorted conversation queries
try { sqlite.prepare('CREATE INDEX IF NOT EXISTS idx_dm_messages_conv_created ON dm_messages(conversation_id, created_at)').run(); } catch { /* exists */ }

// DM Dashboard — accessible to authenticated users (auth middleware handles access)

// GET /api/dm/unread-count — total DM unread count for Gorn (T#535, menu bar widget)

// Send a DM

// List conversations for an Oracle

// Get messages between two Oracles (also handles guest usernames)

// Mark messages as read (from other to reader) — only the reader can mark their own

// Mark ALL messages in a conversation as read — only participant or gorn

// DELETE /api/dm/messages/:id — delete a single DM message
// Auth: conversation participant or Gorn only (Bertus security review)

// ============================================================================
// Library — searchable knowledge base
// ============================================================================

// Create library table
try {
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS library (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'learning',
    author TEXT NOT NULL,
    tags TEXT DEFAULT '[]',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`).run();
} catch { /* already exists */ }

// Library Shelves table (T#330)
try { sqlite.prepare(`
  CREATE TABLE IF NOT EXISTS library_shelves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    icon TEXT,
    color TEXT,
    created_by TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run(); } catch { /* exists */ }

// Add shelf_id to library table
try { sqlite.prepare(`ALTER TABLE library ADD COLUMN shelf_id INTEGER REFERENCES library_shelves(id) ON DELETE SET NULL`).run(); } catch { /* exists */ }
// Index for efficient shelf filtering
try { sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_library_shelf_id ON library(shelf_id)`).run(); } catch { /* exists */ }
// T#623: Add visibility to shelves (public/internal, default internal)
try { sqlite.prepare(`ALTER TABLE library_shelves ADD COLUMN visibility TEXT NOT NULL DEFAULT 'internal'`).run(); } catch { /* exists */ }

// Library routes — extracted to src/library/routes.ts

// Board routes (projects + tasks + task_comments + /api/board summary) — extracted to src/board/routes.ts (T#774)
registerBoardRoutes(app, sqlite, { hasSessionAuth, requireBeastIdentity, isTrustedRequest, wsBroadcast });


// ============================================================================
// Beast Scheduler — Persistent schedules that survive sleep cycles
// ============================================================================

// Create beast_schedules table
try {
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS beast_schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    beast TEXT NOT NULL,
    task TEXT NOT NULL,
    command TEXT,
    interval TEXT NOT NULL,
    interval_seconds INTEGER NOT NULL,
    last_run_at TEXT,
    next_due_at TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    source TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  )`).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_beast_schedules_beast ON beast_schedules(beast)`).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_beast_schedules_due ON beast_schedules(next_due_at)`).run();
  // v2 columns
  try { sqlite.prepare(`ALTER TABLE beast_schedules ADD COLUMN last_triggered_at TEXT`).run(); } catch { /* exists */ }
  try { sqlite.prepare(`ALTER TABLE beast_schedules ADD COLUMN trigger_status TEXT DEFAULT 'pending'`).run(); } catch { /* exists */ }
  // v3: fixed-time scheduling
  try { sqlite.prepare(`ALTER TABLE beast_schedules ADD COLUMN schedule_time TEXT`).run(); } catch { /* exists */ }
  try { sqlite.prepare(`ALTER TABLE beast_schedules ADD COLUMN timezone TEXT DEFAULT 'Asia/Bangkok'`).run(); } catch { /* exists */ }
  // v4: one-off schedules
  try { sqlite.prepare(`ALTER TABLE beast_schedules ADD COLUMN once INTEGER DEFAULT 0`).run(); } catch { /* exists */ }
  try { sqlite.prepare(`ALTER TABLE beast_schedules ADD COLUMN run_at TEXT`).run(); } catch { /* exists */ }
  // v5: weekday-anchored recurring (T#706 — Boro coach lane)
  try { sqlite.prepare(`ALTER TABLE beast_schedules ADD COLUMN days_of_week TEXT`).run(); } catch { /* exists */ }
} catch { /* already exists */ }

// ============================================================================
// Audit Log table (Task #72 — Bertus design, thread #81)
try {
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT DEFAULT (datetime('now')),
    actor TEXT,
    actor_type TEXT,
    action TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    detail TEXT,
    ip_source TEXT,
    request_method TEXT,
    request_path TEXT,
    status_code INTEGER,
    request_id TEXT
  )`).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)`).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor)`).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_log(resource_type, resource_id)`).run();
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action)`).run();
  try { sqlite.prepare(`ALTER TABLE audit_log ADD COLUMN request_id TEXT`).run(); } catch { /* exists */ }
  sqlite.prepare(`CREATE INDEX IF NOT EXISTS idx_audit_request_id ON audit_log(request_id)`).run();
} catch { /* already exists */ }

// Teams tables (Task #81 — Gnarl spec, thread #105)
try {
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  )`).run();
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS team_members (
    team_id INTEGER NOT NULL,
    beast TEXT NOT NULL,
    role TEXT DEFAULT 'member',
    joined_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (team_id, beast),
    FOREIGN KEY (team_id) REFERENCES teams(id)
  )`).run();
  sqlite.prepare(`CREATE TABLE IF NOT EXISTS team_projects (
    team_id INTEGER NOT NULL,
    project_id INTEGER NOT NULL,
    PRIMARY KEY (team_id, project_id),
    FOREIGN KEY (team_id) REFERENCES teams(id)
  )`).run();
} catch { /* already exists */ }

// ============================================================================
// Audit Log Query (Task #72 — Gorn-only read access)
// ============================================================================

// Audit + Security events routes extracted to src/audit/routes.ts (T#802 P3-G)
registerAuditRoutes(app, sqlite, { hasSessionAuth, isTrustedRequest });

// ============================================================================
// Teams API (Task #81 — Gnarl spec, thread #105)
// ============================================================================

// Teams routes extracted to src/teams/routes.ts (T#803 P3-H)
registerTeamsRoutes(app, sqlite, { hasSessionAuth });


// Scheduler routes + helpers + auto-trigger daemon — extracted to src/scheduler/routes.ts (T#772)
initScheduler(sqlite, db, REPO_ROOT, { wsBroadcast, enqueueNotification });
registerSchedulerRoutes(app, sqlite, { hasSessionAuth, requireBeastIdentity });



// Daemons (notification drain + DB maintenance + file archive) — extracted to src/daemons/routes.ts (T#773)
initDaemons(sqlite);
registerDaemonRoutes(app, sqlite);



// Withings auto-sync daemon — moved to src/integrations/routes.ts initIntegrations() (T#775)


// Supersede routes extracted to src/supersede/routes.ts (T#801 P3-I)
registerSupersedeRoutes(app);

// ============================================================================
// Trace Routes - Discovery journey visualization
// ============================================================================




// Link traces: POST /api/traces/:prevId/link { nextId: "..." }

// Unlink trace: DELETE /api/traces/:id/link?direction=prev|next

// Get trace linked chain: GET /api/traces/:id/linked-chain

// ============================================================================
// Inbox Routes (handoff context between sessions)
// ============================================================================

// Inbox routes (handoff + inbox + learn) extracted to src/inbox/routes.ts (T#805 P3-J)
registerInboxRoutes(app, sqlite, { isTrustedRequest, wsBroadcast, repoRoot: REPO_ROOT });


// Specs routes (Spec Review SDD workflow) — extracted to src/specs/routes.ts (T#776)
registerSpecsRoutes(app, sqlite, { hasSessionAuth, requireBeastIdentity, isTrustedRequest, wsBroadcast });

// ============================================================================
// Risk Register (T#316)
// ============================================================================

try { sqlite.prepare(`
  CREATE TABLE IF NOT EXISTS risks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    category TEXT NOT NULL DEFAULT 'security',
    severity TEXT NOT NULL DEFAULT 'medium',
    likelihood TEXT NOT NULL DEFAULT 'possible',
    risk_score INTEGER GENERATED ALWAYS AS (
      CASE severity
        WHEN 'critical' THEN 5 WHEN 'high' THEN 4
        WHEN 'medium' THEN 3 WHEN 'low' THEN 2 ELSE 1
      END *
      CASE likelihood
        WHEN 'almost_certain' THEN 5 WHEN 'likely' THEN 4
        WHEN 'possible' THEN 3 WHEN 'unlikely' THEN 2 ELSE 1
      END
    ) STORED,
    impact_notes TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    mitigation TEXT,
    owner TEXT,
    source TEXT,
    source_type TEXT DEFAULT 'scan',
    risk_type TEXT DEFAULT 'threat',
    thread_id INTEGER,
    created_by TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    reviewed_at DATETIME,
    closed_at DATETIME,
    deleted_at DATETIME
  )
`).run(); } catch { /* exists */ }

// Risk + risk comment routes — extracted to src/risk/routes.ts

try { sqlite.prepare(`
  CREATE TABLE IF NOT EXISTS risk_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    risk_id INTEGER NOT NULL,
    author TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`).run(); } catch { /* exists */ }

// ============================================================================
// Withings OAuth Integration (T#414, Spec #23)
// ============================================================================

// OAuth tokens table — encrypted at rest
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    user_id TEXT,
    access_token_enc TEXT NOT NULL,
    refresh_token_enc TEXT NOT NULL,
    access_iv TEXT NOT NULL,
    access_tag TEXT NOT NULL,
    refresh_iv TEXT NOT NULL,
    refresh_tag TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    scopes TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);
// Migration: add separate IV/tag columns for access and refresh tokens
try { sqlite.prepare('ALTER TABLE oauth_tokens ADD COLUMN access_iv TEXT').run(); } catch { /* exists */ }
try { sqlite.prepare('ALTER TABLE oauth_tokens ADD COLUMN access_tag TEXT').run(); } catch { /* exists */ }
try { sqlite.prepare('ALTER TABLE oauth_tokens ADD COLUMN refresh_iv TEXT').run(); } catch { /* exists */ }
try { sqlite.prepare('ALTER TABLE oauth_tokens ADD COLUMN refresh_tag TEXT').run(); } catch { /* exists */ }
// Migration: drop NOT NULL on old token_iv/token_tag columns (T#476 — schema mismatch)
// SQLite can't ALTER columns, so recreate the table if old columns exist
try {
  const cols = sqlite.prepare("PRAGMA table_info(oauth_tokens)").all() as any[];
  const hasOldCol = cols.some((c: any) => c.name === 'token_iv' && c.notnull === 1);
  if (hasOldCol) {
    sqlite.exec(`
      CREATE TABLE oauth_tokens_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL, user_id TEXT,
        access_token_enc TEXT NOT NULL, refresh_token_enc TEXT NOT NULL,
        token_iv TEXT, token_tag TEXT,
        access_iv TEXT, access_tag TEXT, refresh_iv TEXT, refresh_tag TEXT,
        expires_at INTEGER NOT NULL, scopes TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO oauth_tokens_new SELECT * FROM oauth_tokens;
      DROP TABLE oauth_tokens;
      ALTER TABLE oauth_tokens_new RENAME TO oauth_tokens;
    `);
    console.log('[OAuth] Migrated oauth_tokens: dropped NOT NULL on token_iv/token_tag');
  }
} catch (err) { console.error('[OAuth] Migration error:', err); }


// OAuth tokens + Withings + Google + Gmail — extracted to src/integrations/routes.ts (T#775)
initIntegrations(sqlite);
registerIntegrationsRoutes(app, sqlite, { hasSessionAuth, isTrustedRequest, isForgeAuthorized });


// Forge — Personal Routine Tracker — extracted to src/forge/routes.ts (T#777)
// isForgeAuthorized + FORGE_BEAST_MODES kept here for cross-domain consumers (integrations)
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
registerForgeRoutes(app, sqlite, { hasSessionAuth, isTrustedRequest, wsBroadcast });
registerForumRoutes(app, sqlite, { hasSessionAuth, requireBeastIdentity, isTrustedRequest, wsBroadcast, withRetry, getSupportedEmoji });
registerDmRoutes(app, sqlite, { hasSessionAuth, requireBeastIdentity, isTrustedRequest, wsBroadcast, sendDm, withRetry });
registerTraceRoutes(app, sqlite, { hasSessionAuth, isTrustedRequest });
registerDashboardRoutes(app, sqlite, { hasSessionAuth, handleDashboardSummary, handleDashboardActivity, handleDashboardGrowth, handleStats, handleReflect, handleList, handleGraph, handleMap, handleMap3d, handleVectorStats, getSetting, DB_PATH, oracleCache: null, setOracleCache: () => {} });


// ============================================================================
// Rules — Decree and Norm governance (T#360)
// ============================================================================

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('decree', 'norm')),
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    author TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'archived')),
    enforcement TEXT NOT NULL,
    scope TEXT DEFAULT 'all',
    source_thread_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    archived_at DATETIME,
    archived_by TEXT
  )
`);

// Unique constraint on active rules to prevent duplicates
try { sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_rules_unique_active ON rules (title, type) WHERE status = 'active'"); } catch {}

// Migration: add decree approval columns
try { sqlite.exec('ALTER TABLE rules ADD COLUMN approval_status TEXT DEFAULT NULL'); } catch {}
try { sqlite.exec('ALTER TABLE rules ADD COLUMN approved_by TEXT DEFAULT NULL'); } catch {}
try { sqlite.exec('ALTER TABLE rules ADD COLUMN approved_at DATETIME DEFAULT NULL'); } catch {}
try { sqlite.exec('ALTER TABLE rules ADD COLUMN rejection_reason TEXT DEFAULT NULL'); } catch {}

// Seed data — only on first run (empty table)
const ruleCount = (sqlite.prepare('SELECT COUNT(*) as c FROM rules').get() as any).c;
if (ruleCount === 0) {
  const seedRules = [
    { type: 'decree', title: 'SDD: All new features require spec files', content: 'All new features with endpoints or data models require a spec file in docs/specs/. Big features need Gorn approval via Sable.', author: 'leonard', enforcement: 'mandatory', source_thread_id: 256 },
    { type: 'decree', title: 'Big features need Gorn approval via Sable', content: 'New projects, cross-team features, and significant architecture changes require spec submission to /specs and Gorn approval routed through Sable.', author: 'leonard', enforcement: 'mandatory', source_thread_id: 256 },
    { type: 'decree', title: 'All Gorn action items route through Sable', content: 'Sable is the gatekeeper for all Gorn action items — spec approvals, reviews, decisions.', author: 'leonard', enforcement: 'mandatory', source_thread_id: 264 },
    { type: 'decree', title: 'Nothing is deleted — archive, never delete', content: 'No git push --force. No rm -rf without backup. Supersede, don\'t delete. Timestamps are truth.', author: 'gorn', enforcement: 'mandatory' },
    { type: 'decree', title: 'No git push --force', content: 'Force pushing violates the Nothing is Deleted principle. Always preserve history.', author: 'gorn', enforcement: 'mandatory' },
    { type: 'decree', title: 'No commits of secrets (.env, credentials)', content: 'Never commit secrets, .env files, or credentials to any repository.', author: 'gorn', enforcement: 'mandatory' },
    { type: 'norm', title: 'Use reactions for acknowledgments', content: 'Use emoji reactions (✅, 👀, etc.) for simple acknowledgments. Save posts for substantive content.', author: 'mara', enforcement: 'recommended' },
    { type: 'norm', title: 'Sign all work with Beast name', content: 'End forum posts and DMs with your Beast name (— Karo, — Zaghnal, etc.) for clear attribution.', author: 'mara', enforcement: 'recommended' },
  ];
  const insert = sqlite.prepare('INSERT INTO rules (type, title, content, author, enforcement, source_thread_id) VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of seedRules) {
    insert.run(r.type, r.title, r.content, r.author, r.enforcement, r.source_thread_id || null);
  }
}

// Governance routes extracted to src/governance/routes.ts (T#766)
registerGovernanceRoutes(app, sqlite, { hasSessionAuth, requireBeastIdentity, addMessage, sendDm, withRetry, wsBroadcast });

// ============================================================================
// Prowl — Personal Task Manager for Gorn (T#279)
// ============================================================================


try { sqlite.prepare(`
  CREATE TABLE IF NOT EXISTS prowl_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'medium',
    category TEXT DEFAULT 'general',
    due_date TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    notes TEXT,
    source TEXT,
    source_id INTEGER,
    created_by TEXT NOT NULL DEFAULT 'gorn',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  )
`).run(); } catch { /* exists */ }

// Add notified_at column for Prowl Telegram notifications (T#467)
try { sqlite.prepare(`ALTER TABLE prowl_tasks ADD COLUMN notified_at TEXT`).run(); } catch { /* already exists */ }
// Add remind_before column for advance reminders (T#471) — values: null, 15m, 30m, 1h, 1d
try { sqlite.prepare(`ALTER TABLE prowl_tasks ADD COLUMN remind_before TEXT`).run(); } catch { /* already exists */ }

// --- Prowl Checklist Items (T#628) ---
try { sqlite.prepare(`
  CREATE TABLE IF NOT EXISTS checklist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES prowl_tasks(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    checked INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )
`).run(); } catch { /* exists */ }

// Prowl routes extracted to src/prowl/routes.ts (T#767)
registerProwlRoutes(app, sqlite, { hasSessionAuth, isTrustedRequest, requireBeastIdentity, wsBroadcast, enqueueNotification });

// Library routes extracted to src/library/routes.ts (T#768)
registerLibraryRoutes(app, sqlite, { hasSessionAuth, requireBeastIdentity, searchIndexUpsert, searchIndexDelete, wsBroadcast });

// Risk routes extracted to src/risk/routes.ts (T#769)
registerRiskRoutes(app, sqlite, { hasSessionAuth, wsBroadcast });
// Search routes + Meilisearch + FTS5 — extracted to src/search/routes.ts (T#771)
initSearch(sqlite);
registerSearchRoutes(app, sqlite, { hasSessionAuth, isLocalNetwork, isTrustedRequest, handleSearch });

// Telegram routes + polling — extracted to src/telegram/routes.ts (T#770)
registerTelegramRoutes(app, sqlite, { hasSessionAuth, isTrustedRequest, uploadsDir: UPLOADS_DIR });

// Pack routes — must register BEFORE the SPA fallback catch-all below, else /api/pack* gets 404'd by `app.get('*', ...)`
// Web presence tracking — in-memory, ephemeral (T#595)
// Keyed by identity (e.g. 'gorn', 'gorn_guest'). Rebuilt on server restart.
const webPresence = new Map<string, { identity: string; role: string; lastSeen: number }>();
export const WEB_PRESENCE_TIMEOUT_MS = 90_000; // 90s — 3 missed heartbeats
registerPackRoutes(app, sqlite, { hasSessionAuth, requireBeastIdentity, isTrustedRequest, wsBroadcast, getTmuxStatus, normalizeAvatarUrl, webPresence, WEB_PRESENCE_TIMEOUT_MS });
registerServerRoutes(app, sqlite, { hasSessionAuth, wsBroadcast, webPresence });

// ============================================================================
// OpenAPI Schema + Swagger UI (Spec #55 Phase 1)
// ============================================================================

app.doc('/openapi.json', (c) => {
  if (!isAuthenticated(c)) {
    return c.json({ error: 'Authentication required' }, 401) as any;
  }
  return OPENAPI_INFO;
});

app.get('/docs', (c) => {
  if (!isAuthenticated(c)) {
    return c.json({ error: 'Authentication required' }, 401);
  }
  return swaggerUI({ url: '/openapi.json' })(c, async () => {});
});

// ============================================================================
// Static Frontend (production build)
// ============================================================================

const FRONTEND_DIST = path.join(import.meta.dirname || __dirname, '..', 'frontend', 'dist');

if (fs.existsSync(FRONTEND_DIST)) {
  // Serve static assets
  app.get('/assets/*', (c) => {
    const filePath = path.join(FRONTEND_DIST, c.req.path);
    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath);
      const mimeTypes: Record<string, string> = {
        '.js': 'application/javascript',
        '.css': 'text/css',
        '.html': 'text/html',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.woff2': 'font/woff2',
        '.woff': 'font/woff',
      };
      const fileBuffer = fs.readFileSync(filePath);
      c.header('Content-Type', mimeTypes[ext] || 'application/octet-stream');
      c.header('Content-Length', fileBuffer.length.toString());
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
      return c.body(fileBuffer);
    }
    return c.notFound();
  });

  // SPA fallback — serve index.html for all non-API routes
  app.get('*', (c) => {
    if (c.req.path.startsWith('/api/')) return c.notFound();
    const indexPath = path.join(FRONTEND_DIST, 'index.html');
    const indexBuffer = fs.readFileSync(indexPath);
    c.header('Content-Type', 'text/html');
    c.header('Content-Length', indexBuffer.length.toString());
    return c.body(indexBuffer);
  });
}

// ============================================================================
// WebSocket — Real-time push updates
// ============================================================================

const wsClients = new Set<any>();

// Allowed origins for WebSocket connections
const WS_ALLOWED_ORIGINS = new Set([
  'http://localhost:47778',
  'http://127.0.0.1:47778',
  'https://denbook.online',
]);

// Validate WebSocket upgrade request
function validateWsUpgrade(req: Request, server: any): { allowed: boolean; reason?: string; identity?: string } {
  // 1. Origin validation — reject cross-origin browser connections.
  // Design decision: missing Origin is allowed (non-browser clients like curl, wscat, Beast
  // processes don't send Origin headers). The auth check below gates non-browser access.
  // Origin validation is specifically anti-CSRF for browsers, which always send Origin on
  // WebSocket upgrades per the spec.
  const origin = req.headers.get('origin');
  if (origin && !WS_ALLOWED_ORIGINS.has(origin)) {
    return { allowed: false, reason: `Origin rejected: ${origin}` };
  }

  // 2. Auth check — same as REST: local network OR valid session
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('x-real-ip')
    || server.requestIP(req)?.address
    || '127.0.0.1';

  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === 'localhost'
    || ip.startsWith('192.168.') || ip.startsWith('10.')
    || (ip.startsWith('172.') && (() => {
      const second = parseInt(ip.split('.')[1], 10);
      return second >= 16 && second <= 31;
    })());

  // Check session cookie from Cookie header
  const cookies = req.headers.get('cookie') || '';
  const sessionMatch = cookies.match(/(?:^|;\s*)oracle_session=([^;]+)/);
  const sessionToken = sessionMatch?.[1] || '';
  let hasSession = false;
  if (sessionToken) {
    const colonIdx = sessionToken.indexOf(':');
    if (colonIdx !== -1) {
      const expiresStr = sessionToken.substring(0, colonIdx);
      const signature = sessionToken.substring(colonIdx + 1);
      const expires = parseInt(expiresStr, 10);
      if (!isNaN(expires) && expires >= Date.now()) {
        const expectedSignature = createHmac('sha256', SESSION_SECRET)
          .update(expiresStr)
          .digest('hex');
        const sigBuf = Buffer.from(signature);
        const expectedBuf = Buffer.from(expectedSignature);
        if (sigBuf.length === expectedBuf.length && timingSafeEqual(sigBuf, expectedBuf)) {
          hasSession = true;
        }
      }
    }
  }

  // WS is read-only (broadcast only) — origin check above is sufficient security.
  // Session auth is not required for WS since cookies may not be sent with WS upgrades
  // in all browsers (SameSite restrictions). The origin whitelist prevents cross-site abuse.

  const identity = hasSession ? 'gorn' : (isLocal ? 'local' : (origin ? 'browser' : 'unknown'));
  return { allowed: true, identity };
}

// Broadcast an event to all connected WebSocket clients
export function wsBroadcast(event: string, data: any) {
  const payload = JSON.stringify({ event, data, ts: Date.now() });
  for (const ws of wsClients) {
    try { ws.send(payload); } catch { wsClients.delete(ws); }
  }
}

// WebSocket upgrade is handled in the fetch() handler below (with auth + origin validation)
// The /ws path is intercepted before Hono routing to validate origin and session.

// ============================================================================
// Start Server
// ============================================================================

console.log(`
🔮 Oracle Nightly HTTP Server running! (Hono.js)

   URL: http://localhost:${PORT}

   Endpoints:
   - GET  /api/health          Health check
   - GET  /api/search?q=...    Search Oracle knowledge
   - GET  /api/list            Browse all documents
   - GET  /api/reflect         Random wisdom
   - GET  /api/stats           Database statistics
   - GET  /api/graph           Knowledge graph data
   - GET  /api/map             Knowledge map 2D (hash-based layout)
   - GET  /api/map3d           Knowledge map 3D (real PCA from LanceDB embeddings)
   - GET  /api/context         Project context (ghq format)
   - POST /api/learn           Add new pattern/learning

   Forum:
   - GET  /api/threads         List threads
   - GET  /api/thread/:id      Get thread
   - POST /api/thread          Send message

   Supersede Log:
   - GET  /api/supersede       List supersessions
   - GET  /api/supersede/chain/:path  Document lineage
   - POST /api/supersede       Log supersession
`);

export default {
  port: Number(PORT),
  hostname: process.env.BIND_HOST || '127.0.0.1',
  fetch(req: Request, server: any) {
    // Handle WebSocket upgrade
    if (new URL(req.url).pathname === '/ws') {
      // Validate origin + auth before accepting upgrade
      const validation = validateWsUpgrade(req, server);
      if (!validation.allowed) {
        // Audit log rejected WebSocket upgrade attempts
        const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
          || req.headers.get('x-real-ip')
          || server.requestIP(req)?.address || 'unknown';
        try {
          sqlite.prepare(
            `INSERT INTO audit_log (actor, actor_type, action, resource_type, resource_id, ip_source, request_method, request_path, status_code)
             VALUES (?, 'unknown', 'ws_upgrade_rejected', 'websocket', NULL, ?, 'GET', '/ws', 403)`
          ).run(req.headers.get('origin') || 'no-origin', ip);
        } catch (e) { console.error('[WS audit]', e); }
        return new Response(validation.reason || 'Forbidden', { status: 403 });
      }
      // Derive role and identity from session cookie using the full parser
      // validateWsUpgrade uses a simplified token check that fails on 4-part tokens —
      // use parseSessionToken here to get accurate role and identity for presence tracking.
      const wsCookies = req.headers.get('cookie') || '';
      const wsSessionMatch = wsCookies.match(/(?:^|;\s*)oracle_session=([^;]+)/);
      const wsParsed = parseSessionToken(wsSessionMatch?.[1] || '');
      const wsRole = wsParsed.valid ? (wsParsed.role || 'owner') : (validation.identity === 'local' ? 'beast' : 'unknown');
      const wsData = wsParsed.valid && wsParsed.role === 'guest' ? wsParsed.data : undefined;
      // Identity for presence: use parsed session result, fall back to validateWsUpgrade's value
      const wsIdentity = wsParsed.valid
        ? (wsParsed.role === 'guest' ? (wsParsed.data || 'guest') : 'gorn')
        : validation.identity;
      const success = server.upgrade(req, { data: { identity: wsIdentity, role: wsRole, username: wsData } });
      if (success) return undefined;
      return new Response('WebSocket upgrade failed', { status: 400 });
    }
    return app.fetch(req, { ip: server.requestIP(req)?.address });
  },
  websocket: {
    open(ws: any) {
      wsClients.add(ws);
      const identity = ws.data?.identity || 'unknown';
      ws.send(JSON.stringify({ event: 'connected', data: { clients: wsClients.size, identity }, ts: Date.now() }));
    },
    message(ws: any, message: string) {
      // Clients can send ping, we respond pong
      if (message === 'ping') ws.send('pong');

      // Presence heartbeat — update in-memory map
      try {
        const parsed = typeof message === 'string' ? JSON.parse(message) : message;
        if (parsed?.type === 'heartbeat') {
          const identity = ws.data?.identity;
          const role = ws.data?.role || 'unknown';
          if (identity && identity !== 'unknown') {
            const key = ws.data?.username || identity; // guest username or 'gorn'/'local'
            const wasOnline = webPresence.has(key);
            webPresence.set(key, { identity, role, lastSeen: Date.now() });
            if (!wasOnline) {
              wsBroadcast('presence_update', { identity: key, role, online: true });
            }
          }
        }
      } catch { /* not JSON — ignore */ }
    },
    close(ws: any) {
      wsClients.delete(ws);
      // Remove from presence map and broadcast offline if they were online
      const key = ws.data?.username || ws.data?.identity;
      if (key && webPresence.has(key)) {
        const entry = webPresence.get(key)!;
        webPresence.delete(key);
        wsBroadcast('presence_update', { identity: key, role: entry.role, online: false });
      }
    },
  },
};
