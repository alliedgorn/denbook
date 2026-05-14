import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';

interface TeamsHelpers {
  hasSessionAuth: (c: Context) => boolean;
}

export function registerTeamsRoutes(app: OpenAPIHono, sqlite: Database, helpers: TeamsHelpers) {
  const { hasSessionAuth } = helpers;

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
}
