/**
 * T#905 — /api/schedules/due must not report future beats as due.
 *
 * The endpoint compared a bound ISO-8601 `now` ('T' separator) against
 * next_due_at as RAW STRINGS. The wake storm cap (pack/routes.ts:411) writes
 * next_due_at space-separated via SQLite datetime(), and ' ' (0x20) sorts below
 * 'T' (0x54) — so every same-day space-separated row compared as overdue no
 * matter what the clock said. One seat (@zaghnal) held six such rows and the
 * endpoint reported 5 due when 1 was.
 *
 * These tests import DUE_SCHEDULES_SQL from the route module, so they bind to the
 * string the endpoint actually runs. A re-typed predicate could not catch a revert.
 *
 * Self-contained: an in-memory DB seeded with both timestamp formats. No server,
 * no production database, no fixed sleeps.
 *
 * Author: Rax (Infrastructure) — found by @zaghnal from a write-locked seat.
 */
import { describe, test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { DUE_SCHEDULES_SQL } from "../scheduler/routes.ts";

const BEAST = "t905";

// The exact defective predicate, kept so the tests can prove the two disagree.
// If this ever equals DUE_SCHEDULES_SQL, the fix has been reverted.
const RAW_PREDICATE_SQL =
  "SELECT * FROM beast_schedules WHERE beast = ? AND enabled = 1 AND next_due_at <= ? ORDER BY next_due_at";

let sqlite: Database;
const NOW_ISO = "2026-07-30T09:30:00.000Z";

// Rows chosen to isolate the separator from any timezone effect:
// the next-DAY row is handled correctly even by the broken predicate, which is
// the discriminator proving this is the separator and not a UTC offset.
const ROWS: Array<[string, string, string]> = [
  // id, next_due_at, why
  ["1", "2026-07-30 07:41:44", "space-sep, PAST      -> genuinely due"],
  ["2", "2026-07-30 13:24:44", "space-sep, +4h       -> NOT due (the defect)"],
  ["3", "2026-07-30 23:59:00", "space-sep, +14h      -> NOT due (the defect)"],
  ["4", "2026-07-31 07:11:44", "space-sep, NEXT DAY  -> NOT due (correct even when broken)"],
  ["5", "2026-07-30T07:41:44.000Z", "ISO-T, PAST      -> genuinely due"],
  ["6", "2026-07-30T23:59:00.000Z", "ISO-T, +14h      -> NOT due"],
];

function idsFrom(sql: string): string[] {
  return (sqlite.prepare(sql).all(BEAST, NOW_ISO) as any[])
    .map((r) => String(r.id))
    .sort();
}

describe("T#905 — /api/schedules/due timestamp comparison", () => {
  beforeAll(() => {
    sqlite = new Database(":memory:");
    sqlite.run(`CREATE TABLE beast_schedules (
      id TEXT PRIMARY KEY, beast TEXT NOT NULL,
      next_due_at TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1
    )`);
    const ins = sqlite.prepare(
      "INSERT INTO beast_schedules (id, beast, next_due_at, enabled) VALUES (?, ?, ?, 1)"
    );
    for (const [id, due] of ROWS) ins.run(id, BEAST, due);
  });

  test("the fix is actually in place (predicate wraps both sides in datetime())", () => {
    expect(DUE_SCHEDULES_SQL).toContain("datetime(next_due_at) <= datetime(?)");
    expect(DUE_SCHEDULES_SQL).not.toBe(RAW_PREDICATE_SQL);
  });

  test("returns ONLY genuinely-due rows, both timestamp formats", () => {
    // 1 = space-sep past, 5 = ISO past. Nothing else is due at NOW_ISO.
    expect(idsFrom(DUE_SCHEDULES_SQL)).toEqual(["1", "5"]);
  });

  test("a space-separated row hours in the future is NOT reported due", () => {
    const due = idsFrom(DUE_SCHEDULES_SQL);
    expect(due).not.toContain("2"); // +4h
    expect(due).not.toContain("3"); // +14h
  });

  test("ISO-T rows are unaffected by the fix (no regression for 16 seats)", () => {
    const due = idsFrom(DUE_SCHEDULES_SQL);
    expect(due).toContain("5"); // past -> due
    expect(due).not.toContain("6"); // future -> not due
  });

  test("the OLD predicate really did report the phantoms — the bug was real", () => {
    // Guards against a future reader deciding this test protects nothing.
    const broken = idsFrom(RAW_PREDICATE_SQL);
    expect(broken).toContain("2");
    expect(broken).toContain("3");
    expect(broken.length).toBeGreaterThan(idsFrom(DUE_SCHEDULES_SQL).length);
  });

  test("the next-DAY row is excluded by both — this is a separator bug, not a timezone skew", () => {
    expect(idsFrom(RAW_PREDICATE_SQL)).not.toContain("4");
    expect(idsFrom(DUE_SCHEDULES_SQL)).not.toContain("4");
  });
});
