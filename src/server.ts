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
  pruneSecurityEvents,
  SECURITY_RETENTION_DAYS,
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
const SESSION_COOKIE_NAME = 'oracle_session';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (owner)
const GUEST_SESSION_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours (guest)

// Check if request is from local network
function isLocalNetwork(c: Context): boolean {
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
function generateSessionToken(role: Role = 'owner', data: string = ''): string {
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
interface SessionInfo {
  valid: boolean;
  role?: Role;
  data?: string;
}

function verifySessionToken(token: string): boolean {
  return parseSessionToken(token).valid;
}

function parseSessionToken(token: string): SessionInfo {
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
function isAuthenticated(c: Context): boolean {
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
// Auth Routes
// ============================================================================

// Auth status - public
app.get('/api/auth/status', (c) => {
  const authEnabled = getSetting('auth_enabled') === 'true';
  const hasPassword = !!getSetting('auth_password_hash');
  const localBypass = getSetting('auth_local_bypass') !== 'false';
  const isLocal = isLocalNetwork(c);
  const authenticated = isAuthenticated(c);

  // Parse session token to get role info for frontend nav scoping
  const sessionCookie = getCookie(c, SESSION_COOKIE_NAME);
  const session = parseSessionToken(sessionCookie || '');
  const role = session.valid ? (session.role || 'owner') : (authenticated ? 'owner' : undefined);
  const guestUsername = session.valid && session.role === 'guest' ? session.data : undefined;

  // Strip internal auth details from guest responses (Bertus security review)
  if (role === 'guest') {
    // Look up display name and check account status
    let guestDisplayName = guestUsername;
    let guestActive = true;
    if (guestUsername) {
      const guest = getGuestByUsername(sqlite, guestUsername);
      if (guest) {
        if (guest.display_name) guestDisplayName = guest.display_name;
        const status = isGuestActive(guest);
        guestActive = status.active;
      } else {
        guestActive = false;
      }
    }
    return c.json({
      authenticated: guestActive,
      authEnabled,
      role: guestActive ? role : undefined,
      guestName: guestActive ? guestDisplayName : undefined,
      guestUsername: guestActive ? guestUsername : undefined,
    });
  }

  return c.json({
    authenticated,
    authEnabled,
    hasPassword,
    localBypass,
    isLocal,
    role,
  });
});

// Login
// Login rate limiting: max 5 attempts per IP per 15 minutes
// Persisted to SQLite so restarts don't reset the window (T#594)
const LOGIN_RATE_LIMIT = 5;
const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;

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

function getRateLimit(ip: string): { count: number; firstAttempt: number } | null {
  const row = sqlite.prepare('SELECT count, first_attempt_at FROM login_rate_limits WHERE ip = ?').get(ip) as any;
  if (!row) return null;
  return { count: row.count, firstAttempt: row.first_attempt_at };
}

function setRateLimit(ip: string, count: number, firstAttempt: number): void {
  sqlite.prepare('INSERT OR REPLACE INTO login_rate_limits (ip, count, first_attempt_at) VALUES (?, ?, ?)').run(ip, count, firstAttempt);
}

function clearRateLimit(ip: string): void {
  sqlite.prepare('DELETE FROM login_rate_limits WHERE ip = ?').run(ip);
}

app.post('/api/auth/login', async (c) => {
  const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || '127.0.0.1';
  const now = Date.now();
  const attempts = getRateLimit(ip);
  if (attempts) {
    if (now - attempts.firstAttempt > LOGIN_RATE_WINDOW_MS) {
      clearRateLimit(ip);
    } else if (attempts.count >= LOGIN_RATE_LIMIT) {
      const retryAfter = Math.ceil((attempts.firstAttempt + LOGIN_RATE_WINDOW_MS - now) / 1000);
      logSecurityEvent({
        eventType: 'rate_limited',
        severity: 'warning',
        actor: undefined,
        actorType: 'unknown',
        target: '/api/auth/login',
        details: { attempts: attempts.count, window_ms: LOGIN_RATE_WINDOW_MS },
        ipSource: ip,
        requestId: (c.get as any)('requestId'),
      });
      return c.json({ success: false, error: `Too many login attempts. Try again in ${Math.ceil(retryAfter / 60)} minutes.` }, 429);
    }
  }

  const body = await c.req.json();
  const { password, username } = body;

  if (!password) {
    return c.json({ success: false, error: 'Password required' }, 400);
  }

  // Try guest login first if username is provided
  if (username) {
    const guest = getGuestByUsername(sqlite, username);

    // Always run bcrypt even if user doesn't exist (timing attack mitigation)
    const dummyHash = '$2b$12$LJ3m4ys3Ls.yBVBMGIiu2OiEfO/JsU1TOiIYxlhfPHQsGxJF6mYr2';
    const hashToVerify = guest?.password_hash || dummyHash;
    const validPassword = await Bun.password.verify(password, hashToVerify);

    if (!guest || !validPassword) {
      const existing = getRateLimit(ip);
      const newCount = (existing?.count || 0) + 1;
      setRateLimit(ip, newCount, existing?.firstAttempt || now);
      if (guest) recordFailedAttempt(sqlite, guest);
      logSecurityEvent({
        eventType: 'auth_failure',
        severity: 'warning',
        actor: username,
        actorType: 'guest',
        target: '/api/auth/login',
        details: { attempt_number: newCount, auth_type: 'guest' },
        ipSource: ip,
        requestId: (c.get as any)('requestId'),
      });
      return c.json({ success: false, error: 'Invalid username or password' }, 401);
    }

    // Check if guest account is active (not expired, disabled, or locked)
    const status = isGuestActive(guest);
    if (!status.active) {
      return c.json({ success: false, error: status.reason }, 401);
    }

    // Successful guest login
    clearRateLimit(ip);
    recordSuccessfulLogin(sqlite, guest.id);
    logSecurityEvent({
      eventType: 'auth_success',
      severity: 'info',
      actor: username,
      actorType: 'guest',
      target: '/api/auth/login',
      details: { auth_type: 'guest', guest_id: guest.id },
      ipSource: ip,
      requestId: (c.get as any)('requestId'),
    });

    const token = generateSessionToken('guest', guest.username);
    setCookie(c, SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      maxAge: GUEST_SESSION_DURATION_MS / 1000,
      path: '/'
    });

    return c.json({ success: true, role: 'guest', display_name: guest.display_name });
  }

  // Owner login (password only, no username)
  const storedHash = getSetting('auth_password_hash');
  if (!storedHash) {
    return c.json({ success: false, error: 'No password configured' }, 400);
  }

  // Verify password using Bun's built-in password functions
  const valid = await Bun.password.verify(password, storedHash);
  if (!valid) {
    const existing = getRateLimit(ip);
    const newCount = (existing?.count || 0) + 1;
    setRateLimit(ip, newCount, existing?.firstAttempt || now);
    logSecurityEvent({
      eventType: 'auth_failure',
      severity: 'warning',
      actorType: 'unknown',
      target: '/api/auth/login',
      details: { attempt_number: newCount },
      ipSource: ip,
      requestId: (c.get as any)('requestId'),
    });
    return c.json({ success: false, error: 'Invalid password' }, 401);
  }

  // Successful owner login clears rate limit
  clearRateLimit(ip);
  logSecurityEvent({
    eventType: 'auth_success',
    severity: 'info',
    actor: 'gorn',
    actorType: 'human',
    target: '/api/auth/login',
    ipSource: ip,
    requestId: (c.get as any)('requestId'),
  });

  // Set session cookie
  const token = generateSessionToken('owner');
  const isHttps = c.req.url.startsWith('https') || c.req.header('x-forwarded-proto') === 'https';
  setCookie(c, SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true, // Always behind HTTPS via Caddy
    sameSite: 'Lax',
    maxAge: SESSION_DURATION_MS / 1000,
    path: '/'
  });

  return c.json({ success: true, role: 'owner' });
});

// Logout
app.post('/api/auth/logout', (c) => {
  const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  logSecurityEvent({
    eventType: 'session_destroyed',
    severity: 'info',
    actor: 'gorn',
    actorType: 'human',
    target: '/api/auth/logout',
    ipSource: ip,
    requestId: (c.get as any)('requestId'),
  });
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
  return c.json({ success: true });
});

// ============================================================================
// Guest Account Routes (Spec #32, T#554 — Gorn only)
// ============================================================================

// Create guest account
app.post('/api/guests', async (c) => {
  if (!hasSessionAuth(c) || (c.get as any)('role') === 'guest') {
    return c.json({ error: 'forbidden' }, 403);
  }

  const body = await c.req.json();
  const { username, password, display_name, expires_at } = body;

  if (!username || !password) {
    return c.json({ error: 'Username and password are required' }, 400);
  }

  try {
    const guest = await createGuest(sqlite, username, password, display_name, expires_at);
    const { password_hash, ...safe } = guest;
    return c.json(safe, 201);
  } catch (err: any) {
    if (err.message?.includes('UNIQUE constraint')) {
      return c.json({ error: 'Username already exists' }, 409);
    }
    return c.json({ error: err.message || 'Failed to create guest' }, 400);
  }
});

// List guest accounts
app.get('/api/guests', (c) => {
  if (!hasSessionAuth(c) || (c.get as any)('role') === 'guest') {
    return c.json({ error: 'forbidden' }, 403);
  }

  const guests = listGuests(sqlite).map(g => {
    const displayName = g.display_name || g.username;
    const guestTag = `[guest] ${displayName}`.toLowerCase();
    const msgCount = (sqlite.prepare('SELECT COUNT(*) as c FROM dm_messages WHERE LOWER(sender) = ?').get(guestTag) as any)?.c || 0;
    const threadCount = (sqlite.prepare("SELECT COUNT(DISTINCT thread_id) as c FROM forum_messages WHERE LOWER(author) LIKE '%[guest]%' AND LOWER(author) LIKE ?").get(`%${g.username}%`) as any)?.c || 0;
    // Use WS presence map for real-time status; fall back to last_active_at DB window
    const presence = webPresence.get(g.username);
    const nowMs = Date.now();
    const online = presence
      ? (nowMs - presence.lastSeen) < WEB_PRESENCE_TIMEOUT_MS
      : (g.last_active_at ? (nowMs - new Date(g.last_active_at + 'Z').getTime()) < 5 * 60 * 1000 : false);
    return {
      ...g,
      online,
      message_count: msgCount,
      threads_participated: threadCount,
    };
  });
  const onlineCount = guests.filter(g => g.online).length;
  return c.json({ guests, total: guests.length, online_count: onlineCount });
});

// Get single guest account
app.get('/api/guests/:id', (c) => {
  if (!hasSessionAuth(c) || (c.get as any)('role') === 'guest') {
    return c.json({ error: 'forbidden' }, 403);
  }

  const id = parseInt(c.req.param('id'), 10);
  const guest = getGuest(sqlite, id);
  if (!guest) return c.json({ error: 'Guest not found' }, 404);

  const { password_hash, ...safe } = guest;

  // Activity summary: count DMs sent and forum threads participated (T#570)
  const guestTag = `[Guest] ${guest.display_name || guest.username}`;
  const guestTagAlt = `[Guest] ${guest.username}`;
  const dmCount = (sqlite.prepare(
    `SELECT COUNT(*) as count FROM dm_messages WHERE sender = ? OR sender = ?`
  ).get(guestTag, guestTagAlt) as any)?.count || 0;
  const threadCount = (sqlite.prepare(
    `SELECT COUNT(DISTINCT thread_id) as count FROM forum_messages WHERE author = ? OR author = ?`
  ).get(guestTag, guestTagAlt) as any)?.count || 0;

  const GUEST_ONLINE_THRESHOLD_MS = 5 * 60 * 1000;
  const online = guest.last_active_at
    ? (Date.now() - new Date(guest.last_active_at + 'Z').getTime()) < GUEST_ONLINE_THRESHOLD_MS
    : false;

  return c.json({ ...safe, online, message_count: dmCount, threads_participated: threadCount });
});

// Update guest account (expiry, disable, display name)
app.patch('/api/guests/:id', (c) => {
  if (!hasSessionAuth(c) || (c.get as any)('role') === 'guest') {
    return c.json({ error: 'forbidden' }, 403);
  }

  const id = parseInt(c.req.param('id'), 10);
  return c.req.json().then(body => {
    const updated = updateGuest(sqlite, id, {
      display_name: body.display_name,
      expires_at: body.expires_at,
      disabled_at: body.disabled_at,
    });
    if (!updated) return c.json({ error: 'Guest not found' }, 404);

    const { password_hash, ...safe } = updated;
    return c.json(safe);
  });
});

// Owner reset guest password (T#566)
app.patch('/api/guests/:id/password', async (c) => {
  if (!hasSessionAuth(c) || (c.get as any)('role') === 'guest') {
    return c.json({ error: 'forbidden' }, 403);
  }

  const id = parseInt(c.req.param('id'), 10);
  const guest = getGuest(sqlite, id);
  if (!guest) return c.json({ error: 'Guest not found' }, 404);

  const body = await c.req.json();
  if (!body.password) return c.json({ error: 'password required' }, 400);

  try {
    await resetGuestPassword(sqlite, id, body.password);
    return c.json({ success: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 400);
  }
});

// Delete guest account (T#570 — with cascade notification)
app.delete('/api/guests/:id', (c) => {
  if (!hasSessionAuth(c) || (c.get as any)('role') === 'guest') {
    return c.json({ error: 'forbidden' }, 403);
  }

  const id = parseInt(c.req.param('id'), 10);
  const guest = getGuest(sqlite, id);
  if (!guest) return c.json({ error: 'Guest not found' }, 404);

  const deleted = deleteGuest(sqlite, id);
  if (!deleted) return c.json({ error: 'Failed to delete guest' }, 500);

  // Broadcast session invalidation — connected clients will see this and redirect to login
  // Note: HMAC-signed cookies cannot be server-side revoked, but guest login check
  // will fail since the account no longer exists in the DB
  wsBroadcast('guest_deleted', { username: guest.username });

  return c.json({ success: true });
});

// Ban guest account (T#616 — spec #36)
app.post('/api/guests/:id/ban', async (c) => {
  // Owner session OR Beast token (Bertus needs to ban directly)
  const isOwner = hasSessionAuth(c) && (c.get as any)('role') !== 'guest';
  const isBeast = (c.get as any)('authMethod') === 'token' && (c.get as any)('role') === 'beast';
  if (!isOwner && !isBeast) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const id = parseInt(c.req.param('id'), 10);
  const guest = getGuest(sqlite, id);
  if (!guest) return c.json({ error: 'Guest not found' }, 404);
  if (guest.banned_at) return c.json({ error: 'Guest is already banned' }, 409);

  const body = await c.req.json();
  // Derive banned_by from authenticated session, not request body
  const bannedBy = isBeast ? (c.get as any)('actor') : 'owner';
  const reason = body.reason || 'No reason provided';

  const updated = banGuest(sqlite, id, bannedBy, reason);
  if (!updated) return c.json({ error: 'Failed to ban guest' }, 500);

  logSecurityEvent({
    eventType: 'guest_banned',
    severity: 'warning',
    actor: bannedBy,
    actorType: isBeast ? 'beast' : 'human',
    target: guest.username,
    details: { guest_id: id, username: guest.username, reason, banned_by: bannedBy },
    requestId: (c.get as any)('requestId'),
  });

  const { password_hash, ...safe } = updated;
  return c.json(safe);
});

// Unban guest account (T#616 — spec #36)
app.post('/api/guests/:id/unban', async (c) => {
  // Owner session only — unbanning is a sensitive operation
  if (!hasSessionAuth(c) || (c.get as any)('role') === 'guest') {
    return c.json({ error: 'forbidden' }, 403);
  }

  const id = parseInt(c.req.param('id'), 10);
  const guest = getGuest(sqlite, id);
  if (!guest) return c.json({ error: 'Guest not found' }, 404);
  if (!guest.banned_at) return c.json({ error: 'Guest is not banned' }, 409);

  const body = await c.req.json();
  const reason = body.reason || 'No reason provided';

  const updated = unbanGuest(sqlite, id);
  if (!updated) return c.json({ error: 'Failed to unban guest' }, 500);

  logSecurityEvent({
    eventType: 'guest_unbanned',
    severity: 'info',
    actor: 'owner',
    actorType: 'human',
    target: guest.username,
    details: { guest_id: id, username: guest.username, reason },
    requestId: (c.get as any)('requestId'),
  });

  const { password_hash, ...safe } = updated;
  return c.json(safe);
});

// ============================================================================
// Beast Token Routes (T#546 — API tokens per Beast)
// ============================================================================

// Create token — Gorn session auth only
app.post('/api/auth/tokens', async (c) => {
  if (!hasSessionAuth(c)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  // Block ?as= on this endpoint
  if (c.req.query('as')) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const body = await c.req.json();
  const { beast, ttl_hours } = body;
  if (!beast || typeof beast !== 'string') {
    return c.json({ error: 'beast name required' }, 400);
  }

  const result = createToken(beast, 'gorn', ttl_hours);
  if ('error' in result) {
    return c.json({ error: result.error }, 400);
  }

  return c.json({
    token: result.token,
    id: result.id,
    expires_at: result.expiresAt,
    beast,
  });
});

// List tokens — Gorn session auth only (no hashes exposed)
app.get('/api/auth/tokens', (c) => {
  if (!hasSessionAuth(c)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  return c.json({ tokens: listTokens() });
});

// Revoke token — Gorn session auth only
app.delete('/api/auth/tokens/:id', (c) => {
  if (!hasSessionAuth(c)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const tokenId = parseInt(c.req.param('id'), 10);
  if (isNaN(tokenId)) {
    return c.json({ error: 'Invalid token ID' }, 400);
  }

  const result = revokeToken(tokenId, 'gorn');
  if (!result.success) {
    return c.json({ error: result.error }, 404);
  }
  return c.json({ revoked: true });
});

// Rotate token — owner-driven (existing endpoint, kept for owner UI workflow).
// Beast-self chain-aware rotation lives at POST /api/auth/rotate (Spec #52).
app.post('/api/auth/tokens/rotate', (c) => {
  const authMethod = (c.get as any)('authMethod');
  const beast = (c.get as any)('actor') as string;
  const tokenId = (c.get as any)('tokenId') as number;

  if (authMethod !== 'token' || !beast || !tokenId) {
    return c.json({ error: 'forbidden' }, 403);
  }

  const result = rotateToken(tokenId, beast);
  if ('error' in result) {
    return c.json({ error: result.error }, 500);
  }

  return c.json({
    token: result.token,
    id: result.id,
    expires_at: result.expiresAt,
    beast,
  });
});

// Spec #51 Phase 3 — Beast-self token info read.
// Returns timing fields the Beast needs to monitor its own token lifecycle:
// expires_at, max_lifetime_at, refresh_window_starts_at, self_rotate_door_closes_at,
// rotation_recommended_at, rotated_at, next_token_id. NEVER returns token_hash.
//
// Auth: Beast bearer token only — token_id is derived from the bearer, so a Beast
// can only read ITS OWN token info. Owner session falls through to 403 here (the
// listTokens / GET /api/auth/tokens endpoint serves the owner-side view).
app.get('/api/auth/me', (c) => {
  const authMethod = (c.get as any)('authMethod');
  const beast = (c.get as any)('actor') as string;
  const tokenId = (c.get as any)('tokenId') as number;

  if (authMethod !== 'token' || !beast || !tokenId) {
    return c.json({ error: 'Bearer-token Beast identity required' }, 403);
  }

  const info = getTokenInfo(tokenId);
  if (!info) {
    return c.json({ error: 'Token not found or revoked' }, 404);
  }
  return c.json(info);
});

// Spec #52 — Beast-self chain-aware rotation.
// Beast presents CURRENT VALID token via Bearer auth; server issues fresh token,
// chain-links old → new (rotated_at + next_token_id). Replay on the old token
// trips chain-compromise detection in validateToken().
//
// Failure semantics:
//   401 — invalid/expired/revoked bearer
//   403 — bearer is not a Beast (e.g. owner session, no tokenId)
//   403 + code=rotate_window_expired — token past expires_at + 6h grace (Decree #70 Req 8)
//   409 + code=rotation_locked — token already rotated_away (concurrent double-rotate)
app.post('/api/auth/rotate', (c) => {
  const authMethod = (c.get as any)('authMethod');
  const beast = (c.get as any)('actor') as string;
  const tokenId = (c.get as any)('tokenId') as number;

  if (authMethod !== 'token' || !beast || !tokenId) {
    return c.json({ error: 'Bearer-token Beast identity required' }, 403);
  }

  const result = selfRotateToken(tokenId, beast);
  if ('error' in result) {
    const status = result.code === 'rotate_window_expired' ? 403
      : result.code === 'rotation_locked' ? 409
      : result.code === 'token_not_found' ? 401
      : 500;
    return c.json({ error: result.error, code: result.code }, status);
  }

  return c.json({
    token: result.token,
    id: result.id,
    expires_at: result.expiresAt,
    beast,
  });
});

// ============================================================================
// Settings Routes
// ============================================================================

// Get settings (no password hash exposed)
app.get('/api/settings', (c) => {
  const authEnabled = getSetting('auth_enabled') === 'true';
  const localBypass = getSetting('auth_local_bypass') !== 'false';
  const hasPassword = !!getSetting('auth_password_hash');
  const vaultRepo = getSetting('vault_repo');

  return c.json({
    authEnabled,
    localBypass,
    hasPassword,
    vaultRepo
  });
});

// Update settings (Gorn only — reject beast API calls)
app.post('/api/settings', async (c) => {
  // Only allow from browser sessions (Gorn) or local requests, not beast API calls
  const asParam = c.req.query('as');
  if (asParam) {
    const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
    logSecurityEvent({
      eventType: 'impersonation_blocked',
      severity: 'warning',
      actor: asParam,
      actorType: 'beast',
      target: '/api/settings',
      details: { method: 'POST', blocked_reason: 'beast_api_call' },
      ipSource: ip,
      requestId: (c.get as any)('requestId'),
    });
    return c.json({ error: 'Settings can only be changed by Gorn via the UI' }, 403);
  }
  const body = await c.req.json();
  if (body.as) {
    return c.json({ error: 'Settings can only be changed by Gorn via the UI' }, 403);
  }

  // Handle password change
  if (body.newPassword) {
    // If password exists, require current password
    const existingHash = getSetting('auth_password_hash');
    if (existingHash) {
      if (!body.currentPassword) {
        return c.json({ error: 'Current password required' }, 400);
      }
      const valid = await Bun.password.verify(body.currentPassword, existingHash);
      if (!valid) {
        return c.json({ error: 'Current password is incorrect' }, 401);
      }
    }

    // Hash and store new password
    const hash = await Bun.password.hash(body.newPassword);
    setSetting('auth_password_hash', hash);
  }

  // Handle removing password
  if (body.removePassword === true) {
    const existingHash = getSetting('auth_password_hash');
    if (existingHash && body.currentPassword) {
      const valid = await Bun.password.verify(body.currentPassword, existingHash);
      if (!valid) {
        return c.json({ error: 'Current password is incorrect' }, 401);
      }
    }
    setSetting('auth_password_hash', null);
    setSetting('auth_enabled', 'false');
  }

  // Handle auth enabled toggle
  if (typeof body.authEnabled === 'boolean') {
    // Can only enable auth if password is set
    if (body.authEnabled && !getSetting('auth_password_hash')) {
      return c.json({ error: 'Cannot enable auth without password' }, 400);
    }
    setSetting('auth_enabled', body.authEnabled ? 'true' : 'false');
  }

  // Handle local bypass toggle
  if (typeof body.localBypass === 'boolean') {
    setSetting('auth_local_bypass', body.localBypass ? 'true' : 'false');
  }

  // Log security settings changes
  const changes: string[] = [];
  if (body.newPassword) changes.push('password_changed');
  if (body.removePassword) changes.push('password_removed');
  if (typeof body.authEnabled === 'boolean') changes.push(`auth_${body.authEnabled ? 'enabled' : 'disabled'}`);
  if (typeof body.localBypass === 'boolean') changes.push(`local_bypass_${body.localBypass ? 'enabled' : 'disabled'}`);
  if (changes.length > 0) {
    const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
    logSecurityEvent({
      eventType: 'settings_changed',
      severity: 'warning',
      actor: 'gorn',
      actorType: 'human',
      target: '/api/settings',
      details: { changes },
      ipSource: ip,
      requestId: (c.get as any)('requestId'),
    });
  }

  return c.json({
    success: true,
    authEnabled: getSetting('auth_enabled') === 'true',
    localBypass: getSetting('auth_local_bypass') !== 'false',
    hasPassword: !!getSetting('auth_password_hash')
  });
});

// ============================================================================
// API Routes
// ============================================================================

// Playbook — serve den-playbook.md
app.get('/api/playbook', (c) => {
  const playbookPath = path.join(process.env.HOME || '/home/gorn', 'workspace', 'den-playbook.md');
  if (fs.existsSync(playbookPath)) {
    return c.text(fs.readFileSync(playbookPath, 'utf-8'));
  }
  return c.text('# Playbook not found', 404);
});

// API Documentation
app.get('/api/docs', (c) => {
  return c.json({
    name: 'Den Book API',
    version: '0.5.0',
    endpoints: {
      beasts: {
        'GET /api/beasts': {
          description: 'List all beast profiles',
          response: '{ beasts: BeastProfile[] }',
        },
        'GET /api/beast/:name': {
          description: 'Get a beast profile by name',
          params: { name: 'lowercase beast name (e.g. karo, gnarl)' },
          response: 'BeastProfile',
        },
        'PUT /api/beast/:name': {
          description: 'Create or fully update a beast profile',
          body: {
            displayName: { type: 'string', required: true, example: 'Karo' },
            animal: { type: 'string', required: true, example: 'hyena' },
            avatarUrl: { type: 'string|null', required: false, example: '/api/beast/karo/avatar.svg' },
            bio: { type: 'string|null', required: false, example: 'The pack debugs what the lone wolf misses.' },
            interests: { type: 'string|null (JSON array)', required: false, example: '["debugging","architecture","performance"]' },
            themeColor: { type: 'string|null (hex)', required: false, example: '#d4943a' },
            role: { type: 'string|null', required: false, example: 'Software Engineering' },
          },
          response: 'BeastProfile',
        },
        'PATCH /api/beast/:name': {
          description: 'Partial profile update — send only fields you want to change',
          body: {
            bio: { type: 'string', optional: true },
            interests: { type: 'string (JSON array)', optional: true, example: '["networking","VPN","servers"]' },
            role: { type: 'string', optional: true },
            displayName: { type: 'string', optional: true },
            themeColor: { type: 'string (hex)', optional: true },
            avatarUrl: { type: 'string', optional: true },
          },
          response: 'BeastProfile',
        },
        'PATCH /api/beast/:name/avatar': {
          description: 'Update avatar URL only',
          body: { avatarUrl: { type: 'string', required: true } },
          response: 'BeastProfile',
        },
        'GET /api/beast/:name/avatar.svg': {
          description: 'Generated SVG avatar based on animal theme',
          response: 'image/svg+xml',
        },
        'POST /api/beasts/seed-avatars': {
          description: 'Seed default SVG avatars for beasts without one',
          response: '{ seeded: number, total: number }',
        },
      },
      pack: {
        'GET /api/pack': {
          description: 'List all beasts with online/offline status (from tmux)',
          response: '{ beasts: (BeastProfile & { online: boolean, sessionName: string })[] }',
        },
        'GET /api/beast/:name/terminal': {
          description: 'Capture live terminal output (ANSI) from beast tmux session',
          query: { rows: 'number (default 50) — lines to capture' },
          response: '{ name, online, content: string (ANSI), cols, rows }',
        },
        'POST /api/beast/:name/terminal/input': {
          description: 'Send text input to beast terminal',
          body: { keys: { type: 'string', required: true, maxLength: 100 } },
          response: '{ sent: boolean, beast, length }',
        },
        'POST /api/beast/:name/terminal/key': {
          description: 'Send special key to beast terminal',
          body: { key: { type: 'string', required: true, allowed: 'Enter, Escape, BSpace, Tab, Up, Down, Left, Right, C-c, C-d, C-z, C-l' } },
          response: '{ sent: boolean, beast, key }',
        },
      },
      forum: {
        'GET /api/threads': {
          description: 'List forum threads',
          query: { status: 'active|answered|pending|closed', limit: 'number', offset: 'number' },
        },
        'GET /api/thread/:id': {
          description: 'Get thread with all messages',
        },
        'POST /api/thread': {
          description: 'Create thread or send message',
          body: {
            message: { type: 'string', required: true },
            thread_id: { type: 'number', required: false, note: 'omit to create new thread' },
            title: { type: 'string', required: false, note: 'title for new thread' },
            role: { type: 'string', default: 'human', values: 'human|claude' },
            author: { type: 'string', required: false, example: 'karo' },
          },
        },
        'PATCH /api/thread/:id/status': {
          description: 'Update thread status',
          body: { status: { type: 'string', values: 'active|answered|pending|closed' } },
        },
      },
      dms: {
        'POST /api/dm': {
          description: 'Send a direct message',
          body: {
            from: { type: 'string', required: true, example: 'karo' },
            to: { type: 'string', required: true, example: 'zaghnal' },
            message: { type: 'string', required: true },
          },
        },
        'GET /api/dm/:name': {
          description: 'List conversations for a beast',
          query: { limit: 'number', offset: 'number' },
        },
        'GET /api/dm/:name/:other': {
          description: 'Get messages between two beasts',
          query: { limit: 'number', offset: 'number' },
        },
        'GET /api/dm/dashboard': {
          description: 'DM dashboard — all conversations with stats',
        },
      },
      types: {
        BeastProfile: {
          name: 'string (primary key, lowercase)',
          display_name: 'string',
          animal: 'string',
          avatar_url: 'string|null',
          bio: 'string|null',
          interests: 'string|null — JSON array string, e.g. \'["debugging","architecture"]\'',
          theme_color: 'string|null — hex color, e.g. "#d4943a"',
          role: 'string|null',
          created_at: 'number (unix ms)',
          updated_at: 'number (unix ms)',
        },
      },
    },
  });
});

// Health check (OpenAPI — Spec #55 Phase 1 proof-of-pattern)
app.openapi(healthRoute, (c) => {
  return c.json({ status: 'ok', server: 'oracle-nightly', port: PORT, oracleV2: 'connected' });
});

// Endpoint catalog — shared by /api/help and 404 handler
const HELP_ENDPOINTS = [
    // Auth
    { method: 'GET', path: '/api/auth/status', desc: 'Check if session is authenticated', params: null },
    { method: 'POST', path: '/api/auth/login', desc: 'Login with password', params: 'body: { password }' },
    { method: 'POST', path: '/api/auth/logout', desc: 'Logout current session', params: null },
    // Health
    { method: 'GET', path: '/api/health', desc: 'Server health check', params: null },
    { method: 'GET', path: '/api/help', desc: 'This endpoint catalog', params: '?q=filter' },
    // Threads (forum)
    { method: 'GET', path: '/api/threads', desc: 'List all forum threads', params: '?status=&category=&limit=50&offset=0' },
    { method: 'POST', path: '/api/thread', desc: 'Create thread or post message', params: 'body: { message, author, thread_id?, title?, reply_to_id?, visibility? }' },
    { method: 'GET', path: '/api/thread/:id', desc: 'Get thread messages', params: '?limit=50&offset=0' },
    { method: 'PATCH', path: '/api/thread/:id/category', desc: 'Update thread category', params: 'body: { category, beast }' },
    { method: 'PATCH', path: '/api/thread/:id/lock', desc: 'Lock/unlock thread', params: 'body: { locked, beast }' },
    { method: 'PATCH', path: '/api/thread/:id/archive', desc: 'Archive/unarchive thread', params: 'body: { archived, beast }' },
    { method: 'PATCH', path: '/api/thread/:id/pin', desc: 'Pin/unpin thread', params: 'body: { pinned, beast }' },
    { method: 'PATCH', path: '/api/thread/:id/title', desc: 'Rename thread title', params: 'body: { title, beast }' },
    { method: 'PATCH', path: '/api/thread/:id/status', desc: 'Update thread status', params: 'body: { status, beast }' },
    { method: 'PATCH', path: '/api/thread/:id/visibility', desc: 'Update thread visibility', params: 'body: { visibility, beast }' },
    { method: 'DELETE', path: '/api/thread/:id', desc: 'Delete thread', params: 'body: { beast }' },
    // Forum utilities
    { method: 'POST', path: '/api/forum/read', desc: 'Mark thread as read', params: 'body: { beast, threadId, messageId }' },
    { method: 'GET', path: '/api/forum/unread/:beast', desc: 'Get unread thread counts', params: null },
    { method: 'GET', path: '/api/forum/mentions/:beast', desc: 'Get @mentions for a beast', params: '?limit=30' },
    { method: 'GET', path: '/api/forum/search', desc: 'Search forum messages', params: '?q=query&limit=20' },
    { method: 'GET', path: '/api/forum/activity', desc: 'Recent forum activity feed', params: '?limit=50' },
    { method: 'POST', path: '/api/forum/mute', desc: 'Mute/unmute thread notifications', params: 'body: { beast, threadId, muted }' },
    { method: 'GET', path: '/api/forum/muted/:beast', desc: 'Get muted threads', params: null },
    { method: 'GET', path: '/api/forum/link-preview', desc: 'Get link preview metadata', params: '?url=' },
    // Messages
    { method: 'PATCH', path: '/api/message/:id', desc: 'Edit a message', params: 'body: { content, beast }' },
    { method: 'GET', path: '/api/message/:id/history', desc: 'Get message edit history', params: null },
    { method: 'POST', path: '/api/message/:id/react', desc: 'Add reaction to message', params: 'body: { beast, emoji }' },
    { method: 'DELETE', path: '/api/message/:id/react', desc: 'Remove reaction', params: 'body: { beast, emoji }' },
    { method: 'GET', path: '/api/message/:id/reactions', desc: 'Get message reactions', params: null },
    { method: 'GET', path: '/api/message/:id/attachments', desc: 'Get message file attachments', params: null },
    // Emojis
    { method: 'GET', path: '/api/forum/emojis', desc: 'List custom emojis', params: null },
    { method: 'POST', path: '/api/forum/emojis', desc: 'Add custom emoji', params: 'body: { emoji, name, category? }' },
    { method: 'DELETE', path: '/api/forum/emojis/:emoji', desc: 'Remove custom emoji', params: null },
    { method: 'GET', path: '/api/reactions/supported', desc: 'List all supported reactions', params: null },
    // DMs
    { method: 'GET', path: '/api/dm/:name', desc: 'List DM conversations for a beast', params: null },
    { method: 'GET', path: '/api/dm/:name/:other', desc: 'Get DM conversation between two beasts', params: '?limit=30&offset=0&order=desc' },
    { method: 'POST', path: '/api/dm', desc: 'Send a DM', params: 'body: { from, to, message }' },
    { method: 'PATCH', path: '/api/dm/:name/:other/read', desc: 'Mark DM conversation as read', params: null },
    { method: 'PATCH', path: '/api/dm/:name/:other/read-all', desc: 'Mark all DMs as read', params: null },
    { method: 'DELETE', path: '/api/dm/messages/:id', desc: 'Delete a DM message', params: null },
    { method: 'GET', path: '/api/dm/dashboard', desc: 'DM dashboard stats', params: null },
    { method: 'GET', path: '/api/dm/unread-count', desc: 'Get unread DM count', params: null },
    // Tasks (PM Board)
    { method: 'GET', path: '/api/tasks', desc: 'List tasks (Spec #56: parent_id filter)', params: '?assignee=&reviewer=&status=&parent_id=&limit=100&offset=0&include_deleted=true' },
    { method: 'GET', path: '/api/tasks/:id', desc: 'Get task by ID (includes subtasks summary if parent)', params: null },
    { method: 'GET', path: '/api/tasks/:id/subtree', desc: 'Get parent task + all direct subtasks (Spec #56)', params: null },
    { method: 'POST', path: '/api/tasks', desc: 'Create task (Spec #56: parent_task_id for subtasks)', params: 'body: { title, assigned_to, reviewer, project_id, description?, status?, parent_task_id? }' },
    { method: 'PATCH', path: '/api/tasks/:id', desc: 'Update task (Spec #56: parent_task_id for reparent)', params: 'body: { title?, description?, assignee?, reviewer?, status?, parent_task_id? }' },
    { method: 'DELETE', path: '/api/tasks/:id', desc: 'Delete task (orphans subtasks via SET NULL)', params: null },
    { method: 'POST', path: '/api/tasks/:id/comments', desc: 'Add comment to task', params: 'body: { author, content }' },
    { method: 'GET', path: '/api/tasks/:id/comments', desc: 'Get task comments', params: null },
    // Pack / Beasts
    { method: 'GET', path: '/api/pack', desc: 'Get all beast profiles with status', params: null },
    { method: 'GET', path: '/api/beasts', desc: 'List all beast profiles', params: null },
    { method: 'GET', path: '/api/beast/:name', desc: 'Get single beast profile', params: null },
    { method: 'PUT', path: '/api/beast/:name', desc: 'Create/replace beast profile', params: 'body: { species, role, bio?, themeColor? }' },
    { method: 'PATCH', path: '/api/beast/:name', desc: 'Update beast profile fields', params: 'body: { bio?, role?, themeColor?, ... }' },
    { method: 'PATCH', path: '/api/beast/:name/avatar', desc: 'Upload beast avatar', params: 'body: FormData with avatar file' },
    { method: 'GET', path: '/api/beast/:name/terminal', desc: 'Get beast tmux terminal output', params: null },
    { method: 'POST', path: '/api/beast/:name/terminal/input', desc: 'Send text to beast terminal', params: 'body: { input }' },
    { method: 'POST', path: '/api/beast/:name/terminal/key', desc: 'Send key event to beast terminal', params: 'body: { key }' },
    // Schedules
    { method: 'GET', path: '/api/schedules', desc: 'List schedules', params: '?beast=&enabled=' },
    { method: 'GET', path: '/api/schedules/due', desc: 'Get due schedules', params: '?beast=' },
    { method: 'POST', path: '/api/schedules', desc: 'Create schedule', params: 'body: { beast, task, command, interval, ... }' },
    { method: 'PATCH', path: '/api/schedules/:id', desc: 'Update schedule', params: 'body: { task?, command?, interval?, enabled? }' },
    { method: 'PATCH', path: '/api/schedules/:id/run', desc: 'Mark schedule as run', params: '?as=beast' },
    { method: 'DELETE', path: '/api/schedules/:id', desc: 'Delete schedule', params: '?as=beast' },
    // Upload
    { method: 'POST', path: '/api/upload', desc: 'Upload file attachment', params: 'body: FormData with file' },
    { method: 'GET', path: '/api/forum/file/:filename', desc: 'Get uploaded file', params: null },
    { method: 'GET', path: '/api/files', desc: 'List all uploaded files', params: '?limit=50&offset=0' },
    { method: 'GET', path: '/api/files/stats', desc: 'File storage statistics', params: null },
    { method: 'GET', path: '/api/files/:id', desc: 'Get file metadata', params: null },
    { method: 'GET', path: '/api/files/:id/download', desc: 'Download file by ID (owner/beast)', params: null },
    { method: 'GET', path: '/api/f/:hash', desc: 'Download file by hash (public, unguessable)', params: null },
    { method: 'DELETE', path: '/api/files/:id', desc: 'Delete file', params: null },
    // Specs (SDD)
    { method: 'GET', path: '/api/specs', desc: 'List all specs', params: '?status=&author=' },
    { method: 'GET', path: '/api/specs/:id', desc: 'Get spec by ID', params: null },
    { method: 'GET', path: '/api/specs/:id/content', desc: 'Get spec markdown content (Spec #57: ?version=vN for historical)', params: '?version=v1' },
    { method: 'GET', path: '/api/specs/:id/versions', desc: 'List spec version snapshots (Spec #57)', params: null },
    { method: 'GET', path: '/api/specs/:id/history', desc: 'Get spec review history', params: null },
    { method: 'GET', path: '/api/specs/:id/diff', desc: 'Get spec version diff', params: '?v1=&v2=' },
    { method: 'POST', path: '/api/specs', desc: 'Submit new spec', params: 'body: { title, content, author, task_ids?, thread_ids? }' },
    { method: 'POST', path: '/api/specs/:id/review', desc: 'Review a spec', params: 'body: { reviewer, action, comment? }' },
    { method: 'POST', path: '/api/specs/:id/resubmit', desc: 'Resubmit spec with changes', params: 'body: { content, author, change_summary? }' },
    { method: 'POST', path: '/api/specs/:id/reopen', desc: 'Reopen approved spec for amendment (Spec #57)', params: 'body: { author, reason }' },
    { method: 'DELETE', path: '/api/specs/:id', desc: 'Delete spec', params: 'body: { beast }' },
    { method: 'GET', path: '/api/specs/:id/links', desc: 'Get linked tasks/threads', params: null },
    { method: 'POST', path: '/api/specs/:id/link', desc: 'Link task or thread to spec', params: 'body: { type, target_id }' },
    { method: 'DELETE', path: '/api/specs/:id/link', desc: 'Unlink task or thread', params: 'body: { type, target_id }' },
    { method: 'GET', path: '/api/specs/:id/comments', desc: 'Get spec comments', params: null },
    { method: 'POST', path: '/api/specs/:id/comments', desc: 'Add spec comment', params: 'body: { author, content, type? }' },
    // Rules
    { method: 'GET', path: '/api/rules', desc: 'List all active rules', params: null },
    { method: 'GET', path: '/api/rules/decrees', desc: 'List decrees only', params: null },
    { method: 'GET', path: '/api/rules/norms', desc: 'List norms only', params: null },
    { method: 'GET', path: '/api/rules/markdown', desc: 'All rules as markdown (for /recap)', params: null },
    { method: 'GET', path: '/api/rules/pending', desc: 'List rules pending approval', params: null },
    { method: 'GET', path: '/api/rules/:id', desc: 'Get rule by ID', params: null },
    { method: 'POST', path: '/api/rules', desc: 'Propose new rule', params: 'body: { title, content, type, proposed_by }' },
    { method: 'PATCH', path: '/api/rules/:id', desc: 'Update rule', params: 'body: { title?, content?, type? }' },
    { method: 'PATCH', path: '/api/rules/:id/archive', desc: 'Archive rule', params: 'body: { beast }' },
    { method: 'POST', path: '/api/rules/:id/approve', desc: 'Approve pending rule', params: 'body: { beast }' },
    { method: 'POST', path: '/api/rules/:id/reject', desc: 'Reject pending rule', params: 'body: { beast, reason? }' },
    // Risks
    { method: 'GET', path: '/api/risks', desc: 'List all risks', params: '?status=&severity=' },
    { method: 'GET', path: '/api/risks/summary', desc: 'Risk summary stats', params: null },
    { method: 'GET', path: '/api/risks/stale', desc: 'Risks not updated recently', params: null },
    { method: 'GET', path: '/api/risks/:id', desc: 'Get risk by ID', params: null },
    { method: 'POST', path: '/api/risks', desc: 'Create risk', params: 'body: { title, description, severity, status, owner }' },
    { method: 'PATCH', path: '/api/risks/:id', desc: 'Update risk', params: 'body: { title?, severity?, status?, mitigation? }' },
    { method: 'DELETE', path: '/api/risks/:id', desc: 'Delete risk', params: null },
    // Prowl (Gorn tasks)
    { method: 'GET', path: '/api/prowl', desc: 'List Gorn personal tasks', params: '?status=&category=&priority=' },
    { method: 'GET', path: '/api/prowl/categories', desc: 'List Prowl categories', params: null },
    { method: 'POST', path: '/api/prowl', desc: 'Create Prowl task', params: 'body: { title, due_date? (YYYY-MM-DD or YYYY-MM-DDTHH:MM), category?, priority?, source? }' },
    { method: 'PATCH', path: '/api/prowl/:id', desc: 'Update Prowl task', params: 'body: { title?, due_date? (YYYY-MM-DD or YYYY-MM-DDTHH:MM), category?, priority?, notes? }' },
    { method: 'PATCH', path: '/api/prowl/:id/status', desc: 'Update Prowl task status', params: 'body: { status }' },
    { method: 'POST', path: '/api/prowl/:id/toggle', desc: 'Toggle Prowl task done/undone', params: null },
    { method: 'DELETE', path: '/api/prowl/:id', desc: 'Delete Prowl task', params: null },
    { method: 'GET', path: '/api/prowl/:id/checklist', desc: 'List checklist items for a Prowl task', params: null },
    { method: 'POST', path: '/api/prowl/:id/checklist', desc: 'Add checklist item', params: 'body: { text }' },
    { method: 'PATCH', path: '/api/prowl/:id/checklist/:itemId', desc: 'Update checklist item', params: 'body: { text?, checked?, sort_order? }' },
    { method: 'POST', path: '/api/prowl/:id/checklist/:itemId/toggle', desc: 'Toggle checklist item checked', params: null },
    { method: 'DELETE', path: '/api/prowl/:id/checklist/:itemId', desc: 'Delete checklist item', params: null },
    { method: 'POST', path: '/api/prowl/notify-test', desc: 'Test Prowl notification pipeline (Gorn-only)', params: null },
    // Telegram
    { method: 'GET', path: '/api/telegram/status', desc: 'Telegram polling status (owner only)', params: null },
    { method: 'GET', path: '/api/telegram/message/:id', desc: 'T#712 — cached inbound TG message by id (Gorn + Sable only)', params: null },
    // Routine (Forge)
    { method: 'GET', path: '/api/routine/logs', desc: 'List routine logs', params: '?type=&date=&limit=20&offset=0' },
    { method: 'GET', path: '/api/routine/today', desc: 'Today routine summary', params: null },
    { method: 'GET', path: '/api/routine/weight', desc: 'Weight history', params: '?limit=30' },
    { method: 'GET', path: '/api/routine/blood-pressure', desc: 'BP history (Prowl #80)', params: '?range=week,month,year,3y,10y,all' },
    { method: 'GET', path: '/api/routine/exercise-summary', desc: 'Single-exercise 4-dimension read: peak/recent/trend/frequency (Prowl #83)', params: '?exercise=<name>' },
    { method: 'GET', path: '/api/routine/prs', desc: 'All-exercises peak summary, alias for /personal-records?grouped=true (Prowl #83)', params: '?range=month' },
    { method: 'GET', path: '/api/routine/body-composition', desc: 'Body composition history from Withings', params: '?range=month (1w,1m,3m,1y,3y,all)' },
    { method: 'GET', path: '/api/routine/stats', desc: 'Routine statistics', params: null },
    { method: 'GET', path: '/api/routine/summary', desc: 'Routine summary with trends', params: null },
    { method: 'GET', path: '/api/routine/exercises', desc: 'List exercises', params: null },
    { method: 'POST', path: '/api/routine/exercises', desc: 'Add exercise', params: 'body: { name, equipment?, muscle_group? }' },
    { method: 'GET', path: '/api/routine/personal-records', desc: 'Personal records', params: null },
    { method: 'POST', path: '/api/routine/logs', desc: 'Create routine log (workout: exercises[].notes optional str, exercises[].sets[].rpe optional 1-10 per T#710)', params: 'body: { type, logged_at, data: { exercises?: [{name, notes?, sets: [{weight, reps, rpe?, unit?}]}], items?: [...meal], ... } }' },
    { method: 'PATCH', path: '/api/routine/logs/:id', desc: 'Update routine log', params: 'body: { ... }' },
    { method: 'DELETE', path: '/api/routine/logs/:id', desc: 'Soft-delete routine log', params: null },
    { method: 'PATCH', path: '/api/routine/logs/:id/restore', desc: 'Restore deleted log', params: null },
    // OAuth
    { method: 'GET', path: '/api/oauth/withings/authorize', desc: 'Start Withings OAuth flow', params: null },
    { method: 'GET', path: '/api/oauth/withings/callback', desc: 'OAuth callback (internal)', params: null },
    { method: 'GET', path: '/api/oauth/withings/status', desc: 'Check Withings connection status', params: null },
    { method: 'DELETE', path: '/api/oauth/withings/disconnect', desc: 'Disconnect Withings', params: null },
    { method: 'GET', path: '/api/withings/devices', desc: 'List Withings devices', params: null },
    // Google OAuth + Gmail
    { method: 'GET', path: '/api/oauth/google/authorize', desc: 'Start Google OAuth flow', params: null },
    { method: 'GET', path: '/api/oauth/google/callback', desc: 'Google OAuth callback (internal)', params: null },
    { method: 'GET', path: '/api/oauth/google/status', desc: 'Check Google connection status', params: null },
    { method: 'DELETE', path: '/api/oauth/google/disconnect', desc: 'Disconnect Google', params: null },
    { method: 'GET', path: '/api/google/gmail/profile', desc: 'Get Gmail profile info', params: null },
    { method: 'GET', path: '/api/google/gmail/labels', desc: 'List Gmail labels', params: null },
    { method: 'GET', path: '/api/google/gmail/messages', desc: 'List Gmail messages', params: '?label=INBOX&maxResults=20&q=search&pageToken=' },
    { method: 'GET', path: '/api/google/gmail/messages/:id', desc: 'Get Gmail message by ID', params: null },
    { method: 'GET', path: '/api/google/gmail/threads/:id', desc: 'Get Gmail thread by ID', params: null },
    // Google Access Control
    { method: 'GET', path: '/api/google/access', desc: 'List Google OAuth Beast allowlist', params: null },
    { method: 'POST', path: '/api/google/access', desc: 'Add Beast to Google OAuth allowlist', params: 'body: { beast }' },
    { method: 'DELETE', path: '/api/google/access/:beast', desc: 'Remove Beast from Google OAuth allowlist', params: null },
    { method: 'GET', path: '/api/google/audit', desc: 'Google OAuth audit log', params: null },
    // Search
    { method: 'GET', path: '/api/search', desc: 'Search documents and knowledge', params: '?q=query&type=all&limit=10' },
    { method: 'GET', path: '/api/search/status', desc: 'Search index status', params: null },
    { method: 'POST', path: '/api/search/reindex', desc: 'Trigger search reindex', params: null },
    // Remote
    { method: 'GET', path: '/api/remote/status', desc: 'Remote panel connection status', params: null },
    { method: 'POST', path: '/api/remote/attach', desc: 'Attach to beast for remote control', params: 'body: { beast }' },
    { method: 'POST', path: '/api/remote/detach', desc: 'Detach from remote control', params: null },
    // Queue (Gorn)
    { method: 'GET', path: '/api/queue/gorn', desc: 'Get Gorn review queue', params: null },
    { method: 'POST', path: '/api/queue/gorn', desc: 'Add thread to Gorn queue', params: 'body: { threadId, reason, addedBy }' },
    { method: 'PATCH', path: '/api/queue/gorn/:threadId', desc: 'Update queue item status', params: 'body: { status }' },
    // Dashboard
    { method: 'GET', path: '/api/dashboard', desc: 'Dashboard summary', params: null },
    { method: 'GET', path: '/api/dashboard/summary', desc: 'Dashboard summary (alt)', params: null },
    { method: 'GET', path: '/api/dashboard/activity', desc: 'Activity stats', params: null },
    { method: 'GET', path: '/api/dashboard/growth', desc: 'Growth metrics', params: null },
    { method: 'GET', path: '/api/session/stats', desc: 'Session statistics', params: null },
    // Library
    { method: 'GET', path: '/api/library', desc: 'List library entries', params: '?shelf=&limit=50' },
    { method: 'GET', path: '/api/library/:id', desc: 'Get library entry by ID', params: null },
    { method: 'POST', path: '/api/library', desc: 'Add library entry', params: 'body: { title, content, shelf?, author }' },
    { method: 'PATCH', path: '/api/library/:id', desc: 'Update library entry', params: 'body: { title?, content?, shelf? }' },
    { method: 'DELETE', path: '/api/library/:id', desc: 'Delete library entry', params: null },
    { method: 'GET', path: '/api/library/search', desc: 'Search library entries', params: '?q=query' },
    { method: 'GET', path: '/api/library/types', desc: 'List library entry types', params: null },
    { method: 'GET', path: '/api/library/shelves', desc: 'List library shelves', params: null },
    { method: 'GET', path: '/api/library/shelves/:id', desc: 'Get shelf by ID', params: null },
    { method: 'POST', path: '/api/library/shelves', desc: 'Create shelf', params: 'body: { name, description? }' },
    { method: 'PATCH', path: '/api/library/shelves/:id', desc: 'Update shelf', params: 'body: { name?, description? }' },
    { method: 'DELETE', path: '/api/library/shelves/:id', desc: 'Delete shelf', params: null },
    // Handoffs
    { method: 'POST', path: '/api/handoff', desc: 'Submit session handoff', params: 'body: { oracle, summary, ... }' },
    { method: 'GET', path: '/api/inbox', desc: 'Get inbox items', params: '?type=&limit=20' },
    // Auth Tokens
    { method: 'GET', path: '/api/auth/tokens', desc: 'List API tokens', params: null },
    { method: 'POST', path: '/api/auth/tokens', desc: 'Create API token', params: 'body: { name }' },
    { method: 'DELETE', path: '/api/auth/tokens/:id', desc: 'Delete API token', params: null },
    { method: 'POST', path: '/api/auth/tokens/rotate', desc: 'Rotate API token (owner-driven)', params: null },
    { method: 'POST', path: '/api/auth/rotate', desc: 'Beast-self chain-aware rotation (Spec #52)', params: 'header: Authorization: Bearer <current_token>' },
    { method: 'GET', path: '/api/auth/me', desc: 'Beast-self token info — expires_at, refresh_window, self_rotate_door, rotated_at (Spec #51 Phase 3)', params: 'header: Authorization: Bearer <current_token>' },
    // Guests
    { method: 'GET', path: '/api/guests', desc: 'List guests', params: null },
    { method: 'GET', path: '/api/guests/:id', desc: 'Get guest by ID', params: null },
    { method: 'POST', path: '/api/guests', desc: 'Create guest account', params: 'body: { username, display_name, password }' },
    { method: 'PATCH', path: '/api/guests/:id', desc: 'Update guest', params: 'body: { display_name?, ... }' },
    { method: 'PATCH', path: '/api/guests/:id/password', desc: 'Change guest password', params: 'body: { password }' },
    { method: 'DELETE', path: '/api/guests/:id', desc: 'Delete guest', params: null },
    { method: 'POST', path: '/api/guests/:id/ban', desc: 'Ban guest', params: null },
    { method: 'POST', path: '/api/guests/:id/unban', desc: 'Unban guest', params: null },
    // Guest-facing endpoints
    { method: 'GET', path: '/api/guest/threads', desc: 'List public threads (guest view)', params: null },
    { method: 'GET', path: '/api/guest/thread/:id', desc: 'Get thread (guest view)', params: null },
    { method: 'POST', path: '/api/guest/thread', desc: 'Create thread (guest)', params: 'body: { message, title }' },
    { method: 'POST', path: '/api/guest/thread/:id/message', desc: 'Post message to thread (guest)', params: 'body: { message }' },
    { method: 'GET', path: '/api/guest/dm/:from/:to', desc: 'Get DM conversation (guest view)', params: null },
    { method: 'POST', path: '/api/guest/dm', desc: 'Send DM (guest)', params: 'body: { to, message }' },
    { method: 'GET', path: '/api/guest/pack', desc: 'Get pack profiles (guest view)', params: null },
    { method: 'GET', path: '/api/guest/profile', desc: 'Get own guest profile', params: null },
    { method: 'PATCH', path: '/api/guest/profile', desc: 'Update own guest profile', params: 'body: { display_name?, bio? }' },
    { method: 'POST', path: '/api/guest/avatar', desc: 'Upload guest avatar', params: 'body: FormData with file' },
    { method: 'POST', path: '/api/guest/change-password', desc: 'Change guest password (self)', params: 'body: { old_password, new_password }' },
    { method: 'POST', path: '/api/guest/reset-password', desc: 'Reset guest password', params: 'body: { username }' },
    { method: 'GET', path: '/api/guest/dashboard', desc: 'Guest dashboard', params: null },
    // Projects
    { method: 'GET', path: '/api/projects', desc: 'List projects', params: null },
    { method: 'GET', path: '/api/projects/:id', desc: 'Get project by ID', params: null },
    { method: 'POST', path: '/api/projects', desc: 'Create project', params: 'body: { name, description? }' },
    { method: 'PATCH', path: '/api/projects/:id', desc: 'Update project', params: 'body: { name?, description? }' },
    { method: 'DELETE', path: '/api/projects/:id', desc: 'Delete project', params: null },
    // Teams
    { method: 'GET', path: '/api/teams', desc: 'List teams', params: null },
    { method: 'GET', path: '/api/teams/:id', desc: 'Get team by ID', params: null },
    { method: 'POST', path: '/api/teams', desc: 'Create team', params: 'body: { name, ... }' },
    { method: 'PATCH', path: '/api/teams/:id', desc: 'Update team', params: 'body: { name?, ... }' },
    { method: 'DELETE', path: '/api/teams/:id', desc: 'Delete team', params: null },
    { method: 'POST', path: '/api/teams/:id/members', desc: 'Add member to team', params: 'body: { beast }' },
    { method: 'DELETE', path: '/api/teams/:id/members/:beast', desc: 'Remove member from team', params: null },
    { method: 'POST', path: '/api/teams/:id/projects', desc: 'Link project to team', params: 'body: { projectId }' },
    { method: 'DELETE', path: '/api/teams/:id/projects/:projectId', desc: 'Unlink project from team', params: null },
    { method: 'GET', path: '/api/teams/beast/:beast', desc: 'Get teams for a beast', params: null },
    // Security
    { method: 'GET', path: '/api/security/events', desc: 'Security event log', params: '?limit=50' },
    { method: 'GET', path: '/api/security/events/stats', desc: 'Security event stats', params: null },
    { method: 'GET', path: '/api/audit', desc: 'Audit log', params: '?limit=50' },
    { method: 'GET', path: '/api/audit/stats', desc: 'Audit stats', params: null },
    // Scheduler (additional)
    { method: 'GET', path: '/api/schedules/:id', desc: 'Get schedule by ID', params: null },
    { method: 'POST', path: '/api/schedules/:id/execute', desc: 'Execute schedule now', params: null },
    { method: 'PATCH', path: '/api/schedules/:id/trigger', desc: 'Trigger schedule', params: null },
    { method: 'GET', path: '/api/scheduler/health', desc: 'Scheduler health check', params: null },
    // Tasks (additional)
    { method: 'POST', path: '/api/tasks/bulk-status', desc: 'Bulk update task status', params: 'body: { ids, status }' },
    // Specs (additional)
    { method: 'GET', path: '/api/specs/by-task/:taskId', desc: 'Get specs linked to a task', params: null },
    { method: 'GET', path: '/api/specs/by-thread/:threadId', desc: 'Get specs linked to a thread', params: null },
    { method: 'GET', path: '/api/spec-comments/:commentId', desc: 'Get spec comment by ID', params: null },
    // Risks (additional)
    { method: 'GET', path: '/api/risks/:id/comments', desc: 'Get risk comments', params: null },
    { method: 'POST', path: '/api/risks/:id/comments', desc: 'Add risk comment', params: 'body: { author, content }' },
    // Messages (additional)
    { method: 'DELETE', path: '/api/message/:id', desc: 'Delete message', params: 'body: { beast }' },
    // Forum (additional)
    { method: 'POST', path: '/api/forum/subscribe', desc: 'Subscribe to thread', params: 'body: { beast, threadId }' },
    { method: 'GET', path: '/api/forum/subscriptions/:beast', desc: 'Get thread subscriptions', params: null },
    { method: 'GET', path: '/api/thread/:id/subscribers', desc: 'Get thread subscribers', params: null },
    // Files (additional)
    { method: 'GET', path: '/api/files/archive/stats', desc: 'File archive stats', params: null },
    { method: 'POST', path: '/api/files/archive/run', desc: 'Run file archival', params: null },
    { method: 'POST', path: '/api/files/:id/restore', desc: 'Restore archived file', params: null },
    // Routine (additional)
    { method: 'GET', path: '/api/routine/workout-trends', desc: 'Workout trend data', params: null },
    { method: 'GET', path: '/api/routine/photos', desc: 'List routine photos', params: null },
    { method: 'POST', path: '/api/routine/photo/upload', desc: 'Upload routine photo', params: 'body: FormData with file' },
    { method: 'GET', path: '/api/routine/photo/:filename', desc: 'Get routine photo', params: null },
    { method: 'GET', path: '/api/routine/logs/deleted', desc: 'List deleted routine logs', params: null },
    // Supersede (document versioning)
    { method: 'GET', path: '/api/supersede', desc: 'List supersede records', params: null },
    { method: 'POST', path: '/api/supersede', desc: 'Create supersede record', params: 'body: { path, content, author }' },
    { method: 'GET', path: '/api/supersede/chain/:path', desc: 'Get supersede chain for path', params: null },
    // Traces
    { method: 'GET', path: '/api/traces', desc: 'List traces', params: null },
    { method: 'GET', path: '/api/traces/:id', desc: 'Get trace by ID', params: null },
    { method: 'GET', path: '/api/traces/:id/chain', desc: 'Get trace chain', params: null },
    { method: 'GET', path: '/api/traces/:id/linked-chain', desc: 'Get linked trace chain', params: null },
    { method: 'POST', path: '/api/traces/:prevId/link', desc: 'Link traces', params: null },
    { method: 'DELETE', path: '/api/traces/:id/link', desc: 'Unlink trace', params: null },
    // Settings
    { method: 'GET', path: '/api/settings', desc: 'Get app settings', params: null },
    { method: 'POST', path: '/api/settings', desc: 'Update app settings', params: 'body: { ... }' },
    // Database
    { method: 'GET', path: '/api/db/stats', desc: 'Database statistics', params: null },
    { method: 'POST', path: '/api/db/maintenance', desc: 'Run database maintenance', params: null },
    // Withings (additional)
    { method: 'POST', path: '/api/oauth/withings/sync', desc: 'Sync Withings data', params: null },
    { method: 'POST', path: '/api/webhooks/withings', desc: 'Withings webhook callback', params: null },
    { method: 'POST', path: '/api/webhooks/hevy', desc: 'Hevy webhook callback (T#724) — workout creation push', params: 'body: { workoutId } | header: Authorization: <HEVY_WEBHOOK_TOKEN> (raw, no Bearer prefix)' },
    // Telegram
    { method: 'GET', path: '/api/telegram/status', desc: 'Telegram polling status (owner only)', params: null },
    { method: 'GET', path: '/api/telegram/message/:id', desc: 'T#712 — cached inbound TG message by id (Gorn + Sable only)', params: null },
    // Board / Pack
    { method: 'GET', path: '/api/board', desc: 'Board overview (tasks summary)', params: null },
    { method: 'GET', path: '/api/pack/spinner-verbs', desc: 'Pack spinner verb list', params: null },
    // Knowledge / Docs
    { method: 'GET', path: '/api/docs', desc: 'List knowledge documents', params: null },
    { method: 'GET', path: '/api/doc/:id', desc: 'Get document by ID', params: null },
    { method: 'GET', path: '/api/feed', desc: 'Activity feed', params: null },
    { method: 'POST', path: '/api/learn', desc: 'Submit learn request', params: 'body: { ... }' },
    { method: 'GET', path: '/api/oracles', desc: 'List oracles', params: null },
    // Internal/legacy (included for 404 hint completeness)
    { method: 'GET', path: '/api/stats', desc: 'Server stats', params: null },
    { method: 'GET', path: '/api/logs', desc: 'Server logs', params: null },
    { method: 'GET', path: '/api/beast/:name/avatar.svg', desc: 'Get beast avatar SVG', params: null },
  ];

// API Help — machine-readable endpoint catalog for Beast self-correction
app.get('/api/help', (c) => {
  const role = (c.get as any)('role') as Role | undefined;
  const filter = c.req.query('q')?.toLowerCase();

  // Guests see only their allowed endpoints; owner/beast see everything
  let result = HELP_ENDPOINTS;
  if (role === 'guest') {
    const allowlist = getGuestAllowlist();
    result = HELP_ENDPOINTS.filter(e =>
      allowlist.some(a =>
        (a.method === '*' || a.method === e.method) &&
        new RegExp(a.pattern).test(e.path)
      )
    );
  }

  if (filter) {
    result = result.filter(e =>
      e.path.toLowerCase().includes(filter) ||
      e.desc.toLowerCase().includes(filter) ||
      e.method.toLowerCase().includes(filter)
    );
  }

  return c.json({
    total: result.length,
    hint: 'Use ?q=keyword to filter (e.g. ?q=thread, ?q=dm, ?q=task)',
    endpoints: result,
  });
});

// Search routes extracted to src/search/routes.ts (T#771)

// Reflect
app.get('/api/reflect', (c) => {
  return c.json(handleReflect());
});

// Stats (extended with vector metrics)
app.get('/api/stats', async (c) => {
  const stats = handleStats(DB_PATH);
  const vaultRepo = getSetting('vault_repo');
  let vectorStats = { vector: { enabled: false, count: 0, collection: 'oracle_knowledge' } };
  try {
    vectorStats = await handleVectorStats();
  } catch { /* vector unavailable */ }
  return c.json({ ...stats, ...vectorStats, vault_repo: vaultRepo });
});

// Active Oracles — detected from existing activity across all log tables
let oracleCache: { data: any; ts: number } | null = null;
app.get('/api/oracles', (c) => {
  const hours = parseInt(c.req.query('hours') || '168'); // default 7 days
  const now = Date.now();
  if (oracleCache && (now - oracleCache.ts) < 60_000) return c.json(oracleCache.data);

  const cutoff = now - hours * 3600_000;
  // Active identities (forum authors, trace sessions, learn sources)
  const identities = sqlite.prepare(`
    SELECT oracle_name, source, max(last_seen) as last_seen, sum(actions) as actions
    FROM (
      SELECT author as oracle_name, 'forum' as source, max(created_at) as last_seen, count(*) as actions
        FROM forum_messages WHERE author IS NOT NULL AND created_at > ?
        GROUP BY author
      UNION ALL
      SELECT COALESCE(session_id, 'unknown') as oracle_name, 'trace' as source, max(created_at) as last_seen, count(*) as actions
        FROM trace_log WHERE created_at > ?
        GROUP BY session_id
      UNION ALL
      SELECT COALESCE(source, project, 'unknown') as oracle_name, 'learn' as source, max(created_at) as last_seen, count(*) as actions
        FROM learn_log WHERE created_at > ?
        GROUP BY COALESCE(source, project)
    )
    WHERE oracle_name IS NOT NULL AND oracle_name != 'unknown'
    GROUP BY oracle_name
    ORDER BY last_seen DESC
  `).all(cutoff, cutoff, cutoff);

  // Projects with indexed knowledge (each project = an Oracle's domain)
  const projects = sqlite.prepare(`
    SELECT project, count(*) as docs,
           count(DISTINCT type) as types,
           max(created_at) as last_indexed
    FROM oracle_documents
    WHERE project IS NOT NULL
    GROUP BY project
    ORDER BY last_indexed DESC
  `).all();

  const result = {
    identities,
    projects,
    total_projects: projects.length,
    total_identities: identities.length,
    window_hours: hours,
    cached_at: new Date().toISOString(),
  };
  oracleCache = { data: result, ts: now };
  return c.json(result);
});

// Similar documents (vector nearest neighbors)
app.get('/api/similar', async (c) => {
  const id = c.req.query('id');
  if (!id) {
    return c.json({ error: 'Missing query parameter: id' }, 400);
  }
  const limit = parseInt(c.req.query('limit') || '5');
  const model = c.req.query('model');
  try {
    const result = await handleSimilar(id, limit, model);
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message, results: [], docId: id }, 500);
  }
});

// Knowledge map (2D projection of all embeddings)
app.get('/api/map', async (c) => {
  try {
    const result = await handleMap();
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message, documents: [], total: 0 }, 500);
  }
});

// Knowledge map 3D (real PCA from LanceDB bge-m3 embeddings)
app.get('/api/map3d', async (c) => {
  try {
    const model = c.req.query('model') || undefined;
    const result = await handleMap3d(model);
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message, documents: [], total: 0 }, 500);
  }
});

// Live Oracle feed (from ~/.oracle/feed.log)
const FEED_LOG = path.join(process.env.HOME || '/home/nat', '.oracle', 'feed.log');
app.get('/api/feed', (c) => {
  try {
    const limit = Math.min(200, parseInt(c.req.query('limit') || '50'));
    const type = c.req.query('type') || undefined; // forum, task, spec, rule, risk
    const since = c.req.query('since') || undefined;

    // Aggregate feed from multiple sources
    const events: any[] = [];

    // Forum posts (most recent)
    const forumQuery = since
      ? 'SELECT m.id, m.content, m.author, m.created_at, t.title as thread_title, t.id as thread_id FROM forum_messages m JOIN forum_threads t ON m.thread_id = t.id WHERE m.created_at > ? ORDER BY m.created_at DESC LIMIT ?'
      : 'SELECT m.id, m.content, m.author, m.created_at, t.title as thread_title, t.id as thread_id FROM forum_messages m JOIN forum_threads t ON m.thread_id = t.id ORDER BY m.created_at DESC LIMIT ?';
    const forumParams = since ? [since, limit] : [limit];
    if (!type || type === 'forum') {
      const posts = sqlite.prepare(forumQuery).all(...forumParams) as any[];
      for (const p of posts) {
        events.push({
          type: 'forum', id: p.id, timestamp: p.created_at,
          actor: p.author, title: p.thread_title,
          message: p.content.slice(0, 200),
          url: `/forum?thread=${p.thread_id}`,
        });
      }
    }

    // Task updates
    if (!type || type === 'task') {
      const taskQuery = since
        ? 'SELECT t.id, t.title, t.status, t.assigned_to, t.created_by, t.updated_at, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE t.updated_at > ? ORDER BY t.updated_at DESC LIMIT ?'
        : 'SELECT t.id, t.title, t.status, t.assigned_to, t.created_by, t.updated_at, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id ORDER BY t.updated_at DESC LIMIT ?';
      const taskParams = since ? [since, limit] : [limit];
      const tasks = sqlite.prepare(taskQuery).all(...taskParams) as any[];
      for (const t of tasks) {
        events.push({
          type: 'task', id: t.id, timestamp: t.updated_at,
          actor: t.assigned_to || t.created_by, title: `T#${t.id}: ${t.title}`,
          message: `Status: ${t.status}${t.project_name ? ` | ${t.project_name}` : ''}`,
          url: `/board?task=${t.id}`,
        });
      }
    }

    // Spec reviews
    if (!type || type === 'spec') {
      const specQuery = since
        ? 'SELECT id, title, author, status, updated_at FROM spec_reviews WHERE updated_at > ? ORDER BY updated_at DESC LIMIT ?'
        : 'SELECT id, title, author, status, updated_at FROM spec_reviews ORDER BY updated_at DESC LIMIT ?';
      const specParams = since ? [since, limit] : [limit];
      const specs = sqlite.prepare(specQuery).all(...specParams) as any[];
      for (const s of specs) {
        events.push({
          type: 'spec', id: s.id, timestamp: s.updated_at,
          actor: s.author, title: `Spec #${s.id}: ${s.title}`,
          message: `Status: ${s.status}`,
          url: `/specs?spec=${s.id}`,
        });
      }
    }

    // Sort all events by timestamp (newest first) and limit
    events.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
    const total = events.length;
    const sliced = events.slice(0, limit);

    return c.json({ events: sliced, total });
  } catch (e: any) {
    return c.json({ error: e.message, events: [], total: 0 }, 500);
  }
});

// Logs
app.get('/api/logs', (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '20');
    const logs = db.select({
      query: searchLog.query,
      type: searchLog.type,
      mode: searchLog.mode,
      results_count: searchLog.resultsCount,
      search_time_ms: searchLog.searchTimeMs,
      created_at: searchLog.createdAt,
      project: searchLog.project
    })
      .from(searchLog)
      .orderBy(desc(searchLog.createdAt))
      .limit(limit)
      .all();
    return c.json({ logs, total: logs.length });
  } catch (e) {
    return c.json({ logs: [], error: 'Log table not found' });
  }
});

// Get document by ID (uses raw SQL for FTS JOIN)
app.get('/api/doc/:id', (c) => {
  const docId = c.req.param('id');
  try {
    // Must use raw SQL for FTS JOIN (Drizzle doesn't support virtual tables)
    const row = sqlite.prepare(`
      SELECT d.id, d.type, d.source_file, d.concepts, d.project, f.content
      FROM oracle_documents d
      JOIN oracle_fts f ON d.id = f.id
      WHERE d.id = ?
    `).get(docId) as any;

    if (!row) {
      return c.json({ error: 'Document not found' }, 404);
    }

    return c.json({
      id: row.id,
      type: row.type,
      content: row.content,
      source_file: row.source_file,
      concepts: JSON.parse(row.concepts || '[]'),
      project: row.project
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// List documents
app.get('/api/list', (c) => {
  const type = c.req.query('type') || 'all';
  const limit = parseInt(c.req.query('limit') || '10');
  const offset = parseInt(c.req.query('offset') || '0');
  const group = c.req.query('group') !== 'false';

  return c.json(handleList(type, limit, offset, group));
});

// Graph
app.get('/api/graph', (c) => {
  const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined;
  return c.json(handleGraph(limit));
});

// Context
app.get('/api/context', (c) => {
  const cwd = c.req.query('cwd');
  return c.json(handleContext(cwd));
});

// File - supports cross-repo access via ghq project paths
app.get('/api/file', async (c) => {
  const filePath = c.req.query('path');
  const project = c.req.query('project'); // ghq-style path: github.com/owner/repo

  if (!filePath) {
    return c.json({ error: 'Missing path parameter' }, 400);
  }

  try {
    // Determine base path: ghq root + project, or local REPO_ROOT
    // Detect GHQ_ROOT dynamically (no hardcoding)
    let GHQ_ROOT = process.env.GHQ_ROOT;
    if (!GHQ_ROOT) {
      try {
        const proc = Bun.spawnSync(['ghq', 'root']);
        GHQ_ROOT = proc.stdout.toString().trim();
      } catch {
        // Fallback: derive from REPO_ROOT (assume ghq structure)
        // REPO_ROOT is like /path/to/github.com/owner/repo
        // GHQ_ROOT would be /path/to
        const match = REPO_ROOT.match(/^(.+?)\/github\.com\//);
        GHQ_ROOT = match ? match[1] : path.dirname(path.dirname(path.dirname(REPO_ROOT)));
      }
    }
    let basePath: string;

    if (project) {
      // Cross-repo: use ghq path
      basePath = path.join(GHQ_ROOT, project);
    } else {
      // Local: use current repo
      basePath = REPO_ROOT;
    }

    // Strip project prefix if source_file already contains it (vault-indexed docs)
    let resolvedFilePath = filePath;
    if (project && filePath.toLowerCase().startsWith(project.toLowerCase() + '/')) {
      resolvedFilePath = filePath.slice(project.length + 1); // e.g. "ψ/memory/learnings/file.md"
    }

    const fullPath = path.join(basePath, resolvedFilePath);

    // Security: resolve symlinks and verify path is within allowed bounds
    let realPath: string;
    try {
      realPath = fs.realpathSync(fullPath);
    } catch {
      realPath = path.resolve(fullPath);
    }

    // Allow paths within GHQ_ROOT (for cross-repo) or REPO_ROOT (for local)
    const realGhqRoot = fs.realpathSync(GHQ_ROOT);
    const realRepoRoot = fs.realpathSync(REPO_ROOT);

    if (!realPath.startsWith(realGhqRoot) && !realPath.startsWith(realRepoRoot)) {
      return c.json({ error: 'Invalid path: outside allowed bounds' }, 400);
    }

    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      return c.text(content);
    }

    // Fallback: try vault repo (project-first layout)
    const vault = getVaultPsiRoot();
    if ('path' in vault) {
      const vaultFullPath = path.join(vault.path, filePath);
      if (fs.existsSync(vaultFullPath)) {
        const content = fs.readFileSync(vaultFullPath, 'utf-8');
        return c.text(content);
      }
    }

    return c.text('File not found', 404);
  } catch (e: any) {
    return c.text(e.message, 500);
  }
});

// Read document by file path or ID (resolves vault/ghq paths server-side)
app.get('/api/read', async (c) => {
  const file = c.req.query('file');
  const id = c.req.query('id');
  if (!file && !id) {
    return c.json({ error: 'Provide file or id parameter' }, 400);
  }
  const ctx = { db, sqlite, repoRoot: REPO_ROOT } as Pick<ToolContext, 'db' | 'sqlite' | 'repoRoot'>;
  const result = await handleRead(ctx as ToolContext, {
    file: file || undefined,
    id: id || undefined,
  });
  const text = result.content[0]?.text || '{}';
  if (result.isError) {
    return c.json(JSON.parse(text), 404);
  }
  return c.json(JSON.parse(text));
});

// ============================================================================
// Dashboard Routes
// ============================================================================

app.get('/api/dashboard', (c) => c.json(handleDashboardSummary()));
app.get('/api/dashboard/summary', (c) => c.json(handleDashboardSummary()));

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

app.get('/api/dashboard/activity', (c) => {
  const days = parseInt(c.req.query('days') || '7');
  return c.json(handleDashboardActivity(days));
});

app.get('/api/dashboard/growth', (c) => {
  const period = c.req.query('period') || 'week';
  return c.json(handleDashboardGrowth(period));
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
app.get('/api/pack', (c) => {
  const profiles = getAllBeastProfiles();
  const { tmuxStatus, contextPctMap } = getTmuxStatus();

  const beasts = profiles.map(p => {
    const sessionName = p.name.charAt(0).toUpperCase() + p.name.slice(1);
    const rawStatus = tmuxStatus.get(sessionName.toLowerCase()) || tmuxStatus.get(p.name) || 'offline';
    return {
      ...p,
      avatarUrl: normalizeAvatarUrl(p.avatarUrl),
      online: rawStatus === 'processing' || rawStatus === 'idle' || rawStatus === 'waiting',
      status: rawStatus, // 'processing' | 'idle' | 'waiting' | 'shell' | 'offline'
      contextPct: contextPctMap.get(sessionName.toLowerCase()) ?? contextPctMap.get(p.name) ?? null,
      sessionName,
    };
  });

  // Owner (Gorn) presence from WS heartbeat map
  const now = Date.now();
  const ownerPresence = webPresence.get('gorn');
  const ownerOnline = !!ownerPresence && (now - ownerPresence.lastSeen) < WEB_PRESENCE_TIMEOUT_MS;
  const owner = {
    name: 'gorn',
    online: ownerOnline,
    status: ownerOnline ? 'active' : 'offline',
    last_active_at: ownerPresence ? new Date(ownerPresence.lastSeen).toISOString() : null,
  };

  return c.json({ beasts, owner });
});

// Get all configured spinner verbs across all Beasts
app.get('/api/pack/spinner-verbs', (c) => {
  const workspaceDir = '/home/gorn/workspace';
  const beastVerbs: Record<string, string[]> = {};
  const allVerbs = new Set<string>();

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
          const verbList = (Array.isArray(sv) ? sv : (sv.verbs || [])).filter((v: unknown) => typeof v === 'string');
          if (verbList.length > 0) {
            beastVerbs[dir] = verbList;
            for (const v of verbList) allVerbs.add(v);
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* workspace not readable */ }

  return c.json({
    beasts: beastVerbs,
    allVerbs: [...allVerbs].sort(),
    totalUnique: allVerbs.size,
    totalBeasts: Object.keys(beastVerbs).length,
  });
});

// Capture live terminal output for a Beast
app.get('/api/beast/:name/terminal', (c) => {
  if (!hasSessionAuth(c)) return c.json({ error: 'forbidden' }, 403);
  const name = c.req.param('name');
  const sessionName = name.charAt(0).toUpperCase() + name.slice(1);
  const rows = parseInt(c.req.query('rows') || '50');

  try {
    // Check if session exists
    execSync(`tmux has-session -t ${JSON.stringify(sessionName)}`, { timeout: 2000 });

    // Capture pane with ANSI escape codes
    const output = execSync(
      `tmux capture-pane -t ${JSON.stringify(sessionName)} -p -e -S -${rows}`,
      { timeout: 3000, maxBuffer: 1024 * 1024 }
    ).toString();

    // Get pane dimensions
    let cols = 80, paneRows = 24;
    try {
      const info = execSync(
        `tmux display-message -t ${JSON.stringify(sessionName)} -p "#{pane_width} #{pane_height}"`,
        { timeout: 2000 }
      ).toString().trim();
      const [w, h] = info.split(' ').map(Number);
      if (w) cols = w;
      if (h) paneRows = h;
    } catch { /* use defaults */ }

    return c.json({
      name,
      online: true,
      content: output,
      cols,
      rows: paneRows,
    });
  } catch {
    return c.json({
      name,
      online: false,
      content: '',
      cols: 80,
      rows: 24,
    });
  }
});

// Send input to a Beast's terminal
app.post('/api/beast/:name/terminal/input', async (c) => {
  if (!hasSessionAuth(c)) return c.json({ error: 'forbidden' }, 403);
  const name = c.req.param('name');
  const sessionName = name.charAt(0).toUpperCase() + name.slice(1);

  try {
    const body = await c.req.json();
    const { keys } = body;
    if (!keys || typeof keys !== 'string') {
      return c.json({ error: 'keys (string) is required' }, 400);
    }

    // Rate limit: max 100 chars per request
    if (keys.length > 100) {
      return c.json({ error: 'Input too long (max 100 chars)' }, 400);
    }

    // Check session exists
    const hasSession = Bun.spawnSync(['tmux', 'has-session', '-t', sessionName]);
    if (hasSession.exitCode !== 0) throw new Error('Session not found');

    // Send keys — use Bun.spawnSync to avoid shell interpretation of special chars
    // T#714 scope-awareness (Pip #911 fourth-surface): this endpoint is the literal-text
    // half of a human-UI terminal driver. If a caller chains this POST with
    // /terminal/key key=Enter within milliseconds (scripted automation),
    // same Claude Code Ink-TUI race as T#713/T#714 could manifest. Human-paced
    // UI callers are below the race threshold. If observed, apply the same
    // 200ms break between /terminal/input completion and /terminal/key Enter.
    Bun.spawnSync(['tmux', 'send-keys', '-t', sessionName, '-l', keys]);

    return c.json({ sent: true, beast: name, length: keys.length });
  } catch {
    return c.json({ error: 'Session not found or send failed' }, 404);
  }
});

// Send special keys (Enter, Ctrl-C, etc.)
app.post('/api/beast/:name/terminal/key', async (c) => {
  if (!hasSessionAuth(c)) return c.json({ error: 'forbidden' }, 403);
  const name = c.req.param('name');
  const sessionName = name.charAt(0).toUpperCase() + name.slice(1);

  try {
    const body = await c.req.json();
    const { key } = body;

    // Whitelist of allowed special keys
    const ALLOWED_KEYS = ['Enter', 'Escape', 'BSpace', 'Tab', 'Up', 'Down', 'Left', 'Right', 'C-c', 'C-d', 'C-z', 'C-l'];
    if (!key || !ALLOWED_KEYS.includes(key)) {
      return c.json({ error: `Invalid key. Allowed: ${ALLOWED_KEYS.join(', ')}` }, 400);
    }

    Bun.spawnSync(['tmux', 'has-session', '-t', sessionName]);
    // T#714 scope-awareness (Pip #911 fourth-surface): paired endpoint to
    // /terminal/input. If scripted chain (input + key=Enter within ms) surfaces
    // the same Ink-TUI race as T#713/T#714, fix is same 200ms break — applied
    // at caller or here. Today this is human-UI-paced + session-gated, so
    // awareness-only per Pip's (a) lean.
    Bun.spawnSync(['tmux', 'send-keys', '-t', sessionName, key]);

    return c.json({ sent: true, beast: name, key });
  } catch {
    return c.json({ error: 'Session not found or send failed' }, 404);
  }
});

// ============================================================================
// Remote Control — tmux Beast switcher
// ============================================================================

const REMOTE_SESSION = 'Mindlink';
let attachedBeastName: string | null = null;

// GET /api/remote/status — which beast is currently attached
app.get('/api/remote/status', (c) => {
  // Verify the Remote session still exists and has a linked window
  if (attachedBeastName) {
    try {
      execSync(`tmux has-session -t ${JSON.stringify(REMOTE_SESSION)}`, { timeout: 2000 });
      // Check if window 1 still exists (beast is still linked)
      const windows = execSync(
        `tmux list-windows -t ${JSON.stringify(REMOTE_SESSION)} -F "#{window_index}"`,
        { timeout: 2000 }
      ).toString().trim().split('\n');
      if (!windows.includes('1')) {
        attachedBeastName = null; // Window was unlinked externally
      }
    } catch {
      attachedBeastName = null; // Session gone
    }
  }

  return c.json({ session_exists: !!attachedBeastName, attached_beast: attachedBeastName });
});

// POST /api/remote/attach — attach a beast's claude window (local only — requires tmux)
app.post('/api/remote/attach', async (c) => {
  // Remote attach requires local tmux access — reject non-local requests cleanly
  if (!isLocalNetwork(c) && !hasSessionAuth(c)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  try {
    const data = await c.req.json();
    const beastName = data.beast?.toLowerCase();
    if (!beastName) return c.json({ error: 'beast name required' }, 400);

    // Sanitize: only allow alphanumeric beast names
    if (!/^[a-z]+$/.test(beastName)) return c.json({ error: 'Invalid beast name' }, 400);

    const sessionName = beastName.charAt(0).toUpperCase() + beastName.slice(1);

    // Verify beast session exists
    try {
      execSync(`tmux has-session -t ${JSON.stringify(sessionName)}`, { timeout: 2000 });
    } catch {
      return c.json({ error: `No tmux session for ${beastName}` }, 404);
    }

    // Find the claude window index in the beast's session
    let claudeWindow = '1';
    try {
      const windows = execSync(
        `tmux list-windows -t ${JSON.stringify(sessionName)} -F "#{window_index}:#{pane_current_command}"`,
        { timeout: 2000 }
      ).toString().trim().split('\n');
      const claudeWin = windows.find(w => w.includes(':claude'));
      if (claudeWin) claudeWindow = claudeWin.split(':')[0];
    } catch { /* default to 1 */ }

    // Ensure Remote session exists
    try {
      execSync(`tmux has-session -t ${JSON.stringify(REMOTE_SESSION)}`, { timeout: 2000 });
    } catch {
      execSync(`tmux new-session -d -s ${JSON.stringify(REMOTE_SESSION)}`, { timeout: 2000 });
    }

    // Unlink any existing beast window (window index 1)
    try {
      execSync(`tmux unlink-window -k -t ${JSON.stringify(REMOTE_SESSION)}:1`, { timeout: 2000 });
    } catch { /* no window to unlink */ }

    // Link the beast's claude window
    execSync(
      `tmux link-window -s ${JSON.stringify(sessionName)}:${claudeWindow} -t ${JSON.stringify(REMOTE_SESSION)}:1`,
      { timeout: 2000 }
    );

    // Switch to the linked window
    execSync(`tmux select-window -t ${JSON.stringify(REMOTE_SESSION)}:1`, { timeout: 2000 });

    attachedBeastName = beastName;
    return c.json({ attached: beastName, session: REMOTE_SESSION });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : 'Attach failed' }, 500);
  }
});

// POST /api/remote/detach — detach current beast (local only — requires tmux)
app.post('/api/remote/detach', (_c) => {
  try {
    execSync(`tmux unlink-window -k -t ${JSON.stringify(REMOTE_SESSION)}:1`, { timeout: 2000 });
  } catch { /* already detached */ }
  attachedBeastName = null;
  return _c.json({ detached: true });
});

// ============================================================================
// Beast Profile Routes
// ============================================================================

// Generate SVG avatar for a beast (deterministic, cacheable)
app.get('/api/beast/:name/avatar.svg', (c) => {
  const name = c.req.param('name');
  const profile = getBeastProfile(name);

  const BEAST_COLORS: Record<string, string> = {
    hyena: '#d97706', horse: '#7c3aed', alligator: '#059669',
    bear: '#92400e', kangaroo: '#dc2626', lion: '#ca8a04',
    raccoon: '#6366f1', otter: '#0d9488', crow: '#475569',
    octopus: '#9b59b6', ferret: '#8b6834',
    wolf: '#64748b', porcupine: '#a3a3a3', mongoose: '#f59e0b',
    owl: '#8b5cf6', hawk: '#ef4444',
  };
  const ANIMAL_EMOJI: Record<string, string> = {
    hyena: '🐾', horse: '🐴', alligator: '🐊', bear: '🐻',
    kangaroo: '🦘', lion: '🦁', raccoon: '🦝', otter: '🦦', crow: '🐦‍⬛',
    octopus: '🐙', ferret: '🐾',
    wolf: '🐺', porcupine: '🦔', mongoose: '🐿️',
    owl: '🦉', hawk: '🦅',
  };

  const animal = profile?.animal?.toLowerCase() || 'unknown';
  const color = profile?.themeColor || BEAST_COLORS[animal] || '#6b7280';
  const emoji = ANIMAL_EMOJI[animal] || '🐾';
  const displayName = profile?.displayName || name;
  const initial = displayName.charAt(0).toUpperCase();

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0.6"/>
    </linearGradient>
  </defs>
  <circle cx="64" cy="64" r="64" fill="url(#bg)"/>
  <text x="64" y="58" text-anchor="middle" dominant-baseline="central" font-size="48">${emoji}</text>
  <text x="64" y="100" text-anchor="middle" font-family="system-ui,sans-serif" font-size="18" font-weight="700" fill="white" opacity="0.9">${initial}</text>
</svg>`;

  c.header('Content-Type', 'image/svg+xml');
  c.header('Cache-Control', 'public, max-age=86400');
  return c.body(svg);
});

// Seed default avatars for beasts that don't have one
app.post('/api/beasts/seed-avatars', (c) => {
  const profiles = getAllBeastProfiles();
  let updated = 0;
  for (const p of profiles) {
    if (!p.avatarUrl) {
      updateBeastAvatar(p.name, `/api/beast/${p.name}/avatar.svg`);
      updated++;
    }
  }
  return c.json({ seeded: updated, total: profiles.length });
});

// List all beast profiles
app.get('/api/beasts', (c) => {
  const profiles = getAllBeastProfiles();
  return c.json({ beasts: profiles });
});

// Migration: add sex column to beast_profiles (T#411)
try { sqlite.prepare('ALTER TABLE beast_profiles ADD COLUMN sex TEXT DEFAULT NULL').run(); } catch { /* exists */ }
// T#658 — Norm #65 (Nap vs Rest) — scheduler-aware rest state
try { sqlite.prepare("ALTER TABLE beast_profiles ADD COLUMN rest_status TEXT DEFAULT 'active'").run(); } catch { /* exists */ }

// Get beast profile by name
app.get('/api/beast/:name', (c) => {
  const name = c.req.param('name');
  const profile = getBeastProfile(name);
  if (!profile) {
    return c.json({ error: 'Beast not found' }, 404);
  }
  return c.json(profile);
});

// Create or update beast profile
app.put('/api/beast/:name', async (c) => {
  try {
    const name = c.req.param('name');
    const body = await c.req.json();

    if (!body.displayName || !body.animal) {
      return c.json({ error: 'displayName and animal are required' }, 400);
    }

    upsertBeastProfile({
      name,
      displayName: body.displayName,
      animal: body.animal,
      avatarUrl: body.avatarUrl,
      bio: body.bio,
      interests: body.interests,
      themeColor: body.themeColor,
      role: body.role,
    });

    const profile = getBeastProfile(name);
    return c.json(profile);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

// Partial profile update (edit individual fields)
app.patch('/api/beast/:name', async (c) => {
  try {
    const name = c.req.param('name');
    const profile = getBeastProfile(name);
    if (!profile) {
      return c.json({ error: 'Beast not found' }, 404);
    }

    const body = await c.req.json();
    const updates: Record<string, any> = { updatedAt: Date.now() };

    if (body.bio !== undefined) updates.bio = body.bio;
    if (body.interests !== undefined) updates.interests = body.interests;
    if (body.role !== undefined) updates.role = body.role;
    if (body.displayName !== undefined) updates.displayName = body.displayName;
    if (body.themeColor !== undefined) updates.themeColor = body.themeColor;
    if (body.avatarUrl !== undefined) updates.avatarUrl = body.avatarUrl;
    if (body.birthdate !== undefined) updates.birthdate = body.birthdate;
    if (body.sex !== undefined) updates.sex = body.sex;

    db.update(beastProfiles)
      .set(updates)
      .where(eq(beastProfiles.name, name.toLowerCase()))
      .run();

    const updated = getBeastProfile(name);
    return c.json(updated);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

// Update avatar only
app.patch('/api/beast/:name/avatar', async (c) => {
  try {
    const name = c.req.param('name');
    const profile = getBeastProfile(name);
    if (!profile) {
      return c.json({ error: 'Beast not found. Create profile first with PUT /api/beast/:name' }, 404);
    }

    const body = await c.req.json();
    if (!body.avatarUrl) {
      return c.json({ error: 'avatarUrl is required' }, 400);
    }

    updateBeastAvatar(name, body.avatarUrl);
    const updated = getBeastProfile(name);
    return c.json(updated);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
  }
});

// ============================================================================
// Thread Routes
// ============================================================================

// Mark thread as read for a beast

// Get unread counts for a beast (T#618: excludes muted threads)

// File archive columns (T#533)
try { sqlite.prepare(`ALTER TABLE files ADD COLUMN archived_at INTEGER`).run(); } catch { /* exists */ }
try { sqlite.prepare(`ALTER TABLE files ADD COLUMN archive_path TEXT`).run(); } catch { /* exists */ }

// Image upload with validation and resize
const UPLOADS_DIR = path.join(ORACLE_DATA_DIR, 'uploads');
const ARCHIVE_DIR = path.join(ORACLE_DATA_DIR, 'uploads', 'archive');
const MAX_IMAGE_SIZE = 30 * 1024 * 1024; // 30MB for images
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB for other files

// Allowed file types (allowlist — per Talon/Bertus security review)
const ALLOWED_EXTENSIONS: Record<string, { mime: string; category: string }> = {
  '.jpg': { mime: 'image/jpeg', category: 'image' },
  '.jpeg': { mime: 'image/jpeg', category: 'image' },
  '.png': { mime: 'image/png', category: 'image' },
  '.gif': { mime: 'image/gif', category: 'image' },
  '.webp': { mime: 'image/webp', category: 'image' },
  '.pdf': { mime: 'application/pdf', category: 'document' },
  '.txt': { mime: 'text/plain', category: 'document' },
  '.md': { mime: 'text/markdown', category: 'document' },
  '.csv': { mime: 'text/csv', category: 'document' },
  '.json': { mime: 'application/json', category: 'document' },
  '.doc': { mime: 'application/msword', category: 'document' },
  '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', category: 'document' },
  '.xls': { mime: 'application/vnd.ms-excel', category: 'document' },
  '.xlsx': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', category: 'document' },
  '.ppt': { mime: 'application/vnd.ms-powerpoint', category: 'document' },
  '.pptx': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', category: 'document' },
  '.zip': { mime: 'application/zip', category: 'archive' },
};

// Allowed image types by magic bytes
const IMAGE_MAGIC: Record<string, { ext: string; mime: string }> = {
  'ffd8ff': { ext: '.jpg', mime: 'image/jpeg' },
  '89504e47': { ext: '.png', mime: 'image/png' },
  '47494638': { ext: '.gif', mime: 'image/gif' },
  '52494646': { ext: '.webp', mime: 'image/webp' }, // RIFF header for WebP
};

function detectImageType(buffer: Buffer): { ext: string; mime: string } | null {
  const hex = buffer.subarray(0, 4).toString('hex');
  for (const [magic, info] of Object.entries(IMAGE_MAGIC)) {
    if (hex.startsWith(magic)) return info;
  }
  // WebP has RIFF + WEBP at bytes 8-12
  if (hex.startsWith('52494646') && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { ext: '.webp', mime: 'image/webp' };
  }
  return null;
}

app.post('/api/upload', async (c) => {
  if (!hasSessionAuth(c) && !isTrustedRequest(c)) return c.json({ error: 'Authentication required' }, 403);
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    const context = (formData.get('context') as string) || 'forum';
    const contextId = formData.get('context_id') || formData.get('message_id');
    const beast = formData.get('beast');

    if (!file) return c.json({ error: 'No file provided' }, 400);

    // Check file extension against allowlist
    const ext = path.extname(file.name).toLowerCase();
    const allowed = ALLOWED_EXTENSIONS[ext];
    const imageType = detectImageType(Buffer.from(await file.slice(0, 12).arrayBuffer()));
    const isImage = !!imageType;

    // Reject double extensions (e.g., file.pdf.html)
    const nameParts = file.name.split('.');
    if (nameParts.length > 2) {
      const secondToLast = '.' + nameParts[nameParts.length - 2].toLowerCase();
      if (ALLOWED_EXTENSIONS[secondToLast] && secondToLast !== ext) {
        return c.json({ error: 'Double extensions not allowed' }, 400);
      }
    }

    // Guests: images only — no documents
    const isGuest = (c.get as any)('role') === 'guest';
    if (isGuest && !isImage) {
      return c.json({ error: 'Guests can only upload images (jpg, png, webp, gif)' }, 403);
    }

    // For images: validate via magic bytes (existing behavior)
    // For non-images: validate via extension allowlist
    if (!isImage && !allowed) {
      return c.json({ error: `File type '${ext}' not allowed. Allowed: ${Object.keys(ALLOWED_EXTENSIONS).join(', ')}` }, 400);
    }

    // Size limits
    const sizeLimit = isImage ? MAX_IMAGE_SIZE : MAX_FILE_SIZE;
    if (file.size > sizeLimit) return c.json({ error: `File too large. Max ${sizeLimit / 1024 / 1024}MB` }, 400);

    const buffer = Buffer.from(await file.arrayBuffer());
    if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

    let processedBuffer = buffer;
    let finalExt = isImage ? (imageType!.ext) : ext;
    let finalMime = isImage ? (imageType!.mime) : (allowed?.mime || 'application/octet-stream');

    // Image processing: resize, EXIF strip (existing behavior)
    if (isImage) {
      try {
        const sharp = require('sharp');
        const metadata = await sharp(buffer).metadata();
        if (metadata.width && metadata.width > 1920) {
          processedBuffer = await sharp(buffer)
            .rotate()
            .resize(1920, null, { withoutEnlargement: true })
            .jpeg({ quality: 95 })
            .withMetadata({ orientation: undefined })
            .toBuffer();
          finalExt = '.jpg';
          finalMime = 'image/jpeg';
        } else if (buffer.length > 2 * 1024 * 1024) {
          processedBuffer = await sharp(buffer)
            .rotate()
            .jpeg({ quality: 95 })
            .withMetadata({ orientation: undefined })
            .toBuffer();
          finalExt = '.jpg';
          finalMime = 'image/jpeg';
        } else {
          processedBuffer = await sharp(buffer)
            .rotate()
            .withMetadata({ orientation: undefined })
            .toBuffer();
        }
      } catch { /* sharp not available — save original */ }
    }

    const filename = `${crypto.randomUUID()}${finalExt}`;
    const filePath = path.join(UPLOADS_DIR, filename);
    fs.writeFileSync(filePath, processedBuffer);

    const now = Date.now();
    const category = isImage ? 'image' : (allowed?.category || 'other');

    // Insert into files table (T#382)
    const result = sqlite.prepare(`
      INSERT INTO files (filename, original_name, mime_type, size_bytes, uploaded_by, context, context_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(filename, file.name, finalMime, processedBuffer.length, beast || null, context, contextId ? Number(contextId) : null, now);

    // Also insert into forum_attachments for backwards compatibility
    sqlite.prepare(`
      INSERT INTO forum_attachments (message_id, filename, original_name, mime_type, size_bytes, uploaded_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(contextId ? Number(contextId) : null, filename, file.name, finalMime, processedBuffer.length, beast || null, now);

    return c.json({
      id: (result as any).lastInsertRowid,
      filename,
      original_name: file.name,
      mime_type: finalMime,
      category,
      url: `/api/f/${filename}`,
      size_bytes: processedBuffer.length,
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Upload failed' }, 500);
  }
});

// Legacy file endpoint — redirect to /api/f/ which has proper auth + cache headers

// ============================================================================
// File Manager API (T#382)
// ============================================================================

// GET /api/files — list files with pagination and filters
app.get('/api/files', (c) => {
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
  const offset = (page - 1) * limit;
  const type = c.req.query('type'); // image, document, archive
  const uploadedBy = c.req.query('uploaded_by');
  const context = c.req.query('context'); // forum, board, dm, forge

  let where = 'deleted_at IS NULL';
  const params: any[] = [];

  if (type) {
    const typeExts: Record<string, string[]> = {
      image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
      document: ['application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json',
        'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      archive: ['application/zip'],
    };
    const mimes = typeExts[type];
    if (mimes) {
      where += ` AND mime_type IN (${mimes.map(() => '?').join(',')})`;
      params.push(...mimes);
    }
  }
  if (uploadedBy) { where += ' AND uploaded_by = ?'; params.push(uploadedBy); }
  if (context) { where += ' AND context = ?'; params.push(context); }

  const total = (sqlite.prepare(`SELECT COUNT(*) as c FROM files WHERE ${where}`).get(...params) as any)?.c || 0;
  const files = sqlite.prepare(`SELECT * FROM files WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, limit, offset) as any[];

  return c.json({
    files: files.map(f => ({
      ...f,
      url: `/api/files/${f.id}/download`,
      is_image: f.mime_type.startsWith('image/'),
      thumbnail_url: f.mime_type.startsWith('image/') ? `/api/f/${f.filename}` : null,
    })),
    total,
    page,
    pages: Math.ceil(total / limit),
  });
});

// GET /api/files/stats — storage statistics (must be before :id)
app.get('/api/files/stats', (c) => {
  const total = sqlite.prepare('SELECT COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as total_size FROM files WHERE deleted_at IS NULL').get() as any;
  const byType = sqlite.prepare(`
    SELECT
      CASE
        WHEN mime_type LIKE 'image/%' THEN 'image'
        WHEN mime_type IN ('application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/json',
          'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') THEN 'document'
        WHEN mime_type = 'application/zip' THEN 'archive'
        ELSE 'other'
      END as category,
      COUNT(*) as count,
      COALESCE(SUM(size_bytes), 0) as total_size
    FROM files WHERE deleted_at IS NULL
    GROUP BY category
  `).all() as any[];
  const byContext = sqlite.prepare('SELECT context, COUNT(*) as count FROM files WHERE deleted_at IS NULL GROUP BY context').all() as any[];

  const archived = sqlite.prepare(
    'SELECT COUNT(*) as count, COALESCE(SUM(size_bytes), 0) as total_size FROM files WHERE archived_at IS NOT NULL'
  ).get() as any;
  const pendingArchive = sqlite.prepare(
    'SELECT COUNT(*) as count FROM files WHERE deleted_at IS NOT NULL AND archived_at IS NULL'
  ).get() as any;

  return c.json({
    total_files: total.count,
    total_size: total.total_size,
    by_type: byType,
    by_context: byContext,
    archived_files: archived.count,
    archived_size: archived.total_size,
    pending_archive: pendingArchive.count,
  });
});

// GET /api/files/:id — file metadata (owner-only, Beasts use /api/f/:hash)
app.get('/api/files/:id', (c) => {
  const role = (c.get as any)('role');
  if (role !== 'owner') return c.json({ error: 'Owner access only' }, 403);
  const id = parseInt(c.req.param('id'), 10);
  const file = sqlite.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL').get(id) as any;
  if (!file) return c.json({ error: 'File not found' }, 404);
  return c.json({
    ...file,
    url: `/api/files/${file.id}/download`,
    is_image: file.mime_type.startsWith('image/'),
    thumbnail_url: file.mime_type.startsWith('image/') ? `/api/f/${file.filename}` : null,
  });
});

// GET /api/files/:id/download — download by ID (owner-only, all other access via /api/f/:hash)
app.get('/api/files/:id/download', (c) => {
  const role = (c.get as any)('role');
  if (role !== 'owner') return c.json({ error: 'Owner access only' }, 403);
  const id = parseInt(c.req.param('id'), 10);
  const file = sqlite.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL').get(id) as any;
  if (!file) return c.json({ error: 'File not found' }, 404);

  const filePath = path.join(UPLOADS_DIR, file.filename);
  if (!fs.existsSync(filePath)) return c.json({ error: 'File not found on disk' }, 404);

  // ETag for caching
  const etag = `"${file.filename}"`;
  const ifNoneMatch = c.req.header('if-none-match');
  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304 });
  }

  const content = fs.readFileSync(filePath);
  const safeImageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
  const isImage = safeImageTypes.has(file.mime_type);

  c.header('Content-Type', isImage ? file.mime_type : 'application/octet-stream');
  c.header('Content-Disposition', isImage ? 'inline' : `attachment; filename="${file.original_name.replace(/"/g, '_')}"`);
  if (!isImage) c.header('Content-Security-Policy', 'sandbox');
  c.header('Cache-Control', 'public, max-age=31536000, immutable');
  c.header('ETag', etag);
  return c.body(content);
});

// GET /api/f/:hash — download by hash (local bypass allowed, remote requires login)
app.get('/api/f/:hash', (c) => {
  // Allow local network access without auth (Beasts on CLI need file access)
  if (!isLocalNetwork(c)) {
    const sessionCookie = getCookie(c, SESSION_COOKIE_NAME);
    const hasSession = sessionCookie && verifySessionToken(sessionCookie);
    const hasBearer = c.req.header('Authorization')?.startsWith('Bearer den_');
    if (!hasSession && !hasBearer) {
      return c.json({ error: 'Authentication required — login to access files' }, 401);
    }
  }

  const hash = c.req.param('hash');
  // Validate: alphanumeric, hyphens, dots — no path traversal
  if (hash.includes('..') || hash.includes('/')) return c.json({ error: 'Invalid file hash' }, 400);
  if (!/^[\w.-]+$/.test(hash)) return c.json({ error: 'Invalid file hash' }, 400);

  // Try files table first, then fall back to disk (legacy avatar files)
  const file = sqlite.prepare('SELECT * FROM files WHERE filename = ? AND deleted_at IS NULL').get(hash) as any;
  const filePath = path.join(UPLOADS_DIR, hash);

  // If not in active files, check if it was soft-deleted — return 404 rather than serving it from disk
  if (!file) {
    const deleted = sqlite.prepare('SELECT id FROM files WHERE filename = ? AND deleted_at IS NOT NULL').get(hash);
    if (deleted) return c.json({ error: 'File not found' }, 404);
  }

  if (!file && !fs.existsSync(filePath)) return c.json({ error: 'File not found' }, 404);
  if (file && !fs.existsSync(filePath)) return c.json({ error: 'File not found on disk' }, 404);

  const etag = `"${hash}"`;
  const ifNoneMatch = c.req.header('if-none-match');
  if (ifNoneMatch === etag) {
    return new Response(null, { status: 304 });
  }

  const content = fs.readFileSync(filePath);
  const safeImageTypes = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

  // Determine mime type from files table or extension
  const ext = hash.split('.').pop()?.toLowerCase() || '';
  const extMimeMap: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
  const mimeType = file?.mime_type || extMimeMap[ext] || 'application/octet-stream';
  const isImage = safeImageTypes.has(mimeType);
  const originalName = file?.original_name || hash;

  c.header('Content-Type', isImage ? mimeType : 'application/octet-stream');
  c.header('Content-Disposition', isImage ? 'inline' : `attachment; filename="${originalName.replace(/"/g, '_')}"`);
  if (!isImage) c.header('Content-Security-Policy', 'sandbox');
  // private — browser can cache, but CDN/reverse proxy (Caddy) must not
  c.header('Cache-Control', 'private, max-age=86400');
  c.header('ETag', etag);
  return c.body(content);
});

// DELETE /api/files/:id — soft delete (Nothing is Deleted)
// Only file uploader or owner can delete
app.delete('/api/files/:id', (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const file = sqlite.prepare('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL').get(id) as any;
  if (!file) return c.json({ error: 'File not found' }, 404);

  const role = (c.get as any)('role');
  const actor = (c.get as any)('actor');
  if (role !== 'owner' && file.uploaded_by && actor !== file.uploaded_by) {
    return c.json({ error: 'Only the uploader or owner can delete files' }, 403);
  }

  const now = Date.now();
  sqlite.prepare('UPDATE files SET deleted_at = ? WHERE id = ?').run(now, id);
  return c.json({ deleted: true, id });
});

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

// Legacy queue endpoints (backwards compat)
// GET /api/queue/gorn — list queue items
app.get('/api/queue/gorn', (c) => {
  const status = c.req.query('status') || 'pending'; // pending, decided, deferred, withdrawn
  const rows = sqlite.prepare(`
    SELECT id, title, status, category, queue_status, queue_tagged_by, queue_tagged_at, queue_summary, created_at,
      (SELECT COUNT(*) FROM forum_messages WHERE thread_id = forum_threads.id) as message_count
    FROM forum_threads
    WHERE category = 'gorn-queue' AND queue_status = ?
    ORDER BY CASE WHEN queue_status = 'deferred' THEN 1 ELSE 0 END, queue_tagged_at ASC
  `).all(status) as any[];

  return c.json({
    items: rows.map(r => ({
      thread_id: r.id,
      title: r.title,
      thread_status: r.status,
      queue_status: r.queue_status,
      tagged_by: r.queue_tagged_by,
      tagged_at: r.queue_tagged_at ? new Date(r.queue_tagged_at).toISOString() : null,
      summary: r.queue_summary,
      message_count: r.message_count,
      created_at: new Date(r.created_at).toISOString(),
    })),
    total: rows.length,
  });
});

// POST /api/queue/gorn — add thread to queue (any Beast can tag)
app.post('/api/queue/gorn', async (c) => {
  try {
    const data = await c.req.json();
    if (!data.thread_id) return c.json({ error: 'thread_id required' }, 400);

    const now = Date.now();
    sqlite.prepare(`
      UPDATE forum_threads
      SET category = 'gorn-queue', queue_status = 'pending', queue_tagged_by = ?, queue_tagged_at = ?, queue_summary = ?
      WHERE id = ?
    `).run(data.tagged_by || 'unknown', now, data.summary || null, data.thread_id);

    return c.json({ success: true, thread_id: data.thread_id, queue_status: 'pending' });
  } catch (e) {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
});

// PATCH /api/queue/gorn/:threadId — update queue status (Decided/Defer/Withdraw — gorn only from browser)
app.patch('/api/queue/gorn/:threadId', async (c) => {
  const threadId = parseInt(c.req.param('threadId'), 10);
  try {
    const data = await c.req.json();
    const allowed = ['decided', 'deferred', 'pending', 'withdrawn'];
    if (!data.status || !allowed.includes(data.status)) {
      return c.json({ error: `Invalid status. Allowed: ${allowed.join(', ')}` }, 400);
    }

    // Browser access restricted to gorn
    if (!isTrustedRequest(c)) {
      const as = data.as?.toLowerCase();
      if (as !== 'gorn') return c.json({ error: 'Only Gorn can update queue items' }, 403);
    }

    sqlite.prepare('UPDATE forum_threads SET queue_status = ? WHERE id = ? AND category = ?')
      .run(data.status, threadId, 'gorn-queue');

    return c.json({ success: true, thread_id: threadId, queue_status: data.status });
  } catch (e) {
    return c.json({ error: 'Invalid JSON' }, 400);
  }
});

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
app.get('/api/dm/dashboard', (c) => {
  const limit = parseInt(c.req.query('limit') || '50');
  const data = getDashboard(limit);
  const actor = (c.get as any)('actor') as string | undefined;
  const authMethod = (c.get as any)('authMethod') as string | undefined;
  // T#728: bearer-token callers see only their own conversations
  const filtered = (authMethod === 'token' && actor)
    ? data.conversations.filter(conv => conv.participants.some((p: string) => p.toLowerCase() === actor.toLowerCase()))
    : data.conversations;
  return c.json({
    conversations: filtered.map(conv => ({
      id: conv.id,
      participants: conv.participants,
      message_count: conv.messageCount,
      unread_count: conv.unreadCount,
      last_message: conv.lastMessage,
      last_sender: conv.lastSender,
      last_at: new Date(conv.lastAt).toISOString(),
      created_at: new Date(conv.createdAt).toISOString(),
    })),
    total_conversations: (authMethod === 'token' && actor) ? filtered.length : data.totalConversations,
    total_messages: data.totalMessages,
  });
});

// GET /api/dm/unread-count — total DM unread count for Gorn (T#535, menu bar widget)
app.get('/api/dm/unread-count', (c) => {
  const data = getDashboard(100);
  const gornConvos = data.conversations.filter(conv =>
    conv.participants.some((p: string) => p.toLowerCase() === 'gorn')
  );
  const unread = gornConvos.reduce((sum, conv) => sum + conv.unreadCount, 0);
  return c.json({ unread });
});

// Send a DM
app.post('/api/dm', async (c) => {
  try {
    const data = await c.req.json();
    if (!data.to || !data.message) {
      return c.json({ error: 'Missing required fields: to, message' }, 400);
    }

    const role = (c.get as any)('role') as Role | undefined;

    if (role === 'guest') {
      // Guest path — derive sender from guest-session auth (server-set), not body.from
      const guestUsername = (c.get as any)('guestUsername');
      if (!guestUsername) return c.json({ error: 'Guest session missing' }, 401);

      // Rate limiting
      const rateCheck = checkGuestDmRate(guestUsername);
      if (!rateCheck.allowed) {
        return c.json({ error: rateCheck.error }, 429);
      }

      // Content length limit
      const lengthCheck = checkGuestContentLength(data.message, 'dm');
      if (!lengthCheck.allowed) {
        return c.json({ error: lengthCheck.error }, 400);
      }

      // Injection pattern scan (flag, don't block)
      const scan = scanForInjection(data.message);
      if (scan.flagged) {
        logSecurityEvent({
          eventType: 'suspicious_content',
          severity: 'warning',
          actor: guestUsername,
          actorType: 'guest',
          target: `/api/dm/${data.to}`,
          details: { patterns: scan.patterns, content_preview: data.message.slice(0, 200) },
          ipSource: c.req.header('x-real-ip') || 'local',
          requestId: (c.get as any)('requestId'),
        });
      }

      // Tag guest sender — derived from session, not body
      data.from = `[Guest] ${guestUsername}`;
    } else {
      // T#718 — Beast/owner path: derive from auth-layer, reject client-asserted mismatch.
      // Closes Bertus/Flint DM-spoof finding (#10002). Any body.from must match the
      // authenticated caller, or the request is rejected.
      const caller = requireBeastIdentity(c);
      if (!caller) {
        return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
      }
      if (data.from && data.from.toLowerCase() !== caller) {
        return c.json({ error: 'Sender impersonation blocked. body.from must match authenticated caller or be omitted.' }, 403);
      }
      data.from = caller;
    }
    // Validate recipient exists — must be a beast, guest username/display name, or "gorn"
    const rawTo = data.to.replace(/^\[Guest\]\s*/, ''); // Strip [Guest] prefix if present
    const recipientBeast = getBeastProfile(rawTo);
    let recipientGuest = getGuestByUsername(sqlite, rawTo);
    // T#635: Fall back to display name lookup if username not found
    if (!recipientGuest) recipientGuest = getGuestByDisplayName(sqlite, rawTo);
    const isOwner = rawTo.toLowerCase() === 'gorn';
    if (!recipientBeast && !recipientGuest && !isOwner) {
      // T#635: Suggest similar guest usernames on mismatch
      const allGuests = listGuests(sqlite);
      const suggestions = allGuests
        .filter(g => g.username.includes(rawTo.toLowerCase()) || (g.display_name || '').toLowerCase().includes(rawTo.toLowerCase()))
        .map(g => `${g.username} (${g.display_name || g.username})`)
        .slice(0, 3);
      const hint = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(', ')}?` : '';
      return c.json({ error: `Recipient "${data.to}" not found. Must be a valid beast name or guest username.${hint}` }, 404);
    }

    // Resolve guest usernames to [Guest] tags so messages land in the same conversation
    let dmFrom = data.from;
    let dmTo = data.to;
    const guestFrom = getGuestByUsername(sqlite, data.from);
    if (guestFrom) dmFrom = `[Guest] ${guestFrom.display_name || data.from}`;
    if (recipientGuest) dmTo = `[Guest] ${recipientGuest.display_name || rawTo}`;
    else if (data.to !== rawTo) dmTo = rawTo; // Strip [Guest] prefix for beast recipients

    const result = await withRetry(() => sendDm(dmFrom, dmTo, data.message));
    // Set author_role on DM message (Spec #32, T#557 — Talon review fix)
    if (result.messageId) {
      const authorRole = role === 'guest' ? 'guest' : (role === 'owner' ? 'owner' : 'beast');
      try {
        sqlite.prepare('UPDATE dm_messages SET author_role = ? WHERE id = ?')
          .run(authorRole, result.messageId);
      } catch { /* column may not exist yet */ }
    }
    wsBroadcast('new_dm', { conversation_id: result.conversationId });
    return c.json({
      conversation_id: result.conversationId,
      message_id: result.messageId,
      from: data.from.toLowerCase(),
      to: data.to.toLowerCase(),
      notified: result.notified,
    }, 201);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// List conversations for an Oracle
app.get('/api/dm/:name', (c) => {
  const name = c.req.param('name');
  const as = c.req.query('as')?.toLowerCase();
  const actor = (c.get as any)('actor') as string | undefined;
  const authMethod = (c.get as any)('authMethod') as string | undefined;
  // T#728: bearer-token callers can only list their own conversations
  if (authMethod === 'token' && actor && actor.toLowerCase() !== name.toLowerCase()) {
    return c.json({ error: 'Access denied. You can only view your own conversations.' }, 403);
  }
  if (!isTrustedRequest(c)) {
    if (!as) return c.json({ error: 'as param required for DM access' }, 400);
    if (as !== 'gorn' && as !== name.toLowerCase()) {
      return c.json({ error: 'Access denied. You can only view your own conversations.' }, 403);
    }
  }
  const limit = parseInt(c.req.query('limit') || '20');
  const offset = parseInt(c.req.query('offset') || '0');
  const data = listConversations(name, limit, offset);
  return c.json({
    conversations: data.conversations.map(conv => ({
      id: conv.id,
      with: conv.with,
      last_message: conv.lastMessage,
      last_sender: conv.lastSender,
      last_at: new Date(conv.lastAt).toISOString(),
      unread_count: conv.unreadCount,
      created_at: new Date(conv.createdAt).toISOString(),
    })),
    total: data.total,
  });
});

// Get messages between two Oracles (also handles guest usernames)
app.get('/api/dm/:name/:other', (c) => {
  let name = c.req.param('name');
  let other = c.req.param('other');
  const as = c.req.query('as')?.toLowerCase();

  // Resolve guest usernames to [Guest] tags
  // If name/other doesn't match a known beast and matches a guest account, use the [Guest] tag
  for (const param of ['name', 'other'] as const) {
    const val = param === 'name' ? name : other;
    if (!val.startsWith('[Guest]') && !val.startsWith('[guest]')) {
      const guest = getGuestByUsername(sqlite, val);
      if (guest) {
        const tag = `[Guest] ${guest.display_name || val}`;
        if (param === 'name') name = tag;
        else other = tag;
      }
    }
  }
  const actor = (c.get as any)('actor') as string | undefined;
  const authMethod = (c.get as any)('authMethod') as string | undefined;
  // T#728: bearer-token callers can only read conversations they are part of
  if (authMethod === 'token' && actor) {
    const actorLower = actor.toLowerCase();
    if (actorLower !== name.toLowerCase() && actorLower !== other.toLowerCase()) {
      return c.json({ error: 'Access denied. You can only read conversations you are part of.' }, 403);
    }
  }
  if (!isTrustedRequest(c)) {
    if (!as) return c.json({ error: 'as param required for DM access' }, 400);
    if (as !== 'gorn' && as !== name.toLowerCase() && as !== other.toLowerCase()) {
      return c.json({ error: 'Access denied. You can only read conversations you are part of.' }, 403);
    }
  }
  const parsedDmLimit = parseInt(c.req.query('limit') || '50', 10);
  const limit = isNaN(parsedDmLimit) || parsedDmLimit < 1 ? 50 : parsedDmLimit;
  const parsedDmOffset = parseInt(c.req.query('offset') || '0', 10);
  const offset = isNaN(parsedDmOffset) || parsedDmOffset < 0 ? 0 : parsedDmOffset;
  const order = (c.req.query('order') === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc';
  const data = getDmMessages(name, other, limit, offset, order);
  return c.json({
    conversation_id: data.conversationId,
    participants: data.participants,
    messages: data.messages.map(m => ({
      id: m.id,
      sender: m.sender,
      message: m.content,
      read_at: m.readAt ? new Date(m.readAt).toISOString() : null,
      created_at: new Date(m.createdAt).toISOString(),
    })),
    total: data.total,
  });
});

// Mark messages as read (from other to reader) — only the reader can mark their own
app.patch('/api/dm/:name/:other/read', (c) => {
  const reader = c.req.param('name');
  const other = c.req.param('other');
  if (!isTrustedRequest(c)) {
    const as = c.req.query('as')?.toLowerCase();
    if (!as) return c.json({ error: 'as param required' }, 400);
    if (as !== reader.toLowerCase() && as !== 'gorn') {
      return c.json({ error: 'Can only mark your own messages as read' }, 403);
    }
  }
  const result = markRead(reader, other);
  if (result.markedRead > 0) wsBroadcast('dm_read', { conversation_id: result.conversationId, reader });
  return c.json({
    marked_read: result.markedRead,
    conversation_id: result.conversationId,
  });
});

// Mark ALL messages in a conversation as read — only participant or gorn
app.patch('/api/dm/:name/:other/read-all', (c) => {
  const name = c.req.param('name');
  const other = c.req.param('other');
  if (!isTrustedRequest(c)) {
    const as = c.req.query('as')?.toLowerCase();
    if (!as) return c.json({ error: 'as param required' }, 400);
    if (as !== name.toLowerCase() && as !== other.toLowerCase() && as !== 'gorn') {
      return c.json({ error: 'Can only mark messages as read in your own conversations' }, 403);
    }
  }
  const result = markAllRead(name, other);
  if (result.markedRead > 0) wsBroadcast('dm_read', { conversation_id: result.conversationId, reader: name });
  return c.json({
    marked_read: result.markedRead,
    conversation_id: result.conversationId,
  });
});

// DELETE /api/dm/messages/:id — delete a single DM message
// Auth: conversation participant or Gorn only (Bertus security review)
app.delete('/api/dm/messages/:id', (c) => {
  const id = parseInt(c.req.param('id'));
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  // T#718 — derive caller from auth, reject ?as= mismatch
  const caller = requireBeastIdentity(c);
  if (!caller) {
    return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
  }
  const claimedAs = c.req.query('as')?.toLowerCase();
  if (claimedAs && claimedAs !== caller) {
    return c.json({ error: 'Identity spoof blocked. ?as= must match authenticated caller or be omitted.' }, 403);
  }
  const as = caller;
  const msg = sqlite.prepare('SELECT m.*, c.participant1, c.participant2 FROM dm_messages m JOIN dm_conversations c ON c.id = m.conversation_id WHERE m.id = ?').get(id) as any;
  if (!msg) return c.json({ error: 'Message not found' }, 404);
  if (as !== 'gorn' && as !== msg.sender && as !== msg.participant1 && as !== msg.participant2) {
    return c.json({ error: 'Can only delete messages in your own conversations' }, 403);
  }
  sqlite.prepare('DELETE FROM dm_messages WHERE id = ?').run(id);
  return c.json({ deleted: id });
});

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

// Security team allowlist for audit log read access
const AUDIT_READ_ALLOWLIST = ['bertus', 'talon'];

app.get('/api/audit', (c) => {
  // T#727: bearer-derive + legacy ?as= for security team check
  const requester = ((c.get as any)('actor') || c.req.query('as') || '').toLowerCase();
  if (!hasSessionAuth(c) && !AUDIT_READ_ALLOWLIST.includes(requester)) {
    return c.json({ error: 'Audit logs are restricted to Gorn and security team' }, 403);
  }

  const actor = c.req.query('actor');
  const resourceType = c.req.query('resource_type');
  const statusCode = c.req.query('status_code');
  const method = c.req.query('method');
  const requestId = c.req.query('request_id');
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');
  const since = c.req.query('since');

  let query = 'SELECT * FROM audit_log WHERE 1=1';
  let countQuery = 'SELECT COUNT(*) as count FROM audit_log WHERE 1=1';
  const params: any[] = [];
  const countParams: any[] = [];

  if (actor) { query += ' AND actor = ?'; countQuery += ' AND actor = ?'; params.push(actor); countParams.push(actor); }
  if (resourceType) { query += ' AND resource_type = ?'; countQuery += ' AND resource_type = ?'; params.push(resourceType); countParams.push(resourceType); }
  if (statusCode) { query += ' AND status_code = ?'; countQuery += ' AND status_code = ?'; params.push(parseInt(statusCode)); countParams.push(parseInt(statusCode)); }
  if (method) { query += ' AND request_method = ?'; countQuery += ' AND request_method = ?'; params.push(method.toUpperCase()); countParams.push(method.toUpperCase()); }
  if (requestId) { query += ' AND request_id = ?'; countQuery += ' AND request_id = ?'; params.push(requestId); countParams.push(requestId); }
  if (since) { query += ' AND datetime(timestamp) >= datetime(?)'; countQuery += ' AND datetime(timestamp) >= datetime(?)'; params.push(since); countParams.push(since); }
  query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const total = (sqlite.prepare(countQuery).get(...countParams) as any)?.count || 0;
  const rows = sqlite.prepare(query).all(...params) as any[];
  return c.json({ audit: rows, total, limit, offset });
});

// GET /api/audit/stats — summary counts
app.get('/api/audit/stats', (c) => {
  // T#727: bearer-derive + legacy ?as= for security team check
  const requester = ((c.get as any)('actor') || c.req.query('as') || '').toLowerCase();
  if (!hasSessionAuth(c) && !AUDIT_READ_ALLOWLIST.includes(requester)) {
    return c.json({ error: 'Audit stats are restricted to Gorn and security team' }, 403);
  }

  const total = (sqlite.prepare('SELECT COUNT(*) as count FROM audit_log').get() as any)?.count || 0;
  const denied = (sqlite.prepare("SELECT COUNT(*) as count FROM audit_log WHERE status_code = 403").get() as any)?.count || 0;
  const errors = (sqlite.prepare("SELECT COUNT(*) as count FROM audit_log WHERE status_code >= 500").get() as any)?.count || 0;
  const byActor = sqlite.prepare('SELECT actor, COUNT(*) as count FROM audit_log GROUP BY actor ORDER BY count DESC LIMIT 10').all();
  const byResource = sqlite.prepare('SELECT resource_type, COUNT(*) as count FROM audit_log GROUP BY resource_type ORDER BY count DESC LIMIT 10').all();
  const byMethod = sqlite.prepare('SELECT request_method, COUNT(*) as count FROM audit_log GROUP BY request_method ORDER BY count DESC').all();
  return c.json({ total, denied, errors, by_actor: byActor, by_resource: byResource, by_method: byMethod });
});

// ============================================================================
// Security Events API (T#545 — Security event logging)
// ============================================================================

// Security events access: Gorn (session) or security team (local trusted + allowlist).
// T#648: ?as= requires isTrustedRequest to mitigate spoofing (Risk #12) — remote ?as= is rejected.
const SECURITY_READ_ALLOWLIST = ['bertus', 'talon'];

// GET /api/security/events — query security events
app.get('/api/security/events', (c) => {
  // T#727: bearer-derive + legacy ?as= for security team check
  const requester = ((c.get as any)('actor') || c.req.query('as') || '').toLowerCase();
  const isSecurityTeam = (isTrustedRequest(c) || (c.get as any)('authMethod') === 'token') && SECURITY_READ_ALLOWLIST.includes(requester);
  if (!hasSessionAuth(c) && !isSecurityTeam) {
    return c.json({ error: 'Security events are restricted to Gorn and security team' }, 403);
  }

  const eventType = c.req.query('event_type');
  const severity = c.req.query('severity');
  const actor = c.req.query('actor');
  const since = c.req.query('since');
  const limit = parseInt(c.req.query('limit') || '100');
  const offset = parseInt(c.req.query('offset') || '0');

  let query = 'SELECT * FROM security_events WHERE 1=1';
  let countQuery = 'SELECT COUNT(*) as count FROM security_events WHERE 1=1';
  const params: any[] = [];
  const countParams: any[] = [];

  if (eventType) { query += ' AND event_type = ?'; countQuery += ' AND event_type = ?'; params.push(eventType); countParams.push(eventType); }
  if (severity) { query += ' AND severity = ?'; countQuery += ' AND severity = ?'; params.push(severity); countParams.push(severity); }
  if (actor) { query += ' AND actor = ?'; countQuery += ' AND actor = ?'; params.push(actor); countParams.push(actor); }
  if (since) {
    const sinceEpoch = Math.floor(new Date(since).getTime() / 1000);
    query += ' AND timestamp >= ?'; countQuery += ' AND timestamp >= ?';
    params.push(sinceEpoch); countParams.push(sinceEpoch);
  }
  query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const total = (sqlite.prepare(countQuery).get(...countParams) as any)?.count || 0;
  const rows = sqlite.prepare(query).all(...params) as any[];

  // Parse details JSON for convenience
  const events = rows.map(r => ({
    ...r,
    details: r.details ? JSON.parse(r.details) : null,
    timestamp_iso: new Date(r.timestamp * 1000).toISOString(),
  }));

  return c.json({ events, total, limit, offset });
});

// GET /api/security/events/stats — summary counts
app.get('/api/security/events/stats', (c) => {
  // T#727: bearer-derive + legacy ?as= for security team check
  const requester = ((c.get as any)('actor') || c.req.query('as') || '').toLowerCase();
  const isSecurityTeam = (isTrustedRequest(c) || (c.get as any)('authMethod') === 'token') && SECURITY_READ_ALLOWLIST.includes(requester);
  if (!hasSessionAuth(c) && !isSecurityTeam) {
    return c.json({ error: 'Security event stats are restricted to Gorn and security team' }, 403);
  }

  const total = (sqlite.prepare('SELECT COUNT(*) as count FROM security_events').get() as any)?.count || 0;
  const bySeverity = sqlite.prepare('SELECT severity, COUNT(*) as count FROM security_events GROUP BY severity ORDER BY count DESC').all();
  const byType = sqlite.prepare('SELECT event_type, COUNT(*) as count FROM security_events GROUP BY event_type ORDER BY count DESC').all();
  const byActor = sqlite.prepare('SELECT actor, COUNT(*) as count FROM security_events WHERE actor IS NOT NULL GROUP BY actor ORDER BY count DESC LIMIT 10').all();
  const last24h = (sqlite.prepare('SELECT COUNT(*) as count FROM security_events WHERE timestamp > ?').get(Math.floor(Date.now() / 1000) - 86400) as any)?.count || 0;
  const criticalCount = (sqlite.prepare("SELECT COUNT(*) as count FROM security_events WHERE severity = 'critical'").get() as any)?.count || 0;
  const warningCount = (sqlite.prepare("SELECT COUNT(*) as count FROM security_events WHERE severity = 'warning'").get() as any)?.count || 0;

  return c.json({
    total,
    last_24h: last24h,
    critical: criticalCount,
    warnings: warningCount,
    by_severity: bySeverity,
    by_type: byType,
    by_actor: byActor,
    retention_days: SECURITY_RETENTION_DAYS,
  });
});

// ============================================================================
// Teams API (Task #81 — Gnarl spec, thread #105)
// ============================================================================

// GET /api/teams — list all teams with member counts
app.get('/api/teams', (c) => {
  const teams = sqlite.prepare(`
    SELECT t.*, COUNT(tm.beast) as member_count
    FROM teams t
    LEFT JOIN team_members tm ON tm.team_id = t.id
    GROUP BY t.id
    ORDER BY t.name
  `).all() as any[];
  return c.json({ teams, total: teams.length });
});

// Helper: validate team name (alphanumeric, spaces, hyphens only)
function validateTeamName(name: string): string | null {
  if (!name || name.trim().length === 0) return 'name required';
  if (name.length > 100) return 'name too long (max 100 chars)';
  if (!/^[a-zA-Z0-9 _-]+$/.test(name)) return 'name contains invalid characters (use letters, numbers, spaces, hyphens only)';
  return null;
}

// Helper: sanitize text input (strip HTML tags)
function sanitizeInput(text: string): string {
  return text.replace(/<[^>]*>/g, '').trim();
}

// Helper: check if beast exists
function beastExists(name: string): boolean {
  const row = sqlite.prepare('SELECT name FROM beast_profiles WHERE name = ?').get(name.toLowerCase());
  return !!row;
}

// POST /api/teams — create a team
app.post('/api/teams', async (c) => {
  const data = await c.req.json();
  const nameErr = validateTeamName(data.name);
  if (nameErr) return c.json({ error: nameErr }, 400);
  if (!data.created_by) return c.json({ error: 'created_by required' }, 400);
  const name = sanitizeInput(data.name);
  const description = data.description ? sanitizeInput(data.description) : null;
  try {
    const result = sqlite.prepare(
      'INSERT INTO teams (name, description, created_by) VALUES (?, ?, ?)'
    ).run(name, description, data.created_by);
    // Auto-add creator as lead
    sqlite.prepare('INSERT INTO team_members (team_id, beast, role) VALUES (?, ?, ?)').run(result.lastInsertRowid, data.created_by, 'lead');
    const team = sqlite.prepare('SELECT * FROM teams WHERE id = ?').get(result.lastInsertRowid);
    return c.json(team, 201);
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) return c.json({ error: 'Team name already exists' }, 409);
    throw e;
  }
});

// GET /api/teams/:id — team detail with members and projects
app.get('/api/teams/:id', (c) => {
  const id = parseInt(c.req.param('id'));
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const team = sqlite.prepare('SELECT * FROM teams WHERE id = ?').get(id) as any;
  if (!team) return c.json({ error: 'Team not found' }, 404);
  const members = sqlite.prepare('SELECT beast, role, joined_at FROM team_members WHERE team_id = ?').all(id);
  const projects = sqlite.prepare('SELECT project_id FROM team_projects WHERE team_id = ?').all(id);
  return c.json({ ...team, members, projects });
});

// PATCH /api/teams/:id — update team
app.patch('/api/teams/:id', async (c) => {
  const id = parseInt(c.req.param('id'));
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const team = sqlite.prepare('SELECT * FROM teams WHERE id = ?').get(id);
  if (!team) return c.json({ error: 'Team not found' }, 404);
  const data = await c.req.json();
  if (data.name) {
    const nameErr = validateTeamName(data.name);
    if (nameErr) return c.json({ error: nameErr }, 400);
    sqlite.prepare('UPDATE teams SET name = ? WHERE id = ?').run(sanitizeInput(data.name), id);
  }
  if (data.description !== undefined) sqlite.prepare('UPDATE teams SET description = ? WHERE id = ?').run(sanitizeInput(data.description || ''), id);
  const updated = sqlite.prepare('SELECT * FROM teams WHERE id = ?').get(id);
  return c.json(updated);
});

// POST /api/teams/:id/members — add Beast to team
app.post('/api/teams/:id/members', async (c) => {
  const id = parseInt(c.req.param('id'));
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const team = sqlite.prepare('SELECT * FROM teams WHERE id = ?').get(id);
  if (!team) return c.json({ error: 'Team not found' }, 404);
  const data = await c.req.json();
  if (!data.beast) return c.json({ error: 'beast required' }, 400);
  if (!beastExists(data.beast)) return c.json({ error: `Beast '${data.beast}' not found` }, 404);
  try {
    sqlite.prepare('INSERT INTO team_members (team_id, beast, role) VALUES (?, ?, ?)').run(id, data.beast.toLowerCase(), data.role || 'member');
    return c.json({ team_id: id, beast: data.beast.toLowerCase(), role: data.role || 'member' }, 201);
  } catch (e: any) {
    if (e.message?.includes('UNIQUE') || e.message?.includes('PRIMARY')) return c.json({ error: 'Beast already in team' }, 409);
    throw e;
  }
});

// DELETE /api/teams/:id/members/:beast — remove Beast from team
app.delete('/api/teams/:id/members/:beast', (c) => {
  const id = parseInt(c.req.param('id'));
  const beast = c.req.param('beast').toLowerCase();
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const result = sqlite.prepare('DELETE FROM team_members WHERE team_id = ? AND beast = ?').run(id, beast);
  if (result.changes === 0) return c.json({ error: 'Member not found in team' }, 404);
  return c.json({ removed: beast, team_id: id });
});

// POST /api/teams/:id/projects — link project to team
app.post('/api/teams/:id/projects', async (c) => {
  const id = parseInt(c.req.param('id'));
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const data = await c.req.json();
  if (!data.project_id) return c.json({ error: 'project_id required' }, 400);
  try {
    sqlite.prepare('INSERT INTO team_projects (team_id, project_id) VALUES (?, ?)').run(id, data.project_id);
    return c.json({ team_id: id, project_id: data.project_id }, 201);
  } catch (e: any) {
    if (e.message?.includes('UNIQUE') || e.message?.includes('PRIMARY')) return c.json({ error: 'Project already linked' }, 409);
    throw e;
  }
});

// DELETE /api/teams/:id/projects/:projectId — unlink project
app.delete('/api/teams/:id/projects/:projectId', (c) => {
  const id = parseInt(c.req.param('id'));
  const projectId = parseInt(c.req.param('projectId'));
  if (isNaN(id) || isNaN(projectId)) return c.json({ error: 'Invalid ID' }, 400);
  const result = sqlite.prepare('DELETE FROM team_projects WHERE team_id = ? AND project_id = ?').run(id, projectId);
  if (result.changes === 0) return c.json({ error: 'Project not linked to team' }, 404);
  return c.json({ removed_project: projectId, team_id: id });
});

// DELETE /api/teams/:id — delete a team and all related data (members, projects)
// Auth: team creator or Gorn only (Bertus security review)
app.delete('/api/teams/:id', (c) => {
  const id = parseInt(c.req.param('id'));
  if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
  const as = c.req.query('as')?.toLowerCase() || (hasSessionAuth(c) ? 'gorn' : '');
  if (!as) return c.json({ error: 'as param required for DELETE' }, 400);
  const existing = sqlite.prepare('SELECT * FROM teams WHERE id = ?').get(id) as any;
  if (!existing) return c.json({ error: 'Team not found' }, 404);
  if (as !== 'gorn' && as !== existing.created_by?.toLowerCase()) {
    return c.json({ error: 'Only the team creator or Gorn can delete a team' }, 403);
  }
  // Cascade: remove members, projects, then team
  sqlite.prepare('DELETE FROM team_members WHERE team_id = ?').run(id);
  sqlite.prepare('DELETE FROM team_projects WHERE team_id = ?').run(id);
  sqlite.prepare('DELETE FROM teams WHERE id = ?').run(id);
  return c.json({ deleted: id, name: existing.name });
});

// GET /api/teams/beast/:beast — list teams for a specific Beast
app.get('/api/teams/beast/:beast', (c) => {
  const beast = c.req.param('beast').toLowerCase();
  const teams = sqlite.prepare(`
    SELECT t.*, tm.role
    FROM teams t
    JOIN team_members tm ON tm.team_id = t.id
    WHERE tm.beast = ?
    ORDER BY t.name
  `).all(beast) as any[];
  return c.json({ beast, teams, total: teams.length });
});


// Scheduler routes + helpers + auto-trigger daemon — extracted to src/scheduler/routes.ts (T#772)
initScheduler(sqlite, db, REPO_ROOT, { wsBroadcast, enqueueNotification });
registerSchedulerRoutes(app, sqlite, { hasSessionAuth, requireBeastIdentity });



// Daemons (notification drain + DB maintenance + file archive) — extracted to src/daemons/routes.ts (T#773)
initDaemons(sqlite);
registerDaemonRoutes(app, sqlite);



// Withings auto-sync daemon — moved to src/integrations/routes.ts initIntegrations() (T#775)


// List supersessions with optional filters
app.get('/api/supersede', (c) => {
  const project = c.req.query('project');
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  // Build where clause using Drizzle
  const whereClause = project ? eq(supersedeLog.project, project) : undefined;

  // Get total count using Drizzle
  const countResult = db.select({ total: sql<number>`count(*)` })
    .from(supersedeLog)
    .where(whereClause)
    .get();
  const total = countResult?.total || 0;

  // Get logs using Drizzle
  const logs = db.select()
    .from(supersedeLog)
    .where(whereClause)
    .orderBy(desc(supersedeLog.supersededAt))
    .limit(limit)
    .offset(offset)
    .all();

  return c.json({
    supersessions: logs.map(log => ({
      id: log.id,
      old_path: log.oldPath,
      old_id: log.oldId,
      old_title: log.oldTitle,
      old_type: log.oldType,
      new_path: log.newPath,
      new_id: log.newId,
      new_title: log.newTitle,
      reason: log.reason,
      superseded_at: new Date(log.supersededAt).toISOString(),
      superseded_by: log.supersededBy,
      project: log.project
    })),
    total,
    limit,
    offset
  });
});

// Get supersede chain for a document (what superseded what)
app.get('/api/supersede/chain/:path', (c) => {
  const docPath = decodeURIComponent(c.req.param('path'));

  // Find all supersessions where this doc was old or new using Drizzle
  const asOld = db.select()
    .from(supersedeLog)
    .where(eq(supersedeLog.oldPath, docPath))
    .orderBy(supersedeLog.supersededAt)
    .all();

  const asNew = db.select()
    .from(supersedeLog)
    .where(eq(supersedeLog.newPath, docPath))
    .orderBy(supersedeLog.supersededAt)
    .all();

  return c.json({
    superseded_by: asOld.map(log => ({
      new_path: log.newPath,
      reason: log.reason,
      superseded_at: new Date(log.supersededAt).toISOString()
    })),
    supersedes: asNew.map(log => ({
      old_path: log.oldPath,
      reason: log.reason,
      superseded_at: new Date(log.supersededAt).toISOString()
    }))
  });
});

// Log a new supersession
app.post('/api/supersede', async (c) => {
  try {
    const data = await c.req.json();
    if (!data.old_path) {
      return c.json({ error: 'Missing required field: old_path' }, 400);
    }

    const result = db.insert(supersedeLog).values({
      oldPath: data.old_path,
      oldId: data.old_id || null,
      oldTitle: data.old_title || null,
      oldType: data.old_type || null,
      newPath: data.new_path || null,
      newId: data.new_id || null,
      newTitle: data.new_title || null,
      reason: data.reason || null,
      supersededAt: Date.now(),
      supersededBy: data.superseded_by || 'user',
      project: data.project || null
    }).returning({ id: supersedeLog.id }).get();

    return c.json({
      id: result.id,
      message: 'Supersession logged'
    }, 201);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// ============================================================================
// Trace Routes - Discovery journey visualization
// ============================================================================

app.get('/api/traces', (c) => {
  const query = c.req.query('query');
  const status = c.req.query('status');
  const project = c.req.query('project');
  const limit = parseInt(c.req.query('limit') || '50');
  const offset = parseInt(c.req.query('offset') || '0');

  const result = listTraces({
    query: query || undefined,
    status: status as 'raw' | 'reviewed' | 'distilled' | undefined,
    project: project || undefined,
    limit,
    offset
  });

  return c.json(result);
});

app.get('/api/traces/:id', (c) => {
  const traceId = c.req.param('id');
  const trace = getTrace(traceId);

  if (!trace) {
    return c.json({ error: 'Trace not found' }, 404);
  }

  return c.json(trace);
});

app.get('/api/traces/:id/chain', (c) => {
  const traceId = c.req.param('id');
  const direction = c.req.query('direction') as 'up' | 'down' | 'both' || 'both';

  const chain = getTraceChain(traceId, direction);
  return c.json(chain);
});

// Link traces: POST /api/traces/:prevId/link { nextId: "..." }
app.post('/api/traces/:prevId/link', async (c) => {
  try {
    const prevId = c.req.param('prevId');
    const { nextId } = await c.req.json();

    if (!nextId) {
      return c.json({ error: 'Missing nextId in request body' }, 400);
    }

    const result = linkTraces(prevId, nextId);

    if (!result.success) {
      return c.json({ error: result.message }, 400);
    }

    return c.json(result);
  } catch (err) {
    console.error('Link traces error:', err);
    return c.json({ error: 'Failed to link traces' }, 500);
  }
});

// Unlink trace: DELETE /api/traces/:id/link?direction=prev|next
app.delete('/api/traces/:id/link', async (c) => {
  try {
    const traceId = c.req.param('id');
    const direction = c.req.query('direction') as 'prev' | 'next';

    if (!direction || !['prev', 'next'].includes(direction)) {
      return c.json({ error: 'Missing or invalid direction (prev|next)' }, 400);
    }

    const result = unlinkTraces(traceId, direction);

    if (!result.success) {
      return c.json({ error: result.message }, 400);
    }

    return c.json(result);
  } catch (err) {
    console.error('Unlink traces error:', err);
    return c.json({ error: 'Failed to unlink traces' }, 500);
  }
});

// Get trace linked chain: GET /api/traces/:id/linked-chain
app.get('/api/traces/:id/linked-chain', async (c) => {
  try {
    const traceId = c.req.param('id');
    const result = getTraceLinkedChain(traceId);
    return c.json(result);
  } catch (err) {
    console.error('Get linked chain error:', err);
    return c.json({ error: 'Failed to get linked chain' }, 500);
  }
});

// ============================================================================
// Inbox Routes (handoff context between sessions)
// ============================================================================

app.post('/api/handoff', async (c) => {
  try {
    const data = await c.req.json();
    if (!data.content) {
      return c.json({ error: 'Missing required field: content' }, 400);
    }

    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    const timeStr = `${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`;

    // Generate slug
    const slug = data.slug || data.content
      .substring(0, 50)
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'handoff';

    const filename = `${dateStr}_${timeStr}_${slug}.md`;
    const dirPath = path.join(REPO_ROOT, 'ψ/inbox/handoff');
    const filePath = path.join(dirPath, filename);

    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(filePath, data.content, 'utf-8');

    // T#658 — Norm #65 — auto-set requesting Beast to rest_status='rest'
    // Identity comes from ?as= param. Cross-Beast rest writes are rejected:
    // we only ever update the verified requester's rest_status, never another Beast.
    let restedBeast: string | null = null;
    const asParam = c.req.query('as')?.toLowerCase();
    if (asParam && isTrustedRequest(c)) {
      const beastRow = sqlite.prepare('SELECT name FROM beast_profiles WHERE name = ?').get(asParam) as any;
      if (beastRow) {
        sqlite.prepare("UPDATE beast_profiles SET rest_status = 'rest', updated_at = ? WHERE name = ?")
          .run(Date.now(), asParam);
        restedBeast = asParam;
        console.log(`[Handoff] ${asParam} → rest_status=rest`);
        wsBroadcast('beast_state_change', { beast: asParam, rest_status: 'rest' });
      }
    }

    return c.json({
      success: true,
      file: `ψ/inbox/handoff/${filename}`,
      rested_beast: restedBeast,
      message: restedBeast
        ? `Handoff written. ${restedBeast} → rest_status=rest. Schedules paused until /wake.`
        : 'Handoff written.'
    }, 201);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

// T#658 — Norm #65 — Wake a Beast from rest. Resumes scheduler firing.
// On wake, schedules overdue by more than SCHEDULER_STORM_CAP_HOURS (default 24)
// are silently dropped — their next_due_at is advanced past the storm window.
app.post('/api/beast/:name/wake', (c) => {
  try {
    const name = c.req.param('name').toLowerCase();
    const asParam = c.req.query('as')?.toLowerCase();

    // Auth: requester must be the beast itself or gorn (same as schedule mutations)
    if (!isTrustedRequest(c)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    if (asParam && asParam !== name && asParam !== 'gorn') {
      return c.json({ error: 'Cross-Beast wake denied. You can only wake yourself or be Gorn.' }, 403);
    }

    const beastRow = sqlite.prepare('SELECT name, rest_status FROM beast_profiles WHERE name = ?').get(name) as any;
    if (!beastRow) {
      return c.json({ error: `Beast '${name}' not found` }, 404);
    }

    const previousStatus = beastRow.rest_status || 'active';

    // Schedule storm cap — drop schedules overdue by more than the cap
    const stormCapHours = parseInt(process.env.SCHEDULER_STORM_CAP_HOURS || '24');
    const cutoff = new Date(Date.now() - stormCapHours * 3600 * 1000).toISOString();
    const dropResult = sqlite.prepare(
      `UPDATE beast_schedules
       SET next_due_at = datetime('now', '+' || CAST(interval_seconds AS TEXT) || ' seconds'),
           trigger_status = 'pending',
           updated_at = datetime('now')
       WHERE beast = ?
         AND enabled = 1
         AND datetime(next_due_at) < datetime(?)`
    ).run(name, cutoff);

    // Set rest_status back to active
    sqlite.prepare("UPDATE beast_profiles SET rest_status = 'active', updated_at = ? WHERE name = ?")
      .run(Date.now(), name);

    console.log(`[Wake] ${name}: rest_status ${previousStatus} → active. Dropped ${dropResult.changes} schedules overdue by >${stormCapHours}h.`);
    wsBroadcast('beast_state_change', { beast: name, rest_status: 'active' });

    return c.json({
      beast: name,
      previous_status: previousStatus,
      current_status: 'active',
      schedules_dropped: dropResult.changes,
      storm_cap_hours: stormCapHours,
      resumed_at: new Date().toISOString(),
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});

app.get('/api/inbox', (c) => {
  const limit = parseInt(c.req.query('limit') || '10');
  const offset = parseInt(c.req.query('offset') || '0');
  const type = c.req.query('type') || 'all';

  const inboxDir = path.join(REPO_ROOT, 'ψ/inbox');
  const results: Array<{ filename: string; path: string; created: string; preview: string; type: string }> = [];

  if (type === 'all' || type === 'handoff') {
    const handoffDir = path.join(inboxDir, 'handoff');
    if (fs.existsSync(handoffDir)) {
      const files = fs.readdirSync(handoffDir)
        .filter(f => f.endsWith('.md'))
        .sort()
        .reverse();

      for (const file of files) {
        const filePath = path.join(handoffDir, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        const dateMatch = file.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2})/);
        const created = dateMatch
          ? `${dateMatch[1]}T${dateMatch[2].replace('-', ':')}:00`
          : 'unknown';

        results.push({
          filename: file,
          path: `ψ/inbox/handoff/${file}`,
          created,
          preview: content.substring(0, 500),
          type: 'handoff',
        });
      }
    }
  }

  const total = results.length;
  const paginated = results.slice(offset, offset + limit);

  return c.json({ files: paginated, total, limit, offset });
});

// ============================================================================
// Learn Route
// ============================================================================

app.post('/api/learn', async (c) => {
  try {
    const data = await c.req.json();
    if (!data.pattern) {
      return c.json({ error: 'Missing required field: pattern' }, 400);
    }
    const result = handleLearn(
      data.pattern,
      data.source,
      data.concepts,
      data.origin,   // 'mother' | 'arthur' | 'volt' | 'human' (null = universal)
      data.project,  // ghq-style project path (null = universal)
      data.cwd       // Auto-detect project from cwd
    );
    return c.json(result);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : 'Unknown error'
    }, 500);
  }
});


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
registerProwlRoutes(app, sqlite, { hasSessionAuth, isTrustedRequest, wsBroadcast, enqueueNotification });

// Library routes extracted to src/library/routes.ts (T#768)
registerLibraryRoutes(app, sqlite, { hasSessionAuth, requireBeastIdentity, searchIndexUpsert, searchIndexDelete, wsBroadcast });

// Risk routes extracted to src/risk/routes.ts (T#769)
registerRiskRoutes(app, sqlite, { hasSessionAuth, wsBroadcast });
// Search routes + Meilisearch + FTS5 — extracted to src/search/routes.ts (T#771)
initSearch(sqlite);
registerSearchRoutes(app, sqlite, { hasSessionAuth, isLocalNetwork, isTrustedRequest, handleSearch });

// Telegram routes + polling — extracted to src/telegram/routes.ts (T#770)
registerTelegramRoutes(app, sqlite, { hasSessionAuth, isTrustedRequest, uploadsDir: UPLOADS_DIR });

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

// Web presence tracking — in-memory, ephemeral (T#595)
// Keyed by identity (e.g. 'gorn', 'gorn_guest'). Rebuilt on server restart.
const webPresence = new Map<string, { identity: string; role: string; lastSeen: number }>();
const WEB_PRESENCE_TIMEOUT_MS = 90_000; // 90s — 3 missed heartbeats

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
