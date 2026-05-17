import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';
import { db, beastProfiles, getBeastProfile, getAllBeastProfiles, upsertBeastProfile, updateBeastAvatar } from '../db/index.ts';

// ============================================================================
// Pack routes — Phase 2.5 of Library #102 (T#783)
// ============================================================================

interface PackHelpers {
  hasSessionAuth: (c: Context) => boolean;
  requireBeastIdentity: (c: Context) => string | null;
  isTrustedRequest: (c: Context) => boolean;
  wsBroadcast: (event: string, data: any) => void;
  getTmuxStatus: () => { tmuxStatus: Map<string, any>; contextPctMap: Map<string, number | null> };
  normalizeAvatarUrl: (url: string | null) => string | null;
  webPresence: Map<string, { identity: string; role: string; lastSeen: number }>;
  WEB_PRESENCE_TIMEOUT_MS: number;
}

export function registerPackRoutes(app: OpenAPIHono, sqliteDb: Database, helpers: PackHelpers): void {
  const { hasSessionAuth, requireBeastIdentity, isTrustedRequest, wsBroadcast, getTmuxStatus, normalizeAvatarUrl, webPresence, WEB_PRESENCE_TIMEOUT_MS } = helpers;
  const sqlite: Database = sqliteDb;

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

  app.post('/api/beasts/seed-avatars', (c) => {
    // T#793 PACK-1 — Gorn-only (mass-mutate across all profiles).
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (caller !== 'gorn') {
      return c.json({ error: 'Gorn-only — mass profile mutation' }, 403);
    }
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

  app.get('/api/beasts', (c) => {
    const profiles = getAllBeastProfiles();
    return c.json({ beasts: profiles });
  });

  app.get('/api/beast/:name', (c) => {
    const name = c.req.param('name');
    const profile = getBeastProfile(name);
    if (!profile) {
      return c.json({ error: 'Beast not found' }, 404);
    }
    return c.json(profile);
  });

  app.put('/api/beast/:name', async (c) => {
    try {
      // T#793 PACK-1 — owner-or-Gorn-only profile create/replace.
      const caller = requireBeastIdentity(c);
      if (!caller) {
        return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
      }
      const name = c.req.param('name');
      if (caller !== name.toLowerCase() && caller !== 'gorn') {
        return c.json({ error: 'Only the beast themselves or Gorn can modify this profile' }, 403);
      }
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

  app.patch('/api/beast/:name', async (c) => {
    try {
      // T#793 PACK-1 — owner-or-Gorn-only profile update.
      const caller = requireBeastIdentity(c);
      if (!caller) {
        return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
      }
      const name = c.req.param('name');
      if (caller !== name.toLowerCase() && caller !== 'gorn') {
        return c.json({ error: 'Only the beast themselves or Gorn can modify this profile' }, 403);
      }
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

  app.patch('/api/beast/:name/avatar', async (c) => {
    try {
      // T#793 PACK-1 — owner-or-Gorn-only avatar update.
      const caller = requireBeastIdentity(c);
      if (!caller) {
        return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
      }
      const name = c.req.param('name');
      if (caller !== name.toLowerCase() && caller !== 'gorn') {
        return c.json({ error: 'Only the beast themselves or Gorn can modify this profile' }, 403);
      }
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


}
