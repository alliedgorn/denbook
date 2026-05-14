import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';
import type { Role } from '../server/rbac.ts';
import { checkGuestDmRate, checkGuestContentLength, scanForInjection } from '../server/guest-safety.ts';
import { logSecurityEvent } from '../server/security-logger.ts';
import { getDashboard, listConversations, markRead, markAllRead, getMessages as getDmMessages, sendDm as _sendDmHelper } from './handler.ts';
import { getBeastProfile } from '../db/index.ts';
import { listGuests, getGuestByUsername, getGuestByDisplayName } from '../server/guest-accounts.ts';

// ============================================================================
// DM routes — Phase 2.2 of Library #102 (T#780)
// Mechanical extraction of DM route registrations.
// ============================================================================

interface DmHelpers {
  hasSessionAuth: (c: Context) => boolean;
  requireBeastIdentity: (c: Context) => string | null;
  isTrustedRequest: (c: Context) => boolean;
  wsBroadcast: (event: string, data: any) => void;
  sendDm: (...args: any[]) => any;
  withRetry: <T>(fn: () => T | Promise<T>, maxRetries?: number, delayMs?: number) => Promise<T>;
}

export function registerDmRoutes(app: OpenAPIHono, sqliteDb: Database, helpers: DmHelpers): void {
  // T#795 P1: hasSessionAuth + isTrustedRequest no longer needed in this file —
  // requireBeastIdentity handles both auth paths internally (token > session > null).
  // Interface entries kept for backward-compat with call site at server.ts:4056.
  const { requireBeastIdentity, wsBroadcast, sendDm, withRetry } = helpers;
  const sqlite: Database = sqliteDb;

  app.get('/api/dm/dashboard', (c) => {
    // T#795 P1 — close localhost-trust read-bypass. Require bearer-token or owner session.
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    const limit = parseInt(c.req.query('limit') || '50');
    const data = getDashboard(limit);
    // T#728 + T#795 P1: non-gorn callers see only their own conversations.
    const filtered = (caller !== 'gorn')
      ? data.conversations.filter(conv => conv.participants.some((p: string) => p.toLowerCase() === caller))
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
      total_conversations: (caller !== 'gorn') ? filtered.length : data.totalConversations,
      total_messages: data.totalMessages,
    });
  });

  app.get('/api/dm/unread-count', (c) => {
    const data = getDashboard(100);
    const gornConvos = data.conversations.filter(conv =>
      conv.participants.some((p: string) => p.toLowerCase() === 'gorn')
    );
    const unread = gornConvos.reduce((sum, conv) => sum + conv.unreadCount, 0);
    return c.json({ unread });
  });

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

  app.get('/api/dm/:name', (c) => {
    const name = c.req.param('name');
    // T#795 P1 — close localhost-trust read-bypass. Require bearer-token or owner session,
    // then scope to caller (gorn sees all; beasts see their own).
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (caller !== 'gorn' && caller !== name.toLowerCase()) {
      return c.json({ error: 'Access denied. You can only view your own conversations.' }, 403);
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

  app.get('/api/dm/:name/:other', (c) => {
    let name = c.req.param('name');
    let other = c.req.param('other');

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
    // T#795 P1 — close localhost-trust read-bypass. Require bearer-token or owner session,
    // then scope to participants (gorn sees all; beasts see only conversations they are part of).
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (caller !== 'gorn' && caller !== name.toLowerCase() && caller !== other.toLowerCase()) {
      return c.json({ error: 'Access denied. You can only read conversations you are part of.' }, 403);
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

  app.patch('/api/dm/:name/:other/read', (c) => {
    const reader = c.req.param('name');
    const other = c.req.param('other');
    // T#795 P1 — close localhost-trust read-bypass. Require bearer-token or owner session,
    // then scope to caller (gorn marks any; beasts mark only their own).
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (caller !== 'gorn' && caller !== reader.toLowerCase()) {
      return c.json({ error: 'Can only mark your own messages as read' }, 403);
    }
    const result = markRead(reader, other);
    if (result.markedRead > 0) wsBroadcast('dm_read', { conversation_id: result.conversationId, reader });
    return c.json({
      marked_read: result.markedRead,
      conversation_id: result.conversationId,
    });
  });

  app.patch('/api/dm/:name/:other/read-all', (c) => {
    const name = c.req.param('name');
    const other = c.req.param('other');
    // T#795 P1 — close localhost-trust read-bypass. Require bearer-token or owner session,
    // then scope to participants (gorn marks any; beasts mark only conversations they are part of).
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (caller !== 'gorn' && caller !== name.toLowerCase() && caller !== other.toLowerCase()) {
      return c.json({ error: 'Can only mark messages as read in your own conversations' }, 403);
    }
    const result = markAllRead(name, other);
    if (result.markedRead > 0) wsBroadcast('dm_read', { conversation_id: result.conversationId, reader: name });
    return c.json({
      marked_read: result.markedRead,
      conversation_id: result.conversationId,
    });
  });

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


}
