#!/usr/bin/env bash
set -euo pipefail

DENBOOK_DIR="/home/gorn/workspace/denbook"
PORT=47778
UNIT="den-book"   # systemd --user unit; supplies Restart=on-failure, EnvironmentFile and the journal

# PID currently listening on $PORT (empty if none)
listener_pid() {
  ss -Hlptn "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2
}

cd "$DENBOOK_DIR"

echo "=== Den Book Deploy ==="

# 1. Pull merged commits
echo "[1/6] Pulling main..."
BEFORE=$(git rev-parse HEAD)
git pull origin main
AFTER=$(git rev-parse HEAD)

if [ "$BEFORE" = "$AFTER" ]; then
  echo "No new commits. Nothing to deploy."
  exit 0
fi

echo "Deploy payload: $BEFORE..$AFTER"
git log --oneline "$BEFORE..$AFTER"

# 2. Check for dependency changes
if git diff --name-only "$BEFORE" "$AFTER" | grep -q 'package.json\|bun.lock'; then
  echo "[2/6] Dependencies changed — running bun install..."
  bun install
else
  echo "[2/6] No dependency changes — skipping install."
fi

# 3. Check for frontend changes and rebuild if needed
if git diff --name-only "$BEFORE" "$AFTER" | grep -q '^frontend/src/'; then
  echo "[3/6] Frontend changes detected — rebuilding..."
  cd frontend && npm run build && cd ..
  echo "Frontend rebuilt."
else
  echo "[3/6] No frontend changes — skipping build."
fi

# 4. Clear any listener the unit does not own
# An earlier deploy.sh started the server with nohup, outside systemd. A stray like
# that holds $PORT, so the unit cannot bind and would restart-loop. Target the port
# listener, not a process pattern: 'bun.*server.ts' also matches dev servers in
# other worktrees.
echo "[4/6] Checking for an unsupervised listener on :$PORT..."
MAIN=$(systemctl --user show -p MainPID --value "$UNIT")
STRAY=$(listener_pid)
if [ -n "$STRAY" ] && [ "$STRAY" != "$MAIN" ]; then
  echo "Listener pid $STRAY is not $UNIT (MainPID=$MAIN) — stopping it..."
  kill -TERM "$STRAY" 2>/dev/null || true
  for _ in $(seq 1 10); do [ -z "$(listener_pid)" ] && break; sleep 1; done
  if [ -n "$(listener_pid)" ]; then
    echo "WARNING: pid $STRAY still listening after 10s — sending SIGKILL..."
    kill -9 "$STRAY" 2>/dev/null || true
    sleep 1
  fi
else
  echo "None."
fi

# 5. Restart under systemd
echo "[5/6] Restarting $UNIT..."
systemctl --user restart "$UNIT"

# 6. Smoke check — healthy AND supervised
echo "[6/6] Smoke check..."
OK=""
for _ in $(seq 1 15); do
  if curl -sf "http://localhost:$PORT/api/health" >/dev/null 2>&1; then OK=1; break; fi
  sleep 1
done
if [ -z "$OK" ]; then
  echo "✗ Health FAILED — check: journalctl --user -u $UNIT -n 50"
  journalctl --user -u "$UNIT" -n 20 --no-pager || true
  exit 1
fi
echo "✓ Health OK"
P=$(listener_pid)
if [ "$(systemctl --user is-active "$UNIT")" = active ] && grep -q "$UNIT.service" "/proc/$P/cgroup" 2>/dev/null; then
  echo "✓ Supervised: listener pid $P is in $UNIT.service"
else
  echo "✗ Listener pid ${P:-none} is NOT in $UNIT.service — server is unsupervised"
  exit 1
fi

echo ""
echo "=== Deploy complete: $(git rev-parse --short HEAD) ==="
echo "Payload: $(git log --oneline "$BEFORE..$AFTER" | wc -l) commits"
