# WIP — 2026-01-10 19:19

## Git Status
```
(clean)
```

## งานค้าง
- [ ] Configure Arthur as read-only Oracle child (remove `oracle_learn` from MCP tool list)
- [ ] Re-index existing docs with project metadata (optional)

## Context
- Migrated HTTP server to Hono.js (#21)
- Added provenance tracking: `origin`, `project`, `created_by` columns (#22)
- Auto-detect project from cwd via ghq/symlink resolution (#23)
- Server: `bun run server:ensure` (port 47778)

## Key Files
- `src/server.ts` — Hono.js HTTP server
- `src/ensure-server.ts` — Auto-start daemon with locking
- `src/server/project-detect.ts` — ghq/symlink project detection

## Search Behavior
- No project → universal only (`project IS NULL`)
- With project → project + universal
- Auto-detect from `cwd` param

---

*Ready for /clear*
