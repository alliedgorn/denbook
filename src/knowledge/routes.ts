import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';
import { desc } from 'drizzle-orm';
import * as path from 'path';
import * as fs from 'fs';
import { db, searchLog } from '../db/index.ts';
import { handleSimilar } from '../server/handlers.ts';
import { handleContext } from '../server/context.ts';
import { handleRead } from '../tools/read.ts';
import { getGuestAllowlist } from '../server/rbac.ts';
import type { Role } from '../server/rbac.ts';
import { getVaultPsiRoot } from '../vault/handler.ts';
import type { ToolContext } from '../tools/types.ts';

// Endpoint catalog — shared by /api/help and 404 handler
export const HELP_ENDPOINTS = [
    // Auth
    { method: 'GET', path: '/api/auth/status', desc: 'Check if session is authenticated', params: null },
    { method: 'POST', path: '/api/auth/login', desc: 'Login with password', params: 'body: { password }' },
    { method: 'POST', path: '/api/auth/logout', desc: 'Logout current session', params: null },
    // Health
    { method: 'GET', path: '/api/health', desc: 'Server health check', params: null },
    { method: 'GET', path: '/api/help', desc: 'This endpoint catalog', params: '?q=filter' },
    // Threads (forum)
    { method: 'GET', path: '/api/threads', desc: 'List all forum threads', params: '?status=&category=&limit=50&offset=0' },
    { method: 'POST', path: '/api/thread', desc: 'Create thread or post message', params: 'body: { message, author, thread_id?, title?, reply_to_id?, visibility? }' },
    { method: 'GET', path: '/api/thread/:id', desc: 'Get thread messages', params: '?limit=50&offset=0' },
    { method: 'PATCH', path: '/api/thread/:id/category', desc: 'Update thread category', params: 'body: { category, beast }' },
    { method: 'PATCH', path: '/api/thread/:id/lock', desc: 'Lock/unlock thread', params: 'body: { locked, beast }' },
    { method: 'PATCH', path: '/api/thread/:id/archive', desc: 'Archive/unarchive thread', params: 'body: { archived, beast }' },
    { method: 'PATCH', path: '/api/thread/:id/pin', desc: 'Pin/unpin thread', params: 'body: { pinned, beast }' },
    { method: 'PATCH', path: '/api/thread/:id/title', desc: 'Rename thread title', params: 'body: { title, beast }' },
    { method: 'PATCH', path: '/api/thread/:id/status', desc: 'Update thread status', params: 'body: { status, beast }' },
    { method: 'PATCH', path: '/api/thread/:id/visibility', desc: 'Update thread visibility', params: 'body: { visibility, beast }' },
    { method: 'DELETE', path: '/api/thread/:id', desc: 'Delete thread', params: 'body: { beast }' },
    // Forum utilities
    { method: 'POST', path: '/api/forum/read', desc: 'Mark thread as read', params: 'body: { beast, threadId, messageId }' },
    { method: 'GET', path: '/api/forum/unread/:beast', desc: 'Get unread thread counts', params: null },
    { method: 'GET', path: '/api/forum/mentions/:beast', desc: 'Get @mentions for a beast', params: '?limit=30' },
    { method: 'GET', path: '/api/forum/search', desc: 'Search forum messages', params: '?q=query&limit=20' },
    { method: 'GET', path: '/api/forum/activity', desc: 'Recent forum activity feed', params: '?limit=50' },
    { method: 'POST', path: '/api/forum/mute', desc: 'Mute/unmute thread notifications', params: 'body: { beast, threadId, muted }' },
    { method: 'GET', path: '/api/forum/muted/:beast', desc: 'Get muted threads', params: null },
    { method: 'GET', path: '/api/forum/link-preview', desc: 'Get link preview metadata', params: '?url=' },
    // Messages
    { method: 'PATCH', path: '/api/message/:id', desc: 'Edit a message', params: 'body: { content, beast }' },
    { method: 'GET', path: '/api/message/:id/history', desc: 'Get message edit history', params: null },
    { method: 'POST', path: '/api/message/:id/react', desc: 'Add reaction to message', params: 'body: { beast, emoji }' },
    { method: 'DELETE', path: '/api/message/:id/react', desc: 'Remove reaction', params: 'body: { beast, emoji }' },
    { method: 'GET', path: '/api/message/:id/reactions', desc: 'Get message reactions', params: null },
    { method: 'GET', path: '/api/message/:id/attachments', desc: 'Get message file attachments', params: null },
    // Emojis
    { method: 'GET', path: '/api/forum/emojis', desc: 'List custom emojis', params: null },
    { method: 'POST', path: '/api/forum/emojis', desc: 'Add custom emoji', params: 'body: { emoji, name, category? }' },
    { method: 'DELETE', path: '/api/forum/emojis/:emoji', desc: 'Remove custom emoji', params: null },
    { method: 'GET', path: '/api/reactions/supported', desc: 'List all supported reactions', params: null },
    // DMs
    { method: 'GET', path: '/api/dm/:name', desc: 'List DM conversations for a beast', params: null },
    { method: 'GET', path: '/api/dm/:name/:other', desc: 'Get DM conversation between two beasts', params: '?limit=30&offset=0&order=desc' },
    { method: 'POST', path: '/api/dm', desc: 'Send a DM', params: 'body: { from, to, message }' },
    { method: 'PATCH', path: '/api/dm/:name/:other/read', desc: 'Mark DM conversation as read', params: null },
    { method: 'PATCH', path: '/api/dm/:name/:other/read-all', desc: 'Mark all DMs as read', params: null },
    { method: 'DELETE', path: '/api/dm/messages/:id', desc: 'Delete a DM message', params: null },
    { method: 'GET', path: '/api/dm/dashboard', desc: 'DM dashboard stats', params: null },
    { method: 'GET', path: '/api/dm/unread-count', desc: 'Get unread DM count', params: null },
    // Tasks (PM Board)
    { method: 'GET', path: '/api/tasks', desc: 'List tasks (Spec #56: parent_id filter)', params: '?assignee=&reviewer=&status=&parent_id=&limit=100&offset=0&include_deleted=true' },
    { method: 'GET', path: '/api/tasks/:id', desc: 'Get task by ID (includes subtasks summary if parent)', params: null },
    { method: 'GET', path: '/api/tasks/:id/subtree', desc: 'Get parent task + all direct subtasks (Spec #56)', params: null },
    { method: 'POST', path: '/api/tasks', desc: 'Create task (Spec #56: parent_task_id for subtasks)', params: 'body: { title, assigned_to, reviewer, project_id, description?, status?, parent_task_id? }' },
    { method: 'PATCH', path: '/api/tasks/:id', desc: 'Update task (Spec #56: parent_task_id for reparent)', params: 'body: { title?, description?, assignee?, reviewer?, status?, parent_task_id? }' },
    { method: 'DELETE', path: '/api/tasks/:id', desc: 'Delete task (orphans subtasks via SET NULL)', params: null },
    { method: 'POST', path: '/api/tasks/:id/comments', desc: 'Add comment to task', params: 'body: { author, content }' },
    { method: 'GET', path: '/api/tasks/:id/comments', desc: 'Get task comments', params: null },
    // Pack / Beasts
    { method: 'GET', path: '/api/pack', desc: 'Get all beast profiles with status', params: null },
    { method: 'GET', path: '/api/beasts', desc: 'List all beast profiles', params: null },
    { method: 'GET', path: '/api/beast/:name', desc: 'Get single beast profile', params: null },
    { method: 'PUT', path: '/api/beast/:name', desc: 'Create/replace beast profile', params: 'body: { species, role, bio?, themeColor? }' },
    { method: 'PATCH', path: '/api/beast/:name', desc: 'Update beast profile fields', params: 'body: { bio?, role?, themeColor?, ... }' },
    { method: 'PATCH', path: '/api/beast/:name/avatar', desc: 'Upload beast avatar', params: 'body: FormData with avatar file' },
    { method: 'GET', path: '/api/beast/:name/terminal', desc: 'Get beast tmux terminal output', params: null },
    { method: 'POST', path: '/api/beast/:name/terminal/input', desc: 'Send text to beast terminal', params: 'body: { input }' },
    { method: 'POST', path: '/api/beast/:name/terminal/key', desc: 'Send key event to beast terminal', params: 'body: { key }' },
    // Schedules
    { method: 'GET', path: '/api/schedules', desc: 'List schedules', params: '?beast=&enabled=' },
    { method: 'GET', path: '/api/schedules/due', desc: 'Get due schedules', params: '?beast=' },
    { method: 'POST', path: '/api/schedules', desc: 'Create schedule', params: 'body: { beast, task, command, interval, ... }' },
    { method: 'PATCH', path: '/api/schedules/:id', desc: 'Update schedule', params: 'body: { task?, command?, interval?, enabled? }' },
    { method: 'PATCH', path: '/api/schedules/:id/run', desc: 'Mark schedule as run', params: '?as=beast' },
    { method: 'DELETE', path: '/api/schedules/:id', desc: 'Delete schedule', params: '?as=beast' },
    // Upload
    { method: 'POST', path: '/api/upload', desc: 'Upload file attachment', params: 'body: FormData with file' },
    { method: 'GET', path: '/api/forum/file/:filename', desc: 'Get uploaded file', params: null },
    { method: 'GET', path: '/api/files', desc: 'List all uploaded files', params: '?limit=50&offset=0' },
    { method: 'GET', path: '/api/files/stats', desc: 'File storage statistics', params: null },
    { method: 'GET', path: '/api/files/:id', desc: 'Get file metadata', params: null },
    { method: 'GET', path: '/api/files/:id/download', desc: 'Download file by ID (owner/beast)', params: null },
    { method: 'GET', path: '/api/f/:hash', desc: 'Download file by hash (public, unguessable)', params: null },
    { method: 'DELETE', path: '/api/files/:id', desc: 'Delete file', params: null },
    // Specs (SDD)
    { method: 'GET', path: '/api/specs', desc: 'List all specs', params: '?status=&author=' },
    { method: 'GET', path: '/api/specs/:id', desc: 'Get spec by ID', params: null },
    { method: 'GET', path: '/api/specs/:id/content', desc: 'Get spec markdown content (Spec #57: ?version=vN for historical)', params: '?version=v1' },
    { method: 'GET', path: '/api/specs/:id/versions', desc: 'List spec version snapshots (Spec #57)', params: null },
    { method: 'GET', path: '/api/specs/:id/history', desc: 'Get spec review history', params: null },
    { method: 'GET', path: '/api/specs/:id/diff', desc: 'Get spec version diff', params: '?v1=&v2=' },
    { method: 'POST', path: '/api/specs', desc: 'Submit new spec', params: 'body: { title, content, author, task_ids?, thread_ids? }' },
    { method: 'POST', path: '/api/specs/:id/review', desc: 'Review a spec', params: 'body: { reviewer, action, comment? }' },
    { method: 'POST', path: '/api/specs/:id/resubmit', desc: 'Resubmit spec with changes', params: 'body: { content, author, change_summary? }' },
    { method: 'POST', path: '/api/specs/:id/reopen', desc: 'Reopen approved spec for amendment (Spec #57)', params: 'body: { author, reason }' },
    { method: 'DELETE', path: '/api/specs/:id', desc: 'Delete spec', params: 'body: { beast }' },
    { method: 'GET', path: '/api/specs/:id/links', desc: 'Get linked tasks/threads', params: null },
    { method: 'POST', path: '/api/specs/:id/link', desc: 'Link task or thread to spec', params: 'body: { type, target_id }' },
    { method: 'DELETE', path: '/api/specs/:id/link', desc: 'Unlink task or thread', params: 'body: { type, target_id }' },
    { method: 'GET', path: '/api/specs/:id/comments', desc: 'Get spec comments', params: null },
    { method: 'POST', path: '/api/specs/:id/comments', desc: 'Add spec comment', params: 'body: { author, content, type? }' },
    // Rules
    { method: 'GET', path: '/api/rules', desc: 'List all active rules', params: null },
    { method: 'GET', path: '/api/rules/decrees', desc: 'List decrees only', params: null },
    { method: 'GET', path: '/api/rules/norms', desc: 'List norms only', params: null },
    { method: 'GET', path: '/api/rules/markdown', desc: 'All rules as markdown (for /recap)', params: null },
    { method: 'GET', path: '/api/rules/pending', desc: 'List rules pending approval', params: null },
    { method: 'GET', path: '/api/rules/:id', desc: 'Get rule by ID', params: null },
    { method: 'POST', path: '/api/rules', desc: 'Propose new rule', params: 'body: { title, content, type, proposed_by }' },
    { method: 'PATCH', path: '/api/rules/:id', desc: 'Update rule', params: 'body: { title?, content?, type? }' },
    { method: 'PATCH', path: '/api/rules/:id/archive', desc: 'Archive rule', params: 'body: { beast }' },
    { method: 'POST', path: '/api/rules/:id/approve', desc: 'Approve pending rule', params: 'body: { beast }' },
    { method: 'POST', path: '/api/rules/:id/reject', desc: 'Reject pending rule', params: 'body: { beast, reason? }' },
    // Risks
    { method: 'GET', path: '/api/risks', desc: 'List all risks', params: '?status=&severity=' },
    { method: 'GET', path: '/api/risks/summary', desc: 'Risk summary stats', params: null },
    { method: 'GET', path: '/api/risks/stale', desc: 'Risks not updated recently', params: null },
    { method: 'GET', path: '/api/risks/:id', desc: 'Get risk by ID', params: null },
    { method: 'POST', path: '/api/risks', desc: 'Create risk', params: 'body: { title, description, severity, status, owner }' },
    { method: 'PATCH', path: '/api/risks/:id', desc: 'Update risk', params: 'body: { title?, severity?, status?, mitigation? }' },
    { method: 'DELETE', path: '/api/risks/:id', desc: 'Delete risk', params: null },
    // Prowl (Gorn tasks)
    { method: 'GET', path: '/api/prowl', desc: 'List Gorn personal tasks', params: '?status=&category=&priority=' },
    { method: 'GET', path: '/api/prowl/categories', desc: 'List Prowl categories', params: null },
    { method: 'POST', path: '/api/prowl', desc: 'Create Prowl task', params: 'body: { title, due_date? (YYYY-MM-DD or YYYY-MM-DDTHH:MM), category?, priority?, source? }' },
    { method: 'PATCH', path: '/api/prowl/:id', desc: 'Update Prowl task', params: 'body: { title?, due_date? (YYYY-MM-DD or YYYY-MM-DDTHH:MM), category?, priority?, notes? }' },
    { method: 'PATCH', path: '/api/prowl/:id/status', desc: 'Update Prowl task status', params: 'body: { status }' },
    { method: 'POST', path: '/api/prowl/:id/toggle', desc: 'Toggle Prowl task done/undone', params: null },
    { method: 'DELETE', path: '/api/prowl/:id', desc: 'Delete Prowl task', params: null },
    { method: 'GET', path: '/api/prowl/:id/checklist', desc: 'List checklist items for a Prowl task', params: null },
    { method: 'POST', path: '/api/prowl/:id/checklist', desc: 'Add checklist item', params: 'body: { text }' },
    { method: 'PATCH', path: '/api/prowl/:id/checklist/:itemId', desc: 'Update checklist item', params: 'body: { text?, checked?, sort_order? }' },
    { method: 'POST', path: '/api/prowl/:id/checklist/:itemId/toggle', desc: 'Toggle checklist item checked', params: null },
    { method: 'DELETE', path: '/api/prowl/:id/checklist/:itemId', desc: 'Delete checklist item', params: null },
    { method: 'POST', path: '/api/prowl/notify-test', desc: 'Test Prowl notification pipeline (Gorn-only)', params: null },
    // Telegram
    { method: 'GET', path: '/api/telegram/status', desc: 'Telegram polling status (owner only)', params: null },
    { method: 'GET', path: '/api/telegram/message/:id', desc: 'T#712 — cached inbound TG message by id (Gorn + Sable only)', params: null },
    // Routine (Forge)
    { method: 'GET', path: '/api/routine/logs', desc: 'List routine logs', params: '?type=&date=&limit=20&offset=0' },
    { method: 'GET', path: '/api/routine/today', desc: 'Today routine summary', params: null },
    { method: 'GET', path: '/api/routine/weight', desc: 'Weight history', params: '?limit=30' },
    { method: 'GET', path: '/api/routine/blood-pressure', desc: 'BP history (Prowl #80)', params: '?range=week,month,year,3y,10y,all' },
    { method: 'GET', path: '/api/routine/exercise-summary', desc: 'Single-exercise 4-dimension read: peak/recent/trend/frequency (Prowl #83)', params: '?exercise=<name>' },
    { method: 'GET', path: '/api/routine/prs', desc: 'All-exercises peak summary, alias for /personal-records?grouped=true (Prowl #83)', params: '?range=month' },
    { method: 'GET', path: '/api/routine/body-composition', desc: 'Body composition history from Withings', params: '?range=month (1w,1m,3m,1y,3y,all)' },
    { method: 'GET', path: '/api/routine/stats', desc: 'Routine statistics', params: null },
    { method: 'GET', path: '/api/routine/summary', desc: 'Routine summary with trends', params: null },
    { method: 'GET', path: '/api/routine/exercises', desc: 'List exercises', params: null },
    { method: 'POST', path: '/api/routine/exercises', desc: 'Add exercise', params: 'body: { name, equipment?, muscle_group? }' },
    { method: 'GET', path: '/api/routine/personal-records', desc: 'Personal records', params: null },
    { method: 'POST', path: '/api/routine/logs', desc: 'Create routine log (workout: exercises[].notes optional str, exercises[].sets[].rpe optional 1-10 per T#710)', params: 'body: { type, logged_at, data: { exercises?: [{name, notes?, sets: [{weight, reps, rpe?, unit?}]}], items?: [...meal], ... } }' },
    { method: 'PATCH', path: '/api/routine/logs/:id', desc: 'Update routine log', params: 'body: { ... }' },
    { method: 'DELETE', path: '/api/routine/logs/:id', desc: 'Soft-delete routine log', params: null },
    { method: 'PATCH', path: '/api/routine/logs/:id/restore', desc: 'Restore deleted log', params: null },
    // OAuth
    { method: 'GET', path: '/api/oauth/withings/authorize', desc: 'Start Withings OAuth flow', params: null },
    { method: 'GET', path: '/api/oauth/withings/callback', desc: 'OAuth callback (internal)', params: null },
    { method: 'GET', path: '/api/oauth/withings/status', desc: 'Check Withings connection status', params: null },
    { method: 'DELETE', path: '/api/oauth/withings/disconnect', desc: 'Disconnect Withings', params: null },
    { method: 'GET', path: '/api/withings/devices', desc: 'List Withings devices', params: null },
    // Google OAuth + Gmail
    { method: 'GET', path: '/api/oauth/google/authorize', desc: 'Start Google OAuth flow', params: null },
    { method: 'GET', path: '/api/oauth/google/callback', desc: 'Google OAuth callback (internal)', params: null },
    { method: 'GET', path: '/api/oauth/google/status', desc: 'Check Google connection status', params: null },
    { method: 'DELETE', path: '/api/oauth/google/disconnect', desc: 'Disconnect Google', params: null },
    { method: 'GET', path: '/api/google/gmail/profile', desc: 'Get Gmail profile info', params: null },
    { method: 'GET', path: '/api/google/gmail/labels', desc: 'List Gmail labels', params: null },
    { method: 'GET', path: '/api/google/gmail/messages', desc: 'List Gmail messages', params: '?label=INBOX&maxResults=20&q=search&pageToken=' },
    { method: 'GET', path: '/api/google/gmail/messages/:id', desc: 'Get Gmail message by ID', params: null },
    { method: 'GET', path: '/api/google/gmail/threads/:id', desc: 'Get Gmail thread by ID', params: null },
    // Google Access Control
    { method: 'GET', path: '/api/google/access', desc: 'List Google OAuth Beast allowlist', params: null },
    { method: 'POST', path: '/api/google/access', desc: 'Add Beast to Google OAuth allowlist', params: 'body: { beast }' },
    { method: 'DELETE', path: '/api/google/access/:beast', desc: 'Remove Beast from Google OAuth allowlist', params: null },
    { method: 'GET', path: '/api/google/audit', desc: 'Google OAuth audit log', params: null },
    // Search
    { method: 'GET', path: '/api/search', desc: 'Search documents and knowledge', params: '?q=query&type=all&limit=10' },
    { method: 'GET', path: '/api/search/status', desc: 'Search index status', params: null },
    { method: 'POST', path: '/api/search/reindex', desc: 'Trigger search reindex', params: null },
    // Remote
    { method: 'GET', path: '/api/remote/status', desc: 'Remote panel connection status', params: null },
    { method: 'POST', path: '/api/remote/attach', desc: 'Attach to beast for remote control', params: 'body: { beast }' },
    { method: 'POST', path: '/api/remote/detach', desc: 'Detach from remote control', params: null },
    // Queue (Gorn)
    { method: 'GET', path: '/api/queue/gorn', desc: 'Get Gorn review queue', params: null },
    { method: 'POST', path: '/api/queue/gorn', desc: 'Add thread to Gorn queue', params: 'body: { threadId, reason, addedBy }' },
    { method: 'PATCH', path: '/api/queue/gorn/:threadId', desc: 'Update queue item status', params: 'body: { status }' },
    // Dashboard
    { method: 'GET', path: '/api/dashboard', desc: 'Dashboard summary', params: null },
    { method: 'GET', path: '/api/dashboard/summary', desc: 'Dashboard summary (alt)', params: null },
    { method: 'GET', path: '/api/dashboard/activity', desc: 'Activity stats', params: null },
    { method: 'GET', path: '/api/dashboard/growth', desc: 'Growth metrics', params: null },
    { method: 'GET', path: '/api/session/stats', desc: 'Session statistics', params: null },
    // Library
    { method: 'GET', path: '/api/library', desc: 'List library entries', params: '?shelf=&limit=50' },
    { method: 'GET', path: '/api/library/:id', desc: 'Get library entry by ID', params: null },
    { method: 'POST', path: '/api/library', desc: 'Add library entry', params: 'body: { title, content, shelf?, author }' },
    { method: 'PATCH', path: '/api/library/:id', desc: 'Update library entry', params: 'body: { title?, content?, shelf? }' },
    { method: 'DELETE', path: '/api/library/:id', desc: 'Delete library entry', params: null },
    { method: 'GET', path: '/api/library/search', desc: 'Search library entries', params: '?q=query' },
    { method: 'GET', path: '/api/library/types', desc: 'List library entry types', params: null },
    { method: 'GET', path: '/api/library/shelves', desc: 'List library shelves', params: null },
    { method: 'GET', path: '/api/library/shelves/:id', desc: 'Get shelf by ID', params: null },
    { method: 'POST', path: '/api/library/shelves', desc: 'Create shelf', params: 'body: { name, description? }' },
    { method: 'PATCH', path: '/api/library/shelves/:id', desc: 'Update shelf', params: 'body: { name?, description? }' },
    { method: 'DELETE', path: '/api/library/shelves/:id', desc: 'Delete shelf', params: null },
    // Handoffs
    { method: 'POST', path: '/api/handoff', desc: 'Submit session handoff', params: 'body: { oracle, summary, ... }' },
    { method: 'GET', path: '/api/inbox', desc: 'Get inbox items', params: '?type=&limit=20' },
    // Auth Tokens
    { method: 'GET', path: '/api/auth/tokens', desc: 'List API tokens', params: null },
    { method: 'POST', path: '/api/auth/tokens', desc: 'Create API token', params: 'body: { name }' },
    { method: 'DELETE', path: '/api/auth/tokens/:id', desc: 'Delete API token', params: null },
    { method: 'POST', path: '/api/auth/tokens/rotate', desc: 'Rotate API token (owner-driven)', params: null },
    { method: 'POST', path: '/api/auth/rotate', desc: 'Beast-self chain-aware rotation (Spec #52)', params: 'header: Authorization: Bearer <current_token>' },
    { method: 'GET', path: '/api/auth/me', desc: 'Beast-self token info — expires_at, refresh_window, self_rotate_door, rotated_at (Spec #51 Phase 3)', params: 'header: Authorization: Bearer <current_token>' },
    // Guests
    { method: 'GET', path: '/api/guests', desc: 'List guests', params: null },
    { method: 'GET', path: '/api/guests/:id', desc: 'Get guest by ID', params: null },
    { method: 'POST', path: '/api/guests', desc: 'Create guest account', params: 'body: { username, display_name, password }' },
    { method: 'PATCH', path: '/api/guests/:id', desc: 'Update guest', params: 'body: { display_name?, ... }' },
    { method: 'PATCH', path: '/api/guests/:id/password', desc: 'Change guest password', params: 'body: { password }' },
    { method: 'DELETE', path: '/api/guests/:id', desc: 'Delete guest', params: null },
    { method: 'POST', path: '/api/guests/:id/ban', desc: 'Ban guest', params: null },
    { method: 'POST', path: '/api/guests/:id/unban', desc: 'Unban guest', params: null },
    // Guest-facing endpoints
    { method: 'GET', path: '/api/guest/threads', desc: 'List public threads (guest view)', params: null },
    { method: 'GET', path: '/api/guest/thread/:id', desc: 'Get thread (guest view)', params: null },
    { method: 'POST', path: '/api/guest/thread', desc: 'Create thread (guest)', params: 'body: { message, title }' },
    { method: 'POST', path: '/api/guest/thread/:id/message', desc: 'Post message to thread (guest)', params: 'body: { message }' },
    { method: 'GET', path: '/api/guest/dm/:from/:to', desc: 'Get DM conversation (guest view)', params: null },
    { method: 'POST', path: '/api/guest/dm', desc: 'Send DM (guest)', params: 'body: { to, message }' },
    { method: 'GET', path: '/api/guest/pack', desc: 'Get pack profiles (guest view)', params: null },
    { method: 'GET', path: '/api/guest/profile', desc: 'Get own guest profile', params: null },
    { method: 'PATCH', path: '/api/guest/profile', desc: 'Update own guest profile', params: 'body: { display_name?, bio? }' },
    { method: 'POST', path: '/api/guest/avatar', desc: 'Upload guest avatar', params: 'body: FormData with file' },
    { method: 'POST', path: '/api/guest/change-password', desc: 'Change guest password (self)', params: 'body: { old_password, new_password }' },
    { method: 'POST', path: '/api/guest/reset-password', desc: 'Reset guest password', params: 'body: { username }' },
    { method: 'GET', path: '/api/guest/dashboard', desc: 'Guest dashboard', params: null },
    // Projects
    { method: 'GET', path: '/api/projects', desc: 'List projects', params: null },
    { method: 'GET', path: '/api/projects/:id', desc: 'Get project by ID', params: null },
    { method: 'POST', path: '/api/projects', desc: 'Create project', params: 'body: { name, description? }' },
    { method: 'PATCH', path: '/api/projects/:id', desc: 'Update project', params: 'body: { name?, description? }' },
    { method: 'DELETE', path: '/api/projects/:id', desc: 'Delete project', params: null },
    // Teams
    { method: 'GET', path: '/api/teams', desc: 'List teams', params: null },
    { method: 'GET', path: '/api/teams/:id', desc: 'Get team by ID', params: null },
    { method: 'POST', path: '/api/teams', desc: 'Create team', params: 'body: { name, ... }' },
    { method: 'PATCH', path: '/api/teams/:id', desc: 'Update team', params: 'body: { name?, ... }' },
    { method: 'DELETE', path: '/api/teams/:id', desc: 'Delete team', params: null },
    { method: 'POST', path: '/api/teams/:id/members', desc: 'Add member to team', params: 'body: { beast }' },
    { method: 'DELETE', path: '/api/teams/:id/members/:beast', desc: 'Remove member from team', params: null },
    { method: 'POST', path: '/api/teams/:id/projects', desc: 'Link project to team', params: 'body: { projectId }' },
    { method: 'DELETE', path: '/api/teams/:id/projects/:projectId', desc: 'Unlink project from team', params: null },
    { method: 'GET', path: '/api/teams/beast/:beast', desc: 'Get teams for a beast', params: null },
    // Security
    { method: 'GET', path: '/api/security/events', desc: 'Security event log', params: '?limit=50' },
    { method: 'GET', path: '/api/security/events/stats', desc: 'Security event stats', params: null },
    { method: 'GET', path: '/api/audit', desc: 'Audit log', params: '?limit=50' },
    { method: 'GET', path: '/api/audit/stats', desc: 'Audit stats', params: null },
    // Scheduler (additional)
    { method: 'GET', path: '/api/schedules/:id', desc: 'Get schedule by ID', params: null },
    { method: 'POST', path: '/api/schedules/:id/execute', desc: 'Execute schedule now', params: null },
    { method: 'PATCH', path: '/api/schedules/:id/trigger', desc: 'Trigger schedule', params: null },
    { method: 'GET', path: '/api/scheduler/health', desc: 'Scheduler health check', params: null },
    // Tasks (additional)
    { method: 'POST', path: '/api/tasks/bulk-status', desc: 'Bulk update task status', params: 'body: { ids, status }' },
    // Specs (additional)
    { method: 'GET', path: '/api/specs/by-task/:taskId', desc: 'Get specs linked to a task', params: null },
    { method: 'GET', path: '/api/specs/by-thread/:threadId', desc: 'Get specs linked to a thread', params: null },
    { method: 'GET', path: '/api/spec-comments/:commentId', desc: 'Get spec comment by ID', params: null },
    // Risks (additional)
    { method: 'GET', path: '/api/risks/:id/comments', desc: 'Get risk comments', params: null },
    { method: 'POST', path: '/api/risks/:id/comments', desc: 'Add risk comment', params: 'body: { author, content }' },
    // Messages (additional)
    { method: 'DELETE', path: '/api/message/:id', desc: 'Delete message', params: 'body: { beast }' },
    // Forum (additional)
    { method: 'POST', path: '/api/forum/subscribe', desc: 'Subscribe to thread', params: 'body: { beast, threadId }' },
    { method: 'GET', path: '/api/forum/subscriptions/:beast', desc: 'Get thread subscriptions', params: null },
    { method: 'GET', path: '/api/thread/:id/subscribers', desc: 'Get thread subscribers', params: null },
    // Files (additional)
    { method: 'GET', path: '/api/files/archive/stats', desc: 'File archive stats', params: null },
    { method: 'POST', path: '/api/files/archive/run', desc: 'Run file archival', params: null },
    { method: 'POST', path: '/api/files/:id/restore', desc: 'Restore archived file', params: null },
    // Routine (additional)
    { method: 'GET', path: '/api/routine/workout-trends', desc: 'Workout trend data', params: null },
    { method: 'GET', path: '/api/routine/photos', desc: 'List routine photos', params: null },
    { method: 'POST', path: '/api/routine/photo/upload', desc: 'Upload routine photo', params: 'body: FormData with file' },
    { method: 'GET', path: '/api/routine/photo/:filename', desc: 'Get routine photo', params: null },
    { method: 'GET', path: '/api/routine/logs/deleted', desc: 'List deleted routine logs', params: null },
    // Supersede (document versioning)
    { method: 'GET', path: '/api/supersede', desc: 'List supersede records', params: null },
    { method: 'POST', path: '/api/supersede', desc: 'Create supersede record', params: 'body: { path, content, author }' },
    { method: 'GET', path: '/api/supersede/chain/:path', desc: 'Get supersede chain for path', params: null },
    // Traces
    { method: 'GET', path: '/api/traces', desc: 'List traces', params: null },
    { method: 'GET', path: '/api/traces/:id', desc: 'Get trace by ID', params: null },
    { method: 'GET', path: '/api/traces/:id/chain', desc: 'Get trace chain', params: null },
    { method: 'GET', path: '/api/traces/:id/linked-chain', desc: 'Get linked trace chain', params: null },
    { method: 'POST', path: '/api/traces/:prevId/link', desc: 'Link traces', params: null },
    { method: 'DELETE', path: '/api/traces/:id/link', desc: 'Unlink trace', params: null },
    // Settings
    { method: 'GET', path: '/api/settings', desc: 'Get app settings', params: null },
    { method: 'POST', path: '/api/settings', desc: 'Update app settings', params: 'body: { ... }' },
    // Database
    { method: 'GET', path: '/api/db/stats', desc: 'Database statistics', params: null },
    { method: 'POST', path: '/api/db/maintenance', desc: 'Run database maintenance', params: null },
    // Withings (additional)
    { method: 'POST', path: '/api/oauth/withings/sync', desc: 'Sync Withings data', params: null },
    { method: 'POST', path: '/api/webhooks/withings', desc: 'Withings webhook callback', params: null },
    { method: 'POST', path: '/api/webhooks/hevy', desc: 'Hevy webhook callback (T#724) — workout creation push', params: 'body: { workoutId } | header: Authorization: <HEVY_WEBHOOK_TOKEN> (raw, no Bearer prefix)' },
    // Telegram
    { method: 'GET', path: '/api/telegram/status', desc: 'Telegram polling status (owner only)', params: null },
    { method: 'GET', path: '/api/telegram/message/:id', desc: 'T#712 — cached inbound TG message by id (Gorn + Sable only)', params: null },
    // Board / Pack
    { method: 'GET', path: '/api/board', desc: 'Board overview (tasks summary)', params: null },
    { method: 'GET', path: '/api/pack/spinner-verbs', desc: 'Pack spinner verb list', params: null },
    // Knowledge / Docs
    { method: 'GET', path: '/api/docs', desc: 'List knowledge documents', params: null },
    { method: 'GET', path: '/api/doc/:id', desc: 'Get document by ID', params: null },
    { method: 'GET', path: '/api/feed', desc: 'Activity feed', params: null },
    { method: 'POST', path: '/api/learn', desc: 'Submit learn request', params: 'body: { ... }' },
    { method: 'GET', path: '/api/oracles', desc: 'List oracles', params: null },
    // Internal/legacy (included for 404 hint completeness)
    { method: 'GET', path: '/api/stats', desc: 'Server stats', params: null },
    { method: 'GET', path: '/api/logs', desc: 'Server logs', params: null },
    { method: 'GET', path: '/api/beast/:name/avatar.svg', desc: 'Get beast avatar SVG', params: null },
];

const FEED_LOG = path.join(process.env.HOME || '/home/nat', '.oracle', 'feed.log');

interface KnowledgeHelpers {
  repoRoot: string;
}

export function registerKnowledgeRoutes(app: OpenAPIHono, sqlite: Database, helpers: KnowledgeHelpers) {
  const { repoRoot: REPO_ROOT } = helpers;

  // Playbook — serve den-playbook.md
  app.get('/api/playbook', (c) => {
    const playbookPath = path.join(process.env.HOME || '/home/gorn', 'workspace', 'den-playbook.md');
    if (fs.existsSync(playbookPath)) {
      return c.text(fs.readFileSync(playbookPath, 'utf-8'));
    }
    return c.text('# Playbook not found', 404);
  });

  // API Documentation
  app.get('/api/docs', (c) => {
    return c.json({
      name: 'Den Book API',
      version: '0.5.0',
      endpoints: {
        beasts: {
          'GET /api/beasts': { description: 'List all beast profiles', response: '{ beasts: BeastProfile[] }' },
          'GET /api/beast/:name': { description: 'Get a beast profile by name', params: { name: 'lowercase beast name (e.g. karo, gnarl)' }, response: 'BeastProfile' },
          'PUT /api/beast/:name': { description: 'Create or fully update a beast profile', response: 'BeastProfile' },
          'PATCH /api/beast/:name': { description: 'Partial profile update', response: 'BeastProfile' },
          'PATCH /api/beast/:name/avatar': { description: 'Update avatar URL only' },
          'GET /api/beast/:name/avatar.svg': { description: 'Generated SVG avatar based on animal theme', response: 'image/svg+xml' },
          'POST /api/beasts/seed-avatars': { description: 'Seed default SVG avatars' },
        },
        pack: { 'GET /api/pack': { description: 'List all beasts with online/offline status (from tmux)' } },
        forum: { 'GET /api/threads': {}, 'POST /api/thread': {}, 'PATCH /api/thread/:id/status': {} },
        dms: { 'POST /api/dm': {}, 'GET /api/dm/:name': {}, 'GET /api/dm/:name/:other': {}, 'GET /api/dm/dashboard': {} },
        types: {
          BeastProfile: { name: 'string (primary key, lowercase)', display_name: 'string', animal: 'string' },
        },
      },
      note: 'Full machine-readable catalog at /api/help (327 endpoints).',
    });
  });

  // API Help — machine-readable endpoint catalog for Beast self-correction
  app.get('/api/help', (c) => {
    const role = (c.get as any)('role') as Role | undefined;
    const filter = c.req.query('q')?.toLowerCase();

    // Guests see only their allowed endpoints; owner/beast see everything
    let result = HELP_ENDPOINTS;
    if (role === 'guest') {
      const allowlist = getGuestAllowlist();
      result = HELP_ENDPOINTS.filter(e =>
        allowlist.some(a =>
          (a.method === '*' || a.method === e.method) &&
          new RegExp(a.pattern).test(e.path)
        )
      );
    }

    if (filter) {
      result = result.filter(e =>
        e.path.toLowerCase().includes(filter) ||
        e.desc.toLowerCase().includes(filter) ||
        e.method.toLowerCase().includes(filter)
      );
    }

    return c.json({
      total: result.length,
      hint: 'Use ?q=keyword to filter (e.g. ?q=thread, ?q=dm, ?q=task)',
      endpoints: result,
    });
  });

  // Similar documents (vector nearest neighbors)
  app.get('/api/similar', async (c) => {
    const id = c.req.query('id');
    if (!id) {
      return c.json({ error: 'Missing query parameter: id' }, 400);
    }
    const limit = parseInt(c.req.query('limit') || '5');
    const model = c.req.query('model');
    try {
      const result = await handleSimilar(id, limit, model);
      return c.json(result);
    } catch (e: any) {
      return c.json({ error: e.message, results: [], docId: id }, 500);
    }
  });

  // Live Oracle feed
  app.get('/api/feed', (c) => {
    try {
      const limit = Math.min(200, parseInt(c.req.query('limit') || '50'));
      const type = c.req.query('type') || undefined;
      const since = c.req.query('since') || undefined;

      const events: any[] = [];

      const forumQuery = since
        ? 'SELECT m.id, m.content, m.author, m.created_at, t.title as thread_title, t.id as thread_id FROM forum_messages m JOIN forum_threads t ON m.thread_id = t.id WHERE m.created_at > ? ORDER BY m.created_at DESC LIMIT ?'
        : 'SELECT m.id, m.content, m.author, m.created_at, t.title as thread_title, t.id as thread_id FROM forum_messages m JOIN forum_threads t ON m.thread_id = t.id ORDER BY m.created_at DESC LIMIT ?';
      const forumParams = since ? [since, limit] : [limit];
      if (!type || type === 'forum') {
        const posts = sqlite.prepare(forumQuery).all(...forumParams) as any[];
        for (const p of posts) {
          events.push({
            type: 'forum', id: p.id, timestamp: p.created_at,
            actor: p.author, title: p.thread_title,
            message: p.content.slice(0, 200),
            url: `/forum?thread=${p.thread_id}`,
          });
        }
      }

      if (!type || type === 'task') {
        const taskQuery = since
          ? 'SELECT t.id, t.title, t.status, t.assigned_to, t.created_by, t.updated_at, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE t.updated_at > ? ORDER BY t.updated_at DESC LIMIT ?'
          : 'SELECT t.id, t.title, t.status, t.assigned_to, t.created_by, t.updated_at, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id ORDER BY t.updated_at DESC LIMIT ?';
        const taskParams = since ? [since, limit] : [limit];
        const tasks = sqlite.prepare(taskQuery).all(...taskParams) as any[];
        for (const t of tasks) {
          events.push({
            type: 'task', id: t.id, timestamp: t.updated_at,
            actor: t.assigned_to || t.created_by, title: `T#${t.id}: ${t.title}`,
            message: `Status: ${t.status}${t.project_name ? ` | ${t.project_name}` : ''}`,
            url: `/board?task=${t.id}`,
          });
        }
      }

      if (!type || type === 'spec') {
        const specQuery = since
          ? 'SELECT id, title, author, status, updated_at FROM spec_reviews WHERE updated_at > ? ORDER BY updated_at DESC LIMIT ?'
          : 'SELECT id, title, author, status, updated_at FROM spec_reviews ORDER BY updated_at DESC LIMIT ?';
        const specParams = since ? [since, limit] : [limit];
        const specs = sqlite.prepare(specQuery).all(...specParams) as any[];
        for (const s of specs) {
          events.push({
            type: 'spec', id: s.id, timestamp: s.updated_at,
            actor: s.author, title: `Spec #${s.id}: ${s.title}`,
            message: `Status: ${s.status}`,
            url: `/specs?spec=${s.id}`,
          });
        }
      }

      events.sort((a, b) => String(b.timestamp || '').localeCompare(String(a.timestamp || '')));
      const total = events.length;
      const sliced = events.slice(0, limit);

      return c.json({ events: sliced, total });
    } catch (e: any) {
      return c.json({ error: e.message, events: [], total: 0 }, 500);
    }
  });

  // Logs
  app.get('/api/logs', (c) => {
    try {
      const limit = parseInt(c.req.query('limit') || '20');
      const logs = db.select({
        query: searchLog.query,
        type: searchLog.type,
        mode: searchLog.mode,
        results_count: searchLog.resultsCount,
        search_time_ms: searchLog.searchTimeMs,
        created_at: searchLog.createdAt,
        project: searchLog.project
      })
        .from(searchLog)
        .orderBy(desc(searchLog.createdAt))
        .limit(limit)
        .all();
      return c.json({ logs, total: logs.length });
    } catch (e) {
      return c.json({ logs: [], error: 'Log table not found' });
    }
  });

  // Get document by ID (uses raw SQL for FTS JOIN)
  app.get('/api/doc/:id', (c) => {
    const docId = c.req.param('id');
    try {
      const row = sqlite.prepare(`
        SELECT d.id, d.type, d.source_file, d.concepts, d.project, f.content
        FROM oracle_documents d
        JOIN oracle_fts f ON d.id = f.id
        WHERE d.id = ?
      `).get(docId) as any;

      if (!row) {
        return c.json({ error: 'Document not found' }, 404);
      }

      return c.json({
        id: row.id,
        type: row.type,
        content: row.content,
        source_file: row.source_file,
        concepts: JSON.parse(row.concepts || '[]'),
        project: row.project
      });
    } catch (e: any) {
      return c.json({ error: e.message }, 500);
    }
  });

  // Context
  app.get('/api/context', (c) => {
    const cwd = c.req.query('cwd');
    return c.json(handleContext(cwd));
  });

  // File - supports cross-repo access via ghq project paths
  app.get('/api/file', async (c) => {
    const filePath = c.req.query('path');
    const project = c.req.query('project');

    if (!filePath) {
      return c.json({ error: 'Missing path parameter' }, 400);
    }

    try {
      let GHQ_ROOT = process.env.GHQ_ROOT;
      if (!GHQ_ROOT) {
        try {
          const proc = Bun.spawnSync(['ghq', 'root']);
          GHQ_ROOT = proc.stdout.toString().trim();
        } catch {
          const match = REPO_ROOT.match(/^(.+?)\/github\.com\//);
          GHQ_ROOT = match ? match[1] : path.dirname(path.dirname(path.dirname(REPO_ROOT)));
        }
      }
      let basePath: string;

      if (project) {
        basePath = path.join(GHQ_ROOT, project);
      } else {
        basePath = REPO_ROOT;
      }

      let resolvedFilePath = filePath;
      if (project && filePath.toLowerCase().startsWith(project.toLowerCase() + '/')) {
        resolvedFilePath = filePath.slice(project.length + 1);
      }

      const fullPath = path.join(basePath, resolvedFilePath);

      let realPath: string;
      try {
        realPath = fs.realpathSync(fullPath);
      } catch {
        realPath = path.resolve(fullPath);
      }

      const realGhqRoot = fs.realpathSync(GHQ_ROOT);
      const realRepoRoot = fs.realpathSync(REPO_ROOT);

      if (!realPath.startsWith(realGhqRoot) && !realPath.startsWith(realRepoRoot)) {
        return c.json({ error: 'Invalid path: outside allowed bounds' }, 400);
      }

      if (fs.existsSync(fullPath)) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        return c.text(content);
      }

      const vault = getVaultPsiRoot();
      if ('path' in vault) {
        const vaultFullPath = path.join(vault.path, filePath);
        if (fs.existsSync(vaultFullPath)) {
          const content = fs.readFileSync(vaultFullPath, 'utf-8');
          return c.text(content);
        }
      }

      return c.text('File not found', 404);
    } catch (e: any) {
      return c.text(e.message, 500);
    }
  });

  // Read document by file path or ID
  app.get('/api/read', async (c) => {
    const file = c.req.query('file');
    const id = c.req.query('id');
    if (!file && !id) {
      return c.json({ error: 'Provide file or id parameter' }, 400);
    }
    const ctx = { db, sqlite, repoRoot: REPO_ROOT } as Pick<ToolContext, 'db' | 'sqlite' | 'repoRoot'>;
    const result = await handleRead(ctx as ToolContext, {
      file: file || undefined,
      id: id || undefined,
    });
    const text = result.content[0]?.text || '{}';
    if (result.isError) {
      return c.json(JSON.parse(text), 404);
    }
    return c.json(JSON.parse(text));
  });
}
