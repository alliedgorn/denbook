import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';

interface LibraryHelpers {
  hasSessionAuth: (c: Context) => boolean;
  requireBeastIdentity: (c: Context) => string | null;
  searchIndexUpsert: (sourceType: string, sourceId: number, title: string, content: string, author: string, createdAt: string, url?: string) => void;
  searchIndexDelete: (sourceType: string, sourceId: number) => void;
  wsBroadcast: (event: string, data: any) => void;
}

export function registerLibraryRoutes(app: OpenAPIHono, sqlite: Database, helpers: LibraryHelpers) {
  const { hasSessionAuth, requireBeastIdentity, searchIndexUpsert, searchIndexDelete, wsBroadcast } = helpers;

  // --- Shelf CRUD ---

  // GET /api/library/shelves — list all shelves with entry counts
  app.get('/api/library/shelves', (c) => {
    const isGuest = (c.get as any)('role') === 'guest';
    const visFilter = c.req.query('visibility');
    let query = `
      SELECT s.*, COUNT(l.id) as entry_count
      FROM library_shelves s
      LEFT JOIN library l ON l.shelf_id = s.id
    `;
    const params: any[] = [];
    if (isGuest) {
      query += ` WHERE s.visibility = 'public'`;
    } else if (visFilter === 'public' || visFilter === 'internal') {
      query += ` WHERE s.visibility = ?`;
      params.push(visFilter);
    }
    query += ` GROUP BY s.id ORDER BY s.name`;
    const shelves = sqlite.prepare(query).all(...params);
    return c.json({ shelves });
  });

  // GET /api/library/shelves/:id — single shelf with entries
  app.get('/api/library/shelves/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
    const isGuest = (c.get as any)('role') === 'guest';
    const shelf = sqlite.prepare('SELECT * FROM library_shelves WHERE id = ?').get(id) as any;
    if (!shelf) return c.json({ error: 'Shelf not found' }, 404);
    if (isGuest && shelf.visibility !== 'public') return c.json({ error: 'Shelf not found' }, 404);
    const entryCount = (sqlite.prepare('SELECT COUNT(*) as c FROM library WHERE shelf_id = ?').get(id) as any).c;
    return c.json({ ...shelf, entry_count: entryCount });
  });

  // POST /api/library/shelves — create shelf
  app.post('/api/library/shelves', async (c) => {
    try {
      const data = await c.req.json();
      if (!data.name?.trim()) return c.json({ error: 'name required' }, 400);
      // T#718 — derive author from auth, reject client-asserted mismatch
      const caller = requireBeastIdentity(c);
      if (!caller) {
        return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
      }
      const claimed = (c.req.query('as') || data.created_by || '').toLowerCase();
      if (claimed && claimed !== caller) {
        return c.json({ error: 'Identity spoof blocked. ?as=/body.created_by must match authenticated caller or be omitted.' }, 403);
      }
      const author = caller;

      // Check duplicate
      const existing = sqlite.prepare('SELECT id FROM library_shelves WHERE name = ?').get(data.name.trim());
      if (existing) return c.json({ error: 'A shelf with this name already exists' }, 409);

      const now = new Date().toISOString();
      const visibility = (data.visibility === 'public') ? 'public' : 'internal';
      const result = sqlite.prepare(
        'INSERT INTO library_shelves (name, description, icon, color, created_by, created_at, updated_at, visibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(data.name.trim(), data.description || null, data.icon || null, data.color || null, author, now, now, visibility);
      const shelf = sqlite.prepare('SELECT * FROM library_shelves WHERE id = ?').get((result as any).lastInsertRowid) as any;
      searchIndexUpsert('shelf', shelf.id, shelf.name, shelf.description || '', author, now, '/library');
      return c.json(shelf, 201);
    } catch (e: any) {
      return c.json({ error: e?.message || 'Invalid request' }, 400);
    }
  });

  // PATCH /api/library/shelves/:id — update shelf
  app.patch('/api/library/shelves/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
    const existing = sqlite.prepare('SELECT * FROM library_shelves WHERE id = ?').get(id);
    if (!existing) return c.json({ error: 'Shelf not found' }, 404);
    try {
      const data = await c.req.json();
      const allowed = ['name', 'description', 'icon', 'color', 'visibility'];
      const updates: string[] = [];
      const values: any[] = [];
      for (const field of allowed) {
        if (field in data) {
          if (field === 'name' && data.name?.trim()) {
            const dup = sqlite.prepare('SELECT id FROM library_shelves WHERE name = ? AND id != ?').get(data.name.trim(), id);
            if (dup) return c.json({ error: 'A shelf with this name already exists' }, 409);
          }
          if (field === 'visibility') {
            if (!hasSessionAuth(c)) return c.json({ error: 'Only Gorn can change shelf visibility' }, 403);
            const val = data[field] === 'public' ? 'public' : 'internal';
            updates.push(`${field} = ?`);
            values.push(val);
            continue;
          }
          updates.push(`${field} = ?`);
          values.push(data[field]);
        }
      }
      if (updates.length === 0) return c.json({ error: 'No valid fields to update' }, 400);
      updates.push('updated_at = ?');
      values.push(new Date().toISOString());
      values.push(id);
      sqlite.prepare(`UPDATE library_shelves SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      const shelf = sqlite.prepare('SELECT * FROM library_shelves WHERE id = ?').get(id) as any;
      if (shelf) searchIndexUpsert('shelf', id, shelf.name, shelf.description || '', shelf.created_by, shelf.created_at, '/library');
      return c.json(shelf);
    } catch {
      return c.json({ error: 'Invalid request' }, 400);
    }
  });

  // DELETE /api/library/shelves/:id — delete shelf, entries become ungrouped (Gorn only)
  app.delete('/api/library/shelves/:id', async (c) => {
    if (!hasSessionAuth(c)) return c.json({ error: 'Gorn-only' }, 403);
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
    const existing = sqlite.prepare('SELECT * FROM library_shelves WHERE id = ?').get(id);
    if (!existing) return c.json({ error: 'Shelf not found' }, 404);
    // Ungroup entries (ON DELETE SET NULL handles this, but be explicit)
    sqlite.prepare('UPDATE library SET shelf_id = NULL WHERE shelf_id = ?').run(id);
    sqlite.prepare('DELETE FROM library_shelves WHERE id = ?').run(id);
    searchIndexDelete('shelf', id);
    return c.json({ deleted: true, id });
  });

  // GET /api/library — list/search library entries
  app.get('/api/library', (c) => {
    const isGuest = (c.get as any)('role') === 'guest';
    const q = c.req.query('q');
    const type = c.req.query('type') || c.req.query('category');
    const author = c.req.query('author');
    const tag = c.req.query('tag');
    const limit = Math.max(1, parseInt(c.req.query('limit') || '50', 10) || 50);
    const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10) || 0);

    let query = 'SELECT l.* FROM library l';
    const params: any[] = [];

    // T#623: guests only see entries in public shelves
    if (isGuest) {
      query += ' INNER JOIN library_shelves s ON s.id = l.shelf_id AND s.visibility = \'public\'';
    }

    query += ' WHERE 1=1';

    if (q) {
      query += ' AND (l.title LIKE ? OR l.content LIKE ?)';
      params.push(`%${q}%`, `%${q}%`);
    }
    if (type) {
      query += ' AND l.type = ?';
      params.push(type);
    }
    if (author) {
      query += ' AND l.author = ?';
      params.push(author);
    }
    if (tag) {
      query += ' AND l.tags LIKE ?';
      params.push(`%"${tag}"%`);
    }
    const shelfId = c.req.query('shelf_id');
    if (shelfId === 'null') {
      query += ' AND l.shelf_id IS NULL';
    } else if (shelfId) {
      query += ' AND l.shelf_id = ?';
      params.push(parseInt(shelfId, 10));
    }

    // Count
    const countQuery = query.replace('SELECT l.*', 'SELECT COUNT(*) as count');
    const countResult = sqlite.prepare(countQuery).get(...params) as any;

    query += ' ORDER BY l.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const rows = sqlite.prepare(query).all(...params) as any[];

    return c.json({
      entries: rows.map(r => ({
        id: r.id,
        title: r.title,
        content: r.content,
        type: r.type,
        category: r.type,
        author: r.author,
        tags: (() => { try { const t = JSON.parse(r.tags || '[]'); return Array.isArray(t) ? t : []; } catch { return typeof r.tags === 'string' && r.tags ? r.tags.split(',').map((s: string) => s.trim()) : []; } })(),
        shelf_id: r.shelf_id || null,
        created_at: new Date(r.created_at).toISOString(),
        updated_at: new Date(r.updated_at).toISOString(),
      })),
      total: countResult?.count || 0,
    });
  });

  // GET /api/library/search — typeahead suggestions for shelves + entries
  app.get('/api/library/search', (c) => {
    const isGuest = (c.get as any)('role') === 'guest';
    const q = c.req.query('q')?.trim();
    if (!q || q.length < 2) return c.json({ suggestions: [] });

    const pattern = `%${q}%`;

    const shelfQuery = isGuest
      ? 'SELECT id, name, icon, color, "shelf" as result_type FROM library_shelves WHERE name LIKE ? AND visibility = \'public\' LIMIT 5'
      : 'SELECT id, name, icon, color, "shelf" as result_type FROM library_shelves WHERE name LIKE ? LIMIT 5';
    const shelves = sqlite.prepare(shelfQuery).all(pattern) as any[];

    const entryQuery = isGuest
      ? 'SELECT l.id, l.title, l.type, l.author, l.shelf_id, "entry" as result_type FROM library l INNER JOIN library_shelves s ON s.id = l.shelf_id AND s.visibility = \'public\' WHERE l.title LIKE ? ORDER BY l.updated_at DESC LIMIT 8'
      : 'SELECT id, title, type, author, shelf_id, "entry" as result_type FROM library WHERE title LIKE ? ORDER BY updated_at DESC LIMIT 8';
    const entries = sqlite.prepare(entryQuery).all(pattern) as any[];

    return c.json({
      suggestions: [
        ...shelves.map(s => ({ id: s.id, label: s.name, icon: s.icon, color: s.color, type: 'shelf' as const })),
        ...entries.map(e => ({ id: e.id, label: e.title, type: 'entry' as const, entryType: e.type, author: e.author, shelf_id: e.shelf_id })),
      ],
    });
  });

  // GET /api/library/types — list available types and counts (must be before /:id)
  app.get('/api/library/types', (c) => {
    const rows = sqlite.prepare('SELECT type, COUNT(*) as count FROM library GROUP BY type ORDER BY count DESC').all() as any[];
    return c.json({ types: rows });
  });

  // GET /api/library/:id — get single entry
  app.get('/api/library/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const isGuest = (c.get as any)('role') === 'guest';
    const row = sqlite.prepare('SELECT * FROM library WHERE id = ?').get(id) as any;
    if (!row) return c.json({ error: 'Entry not found' }, 404);
    // T#623: guests can only see entries in public shelves
    if (isGuest && row.shelf_id) {
      const shelf = sqlite.prepare('SELECT visibility FROM library_shelves WHERE id = ?').get(row.shelf_id) as any;
      if (!shelf || shelf.visibility !== 'public') return c.json({ error: 'Entry not found' }, 404);
    } else if (isGuest && !row.shelf_id) {
      return c.json({ error: 'Entry not found' }, 404); // unshelved entries hidden from guests
    }

    return c.json({
      id: row.id,
      title: row.title,
      content: row.content,
      type: row.type,
      category: row.type,
      author: row.author,
      tags: JSON.parse(row.tags || '[]'),
      created_at: new Date(row.created_at).toISOString(),
      updated_at: new Date(row.updated_at).toISOString(),
    });
  });

  // POST /api/library — create entry
  app.post('/api/library', async (c) => {
    try {
      const data = await c.req.json();
      if (!data.title || !data.content) {
        return c.json({ error: 'title and content required' }, 400);
      }
      // T#718 — derive author from auth, reject client-asserted mismatch
      const caller = requireBeastIdentity(c);
      if (!caller) {
        return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
      }
      if (data.author && data.author.toLowerCase() !== caller) {
        return c.json({ error: 'Author impersonation blocked. body.author must match authenticated caller or be omitted.' }, 403);
      }
      const author = caller;

      const allowed = ['research', 'architecture', 'learning', 'decision'];
      const type = allowed.includes(data.type) ? data.type : 'learning';
      const tags = JSON.stringify(data.tags || []);
      const now = Date.now();

      const shelfId = data.shelf_id ? Number(data.shelf_id) : null;
      if (!shelfId) return c.json({ error: 'shelf_id required — every entry must belong to a shelf' }, 400);
      const result = sqlite.prepare(
        'INSERT INTO library (title, content, type, author, tags, shelf_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(data.title, data.content, type, author, tags, shelfId, now, now);

      const newId = (result as any).lastInsertRowid;
      searchIndexUpsert('library', newId, data.title, data.content, author, new Date(now).toISOString());
      return c.json({ id: newId, title: data.title, type, author }, 201);
    } catch (e) {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
  });

  // PATCH /api/library/:id — update entry
  app.patch('/api/library/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    try {
      const data = await c.req.json();
      const now = Date.now();
      const updates: string[] = ['updated_at = ?'];
      const params: any[] = [now];

      if (data.title) { updates.push('title = ?'); params.push(data.title); }
      if (data.content) { updates.push('content = ?'); params.push(data.content); }
      if (data.type) { updates.push('type = ?'); params.push(data.type); }
      if (data.tags) { updates.push('tags = ?'); params.push(JSON.stringify(data.tags)); }
      if ('shelf_id' in data) { updates.push('shelf_id = ?'); params.push(data.shelf_id || null); }

      params.push(id);
      sqlite.prepare(`UPDATE library SET ${updates.join(', ')} WHERE id = ?`).run(...params);

      const updated = sqlite.prepare('SELECT * FROM library WHERE id = ?').get(id) as any;
      if (updated) {
        searchIndexUpsert('library', id, updated.title, updated.content, updated.author, new Date(updated.created_at).toISOString());
        if (updated.tags) { try { updated.tags = JSON.parse(updated.tags); } catch { updated.tags = []; } }
      }
      return c.json(updated);
    } catch (e) {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
  });

  // DELETE /api/library/:id — delete entry (Gorn or Pip)
  app.delete('/api/library/:id', (c) => {
    // T#718 — derive requester from auth, reject client-asserted mismatch
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    const claimedAs = c.req.query('as')?.toLowerCase();
    if (claimedAs && claimedAs !== caller) {
      return c.json({ error: 'Identity spoof blocked. ?as= must match authenticated caller or be omitted.' }, 403);
    }
    const requester = caller;
    if (requester !== 'gorn' && requester !== 'pip') {
      return c.json({ error: 'Only Gorn or Pip can delete library entries' }, 403);
    }
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
    const existing = sqlite.prepare('SELECT id FROM library WHERE id = ?').get(id) as any;
    if (!existing) return c.json({ error: 'Entry not found' }, 404);
    sqlite.prepare('DELETE FROM library WHERE id = ?').run(id);
    searchIndexDelete('library', id);
    wsBroadcast('library_entry_deleted', { id });
    return c.json({ deleted: true, id });
  });
}
