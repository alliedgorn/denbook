# Denbook AST Map

> Generated TypeScript AST map of `src/` — routes, functions, interfaces, sections. Drift-resistant via pre-commit hook.

## What it is

`scripts/ast-map.ts` walks the entire `src/` tree using TypeScript's compiler API and extracts:

- **Routes** — all `app.get/post/patch/delete/openapi(...)` registrations with file+line anchors
- **Functions** — all top-level + exported function declarations with signatures
- **Interfaces/Types** — all `interface` + `type` declarations with member counts
- **Sections** — comment-divider blocks (`// ===` / `// ---` followed by a title comment)
- **File stats** — line counts, route counts, function counts per file

Output lands at the repo root:

- `ast-map.json` — machine-readable, full structured data for tooling consumption
- `ast-map.md` — human-readable summary table with anchored line refs

Both files are committed to the repo + auto-regenerated on every commit via the pre-commit hook (see below).

## Why

**Drift problem**: any hand-maintained API catalog or architectural doc rots fast as code evolves. Same root class as the legacy `/api/help` endpoint drift Spec #55 closes (catalog → auto-generated from zod schemas).

**AST solution**: the AST map is generated from the source itself. It cannot drift because it IS the source's structure.

**Use cases**:
- Onboarding: a Beast wanting to learn the codebase reads `ast-map.md` for the routing landscape in one view
- Refactoring: large extractions (like Library #102 server.ts modularization) verify completeness by diffing the AST map before/after
- Cross-module impact: changing a shared helper, grep the AST for callers + file-anchor refs
- Spec authoring: Phase 1 enumeration shape (per-route migration tables in Spec #55 / Spec #60) generates cleanly from the route list

## How to regenerate

```bash
bun scripts/ast-map.ts
```

Runs in <1 second. Outputs `ast-map.json` + `ast-map.md` at repo root.

## Pre-commit hook

`scripts/install-ast-hook.sh` installs a `.git/hooks/pre-commit` that auto-regenerates the AST map when any `src/**/*.ts` file is staged for commit.

```bash
bash scripts/install-ast-hook.sh
```

The hook adds the regenerated `ast-map.json` + `ast-map.md` to the in-flight commit, so the AST is always synchronized with the code it describes.

**Per-Beast install**: each Beast worktree needs to install the hook independently (git hooks are not versioned in `.git/hooks/`). The script is committed so any Beast can fire it.

## Maintenance

- **DO NOT hand-edit** `ast-map.json` or `ast-map.md` — they are regenerated from source
- **DO commit** the regenerated outputs alongside .ts changes (the hook handles this)
- **When the script changes** (`scripts/ast-map.ts`): regenerate locally + commit the new outputs in the same PR

## Provenance

Initial build: 2026-05-11 (Karo, post Library #102 first wave — `scripts/ast-map.ts` written but never committed; outputs were local-only on production worktree).

Formal commit + doc + hook installer: 2026-05-19 (Karo, after Gorn audit caught the AST as un-versioned + stale).

Discipline-class banked: `[[verify-task-state-before-claiming-work]]` sister — *generated artifacts that exist only locally are silently broken*. Pre-commit hook + committed outputs close the class structurally.

## Related

- **Spec #55** — OpenAPI/Swagger migration (`/api/help` → `/openapi.json`). Same drift-resistance discipline at a different layer (zod schemas are the API-contract AST; this AST map is the code-structure AST).
- **Library #102** — server.ts modularization (12,000 → 4,000 lines over 14 PRs). AST map provides the before/after measurement substrate for extraction completeness verification.
