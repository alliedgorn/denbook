import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { execSync } from 'child_process';
import { remoteStatusRoute, remoteAttachRoute, remoteDetachRoute } from '../server/openapi.ts';

const REMOTE_SESSION = 'Mindlink';

interface RemoteHelpers {
  isLocalNetwork: (c: Context) => boolean;
  hasSessionAuth: (c: Context) => boolean;
}

export function registerRemoteRoutes(app: OpenAPIHono, helpers: RemoteHelpers) {
  const { isLocalNetwork, hasSessionAuth } = helpers;

  // Module-local attached-beast state. Reset on server restart (intentional —
  // tmux session is the source of truth, this is a fast-path cache).
  let attachedBeastName: string | null = null;

  // GET /api/remote/status — which beast is currently attached
  app.openapi(remoteStatusRoute, ((c: Context) => {
    // Verify the Remote session still exists and has a linked window
    if (attachedBeastName) {
      try {
        execSync(`tmux has-session -t ${JSON.stringify(REMOTE_SESSION)}`, { timeout: 2000 });
        // Check if window 1 still exists (beast is still linked)
        const windows = execSync(
          `tmux list-windows -t ${JSON.stringify(REMOTE_SESSION)} -F "#{window_index}"`,
          { timeout: 2000 }
        ).toString().trim().split('\n');
        if (!windows.includes('1')) {
          attachedBeastName = null; // Window was unlinked externally
        }
      } catch {
        attachedBeastName = null; // Session gone
      }
    }

    return c.json({ session_exists: !!attachedBeastName, attached_beast: attachedBeastName }, 200);
  }) as any);

  // POST /api/remote/attach — attach a beast's claude window (local only — requires tmux)
  // Cast handler: multi-branch response shape (200/400/403/404/500) conflicts with
  // strict zod-openapi handler typing. Runtime preserves current behavior verbatim.
  app.openapi(remoteAttachRoute, (async (c: Context) => {
    // Remote attach requires local tmux access — reject non-local requests cleanly
    if (!isLocalNetwork(c) && !hasSessionAuth(c)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    try {
      const data = await c.req.json();
      const beastName = data.beast?.toLowerCase();
      if (!beastName) return c.json({ error: 'beast name required' }, 400);

      // Sanitize: only allow alphanumeric beast names
      if (!/^[a-z]+$/.test(beastName)) return c.json({ error: 'Invalid beast name' }, 400);

      const sessionName = beastName.charAt(0).toUpperCase() + beastName.slice(1);

      // Verify beast session exists
      try {
        execSync(`tmux has-session -t ${JSON.stringify(sessionName)}`, { timeout: 2000 });
      } catch {
        return c.json({ error: `No tmux session for ${beastName}` }, 404);
      }

      // Find the claude window index in the beast's session
      let claudeWindow = '1';
      try {
        const windows = execSync(
          `tmux list-windows -t ${JSON.stringify(sessionName)} -F "#{window_index}:#{pane_current_command}"`,
          { timeout: 2000 }
        ).toString().trim().split('\n');
        const claudeWin = windows.find(w => w.includes(':claude'));
        if (claudeWin) claudeWindow = claudeWin.split(':')[0];
      } catch { /* default to 1 */ }

      // Ensure Remote session exists
      try {
        execSync(`tmux has-session -t ${JSON.stringify(REMOTE_SESSION)}`, { timeout: 2000 });
      } catch {
        execSync(`tmux new-session -d -s ${JSON.stringify(REMOTE_SESSION)}`, { timeout: 2000 });
      }

      // Unlink any existing beast window (window index 1)
      try {
        execSync(`tmux unlink-window -k -t ${JSON.stringify(REMOTE_SESSION)}:1`, { timeout: 2000 });
      } catch { /* no window to unlink */ }

      // Link the beast's claude window
      execSync(
        `tmux link-window -s ${JSON.stringify(sessionName)}:${claudeWindow} -t ${JSON.stringify(REMOTE_SESSION)}:1`,
        { timeout: 2000 }
      );

      // Switch to the linked window
      execSync(`tmux select-window -t ${JSON.stringify(REMOTE_SESSION)}:1`, { timeout: 2000 });

      attachedBeastName = beastName;
      return c.json({ attached: beastName, session: REMOTE_SESSION }, 200);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : 'Attach failed' }, 500);
    }
  }) as any);

  // POST /api/remote/detach — detach current beast (local only — requires tmux)
  app.openapi(remoteDetachRoute, ((c: Context) => {
    try {
      execSync(`tmux unlink-window -k -t ${JSON.stringify(REMOTE_SESSION)}:1`, { timeout: 2000 });
    } catch { /* already detached */ }
    attachedBeastName = null;
    return c.json({ detached: true as const }, 200);
  }) as any);
}
