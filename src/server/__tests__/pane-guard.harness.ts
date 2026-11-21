/**
 * Child process for pane-guard.test.ts. It must be started with TMUX_TMPDIR set
 * and TMUX unset, so every tmux call here (deliverToPane's included) talks to a
 * private server. Bun does not pass a runtime change to process.env on to
 * spawned children, so the env has to be right from process start.
 *
 * Prints one JSON object with the result of each scenario.
 */
import fs from 'fs';
import path from 'path';
import { Database } from 'bun:sqlite';
import { deliverToPane, enqueueNotification, setRestDb } from '../../notify.ts';

const dir = process.argv[2];
if (!dir || !process.env.TMUX_TMPDIR || process.env.TMUX) {
  throw new Error('pane-guard harness: needs a dir argument, TMUX_TMPDIR set and TMUX unset');
}
const socket = path.join(dir, `tmux-${process.getuid?.() ?? 0}`, 'default');

function tmux(...args: string[]) {
  return Bun.spawnSync(['tmux', ...args]);
}

function waitFor(check: () => boolean, ms = 3000): boolean {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    Bun.sleepSync(50);
  }
  return check();
}

// Rax's fixture (#20 msg 31020, case 4): the DM line leaves a single quote open,
// the forum line closes it at the apostrophe in "Sable's", and the rest is live.
const dmLine = "[2026-11-12 14:00:00 UTC+7] [from boro] [DM from boro] I'm up";
const forumLine = (marker: string) =>
  `[2026-11-12 14:00:01 UTC+7] [from server] [Forum message] From rax in thread #20 ("t"): Sable's $(touch ${marker}) ok`;

// Safety gate before creating anything: no server runs on the private socket yet.
// If this lists sessions, we are on the real server, so stop.
if (tmux('list-sessions').exitCode === 0) {
  throw new Error('pane-guard harness: tmux is not on the private socket, refusing to run');
}

const out: Record<string, unknown> = {};
try {
  // A stand-in for Claude Code: it records its input and evaluates nothing.
  // tmux takes pane_current_command from argv[0], so the launcher sets argv[0]
  // to "claude" (a script's own name only changes comm, which tmux ignores).
  const got = path.join(dir, 'claude-got.txt');
  const loop = path.join(dir, 'fake-claude-loop.sh');
  const launch = path.join(dir, 'fake-claude-launch.sh');
  fs.writeFileSync(loop, `#!/bin/bash\nwhile IFS= read -r line; do printf '%s\\n' "$line" >> "${got}"; done\n`, { mode: 0o755 });
  fs.writeFileSync(launch, `#!/bin/bash\nexec -a claude /bin/bash "${loop}"\n`, { mode: 0o755 });
  tmux('new-session', '-d', '-s', 'Pgclaude', '-c', dir, `exec ${launch}`);
  for (const s of ['Pgbash', 'Pgcontrol']) {
    tmux('new-session', '-d', '-s', s, '-c', dir, 'exec bash --norc --noprofile -i');
  }
  out.sessions = tmux('list-sessions', '-F', '#{session_name}').stdout.toString().trim().split('\n').sort();
  out.socketIsPrivate = fs.existsSync(socket);
  waitFor(() => tmux('display-message', '-p', '-t', 'Pgclaude', '#{pane_current_command}').stdout.toString().trim() === 'claude');
  waitFor(() => tmux('display-message', '-p', '-t', 'Pgbash', '#{pane_current_command}').stdout.toString().trim() === 'bash');

  // 1. Positive control: unguarded send-keys into bash runs the fixture.
  const mControl = path.join(dir, 'm_control');
  for (const line of [dmLine, forumLine(mControl)]) {
    tmux('send-keys', '-t', 'Pgcontrol', '-l', line);
    tmux('send-keys', '-t', 'Pgcontrol', 'Enter');
  }
  out.controlRan = waitFor(() => fs.existsSync(mControl));

  // 2. Guarded delivery into bash: refused, nothing typed, nothing run.
  const mGuarded = path.join(dir, 'm_guarded');
  out.bashOutcomes = [deliverToPane('Pgbash', dmLine), deliverToPane('Pgbash', forumLine(mGuarded))];
  out.guardedRan = waitFor(() => fs.existsSync(mGuarded), 1500);
  const screen = tmux('capture-pane', '-p', '-t', 'Pgbash').stdout.toString();
  out.bashScreenHasText = screen.includes('DM from boro') || screen.includes('Forum message');

  // 3. Guarded delivery into claude: sent verbatim, not evaluated.
  const mClaude = path.join(dir, 'm_claude');
  out.claudeOutcome = deliverToPane('Pgclaude', forumLine(mClaude));
  waitFor(() => fs.existsSync(got) && fs.readFileSync(got, 'utf-8').includes('Forum message'));
  out.claudeGot = fs.existsSync(got) ? fs.readFileSync(got, 'utf-8') : '';
  out.claudeRan = fs.existsSync(mClaude);
  out.mClaude = mClaude;

  // 4. No session at all.
  out.missingOutcome = deliverToPane('Pgnosuchsession', 'hello');

  // 5. T#1025 (Bertus): the rest hold at its two call sites, on this private
  // server. DEN_NOTIFY_DIR is pointed at a dir inside the harness dir BEFORE
  // daemons/routes.ts is imported, since DRAIN_DIR is read at import.
  const qdir = path.join(dir, 'notify');
  fs.mkdirSync(qdir, { mode: 0o700 });
  process.env.DEN_NOTIFY_DIR = qdir;
  // Importing daemons/routes.ts opens the db module, so pin it off the real one.
  process.env.ORACLE_DB_PATH = ':memory:';
  process.env.ORACLE_DATA_DIR = path.join(dir, 'data');
  const { runDrainCycle, DRAIN_DIR } = await import('../../daemons/routes.ts');
  out.drainDirIsPrivate = DRAIN_DIR === qdir;
  const db = new Database(':memory:');
  db.run("CREATE TABLE beast_profiles (name TEXT PRIMARY KEY, rest_status TEXT, rest_since INTEGER)");
  db.run("INSERT INTO beast_profiles VALUES ('pgclaude', 'rest', ?)", [Date.now()]);
  const qfile = path.join(qdir, 'pgclaude.queue');
  const heldLine = 'T1025 held doorbell';
  fs.writeFileSync(qfile, Buffer.from(heldLine).toString('base64') + '\n', { mode: 0o600 });
  const before = fs.readFileSync(qfile, 'utf-8');
  const gotHas = (t: string) => fs.existsSync(got) && fs.readFileSync(got, 'utf-8').includes(t);

  // 5a. At rest: one cycle leaves the queue byte-identical and types nothing.
  runDrainCycle(db);
  out.restQueueUntouched = fs.readFileSync(qfile, 'utf-8') === before;
  out.restTyped = waitFor(() => gotHas(heldLine), 1000);

  // 5b. Woken (what /wake writes): the next cycle drains it into claude.
  db.run("UPDATE beast_profiles SET rest_status = 'active', rest_since = NULL WHERE name = 'pgclaude'");
  runDrainCycle(db);
  out.wakeQueueEmpty = fs.readFileSync(qfile, 'utf-8') === '';
  out.wakeTyped = waitFor(() => gotHas(heldLine));

  // 5c. Lapsed (rest started 2 h ago, an aborted /rest): delivers again.
  db.run("UPDATE beast_profiles SET rest_status = 'rest', rest_since = ? WHERE name = 'pgclaude'", [Date.now() - 2 * 3600_000]);
  const lapsedLine = 'T1025 lapsed doorbell';
  fs.writeFileSync(qfile, Buffer.from(lapsedLine).toString('base64') + '\n', { mode: 0o600 });
  Bun.sleepSync(1100); // DRAIN_SPACING is 1 s per Beast
  runDrainCycle(db);
  out.lapsedTyped = waitFor(() => gotHas(lapsedLine));

  // 6. Tier-2: there is no /home/gorn/workspace/pgclaude/scripts/notify.sh, so
  // Tier-1 fails and Tier-2 types straight into the pane, unless at rest.
  setRestDb(db);
  db.run("UPDATE beast_profiles SET rest_status = 'rest', rest_since = ? WHERE name = 'pgclaude'", [Date.now()]);
  out.tier2RestResult = enqueueNotification('pgclaude', 'T1025 tier2 at rest');
  out.tier2RestTyped = waitFor(() => gotHas('T1025 tier2 at rest'), 1000);
  // 7. Owner bypass (Gorn 11-21, "3 yes"): at rest, an owner line is typed straight in; the
  // same line without fromOwner is held (Tier-2 refuses).
  out.ownerRestResult = enqueueNotification('pgclaude', 'T1025 owner at rest', { fromOwner: true });
  out.ownerRestTyped = waitFor(() => gotHas('T1025 owner at rest'));
  db.run("INSERT INTO beast_profiles VALUES ('pgnosuchsession', 'rest', ?)", [Date.now()]);
  out.ownerNoSessionResult = enqueueNotification('pgnosuchsession', 'T1025 owner no session', { fromOwner: true });
  db.run("UPDATE beast_profiles SET rest_status = 'active', rest_since = NULL WHERE name = 'pgclaude'");
  out.tier2AwakeResult = enqueueNotification('pgclaude', 'T1025 tier2 awake');
  out.tier2AwakeTyped = waitFor(() => gotHas('T1025 tier2 awake'));
  setRestDb(null);
} finally {
  // Explicit socket, so teardown can never reach the real tmux server.
  if (fs.existsSync(socket)) Bun.spawnSync(['tmux', '-S', socket, 'kill-server']);
}
console.log(JSON.stringify(out));
