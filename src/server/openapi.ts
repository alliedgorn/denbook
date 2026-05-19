import { createRoute, z } from '@hono/zod-openapi';

export const healthRoute = createRoute({
  method: 'get',
  path: '/api/health',
  tags: ['system'],
  summary: 'Server health check',
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ status: z.string(), server: z.string(), port: z.number(), oracleV2: z.string() }) } },
      description: 'Server is healthy',
    },
  },
});

export const authStatusRoute = createRoute({
  method: 'get',
  path: '/api/auth/status',
  tags: ['auth'],
  summary: 'Check if session is authenticated',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            authenticated: z.boolean(),
            authEnabled: z.boolean(),
            hasPassword: z.boolean().optional(),
            localBypass: z.boolean().optional(),
            isLocal: z.boolean().optional(),
            role: z.enum(['owner', 'guest']).optional(),
            guestName: z.string().optional(),
            guestUsername: z.string().optional(),
          }),
        },
      },
      description: 'Auth status response (owner branch carries hasPassword/localBypass/isLocal; guest branch carries guestName/guestUsername)',
    },
  },
});

export const authLoginRoute = createRoute({
  method: 'post',
  path: '/api/auth/login',
  tags: ['auth'],
  summary: 'Login with password',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            password: z.string(),
            username: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            role: z.enum(['owner', 'guest']).optional(),
            display_name: z.string().optional(),
          }),
        },
      },
      description: 'Login successful',
    },
    400: {
      content: { 'application/json': { schema: z.object({ success: z.literal(false), error: z.string() }) } },
      description: 'Missing password or no password configured',
    },
    401: {
      content: { 'application/json': { schema: z.object({ success: z.literal(false), error: z.string() }) } },
      description: 'Invalid credentials',
    },
    429: {
      content: { 'application/json': { schema: z.object({ success: z.literal(false), error: z.string() }) } },
      description: 'Rate limited',
    },
  },
});

export const authLogoutRoute = createRoute({
  method: 'post',
  path: '/api/auth/logout',
  tags: ['auth'],
  summary: 'Logout current session',
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ success: z.boolean() }) } },
      description: 'Logout successful',
    },
  },
});

// ============================================================================
// /api/forum/emojis — emoji whitelist CRUD (Spec #55 Phase 2 emoji domain)
// ============================================================================

export const emojiListRoute = createRoute({
  method: 'get',
  path: '/api/forum/emojis',
  tags: ['emoji'],
  summary: 'List whitelisted forum emojis',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            emoji: z.array(z.object({
              emoji: z.string(),
              added_by: z.string().nullable(),
              created_at: z.number(),
            })),
            total: z.number(),
          }),
        },
      },
      description: 'Whitelisted emoji list',
    },
  },
});

export const emojiAddRoute = createRoute({
  method: 'post',
  path: '/api/forum/emojis',
  tags: ['emoji'],
  summary: 'Add emoji to whitelist',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            emoji: z.string(),
            beast: z.string().optional(),
            added_by: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            added: z.string(),
            by: z.string(),
            total: z.number(),
          }),
        },
      },
      description: 'Emoji added',
    },
    400: {
      content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      description: 'Missing emoji or beast field',
    },
  },
});

export const emojiRemoveRoute = createRoute({
  method: 'delete',
  path: '/api/forum/emojis/{emoji}',
  tags: ['emoji'],
  summary: 'Remove emoji from whitelist (owner-only)',
  request: {
    params: z.object({
      emoji: z.string(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            removed: z.string(),
            total: z.number(),
          }),
        },
      },
      description: 'Emoji removed',
    },
    403: {
      content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      description: 'Owner-only — bearer or session required',
    },
  },
});

// ============================================================================
// /api/settings — auth + vault settings (Spec #55 Phase 2 settings domain)
// ============================================================================

export const settingsGetRoute = createRoute({
  method: 'get',
  path: '/api/settings',
  tags: ['settings'],
  summary: 'Get current auth + vault settings (no password hash exposed)',
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            authEnabled: z.boolean(),
            localBypass: z.boolean(),
            hasPassword: z.boolean(),
            vaultRepo: z.string().nullable(),
          }),
        },
      },
      description: 'Current settings snapshot',
    },
  },
});

export const settingsUpdateRoute = createRoute({
  method: 'post',
  path: '/api/settings',
  tags: ['settings'],
  summary: 'Update auth settings (Gorn-only via UI — beast API calls rejected)',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            newPassword: z.string().optional(),
            currentPassword: z.string().optional(),
            removePassword: z.boolean().optional(),
            authEnabled: z.boolean().optional(),
            localBypass: z.boolean().optional(),
            as: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            authEnabled: z.boolean(),
            localBypass: z.boolean(),
            hasPassword: z.boolean(),
          }),
        },
      },
      description: 'Settings updated',
    },
    400: {
      content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      description: 'Missing current password or cannot enable auth without password',
    },
    401: {
      content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      description: 'Current password is incorrect',
    },
    403: {
      content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      description: 'Beast API call blocked — settings can only be changed by Gorn via the UI',
    },
  },
});

// ============================================================================
// /api/queue/gorn — Gorn queue CRUD (Spec #55 Phase 2 queue domain)
// ============================================================================

export const queueListRoute = createRoute({
  method: 'get',
  path: '/api/queue/gorn',
  tags: ['queue'],
  summary: 'List queued threads for Gorn',
  request: {
    query: z.object({
      status: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            items: z.array(z.object({
              thread_id: z.number(),
              title: z.string(),
              thread_status: z.string().nullable(),
              queue_status: z.string().nullable(),
              tagged_by: z.string().nullable(),
              tagged_at: z.string().nullable(),
              summary: z.string().nullable(),
              message_count: z.number(),
              created_at: z.string(),
            })),
            total: z.number(),
          }),
        },
      },
      description: 'Queue items filtered by queue_status (default: pending)',
    },
  },
});

export const queueAddRoute = createRoute({
  method: 'post',
  path: '/api/queue/gorn',
  tags: ['queue'],
  summary: 'Tag a thread into Gorn queue',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            thread_id: z.number(),
            tagged_by: z.string().optional(),
            summary: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            thread_id: z.number(),
            queue_status: z.literal('pending'),
          }),
        },
      },
      description: 'Thread tagged into queue',
    },
    400: {
      content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      description: 'Missing thread_id or invalid JSON',
    },
  },
});

export const queueUpdateRoute = createRoute({
  method: 'patch',
  path: '/api/queue/gorn/{threadId}',
  tags: ['queue'],
  summary: 'Update queue status (Decided/Defer/Withdraw — Gorn-only from browser)',
  request: {
    params: z.object({
      threadId: z.string(),
    }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            status: z.string(),
            as: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            success: z.literal(true),
            thread_id: z.number(),
            queue_status: z.string(),
          }),
        },
      },
      description: 'Queue status updated',
    },
    400: {
      content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      description: 'Missing/invalid status or invalid JSON',
    },
    403: {
      content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      description: 'Browser callers must be Gorn',
    },
  },
});

// ============================================================================
// /api/supersede — supersede chain log (Spec #55 Phase 2 supersede domain)
// ============================================================================

export const supersedeListRoute = createRoute({
  method: 'get',
  path: '/api/supersede',
  tags: ['supersede'],
  summary: 'List supersede log entries',
  request: {
    query: z.object({
      project: z.string().optional(),
      limit: z.string().optional(),
      offset: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            supersessions: z.array(z.object({
              id: z.number(),
              old_path: z.string(),
              old_id: z.string().nullable(),
              old_title: z.string().nullable(),
              old_type: z.string().nullable(),
              new_path: z.string().nullable(),
              new_id: z.string().nullable(),
              new_title: z.string().nullable(),
              reason: z.string().nullable(),
              superseded_at: z.string(),
              superseded_by: z.string().nullable(),
              project: z.string().nullable(),
            })),
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
        },
      },
      description: 'Supersede log entries with paging metadata',
    },
  },
});

export const supersedeChainRoute = createRoute({
  method: 'get',
  path: '/api/supersede/chain/{path}',
  tags: ['supersede'],
  summary: 'Get supersede chain for a document path',
  request: {
    params: z.object({
      path: z.string(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({
            superseded_by: z.array(z.object({
              new_path: z.string().nullable(),
              reason: z.string().nullable(),
              superseded_at: z.string(),
            })),
            supersedes: z.array(z.object({
              old_path: z.string(),
              reason: z.string().nullable(),
              superseded_at: z.string(),
            })),
          }),
        },
      },
      description: 'Chain of supersessions touching the given path',
    },
  },
});

export const supersedeCreateRoute = createRoute({
  method: 'post',
  path: '/api/supersede',
  tags: ['supersede'],
  summary: 'Log a new supersession',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            old_path: z.string(),
            old_id: z.string().optional(),
            old_title: z.string().optional(),
            old_type: z.string().optional(),
            new_path: z.string().optional(),
            new_id: z.string().optional(),
            new_title: z.string().optional(),
            reason: z.string().optional(),
            superseded_by: z.string().optional(),
            project: z.string().optional(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      content: {
        'application/json': {
          schema: z.object({
            id: z.number(),
            message: z.string(),
          }),
        },
      },
      description: 'Supersession logged',
    },
    400: {
      content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      description: 'Missing required field',
    },
    500: {
      content: { 'application/json': { schema: z.object({ error: z.string() }) } },
      description: 'Insert failed',
    },
  },
});


export const OPENAPI_INFO = {
  openapi: '3.0.0' as const,
  info: {
    title: 'Den Book API',
    version: '1.0.0',
    description: 'Internal API for Den Book — Beast communication, forum, tasks, and village life.',
  },
};
