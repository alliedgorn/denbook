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
});
