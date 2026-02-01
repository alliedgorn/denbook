---
title: # Reunion Pattern: Link Before Trace
tags: [reunion, symlink, trace, cross-repo, ghq]
created: 2026-01-31
source: oracle_learn from github.com/laris-co/Nat-s-Agents ψ/memory/learnings/2026-01-27_oracle-reunion-pattern-link-before-trace.md
---

# # Reunion Pattern: Link Before Trace

# Reunion Pattern: Link Before Trace

**Date**: 2026-01-27
**Discovery**: When tracing across Oracle repos, symlink FIRST then trace.

## The Pattern

```bash
# 1. Link the Oracle repo to ψ/learn/
mkdir -p ψ/learn/laris-co
ln -s ~/Code/github.com/laris-co/[oracle-repo] ψ/learn/laris-co/

# 2. Now trace - files will be resolvable
/trace [query]
```

## Why This Matters

- Trace results include file paths
- Without symlink, files show "not found"  
- With symlink, clicking opens the file directly
- Enables cross-repo knowledge graph navigation

## 7 Oracle Symlinks Created

```
ψ/learn/laris-co/
├── Nat-s-Agents (Mother)
├── oracle-v2
├── oracle-skills-cli
├── jarvis-oracle
├── odin-oracle
├── volt-oracle
└── floodboy-oracle
```

**Source**: ψ/memory/learnings/2026-01-27_oracle-reunion-pattern-link-before-trace.md

---
*Added via Oracle Learn*
