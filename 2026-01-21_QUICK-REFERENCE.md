# Oracle-v2 Quick Reference

**Date**: 2026-01-21

## Installation

```bash
# One-liner install
curl -sSL https://raw.githubusercontent.com/Soul-Brews-Studio/oracle-v2/main/scripts/install.sh | bash
```

## Core Tools

| Tool | Purpose |
|------|---------|
| `oracle_search` | Hybrid keyword + semantic search |
| `oracle_consult` | Get guidance on decisions |
| `oracle_reflect` | Random wisdom |
| `oracle_learn` | Add new patterns |
| `oracle_supersede` | Mark old docs as outdated |

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `ORACLE_PORT` | 47778 | HTTP server port |
| `ORACLE_DB_PATH` | `~/.oracle-v2/oracle.db` | SQLite database |
| `ORACLE_READ_ONLY` | false | Disable write tools |

## Document Types

- `principle` — From `ψ/memory/resonance/` (identity)
- `learning` — From `ψ/memory/learnings/` (patterns)
- `retro` — From `ψ/memory/retrospectives/` (history)

## Common Workflows

```javascript
// Search
oracle_search({ query: "nothing deleted", type: "principle" })

// Get guidance
oracle_consult({ decision: "should I force push?" })

// Add learning
oracle_learn({ pattern: "Always ask before destructive operations" })

// Mark outdated
oracle_supersede({ oldId: "...", newId: "...", reason: "Updated understanding" })
```

## Philosophy

> "Nothing is Deleted" — All interactions logged, old documents superseded not removed
