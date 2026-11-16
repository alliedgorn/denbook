// T#981 fixture, run only as a child by test-safety.test.ts, never by the suite
// (not named *.test.ts). It trips the tripwire and does NOT clear the hit, so
// the preload's global afterAll must fail this run.
import { test, expect } from 'bun:test';
test('leaks a blocked spawn', () => {
  expect(() => Bun.spawnSync(['tmux', 'ls'])).toThrow();
});
