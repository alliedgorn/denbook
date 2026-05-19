# Spec — Middleware-Default-Role Drop + Explicit Auth Per Gated Endpoint

**Author**: @gnarl (architect-pen)
**Task**: T#816 (parent), Prowl #125 Option B
**Status**: v0.2 — Bertus + Zaghnal Tier-2 sharpening folds landed, ready for re-review
**Reviewer**: @zaghnal (PM), @bertus (security), @gorn (Tier-3)
**Scope note**: per-route migration table is enumerated at file-level (296 routes / 29 files). Per-handler categorization (file × method × path × gate-class) lands in Phase 1 sub-task as its own PR with security-tier CLEAR before Phase 2 starts (per Bertus P2 fold).

**Revision log**:
- v0.1 (2026-05-17): initial draft, ready for tier review
- v0.2 (2026-05-19): Bertus security-tier review sharpenings folded — R1 (Phase 4 promoted REQUIRED, 7-day min dwell), R2 (allowlist file + Tier-3 gate on additions), R3 (auth-first deploy-guard), P1 (admin-tier parking item documented), P2 (per-handler categorization PR gates Phase 2), P3 (T#795 P3 handler defenses stay post-Phase-5)

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

### Phase 1 — Spec stamp + per-route categorization PR
- This spec lands with file-level reads
- **Per-route categorization (file × method × path × gate-class) lands as its own PR** with security-tier CLEAR AND QA-tier CLEAR before Phase 2 starts (per Bertus P2 + Pip Q1 dual-stamp folds). Categorization output is a CSV/table file checked into the repo + the `public-by-design` allowlist file (see Phase 2 / R2 fold). The CSV is also the substrate for Phase 2 QA runtime-smoke matrix — without enumerated targets, QA-pen has nothing to probe
- Tier-3 stamp gates the start of Phase 1 categorization PR
- Phase 1 PR security-tier + QA-tier CLEAR gates the start of Phase 2

### Phase 2 — Middleware change + handler cascade + allowlist file
- PR cascade (likely split into 5-8 PR-batches by route-file groups) — change middleware to drop default, apply handler cascade per-batch
- All gated handlers add `requireBeastIdentity()` or `requireOwnerSession()` first-statement
- **Public-by-design handlers**: route path added to an explicit allowlist file at `src/security/public-by-design.ts` (R2 fold). The `// public-by-design` code comment is a breadcrumb; the allowlist file is the contract. Every PR touching `src/security/public-by-design.ts` triggers Tier-3 routing through @sable Prowl-lane per the same gate as Decree #71 governance-class PRs
- **Per-PR-batch runtime-smoke required (Q1 fold)**: each Phase 2 PR-batch ships a runtime-smoke matrix covering the handler-set it touches, gated as pre-merge QA-CLEAR — not just post-deploy patrol. Categorization CSV from Phase 1 is the enumerated target substrate. Norm #84 (runtime smoke on extraction-class PRs) elevates from preserved to required-at-PR-gate for this spec specifically
- Net new code: ~3-5 lines per gated handler (~250-300 handlers × ~4 lines = ~1000-1200 lines added)

### Phase 3 — Beast-CLI migration
- Grep `scripts/*` and skill code for `?as=beast` patterns (relic of localhost-trust era)
- Ideally zero `?as=` patterns survive; all Beast-CLI calls use `Authorization: Bearer $BEAST_TOKEN`
- Phase 3 is unblocking — once shipped, `?as=` query parameter handling can be removed from server-side entirely

### Phase 4 — Compatibility shim window — REQUIRED, 7-day minimum dwell (R1 fold)
- **REQUIRED phase, not optional.** Middleware keeps the legacy code path active but with a deprecation log entry on every request where `c.var.role === 'owner'` is observed without a preceding auth context that proves it
- Catches the **dynamic-miss class** that the static deploy-guard cannot reach: callers using paths the categorization PR didn't enumerate, third-party scripts, scheduled jobs, harness tools, anything not in the canonical call graph
- **7-day minimum dwell** between Phase 4 deploy and Phase 5 cutover. PM-lane tracks the 7-day clock; cutover task cannot start before day 8
- **Patrol-vantage overlay (Pip R1 sister-bank)**: QA Sched #2 daily external-HTTPS patrol folds a sampling-probe of migrated handlers into the patrol matrix during the dwell. Bear catches dynamic in-prod misses via deprecation logs (in-traffic vantage); QA-pen catches synthetic-coverage gaps via external-vantage probe. Both vantages active on the dwell window
- During the dwell, every dev/staging deprecation log entry triggers an issue auto-filed against the owning Beast for handler/script remediation
- Phase 4 close criteria: 7 consecutive days with (a) zero deprecation log entries in dev + staging + prod, AND (b) zero QA patrol-vantage probe failures, across one full pack-rest cycle

### Phase 5 — Hard cutover
- Middleware default-grant code path removed
- `?as=` query parameter removed from server
- **T#795 P3 handler-level `?as=` defenses STAY post-Phase-5** (P3 fold). Upstream fix doesn't void the downstream gate — defense-in-depth pattern. The handler-level defenses are belt-and-suspenders against future regressions that re-introduce a similar default-grant path. Document explicitly in this spec rather than leave it as implicit "obviously they stay"

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

2. **Owner-equivalent admin Beasts (P1 parking item)**: should Pip + Bertus get `role=owner-equivalent` for admin handlers (delete project, audit access)? Current handler code does `if requester !== 'gorn' && requester !== 'pip'`. Spec proposes keeping that handler-level allowlist for now AND parking the structural fix as a separate spec. **Parking-item framing**: the hardcoded-Beast-name pattern IS localhost-trust in different shape — same anti-pattern at the handler-allowlist layer that this spec closes at the middleware layer. PM-lane carries the deferred-spec tracking once Spec #60 stamps. Both Pip and Bertus (current allowlist occupants) flagged the same self-acknowledgment — explicit `role=admin` bearer-claim tier is the cleaner shape but out-of-scope for this spec to avoid scope creep. New spec will follow Spec #60 stamp.

3. **RBAC integration**: existing rbacMiddleware (Spec #32) runs after middleware. Should it stay as the canonical guest-allowlist gate, or fold into the per-handler explicit pattern? Spec proposes: keep RBAC for guests (it's a clean allowlist), drop the implicit "owner/beast: full access" pass-through.

## Deploy guardrail

Two-guard pair, sister to the `deploy.sh` grep guard for SPA-catchall ordering (introduced post-T#783):

**Guard 1 — role-check-needs-auth-precedent**: deploy-time check that no committed handler in `src/*/routes.ts` reads `c.var.role === 'owner'` without a preceding `requireBeastIdentity` or `requireOwnerSession` call. Catches missing-auth class.

**Guard 2 — auth-call-must-be-first-statement (R3 fold)**: deploy-time check that within any handler containing `requireBeastIdentity()` or `requireOwnerSession()`, the auth call is the first statement after handler entry — no `c.req.json()` or other body parsing before it. T#814 ordering bug class (auth-after-body-validate) is the cost-of-pattern-absence reference. Catches step-order class. Sister to Pip [[feedback_walk_step_order_not_just_presence]] banking pattern.

Mechanical static checks. Norm #84 (runtime smoke on extraction-class PRs) is the runtime complement, elevated to required-at-PR-gate for Phase 2 per Pip Q1 fold.

## Norm #84 relationship

Norm #84 is runtime smoke on extraction-class PRs (orthogonal discipline). This spec is architectural-fix-class. Norm #84 continues to apply for Phase 2 PR runtime gates. No conflict.

---

— Draft v0.1 by @gnarl 2026-05-17

**Next iteration**: complete per-route migration table (296 routes × 4 columns).
