import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { enqueueNotification } from '../notify.ts';

const TG_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TG_POLL_INTERVAL = 3000; // ms

interface TelegramBot {
  token: string;
  beast: string;
  chatId: string;
  offset: number;
  lastMessageAt: string | null;
  messageCount: number;
  active: boolean;
  timer: ReturnType<typeof setInterval> | null;
  polling: boolean;
}

function parseTelegramBots(): TelegramBot[] {
  const bots: TelegramBot[] = [];

  const botsJson = process.env.TELEGRAM_BOTS;
  if (botsJson) {
    try {
      const parsed = JSON.parse(botsJson);
      for (const b of parsed) {
        if (b.token && b.beast) {
          bots.push({
            token: b.token,
            beast: b.beast,
            chatId: b.chatId || TG_CHAT_ID,
            offset: 0, lastMessageAt: null, messageCount: 0, active: false, timer: null, polling: false,
          });
        }
      }
    } catch (e) { console.error('[Telegram] Failed to parse TELEGRAM_BOTS:', e); }
  }

  if (bots.length === 0) {
    const token = process.env.TELEGRAM_BOT_TOKEN || '';
    const beast = process.env.TELEGRAM_FORWARD_TO || 'karo';
    if (token && TG_CHAT_ID) {
      bots.push({
        token, beast, chatId: TG_CHAT_ID,
        offset: 0, lastMessageAt: null, messageCount: 0, active: false, timer: null, polling: false,
      });
    }
  }

  return bots;
}

const telegramBots = parseTelegramBots();

async function tgApi(token: string, method: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  return res.json();
}

async function tgSendReply(token: string, chatId: string, text: string): Promise<void> {
  await tgApi(token, 'sendMessage', { chat_id: chatId, text });
}

async function handleTelegramMessage(bot: TelegramBot, msg: any, sqlite: Database, uploadsDir: string): Promise<void> {
  if (String(msg.chat.id) !== bot.chatId) {
    console.log(`[Telegram:${bot.beast}] Rejected: chat_id ${msg.chat.id} !== expected ${bot.chatId}`);
    return;
  }

  // T#712 cache inbound message
  try {
    const msgId = msg.message_id;
    if (typeof msgId === 'number' && Number.isFinite(msgId)) {
      const sanitized = JSON.parse(JSON.stringify(msg));
      const stripEphemeral = (obj: any) => {
        if (!obj || typeof obj !== 'object') return;
        for (const k of Object.keys(obj)) {
          if (k === 'file_path') delete obj[k];
          else if (typeof obj[k] === 'object') stripEphemeral(obj[k]);
        }
      };
      stripEphemeral(sanitized);
      const rawJson = JSON.stringify(sanitized);
      sqlite.prepare(
        'INSERT OR IGNORE INTO telegram_messages (chat_id, id, from_id, text, caption, photo_file_id, date_unix, received_at, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        String(msg.chat.id),
        msgId,
        msg.from?.id ? String(msg.from.id) : null,
        msg.text || null,
        msg.caption || null,
        msg.photo && msg.photo.length > 0 ? (msg.photo[msg.photo.length - 1].file_id || null) : null,
        msg.date || Math.floor(Date.now() / 1000),
        Date.now(),
        rawJson
      );
    } else {
      console.warn(`[Telegram:${bot.beast} T#712] dropping cache — malformed message_id: ${JSON.stringify(msgId)}`);
    }
  } catch (cacheErr) {
    console.warn(`[Telegram:${bot.beast} T#712] dropping cache — persist error:`, cacheErr);
  }

  try {
    let notifyText: string;
    let confirmText: string;

    let replyContext = '';
    if (msg.reply_to_message) {
      const replied = msg.reply_to_message;
      const repliedId = typeof replied.message_id === 'number' ? replied.message_id : '?';
      const repliedText = replied.text || replied.caption || '[media]';
      const repliedPreview = repliedText.length > 80 ? repliedText.slice(0, 80) + '...' : repliedText;
      replyContext = `(replying to TG#${repliedId}: "${repliedPreview}")\\n`;
    }

    if (msg.photo && msg.photo.length > 0) {
      let photoUrl = '';
      try {
        const photo = msg.photo[msg.photo.length - 1];
        const fileInfo = await tgApi(bot.token, 'getFile', { file_id: photo.file_id });
        if (fileInfo.ok && fileInfo.result?.file_path) {
          const filePath = fileInfo.result.file_path;
          const imageRes = await fetch(`https://api.telegram.org/file/bot${bot.token}/${filePath}`);
          if (imageRes.ok) {
            const buffer = Buffer.from(await imageRes.arrayBuffer());
            if (buffer.length <= 20 * 1024 * 1024) {
              let processedBuffer = buffer;
              let ext = '.' + (filePath.split('.').pop() || 'jpg');
              try {
                const sharp = require('sharp');
                const metadata = await sharp(buffer).metadata();
                if (metadata.width && metadata.width > 1920) {
                  processedBuffer = await sharp(buffer).rotate().resize(1920, null, { withoutEnlargement: true }).jpeg({ quality: 95 }).withMetadata({ orientation: undefined }).toBuffer();
                  ext = '.jpg';
                } else {
                  processedBuffer = await sharp(buffer).rotate().withMetadata({ orientation: undefined }).toBuffer();
                }
              } catch { /* sharp not available */ }

              if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
              const filename = `telegram_${crypto.randomUUID()}${ext}`;
              fs.writeFileSync(path.join(uploadsDir, filename), processedBuffer);
              try {
                sqlite.prepare('INSERT INTO files (filename, original_name, mime_type, size_bytes, uploaded_by, context, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(filename, `telegram_photo${ext}`, ext === '.jpg' ? 'image/jpeg' : 'image/png', processedBuffer.length, 'gorn', 'telegram', Date.now());
              } catch { /* files table may not have all columns */ }
              photoUrl = `https://denbook.online/api/f/${filename}`;
              console.log(`[Telegram:${bot.beast}] Photo saved: ${filename}`);
            }
          }
        }
      } catch (e) { console.error(`[Telegram:${bot.beast}] Photo download error:`, e); }

      const caption = msg.caption || '';
      if (photoUrl) {
        notifyText = caption
          ? `[Telegram from Gorn] ${replyContext}${caption}\\n\\nPhoto: ${photoUrl}`
          : `[Telegram from Gorn] ${replyContext}Photo: ${photoUrl}`;
      } else {
        notifyText = caption
          ? `[Telegram from Gorn] ${replyContext}Photo: ${caption}`
          : `[Telegram from Gorn] ${replyContext}Photo received (download failed)`;
      }
      confirmText = `✓ Notified ${bot.beast}`;

    } else if (msg.text) {
      notifyText = `[Telegram from Gorn] ${replyContext}${msg.text}`;
      confirmText = `✓ Notified ${bot.beast}`;

    } else if (msg.document) {
      const docName = msg.document.file_name || 'unknown';
      notifyText = `[Telegram from Gorn] ${replyContext}Document: ${docName}${msg.caption ? ' — ' + msg.caption : ''}`;
      confirmText = `✓ Notified ${bot.beast}`;

    } else if (msg.voice) {
      notifyText = `[Telegram from Gorn] ${replyContext}Voice message`;
      confirmText = `✓ Notified ${bot.beast}`;

    } else if (msg.sticker) {
      const emoji = msg.sticker.emoji || '';
      notifyText = `[Telegram from Gorn] ${replyContext}Sticker ${emoji}`;
      confirmText = `✓ Notified ${bot.beast}`;

    } else {
      notifyText = `[Telegram from Gorn] ${replyContext}Message received`;
      confirmText = `✓ Notified ${bot.beast}`;
    }

    const msgTime = msg.date ? new Date(msg.date * 1000) : new Date();
    const notification = `${notifyText}\\n\\nReply via Telegram to respond to Gorn.`;
    enqueueNotification(bot.beast, notification, { sentAt: msgTime });

    console.log(`[Telegram:${bot.beast}] Notified: ${notifyText.slice(0, 80)}`);
    bot.messageCount++;
    bot.lastMessageAt = new Date().toISOString();

  } catch (err) {
    console.error(`[Telegram:${bot.beast}] Error handling message:`, err);
  }
}

async function pollTelegramBot(bot: TelegramBot, sqlite: Database, uploadsDir: string): Promise<void> {
  if (bot.polling) return;
  bot.polling = true;
  try {
    const data = await tgApi(bot.token, 'getUpdates', {
      offset: String(bot.offset),
      timeout: '3',
      allowed_updates: JSON.stringify(['message']),
    });

    if (data.ok && data.result?.length) {
      for (const update of data.result) {
        bot.offset = update.update_id + 1;
        const msg = update.message;
        if (msg) {
          console.log(`[Telegram:${bot.beast}] Update ${update.update_id}: chat_id=${msg.chat?.id} from=${msg.from?.username || msg.from?.id} text=${(msg.text || '[non-text]').slice(0, 50)}`);
          await handleTelegramMessage(bot, msg, sqlite, uploadsDir);
        }
      }
    }
  } catch (err) {
    console.error(`[Telegram:${bot.beast}] Poll error:`, err);
  } finally {
    bot.polling = false;
  }
}

const TELEGRAM_READ_MODES: Record<string, 'read'> = {
  sable: 'read',
};

function isTelegramAuthorized(c: any, hasSessionAuth: (c: Context) => boolean, isTrustedRequest: (c: Context) => boolean): boolean {
  if (hasSessionAuth(c)) return true;
  const actor = (c.get as any)('actor') as string | undefined;
  if (actor && telegramBots.some(b => b.beast === actor)) return true;
  if (isTrustedRequest(c)) {
    const as = (c.req.query('as') || '').toLowerCase();
    return TELEGRAM_READ_MODES[as] === 'read';
  }
  return false;
}

interface TelegramHelpers {
  hasSessionAuth: (c: Context) => boolean;
  isTrustedRequest: (c: Context) => boolean;
  uploadsDir: string;
}

export function registerTelegramRoutes(app: OpenAPIHono, sqlite: Database, helpers: TelegramHelpers) {
  const { hasSessionAuth, isTrustedRequest, uploadsDir } = helpers;

  // GET /api/telegram/status — polling status (owner only)
  app.get('/api/telegram/status', (c) => {
    if (!hasSessionAuth(c) && !isTrustedRequest(c)) return c.json({ error: 'Auth required' }, 403);

    return c.json({
      bots: telegramBots.map(b => ({
        beast: b.beast,
        polling: b.active,
        chat_id: b.chatId ? `${b.chatId.slice(0, 4)}****` : null,
        last_message_at: b.lastMessageAt,
        message_count: b.messageCount,
      })),
      poll_interval_ms: TG_POLL_INTERVAL,
      total_bots: telegramBots.length,
    });
  });

  // T#712: GET /api/telegram/message/:id — fetch cached inbound TG message body
  app.get('/api/telegram/message/:id', (c) => {
    if (!isTelegramAuthorized(c, hasSessionAuth, isTrustedRequest)) return c.json({ error: 'Telegram cache is private' }, 403);
    const idParam = c.req.param('id');
    const msgId = parseInt(idParam, 10);
    if (!Number.isFinite(msgId) || String(msgId) !== idParam) {
      return c.json({ error: 'id must be an integer' }, 400);
    }
    const validChatIds = telegramBots.map(b => b.chatId).filter(Boolean);
    if (validChatIds.length === 0) return c.json({ error: 'no telegram bots configured' }, 503);
    const placeholders = validChatIds.map(() => '?').join(',');
    const row = sqlite.prepare(
      `SELECT chat_id, id, from_id, text, caption, photo_file_id, date_unix, received_at, raw_json FROM telegram_messages WHERE chat_id IN (${placeholders}) AND id = ? LIMIT 1`
    ).get(...validChatIds, msgId) as any;
    if (!row) return c.json({ error: 'message not found' }, 404);
    let raw: any = null;
    try { raw = JSON.parse(row.raw_json); } catch { /* leave null on parse fail */ }
    return c.json({
      chat_id: row.chat_id,
      id: row.id,
      from_id: row.from_id,
      text: row.text,
      caption: row.caption,
      photo_file_id: row.photo_file_id,
      date_unix: row.date_unix,
      received_at: row.received_at,
      raw: raw,
    });
  });

  // Start polling on registration
  startTelegramPolling(sqlite, uploadsDir);
}

function startTelegramPolling(sqlite: Database, uploadsDir: string): void {
  if (telegramBots.length === 0) {
    console.log('[Telegram] No bots configured — polling disabled');
    return;
  }

  for (const bot of telegramBots) {
    bot.active = true;
    const delay = telegramBots.indexOf(bot) * 1000;
    setTimeout(() => {
      pollTelegramBot(bot, sqlite, uploadsDir).then(() => {
        bot.timer = setInterval(() => pollTelegramBot(bot, sqlite, uploadsDir), TG_POLL_INTERVAL);
        console.log(`[Telegram:${bot.beast}] Polling started (every ${TG_POLL_INTERVAL / 1000}s)`);
      });
    }, delay);
  }
}

export { tgSendReply, telegramBots };
