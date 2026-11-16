/**
 * T#973 (Bertus F5): notifications must never be typed into a pane whose
 * claude has exited. The scenarios run in pane-guard.harness.ts as a child
 * process with its own TMUX_TMPDIR and no TMUX, so they use a private tmux
 * server and never touch a real Beast session.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-guard-'));
let r: Record<string, any> = {};

beforeAll(() => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'TMUX') env[k] = v;
  env.TMUX_TMPDIR = dir;
  const child = Bun.spawnSync(['bun', path.join(import.meta.dir, 'pane-guard.harness.ts'), dir], { env });
  const stdout = child.stdout.toString().trim();
  if (child.exitCode !== 0 || !stdout) {
    throw new Error(`harness failed (exit ${child.exitCode}): ${child.stderr.toString()}`);
  }
  r = JSON.parse(stdout.split('\n').pop()!);
}, 30000);

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('deliverToPane (T#973)', () => {
  test('runs on a private tmux server holding only the test sessions', () => {
    expect(r.socketIsPrivate).toBe(true);
    expect(r.sessions).toEqual(['Pgbash', 'Pgclaude', 'Pgcontrol']);
  });

  test("positive control: unguarded send-keys into bash runs Rax's quote-carry fixture", () => {
    // If this fails, the harness cannot show the hole and the guarded case proves nothing.
    expect(r.controlRan).toBe(true);
  });

  test('refuses a bash pane and types nothing into it', () => {
    expect(r.bashOutcomes).toEqual(['not-claude', 'not-claude']);
    expect(r.guardedRan).toBe(false);
    expect(r.bashScreenHasText).toBe(false);
  });

  test('delivers into a claude pane, verbatim and unevaluated', () => {
    expect(r.claudeOutcome).toBe('sent');
    expect(r.claudeGot).toContain('Forum message');
    expect(r.claudeGot).toContain(`$(touch ${r.mClaude})`);
    expect(r.claudeRan).toBe(false);
  });

  test('reports a missing session without sending', () => {
    expect(r.missingOutcome).toBe('no-session');
  });
});
