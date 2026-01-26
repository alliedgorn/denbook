# Oracle-v2 Architecture Overview

**Date**: 2026-01-21
**Repo**: Soul-Brews-Studio/oracle-v2

## Executive Summary

Oracle-v2 is a **TypeScript MCP (Model Context Protocol) server** that provides semantic knowledge management. It combines:
- **SQLite + FTS5** — Keyword search
- **ChromaDB** — Semantic/vector search
- **Hono** — HTTP server
- **React** — Dashboard

**Philosophy**: "The Oracle Keeps the Human Human"

## Architecture

```
Claude Code → MCP Server → SQLite (FTS5) + ChromaDB (vectors)
                ↓
           HTTP API (port 47778) → React Dashboard (port 3000)
                ↓
           ψ/memory/ files (principles, learnings, retrospectives)
```

## 19 MCP Tools

### Search & Discovery
- `oracle_search` — Hybrid FTS5+Vector search
- `oracle_list` — Browse documents
- `oracle_concepts` — List concept tags
- `oracle_stats` — Database statistics

### Consultation & Reflection
- `oracle_consult` — Get guidance based on principles
- `oracle_reflect` — Random wisdom for alignment

### Knowledge Management
- `oracle_learn` — Add new patterns
- `oracle_supersede` — Mark documents as outdated (Nothing is Deleted)

### Forum/Discussion
- `oracle_thread` — Multi-turn discussions
- `oracle_threads` — List threads
- `oracle_thread_read` — Full thread history
- `oracle_thread_update` — Change thread status

### Decision Tracking
- `oracle_decisions_create` — Track decisions
- `oracle_decisions_list` — List decisions
- `oracle_decisions_get` — Get decision details
- `oracle_decisions_update` — Update status

### Trace Logging
- `oracle_trace` — Log discovery sessions
- `oracle_trace_list` — Browse traces
- `oracle_trace_get` — Full trace details

## Key Patterns

### Hybrid Search
- FTS5 for keyword matching
- ChromaDB for semantic similarity
- Graceful degradation if ChromaDB unavailable

### "Nothing is Deleted"
- `oracle_supersede()` marks old docs as outdated
- Original content preserved for audit trail
- All interactions logged

### Provenance Tracking
- `origin`: mother|arthur|volt|human
- `project`: ghq-style paths
- `created_by`: indexer|oracle_learn|manual
