# Denbook AST Map

**Scope**: Full `src/` tree (113 files, 30,980 lines)
**Generated**: 2026-05-19T12:25:00.738Z

| Type | Count |
|------|-------|
| Files | 113 |
| Routes | 299 |
| Functions | 407 |
| Interfaces/Types | 140 |
| Sections | 146 |

## Files by Size

| File | Lines | Routes | Functions |
|------|-------|--------|-----------|
| `src/server.ts` | 1927 | 4 | 20 |
| `src/forge/routes.ts` | 1725 | 27 | 9 |
| `src/server/handlers.ts` | 1321 | 0 | 16 |
| `src/integrations/routes.ts` | 1027 | 20 | 23 |
| `src/forum/routes.ts` | 963 | 34 | 1 |
| `src/indexer.ts` | 892 | 0 | 1 |
| `src/server/beast-tokens.ts` | 757 | 0 | 13 |
| `src/scheduler/routes.ts` | 749 | 14 | 11 |
| `src/specs/routes.ts` | 669 | 19 | 4 |
| `src/knowledge/routes.ts` | 653 | 10 | 1 |
| `src/board/routes.ts` | 636 | 15 | 4 |
| `src/server/routes.ts` | 618 | 14 | 2 |
| `src/guest/routes.ts` | 591 | 13 | 3 |
| `src/trace/handler.ts` | 570 | 0 | 14 |
| `src/forum/responder.ts` | 559 | 0 | 14 |
| `src/server-legacy.ts` | 514 | 0 | 1 |
| `src/chroma-mcp.ts` | 494 | 0 | 1 |
| `src/search/routes.ts` | 494 | 4 | 11 |
| `src/vault/handler.ts` | 492 | 0 | 13 |
| `src/daemons/routes.ts` | 464 | 5 | 7 |
| `src/pack/routes.ts` | 442 | 13 | 1 |
| `src/tools/search.ts` | 442 | 0 | 6 |
| `src/prowl/routes.ts` | 415 | 13 | 1 |
| `src/dm/handler.ts` | 411 | 0 | 10 |
| `src/files/routes.ts` | 380 | 7 | 2 |
| `src/forum/handler.ts` | 380 | 0 | 9 |
| `src/server/guest-accounts.ts` | 362 | 0 | 17 |
| `src/process-manager/ProcessManager.ts` | 361 | 0 | 16 |
| `src/library/routes.ts` | 358 | 12 | 1 |
| `src/db/schema.ts` | 350 | 0 | 0 |
| `src/tools/schedule.ts` | 348 | 0 | 7 |
| `src/telegram/routes.ts` | 330 | 2 | 9 |
| `src/index.ts` | 328 | 0 | 1 |
| `src/vector/adapters/cloudflare-vectorize.ts` | 325 | 0 | 0 |
| `src/dm/routes.ts` | 313 | 8 | 1 |
| `src/forum/mentions.ts` | 304 | 0 | 10 |
| `src/risk/routes.ts` | 299 | 9 | 1 |
| `src/tools/trace.ts` | 298 | 0 | 6 |
| `src/vector/adapters/sqlite-vec.ts` | 269 | 0 | 2 |
| `src/vault/migrate.ts` | 260 | 0 | 5 |
| `src/ensure-server.ts` | 259 | 0 | 8 |
| `src/governance/routes.ts` | 239 | 11 | 2 |
| `src/tools/forum.ts` | 222 | 0 | 4 |
| `src/vector/factory.ts` | 219 | 0 | 5 |
| `src/verify/handler.ts` | 217 | 0 | 2 |
| `src/server/dashboard.ts` | 213 | 0 | 3 |
| `src/server/security-logger.ts` | 206 | 0 | 4 |
| `src/tools/learn.ts` | 201 | 0 | 4 |
| `src/db/index.ts` | 193 | 0 | 10 |
| `src/vector/adapters/qdrant.ts` | 190 | 0 | 0 |
| `src/tools/read.ts` | 181 | 0 | 5 |
| `src/teams/routes.ts` | 178 | 10 | 4 |
| `src/vector/adapters/lancedb.ts` | 175 | 0 | 0 |
| `src/process-manager/HealthMonitor.ts` | 164 | 0 | 6 |
| `src/vault/cli.ts` | 161 | 0 | 1 |
| `src/server/guest-safety.ts` | 158 | 0 | 6 |
| `src/audit/routes.ts` | 157 | 4 | 1 |
| `src/process-manager/GracefulShutdown.ts` | 157 | 0 | 3 |
| `src/forum/types.ts` | 156 | 0 | 2 |
| `src/dashboard/routes.ts` | 144 | 11 | 1 |
| `src/vector/embeddings.ts` | 144 | 0 | 1 |
| `src/trace/types.ts` | 139 | 0 | 0 |
| `src/inbox/routes.ts` | 138 | 3 | 1 |
| `src/types.ts` | 130 | 0 | 0 |
| `src/settings/routes.ts` | 125 | 2 | 1 |
| `src/scripts/index-model.ts` | 123 | 0 | 1 |
| `src/cli/commands/vault.ts` | 116 | 0 | 2 |
| `src/supersede/routes.ts` | 116 | 3 | 1 |
| `src/trace/routes.ts` | 113 | 6 | 1 |
| `src/remote/routes.ts` | 112 | 3 | 1 |
| `src/scripts/index-qwen3.ts` | 111 | 0 | 1 |
| `src/server/logging.ts` | 109 | 0 | 3 |
| `src/server/openapi.ts` | 108 | 0 | 0 |
| `src/tools/types.ts` | 108 | 0 | 0 |
| `src/notify.ts` | 107 | 0 | 2 |
| `src/server/rbac.ts` | 105 | 0 | 3 |
| `src/server/types.ts` | 104 | 0 | 0 |
| `src/scripts/fix-oracle-learn-project.ts` | 103 | 0 | 1 |
| `src/cli/format.ts` | 100 | 0 | 8 |
| `src/tools/index.ts` | 100 | 0 | 0 |
| `src/server/context.ts` | 98 | 0 | 4 |
| `src/tools/list.ts` | 96 | 0 | 1 |
| `src/cli/commands/server.ts` | 87 | 0 | 1 |
| `src/queue/routes.ts` | 84 | 3 | 1 |
| `src/tools/handoff.ts` | 83 | 0 | 1 |
| `src/tools/inbox.ts` | 81 | 0 | 1 |
| `src/tools/stats.ts` | 80 | 0 | 1 |
| `src/cli/index.ts` | 78 | 0 | 0 |
| `src/tools/concepts.ts` | 78 | 0 | 1 |
| `src/tools/supersede.ts` | 78 | 0 | 1 |
| `src/server/utils.ts` | 69 | 0 | 3 |
| `src/cli/commands/schedule.ts` | 65 | 0 | 1 |
| `src/tools/reflect.ts` | 60 | 0 | 1 |
| `src/vector/adapters/chroma-mcp.ts` | 59 | 0 | 0 |
| `src/server/project-detect.ts` | 57 | 0 | 1 |
| `src/tools/verify.ts` | 57 | 0 | 1 |
| `src/process-manager/logger.ts` | 56 | 0 | 4 |
| `src/process-manager/index.ts` | 52 | 0 | 0 |
| `src/vector/types.ts` | 52 | 0 | 0 |
| `src/cli/http.ts` | 45 | 0 | 1 |
| `src/mcp-audit.ts` | 42 | 0 | 2 |
| `src/cli/commands/list.ts` | 38 | 0 | 1 |
| `src/cli/commands/traces.ts` | 37 | 0 | 1 |
| `src/config.ts` | 35 | 0 | 0 |
| `src/cli/commands/learn.ts` | 33 | 0 | 1 |
| `src/cli/commands/threads.ts` | 33 | 0 | 1 |
| `src/cli/commands/search.ts` | 29 | 0 | 1 |
| `src/cli/commands/stats.ts` | 29 | 0 | 1 |
| `src/cli/commands/read.ts` | 28 | 0 | 1 |
| `src/cli/commands/inbox.ts` | 23 | 0 | 1 |
| `src/dm/types.ts` | 23 | 0 | 0 |
| `src/cli/commands/health.ts` | 18 | 0 | 1 |
| `src/vector/adapters/index.ts` | 6 | 0 | 0 |

## Sections


### src/board/routes.ts
- **L6** — Board routes — projects + tasks + task_comments + board summary
- **L24** — PM Board — Projects + Tasks + Task Comments

### src/daemons/routes.ts
- **L13** — Module-level state — captured via initDaemons()
- **L20** — Notification Queue Drain (Spec #29, T#497)
- **L143** — DB Maintenance — audit log retention + VACUUM
- **L283** — initDaemons — server startup entry: capture sqlite + start all daemons once
- **L308** — Routes — 5 daemon-management endpoints

### src/dashboard/routes.ts
- **L5** — Dashboard routes — Phase 2.6 of Library #102 (T#784)

### src/db/index.ts
- **L86** — Default module-level connection (used by server.ts, handlers, etc.)
- **L107** — Beast Profile helpers
- **L175** — Settings helpers

### src/db/schema.ts
- **L90** — Forum Tables (threaded discussions with Oracle)
- **L133** — DM Tables (private one-on-one messaging between Oracles)
- **L164** — Trace Log Tables (discovery tracing with dig points)
- **L223** — Supersede Log (Issue #18) - Audit trail for "Nothing is Deleted"
- **L258** — Activity Log - User activity tracking
- **L278** — Schedule Table - Appointments & events (per-human, shared across Oracles)
- **L298** — Beast Profiles - Pack member identity & avatars
- **L318** — Settings Table - Key-value store for configuration
- **L328** — Security Events (T#545) — Security-specific event logging

### src/dm/handler.ts
- **L14** — Helpers
- **L38** — Conversation Operations
- **L85** — Message Operations

### src/dm/routes.ts
- **L11** — DM routes — Phase 2.2 of Library #102 (T#780)

### src/forge/routes.ts
- **L27** — Forge — Personal Routine Tracker for Gorn (T#372)
- **L47** — Forge — Personal Routine Tracker for Gorn (T#372)

### src/forum/handler.ts
- **L33** — Thread Operations
- **L157** — Message Operations
- **L251** — Main Thread API (MCP Tool Interface)

### src/forum/mentions.ts
- **L12** — Oracle Registry
- **L80** — Mention Parsing
- **L145** — Subscription Management (T#618)
- **L225** — Notification Dispatch

### src/forum/routes.ts
- **L10** — Forum routes — Phase 2.1 of Library #102 (T#779)

### src/forum/types.ts
- **L8** — Thread & Message Types (DB-first)
- **L46** — GitHub URL Utilities
- **L72** — MCP Tool Interfaces
- **L131** — Configuration

### src/index.ts
- **L169** — List available tools
- **L208** — Handle tool calls — route to extracted handlers

### src/integrations/routes.ts
- **L9** — Module-level state for Withings auto-sync daemon
- **L23** — initIntegrations — server startup: capture sqlite + start auto-sync daemon
- **L36** — registerIntegrationsRoutes — Withings OAuth + Google OAuth + Gmail proxy
- **L461** — Google OAuth Integration (T#541, Spec #30)
- **L1022** — Supersede Log Routes (Issue #18, #19)

### src/pack/routes.ts
- **L10** — Pack routes — Phase 2.5 of Library #102 (T#783)

### src/scheduler/routes.ts
- **L11** — Module-level state — captured via initScheduler()
- **L26** — Schedule helpers
- **L131** — Auto-trigger daemon
- **L135** — Scheduler Auto-Trigger Daemon (10s polling)
- **L249** — initScheduler — server startup entry
- **L291** — Routes
- **L308** — Singular /api/schedule API (drizzle ORM via handleScheduleList/Add)
- **L354** — Plural /api/schedules API (sqlite + auto-trigger system)
- **L739** — /api/scheduler/health

### src/search/routes.ts
- **L8** — Module-level search infrastructure state
- **L35** — Meilisearch init + backfill
- **L122** — Search index helpers (cross-domain, exported)
- **L206** — initSearch — server startup entry: meili + FTS5 table + backfill check
- **L257** — Routes

### src/server.ts
- **L310** — Auth Helpers
- **L466** — Auth Middleware (protects /api/* except auth routes)
- **L581** — RBAC Authorization Middleware (Spec #32, T#553)
- **L590** — Audit Logging Middleware (Task #72 — logs all mutating API requests)
- **L711** — Auth — rate-limit infrastructure (route handlers extracted to src/server/routes.ts, T#781)
- **L760** — Settings Routes
- **L767** — API Routes
- **L781** — Dashboard Routes
- **L814** — Pack View Routes (Gather-style Beast overview + live terminal)
- **L995** — Remote Control — tmux Beast switcher
- **L1002** — Beast Profile Routes
- **L1025** — Thread Routes
- **L1067** — Forum activity feed — recent messages across all threads
- **L1133** — Gorn Queue — decisions awaiting Gorn's approval
- **L1176** — DM Routes (private one-on-one messaging)
- **L1209** — Library — searchable knowledge base
- **L1254** — Beast Scheduler — Persistent schedules that survive sleep cycles
- **L1289** — Audit Log table (Task #72 — Bertus design, thread #81)
- **L1340** — Audit Log Query (Task #72 — Gorn-only read access)
- **L1347** — Teams API (Task #81 — Gnarl spec, thread #105)
- **L1373** — Trace Routes - Discovery journey visualization
- **L1386** — Inbox Routes (handoff context between sessions)
- **L1397** — Risk Register (T#316)
- **L1448** — Withings OAuth Integration (T#414, Spec #23)
- **L1559** — Rules — Decree and Norm governance (T#360)
- **L1612** — Prowl — Personal Task Manager for Gorn (T#279)
- **L1676** — OpenAPI Schema + Swagger UI (Spec #55 Phase 1)
- **L1694** — Static Frontend (production build)
- **L1736** — WebSocket — Real-time push updates
- **L1817** — Start Server

### src/server/beast-tokens.ts
- **L22** — Configuration
- **L58** — Table initialization (idempotent)
- **L95** — Prepared statements
- **L166** — HMAC-SHA256 hashing
- **L174** — Token generation
- **L220** — Token validation
- **L433** — Spec #51 Phase 3 — token info exposure (`/api/auth/me`)
- **L488** — Spec #52 — chain-walk forward revocation
- **L519** — Token rotation (atomic: create new + revoke old in transaction)
- **L574** — Spec #52 — Beast-self token rotation primitive
- **L683** — Token revocation
- **L706** — Token listing (Gorn-only, no hashes exposed)
- **L737** — Pruning (called from server.ts maintenance cycle)

### src/server/guest-safety.ts
- **L10** — Injection Pattern Detection
- **L50** — Rate Limiting for Guests
- **L119** — Content Length Limits
- **L137** — Migration: author_role field

### src/server/handlers.ts
- **L831** — 3D Knowledge Map — Real PCA from LanceDB embeddings

### src/server/routes.ts
- **L25** — Server routes — Phase 2.3 of Library #102 (T#781)
- **L49** — /api/auth/* (status, login, logout)
- **L260** — /api/guests/* (8 routes — owner admin)
- **L476** — /api/auth/tokens/* + /api/auth/me + /api/auth/rotate (Beast token + self)

### src/server/security-logger.ts
- **L14** — Types
- **L54** — Table initialization (idempotent — migration also creates this)
- **L78** — Prepared statements (reused for performance)
- **L92** — Core logging function
- **L122** — Alert thresholds (Gnarl: simple checks in logger, no pub/sub)
- **L173** — Request ID generator (for audit_log correlation)
- **L184** — Retention (called from server.ts maintenance cycle)

### src/specs/routes.ts
- **L9** — Specs — Spec Review SDD Workflow (Phase 1.11 of Library #102)
- **L25** — Spec Review — SDD Workflow
- **L574** — Spec Comments (T#332)

### src/tools/forum.ts
- **L18** — Input interfaces
- **L46** — Tool definitions
- **L114** — Handlers

### src/tools/learn.ts
- **L50** — Pure helper functions (exported for testing)
- **L100** — Handler

### src/tools/schedule.ts
- **L114** — Tool definitions
- **L185** — Handlers
- **L297** — Markdown export (auto-syncs DB → schedule.md)

### src/tools/search.ts
- **L64** — Pure helper functions (exported for testing)
- **L306** — Handler

### src/tools/trace.ts
- **L26** — Tool definitions
- **L130** — Handlers

### src/tools/types.ts
- **L28** — Input interfaces (moved from index.ts)

### src/trace/routes.ts
- **L6** — Trace routes — Phase 2.4 of Library #102 (T#782)

### src/vault/handler.ts
- **L21** — Helpers
- **L144** — Git status parser (exported for testing)
- **L171** — Vault path resolution (shared across tools)
- **L197** — Public API
- **L485** — Internal helpers

### src/vault/migrate.ts
- **L20** — Helpers
- **L61** — Core
- **L222** — Exported API
- **L229** — CLI (when run directly)

### src/vector/factory.ts
- **L131** — Model-based registry for dual-index search

## Routes

| Method | Path | File | Lines | Description |
|--------|------|------|-------|-------------|
| GET | `/api/audit` | `src/audit/routes.ts` | 20-57 |  |
| GET | `/api/audit/stats` | `src/audit/routes.ts` | 60-77 | GET /api/audit/stats — summary counts |
| GET | `/api/security/events` | `src/audit/routes.ts` | 80-124 | GET /api/security/events — query security events |
| GET | `/api/security/events/stats` | `src/audit/routes.ts` | 127-155 | GET /api/security/events/stats — summary counts |
| GET | `/api/projects` | `src/board/routes.ts` | 123-136 | GET /api/projects — list projects |
| POST | `/api/projects` | `src/board/routes.ts` | 139-159 | POST /api/projects — create project |
| GET | `/api/projects/:id` | `src/board/routes.ts` | 162-170 | GET /api/projects/:id — get project with task counts |
| PATCH | `/api/projects/:id` | `src/board/routes.ts` | 173-192 | PATCH /api/projects/:id — update project |
| DELETE | `/api/projects/:id` | `src/board/routes.ts` | 195-214 | DELETE /api/projects/:id — delete project (Gorn or Pip) |
| GET | `/api/tasks` | `src/board/routes.ts` | 219-268 | GET /api/tasks — list tasks with filters |
| POST | `/api/tasks` | `src/board/routes.ts` | 271-343 | POST /api/tasks — create task |
| GET | `/api/tasks/:id` | `src/board/routes.ts` | 346-355 | GET /api/tasks/:id — get task with comments |
| PATCH | `/api/tasks/:id` | `src/board/routes.ts` | 358-440 | PATCH /api/tasks/:id — update task |
| DELETE | `/api/tasks/:id` | `src/board/routes.ts` | 443-457 | DELETE /api/tasks/:id — soft delete (set status to 'deleted') + orphan subtasks (Bertus C4) |
| GET | `/api/tasks/:id/subtree` | `src/board/routes.ts` | 460-471 | GET /api/tasks/:id/subtree — parent + all direct subtasks in one call (Spec #56) |
| POST | `/api/tasks/bulk-status` | `src/board/routes.ts` | 474-507 | POST /api/tasks/bulk-status — bulk status update (for PM) |
| GET | `/api/tasks/:id/comments` | `src/board/routes.ts` | 512-516 | GET /api/tasks/:id/comments |
| POST | `/api/tasks/:id/comments` | `src/board/routes.ts` | 519-575 | POST /api/tasks/:id/comments |
| GET | `/api/board` | `src/board/routes.ts` | 580-633 | GET /api/board — grouped by status with project filter |
| POST | `/api/db/maintenance` | `src/daemons/routes.ts` | 333-339 | POST /api/db/maintenance — manual trigger (Gorn-only) |
| GET | `/api/db/stats` | `src/daemons/routes.ts` | 342-365 | GET /api/db/stats — table sizes and DB info |
| GET | `/api/files/archive/stats` | `src/daemons/routes.ts` | 373-412 | GET /api/files/archive/stats — archive statistics |
| POST | `/api/files/archive/run` | `src/daemons/routes.ts` | 415-421 | POST /api/files/archive/run — manual trigger |
| POST | `/api/files/:id/restore` | `src/daemons/routes.ts` | 424-462 | POST /api/files/:id/restore — restore an archived file |
| GET | `/api/reflect` | `src/dashboard/routes.ts` | 32-34 |  |
| GET | `/api/stats` | `src/dashboard/routes.ts` | 36-44 |  |
| GET | `/api/oracles` | `src/dashboard/routes.ts` | 46-94 |  |
| GET | `/api/map` | `src/dashboard/routes.ts` | 96-103 |  |
| GET | `/api/map3d` | `src/dashboard/routes.ts` | 105-113 |  |
| GET | `/api/list` | `src/dashboard/routes.ts` | 115-122 |  |
| GET | `/api/graph` | `src/dashboard/routes.ts` | 124-127 |  |
| GET | `/api/dashboard` | `src/dashboard/routes.ts` | 129-129 |  |
| GET | `/api/dashboard/summary` | `src/dashboard/routes.ts` | 130-130 |  |
| GET | `/api/dashboard/activity` | `src/dashboard/routes.ts` | 132-135 |  |
| GET | `/api/dashboard/growth` | `src/dashboard/routes.ts` | 137-140 |  |
| GET | `/api/dm/dashboard` | `src/dm/routes.ts` | 32-58 |  |
| GET | `/api/dm/unread-count` | `src/dm/routes.ts` | 60-67 |  |
| POST | `/api/dm` | `src/dm/routes.ts` | 69-173 |  |
| GET | `/api/dm/:name` | `src/dm/routes.ts` | 175-201 |  |
| GET | `/api/dm/:name/:other` | `src/dm/routes.ts` | 203-247 |  |
| PATCH | `/api/dm/:name/:other/read` | `src/dm/routes.ts` | 249-267 |  |
| PATCH | `/api/dm/:name/:other/read-all` | `src/dm/routes.ts` | 269-287 |  |
| DELETE | `/api/dm/messages/:id` | `src/dm/routes.ts` | 289-309 |  |
| POST | `/api/upload` | `src/files/routes.ts` | 65-176 |  |
| GET | `/api/files` | `src/files/routes.ts` | 179-222 | GET /api/files — list files with pagination and filters |
| GET | `/api/files/stats` | `src/files/routes.ts` | 225-260 | GET /api/files/stats — storage statistics (must be before :id) |
| GET | `/api/files/:id` | `src/files/routes.ts` | 263-275 | GET /api/files/:id — file metadata (owner-only, Beasts use /api/f/:hash) |
| GET | `/api/files/:id/download` | `src/files/routes.ts` | 278-305 | GET /api/files/:id/download — download by ID (owner-only, all other access via /api/f/:hash) |
| GET | `/api/f/:hash` | `src/files/routes.ts` | 308-360 | GET /api/f/:hash — download by hash (local bypass allowed, remote requires login) |
| DELETE | `/api/files/:id` | `src/files/routes.ts` | 364-378 | Only file uploader or owner can delete |
| GET | `/api/routine/logs` | `src/forge/routes.ts` | 164-183 | GET /api/routine/logs — list logs |
| GET | `/api/routine/today` | `src/forge/routes.ts` | 186-193 | GET /api/routine/today — today's logs grouped by type |
| GET | `/api/routine/weight` | `src/forge/routes.ts` | 196-245 | GET /api/routine/weight — weight history for chart (with time-based grouping) |
| GET | `/api/routine/blood-pressure` | `src/forge/routes.ts` | 249-299 | Mirrors /api/routine/weight: range filter + time-based grouping |
| GET | `/api/routine/exercise-summary` | `src/forge/routes.ts` | 306-443 | 20-page pull-and-filter workflow with a single structured summary. |
| GET | `/api/routine/prs` | `src/forge/routes.ts` | 447-465 | Alias to /api/routine/personal-records?grouped=true for cleaner call-site naming. |
| GET | `/api/routine/workout-trends` | `src/forge/routes.ts` | 488-587 | GET /api/routine/workout-trends — exercise progress over time (T#397) |
| GET | `/api/routine/body-composition` | `src/forge/routes.ts` | 590-638 | GET /api/routine/body-composition — body comp history from Withings (T#479, Spec #28) |
| GET | `/api/routine/stats` | `src/forge/routes.ts` | 641-648 | GET /api/routine/stats — summary stats |
| GET | `/api/routine/summary` | `src/forge/routes.ts` | 651-713 | GET /api/routine/summary — enhanced summary for Stats tab (T#410) |
| GET | `/api/routine/exercises` | `src/forge/routes.ts` | 716-729 | GET /api/routine/exercises — exercise library (T#410) |
| POST | `/api/routine/exercises` | `src/forge/routes.ts` | 732-749 | POST /api/routine/exercises — add custom exercise (T#410) |
| POST | `/api/routine/exercises/seed` | `src/forge/routes.ts` | 752-782 | POST /api/routine/exercises/seed — seed exercise library from existing workout data (T#410) |
| GET | `/api/routine/personal-records` | `src/forge/routes.ts` | 785-820 | GET /api/routine/personal-records — personal records list (T#410, T#543) |
| POST | `/api/routine/personal-records/seed` | `src/forge/routes.ts` | 823-867 | POST /api/routine/personal-records/seed — backfill PRs from all workout logs (T#543) |
| GET | `/api/routine/photos` | `src/forge/routes.ts` | 870-879 | GET /api/routine/photos — photo gallery |
| POST | `/api/routine/logs` | `src/forge/routes.ts` | 952-1036 | POST /api/routine/logs — create log entry |
| PATCH | `/api/routine/logs/:id` | `src/forge/routes.ts` | 1039-1089 | PATCH /api/routine/logs/:id — edit log |
| DELETE | `/api/routine/logs/:id` | `src/forge/routes.ts` | 1092-1099 | DELETE /api/routine/logs/:id — soft delete |
| GET | `/api/routine/logs/deleted` | `src/forge/routes.ts` | 1102-1107 | GET /api/routine/logs/deleted — list soft-deleted entries for recovery |
| PATCH | `/api/routine/logs/:id/restore` | `src/forge/routes.ts` | 1110-1117 | PATCH /api/routine/logs/:id/restore — undelete a soft-deleted log |
| POST | `/api/routine/photo/upload` | `src/forge/routes.ts` | 1120-1175 | POST /api/routine/photo/upload — upload progress photo |
| GET | `/api/routine/photo/:filename` | `src/forge/routes.ts` | 1178-1186 | GET /api/routine/photo/:filename — serve routine photo |
| POST | `/api/routine/import/alpha-progression` | `src/forge/routes.ts` | 1189-1335 | POST /api/routine/import/alpha-progression — import Alpha Progression CSV (T#389) |
| POST | `/api/routine/import/alpha-measurements` | `src/forge/routes.ts` | 1338-1433 | POST /api/routine/import/alpha-measurements — import Alpha Progression Measurements CSV (T#392) |
| POST | `/api/routine/hevy/sync` | `src/forge/routes.ts` | 1439-1569 | Dedupes on hevy workout id stored in data.hevy_id. |
| POST | `/api/webhooks/hevy` | `src/forge/routes.ts` | 1577-1624 | Bear T3 stamp: Discord 21:28 BKK 2026-04-26 (Sable Prowl #89 audit). |
| POST | `/api/forum/read` | `src/forum/routes.ts` | 30-58 |  |
| GET | `/api/forum/unread/:beast` | `src/forum/routes.ts` | 60-86 |  |
| GET | `/api/forum/file/:filename` | `src/forum/routes.ts` | 88-92 |  |
| GET | `/api/message/:id/attachments` | `src/forum/routes.ts` | 94-108 |  |
| POST | `/api/forum/mute` | `src/forum/routes.ts` | 110-131 |  |
| GET | `/api/forum/muted/:beast` | `src/forum/routes.ts` | 133-139 |  |
| POST | `/api/forum/subscribe` | `src/forum/routes.ts` | 141-155 |  |
| GET | `/api/forum/subscriptions/:beast` | `src/forum/routes.ts` | 157-161 |  |
| GET | `/api/thread/:id/subscribers` | `src/forum/routes.ts` | 163-192 |  |
| GET | `/api/forum/link-preview` | `src/forum/routes.ts` | 194-253 |  |
| GET | `/api/forum/activity` | `src/forum/routes.ts` | 255-279 |  |
| GET | `/api/forum/mentions/:beast` | `src/forum/routes.ts` | 281-306 |  |
| GET | `/api/forum/search` | `src/forum/routes.ts` | 308-356 |  |
| GET | `/api/threads` | `src/forum/routes.ts` | 358-400 |  |
| POST | `/api/thread` | `src/forum/routes.ts` | 402-519 |  |
| GET | `/api/thread/:id` | `src/forum/routes.ts` | 521-585 |  |
| PATCH | `/api/message/:id` | `src/forum/routes.ts` | 587-629 |  |
| DELETE | `/api/message/:id` | `src/forum/routes.ts` | 631-670 |  |
| GET | `/api/message/:id/history` | `src/forum/routes.ts` | 672-687 |  |
| GET | `/api/forum/emojis` | `src/forum/routes.ts` | 689-692 |  |
| POST | `/api/forum/emojis` | `src/forum/routes.ts` | 694-703 |  |
| DELETE | `/api/forum/emojis/:emoji` | `src/forum/routes.ts` | 705-711 |  |
| GET | `/api/reactions/supported` | `src/forum/routes.ts` | 713-715 |  |
| POST | `/api/message/:id/react` | `src/forum/routes.ts` | 717-787 |  |
| DELETE | `/api/message/:id/react` | `src/forum/routes.ts` | 789-821 |  |
| GET | `/api/message/:id/reactions` | `src/forum/routes.ts` | 823-832 |  |
| PATCH | `/api/thread/:id/category` | `src/forum/routes.ts` | 834-847 |  |
| PATCH | `/api/thread/:id/lock` | `src/forum/routes.ts` | 849-864 |  |
| PATCH | `/api/thread/:id/archive` | `src/forum/routes.ts` | 866-870 |  |
| PATCH | `/api/thread/:id/pin` | `src/forum/routes.ts` | 872-882 |  |
| PATCH | `/api/thread/:id/title` | `src/forum/routes.ts` | 884-899 |  |
| PATCH | `/api/thread/:id/visibility` | `src/forum/routes.ts` | 901-930 |  |
| PATCH | `/api/thread/:id/status` | `src/forum/routes.ts` | 932-944 |  |
| DELETE | `/api/thread/:id` | `src/forum/routes.ts` | 946-959 |  |
| GET | `/api/rules` | `src/governance/routes.ts` | 34-47 | GET /api/rules — list rules |
| GET | `/api/rules/decrees` | `src/governance/routes.ts` | 50-53 | GET /api/rules/decrees — active approved decrees only |
| GET | `/api/rules/pending` | `src/governance/routes.ts` | 56-59 | GET /api/rules/pending — pending decrees awaiting Gorn approval |
| POST | `/api/rules/:id/approve` | `src/governance/routes.ts` | 62-82 | POST /api/rules/:id/approve — Gorn approves a decree |
| POST | `/api/rules/:id/reject` | `src/governance/routes.ts` | 85-109 | POST /api/rules/:id/reject — Gorn rejects a decree |
| GET | `/api/rules/markdown` | `src/governance/routes.ts` | 112-127 | GET /api/rules/markdown — all active rules as plain markdown (T#426) |
| GET | `/api/rules/norms` | `src/governance/routes.ts` | 130-133 | GET /api/rules/norms — active norms only |
| GET | `/api/rules/:id` | `src/governance/routes.ts` | 136-141 | GET /api/rules/:id — single rule |
| POST | `/api/rules` | `src/governance/routes.ts` | 144-172 | POST /api/rules — create rule |
| PATCH | `/api/rules/:id` | `src/governance/routes.ts` | 175-207 | PATCH /api/rules/:id — update rule |
| PATCH | `/api/rules/:id/archive` | `src/governance/routes.ts` | 210-237 | PATCH /api/rules/:id/archive — archive rule |
| GET | `/api/guest/dashboard` | `src/guest/routes.ts` | 35-82 | Guest dashboard — public data only (T#558, Spec #32) |
| GET | `/api/guest/threads` | `src/guest/routes.ts` | 85-108 | Guest threads — public only (T#559) |
| GET | `/api/guest/thread/:id` | `src/guest/routes.ts` | 111-161 | Guest thread detail — public only (T#559) |
| POST | `/api/guest/thread/:id/message` | `src/guest/routes.ts` | 164-215 | Guest post message — public threads only (T#559) |
| POST | `/api/guest/thread` | `src/guest/routes.ts` | 218-272 | Guest create thread — new public thread (T#561) |
| GET | `/api/guest/pack` | `src/guest/routes.ts` | 275-303 | Guest pack — Beast profiles (T#559) |
| GET | `/api/guest/dm/:from/:to` | `src/guest/routes.ts` | 306-342 | Guest DM — read own conversations (T#559) |
| POST | `/api/guest/dm` | `src/guest/routes.ts` | 345-388 | Guest DM — send message (T#559) |
| POST | `/api/guest/change-password` | `src/guest/routes.ts` | 391-437 | Guest self-service password change (T#566, Spec #35 alias) |
| POST | `/api/guest/reset-password` | `src/guest/routes.ts` | 440-482 | Legacy alias (T#566) — same rate limiting as /api/guest/change-password (T#581) |
| GET | `/api/guest/profile` | `src/guest/routes.ts` | 485-501 | Guest profile — own info (T#559, expanded T#574) |
| PATCH | `/api/guest/profile` | `src/guest/routes.ts` | 504-547 | Guest self-service profile update (T#574, Spec #35) |
| POST | `/api/guest/avatar` | `src/guest/routes.ts` | 550-589 | Guest avatar upload (T#574, Spec #35) |
| POST | `/api/handoff` | `src/inbox/routes.ts` | 17-73 |  |
| GET | `/api/inbox` | `src/inbox/routes.ts` | 75-114 |  |
| POST | `/api/learn` | `src/inbox/routes.ts` | 116-136 |  |
| GET | `/api/oauth/withings/authorize` | `src/integrations/routes.ts` | 155-172 | GET /api/oauth/withings/authorize — start OAuth flow |
| GET | `/api/oauth/withings/callback` | `src/integrations/routes.ts` | 175-238 | GET /api/oauth/withings/callback — handle OAuth callback |
| GET | `/api/oauth/withings/status` | `src/integrations/routes.ts` | 241-263 | GET /api/oauth/withings/status — connection status |
| GET | `/api/withings/devices` | `src/integrations/routes.ts` | 266-282 | GET /api/withings/devices — proxy to Withings device list (T#478) |
| DELETE | `/api/oauth/withings/disconnect` | `src/integrations/routes.ts` | 285-311 | DELETE /api/oauth/withings/disconnect — revoke connection |
| POST | `/api/webhooks/withings` | `src/integrations/routes.ts` | 402-430 | POST /api/webhooks/withings — receive Withings push notifications (T#415) |
| POST | `/api/oauth/withings/sync` | `src/integrations/routes.ts` | 433-459 | POST /api/oauth/withings/sync — manual sync trigger (T#415) |
| GET | `/api/oauth/google/authorize` | `src/integrations/routes.ts` | 597-624 | GET /api/oauth/google/authorize — start OAuth flow with PKCE |
| GET | `/api/oauth/google/callback` | `src/integrations/routes.ts` | 627-697 | GET /api/oauth/google/callback — handle OAuth callback with PKCE |
| GET | `/api/oauth/google/status` | `src/integrations/routes.ts` | 700-712 | GET /api/oauth/google/status — connection status |
| DELETE | `/api/oauth/google/disconnect` | `src/integrations/routes.ts` | 715-742 | DELETE /api/oauth/google/disconnect — revoke and delete |
| GET | `/api/google/access` | `src/integrations/routes.ts` | 747-751 | GET /api/google/access — list allowed Beasts |
| POST | `/api/google/access` | `src/integrations/routes.ts` | 754-767 | POST /api/google/access — grant Beast access |
| DELETE | `/api/google/access/:beast` | `src/integrations/routes.ts` | 770-776 | DELETE /api/google/access/:beast — revoke Beast access |
| GET | `/api/google/audit` | `src/integrations/routes.ts` | 779-786 | GET /api/google/audit — view audit log (Gorn-only) |
| GET | `/api/google/gmail/profile` | `src/integrations/routes.ts` | 803-825 | GET /api/google/gmail/profile — email profile |
| GET | `/api/google/gmail/labels` | `src/integrations/routes.ts` | 828-850 | GET /api/google/gmail/labels — list labels |
| GET | `/api/google/gmail/messages` | `src/integrations/routes.ts` | 853-885 | GET /api/google/gmail/messages — list messages |
| GET | `/api/google/gmail/messages/:id` | `src/integrations/routes.ts` | 888-940 | GET /api/google/gmail/messages/:id — read a single message |
| GET | `/api/google/gmail/threads/:id` | `src/integrations/routes.ts` | 943-993 | GET /api/google/gmail/threads/:id — read a thread |
| GET | `/api/playbook` | `src/knowledge/routes.ts` | 359-365 | Playbook — serve den-playbook.md |
| GET | `/api/docs` | `src/knowledge/routes.ts` | 368-391 | API Documentation |
| GET | `/api/help` | `src/knowledge/routes.ts` | 394-423 | API Help — machine-readable endpoint catalog for Beast self-correction |
| GET | `/api/similar` | `src/knowledge/routes.ts` | 426-439 | Similar documents (vector nearest neighbors) |
| GET | `/api/feed` | `src/knowledge/routes.ts` | 442-506 | Live Oracle feed |
| GET | `/api/logs` | `src/knowledge/routes.ts` | 509-529 | Logs |
| GET | `/api/doc/:id` | `src/knowledge/routes.ts` | 532-557 | Get document by ID (uses raw SQL for FTS JOIN) |
| GET | `/api/context` | `src/knowledge/routes.ts` | 560-563 | Context |
| GET | `/api/file` | `src/knowledge/routes.ts` | 566-632 | File - supports cross-repo access via ghq project paths |
| GET | `/api/read` | `src/knowledge/routes.ts` | 635-651 | Read document by file path or ID |
| GET | `/api/library/shelves` | `src/library/routes.ts` | 19-37 | GET /api/library/shelves — list all shelves with entry counts |
| GET | `/api/library/shelves/:id` | `src/library/routes.ts` | 40-49 | GET /api/library/shelves/:id — single shelf with entries |
| POST | `/api/library/shelves` | `src/library/routes.ts` | 52-82 | POST /api/library/shelves — create shelf |
| PATCH | `/api/library/shelves/:id` | `src/library/routes.ts` | 85-123 | PATCH /api/library/shelves/:id — update shelf |
| DELETE | `/api/library/shelves/:id` | `src/library/routes.ts` | 126-137 | DELETE /api/library/shelves/:id — delete shelf, entries become ungrouped (Gorn only) |
| GET | `/api/library` | `src/library/routes.ts` | 140-207 | GET /api/library — list/search library entries |
| GET | `/api/library/search` | `src/library/routes.ts` | 210-233 | GET /api/library/search — typeahead suggestions for shelves + entries |
| GET | `/api/library/types` | `src/library/routes.ts` | 236-239 | GET /api/library/types — list available types and counts (must be before /:id) |
| GET | `/api/library/:id` | `src/library/routes.ts` | 242-266 | GET /api/library/:id — get single entry |
| POST | `/api/library` | `src/library/routes.ts` | 269-302 | POST /api/library — create entry |
| PATCH | `/api/library/:id` | `src/library/routes.ts` | 305-331 | PATCH /api/library/:id — update entry |
| DELETE | `/api/library/:id` | `src/library/routes.ts` | 334-356 | DELETE /api/library/:id — delete entry (Gorn or Pip) |
| GET | `/api/pack` | `src/pack/routes.ts` | 29-58 |  |
| GET | `/api/pack/spinner-verbs` | `src/pack/routes.ts` | 60-91 |  |
| GET | `/api/beast/:name/terminal` | `src/pack/routes.ts` | 93-137 |  |
| POST | `/api/beast/:name/terminal/input` | `src/pack/routes.ts` | 139-173 |  |
| POST | `/api/beast/:name/terminal/key` | `src/pack/routes.ts` | 175-202 |  |
| GET | `/api/beast/:name/avatar.svg` | `src/pack/routes.ts` | 204-245 |  |
| POST | `/api/beasts/seed-avatars` | `src/pack/routes.ts` | 247-265 |  |
| GET | `/api/beasts` | `src/pack/routes.ts` | 267-270 |  |
| GET | `/api/beast/:name` | `src/pack/routes.ts` | 272-279 |  |
| PUT | `/api/beast/:name` | `src/pack/routes.ts` | 281-314 |  |
| PATCH | `/api/beast/:name` | `src/pack/routes.ts` | 316-354 |  |
| PATCH | `/api/beast/:name/avatar` | `src/pack/routes.ts` | 356-383 |  |
| POST | `/api/beast/:name/wake` | `src/pack/routes.ts` | 385-438 |  |
| GET | `/api/prowl` | `src/prowl/routes.ts` | 20-79 | GET /api/prowl — list tasks with filters |
| GET | `/api/prowl/categories` | `src/prowl/routes.ts` | 82-94 | GET /api/prowl/categories — unique categories with counts |
| POST | `/api/prowl` | `src/prowl/routes.ts` | 97-144 | POST /api/prowl — create task |
| PATCH | `/api/prowl/:id` | `src/prowl/routes.ts` | 147-187 | PATCH /api/prowl/:id — update task fields (T#619: Gorn, Sable, or Karo) |
| PATCH | `/api/prowl/:id/status` | `src/prowl/routes.ts` | 190-220 | PATCH /api/prowl/:id/status — change status (T#619: Gorn, Sable, or Karo) |
| POST | `/api/prowl/:id/toggle` | `src/prowl/routes.ts` | 223-246 | POST /api/prowl/:id/toggle — quick toggle pending ↔ done (T#619: Gorn, Sable, or Karo) |
| DELETE | `/api/prowl/:id` | `src/prowl/routes.ts` | 249-267 | DELETE /api/prowl/:id — delete task (T#619: Gorn, Sable, or Karo) |
| GET | `/api/prowl/:id/checklist` | `src/prowl/routes.ts` | 272-288 | GET /api/prowl/:id/checklist — list checklist items for a task |
| POST | `/api/prowl/:id/checklist` | `src/prowl/routes.ts` | 291-318 | POST /api/prowl/:id/checklist — add checklist item |
| PATCH | `/api/prowl/:id/checklist/:itemId` | `src/prowl/routes.ts` | 321-357 | PATCH /api/prowl/:id/checklist/:itemId — update checklist item (text, checked, sort_order) |
| POST | `/api/prowl/:id/checklist/:itemId/toggle` | `src/prowl/routes.ts` | 360-380 | POST /api/prowl/:id/checklist/:itemId/toggle — quick toggle checked |
| DELETE | `/api/prowl/:id/checklist/:itemId` | `src/prowl/routes.ts` | 383-400 | DELETE /api/prowl/:id/checklist/:itemId — delete checklist item |
| POST | `/api/prowl/notify-test` | `src/prowl/routes.ts` | 403-413 | POST /api/prowl/notify-test — test notification pipeline (Gorn-only) |
| GET | `/api/queue/gorn` | `src/queue/routes.ts` | 14-38 | GET /api/queue/gorn — list queue items |
| POST | `/api/queue/gorn` | `src/queue/routes.ts` | 41-57 | POST /api/queue/gorn — add thread to queue (any Beast can tag) |
| PATCH | `/api/queue/gorn/:threadId` | `src/queue/routes.ts` | 60-82 | PATCH /api/queue/gorn/:threadId — update queue status (Decided/Defer/Withdraw — gorn only from browser) |
| GET | `/api/remote/status` | `src/remote/routes.ts` | 20-39 | GET /api/remote/status — which beast is currently attached |
| POST | `/api/remote/attach` | `src/remote/routes.ts` | 42-101 | POST /api/remote/attach — attach a beast's claude window (local only — requires tmux) |
| POST | `/api/remote/detach` | `src/remote/routes.ts` | 104-110 | POST /api/remote/detach — detach current beast (local only — requires tmux) |
| GET | `/api/risks` | `src/risk/routes.ts` | 17-43 | GET /api/risks — list risks |
| GET | `/api/risks/summary` | `src/risk/routes.ts` | 46-74 | GET /api/risks/summary — dashboard summary |
| GET | `/api/risks/stale` | `src/risk/routes.ts` | 77-82 | GET /api/risks/stale — risks not reviewed in >7 days |
| GET | `/api/risks/:id` | `src/risk/routes.ts` | 85-91 | GET /api/risks/:id — single risk |
| POST | `/api/risks` | `src/risk/routes.ts` | 94-147 | POST /api/risks — create risk (Gorn, Bertus, Talon) |
| PATCH | `/api/risks/:id` | `src/risk/routes.ts` | 150-206 | PATCH /api/risks/:id — update risk |
| DELETE | `/api/risks/:id` | `src/risk/routes.ts` | 209-220 | DELETE /api/risks/:id — soft delete (Gorn only) |
| GET | `/api/risks/:id/comments` | `src/risk/routes.ts` | 225-232 | GET /api/risks/:id/comments — list comments for a risk |
| POST | `/api/risks/:id/comments` | `src/risk/routes.ts` | 235-297 | POST /api/risks/:id/comments — add comment |
| GET | `/api/schedule/md` | `src/scheduler/routes.ts` | 313-319 | Serve raw schedule.md for frontend rendering |
| GET | `/api/schedule` | `src/scheduler/routes.ts` | 321-333 |  |
| POST | `/api/schedule` | `src/scheduler/routes.ts` | 335-341 |  |
| PATCH | `/api/schedule/:id` | `src/scheduler/routes.ts` | 343-352 |  |
| GET | `/api/schedules` | `src/scheduler/routes.ts` | 358-371 |  |
| GET | `/api/schedules/due` | `src/scheduler/routes.ts` | 374-382 | GET /api/schedules/due — overdue items for a beast |
| GET | `/api/schedules/:id` | `src/scheduler/routes.ts` | 385-391 | GET /api/schedules/:id — get a single schedule |
| POST | `/api/schedules` | `src/scheduler/routes.ts` | 394-506 | POST /api/schedules — create a schedule |
| PATCH | `/api/schedules/:id` | `src/scheduler/routes.ts` | 509-593 | PATCH /api/schedules/:id — update a schedule (owner or Gorn only) |
| PATCH | `/api/schedules/:id/run` | `src/scheduler/routes.ts` | 596-660 | PATCH /api/schedules/:id/run — mark a schedule as run (owner or Gorn only) |
| DELETE | `/api/schedules/:id` | `src/scheduler/routes.ts` | 663-680 | DELETE /api/schedules/:id — remove a schedule (owner or Gorn only) |
| POST | `/api/schedules/:id/execute` | `src/scheduler/routes.ts` | 683-713 | POST /api/schedules/:id/execute — manually trigger a schedule (sends tmux notification to Beast) |
| PATCH | `/api/schedules/:id/trigger` | `src/scheduler/routes.ts` | 716-736 | PATCH /api/schedules/:id/trigger — mark as triggered (owner, Gorn, or server daemon only) |
| GET | `/api/scheduler/health` | `src/scheduler/routes.ts` | 744-746 | GET /api/scheduler/health — daemon status |
| GET | `/api/search/legacy` | `src/search/routes.ts` | 273-288 | GET /api/search/legacy — Legacy vector search (kept for backwards compat) |
| GET | `/api/search` | `src/search/routes.ts` | 291-417 | GET /api/search — global search (Meilisearch with FTS5 fallback) |
| POST | `/api/search/reindex` | `src/search/routes.ts` | 420-459 | POST /api/search/reindex — full rebuild (Gorn or trusted local) |
| GET | `/api/search/status` | `src/search/routes.ts` | 462-492 | GET /api/search/status — integrity check |
| GET | `/api/session/stats` | `src/server.ts` | 791-810 | Session stats endpoint - tracks activity from DB (includes MCP usage) |
| GET | `/docs` | `src/server.ts` | 1687-1692 |  |
| GET | `/assets/*` | `src/server.ts` | 1702-1723 | Serve static assets |
| GET | `*` | `src/server.ts` | 1726-1733 | SPA fallback — serve index.html for all non-API routes |
| POST | `/api/guests` | `src/server/routes.ts` | 264-286 |  |
| GET | `/api/guests` | `src/server/routes.ts` | 289-314 | List guest accounts |
| GET | `/api/guests/:id` | `src/server/routes.ts` | 317-344 | Get single guest account |
| PATCH | `/api/guests/:id` | `src/server/routes.ts` | 347-364 | Update guest account (expiry, disable, display name) |
| PATCH | `/api/guests/:id/password` | `src/server/routes.ts` | 367-385 | Owner reset guest password (T#566) |
| DELETE | `/api/guests/:id` | `src/server/routes.ts` | 388-406 | Delete guest account (T#570 — with cascade notification) |
| POST | `/api/guests/:id/ban` | `src/server/routes.ts` | 409-442 | Ban guest account (T#616 — spec #36) |
| POST | `/api/guests/:id/unban` | `src/server/routes.ts` | 445-474 | Unban guest account (T#616 — spec #36) |
| POST | `/api/auth/tokens` | `src/server/routes.ts` | 480-506 |  |
| GET | `/api/auth/tokens` | `src/server/routes.ts` | 509-514 | List tokens — Gorn session auth only (no hashes exposed) |
| DELETE | `/api/auth/tokens/:id` | `src/server/routes.ts` | 517-531 | Revoke token — Gorn session auth only |
| POST | `/api/auth/tokens/rotate` | `src/server/routes.ts` | 535-555 | Beast-self chain-aware rotation lives at POST /api/auth/rotate (Spec #52). |
| GET | `/api/auth/me` | `src/server/routes.ts` | 565-579 | listTokens / GET /api/auth/tokens endpoint serves the owner-side view). |
| POST | `/api/auth/rotate` | `src/server/routes.ts` | 591-615 | 409 + code=rotation_locked — token already rotated_away (concurrent double-rotate) |
| GET | `/api/settings` | `src/settings/routes.ts` | 14-26 | Get settings (no password hash exposed) |
| POST | `/api/settings` | `src/settings/routes.ts` | 29-123 | Update settings (Gorn only — reject beast API calls) |
| GET | `/api/specs` | `src/specs/routes.ts` | 144-160 | GET /api/specs — list all specs |
| GET | `/api/specs/:id` | `src/specs/routes.ts` | 163-176 | GET /api/specs/:id — get spec detail (with linked tasks + threads) |
| GET | `/api/specs/:id/content` | `src/specs/routes.ts` | 179-201 | GET /api/specs/:id/content — raw markdown content from repo (or historical version via ?version=vN) |
| GET | `/api/specs/:id/versions` | `src/specs/routes.ts` | 204-212 | T#755 / Spec #57 Phase 2: GET /api/specs/:id/versions — list all version snapshots |
| GET | `/api/specs/:id/history` | `src/specs/routes.ts` | 215-234 | GET /api/specs/:id/history — git log for spec file |
| GET | `/api/specs/:id/diff` | `src/specs/routes.ts` | 237-260 | GET /api/specs/:id/diff — diff between two versions of spec file |
| POST | `/api/specs` | `src/specs/routes.ts` | 263-311 | POST /api/specs — register a spec for review |
| POST | `/api/specs/:id/review` | `src/specs/routes.ts` | 314-397 | POST /api/specs/:id/review — approve or reject (Gorn only) |
| GET | `/api/specs/:id/links` | `src/specs/routes.ts` | 400-406 | GET /api/specs/:id/links — list all links for a spec (T#425) |
| POST | `/api/specs/:id/link` | `src/specs/routes.ts` | 409-427 | POST /api/specs/:id/link — add a task or thread link (T#425) |
| DELETE | `/api/specs/:id/link` | `src/specs/routes.ts` | 430-442 | DELETE /api/specs/:id/link — remove a task or thread link (T#425) |
| GET | `/api/specs/by-task/:taskId` | `src/specs/routes.ts` | 445-451 | GET /api/specs/by-task/:taskId — find specs linked to a task (T#425) |
| GET | `/api/specs/by-thread/:threadId` | `src/specs/routes.ts` | 454-460 | GET /api/specs/by-thread/:threadId — find specs linked to a thread (T#425) |
| POST | `/api/specs/:id/resubmit` | `src/specs/routes.ts` | 463-502 | POST /api/specs/:id/resubmit — reset rejected/reopened spec to pending (author/assignee only) |
| POST | `/api/specs/:id/reopen` | `src/specs/routes.ts` | 507-557 | Only spec author + sable + gorn may reopen (per spec threat model). |
| DELETE | `/api/specs/:id` | `src/specs/routes.ts` | 560-572 | DELETE /api/specs/:id — delete spec (Gorn or Pip) |
| GET | `/api/specs/:id/comments` | `src/specs/routes.ts` | 589-601 | GET /api/specs/:id/comments |
| GET | `/api/spec-comments/:commentId` | `src/specs/routes.ts` | 604-610 | GET /api/spec-comments/:commentId — single comment by ID |
| POST | `/api/specs/:id/comments` | `src/specs/routes.ts` | 613-665 | POST /api/specs/:id/comments |
| GET | `/api/supersede` | `src/supersede/routes.ts` | 7-50 | List supersessions with optional filters |
| GET | `/api/supersede/chain/:path` | `src/supersede/routes.ts` | 53-81 | Get supersede chain for a document (what superseded what) |
| POST | `/api/supersede` | `src/supersede/routes.ts` | 84-114 | Log a new supersession |
| GET | `/api/teams` | `src/teams/routes.ts` | 32-41 | GET /api/teams — list all teams with member counts |
| POST | `/api/teams` | `src/teams/routes.ts` | 44-63 | POST /api/teams — create a team |
| GET | `/api/teams/:id` | `src/teams/routes.ts` | 66-74 | GET /api/teams/:id — team detail with members and projects |
| PATCH | `/api/teams/:id` | `src/teams/routes.ts` | 77-91 | PATCH /api/teams/:id — update team |
| POST | `/api/teams/:id/members` | `src/teams/routes.ts` | 94-109 | POST /api/teams/:id/members — add Beast to team |
| DELETE | `/api/teams/:id/members/:beast` | `src/teams/routes.ts` | 112-119 | DELETE /api/teams/:id/members/:beast — remove Beast from team |
| POST | `/api/teams/:id/projects` | `src/teams/routes.ts` | 122-134 | POST /api/teams/:id/projects — link project to team |
| DELETE | `/api/teams/:id/projects/:projectId` | `src/teams/routes.ts` | 137-144 | DELETE /api/teams/:id/projects/:projectId — unlink project |
| DELETE | `/api/teams/:id` | `src/teams/routes.ts` | 148-163 | Auth: team creator or Gorn only (Bertus security review) |
| GET | `/api/teams/beast/:beast` | `src/teams/routes.ts` | 166-176 | GET /api/teams/beast/:beast — list teams for a specific Beast |
| GET | `/api/telegram/status` | `src/telegram/routes.ts` | 261-275 | GET /api/telegram/status — polling status (owner only) |
| GET | `/api/telegram/message/:id` | `src/telegram/routes.ts` | 278-305 | T#712: GET /api/telegram/message/:id — fetch cached inbound TG message body |
| GET | `/api/traces` | `src/trace/routes.ts` | 19-35 |  |
| GET | `/api/traces/:id` | `src/trace/routes.ts` | 37-46 |  |
| GET | `/api/traces/:id/chain` | `src/trace/routes.ts` | 48-54 |  |
| POST | `/api/traces/:prevId/link` | `src/trace/routes.ts` | 56-76 |  |
| DELETE | `/api/traces/:id/link` | `src/trace/routes.ts` | 78-98 |  |
| GET | `/api/traces/:id/linked-chain` | `src/trace/routes.ts` | 100-109 |  |

## Functions

| Name | File | Lines | Size | Exported |
|------|------|-------|------|----------|
| registerAuditRoutes | `src/audit/routes.ts` | 17-156 | 140L | ✓ |
| registerBoardRoutes | `src/board/routes.ts` | 18-635 | 618L | ✓ |
| validateParentTaskId | `src/board/routes.ts` | 77-87 | 11L |  |
| getSubtasksSummary | `src/board/routes.ts` | 89-98 | 10L |  |
| checkApprovalGate | `src/board/routes.ts` | 101-107 | 7L |  |
| safeJsonParse | `src/chroma-mcp.ts` | 14-41 | 28L |  |
| registerHealth | `src/cli/commands/health.ts` | 5-17 | 13L | ✓ |
| registerInbox | `src/cli/commands/inbox.ts` | 5-22 | 18L | ✓ |
| registerLearn | `src/cli/commands/learn.ts` | 5-32 | 28L | ✓ |
| registerList | `src/cli/commands/list.ts` | 5-37 | 33L | ✓ |
| registerRead | `src/cli/commands/read.ts` | 5-27 | 23L | ✓ |
| registerSchedule | `src/cli/commands/schedule.ts` | 5-64 | 60L | ✓ |
| registerSearch | `src/cli/commands/search.ts` | 5-28 | 24L | ✓ |
| registerServer | `src/cli/commands/server.ts` | 8-86 | 79L | ✓ |
| registerStats | `src/cli/commands/stats.ts` | 5-28 | 24L | ✓ |
| registerThreads | `src/cli/commands/threads.ts` | 5-32 | 28L | ✓ |
| registerTraces | `src/cli/commands/traces.ts` | 5-36 | 32L | ✓ |
| registerVault | `src/cli/commands/vault.ts` | 9-115 | 107L | ✓ |
| walk | `src/cli/commands/vault.ts` | 82-91 | 10L |  |
| printJson | `src/cli/format.ts` | 5-7 | 3L | ✓ |
| truncate | `src/cli/format.ts` | 9-12 | 4L | ✓ |
| printSearchResults | `src/cli/format.ts` | 14-31 | 18L | ✓ |
| printThreads | `src/cli/format.ts` | 33-45 | 13L | ✓ |
| printThread | `src/cli/format.ts` | 47-57 | 11L | ✓ |
| printSchedule | `src/cli/format.ts` | 59-71 | 13L | ✓ |
| printTraces | `src/cli/format.ts` | 73-85 | 13L | ✓ |
| printInbox | `src/cli/format.ts` | 87-99 | 13L | ✓ |
| oracleFetch | `src/cli/http.ts` | 19-44 | 26L | ✓ |
| perBeastDrainAlive | `src/daemons/routes.ts` | 46-60 | 15L |  |
| runDrainCycle | `src/daemons/routes.ts` | 62-139 | 78L |  |
| runDbMaintenance | `src/daemons/routes.ts` | 150-179 | 30L |  |
| runFileArchive | `src/daemons/routes.ts` | 189-279 | 91L |  |
| initDaemons | `src/daemons/routes.ts` | 287-306 | 20L | ✓ |
| registerDaemonRoutes | `src/daemons/routes.ts` | 317-463 | 147L | ✓ |
| requireOwner | `src/daemons/routes.ts` | 324-329 | 6L |  |
| registerDashboardRoutes | `src/dashboard/routes.ts` | 27-143 | 117L | ✓ |
| initFts5 | `src/db/index.ts` | 26-35 | 10L | ✓ |
| initializeDatabase | `src/db/index.ts` | 40-60 | 21L |  |
| createDatabase | `src/db/index.ts` | 66-84 | 19L | ✓ |
| getBeastProfile | `src/db/index.ts` | 111-113 | 3L | ✓ |
| getAllBeastProfiles | `src/db/index.ts` | 115-117 | 3L | ✓ |
| upsertBeastProfile | `src/db/index.ts` | 119-159 | 41L | ✓ |
| updateBeastAvatar | `src/db/index.ts` | 161-166 | 6L | ✓ |
| closeDb | `src/db/index.ts` | 171-173 | 3L | ✓ |
| getSetting | `src/db/index.ts` | 179-182 | 4L | ✓ |
| setSetting | `src/db/index.ts` | 184-192 | 9L | ✓ |
| sortPair | `src/dm/handler.ts` | 21-25 | 5L |  |
| sanitizeForTmux | `src/dm/handler.ts` | 30-36 | 7L |  |
| getOrCreateConversation | `src/dm/handler.ts` | 45-83 | 39L | ✓ |
| sendDm | `src/dm/handler.ts` | 92-125 | 34L | ✓ |
| notifyDmRecipient | `src/dm/handler.ts` | 132-149 | 18L |  |
| listConversations | `src/dm/handler.ts` | 154-214 | 61L | ✓ |
| getMessages | `src/dm/handler.ts` | 219-266 | 48L | ✓ |
| markRead | `src/dm/handler.ts` | 271-302 | 32L | ✓ |
| markAllRead | `src/dm/handler.ts` | 307-335 | 29L | ✓ |
| getDashboard | `src/dm/handler.ts` | 340-410 | 71L | ✓ |
| registerDmRoutes | `src/dm/routes.ts` | 25-312 | 288L | ✓ |
| LOCK_FILE | `src/ensure-server.ts` | 21-21 | 1L |  |
| acquireLock | `src/ensure-server.ts` | 42-68 | 27L |  |
| releaseLock | `src/ensure-server.ts` | 73-82 | 10L |  |
| cleanupStalePidFile | `src/ensure-server.ts` | 87-93 | 7L |  |
| isServerHealthy | `src/ensure-server.ts` | 98-111 | 14L |  |
| ensureServerRunning | `src/ensure-server.ts` | 117-201 | 85L | ✓ |
| waitForHealthWithTimeout | `src/ensure-server.ts` | 206-218 | 13L |  |
| getServerStatus | `src/ensure-server.ts` | 223-241 | 19L | ✓ |
| detectImageType | `src/files/routes.ts` | 41-51 | 11L |  |
| registerFilesRoutes | `src/files/routes.ts` | 62-379 | 318L | ✓ |
| detectImageType | `src/forge/routes.ts` | 10-25 | 16L |  |
| registerForgeRoutes | `src/forge/routes.ts` | 43-1724 | 1682L | ✓ |
| isForgeAuthorized | `src/forge/routes.ts` | 135-158 | 24L |  |
| toKg | `src/forge/routes.ts` | 359-361 | 3L |  |
| getPeakWeight | `src/forge/routes.ts` | 409-418 | 10L |  |
| parseExerciseName | `src/forge/routes.ts` | 469-473 | 5L |  |
| parseExerciseString | `src/forge/routes.ts` | 476-485 | 10L |  |
| validateWorkoutData | `src/forge/routes.ts` | 885-949 | 65L |  |
| syncSingleHevyWorkout | `src/forge/routes.ts` | 1634-1722 | 89L |  |
| getProjectContext_ | `src/forum/handler.ts` | 28-31 | 4L |  |
| createThread | `src/forum/handler.ts` | 40-65 | 26L | ✓ |
| getThread | `src/forum/handler.ts` | 70-90 | 21L | ✓ |
| updateThreadStatus | `src/forum/handler.ts` | 95-100 | 6L | ✓ |
| listThreads | `src/forum/handler.ts` | 105-155 | 51L | ✓ |
| addMessage | `src/forum/handler.ts` | 164-205 | 42L | ✓ |
| getMessages | `src/forum/handler.ts` | 210-249 | 40L | ✓ |
| handleThreadMessage | `src/forum/handler.ts` | 258-359 | 102L | ✓ |
| getFullThread | `src/forum/handler.ts` | 364-379 | 16L | ✓ |
| getOracleRegistry | `src/forum/mentions.ts` | 43-71 | 29L | ✓ |
| invalidateRegistryCache | `src/forum/mentions.ts` | 76-78 | 3L | ✓ |
| parseMentions | `src/forum/mentions.ts` | 91-143 | 53L | ✓ |
| getSubscriptionLevel | `src/forum/mentions.ts` | 155-165 | 11L | ✓ |
| setSubscription | `src/forum/mentions.ts` | 170-180 | 11L | ✓ |
| autoSubscribe | `src/forum/mentions.ts` | 186-193 | 8L | ✓ |
| getSubscriptions | `src/forum/mentions.ts` | 198-208 | 11L | ✓ |
| getThreadSubscribers | `src/forum/mentions.ts` | 213-223 | 11L | ✓ |
| sanitizeForTmux | `src/forum/mentions.ts` | 233-239 | 7L |  |
| notifyMentioned | `src/forum/mentions.ts` | 249-303 | 55L | ✓ |
| getOracles | `src/forum/responder.ts` | 18-47 | 30L |  |
| findTmuxPane | `src/forum/responder.ts` | 60-98 | 39L |  |
| sendToLiveSession | `src/forum/responder.ts` | 104-120 | 17L |  |
| extractTargetOracle | `src/forum/responder.ts` | 132-140 | 9L | ✓ |
| extractOracleFromAuthor | `src/forum/responder.ts` | 146-154 | 9L |  |
| buildPrompt | `src/forum/responder.ts` | 159-181 | 23L |  |
| invokeOracle | `src/forum/responder.ts` | 186-223 | 38L |  |
| isConversationComplete | `src/forum/responder.ts` | 228-231 | 4L |  |
| cleanResponse | `src/forum/responder.ts` | 236-238 | 3L |  |
| saveConversationMemory | `src/forum/responder.ts` | 246-356 | 111L |  |
| runConversation | `src/forum/responder.ts` | 363-448 | 86L |  |
| processQueue | `src/forum/responder.ts` | 453-463 | 11L |  |
| getNextResponder | `src/forum/responder.ts` | 469-498 | 30L |  |
| maybeAutoRespond | `src/forum/responder.ts` | 504-558 | 55L | ✓ |
| registerForumRoutes | `src/forum/routes.ts` | 25-962 | 938L | ✓ |
| parseIssueUrl | `src/forum/types.ts` | 57-66 | 10L | ✓ |
| buildIssueUrl | `src/forum/types.ts` | 68-70 | 3L | ✓ |
| decorateRule | `src/governance/routes.ts` | 14-28 | 15L |  |
| registerGovernanceRoutes | `src/governance/routes.ts` | 30-238 | 209L | ✓ |
| registerGuestRoutes | `src/guest/routes.ts` | 20-590 | 571L | ✓ |
| getGuestDisplayName | `src/guest/routes.ts` | 29-32 | 4L |  |
| normalizeGuestSender | `src/guest/routes.ts` | 325-328 | 4L |  |
| registerInboxRoutes | `src/inbox/routes.ts` | 14-137 | 124L | ✓ |
| main | `src/index.ts` | 312-325 | 14L |  |
| escapeCSV | `src/indexer.ts` | 137-142 | 6L |  |
| runWithingsAutoSync | `src/integrations/routes.ts` | 21-21 | 1L |  |
| initIntegrations | `src/integrations/routes.ts` | 27-34 | 8L | ✓ |
| registerIntegrationsRoutes | `src/integrations/routes.ts` | 48-1026 | 979L | ✓ |
| encryptToken | `src/integrations/routes.ts` | 58-67 | 10L |  |
| decryptToken | `src/integrations/routes.ts` | 69-78 | 10L |  |
| withingsSign | `src/integrations/routes.ts` | 81-83 | 3L |  |
| getWithingsNonce | `src/integrations/routes.ts` | 86-97 | 12L |  |
| ensureFreshWithingsToken | `src/integrations/routes.ts` | 100-149 | 50L |  |
| syncWithingsMeasurements | `src/integrations/routes.ts` | 321-399 | 79L |  |
| checkGoogleRateLimit | `src/integrations/routes.ts` | 500-508 | 9L |  |
| generateCodeVerifier | `src/integrations/routes.ts` | 511-513 | 3L |  |
| generateCodeChallenge | `src/integrations/routes.ts` | 515-517 | 3L |  |
| ensureFreshGoogleToken | `src/integrations/routes.ts` | 520-567 | 48L |  |
| checkGoogleAccess | `src/integrations/routes.ts` | 570-576 | 7L |  |
| logGoogleAccess | `src/integrations/routes.ts` | 579-582 | 4L |  |
| tagUntrustedContent | `src/integrations/routes.ts` | 585-588 | 4L |  |
| sanitizeMetadata | `src/integrations/routes.ts` | 591-594 | 4L |  |
| getGmailBeast | `src/integrations/routes.ts` | 791-800 | 10L |  |
| getHeader | `src/integrations/routes.ts` | 909-909 | 1L |  |
| extractText | `src/integrations/routes.ts` | 913-918 | 6L |  |
| getHeader | `src/integrations/routes.ts` | 965-965 | 1L |  |
| extractText | `src/integrations/routes.ts` | 968-973 | 6L |  |
| runWithingsAutoSync | `src/integrations/routes.ts` | 1003-1019 | 17L |  |
| registerKnowledgeRoutes | `src/knowledge/routes.ts` | 355-652 | 298L | ✓ |
| registerLibraryRoutes | `src/library/routes.ts` | 13-357 | 345L | ✓ |
| ensureLogPath | `src/mcp-audit.ts` | 11-17 | 7L |  |
| logMcpToolCall | `src/mcp-audit.ts` | 19-41 | 23L | ✓ |
| formatUtc7Timestamp | `src/notify.ts` | 50-59 | 10L |  |
| enqueueNotification | `src/notify.ts` | 71-106 | 36L | ✓ |
| registerPackRoutes | `src/pack/routes.ts` | 25-441 | 417L | ✓ |
| closeHttpServer | `src/process-manager/GracefulShutdown.ts` | 54-73 | 20L |  |
| performGracefulShutdown | `src/process-manager/GracefulShutdown.ts` | 82-149 | 68L | ✓ |
| createShutdownHandler | `src/process-manager/GracefulShutdown.ts` | 154-156 | 3L | ✓ |
| isPortInUse | `src/process-manager/HealthMonitor.ts` | 36-47 | 12L | ✓ |
| waitForHealth | `src/process-manager/HealthMonitor.ts` | 55-73 | 19L | ✓ |
| waitForPortFree | `src/process-manager/HealthMonitor.ts` | 79-91 | 13L | ✓ |
| httpShutdown | `src/process-manager/HealthMonitor.ts` | 98-121 | 24L | ✓ |
| getWorkerStatus | `src/process-manager/HealthMonitor.ts` | 126-143 | 18L | ✓ |
| getWorkerVersion | `src/process-manager/HealthMonitor.ts` | 148-163 | 16L | ✓ |
| formatData | `src/process-manager/logger.ts` | 16-19 | 4L |  |
| formatError | `src/process-manager/logger.ts` | 21-24 | 4L |  |
| setLogger | `src/process-manager/logger.ts` | 49-51 | 3L | ✓ |
| getLogger | `src/process-manager/logger.ts` | 53-55 | 3L | ✓ |
| configure | `src/process-manager/ProcessManager.ts` | 29-32 | 4L | ✓ |
| getDataDir | `src/process-manager/ProcessManager.ts` | 37-39 | 3L | ✓ |
| getPidFilePath | `src/process-manager/ProcessManager.ts` | 44-46 | 3L | ✓ |
| writePidFile | `src/process-manager/ProcessManager.ts` | 58-62 | 5L | ✓ |
| readPidFile | `src/process-manager/ProcessManager.ts` | 68-78 | 11L | ✓ |
| removePidFile | `src/process-manager/ProcessManager.ts` | 83-92 | 10L | ✓ |
| getPlatformTimeout | `src/process-manager/ProcessManager.ts` | 97-100 | 4L | ✓ |
| isProcessAlive | `src/process-manager/ProcessManager.ts` | 105-112 | 8L | ✓ |
| getChildProcesses | `src/process-manager/ProcessManager.ts` | 118-144 | 27L | ✓ |
| forceKillProcess | `src/process-manager/ProcessManager.ts` | 151-169 | 19L | ✓ |
| waitForProcessesExit | `src/process-manager/ProcessManager.ts` | 174-191 | 18L | ✓ |
| findProcesses | `src/process-manager/ProcessManager.ts` | 196-238 | 43L | ✓ |
| killProcesses | `src/process-manager/ProcessManager.ts` | 243-269 | 27L | ✓ |
| spawnDaemon | `src/process-manager/ProcessManager.ts` | 290-319 | 30L | ✓ |
| createSignalHandler | `src/process-manager/ProcessManager.ts` | 325-345 | 21L | ✓ |
| registerSignalHandlers | `src/process-manager/ProcessManager.ts` | 350-360 | 11L | ✓ |
| registerProwlRoutes | `src/prowl/routes.ts` | 16-414 | 399L | ✓ |
| registerQueueRoutes | `src/queue/routes.ts` | 9-83 | 75L | ✓ |
| registerRemoteRoutes | `src/remote/routes.ts` | 12-111 | 100L | ✓ |
| registerRiskRoutes | `src/risk/routes.ts` | 13-298 | 286L | ✓ |
| wsBroadcast | `src/scheduler/routes.ts` | 18-18 | 1L |  |
| enqueueNotification | `src/scheduler/routes.ts` | 19-19 | 1L |  |
| parseInterval | `src/scheduler/routes.ts` | 31-41 | 11L |  |
| computeNextFixedTime | `src/scheduler/routes.ts` | 44-61 | 18L |  |
| computeNextFixedTimeAfterRun | `src/scheduler/routes.ts` | 64-73 | 10L |  |
| parseDaysOfWeek | `src/scheduler/routes.ts` | 77-87 | 11L |  |
| computeNextWeekdayFixedTime | `src/scheduler/routes.ts` | 93-127 | 35L |  |
| toIso | `src/scheduler/routes.ts` | 110-110 | 1L |  |
| runSchedulerCycle | `src/scheduler/routes.ts` | 140-244 | 105L |  |
| initScheduler | `src/scheduler/routes.ts` | 253-289 | 37L | ✓ |
| registerSchedulerRoutes | `src/scheduler/routes.ts` | 300-748 | 449L | ✓ |
| extractProjectFromSource | `src/scripts/fix-oracle-learn-project.ts` | 88-102 | 15L |  |
| main | `src/scripts/index-model.ts` | 30-117 | 88L |  |
| main | `src/scripts/index-qwen3.ts` | 19-105 | 87L |  |
| searchUrlFor | `src/search/routes.ts` | 30-33 | 4L |  |
| initMeilisearch | `src/search/routes.ts` | 39-64 | 26L |  |
| backfillMeilisearch | `src/search/routes.ts` | 67-106 | 40L | ✓ |
| indexSpecFiles | `src/search/routes.ts` | 109-120 | 12L |  |
| searchIndexUpsert | `src/search/routes.ts` | 127-142 | 16L | ✓ |
| searchIndexDelete | `src/search/routes.ts` | 144-150 | 7L | ✓ |
| sanitizeFtsQuery | `src/search/routes.ts` | 153-156 | 4L |  |
| fts5Search | `src/search/routes.ts` | 159-204 | 46L |  |
| forumUrl | `src/search/routes.ts` | 181-185 | 5L |  |
| initSearch | `src/search/routes.ts` | 210-255 | 46L | ✓ |
| registerSearchRoutes | `src/search/routes.ts` | 268-493 | 226L | ✓ |
| serveStatic | `src/server-legacy.ts` | 83-100 | 18L |  |
| withRetry | `src/server.ts` | 186-200 | 15L |  |
| findSimilarPaths | `src/server.ts` | 246-264 | 19L |  |
| isLocalNetwork | `src/server.ts` | 321-349 | 29L | ✓ |
| generateSessionToken | `src/server.ts` | 354-362 | 9L | ✓ |
| verifySessionToken | `src/server.ts` | 372-374 | 3L |  |
| parseSessionToken | `src/server.ts` | 376-421 | 46L | ✓ |
| hasSessionAuth | `src/server.ts` | 424-427 | 4L |  |
| isTrustedRequest | `src/server.ts` | 430-432 | 3L |  |
| requireBeastIdentity | `src/server.ts` | 440-445 | 6L |  |
| isAuthenticated | `src/server.ts` | 448-460 | 13L | ✓ |
| getRateLimit | `src/server.ts` | 749-753 | 5L | ✓ |
| clearRateLimit | `src/server.ts` | 755-757 | 3L | ✓ |
| loadAllSpinnerVerbs | `src/server.ts` | 822-844 | 23L |  |
| getSpinnerVerbs | `src/server.ts` | 849-856 | 8L |  |
| normalizeAvatarUrl | `src/server.ts` | 859-870 | 12L |  |
| getTmuxStatus | `src/server.ts` | 873-983 | 111L |  |
| getSupportedEmoji | `src/server.ts` | 1110-1113 | 4L |  |
| isForgeAuthorized | `src/server.ts` | 1523-1546 | 24L |  |
| validateWsUpgrade | `src/server.ts` | 1750-1804 | 55L |  |
| wsBroadcast | `src/server.ts` | 1807-1812 | 6L | ✓ |
| has | `src/server/beast-tokens.ts` | 81-81 | 1L |  |
| hmacHash | `src/server/beast-tokens.ts` | 170-172 | 3L |  |
| createToken | `src/server/beast-tokens.ts` | 182-218 | 37L | ✓ |
| validateToken | `src/server/beast-tokens.ts` | 258-431 | 174L | ✓ |
| getTokenInfo | `src/server/beast-tokens.ts` | 443-486 | 44L | ✓ |
| fmt | `src/server/beast-tokens.ts` | 472-472 | 1L |  |
| revokeChainForward | `src/server/beast-tokens.ts` | 500-517 | 18L |  |
| rotateToken | `src/server/beast-tokens.ts` | 529-572 | 44L | ✓ |
| selfRotateToken | `src/server/beast-tokens.ts` | 592-655 | 64L | ✓ |
| revokeBeastChain | `src/server/beast-tokens.ts` | 663-681 | 19L | ✓ |
| revokeToken | `src/server/beast-tokens.ts` | 687-704 | 18L | ✓ |
| listTokens | `src/server/beast-tokens.ts` | 710-735 | 26L | ✓ |
| pruneBeastTokens | `src/server/beast-tokens.ts` | 743-756 | 14L | ✓ |
| parseGhqPath | `src/server/context.ts` | 29-40 | 12L | ✓ |
| getGitInfo | `src/server/context.ts` | 45-55 | 11L | ✓ |
| getProjectContext | `src/server/context.ts` | 61-79 | 19L | ✓ |
| handleContext | `src/server/context.ts` | 86-97 | 12L | ✓ |
| handleDashboardSummary | `src/server/dashboard.ts` | 14-102 | 89L | ✓ |
| handleDashboardActivity | `src/server/dashboard.ts` | 107-161 | 55L | ✓ |
| handleDashboardGrowth | `src/server/dashboard.ts` | 166-212 | 47L | ✓ |
| initGuestTables | `src/server/guest-accounts.ts` | 52-103 | 52L | ✓ |
| createGuest | `src/server/guest-accounts.ts` | 108-138 | 31L | ✓ |
| listGuests | `src/server/guest-accounts.ts` | 143-146 | 4L | ✓ |
| getGuest | `src/server/guest-accounts.ts` | 151-153 | 3L | ✓ |
| getGuestByUsername | `src/server/guest-accounts.ts` | 158-160 | 3L | ✓ |
| getGuestByDisplayName | `src/server/guest-accounts.ts` | 165-167 | 3L | ✓ |
| updateGuest | `src/server/guest-accounts.ts` | 172-198 | 27L | ✓ |
| deleteGuest | `src/server/guest-accounts.ts` | 203-206 | 4L | ✓ |
| banGuest | `src/server/guest-accounts.ts` | 211-222 | 12L | ✓ |
| unbanGuest | `src/server/guest-accounts.ts` | 227-232 | 6L | ✓ |
| isGuestActive | `src/server/guest-accounts.ts` | 237-258 | 22L | ✓ |
| recordFailedAttempt | `src/server/guest-accounts.ts` | 263-273 | 11L | ✓ |
| recordSuccessfulLogin | `src/server/guest-accounts.ts` | 278-281 | 4L | ✓ |
| updateGuestProfile | `src/server/guest-accounts.ts` | 286-316 | 31L | ✓ |
| resetGuestPassword | `src/server/guest-accounts.ts` | 321-329 | 9L | ✓ |
| changeGuestPassword | `src/server/guest-accounts.ts` | 334-351 | 18L | ✓ |
| logGuestAction | `src/server/guest-accounts.ts` | 356-361 | 6L | ✓ |
| scanForInjection | `src/server/guest-safety.ts` | 40-48 | 9L | ✓ |
| checkRate | `src/server/guest-safety.ts` | 73-89 | 17L |  |
| checkGuestPostRate | `src/server/guest-safety.ts` | 94-106 | 13L | ✓ |
| checkGuestDmRate | `src/server/guest-safety.ts` | 111-117 | 7L | ✓ |
| checkGuestContentLength | `src/server/guest-safety.ts` | 129-135 | 7L | ✓ |
| initGuestSafetyMigrations | `src/server/guest-safety.ts` | 144-157 | 14L | ✓ |
| getVectorStore | `src/server/handlers.ts` | 21-23 | 3L |  |
| handleSearch | `src/server/handlers.ts` | 29-238 | 210L | ✓ |
| normalizeRank | `src/server/handlers.ts` | 243-247 | 5L |  |
| combineSearchResults | `src/server/handlers.ts` | 252-281 | 30L |  |
| handleReflect | `src/server/handlers.ts` | 286-323 | 38L | ✓ |
| handleList | `src/server/handlers.ts` | 332-454 | 123L | ✓ |
| handleStats | `src/server/handlers.ts` | 459-541 | 83L | ✓ |
| handleGraph | `src/server/handlers.ts` | 548-614 | 67L | ✓ |
| handleSimilar | `src/server/handlers.ts` | 619-669 | 51L | ✓ |
| handleMap | `src/server/handlers.ts` | 691-818 | 128L | ✓ |
| simpleHash | `src/server/handlers.ts` | 821-828 | 8L |  |
| handleMap3d | `src/server/handlers.ts` | 849-1177 | 329L | ✓ |
| covTimesVec | `src/server/handlers.ts` | 1035-1055 | 21L |  |
| deflate | `src/server/handlers.ts` | 1063-1072 | 10L |  |
| handleVectorStats | `src/server/handlers.ts` | 1183-1219 | 37L | ✓ |
| handleLearn | `src/server/handlers.ts` | 1227-1320 | 94L | ✓ |
| logSearch | `src/server/logging.ts` | 13-73 | 61L | ✓ |
| logDocumentAccess | `src/server/logging.ts` | 78-89 | 12L | ✓ |
| logLearning | `src/server/logging.ts` | 94-107 | 14L | ✓ |
| detectProject | `src/server/project-detect.ts` | 27-55 | 29L | ✓ |
| isGuestAllowed | `src/server/rbac.ts` | 60-64 | 5L |  |
| rbacMiddleware | `src/server/rbac.ts` | 74-97 | 24L | ✓ |
| getGuestAllowlist | `src/server/rbac.ts` | 102-104 | 3L | ✓ |
| registerServerRoutes | `src/server/routes.ts` | 37-617 | 581L | ✓ |
| setRateLimit | `src/server/routes.ts` | 44-46 | 3L |  |
| logSecurityEvent | `src/server/security-logger.ts` | 99-120 | 22L | ✓ |
| checkAlertThresholds | `src/server/security-logger.ts` | 132-171 | 40L |  |
| generateRequestId | `src/server/security-logger.ts` | 180-182 | 3L | ✓ |
| pruneSecurityEvents | `src/server/security-logger.ts` | 194-205 | 12L | ✓ |
| asyncHandler | `src/server/utils.ts` | 12-29 | 18L | ✓ |
| validateRequired | `src/server/utils.ts` | 35-49 | 15L | ✓ |
| asyncHandlerWithValidation | `src/server/utils.ts` | 58-68 | 11L | ✓ |
| registerSettingsRoutes | `src/settings/routes.ts` | 10-124 | 115L | ✓ |
| registerSpecsRoutes | `src/specs/routes.ts` | 21-668 | 648L | ✓ |
| resolveSpecPath | `src/specs/routes.ts` | 79-88 | 10L |  |
| parseVersionN | `src/specs/routes.ts` | 127-130 | 4L |  |
| nextVersionFor | `src/specs/routes.ts` | 133-141 | 9L |  |
| registerSupersedeRoutes | `src/supersede/routes.ts` | 5-115 | 111L | ✓ |
| registerTeamsRoutes | `src/teams/routes.ts` | 9-177 | 169L | ✓ |
| validateTeamName | `src/teams/routes.ts` | 13-18 | 6L |  |
| sanitizeInput | `src/teams/routes.ts` | 21-23 | 3L |  |
| beastExists | `src/teams/routes.ts` | 26-29 | 4L |  |
| parseTelegramBots | `src/telegram/routes.ts` | 24-56 | 33L |  |
| tgApi | `src/telegram/routes.ts` | 60-65 | 6L |  |
| tgSendReply | `src/telegram/routes.ts` | 67-69 | 3L |  |
| handleTelegramMessage | `src/telegram/routes.ts` | 71-207 | 137L |  |
| stripEphemeral | `src/telegram/routes.ts` | 82-88 | 7L |  |
| pollTelegramBot | `src/telegram/routes.ts` | 209-234 | 26L |  |
| isTelegramAuthorized | `src/telegram/routes.ts` | 240-249 | 10L |  |
| registerTelegramRoutes | `src/telegram/routes.ts` | 257-309 | 53L | ✓ |
| startTelegramPolling | `src/telegram/routes.ts` | 311-327 | 17L |  |
| handleConcepts | `src/tools/concepts.ts` | 33-77 | 45L | ✓ |
| handleThread | `src/tools/forum.ts` | 118-143 | 26L | ✓ |
| handleThreads | `src/tools/forum.ts` | 145-172 | 28L | ✓ |
| handleThreadRead | `src/tools/forum.ts` | 174-202 | 29L | ✓ |
| handleThreadUpdate | `src/tools/forum.ts` | 204-221 | 18L | ✓ |
| handleHandoff | `src/tools/handoff.ts` | 33-82 | 50L | ✓ |
| handleInbox | `src/tools/inbox.ts` | 37-80 | 44L | ✓ |
| coerceConcepts | `src/tools/learn.ts` | 16-20 | 5L | ✓ |
| normalizeProject | `src/tools/learn.ts` | 58-79 | 22L | ✓ |
| extractProjectFromSource | `src/tools/learn.ts` | 85-98 | 14L | ✓ |
| handleLearn | `src/tools/learn.ts` | 104-200 | 97L | ✓ |
| handleList | `src/tools/list.ts` | 38-95 | 58L | ✓ |
| detectGhqRoot | `src/tools/read.ts` | 32-44 | 13L |  |
| extractProject | `src/tools/read.ts` | 47-51 | 5L |  |
| resolveFilePath | `src/tools/read.ts` | 57-81 | 25L |  |
| isPathAllowed | `src/tools/read.ts` | 84-96 | 13L |  |
| handleRead | `src/tools/read.ts` | 98-180 | 83L | ✓ |
| handleReflect | `src/tools/reflect.ts` | 20-59 | 40L | ✓ |
| getSchedulePath | `src/tools/schedule.ts` | 23-25 | 3L |  |
| parseDate | `src/tools/schedule.ts` | 51-103 | 53L | ✓ |
| fmt | `src/tools/schedule.ts` | 105-107 | 3L |  |
| fmtLocal | `src/tools/schedule.ts` | 110-112 | 3L |  |
| handleScheduleAdd | `src/tools/schedule.ts` | 189-224 | 36L | ✓ |
| handleScheduleList | `src/tools/schedule.ts` | 226-295 | 70L | ✓ |
| exportScheduleToMarkdown | `src/tools/schedule.ts` | 301-347 | 47L |  |
| sanitizeFtsQuery | `src/tools/search.ts` | 72-84 | 13L | ✓ |
| normalizeFtsScore | `src/tools/search.ts` | 91-94 | 4L | ✓ |
| parseConceptsFromMetadata | `src/tools/search.ts` | 99-111 | 13L | ✓ |
| vectorSearch | `src/tools/search.ts` | 117-182 | 66L | ✓ |
| combineResults | `src/tools/search.ts` | 188-304 | 117L | ✓ |
| handleSearch | `src/tools/search.ts` | 310-441 | 132L | ✓ |
| handleStats | `src/tools/stats.ts` | 21-79 | 59L | ✓ |
| handleSupersede | `src/tools/supersede.ts` | 35-77 | 43L | ✓ |
| handleTrace | `src/tools/trace.ts` | 134-155 | 22L | ✓ |
| handleTraceList | `src/tools/trace.ts` | 157-182 | 26L | ✓ |
| handleTraceGet | `src/tools/trace.ts` | 184-234 | 51L | ✓ |
| handleTraceLink | `src/tools/trace.ts` | 236-261 | 26L | ✓ |
| handleTraceUnlink | `src/tools/trace.ts` | 263-275 | 13L | ✓ |
| handleTraceChain | `src/tools/trace.ts` | 277-297 | 21L | ✓ |
| handleVerify | `src/tools/verify.ts` | 31-56 | 26L | ✓ |
| isLearningFilePath | `src/trace/handler.ts` | 28-30 | 3L |  |
| createLearningFile | `src/trace/handler.ts` | 36-82 | 47L |  |
| processLearnings | `src/trace/handler.ts` | 87-102 | 16L |  |
| createTrace | `src/trace/handler.ts` | 107-181 | 75L | ✓ |
| getTrace | `src/trace/handler.ts` | 186-195 | 10L | ✓ |
| listTraces | `src/trace/handler.ts` | 200-273 | 74L | ✓ |
| getTraceChain | `src/trace/handler.ts` | 278-335 | 58L | ✓ |
| linkTraces | `src/trace/handler.ts` | 341-379 | 39L | ✓ |
| unlinkTraces | `src/trace/handler.ts` | 384-426 | 43L | ✓ |
| getTraceLinkedChain | `src/trace/handler.ts` | 431-461 | 31L | ✓ |
| distillTrace | `src/trace/handler.ts` | 466-488 | 23L | ✓ |
| updateTraceChildren | `src/trace/handler.ts` | 493-512 | 20L |  |
| parseTraceRow | `src/trace/handler.ts` | 517-549 | 33L |  |
| toSummary | `src/trace/handler.ts` | 554-567 | 14L |  |
| registerTraceRoutes | `src/trace/routes.ts` | 15-112 | 98L | ✓ |
| walk | `src/vault/cli.ts` | 114-123 | 10L |  |
| walkFiles | `src/vault/handler.ts` | 29-47 | 19L |  |
| resolveVaultPath | `src/vault/handler.ts` | 49-57 | 9L |  |
| cleanEmptyDirs | `src/vault/handler.ts` | 59-66 | 8L |  |
| mapToVaultPath | `src/vault/handler.ts` | 88-98 | 11L | ✓ |
| mapFromVaultPath | `src/vault/handler.ts` | 104-119 | 16L | ✓ |
| ensureFrontmatterProject | `src/vault/handler.ts` | 127-142 | 16L | ✓ |
| parseGitStatus | `src/vault/handler.ts` | 154-169 | 16L | ✓ |
| getVaultPsiRoot | `src/vault/handler.ts` | 179-195 | 17L | ✓ |
| initVault | `src/vault/handler.ts` | 207-240 | 34L | ✓ |
| syncVault | `src/vault/handler.ts` | 251-365 | 115L | ✓ |
| pullVault | `src/vault/handler.ts` | 372-425 | 54L | ✓ |
| vaultStatus | `src/vault/handler.ts` | 440-483 | 44L | ✓ |
| isProjectCategory | `src/vault/handler.ts` | 489-491 | 3L |  |
| resolveVaultPath | `src/vault/migrate.ts` | 24-28 | 5L |  |
| walkFiles | `src/vault/migrate.ts` | 30-48 | 19L |  |
| isProjectCategory | `src/vault/migrate.ts` | 57-59 | 3L |  |
| findPsiRepos | `src/vault/migrate.ts` | 82-103 | 22L |  |
| migrate | `src/vault/migrate.ts` | 108-220 | 113L |  |
| toBlob | `src/vector/adapters/sqlite-vec.ts` | 14-16 | 3L |  |
| fromBlob | `src/vector/adapters/sqlite-vec.ts` | 19-28 | 10L |  |
| createEmbeddingProvider | `src/vector/embeddings.ts` | 125-143 | 19L | ✓ |
| createVectorStore | `src/vector/factory.ts` | 46-129 | 84L | ✓ |
| homeDir | `src/vector/factory.ts` | 135-139 | 5L |  |
| getEmbeddingModels | `src/vector/factory.ts` | 144-166 | 23L | ✓ |
| getVectorStoreByModel | `src/vector/factory.ts` | 188-208 | 21L | ✓ |
| ensureVectorStoreConnected | `src/vector/factory.ts` | 211-218 | 8L | ✓ |
| walkMarkdownFiles | `src/verify/handler.ts` | 39-57 | 19L |  |
| verifyKnowledgeBase | `src/verify/handler.ts` | 62-216 | 155L | ✓ |

## Interfaces & Types

| Name | File | Lines | Members |
|------|------|-------|---------|
| AuditHelpers | `src/audit/routes.ts` | 11-15 | hasSessionAuth, isTrustedRequest, requireBeastIdentity |
| BoardHelpers | `src/board/routes.ts` | 11-16 | hasSessionAuth, requireBeastIdentity, isTrustedRequest, wsBroadcast |
| ChromaDocument | `src/chroma-mcp.ts` | 43-47 | id, document, metadata |
| FetchOptions | `src/cli/http.ts` | 13-17 | method, body, query |
| DaemonHelpers | `src/daemons/routes.ts` | 312-315 | hasSessionAuth, isTrustedRequest |
| DashboardHelpers | `src/dashboard/routes.ts` | 9-25 | hasSessionAuth, handleDashboardSummary, handleDashboardActivity, handleDashboardGrowth, handleStats... |
| DmHelpers | `src/dm/routes.ts` | 16-23 | hasSessionAuth, requireBeastIdentity, isTrustedRequest, wsBroadcast, sendDm... |
| DmConversation | `src/dm/types.ts` | 7-13 | id, participant1, participant2, createdAt, updatedAt |
| DmMessage | `src/dm/types.ts` | 15-22 | id, conversationId, sender, content, readAt... |
| EnsureServerOptions | `src/ensure-server.ts` | 32-37 | timeout, verbose |
| FilesHelpers | `src/files/routes.ts` | 53-60 | hasSessionAuth, isTrustedRequest, isLocalNetwork, verifySessionToken, uploadsDir... |
| ForgeHelpers | `src/forge/routes.ts` | 32-36 | hasSessionAuth, isTrustedRequest, wsBroadcast |
| MatchedSession | `src/forge/routes.ts` | 319-323 | date, session_title, sets |
| OracleEntry | `src/forum/mentions.ts` | 16-19 | tmux, workspace |
| OracleRegistry | `src/forum/mentions.ts` | 21-21 | - |
| SubscriptionLevel | `src/forum/mentions.ts` | 149-149 | - |
| ForumHelpers | `src/forum/routes.ts` | 16-23 | hasSessionAuth, requireBeastIdentity, isTrustedRequest, wsBroadcast, withRetry... |
| ThreadStatus | `src/forum/types.ts` | 12-12 | - |
| MessageRole | `src/forum/types.ts` | 13-13 | - |
| ForumThread | `src/forum/types.ts` | 15-26 | id, title, createdBy, status, issueUrl... |
| ForumMessage | `src/forum/types.ts` | 28-44 | id, threadId, role, content, author... |
| ParsedIssueUrl | `src/forum/types.ts` | 50-55 | owner, repo, issueNumber, url |
| OracleThreadInput | `src/forum/types.ts` | 77-84 | message, threadId, title, role, model... |
| OracleThreadOutput | `src/forum/types.ts` | 86-97 | threadId, messageId, oracleResponse, status, issueUrl... |
| OracleSyncInput | `src/forum/types.ts` | 100-103 | threadId, createIssue |
| OracleSyncOutput | `src/forum/types.ts` | 105-109 | synced, issueUrl, messagesSync |
| OracleListThreadsInput | `src/forum/types.ts` | 112-116 | status, limit, offset |
| OracleListThreadsOutput | `src/forum/types.ts` | 118-129 | threads, total |
| ForumConfig | `src/forum/types.ts` | 135-144 | defaultRepo, autoAnswer, autoSync, labels |
| GovernanceHelpers | `src/governance/routes.ts` | 5-12 | hasSessionAuth, requireBeastIdentity, addMessage, sendDm, withRetry... |
| GuestHelpers | `src/guest/routes.ts` | 12-18 | wsBroadcast, withRetry, getTmuxStatus, normalizeAvatarUrl, uploadsDir |
| InboxHelpers | `src/inbox/routes.ts` | 8-12 | isTrustedRequest, wsBroadcast, repoRoot |
| IntegrationsHelpers | `src/integrations/routes.ts` | 42-46 | hasSessionAuth, isTrustedRequest, isForgeAuthorized |
| KnowledgeHelpers | `src/knowledge/routes.ts` | 351-353 | repoRoot |
| LibraryHelpers | `src/library/routes.ts` | 5-11 | hasSessionAuth, requireBeastIdentity, searchIndexUpsert, searchIndexDelete, wsBroadcast |
| EnqueueOpts | `src/notify.ts` | 33-43 | from, sentAt |
| PackHelpers | `src/pack/routes.ts` | 14-23 | hasSessionAuth, requireBeastIdentity, isTrustedRequest, wsBroadcast, getTmuxStatus... |
| ShutdownableService | `src/process-manager/GracefulShutdown.ts` | 22-24 | - |
| CloseableResource | `src/process-manager/GracefulShutdown.ts` | 26-28 | - |
| GracefulShutdownConfig | `src/process-manager/GracefulShutdown.ts` | 33-48 | server, services, resources, cleanup, removePid... |
| HealthCheckOptions | `src/process-manager/HealthMonitor.ts` | 15-24 | baseUrl, healthPath, readinessPath, shutdownPath |
| LogLevel | `src/process-manager/logger.ts` | 6-6 | - |
| Logger | `src/process-manager/logger.ts` | 8-14 | - |
| PidInfo | `src/process-manager/ProcessManager.ts` | 48-53 | pid, port, startedAt |
| SpawnDaemonOptions | `src/process-manager/ProcessManager.ts` | 271-284 | scriptPath, port, portEnvVar, env, args... |
| ProwlHelpers | `src/prowl/routes.ts` | 8-14 | hasSessionAuth, isTrustedRequest, requireBeastIdentity, wsBroadcast, enqueueNotification |
| QueueHelpers | `src/queue/routes.ts` | 5-7 | isTrustedRequest |
| RemoteHelpers | `src/remote/routes.ts` | 7-10 | isLocalNetwork, hasSessionAuth |
| RiskHelpers | `src/risk/routes.ts` | 7-11 | hasSessionAuth, requireBeastIdentity, wsBroadcast |
| SchedulerHelpers | `src/scheduler/routes.ts` | 295-298 | hasSessionAuth, requireBeastIdentity |
| SearchHelpers | `src/search/routes.ts` | 261-266 | hasSessionAuth, isLocalNetwork, isTrustedRequest, handleSearch |
| AppEnv | `src/server.ts` | 221-221 | - |
| SessionInfo | `src/server.ts` | 366-370 | valid, role, data |
| TokenValidationResult | `src/server/beast-tokens.ts` | 224-243 | - |
| ProjectContext | `src/server/context.ts` | 8-22 | github, owner, repo, ghqPath, root... |
| GuestAccount | `src/server/guest-accounts.ts` | 10-29 | id, username, password_hash, display_name, bio... |
| GuestAuditEntry | `src/server/guest-accounts.ts` | 31-37 | id, guest_id, endpoint, method, created_at |
| InjectionScanResult | `src/server/guest-safety.ts` | 31-34 | flagged, patterns |
| RateWindow | `src/server/guest-safety.ts` | 54-57 | count, windowStart |
| Role | `src/server/rbac.ts` | 11-11 | - |
| AllowlistEntry | `src/server/rbac.ts` | 18-21 | method, pattern |
| ServerRoutesHelpers | `src/server/routes.ts` | 31-35 | hasSessionAuth, wsBroadcast, webPresence |
| SecurityEventType | `src/server/security-logger.ts` | 18-39 | - |
| SecuritySeverity | `src/server/security-logger.ts` | 41-41 | - |
| SecurityEvent | `src/server/security-logger.ts` | 43-52 | eventType, severity, actor, actorType, target... |
| SearchResult | `src/server/types.ts` | 5-15 | id, type, content, source_file, concepts... |
| SearchResponse | `src/server/types.ts` | 17-22 | results, total, offset, limit |
| StatsResponse | `src/server/types.ts` | 24-35 | total, by_type, concepts, last_indexed, is_stale... |
| GraphResponse | `src/server/types.ts` | 37-49 | nodes, links |
| DashboardSummary | `src/server/types.ts` | 51-68 | documents, concepts, activity, health |
| HealthResponse | `src/server/types.ts` | 70-74 | status, server, port |
| DashboardActivity | `src/server/types.ts` | 76-92 | searches, learnings, days |
| DashboardGrowth | `src/server/types.ts` | 94-102 | period, days, data |
| SettingsHelpers | `src/settings/routes.ts` | 4-8 | getSetting, setSetting, logSecurityEvent |
| SpecsHelpers | `src/specs/routes.ts` | 14-19 | hasSessionAuth, requireBeastIdentity, isTrustedRequest, wsBroadcast |
| TeamsHelpers | `src/teams/routes.ts` | 5-7 | hasSessionAuth |
| TelegramBot | `src/telegram/routes.ts` | 12-22 | token, beast, chatId, offset, lastMessageAt... |
| TelegramHelpers | `src/telegram/routes.ts` | 251-255 | hasSessionAuth, isTrustedRequest, uploadsDir |
| OracleThreadInput | `src/tools/forum.ts` | 22-28 | message, threadId, title, role, model |
| OracleThreadsInput | `src/tools/forum.ts` | 30-34 | status, limit, offset |
| OracleThreadReadInput | `src/tools/forum.ts` | 36-39 | threadId, limit |
| OracleThreadUpdateInput | `src/tools/forum.ts` | 41-44 | threadId, status |
| ToolContext | `src/tools/types.ts` | 14-21 | db, sqlite, repoRoot, vectorStore, vectorStatus... |
| ToolResponse | `src/tools/types.ts` | 23-26 | content, isError |
| OracleSearchInput | `src/tools/types.ts` | 32-41 | query, type, limit, offset, mode... |
| OracleReflectInput | `src/tools/types.ts` | 43-43 | - |
| OracleLearnInput | `src/tools/types.ts` | 45-50 | pattern, source, concepts, project |
| OracleListInput | `src/tools/types.ts` | 52-56 | type, limit, offset |
| OracleStatsInput | `src/tools/types.ts` | 58-58 | - |
| OracleConceptsInput | `src/tools/types.ts` | 60-63 | limit, type |
| OracleSupersededInput | `src/tools/types.ts` | 65-69 | oldId, newId, reason |
| OracleHandoffInput | `src/tools/types.ts` | 71-74 | content, slug |
| OracleInboxInput | `src/tools/types.ts` | 76-80 | limit, offset, type |
| OracleVerifyInput | `src/tools/types.ts` | 82-85 | check, type |
| OracleScheduleAddInput | `src/tools/types.ts` | 87-93 | date, event, time, notes, recurring |
| OracleScheduleListInput | `src/tools/types.ts` | 95-102 | date, from, to, filter, status... |
| OracleReadInput | `src/tools/types.ts` | 104-107 | file, id |
| TraceHelpers | `src/trace/routes.ts` | 10-13 | hasSessionAuth, isTrustedRequest |
| FoundFile | `src/trace/types.ts` | 7-12 | path, type, matchReason, confidence |
| FoundCommit | `src/trace/types.ts` | 14-21 | hash, shortHash, date, message, filesChanged... |
| FoundIssue | `src/trace/types.ts` | 23-29 | number, title, state, url, matchReason |
| CreateTraceInput | `src/trace/types.ts` | 32-47 | query, queryType, foundFiles, foundCommits, foundIssues... |
| ListTracesInput | `src/trace/types.ts` | 49-56 | query, project, status, depth, limit... |
| GetTraceInput | `src/trace/types.ts` | 58-61 | traceId, includeChain |
| DistillTraceInput | `src/trace/types.ts` | 63-67 | traceId, awakening, promoteToLearning |
| TraceRecord | `src/trace/types.ts` | 70-100 | id, traceId, query, queryType, foundFiles... |
| TraceSummary | `src/trace/types.ts` | 102-113 | traceId, query, scope, depth, fileCount... |
| CreateTraceResult | `src/trace/types.ts` | 115-125 | success, traceId, depth, summary |
| ListTracesResult | `src/trace/types.ts` | 127-131 | traces, total, hasMore |
| TraceChainResult | `src/trace/types.ts` | 133-138 | chain, totalDepth, hasAwakening, awakeningTraceId |
| OracleDocumentType | `src/types.ts` | 6-6 | - |
| OracleDocument | `src/types.ts` | 12-21 | id, type, source_file, content, concepts... |
| OracleMetadata | `src/types.ts` | 26-34 | id, type, source_file, concepts, created_at... |
| SearchResult | `src/types.ts` | 39-43 | document, score, source |
| OracleSearchInput | `src/types.ts` | 48-52 | query, type, limit |
| OracleConsultInput | `src/types.ts` | 54-57 | decision, context |
| OracleReflectInput | `src/types.ts` | 59-61 | - |
| OracleListInput | `src/types.ts` | 66-70 | type, limit, offset |
| OracleSearchOutput | `src/types.ts` | 75-78 | results, total |
| OracleConsultOutput | `src/types.ts` | 80-84 | principles, patterns, guidance |
| OracleReflectOutput | `src/types.ts` | 86-88 | principle |
| OracleListOutput | `src/types.ts` | 93-107 | documents, total, limit, offset, type |
| HybridSearchOptions | `src/types.ts` | 112-115 | ftsWeight, vectorWeight |
| IndexerConfig | `src/types.ts` | 120-129 | repoRoot, dbPath, chromaPath, sourcePaths |
| GitStatusCounts | `src/vault/handler.ts` | 148-152 | added, modified, deleted |
| InitResult | `src/vault/handler.ts` | 201-205 | repo, vaultPath, created |
| SyncResult | `src/vault/handler.ts` | 242-249 | dryRun, added, modified, deleted, commitHash... |
| PullResult | `src/vault/handler.ts` | 367-370 | files, project |
| VaultStatusResult | `src/vault/handler.ts` | 427-438 | enabled, repo, lastSync, vaultPath, pending |
| RepoInfo | `src/vault/migrate.ts` | 65-69 | repoPath, project, fileCount |
| MigrateResult | `src/vault/migrate.ts` | 71-77 | reposFound, filesCopied, repos, skipped, symlinked |
| VectorStoreConfig | `src/vector/factory.ts` | 17-33 | type, collectionName, dataPath, pythonVersion, embeddingProvider... |
| VectorDocument | `src/vector/types.ts` | 8-12 | id, document, metadata |
| VectorQueryResult | `src/vector/types.ts` | 14-19 | ids, documents, distances, metadatas |
| VectorStoreAdapter | `src/vector/types.ts` | 25-37 | name |
| EmbeddingProvider | `src/vector/types.ts` | 44-48 | name, dimensions |
| VectorDBType | `src/vector/types.ts` | 50-50 | - |
| EmbeddingProviderType | `src/vector/types.ts` | 51-51 | - |
| VerifyResult | `src/verify/handler.ts` | 15-29 | counts, missing, orphaned, drifted, untracked... |
| FileInfo | `src/verify/handler.ts` | 31-34 | relativePath, mtimeMs |
