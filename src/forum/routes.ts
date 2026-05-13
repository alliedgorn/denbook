import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';
import type { Role } from '../server/rbac.ts';
import { checkGuestPostRate, checkGuestContentLength, scanForInjection } from '../server/guest-safety.ts';
import { logSecurityEvent } from '../server/security-logger.ts';
import { searchIndexUpsert } from '../search/routes.ts';
import { handleThreadMessage, getFullThread, updateThreadStatus } from './handler.ts';

// ============================================================================
// Forum routes — Phase 2.1 of Library #102 (T#779)
// Mechanical extraction of 34 forum/thread/message/reactions registrations.
// All handler bodies moved verbatim from server.ts.
// ============================================================================

interface ForumHelpers {
  hasSessionAuth: (c: Context) => boolean;
  requireBeastIdentity: (c: Context) => string | null;
  isTrustedRequest: (c: Context) => boolean;
  wsBroadcast: (event: string, data: any) => void;
  withRetry: <T>(fn: () => T | Promise<T>, maxRetries?: number, delayMs?: number) => Promise<T>;
  getSupportedEmoji: () => Set<string>;
}

export function registerForumRoutes(app: OpenAPIHono, sqliteDb: Database, helpers: ForumHelpers): void {
  const { hasSessionAuth, requireBeastIdentity, isTrustedRequest, wsBroadcast, withRetry, getSupportedEmoji } = helpers;
  const sqlite: Database = sqliteDb;
  let SUPPORTED_EMOJI: Set<string> = getSupportedEmoji();

  app.post('/api/forum/read', async (c) => {
    try {
      const body = await c.req.json();
      const { threadId, messageId } = body;
      if (!threadId || !messageId) {
        return c.json({ error: 'threadId, messageId required' }, 400);
      }
      // T#718 — derive beast from auth, reject body.beast mismatch
      const caller = requireBeastIdentity(c);
      if (!caller) {
        return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
      }
      if (body.beast && body.beast.toLowerCase() !== caller) {
        return c.json({ error: 'Identity spoof blocked. body.beast must match authenticated caller or be omitted.' }, 403);
      }
      const beast = caller;
      const now = Date.now();
      sqlite.prepare(`
        INSERT INTO forum_read_status (beast_name, thread_id, last_read_message_id, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(beast_name, thread_id) DO UPDATE SET
          last_read_message_id = MAX(last_read_message_id, excluded.last_read_message_id),
          updated_at = excluded.updated_at
      `).run(beast, threadId, messageId, now);
      return c.json({ success: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
    }
  });

  app.get('/api/forum/unread/:beast', (c) => {
    const beast = c.req.param('beast');
    const rows = sqlite.prepare(`
      SELECT t.id as thread_id, t.title,
             COUNT(m.id) as total_messages,
             COALESCE(r.last_read_message_id, 0) as last_read,
             (SELECT COUNT(*) FROM forum_messages WHERE thread_id = t.id AND id > COALESCE(r.last_read_message_id, 0)) as unread_count
      FROM forum_threads t
      LEFT JOIN forum_read_status r ON r.thread_id = t.id AND r.beast_name = ?
      LEFT JOIN forum_messages m ON m.thread_id = t.id
      LEFT JOIN forum_notification_prefs p ON p.thread_id = t.id AND p.beast_name = ?
      WHERE COALESCE(p.level, 'full') != 'muted'
      GROUP BY t.id
      HAVING unread_count > 0
      ORDER BY unread_count DESC
    `).all(beast, beast) as any[];

    return c.json({
      beast,
      threads: rows.map(r => ({
        thread_id: r.thread_id,
        title: r.title,
        unread_count: r.unread_count,
      })),
      total_unread: rows.reduce((sum: number, r: any) => sum + r.unread_count, 0),
    });
  });

  app.get('/api/forum/file/:filename', (c) => {
    const filename = c.req.param('filename');
    if (filename.includes('..') || filename.includes('/')) return c.json({ error: 'Invalid filename' }, 400);
    return c.redirect(`/api/f/${filename}`, 301);
  });

  app.get('/api/message/:id/attachments', (c) => {
    const messageId = parseInt(c.req.param('id'), 10);
    const rows = sqlite.prepare('SELECT * FROM forum_attachments WHERE message_id = ? ORDER BY created_at').all(messageId) as any[];
    return c.json({
      attachments: rows.map(r => ({
        id: r.id,
        filename: r.filename,
        original_name: r.original_name,
        url: `/api/f/${r.filename}`,
        mime_type: r.mime_type,
        size_bytes: r.size_bytes,
        uploaded_by: r.uploaded_by,
      })),
    });
  });

  app.post('/api/forum/mute', async (c) => {
    try {
      const body = await c.req.json();
      if (!body.threadId) return c.json({ error: 'threadId required' }, 400);
      // T#718 — derive beast from auth
      const caller = requireBeastIdentity(c);
      if (!caller) {
        return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
      }
      if (body.beast && body.beast.toLowerCase() !== caller) {
        return c.json({ error: 'Identity spoof blocked. body.beast must match authenticated caller or be omitted.' }, 403);
      }
      const beast = caller;
      const muted = body.muted !== false;
      const level = muted ? 'muted' : 'full';
      const { setSubscription } = await import('./mentions.ts');
      setSubscription(beast, body.threadId, level);
      return c.json({ success: true, beast, thread_id: body.threadId, muted, level });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
    }
  });

  app.get('/api/forum/muted/:beast', (c) => {
    const beast = c.req.param('beast').toLowerCase();
    const rows = sqlite.prepare(
      'SELECT thread_id FROM forum_notification_prefs WHERE beast_name = ? AND (muted = 1 OR level = ?)'
    ).all(beast, 'muted') as any[];
    return c.json({ beast, muted_threads: rows.map(r => r.thread_id) });
  });

  app.post('/api/forum/subscribe', async (c) => {
    try {
      const body = await c.req.json();
      if (!body.beast || !body.threadId) return c.json({ error: 'beast and threadId required' }, 400);
      const level = body.level || 'full';
      if (!['full', 'summary', 'muted'].includes(level)) {
        return c.json({ error: 'level must be full, summary, or muted' }, 400);
      }
      const { setSubscription } = await import('./mentions.ts');
      setSubscription(body.beast, body.threadId, level);
      return c.json({ success: true, beast: body.beast, thread_id: body.threadId, level });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
    }
  });

  app.get('/api/forum/subscriptions/:beast', async (c) => {
    const beast = c.req.param('beast').toLowerCase();
    const { getSubscriptions } = await import('./mentions.ts');
    return c.json({ beast, subscriptions: getSubscriptions(beast) });
  });

  app.get('/api/thread/:id/subscribers', async (c) => {
    const role = (c.get as any)('role') as string | undefined;
    if (role === 'guest') return c.json({ error: 'Not found' }, 404);

    const threadId = parseInt(c.req.param('id'), 10);
    if (isNaN(threadId)) return c.json({ error: 'Invalid thread ID' }, 400);

    const thread = sqlite.prepare('SELECT id FROM forum_threads WHERE id = ?').get(threadId) as any;
    if (!thread) return c.json({ error: 'Thread not found' }, 404);

    const { getThreadSubscribers } = await import('./mentions.ts');
    const subs = getThreadSubscribers(threadId);

    // Enrich with beast profile data
    const subscribers = subs.map(s => {
      const profile = sqlite.prepare(
        'SELECT display_name, animal, avatar_url, theme_color FROM beast_profiles WHERE name = ?'
      ).get(s.beast_name) as any;
      return {
        name: s.beast_name,
        display_name: profile?.display_name || s.beast_name,
        animal: profile?.animal || null,
        avatar_url: profile?.avatar_url || null,
        theme_color: profile?.theme_color || null,
        level: s.level,
      };
    });

    return c.json({ thread_id: threadId, subscribers, total: subscribers.length });
  });

  app.get('/api/forum/link-preview', async (c) => {
    const url = c.req.query('url');
    if (!url) return c.json({ error: 'Missing url parameter' }, 400);

    // SSRF protection: only allow https, block internal IPs
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:') {
        return c.json({ error: 'Only https URLs allowed' }, 400);
      }
      // Block internal/private hostnames
      const hostname = parsed.hostname.toLowerCase();
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' ||
          hostname === '0.0.0.0' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
        return c.json({ error: 'Internal URLs not allowed' }, 400);
      }
      // Resolve DNS and block private IP ranges
      const { resolve4 } = await import('dns/promises');
      try {
        const ips = await resolve4(hostname);
        for (const ip of ips) {
          const parts = ip.split('.').map(Number);
          if (parts[0] === 10 || parts[0] === 127 ||
              (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
              (parts[0] === 192 && parts[1] === 168) ||
              (parts[0] === 169 && parts[1] === 254)) {
            return c.json({ error: 'Internal URLs not allowed' }, 400);
          }
        }
      } catch { /* DNS resolution failed — let fetch handle it */ }
    } catch {
      return c.json({ error: 'Invalid URL' }, 400);
    }

    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'DenBook/1.0' },
        signal: AbortSignal.timeout(5000),
        redirect: 'manual', // Don't follow redirects (prevents redirect-to-internal)
      });
      const html = await response.text();

      // Extract basic meta tags
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const descMatch = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)
        || html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']description["']/i);
      const ogTitleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
      const ogDescMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);
      const ogImageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i);

      return c.json({
        url,
        title: ogTitleMatch?.[1] || titleMatch?.[1] || null,
        description: ogDescMatch?.[1] || descMatch?.[1] || null,
        image: ogImageMatch?.[1] || null,
      });
    } catch {
      return c.json({ url, title: null, description: null, image: null });
    }
  });

  app.get('/api/forum/activity', (c) => {
    const limit = parseInt(c.req.query('limit') || '30');
    const rows = sqlite.prepare(`
      SELECT m.id, m.thread_id, m.role, m.content, m.author, m.created_at,
             t.title as thread_title, t.category
      FROM forum_messages m
      JOIN forum_threads t ON m.thread_id = t.id
      ORDER BY m.created_at DESC
      LIMIT ?
    `).all(limit) as any[];

    return c.json({
      activity: rows.map(r => ({
        message_id: r.id,
        thread_id: r.thread_id,
        thread_title: r.thread_title,
        category: r.category,
        role: r.role,
        content: r.content.slice(0, 200),
        author: r.author,
        created_at: new Date(r.created_at).toISOString(),
      })),
      total: rows.length,
    });
  });

  app.get('/api/forum/mentions/:beast', (c) => {
    const beast = c.req.param('beast').toLowerCase();
    const limit = parseInt(c.req.query('limit') || '30');
    const rows = sqlite.prepare(`
      SELECT m.id, m.thread_id, m.content, m.author, m.created_at,
             t.title as thread_title
      FROM forum_messages m
      JOIN forum_threads t ON m.thread_id = t.id
      WHERE LOWER(m.content) LIKE ?
      ORDER BY m.created_at DESC
      LIMIT ?
    `).all(`%@${beast}%`, limit) as any[];

    return c.json({
      beast,
      mentions: rows.map(r => ({
        message_id: r.id,
        thread_id: r.thread_id,
        thread_title: r.thread_title,
        content: r.content,
        author: r.author,
        created_at: new Date(r.created_at).toISOString(),
      })),
      total: rows.length,
    });
  });

  app.get('/api/forum/search', (c) => {
    const q = c.req.query('q');
    if (!q) return c.json({ error: 'Missing query parameter: q' }, 400);
    const limit = parseInt(c.req.query('limit') || '20');
    const author = c.req.query('author');
    const category = c.req.query('category');

    // Search messages by content (with optional author filter)
    let msgQuery = `SELECT m.id, m.thread_id, m.role, m.content, m.author, m.created_at,
             t.title as thread_title
      FROM forum_messages m
      JOIN forum_threads t ON m.thread_id = t.id
      WHERE m.content LIKE ?`;
    const msgParams: any[] = [`%${q}%`];
    if (author) { msgQuery += ' AND LOWER(m.author) LIKE ?'; msgParams.push(`%${author.toLowerCase()}%`); }
    if (category) { msgQuery += ' AND t.category = ?'; msgParams.push(category); }
    msgQuery += ' ORDER BY m.created_at DESC LIMIT ?';
    msgParams.push(limit);
    const messages = sqlite.prepare(msgQuery).all(...msgParams) as any[];

    // Search threads by title (with optional category filter)
    let threadQuery = 'SELECT id, title, status, category, created_at FROM forum_threads WHERE title LIKE ?';
    const threadParams: any[] = [`%${q}%`];
    if (category) { threadQuery += ' AND category = ?'; threadParams.push(category); }
    threadQuery += ' ORDER BY updated_at DESC LIMIT ?';
    threadParams.push(limit);
    const threads = sqlite.prepare(threadQuery).all(...threadParams) as any[];

    return c.json({
      query: q,
      messages: messages.map(m => ({
        id: m.id,
        thread_id: m.thread_id,
        thread_title: m.thread_title,
        role: m.role,
        content: m.content,
        author: m.author,
        created_at: new Date(m.created_at).toISOString(),
      })),
      threads: threads.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        created_at: new Date(t.created_at).toISOString(),
      })),
      total_messages: messages.length,
      total_threads: threads.length,
    });
  });

  app.get('/api/threads', (c) => {
    const status = c.req.query('status');
    const category = c.req.query('category');
    const visibility = c.req.query('visibility');
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = parseInt(c.req.query('offset') || '0');
    const role = (c.get as any)('role') as Role | undefined;

    let query = 'SELECT *, (SELECT COUNT(*) FROM forum_messages WHERE thread_id = forum_threads.id) as msg_count FROM forum_threads WHERE deleted_at IS NULL';
    const params: any[] = [];
    if (status) { query += ' AND status = ?'; params.push(status); }
    if (category) { query += ' AND category = ?'; params.push(category); }
    // Guests only see public threads; owner can filter by visibility
    if (role === 'guest') { query += " AND visibility = 'public'"; }
    else if (visibility === 'public' || visibility === 'internal') { query += ' AND visibility = ?'; params.push(visibility); }
    query += ' ORDER BY COALESCE(pinned, 0) DESC, updated_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = sqlite.prepare(query).all(...params) as any[];
    let countQuery = 'SELECT COUNT(*) as total FROM forum_threads WHERE deleted_at IS NULL';
    const countParams: any[] = [];
    if (status) { countQuery += ' AND status = ?'; countParams.push(status); }
    if (category) { countQuery += ' AND category = ?'; countParams.push(category); }
    if (role === 'guest') { countQuery += " AND visibility = 'public'"; }
    else if (visibility === 'public' || visibility === 'internal') { countQuery += ' AND visibility = ?'; countParams.push(visibility); }
    const total = (sqlite.prepare(countQuery).get(...countParams) as any)?.total || 0;

    return c.json({
      threads: rows.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status || 'active',
        category: t.category || 'discussion',
        pinned: !!(t.pinned),
        message_count: t.msg_count || 0,
        created_at: new Date(t.created_at).toISOString(),
        created_by: t.created_by || null,
        issue_url: t.issue_url,
        visibility: t.visibility || 'internal',
      })),
      total,
    });
  });

  app.post('/api/thread', async (c) => {
    try {
      const data = await c.req.json();
      if (!data.message) {
        return c.json({ error: 'Missing required field: message' }, 400);
      }

      // Guest restrictions: can only post in existing public threads, cannot create new threads
      const role = (c.get as any)('role') as Role | undefined;
      if (role === 'guest') {
        const guestUsername = (c.get as any)('guestUsername');
        if (!guestUsername) return c.json({ error: 'Guest session missing' }, 401);

        if (!data.thread_id) {
          return c.json({ error: 'Guests cannot create new threads' }, 403);
        }
        const threadRow = sqlite.prepare('SELECT visibility FROM forum_threads WHERE id = ?').get(data.thread_id) as any;
        if (!threadRow || threadRow.visibility !== 'public') {
          return c.json({ error: 'Guests can only post in public threads' }, 403);
        }

        // Rate limiting
        const rateCheck = checkGuestPostRate(guestUsername);
        if (!rateCheck.allowed) {
          return c.json({ error: rateCheck.error }, 429);
        }

        // Content length limit
        const lengthCheck = checkGuestContentLength(data.message, 'post');
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
            target: `/api/thread/${data.thread_id}`,
            details: { patterns: scan.patterns, content_preview: data.message.slice(0, 200) },
            ipSource: c.req.header('x-real-ip') || 'local',
            requestId: (c.get as any)('requestId'),
          });
        }

        // Tag guest author with [Guest] prefix for display (derived from session, not body)
        data.author = `[Guest] ${guestUsername}`;
      } else {
        // T#718 — Beast/owner path: derive author from auth, reject client-asserted mismatch
        const caller = requireBeastIdentity(c);
        if (!caller) {
          return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
        }
        if (data.author && data.author.toLowerCase() !== caller) {
          return c.json({ error: 'Author impersonation blocked. body.author must match authenticated caller or be omitted.' }, 403);
        }
        data.author = caller;
      }

      // Block posting to deleted threads
      if (data.thread_id) {
        const threadCheck = sqlite.prepare('SELECT deleted_at FROM forum_threads WHERE id = ?').get(data.thread_id) as any;
        if (threadCheck?.deleted_at) {
          return c.json({ error: 'Cannot post to a deleted thread' }, 410);
        }
      }

      const result = await withRetry(() => handleThreadMessage({
        message: data.message,
        threadId: data.thread_id,
        title: data.title,
        role: data.role || 'human',
        author: data.author,
      }));
      // Set visibility on new thread creation if specified
      if (!data.thread_id && result.threadId && data.visibility) {
        const vis = data.visibility === 'public' ? 'public' : 'internal';
        sqlite.prepare('UPDATE forum_threads SET visibility = ? WHERE id = ?').run(vis, result.threadId);
      }
      // Store reply_to_id and author_role if applicable
      if (result.messageId) {
        if (data.reply_to_id) {
          sqlite.prepare('UPDATE forum_messages SET reply_to_id = ? WHERE id = ?')
            .run(data.reply_to_id, result.messageId);
        }
        // Set author_role for prompt injection defense (Spec #32, T#557)
        const authorRole = role === 'guest' ? 'guest' : (role === 'owner' ? 'owner' : 'beast');
        sqlite.prepare('UPDATE forum_messages SET author_role = ? WHERE id = ?')
          .run(authorRole, result.messageId);
      }
      // Index forum message for search (T#347)
      if (result.messageId && result.threadId) {
        const threadTitle = data.title || (sqlite.prepare('SELECT title FROM forum_threads WHERE id = ?').get(result.threadId) as any)?.title || '';
        searchIndexUpsert('forum', result.messageId, threadTitle, data.message, data.author, new Date().toISOString(), `/forum?thread=${result.threadId}`);
      }
      // Push WebSocket event
      wsBroadcast('new_message', {
        thread_id: result.threadId,
        message_id: result.messageId,
        author: data.author || data.role || 'unknown',
      });
      return c.json({
        thread_id: result.threadId,
        message_id: result.messageId,
        status: result.status,
        oracle_response: result.oracleResponse,
        issue_url: result.issueUrl,
        notified: result.notified,
      });
    } catch (error) {
      return c.json({
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  app.get('/api/thread/:id', (c) => {
    const threadId = parseInt(c.req.param('id'), 10);
    if (isNaN(threadId)) {
      return c.json({ error: 'Invalid thread ID' }, 400);
    }

    const rawLimit = c.req.query('limit');
    const parsedLimit = rawLimit ? parseInt(rawLimit, 10) : NaN;
    const limit = rawLimit ? (isNaN(parsedLimit) || parsedLimit < 1 ? 50 : parsedLimit) : undefined;
    const rawOffset = parseInt(c.req.query('offset') || '0', 10);
    const offset = isNaN(rawOffset) || rawOffset < 0 ? 0 : rawOffset;
    const order = (c.req.query('order') === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc';

    const threadData = getFullThread(threadId, limit, offset, order);
    if (!threadData) {
      return c.json({ error: 'Thread not found' }, 404);
    }

    // Guests can only view public threads
    const role = (c.get as any)('role') as Role | undefined;
    if (role === 'guest') {
      const threadRow = sqlite.prepare('SELECT visibility FROM forum_threads WHERE id = ?').get(threadId) as any;
      if (!threadRow || threadRow.visibility !== 'public') {
        return c.json({ error: 'Thread not found' }, 404);
      }
    }

    return c.json({
      thread: {
        id: threadData.thread.id,
        title: threadData.thread.title,
        status: threadData.thread.status,
        created_at: new Date(threadData.thread.createdAt).toISOString(),
        issue_url: threadData.thread.issueUrl
      },
      messages: threadData.messages.map(m => {
        // Get reply_to_id from raw SQL (not in Drizzle schema)
        const raw = sqlite.prepare('SELECT reply_to_id FROM forum_messages WHERE id = ?').get(m.id) as any;
        // Get reactions for this message
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

  app.patch('/api/message/:id', async (c) => {
    const messageId = parseInt(c.req.param('id'), 10);
    try {
      const body = await c.req.json();
      if (!body.content?.trim()) {
        return c.json({ error: 'content (non-empty) is required' }, 400);
      }
      // T#718 — derive beast from auth, reject client-asserted mismatch
      const caller = requireBeastIdentity(c);
      if (!caller) {
        return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
      }
      if (body.beast && body.beast.toLowerCase() !== caller) {
        return c.json({ error: 'Identity spoof blocked. body.beast must match authenticated caller or be omitted.' }, 403);
      }

      // Get current content
      const current = sqlite.prepare('SELECT content, author FROM forum_messages WHERE id = ?').get(messageId) as any;
      if (!current) return c.json({ error: 'Message not found' }, 404);

      // Restrict edits to original author only (or Gorn)
      const authorLower = (current.author || '').toLowerCase();
      const beastLower = caller;
      if (!authorLower.includes(beastLower) && beastLower !== 'gorn') {
        return c.json({ error: 'Only the original author can edit this message' }, 403);
      }

      // Save original to edit history (Nothing is Deleted)
      const now = Date.now();
      sqlite.prepare(`
        INSERT INTO forum_message_edits (message_id, original_content, edited_by, created_at)
        VALUES (?, ?, ?, ?)
      `).run(messageId, current.content, caller, now);

      // Update message
      sqlite.prepare('UPDATE forum_messages SET content = ?, edited_at = ? WHERE id = ?')
        .run(body.content, now, messageId);

      return c.json({ success: true, message_id: messageId, edited_at: new Date(now).toISOString() });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
    }
  });

  app.delete('/api/message/:id', async (c) => {
    const messageId = parseInt(c.req.param('id'), 10);
    if (isNaN(messageId)) return c.json({ error: 'Invalid message ID' }, 400);

    const role = (c.get as any)('role') as string | undefined;
    if (role === 'guest') return c.json({ error: 'Not found' }, 404);

    // Gorn-only: require session auth (not just trusted network)
    if (!hasSessionAuth(c)) {
      return c.json({ error: 'Only Gorn can delete forum messages' }, 403);
    }

    const msg = sqlite.prepare('SELECT id, thread_id, author, content, deleted_at FROM forum_messages WHERE id = ?').get(messageId) as any;
    if (!msg) return c.json({ error: 'Message not found' }, 404);
    if (msg.deleted_at) return c.json({ error: 'Message already deleted' }, 400);

    // Soft delete — Nothing is Deleted principle
    const now = new Date().toISOString();
    try {
      sqlite.prepare('UPDATE forum_messages SET deleted_at = ?, deleted_by = ? WHERE id = ?')
        .run(now, 'gorn', messageId);
    } catch (error) {
      return c.json({ error: 'Database error during deletion' }, 500);
    }

    // Audit trail
    const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
    logSecurityEvent({
      eventType: 'message_delete',
      severity: 'warning',
      actor: 'gorn',
      actorType: 'owner',
      target: `message:${messageId}`,
      details: { thread_id: msg.thread_id, author: msg.author, content_preview: msg.content?.slice(0, 100) },
      ipSource: ip,
      requestId: (c.get as any)('requestId'),
    });

    return c.json({ deleted: messageId, thread_id: msg.thread_id, deleted_at: now, deleted_by: 'gorn', soft: true });
  });

  app.get('/api/message/:id/history', (c) => {
    const messageId = parseInt(c.req.param('id'), 10);
    const rows = sqlite.prepare(
      'SELECT id, original_content, edited_by, created_at FROM forum_message_edits WHERE message_id = ? ORDER BY created_at DESC'
    ).all(messageId) as any[];
    return c.json({
      message_id: messageId,
      edits: rows.map(r => ({
        id: r.id,
        original_content: r.original_content,
        edited_by: r.edited_by,
        created_at: new Date(r.created_at).toISOString(),
      })),
      edit_count: rows.length,
    });
  });

  app.get('/api/forum/emojis', (c) => {
    const rows = sqlite.prepare('SELECT emoji, added_by, created_at FROM emoji_whitelist ORDER BY created_at').all() as any[];
    return c.json({ emoji: rows, total: rows.length });
  });

  app.post('/api/forum/emojis', async (c) => {
    const data = await c.req.json();
    if (!data.emoji) return c.json({ error: 'emoji required' }, 400);
    const beast = data.beast || data.added_by || (hasSessionAuth(c) ? 'gorn' : '');
    if (!beast && !isTrustedRequest(c)) return c.json({ error: 'beast required' }, 400);
    const now = Date.now();
    sqlite.prepare('INSERT OR IGNORE INTO emoji_whitelist (emoji, added_by, created_at) VALUES (?, ?, ?)').run(data.emoji, beast, now);
    SUPPORTED_EMOJI = getSupportedEmoji();
    return c.json({ added: data.emoji, by: beast, total: SUPPORTED_EMOJI.size });
  });

  app.delete('/api/forum/emojis/:emoji', (c) => {
    if (!hasSessionAuth(c) && !isTrustedRequest(c)) return c.json({ error: 'Gorn-only' }, 403);
    const emoji = decodeURIComponent(c.req.param('emoji'));
    sqlite.prepare('DELETE FROM emoji_whitelist WHERE emoji = ?').run(emoji);
    SUPPORTED_EMOJI = getSupportedEmoji();
    return c.json({ removed: emoji, total: SUPPORTED_EMOJI.size });
  });

  app.get('/api/reactions/supported', (c) => {
    return c.json({ emoji: [...SUPPORTED_EMOJI] });
  });

  app.post('/api/message/:id/react', async (c) => {
    const messageId = parseInt(c.req.param('id'), 10);
    try {
      const body = await c.req.json();
      if (!body.emoji) {
        return c.json({ error: 'emoji is required' }, 400);
      }

      const role = (c.get as any)('role');

      // Guest identity enforcement — derive from session, never body
      if (role === 'guest') {
        const guestUsername = (c.get as any)('guestUsername');
        if (!guestUsername) return c.json({ error: 'Guest session missing' }, 401);
        body.beast = `[Guest] ${guestUsername}`;

        // Thread visibility check — guests can only react to messages in public threads
        const msg = sqlite.prepare('SELECT thread_id FROM forum_messages WHERE id = ?').get(messageId) as any;
        if (msg) {
          const thread = sqlite.prepare('SELECT visibility FROM forum_threads WHERE id = ?').get(msg.thread_id) as any;
          if (thread && thread.visibility && thread.visibility !== 'public') {
            return c.json({ error: 'Guests cannot react to messages in private threads' }, 403);
          }
        }
      } else {
        // T#718 — Beast/owner path: derive from auth, reject client-asserted mismatch
        const caller = requireBeastIdentity(c);
        if (!caller) {
          return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
        }
        if (body.beast && body.beast.toLowerCase() !== caller) {
          return c.json({ error: 'Identity spoof blocked. body.beast must match authenticated caller or be omitted.' }, 403);
        }
        body.beast = caller;
      }
      if (!SUPPORTED_EMOJI.has(body.emoji)) {
        return c.json({ error: `Unsupported emoji. Supported: ${[...SUPPORTED_EMOJI].join(' ')}` }, 400);
      }
      const now = Date.now();
      sqlite.prepare(`
        INSERT OR IGNORE INTO forum_reactions (message_id, beast_name, emoji, created_at)
        VALUES (?, ?, ?, ?)
      `).run(messageId, body.beast.toLowerCase(), body.emoji, now);
      wsBroadcast('reaction', { message_id: messageId, beast: body.beast, emoji: body.emoji, action: 'add' });

      // Notify the message author about the reaction
      try {
        const msg = sqlite.prepare('SELECT author, thread_id FROM forum_messages WHERE id = ?').get(messageId) as any;
        if (msg?.author) {
          const msgAuthor = msg.author.split('@')[0].toLowerCase();
          const reactor = body.beast.toLowerCase();
          // Don't notify yourself
          if (msgAuthor !== reactor && msgAuthor !== 'gorn' && msgAuthor !== 'human' && msgAuthor !== 'user') {
            const thread = sqlite.prepare('SELECT title FROM forum_threads WHERE id = ?').get(msg.thread_id) as any;
            const { notifyMentioned } = await import('./mentions.ts');
            notifyMentioned(
              [msgAuthor],
              msg.thread_id,
              thread?.title || 'thread',
              reactor,
              `${body.emoji} reacted to your message`
            );
          }
        }
      } catch { /* notification failure is non-critical */ }

      return c.json({ success: true, message_id: messageId, emoji: body.emoji });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
    }
  });

  app.delete('/api/message/:id/react', async (c) => {
    const messageId = parseInt(c.req.param('id'), 10);
    try {
      const body = await c.req.json();
      if (!body.emoji) {
        return c.json({ error: 'emoji is required' }, 400);
      }

      const role = (c.get as any)('role');
      // Guest identity enforcement — derive from session, never body
      if (role === 'guest') {
        const guestUsername = (c.get as any)('guestUsername');
        if (!guestUsername) return c.json({ error: 'Guest session missing' }, 401);
        body.beast = `[Guest] ${guestUsername}`;
      } else {
        // T#718 — Beast/owner path: derive from auth
        const caller = requireBeastIdentity(c);
        if (!caller) {
          return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
        }
        if (body.beast && body.beast.toLowerCase() !== caller) {
          return c.json({ error: 'Identity spoof blocked. body.beast must match authenticated caller or be omitted.' }, 403);
        }
        body.beast = caller;
      }
      sqlite.prepare('DELETE FROM forum_reactions WHERE message_id = ? AND beast_name = ? AND emoji = ?')
        .run(messageId, body.beast.toLowerCase(), body.emoji);
      wsBroadcast('reaction', { message_id: messageId, beast: body.beast, emoji: body.emoji, action: 'remove' });
      return c.json({ success: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Unknown error' }, 500);
    }
  });

  app.get('/api/message/:id/reactions', (c) => {
    const messageId = parseInt(c.req.param('id'), 10);
    const rows = sqlite.prepare(
      'SELECT emoji, GROUP_CONCAT(beast_name) as beasts, COUNT(*) as count FROM forum_reactions WHERE message_id = ? GROUP BY emoji'
    ).all(messageId) as any[];
    return c.json({
      message_id: messageId,
      reactions: rows.map(r => ({ emoji: r.emoji, beasts: r.beasts.split(','), count: r.count })),
    });
  });

  app.patch('/api/thread/:id/category', async (c) => {
    const threadId = parseInt(c.req.param('id'), 10);
    try {
      const data = await c.req.json();
      const allowed = ['announcement', 'task', 'discussion', 'decision', 'question', 'gorn-queue'];
      if (!data.category || !allowed.includes(data.category)) {
        return c.json({ error: `Invalid category. Allowed: ${allowed.join(', ')}` }, 400);
      }
      sqlite.prepare('UPDATE forum_threads SET category = ? WHERE id = ?').run(data.category, threadId);
      return c.json({ success: true, thread_id: threadId, category: data.category });
    } catch (e) {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
  });

  app.patch('/api/thread/:id/lock', async (c) => {
    const threadId = parseInt(c.req.param('id'), 10);
    try {
      const data = await c.req.json();
      const locked = data.locked ? 1 : 0;
      // Use status: 'locked' for locked threads, revert to 'active' when unlocking
      if (locked) {
        sqlite.prepare('UPDATE forum_threads SET status = ? WHERE id = ?').run('locked', threadId);
      } else {
        sqlite.prepare("UPDATE forum_threads SET status = ? WHERE id = ? AND status = 'locked'").run('active', threadId);
      }
      return c.json({ success: true, thread_id: threadId, locked: !!locked });
    } catch (e) {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
  });

  app.patch('/api/thread/:id/archive', async (c) => {
    const threadId = parseInt(c.req.param('id'), 10);
    sqlite.prepare('UPDATE forum_threads SET status = ? WHERE id = ?').run('archived', threadId);
    return c.json({ success: true, thread_id: threadId, status: 'archived' });
  });

  app.patch('/api/thread/:id/pin', async (c) => {
    const threadId = parseInt(c.req.param('id'), 10);
    try {
      const data = await c.req.json();
      const pinned = data.pinned ? 1 : 0;
      sqlite.prepare('UPDATE forum_threads SET pinned = ? WHERE id = ?').run(pinned, threadId);
      return c.json({ success: true, thread_id: threadId, pinned: !!pinned });
    } catch (e) {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
  });

  app.patch('/api/thread/:id/title', async (c) => {
    const threadId = parseInt(c.req.param('id'), 10);
    try {
      const data = await c.req.json();
      if (!data.title?.trim()) return c.json({ error: 'title required' }, 400);
      // Validate thread exists
      const existing = sqlite.prepare('SELECT id FROM forum_threads WHERE id = ?').get(threadId);
      if (!existing) return c.json({ error: 'Thread not found' }, 404);
      // Sanitize: strip HTML tags, cap length
      let title = data.title.trim().replace(/<[^>]*>/g, '');
      if (title.length > 200) title = title.slice(0, 200);
      if (!title) return c.json({ error: 'title required (after sanitization)' }, 400);
      sqlite.prepare('UPDATE forum_threads SET title = ? WHERE id = ?').run(title, threadId);
      return c.json({ success: true, thread_id: threadId, title });
    } catch { return c.json({ error: 'Invalid JSON' }, 400); }
  });

  app.patch('/api/thread/:id/visibility', async (c) => {
    const role = (c.get as any)('role') as Role | undefined;
    if (role === 'guest') return c.json({ error: 'Forbidden' }, 403);

    const threadId = parseInt(c.req.param('id'), 10);
    try {
      const data = await c.req.json();
      if (data.visibility !== 'public' && data.visibility !== 'internal') {
        return c.json({ error: "visibility must be 'public' or 'internal'" }, 400);
      }
      sqlite.prepare('UPDATE forum_threads SET visibility = ? WHERE id = ?').run(data.visibility, threadId);

      // T#629: Notify all Beasts when a thread becomes public
      if (data.visibility === 'public') {
        try {
          const thread = sqlite.prepare('SELECT title, created_by FROM forum_threads WHERE id = ?').get(threadId) as any;
          if (thread) {
            const { getOracleRegistry, notifyMentioned } = await import('./mentions.ts');
            const registry = getOracleRegistry();
            const allBeasts = Object.keys(registry).filter(name => name !== 'gorn' && name !== (thread.created_by || '').toLowerCase());
            notifyMentioned(allBeasts, threadId, thread.title, thread.created_by || 'unknown', `New public thread: ${thread.title}`, undefined, new Set(allBeasts));
          }
        } catch { /* best effort */ }
      }

      return c.json({ success: true, thread_id: threadId, visibility: data.visibility });
    } catch (e) {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
  });

  app.patch('/api/thread/:id/status', async (c) => {
    const threadId = parseInt(c.req.param('id'), 10);
    try {
      const data = await c.req.json();
      if (!data.status) {
        return c.json({ error: 'Missing required field: status' }, 400);
      }
      updateThreadStatus(threadId, data.status);
      return c.json({ success: true, thread_id: threadId, status: data.status });
    } catch (e) {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
  });

  app.delete('/api/thread/:id', (c) => {
    const id = parseInt(c.req.param('id'));
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
    const as = c.req.query('as')?.toLowerCase() || (hasSessionAuth(c) ? 'gorn' : '');
    if (!as) return c.json({ error: 'as param required for DELETE' }, 400);
    const existing = sqlite.prepare('SELECT * FROM forum_threads WHERE id = ?').get(id) as any;
    if (!existing) return c.json({ error: 'Thread not found' }, 404);
    if (as !== 'gorn' && as !== existing.created_by?.toLowerCase()) {
      return c.json({ error: 'Only the thread creator or Gorn can delete a thread' }, 403);
    }
    // Soft delete — set deleted_at timestamp (Nothing is Deleted)
    sqlite.prepare("UPDATE forum_threads SET deleted_at = datetime('now'), status = 'deleted' WHERE id = ?").run(id);
    return c.json({ deleted: id, title: existing.title, soft: true });
  });


}
