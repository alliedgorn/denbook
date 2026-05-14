import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';
import { getCookie } from 'hono/cookie';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

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

interface FilesHelpers {
  hasSessionAuth: (c: Context) => boolean;
  isTrustedRequest: (c: Context) => boolean;
  isLocalNetwork: (c: Context) => boolean;
  verifySessionToken: (token: string) => boolean;
  uploadsDir: string;
  sessionCookieName: string;
}

export function registerFilesRoutes(app: OpenAPIHono, sqlite: Database, helpers: FilesHelpers) {
  const { hasSessionAuth, isTrustedRequest, isLocalNetwork, verifySessionToken, uploadsDir: UPLOADS_DIR, sessionCookieName: SESSION_COOKIE_NAME } = helpers;

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
}
