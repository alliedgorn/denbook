import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';
import * as path from 'path';
import * as fs from 'fs';
import { handleLearn } from '../server/handlers.ts';

interface InboxHelpers {
  isTrustedRequest: (c: Context) => boolean;
  requireBeastIdentity: (c: Context) => string | null;
  wsBroadcast: (event: string, data: any) => void;
  repoRoot: string;
}

export function registerInboxRoutes(app: OpenAPIHono, sqlite: Database, helpers: InboxHelpers) {
  const { isTrustedRequest, requireBeastIdentity, wsBroadcast, repoRoot: REPO_ROOT } = helpers;

  app.post('/api/handoff', async (c) => {
    try {
      // T#883 — the rested Beast comes from the AUTHENTICATED caller, never from ?as=.
      // ?as= stays only as an opt-in that must equal the caller; a mismatch is
      // refused before anything is written. (Was: any trusted caller could rest any
      // Beast by name, which silently paused all of that seat's beats.)
      const asParam = c.req.query('as')?.toLowerCase();
      const caller = requireBeastIdentity(c);
      if (asParam && asParam !== caller) {
        return c.json({
          error: caller
            ? 'Cross-Beast rest blocked: ?as= must match the authenticated caller'
            : 'Beast identity required to rest — bearer-token or owner session'
        }, 403);
      }

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

      // T#658 — Norm #65 — opt-in: ?as=<self> also sets the caller's rest_status='rest'.
      // Identity is the caller checked above (asParam === caller), so a seat can only rest itself.
      let restedBeast: string | null = null;
      if (asParam && caller && isTrustedRequest(c)) {
        const beastRow = sqlite.prepare('SELECT name FROM beast_profiles WHERE name = ?').get(caller) as any;
        if (beastRow) {
          sqlite.prepare("UPDATE beast_profiles SET rest_status = 'rest', updated_at = ? WHERE name = ?")
            .run(Date.now(), caller);
          restedBeast = caller;
          console.log(`[Handoff] ${caller} → rest_status=rest`);
          wsBroadcast('beast_state_change', { beast: caller, rest_status: 'rest' });
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
}
