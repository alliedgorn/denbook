#!/bin/bash
# ============================================================================
# ⛔ THIS IS NOT THE PRODUCTION LAUNCHER. DO NOT RUN IT TO "RESTORE" THE SERVER.
#
# Production is launched and supervised by a systemd user unit:
#     ~/.config/systemd/user/den-book.service   (enabled, WantedBy=default.target)
#     systemctl --user status|restart|stop den-book
#
# That unit has owned the running process since 2026-05-24 10:04:11 and carries
# Restart=on-failure / RestartSec=5. This script predates it (2026-05-06), is on
# no execution path, and is kept only as a record (Principle 1 — supersede, do
# not delete).
#
# Two reasons not to run it — T#912, 2026-07-31:
#
#   1. It would collide. The unit already holds 127.0.0.1:47778.
#
#   2. ⛔ IT IS THE LESS SAFE OF THE TWO PATHS, and that is the load-bearing one.
#      `source` makes bash EVALUATE the credential file: any $(...), backtick or
#      ${...} in ~/.oracle/.env RUNS as the server's user. systemd's
#      EnvironmentFile= parses KEY=VALUE literally — no shell, no substitution.
#      ⇒ Running this silently upgrades ~/.oracle/.env from parsed data to
#        executed code. That file holds TELEGRAM_BOTS, a 698-byte hand-maintained
#        free-form value — the one key on the box whose alphabet nothing
#        constrains. It is clean by inspection, not by construction.
#      ⇒ This script is the ONLY shell-evaluation path to that value anywhere
#        under /home/gorn/workspace. Superseding it is the mitigation, not tidying.
#
# Filed by @zaghnal on the premise that this was the uncommitted production
# launcher. It is not — but he read it as authoritative, which is exactly the
# failure this header exists to stop the next seat repeating.
# ============================================================================
set -a
source ~/.oracle/.env
set +a
cd /home/gorn/workspace/denbook
exec bun src/server.ts
