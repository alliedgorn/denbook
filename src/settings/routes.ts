import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';

interface SettingsHelpers {
  getSetting: (key: string) => string | null;
  setSetting: (key: string, value: string | null) => void;
  logSecurityEvent: (event: any) => void;
}

export function registerSettingsRoutes(app: OpenAPIHono, helpers: SettingsHelpers) {
  const { getSetting, setSetting, logSecurityEvent } = helpers;

  // Get settings (no password hash exposed)
  app.get('/api/settings', (c) => {
    const authEnabled = getSetting('auth_enabled') === 'true';
    const localBypass = getSetting('auth_local_bypass') !== 'false';
    const hasPassword = !!getSetting('auth_password_hash');
    const vaultRepo = getSetting('vault_repo');

    return c.json({
      authEnabled,
      localBypass,
      hasPassword,
      vaultRepo
    });
  });

  // Update settings (Gorn only — reject beast API calls)
  app.post('/api/settings', async (c) => {
    // Only allow from browser sessions (Gorn) or local requests, not beast API calls
    const asParam = c.req.query('as');
    if (asParam) {
      const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
      logSecurityEvent({
        eventType: 'impersonation_blocked',
        severity: 'warning',
        actor: asParam,
        actorType: 'beast',
        target: '/api/settings',
        details: { method: 'POST', blocked_reason: 'beast_api_call' },
        ipSource: ip,
        requestId: (c.get as any)('requestId'),
      });
      return c.json({ error: 'Settings can only be changed by Gorn via the UI' }, 403);
    }
    const body = await c.req.json();
    if (body.as) {
      return c.json({ error: 'Settings can only be changed by Gorn via the UI' }, 403);
    }

    // Handle password change
    if (body.newPassword) {
      // If password exists, require current password
      const existingHash = getSetting('auth_password_hash');
      if (existingHash) {
        if (!body.currentPassword) {
          return c.json({ error: 'Current password required' }, 400);
        }
        const valid = await Bun.password.verify(body.currentPassword, existingHash);
        if (!valid) {
          return c.json({ error: 'Current password is incorrect' }, 401);
        }
      }

      // Hash and store new password
      const hash = await Bun.password.hash(body.newPassword);
      setSetting('auth_password_hash', hash);
    }

    // Handle removing password
    if (body.removePassword === true) {
      const existingHash = getSetting('auth_password_hash');
      if (existingHash && body.currentPassword) {
        const valid = await Bun.password.verify(body.currentPassword, existingHash);
        if (!valid) {
          return c.json({ error: 'Current password is incorrect' }, 401);
        }
      }
      setSetting('auth_password_hash', null);
      setSetting('auth_enabled', 'false');
    }

    // Handle auth enabled toggle
    if (typeof body.authEnabled === 'boolean') {
      // Can only enable auth if password is set
      if (body.authEnabled && !getSetting('auth_password_hash')) {
        return c.json({ error: 'Cannot enable auth without password' }, 400);
      }
      setSetting('auth_enabled', body.authEnabled ? 'true' : 'false');
    }

    // Handle local bypass toggle
    if (typeof body.localBypass === 'boolean') {
      setSetting('auth_local_bypass', body.localBypass ? 'true' : 'false');
    }

    // Log security settings changes
    const changes: string[] = [];
    if (body.newPassword) changes.push('password_changed');
    if (body.removePassword) changes.push('password_removed');
    if (typeof body.authEnabled === 'boolean') changes.push(`auth_${body.authEnabled ? 'enabled' : 'disabled'}`);
    if (typeof body.localBypass === 'boolean') changes.push(`local_bypass_${body.localBypass ? 'enabled' : 'disabled'}`);
    if (changes.length > 0) {
      const ip = c.req.header('x-real-ip') || c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
      logSecurityEvent({
        eventType: 'settings_changed',
        severity: 'warning',
        actor: 'gorn',
        actorType: 'human',
        target: '/api/settings',
        details: { changes },
        ipSource: ip,
        requestId: (c.get as any)('requestId'),
      });
    }

    return c.json({
      success: true,
      authEnabled: getSetting('auth_enabled') === 'true',
      localBypass: getSetting('auth_local_bypass') !== 'false',
      hasPassword: !!getSetting('auth_password_hash')
    });
  });
}
