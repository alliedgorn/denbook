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
import { deliverToPane, typeIntoPane, SEND_KEYS_MAX_BYTES } from '../../notify.ts';

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
  // stty -icanon: a canonical-mode tty truncates any line past 4095 bytes, and
  // scenario 6 sends 20KB. Claude Code reads its tty raw, so this matches it.
  fs.writeFileSync(loop, `#!/bin/bash\nstty -icanon -echo\nwhile IFS= read -r line; do printf '%s\\n' "$line" >> "${got}"; done\n`, { mode: 0o755 });
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

  // 5. Positive control for the length wall (T#973 c3228): raw send-keys -l over
  // about 16KB fails on this tmux. If it ever stops failing, scenario 6 still
  // passes but no longer proves the paste path is needed.
  out.rawOversizeExit = tmux('send-keys', '-t', 'Pgcontrol', '-l', 'y'.repeat(17000)).exitCode;

  // 6. Oversize delivery into claude goes through the paste buffer and arrives whole.
  const big = 'BIG:' + 'x'.repeat(20000) + ':END';
  out.bigBytes = big.length;
  out.bigOutcome = deliverToPane('Pgclaude', big);
  waitFor(() => fs.existsSync(got) && fs.readFileSync(got, 'utf-8').includes(':END'));
  const gotLines = fs.existsSync(got) ? fs.readFileSync(got, 'utf-8').split('\n') : [];
  out.bigArrivedWhole = gotLines.includes(big);
  out.bigLongestLine = Math.max(0, ...gotLines.map((l) => l.length));
  out.buffersLeft = tmux('list-buffers', '-F', '#{buffer_name}').stdout.toString().trim();

  // 7. A tmux failure is reported, on both paths, instead of 'sent'.
  out.typeShortToMissing = typeIntoPane('Pgnosuchsession', 'hi');
  out.typeBigToMissing = typeIntoPane('Pgnosuchsession', 'z'.repeat(SEND_KEYS_MAX_BYTES + 1));
  out.buffersLeftAfterFail = tmux('list-buffers', '-F', '#{buffer_name}').stdout.toString().trim();
} finally {
  // Explicit socket, so teardown can never reach the real tmux server.
  if (fs.existsSync(socket)) Bun.spawnSync(['tmux', '-S', socket, 'kill-server']);
}
console.log(JSON.stringify(out));
