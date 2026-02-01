# oracle-ctl: Process Management for Oracle Instances

**Incubated**: 2026-02-01
**Status**: Idea → Planning
**Priority**: Medium

## Vision

CLI + Web interface to manage multiple Oracle instances.

## Problem

- Fixed DB path (`~/.oracle-v2/oracle.db`)
- Fixed port (`47778`)
- No easy way to run multiple Oracles
- LLM agents need fast process control

## Solution

### CLI (Primary - for agents)

```bash
oracle-ctl list                    # List instances
oracle-ctl status oracle-v2        # Quick status check
oracle-ctl start oracle-v2         # Start instance
oracle-ctl stop work-oracle        # Stop instance
oracle-ctl restart shrimp-oracle   # Restart
oracle-ctl logs oracle-v2 --tail   # View logs
oracle-ctl create my-oracle --port 47781
oracle-ctl config oracle-v2 --autostart true
```

### Web Dashboard (Secondary - for humans)

```
┌─────────────────────────────────────────────────────────────┐
│  🔧 Oracle Control Plane                                     │
├─────────────────────────────────────────────────────────────┤
│  Instance         Port    Status    Uptime      Actions     │
│  oracle-v2        47778   🟢 Running  2h 15m    [⟳] [■]     │
│  work-oracle      47779   🔴 Stopped  -         [▶] [✕]     │
└─────────────────────────────────────────────────────────────┘
```

## Config Format

```yaml
# ~/.oracle-control/instances.yaml
instances:
  - name: oracle-v2
    port: 47778
    db: ~/.oracle-v2/oracle.db
    repo: ~/Code/github.com/Soul-Brews-Studio/oracle-v2
    autostart: true
    
  - name: work-oracle
    port: 47779
    db: ~/.oracle-work/oracle.db
    repo: ~/Code/github.com/laris-co/work-oracle
    autostart: false
```

## Architecture

```
LLM Agents ───► CLI ─────┐
                         ▼
                   ┌────────────┐
                   │  Control   │ ◄── instances.yaml
                   │  Plane     │
                   └────────────┘
                         ▲
Humans ──────► Web UI ───┘
```

## Tech Stack

| Component | Tech |
|-----------|------|
| CLI | Bun + Commander.js |
| Config | YAML (`~/.oracle-control/`) |
| Process | Bun.spawn |
| Web | React (optional, later) |

## Phases

### Phase 1: CLI Core
- [ ] `oracle-ctl list`
- [ ] `oracle-ctl start/stop/restart`
- [ ] `oracle-ctl status`
- [ ] Config file support

### Phase 2: CLI Extended
- [ ] `oracle-ctl create/delete`
- [ ] `oracle-ctl logs`
- [ ] `oracle-ctl config`
- [ ] Auto-discovery of running instances

### Phase 3: Web Dashboard
- [ ] Instance list UI
- [ ] Start/Stop buttons
- [ ] Log viewer
- [ ] Config editor

## Related

- MCP symlink consolidation (done)
- oracle_learn project arg (done)
- Multi-repo knowledge graph

---

*"Control the instances, control the knowledge."*
