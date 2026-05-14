import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';
import * as path from 'path';
import { getFullThread, handleThreadMessage } from '../forum/handler.ts';
import { sendDm, getMessages as getDmMessages } from '../dm/handler.ts';
import { getBeastProfile } from '../db/index.ts';
import { getGuestByUsername, changeGuestPassword, updateGuestProfile } from '../server/guest-accounts.ts';
import { checkGuestPostRate, checkGuestDmRate, checkGuestContentLength, scanForInjection } from '../server/guest-safety.ts';
import { logSecurityEvent } from '../server/security-logger.ts';

interface GuestHelpers {
  wsBroadcast: (event: string, data: any) => void;
  withRetry: <T>(fn: () => T | Promise<T>, maxRetries?: number, delayMs?: number) => Promise<T>;
  getTmuxStatus: () => { tmuxStatus: Map<string, string>; contextPctMap: Map<string, number | null> };
  normalizeAvatarUrl: (url: string | null) => string | null;
  uploadsDir: string;
}

export function registerGuestRoutes(app: OpenAPIHono, sqlite: Database, helpers: GuestHelpers) {
  const { wsBroadcast, withRetry, getTmuxStatus, normalizeAvatarUrl, uploadsDir: UPLOADS_DIR } = helpers;

  // Password change rate limiting: max 5 attempts per guest per 15 minutes
  const passwordChangeAttempts = new Map<string, { count: number; firstAttempt: number }>();
  const PASSWORD_CHANGE_RATE_LIMIT = 5;
  const PASSWORD_CHANGE_RATE_WINDOW_MS = 15 * 60 * 1000;

  // Resolve guest display name from username
  function getGuestDisplayName(username: string): string {
    const guest = sqlite.query('SELECT display_name FROM guest_accounts WHERE username = ?').get(username) as any;
    return guest?.display_name || username;
  }

  // Guest dashboard — public data only (T#558, Spec #32)
  app.get('/api/guest/dashboard', (c) => {
    const guestUsername = (c.get as any)('guestUsername') as string | undefined;

    const publicThreads = sqlite.prepare(
      "SELECT id, title, status, created_at, (SELECT COUNT(*) FROM forum_messages WHERE thread_id = forum_threads.id) as msg_count FROM forum_threads WHERE visibility = 'public' ORDER BY updated_at DESC LIMIT 10"
    ).all() as any[];

    const beasts = sqlite.prepare(
      "SELECT name, display_name, animal, role, bio, theme_color FROM beast_profiles ORDER BY name"
    ).all() as any[];

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

    const rateCheck = checkGuestPostRate(guestUsername);
    if (!rateCheck.allowed) return c.json({ error: rateCheck.error }, 429);

    const lengthCheck = checkGuestContentLength(data.message, 'post');
    if (!lengthCheck.allowed) return c.json({ error: lengthCheck.error }, 400);

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

    const rateCheck = checkGuestPostRate(guestUsername);
    if (!rateCheck.allowed) return c.json({ error: rateCheck.error }, 429);

    const lengthCheck = checkGuestContentLength(data.message, 'post');
    if (!lengthCheck.allowed) return c.json({ error: lengthCheck.error }, 400);

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

    if (result.threadId) {
      sqlite.prepare('UPDATE forum_threads SET visibility = ? WHERE id = ?').run('public', result.threadId);

      if (!data.thread_id) {
        try {
          const { getOracleRegistry, notifyMentioned } = await import('../forum/mentions.ts');
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

    if (fromParam !== guestTag && toParam !== guestTag && fromParam !== guestUsername && toParam !== guestUsername) {
      return c.json({ error: 'Access denied' }, 403);
    }

    const from = (fromParam === guestUsername || fromParam === guestDisplayName) ? guestTag : fromParam;
    const to = (toParam === guestUsername || toParam === guestDisplayName) ? guestTag : toParam;

    const limit = parseInt(c.req.query('limit') || '50');
    const offset = parseInt(c.req.query('offset') || '0');
    const order = c.req.query('order') || 'asc';
    const data = getDmMessages(from, to, limit, offset, order as 'asc' | 'desc');

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

    const recipientBeast = getBeastProfile(data.to);
    const isOwner = data.to.toLowerCase() === 'gorn';
    if (!recipientBeast && !isOwner) {
      return c.json({ error: `Recipient "${data.to}" not found. Must be a valid beast name.` }, 404);
    }

    const rateCheck = checkGuestDmRate(guestUsername);
    if (!rateCheck.allowed) return c.json({ error: rateCheck.error }, 429);

    const lengthCheck = checkGuestContentLength(data.message, 'dm');
    if (!lengthCheck.allowed) return c.json({ error: lengthCheck.error }, 400);

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
  app.post('/api/guest/change-password', async (c) => {
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
      const existing = passwordChangeAttempts.get(guestUsername);
      if (existing) {
        existing.count++;
      } else {
        passwordChangeAttempts.set(guestUsername, { count: 1, firstAttempt: now });
      }
      return c.json({ error: result.error }, 400);
    }

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

    if (body.display_name !== undefined && (!body.display_name || body.display_name.length > 50)) {
      return c.json({ error: 'Display name must be 1-50 characters' }, 400);
    }
    if (body.display_name !== undefined) {
      const RESERVED_NAMES = new Set([
        'karo','rax','mara','leonard','bertus','gnarl','zaghnal','pip','nyx','dex',
        'flint','quill','snap','vigil','talon','sable','gorn','admin','administrator','system',
      ]);
      if (RESERVED_NAMES.has(body.display_name.toLowerCase().trim())) {
        return c.json({ error: 'That display name is reserved' }, 400);
      }
    }
    if (body.bio !== undefined && body.bio.length > 500) {
      return c.json({ error: 'Bio must be under 500 characters' }, 400);
    }
    if (body.interests !== undefined && body.interests.length > 300) {
      return c.json({ error: 'Interests must be under 300 characters' }, 400);
    }

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

    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedTypes.includes(file.type)) {
      return c.json({ error: 'File must be jpg, png, or webp' }, 400);
    }

    if (file.size > 2 * 1024 * 1024) {
      return c.json({ error: 'File must be under 2MB' }, 400);
    }

    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const isJpeg = bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
    const isWebp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
      && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
    if (!isJpeg && !isPng && !isWebp) {
      return c.json({ error: 'File content does not match an allowed image type' }, 400);
    }

    const ext = file.type.split('/')[1] === 'jpeg' ? 'jpg' : file.type.split('/')[1];
    const filename = `guest-${guestUsername}-avatar.${ext}`;
    const filePath = path.join(UPLOADS_DIR, filename);
    await Bun.write(filePath, buffer);

    const avatarUrl = `/api/f/${filename}`;
    updateGuestProfile(sqlite, guest.id, { avatar_url: avatarUrl });

    return c.json({ avatar_url: avatarUrl });
  });
}
