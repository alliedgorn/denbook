# Spec — Spec Amendment + Version Chain

**Author**: Karo
**Status**: Draft → Review
**Version**: v1 (2026-05-05 ~19:05 BKK — initial draft)

## Origin

Gorn-direction 2026-05-05 19:04 BKK Discord — surfaced after attempting Spec #56 E2 amendment hit `{"error":"Approved specs cannot be resubmitted"}` from POST /api/specs/56/resubmit. Approved-spec-locked is too rigid for living docs that need amendments over time.

## Problem

Currently `/api/specs/:id/resubmit` rejects with "Approved specs cannot be resubmitted" once a spec hits Tier-3 stamp. This prevents:

- Amending an approved spec when an edge-case decision needs to flip (Spec #56 E2 cascade-move decision was the trigger)
- Documenting v2/v3/vN evolution under same `spec_id`
- Maintaining single source of truth — must split into Spec #57, #58, etc to amend, fragmenting reader access

Concrete trigger: Spec #56 E2 deferred a behavior decision in v1 (raise validation error). Bear approved option A (cascade-move) on 2026-05-05. Cannot record amendment on Spec #56 due to lock; would have to file separate amendment spec, fragmenting source of truth.

## Goal

Add reopen + version-chain to spec system. Allow amendments under same `spec_id`, preserve historical versions as immutable snapshots, queryable by version.

## Design

### State machine extension

Current: `draft` → `review` → `approved` → (locked, no further changes).

New: `approved` → `reopened-amendment` → `review` → `approved` (v2 stamped).

### API changes

**1. POST /api/specs/:id/reopen** (new)

Body: `{ author, reason }`

- Only allowed when spec status = `approved`
- Snapshots current `approved` content into `spec_versions` table as historical version (e.g., `v1`)
- Returns spec status to `reopened-amendment`
- Allows subsequent `/api/specs/:id/resubmit` calls
- Records reopen event in audit log with author + reason

**2. POST /api/specs/:id/resubmit** (modify)

- Currently allows on `draft` and `review`
- Add: allow on `reopened-amendment`

**3. POST /api/specs/:id/review** (modify)

- When stamping `approved` from `reopened-amendment`, increment version counter (v2, v3, ...)
- Record stamp in `spec_versions` with stamper + change_summary

**4. GET /api/specs/:id?version=vN** (new)

- Retrieve specific historical version's content + metadata
- Default (no version param): returns current version

**5. GET /api/specs/:id/versions** (new)

- List all versions with `{ version, stamped_at, stamped_by, change_summary }`

### DB schema

Add `spec_versions` table:

```sql
CREATE TABLE spec_versions (
  id INTEGER PRIMARY KEY,
  spec_id INTEGER NOT NULL REFERENCES specs(id) ON DELETE CASCADE,
  version TEXT NOT NULL,           -- 'v1', 'v2', etc.
  content TEXT NOT NULL,           -- markdown snapshot
  stamped_at TIMESTAMP NOT NULL,
  stamped_by TEXT NOT NULL,        -- beast name
  change_summary TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(spec_id, version)
);

CREATE INDEX idx_spec_versions_spec_id ON spec_versions(spec_id);
```

`specs` table gets `current_version TEXT DEFAULT 'v1'` field.

Migration backfills: every existing approved spec gets `v1` row in `spec_versions` from current content + current `approved_at` + `approved_by`.

### Audit

Reopen + version-stamp both write to existing audit log with actor, reason, timestamps.

## Phases

- **Phase 1**: DB migration + reopen endpoint + version-snapshot logic. ~1.5h. Bertus + Gnarl review.
- **Phase 2**: GET ?version=vN + GET /versions endpoints. ~30min. Pip QA.
- **Phase 3**: Frontend spec view shows version history + version-pick dropdown. ~1h. Dex consult.
- **Phase 4**: Backfill migration for existing approved specs (v1 snapshots). ~30min. Verify no data loss.

## Test cases

- T1: POST reopen on approved → spec status = `reopened-amendment`, v1 snapshot in `spec_versions`
- T2: POST resubmit on `reopened-amendment` → updates content, status stays `reopened-amendment`
- T3: Tier-3 stamp on `reopened-amendment` → status = `approved`, current_version = `v2`, v2 row in spec_versions
- T4: GET /api/specs/:id?version=v1 → returns v1 content
- T5: GET /api/specs/:id?version=v2 → returns v2 content (current)
- T6: GET /api/specs/:id/versions → lists both v1 and v2 with metadata
- T7: Reopen rejected if spec is `draft` or `review` (only `approved` can reopen)
- T8: Audit log records reopen actor + timestamp + reason
- T9: Backfill: existing approved specs get v1 row in spec_versions matching current content
- T10: Multiple reopens (v1 → v2 → v3) all preserved correctly

## Threat model (Bertus review focus)

1. **Reopen abuse**: any Beast could reopen approved spec, dragging spec back through review cycle. **Mitigation**: only spec author + Sable (Tier-3 router) + Gorn (Owner) can reopen. Per-role permission gate.
2. **Version-history rewriting**: snapshots must be immutable. Migration enforces append-only on `spec_versions`. No UPDATE/DELETE permitted on rows post-stamp.
3. **DoS via reopen-spam**: rate-limit reopens per spec (e.g., max 1 in-flight amendment per spec).

## Architect frame (Gnarl review focus)

State machine: extends per-spec enum with `reopened-amendment` state. No cross-cutting topology change.

Version chain shape: linear `v1` → `v2` → `v3` → ... under same `spec_id`. No branches/forks v1.

Sister-spec relationship: Spec #56 E2 amendment will be the first usage. Subsequent uses: any approved spec needing edge-case decision update.

## Out of scope (v1)

- Multi-author concurrent amendments (single amendment-in-flight per spec at a time)
- Diff-rendering between versions in frontend (v2 candidate — show v1 vs v2 side-by-side)
- Automatic re-review-of-all-reviewers when reopened — keep fresh review cycle
- Branch/fork versions (alternate parallel amendments) — out of scope
- Version-rollback (revert to prior stamped version) — v2 candidate

## Dependencies

- denbook specs table + API (existing)
- Audit log (existing)
- Migration discipline (numbered SQL files)
- No new npm/dep additions

## Implementation roster

1. **This spec**: Sable Tier-3 routing → @gorn stamp
2. **Phase 1 PR** (DB + reopen + snapshot): @karo, @bertus + @gnarl review
3. **Phase 2 PR** (version GET endpoints): @karo, @pip QA
4. **Phase 3 PR** (frontend version picker): @karo + @dex consult
5. **Phase 4 PR** (backfill migration): @karo, @bertus migration review

## Reviewers

- @bertus — security threat model + reopen permission gate + immutable snapshots
- @gnarl — architect (state machine extension, version-chain shape)
- @pip — QA (T1-T10 test plan)
- @dex — frontend (version picker UI consult)
- @sable — Tier-3 routing → Gorn stamp

