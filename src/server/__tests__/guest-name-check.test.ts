// Guest name collisions (Gorn 11-17, option b; Bertus PR 174 note, widened).
// Guest DM threads are keyed by "[guest] <display_name || username>", lowercased, so a
// guest who takes another guest's name, or an old name with DM history, joins those
// threads. In-memory only; never touches ~/.oracle/oracle.db.
import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { initGuestTables, checkGuestName } from '../guest-accounts.ts';

let db: Database;
let alice: number, bob: number;

beforeEach(() => {
  db = new Database(':memory:');
  initGuestTables(db);
  db.exec(`CREATE TABLE beast_profiles (name TEXT, display_name TEXT);
           INSERT INTO beast_profiles VALUES ('boro', 'Boro');
           CREATE TABLE dm_conversations (id INTEGER PRIMARY KEY, participant1 TEXT, participant2 TEXT);
           INSERT INTO dm_conversations (participant1, participant2) VALUES ('[guest] oldfriend', 'karo');`);
  const add = (u: string, d: string | null) =>
    Number(db.prepare('INSERT INTO guest_accounts (username, password_hash, display_name) VALUES (?, ?, ?)').run(u, 'x', d).lastInsertRowid);
  alice = add('alice', 'Alice W');
  add('elise', 'Élise');
  db.prepare("INSERT INTO dm_conversations (participant1, participant2) VALUES (?, 'rax')").run('[guest] Пётр'.toLowerCase());
  bob = add('bob', null);
});

describe('checkGuestName', () => {
  test('a free name is ok (positive control)', () => {
    expect(checkGuestName(db, 'Carol', bob)).toBe('ok');
  });

  test("another guest's display name or username is taken, whatever the case or outer spaces", () => {
    expect(checkGuestName(db, '  alice w ', bob)).toBe('taken');
    expect(checkGuestName(db, 'ALICE', bob)).toBe('taken');
    expect(checkGuestName(db, 'Bob', alice)).toBe('taken');
  });

  test('a guest may keep or re-case their own current name', () => {
    expect(checkGuestName(db, 'Alice W', alice)).toBe('ok');
    expect(checkGuestName(db, 'alice', alice)).toBe('ok');
    expect(checkGuestName(db, 'BOB', bob)).toBe('ok');
  });

  test('an old name with DM history is taken even though no account has it', () => {
    expect(checkGuestName(db, 'OldFriend', bob)).toBe('taken');
    expect(checkGuestName(db, 'oldfriend')).toBe('taken'); // owner create path, no self
  });

  test('Beasts from the live roster (boro was missing from the hand list) and system names are reserved', () => {
    expect(checkGuestName(db, 'Boro', bob)).toBe('reserved');
    expect(checkGuestName(db, 'karo', bob)).toBe('reserved');
    expect(checkGuestName(db, 'Admin', bob)).toBe('reserved');
  });

  test('non-ASCII names fold the way the DM key does (Bertus: SQLite lower is ASCII-only)', () => {
    expect(checkGuestName(db, 'ÉLISE', bob)).toBe('taken');
    expect(checkGuestName(db, 'ПЁТР', bob)).toBe('taken');
  });
});

// The one guest-reachable writer (Bertus, PR 175 review): no test failed if the check
// was dropped from PATCH /api/guest/profile. Real route, in-memory DB, a stub middleware
// standing in for the session (which sets guestUsername in the real server).
import { OpenAPIHono } from '@hono/zod-openapi';
import { registerGuestRoutes } from '../../guest/routes.ts';

describe('PATCH /api/guest/profile', () => {
  let app: OpenAPIHono;
  beforeEach(() => {
    app = new OpenAPIHono();
    app.use('*', async (c, next) => { c.set('guestUsername' as any, c.req.header('x-test-guest')); return next(); });
    registerGuestRoutes(app, db, {
      wsBroadcast: () => {}, withRetry: async (fn) => fn(),
      getTmuxStatus: () => ({ tmuxStatus: new Map(), contextPctMap: new Map() }),
      normalizeAvatarUrl: (u) => u, uploadsDir: '/nonexistent',
    });
  });
  const patch = (who: string, display_name: unknown) => app.request('/api/guest/profile', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-test-guest': who },
    body: JSON.stringify({ display_name }),
  });
  const shown = (u: string) => (db.prepare('SELECT display_name FROM guest_accounts WHERE username = ?').get(u) as any).display_name;

  test('a free name is stored, trimmed (positive control)', async () => {
    const r = await patch('bob', '  Bobby  ');
    expect(r.status).toBe(200);
    expect(shown('bob')).toBe('Bobby');
  });

  test("taking another guest's name, an old DM tag or a Beast's name is refused and nothing changes", async () => {
    expect((await patch('bob', 'alice w')).status).toBe(409);
    expect((await patch('bob', 'OldFriend')).status).toBe(409);
    expect((await patch('bob', 'Élise'.toUpperCase())).status).toBe(409);
    expect((await patch('bob', 'Boro')).status).toBe(400);
    expect((await patch('bob', '   ')).status).toBe(400);
    expect(shown('bob')).toBeNull();
  });

  test('a guest can re-save their own name', async () => {
    expect((await patch('alice', 'ALICE W')).status).toBe(200);
  });
});
