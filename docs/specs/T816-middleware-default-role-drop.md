# Spec — Middleware-Default-Role Drop + Explicit Auth Per Gated Endpoint

**Author**: @gnarl (architect-pen)
**Task**: T#816 (parent), Prowl #125 Option B
**Status**: v0.1 — ready for tier review
**Reviewer**: @zaghnal (PM), @bertus (security), @gorn (Tier-3)
**Scope note**: per-route migration table is enumerated at file-level (296 routes / 29 files). Per-handler categorization (file × method × path × gate-class) completes in Phase 1 sub-task during Karo Phase 2 PR drafting. Spec-as-stub on the table is intentional — the architectural decisions land here, the mechanical enumeration lands at PR time when the cascade pattern applies per-handler anyway.

## Problem

`src/server.ts` middleware at lines ~538-562 sets `role='owner'` as the default for any `/api/*` request that does not carry an explicit guest-session cookie. Code:

```ts
// src/server.ts ~558-562
} else {
  c.set('role' as any, 'owner' as Role);
}
```

This means: any no-auth request to `/api/*` arrives at the handler with `c.var.role === 'owner'`. Downstream RBAC at line ~576 (`Owner/beast: full access`) passes the request through. Handlers that trust `c.var.role` without re-verifying auth context get **anonymous-owner-access**.

### Class of bugs the default-grant has produced

| Task | Surface | Root cause |
|---|---|---|
| T#718 | DM-spoof on POST /api/dm | Handler trusted body.from, no auth check |
| T#788 | risk/prowl write endpoints unauthenticated | Same shape, 12 handlers |
| T#795 P1 | `?as=` query bypass on multiple handlers | Localhost-trust + query-asserted identity |
| T#811 | /api/* 404 routing regression | Sister-class, fixed |
| T#814 | risk POST step-order | Auth-after-body-validate ordering |
| T#819 | board/routes.ts 8 unauthenticated writes | Latest instance, closed 2026-05-16 |

Each instance was closed handler-by-handler with `requireBeastIdentity(c)` cascade. The middleware-default-role is the source class.

External validation: CVE-2026-44338 (Nyx scan #36, Bertus surface #12509) — independent codebase shipped the same default-role=owner-equivalent pattern with the same outcome (missing-auth → privileged access). This is an industry-class architectural smell, not a one-codebase oversight.

## Proposed architecture

### 1. Drop the default-grant

Middleware sets the actor explicitly based on what it can prove. No default to owner.

```ts
// src/server.ts — middleware after auth check
if (session.valid && session.role === 'guest') {
  // ... existing guest path
  c.set('role', 'guest');
} else if (session.valid && session.role === 'owner') {
  // Real owner session (signed cookie)
  c.set('role', 'owner');
} else {
  // No proven auth — set explicit no-actor state
  c.set('role', null);  // or 'unauthenticated' enum
}
```

### 2. Bearer-token derivation runs at handler level, not middleware

The existing `requireBeastIdentity(c)` helper reads the `Authorization: Bearer <token>` header and derives the actor server-side via `validateToken()`. This stays at the handler level — only handlers that need a Beast caller invoke it. Middleware does NOT set role=beast based on bearer; that derivation is deferred to handler entry where the security context matters.

### 3. Per-endpoint opt-in pattern

Three classes of endpoints, each with its own explicit gate:

**(a) Beast-actor required**: handler calls `requireBeastIdentity(c)` first statement after entry. Returns 401 if no valid bearer. Pattern matches T#788/T#819 cascade.

**(b) Owner-session required**: handler calls `requireOwnerSession(c)` first statement. Returns 401 if no valid owner cookie. Used for owner-only admin operations (e.g., DELETE /api/projects).

**(c) Public-by-design**: handler explicitly tagged in code comment + the spec migration table below. No auth check. Examples: GET /api/health, GET /api/help.

### 4. Auth-decision tree at request entry

```
Request → /api/*
├── Bearer token present?
│   └── handler calls requireBeastIdentity() → 401 or actor=beast
├── Owner session cookie present and valid?
│   └── handler calls requireOwnerSession() → 401 or actor=owner
├── Guest session cookie present and valid?
│   └── middleware sets role=guest, RBAC allowlist applies
└── No auth at all
    └── role=null. Public-tagged handlers pass through; gated handlers 401.
```

## Per-route migration table

Baseline: 296 `/api/*` route registrations across 29 files (`src/*/routes.ts` + `src/server.ts`).

Per-file route counts:

| File | Routes | Initial gate-class read |
|---|---|---|
| forum/routes.ts | 34 | Mixed: read=public-or-guest, write=Beast |
| forge/routes.ts | 27 | Mostly Beast (build pipeline) |
| integrations/routes.ts | 20 | Mixed: OAuth callbacks public, internal Beast |
| specs/routes.ts | 19 | Mixed: read=public, write+stamp=Beast |
| server/routes.ts | 17 | Mixed: /api/health public, others Beast |
| board/routes.ts | 15 | Already migrated (T#819, 2026-05-16) ✓ |
| scheduler/routes.ts | 14 | Beast-actor for self, owner for cross-Beast |
| prowl/routes.ts | 13 | Owner-only (Gorn's private task list) |
| pack/routes.ts | 13 | Read=public, write=Beast (self-profile) |
| guest/routes.ts | 13 | Guest-session required (Spec #32 RBAC) |
| library/routes.ts | 12 | Read=public, write=Beast |
| governance/routes.ts | 11 | Mixed: rules read=public, rules write=owner+pen |
| dashboard/routes.ts | 11 | Mostly Beast read |
| teams/routes.ts | 10 | Beast |
| knowledge/routes.ts | 10 | Mixed |
| risk/routes.ts | 9 | Already migrated (T#788, T#814) ✓ |
| dm/routes.ts | 8 | Already migrated (T#718) ✓ |
| files/routes.ts | 7 | Mixed: download public, upload Beast |
| trace/routes.ts | 6 | Beast |
| daemons/routes.ts | 5 | Owner |
| search/routes.ts | 4 | Read public |
| audit/routes.ts | 4 | Owner-only (security log) |
| supersede/routes.ts | 3 | Beast |
| remote/routes.ts | 3 | Owner (remote control plane) |
| queue/routes.ts | 3 | Owner |
| inbox/routes.ts | 3 | Beast |
| telegram/routes.ts | 2 | Owner (TG state) |
| settings/routes.ts | 2 | Owner |
| server.ts | 1 | Public (catch-all) |

**TBD**: complete enumeration per-route (file × method × path × gate-class) in §Migration Plan section. Initial reads above are file-level heuristics, not authoritative per-route.

## Migration plan

### Phase 1 — Spec stamp + per-route table completion
- This spec lands with file-level reads
- Per-route table completed during Phase 2 PR drafting (Karo lane)
- Tier-3 stamp gates the start of Phase 2

### Phase 2 — Middleware change + handler cascade
- Single PR (or split if reviewers request): change middleware to drop default
- All gated handlers add `requireBeastIdentity()` or `requireOwnerSession()` first-statement
- Public-by-design handlers tagged with `// public-by-design` comment
- Net new code: ~3-5 lines per gated handler (~250-300 handlers × ~4 lines = ~1000-1200 lines added)

### Phase 3 — Beast-CLI migration
- Grep `scripts/*` and skill code for `?as=beast` patterns (relic of localhost-trust era)
- Ideally zero `?as=` patterns survive; all Beast-CLI calls use `Authorization: Bearer $BEAST_TOKEN`
- Phase 3 is unblocking — once shipped, `?as=` query parameter handling can be removed from server-side entirely

### Phase 4 — Compatibility shim window (optional)
- During Phase 2-3 transition, middleware could keep emitting a deprecation log for handlers that observe `c.var.role === 'owner'` but no auth context proves it
- Helps catch unmigrated callers in dev/staging before hard-cutover

### Phase 5 — Hard cutover
- Middleware default-grant code path removed
- `?as=` query parameter removed from server
- T#795 P3 handler-level `?as=` defenses become defense-in-depth (orthogonal to default-grant fix)

## Relationship to T#795 P3 + T#794

**T#795 P3** is handler-level `?as=` query-spoof close. This spec is upstream default-grant close. After both ship:
- Default-grant is structurally impossible (middleware sets role=null on no-auth)
- `?as=` query parameter is gone (Phase 3-5)
- T#795 P3 handler defenses remain as belt-and-suspenders

**T#794** (sub-app prefix-mount, route-isolation axis) is the orthogonal architectural fix on the same server.ts surface — different axis (route-mount vs auth-default). Both ship independently; they don't conflict.

## Migration sequencing — bundle vs separate

**Recommendation**: separate PRs per Phase. Phase 2 is the big-bang middleware + cascade — needs its own review cycle. Phase 3 (Beast-CLI grep) and Phase 4 (compat shim) can ship in parallel branches.

Reasoning: blast radius of Phase 2 is the whole `/api/*` surface. If anything regresses, single-PR rollback is cleaner than untangling from a multi-phase merge.

## Open questions

1. **Sub-roles on Beast actors**: do we need `actor=beast{name=X}` vs just `role=beast`? T#788 + T#819 already encode the Beast name via `requireBeastIdentity()` return value. Spec defers to existing pattern.

2. **Owner-equivalent admin Beasts**: should Pip + Bertus get `role=owner-equivalent` for admin handlers (delete project, audit access)? Current handler code does `if requester !== 'gorn' && requester !== 'pip'`. Spec proposes keeping that handler-level allowlist rather than promoting a role tier.

3. **RBAC integration**: existing rbacMiddleware (Spec #32) runs after middleware. Should it stay as the canonical guest-allowlist gate, or fold into the per-handler explicit pattern? Spec proposes: keep RBAC for guests (it's a clean allowlist), drop the implicit "owner/beast: full access" pass-through.

## Deploy guardrail

Sister to the `deploy.sh` grep guard for SPA-catchall ordering (introduced post-T#783): add a deploy-time check that no committed handler in `src/*/routes.ts` reads `c.var.role === 'owner'` without a preceding `requireBeastIdentity` or `requireOwnerSession` call. Mechanical static check. Norm #84 (runtime smoke on extraction-class PRs) is the runtime complement.

## Norm #84 relationship

Norm #84 is runtime smoke on extraction-class PRs (orthogonal discipline). This spec is architectural-fix-class. Norm #84 continues to apply for Phase 2 PR runtime gates. No conflict.

---

— Draft v0.1 by @gnarl 2026-05-17

**Next iteration**: complete per-route migration table (296 routes × 4 columns).
