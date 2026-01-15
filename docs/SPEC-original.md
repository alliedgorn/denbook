---
title: Oracle v2 - MCP Memory Layer (Original Specification)
created: 2025-12-29
archived: 2026-01-15
status: historical
learned-from: claude-mem
note: This is the original planning document with implementation annotations.
---

# Oracle v2 - Original Specification (Dec 2025)

> **📜 Historical Document**: Original planning spec from Dec 29, 2025.
> Annotated with what was actually implemented by Jan 15, 2026.
>
> | Planned | Delivered |
> |---------|-----------|
> | 3 tools | **19 tools** |
> | Skills approach | **MCP-first** |
> | 3 phases | **6 phases** |

**Legend**: ✅ Implemented | ⚡ Exceeded | 🔄 Changed | ❌ Not done

---

## Vision ✅

Oracle v2 transforms the existing Oracle philosophy files into a **searchable knowledge system** via MCP, allowing Claude to:

1. ✅ **Consult** Oracle philosophy when making decisions
2. ✅ **Learn** from patterns in resonance files
3. ✅ **Search** retrospectives and learnings semantically
4. ✅ **Grow** by adding new patterns over time

---

## Architecture 🔄

### Original Plan
```
Claude Code → Skills Layer → MCP Server → SQLite + Chroma
```

### What Was Built ⚡
```
Claude Code → MCP Server (stdio) → SQLite + ChromaDB + Drizzle ORM
                    ↓
              HTTP Server (Hono.js :47778)
                    ↓
              React Dashboard (:3000)
```

**Changes:**
- ❌ Skills layer removed - MCP tools work better in practice
- ⚡ Added HTTP API (Hono.js) - REST endpoints for external access
- ⚡ Added React Dashboard - Visual knowledge graph
- ⚡ Added Drizzle ORM - Type-safe database queries

---

## Data Model ✅

### Source Files
```
ψ/memory/
├── resonance/       ✅ IDENTITY (principles)
├── learnings/       ✅ PATTERNS (what I've learned)
├── retrospectives/  ✅ HISTORY (session records)
└── logs/            ✅ EPHEMERAL (not indexed)
```

### Document Structure ✅
```typescript
interface OracleDocument {
  id: string;           // ✅ Implemented
  type: 'principle' | 'pattern' | 'learning' | 'retro';  // ✅
  source_file: string;  // ✅
  content: string;      // ✅
  concepts: string[];   // ✅
  created_at: number;   // ✅
  updated_at: number;   // ✅
}
```

---

## MCP Tools

### Planned: 3 Tools

| Tool | Status | Notes |
|------|--------|-------|
| `oracle_search` | ✅ | Hybrid FTS5 + vector search |
| `oracle_consult` | ✅ | Decision guidance with synthesis |
| `oracle_learn` | ✅ | Creates markdown files in ψ/memory/learnings/ |

### Actually Delivered: 19 Tools ⚡

| Category | Tools | Notes |
|----------|-------|-------|
| **Core (4)** | `search`, `consult`, `reflect`, `learn` | Original + reflect |
| **Discovery (3)** | `list`, `stats`, `concepts` | Browse & explore |
| **Threads (4)** | `thread`, `threads`, `thread_read`, `thread_update` | Forum discussions |
| **Decisions (4)** | `decisions_list`, `decisions_create`, `decisions_get`, `decisions_update` | Decision tracking |
| **Traces (3)** | `trace`, `trace_list`, `trace_get` | Discovery logging |
| **Evolution (1)** | `supersede` | "Nothing is Deleted" |

---

## Implementation Plan

### Original: 3 Phases

| Phase | Plan | Status |
|-------|------|--------|
| Phase 1: Read-Only | Index + search + reflect | ✅ Done Dec 29 |
| Phase 2: Bidirectional | Learn + pattern detection | ✅ Done Jan 2 |
| Phase 3: Context Injection | SessionStart hooks | 🔄 Changed approach |

### Actual: 6 Phases ⚡

| Phase | Dates | What Happened |
|-------|-------|---------------|
| 0. Genesis | Sept-Dec 2025 | Philosophy foundations |
| 1. Conception | Dec 24-27 | MCP server idea |
| 2. MVP | Dec 29 - Jan 2 | FTS5 + ChromaDB hybrid |
| 3. Maturation | Jan 3-6 | Drizzle ORM, AI-to-AI |
| 4. Features | Jan 7-11 | Threads, decisions, traces, dashboard |
| 5. Release | Jan 15 | Open source |

See [TIMELINE.md](../TIMELINE.md) for full history.

---

## Key Design Decisions

### 1. Skill > MCP Tools 🔄 CHANGED

**Original**: Skills for progressive disclosure (~250 tokens vs ~2500)

**Reality**: MCP tools won. Claude Code handles tool loading efficiently. Skills added complexity without benefit.

### 2. Local Embeddings ✅

**Original**: ChromaDB + sentence-transformers

**Reality**: Implemented as planned. Zero API cost, works offline.

### 3. Source-of-Truth = Files ✅

**Original**: Markdown files in git, SQLite/Chroma are indexes

**Reality**: Exactly as planned. Human-editable, auditable.

### 4. No Recency Window ✅

**Original**: Oracle principles are timeless, unlike claude-mem's 90-day window

**Reality**: Confirmed. All patterns remain relevant.

### 5. Concept Tags ✅

**Original**: Enable filtered search by concept

**Reality**: Implemented via `oracle_concepts()` tool.

---

## Questions to Resolve ✅ ALL RESOLVED

| Question | Resolution |
|----------|------------|
| Where to run MCP server? | **stdio** - Claude Code native, no ports needed |
| Auto-update vectors? | **On session start** - Check indexing status |
| Handle conflicts? | **Files win** - Oracle reindexes from source |

---

## Success Metrics

| Metric | Planned | Actual |
|--------|---------|--------|
| Oracle usage | Count calls | ✅ `search_log` table |
| Pattern application | Track in output | 🔄 Via `consult_log` |
| Knowledge growth | New learnings/week | ✅ `learn_log` table |
| Decision alignment | Retrospective feedback | ⚡ `oracle_decisions_*` system |

---

## Original Next Steps ✅ ALL DONE

- [x] Create ψ/lab/oracle-v2/prototype.ts → Became `src/index.ts`
- [x] Test Chroma indexing → Works with 5,500+ documents
- [x] Create oracle skill → Evolved to 19 MCP tools
- [x] Test in real session → Production since Jan 15

---

## What Exceeded Expectations ⚡

Features not in original spec that emerged organically:

1. **Forum Threads** - Multi-turn Oracle discussions
2. **Decision Tracking** - Full lifecycle (pending → decided → implemented)
3. **Trace Logging** - Discovery sessions with dig points
4. **Supersede Pattern** - "Nothing is Deleted" implementation
5. **React Dashboard** - Visual knowledge graph
6. **HTTP API** - REST endpoints for external tools
7. **Auto-bootstrap** - Works on fresh install without setup

---

*Original: 2025-12-29 10:35*
*Archived: 2026-01-15 12:14*
*Annotations added to show planned vs delivered*
