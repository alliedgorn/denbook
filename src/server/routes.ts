import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';
import {
  SESSION_COOKIE_NAME, SESSION_DURATION_MS, GUEST_SESSION_DURATION_MS,
  LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_MS, WEB_PRESENCE_TIMEOUT_MS,
  getRateLimit, clearRateLimit,
  generateSessionToken, isAuthenticated, isLocalNetwork,
} from '../server.ts';
import {
  createGuest, listGuests, getGuest, getGuestByUsername,
  updateGuest, deleteGuest, banGuest, unbanGuest,
  isGuestActive, recordFailedAttempt, recordSuccessfulLogin,
  resetGuestPassword,
} from './guest-accounts.ts';
import { logSecurityEvent } from './security-logger.ts';
import {
  createToken, listTokens, revokeToken, rotateToken,
  selfRotateToken, getTokenInfo,
} from './beast-tokens.ts';
import { getSetting } from '../db/index.ts';

// ============================================================================
// Server routes — Phase 2.3 of Library #102 (T#781)
// Auth + Guest admin + Beast token routes (17 routes).
// All handler bodies moved verbatim from server.ts.
// ============================================================================

interface ServerRoutesHelpers {
  hasSessionAuth: (c: Context) => boolean;
  wsBroadcast: (event: string, data: any) => void;
  webPresence: Map<string, { identity: string; role: string; lastSeen: number }>;
}

export function registerServerRoutes(app: OpenAPIHono, sqliteDb: Database, helpers: ServerRoutesHelpers): void {
  const { hasSessionAuth, wsBroadcast, webPresence } = helpers;
  const sqlite: Database = sqliteDb;

  // setRateLimit is local — only the login handler uses it. Other rate-limit
  // helpers (getRateLimit, clearRateLimit) stay in server.ts because they are
  // also used by middleware elsewhere.
  function setRateLimit(ip: string, count: number, firstAttempt: number): void {
    sqlite.prepare('INSERT OR REPLACE INTO login_rate_limits (ip, count, first_attempt_at) VALUES (?, ?, ?)').run(ip, count, firstAttempt);
  }


  // ============================================================================
  // /api/auth/* (status, login, logout)
  // ============================================================================

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
  // /api/guests/* (8 routes — owner admin)
  // ============================================================================

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
  // /api/auth/tokens/* + /api/auth/me + /api/auth/rotate (Beast token + self)
  // ============================================================================

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

}
