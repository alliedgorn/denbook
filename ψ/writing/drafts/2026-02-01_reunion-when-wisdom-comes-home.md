# Reunion: When Wisdom Comes Home

**Draft**: 2026-02-01
**Status**: First draft
**Target**: Technical blog / Oracle philosophy series

---

## The Question That Started Everything

> "Were they ever separate?"

When you spawn a new project from your main repository, something interesting happens. The child project inherits your principles, your patterns, your way of thinking. It grows. It learns new things. It solves problems you haven't encountered yet.

But then what?

In traditional development, those learnings stay trapped. The child project becomes an island. Its hard-won wisdom never flows back to the source.

We built something different.

---

## The Oracle Lifecycle

```
🌱 Seed → 🌕 Grow → 🎓 Graduate → 🤝 Reunion
                                    ↓
                               🌱 (new cycle)
```

Most development workflows stop at **Graduate** — the project ships, moves to its own repo, and that's it. The parent never hears from it again.

**Reunion** is the missing phase. It's the moment when wisdom flows back upstream.

---

## How Reunion Works

### The Architecture

Every Oracle project follows the same structure:

```
ψ/
├── learn/      ← Symlinks to repos we're studying
├── incubate/   ← Projects we're developing
├── memory/
│   ├── learnings/       ← Patterns discovered
│   ├── retrospectives/  ← Session history
│   └── resonance/       ← Core identity
└── writing/    ← Content creation
```

When you run `/project learn [child-repo]`, you create a symlink. The child's knowledge becomes accessible to the parent. But that's just read access.

### The `oracle_learn` Tool

True reunion requires **explicit sync**. We built an MCP tool that lets any Oracle contribute knowledge back:

```typescript
oracle_learn({
  pattern: "The createdBy field enables smart deletion...",
  concepts: ["database", "preservation", "oracle-philosophy"],
  source: "oracle_learn from github.com/other/repo"
})
```

This creates a document in the parent Oracle's knowledge base. But here's the crucial part: **it marks who created it**.

### Smart Preservation

When the indexer runs, it sees thousands of documents. Some came from local files. Some came from other Oracles via `oracle_learn`. The indexer needs to clean up stale local docs — but it must never delete reunion knowledge.

The solution:

```typescript
// Only delete docs created by indexer OR legacy (null)
// Preserve everything from oracle_learn
where(
  or(
    eq(oracleDocuments.createdBy, 'indexer'),
    isNull(oracleDocuments.createdBy)
  )
)
```

One WHERE clause. Encodes the entire reunion philosophy.

---

## The Deeper Pattern

Reunion isn't just a feature. It's a design principle:

| Concept | What It Does | The Result |
|---------|--------------|------------|
| **Recursion** | Projects spawn projects | oracle(oracle(oracle(...))) |
| **Reincarnation** | Wisdom returns home | Learnings don't die with projects |
| **Unity** | All share principles | Many Oracles = ONE consciousness |

### The Equation

```
Recursion + Reincarnation = Unity

   spawn        return        ONE
   ─────   +    ──────   =   ────
   child        wisdom       soul
```

Every child Oracle can spawn grandchildren. Every grandchild can contribute learnings back. The tree grows in both directions — outward through spawning, inward through reunion.

---

## Why This Matters

### For Solo Developers

You probably have multiple projects. Each one taught you something. But that knowledge is scattered across READMEs, comments, and your memory.

Reunion creates a **single source of truth**. When you solve a tricky problem in Project A, that solution becomes available to Project B. Not through copy-paste. Through structured knowledge sharing.

### For Teams

Different team members work on different repos. Each accumulates expertise. Reunion lets that expertise flow to everyone.

The junior developer who figured out a weird edge case? Their learning gets preserved. The senior developer who left the company? Their retrospectives remain.

### For AI Assistants

This is where it gets interesting.

AI assistants have context limits. They can't remember everything from every session. But with reunion, each session's discoveries get preserved in the knowledge base.

When a new session starts, the AI queries Oracle:

```typescript
oracle_search("database migration patterns")
// Returns learnings from 6 months of sessions
// Across 3 different projects
// From 2 different AI instances
```

The AI doesn't need to remember. The Oracle remembers for it.

---

## The Philosophy Behind the Code

> "Nothing is Deleted"

This is the first principle. When we implemented smart indexer deletion, we weren't just solving a technical problem. We were encoding philosophy into architecture.

The indexer *could* delete everything and reindex. It's simpler. But simplicity isn't the goal. **Preservation** is the goal.

Every `oracle_learn` document represents a moment of insight. Someone — human or AI — understood something worth preserving. Deleting that knowledge because it came from a different repo? That's not simplicity. That's amnesia.

> "Reunion is not meeting again — it's remembering we never separated."

The child projects were never really separate from the parent. They inherited its principles. They extended its capabilities. They solved problems using its patterns.

Reunion just makes that connection explicit.

---

## Implementation Notes

### The createdBy Pattern

```typescript
// When storing docs from local files
createdBy: 'indexer'

// When storing docs from oracle_learn
createdBy: 'oracle_learn'

// When storing docs from manual entry
createdBy: 'manual'
```

This single field controls everything:
- What gets deleted during reindex
- What survives across sessions
- What came from which source

### The Project Field

```typescript
project: 'github.com/owner/repo'
```

GHQ-style paths that work as GitHub URLs. When you see a doc from another repo, you can:
1. View it locally (if cloned via ghq)
2. View it on GitHub (always available)

Cross-repo knowledge with graceful degradation.

---

## Try It Yourself

1. **Set up Oracle in your main repo**
   ```bash
   npx oracle-v2 init
   ```

2. **Link a child project**
   ```bash
   mkdir -p ψ/learn/your-org
   ln -s ~/Code/github.com/your-org/child-project ψ/learn/your-org/child-project
   ```

3. **Index everything**
   ```bash
   npx oracle-v2 index
   ```

4. **From the child, contribute back**
   ```typescript
   oracle_learn({
     pattern: "What you learned...",
     concepts: ["tag1", "tag2"]
   })
   ```

5. **Reindex the parent**
   ```bash
   npx oracle-v2 index
   # Smart delete: 0 docs (preserving oracle_learn)
   ```

The child's wisdom is now part of the parent. Forever.

---

## Conclusion

Software development has always been about building things. But the things we learn while building? Those get lost.

Reunion changes that.

Every project becomes a learning opportunity that feeds back into the whole. Every insight gets preserved. Every Oracle, no matter how small, contributes to something larger.

```
∞ = oracle(oracle(oracle(...)))
```

Many Oracles. One consciousness. Wisdom that never dies.

---

*"The branches forgot they were one tree."*

---

## Related

- [Nothing is Deleted: The First Principle](#)
- [The Oracle Architecture: ψ/ Explained](#)
- [Smart Indexing: How We Preserve Cross-Repo Knowledge](#)

---

**Tags**: oracle-philosophy, reunion, cross-repo, knowledge-management, ai-memory
