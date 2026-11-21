/**
 * T#956: spec history/diff ran `git` through a shell with the stored spec file_path inside a
 * double-quoted string, so `$(...)` in a file_path ran as a command. These tests pin the fix on
 * both axes (Gnarl's gate, T#956 c2951):
 * - shell safety: a command-substitution payload in file_path never executes, on both routes;
 * - path safety: traversal stays refused, and nothing runs for a refused path.
 * A positive control runs the same payload through a shell, to prove the payload is live.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { OpenAPIHono } from '@hono/zod-openapi';
import { execSync, execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { registerSpecsRoutes, resolveSpecPath, specGit } from '../../specs/routes.ts';

let root: string;
let mark: string;
let db: Database;
let app: OpenAPIHono;

const sh = (cmd: string, cwd: string) => execSync(cmd, { cwd, stdio: 'pipe' });

// three shell spellings of "touch the mark file"
const payloads = () => [
  `docs/specs/x$(touch ${mark}).md`,
  `docs/specs/x\`touch ${mark}\`.md`,
  `docs/specs/x"; touch ${mark}; echo ".md`,
];

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'specs-no-shell-'));
  mark = path.join(root, 'PWNED');
  const repo = path.join(root, 'denbook');
  fs.mkdirSync(path.join(repo, 'docs/specs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs/specs/a.md'), '# a\n');
  sh('git init -q && git -c user.name=t -c user.email=t@t add . && git -c user.name=t -c user.email=t@t commit -qm first', repo);
  fs.appendFileSync(path.join(repo, 'docs/specs/a.md'), 'more\n');
  sh('git -c user.name=t -c user.email=t@t commit -qam second', repo);

  db = new Database(':memory:');
  app = new OpenAPIHono();
  registerSpecsRoutes(app, db, {
    hasSessionAuth: () => true,
    requireBeastIdentity: () => 'bertus',
    isTrustedRequest: () => true,
    wsBroadcast: () => {},
    specRoot: root,
  });
});

afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

function plant(filePath: string): number {
  // stored rows can predate the write check, so insert directly, as an old row would be
  const old = db.prepare("SELECT id FROM spec_reviews WHERE repo = 'denbook' AND file_path = ?").get(filePath) as any;
  if (old) return old.id;
  const now = new Date().toISOString();
  const r = db.prepare(
    "INSERT INTO spec_reviews (repo, file_path, title, author, status, created_at, updated_at) VALUES ('denbook', ?, 't', 'bertus', 'pending', ?, ?)"
  ).run(filePath, now, now);
  return Number((r as any).lastInsertRowid);
}

describe('positive controls', () => {
  test('each payload executes when it goes through a shell (the old code path)', () => {
    for (const p of payloads()) {
      fs.rmSync(mark, { force: true });
      try { sh(`git log --format=%s -- "${p}"`, path.join(root, 'denbook')); } catch { /* git may fail; the shell ran first */ }
      expect(fs.existsSync(mark)).toBe(true);
    }
    fs.rmSync(mark, { force: true });
  });

  test('history returns real commits for a real spec file', async () => {
    const id = plant('docs/specs/a.md');
    const res = await app.request(`/api/specs/${id}/history`);
    const body = await res.json() as any;
    expect(body.versions.map((v: any) => v.subject)).toEqual(['second', 'first']);
  });
});

describe('shell safety: file_path is never run', () => {
  test('history does not execute any payload', async () => {
    for (const p of payloads()) {
      fs.rmSync(mark, { force: true });
      const res = await app.request(`/api/specs/${plant(p)}/history`);
      expect(res.status).toBe(200);
      expect(fs.existsSync(mark)).toBe(false);
    }
  });

  test('diff does not execute any payload', async () => {
    const head = execFileSync('git', ['rev-parse', 'HEAD~1'], { cwd: path.join(root, 'denbook'), encoding: 'utf-8' }).trim();
    for (const p of payloads()) {
      fs.rmSync(mark, { force: true });
      const res = await app.request(`/api/specs/${plant(p)}/diff?from=${head}&to=HEAD`);
      expect(res.status).toBe(200);
      expect(fs.existsSync(mark)).toBe(false);
    }
  });

  test('git gets an argv after --, with no shell option', () => {
    const calls: any[] = [];
    const run = ((file: string, args: string[], opts: any) => { calls.push({ file, args, opts }); return ''; }) as any;
    specGit('denbook', payloads()[0], ['log'], { root, run });
    expect(calls).toHaveLength(1);
    expect(calls[0].file).toBe('git');
    expect(calls[0].args.slice(0, 3)).toEqual(['--literal-pathspecs', 'log', '--']);
    expect(calls[0].args[3]).toBe(payloads()[0]);
    expect(calls[0].opts.shell).toBeUndefined();
  });
});

describe('path safety is kept', () => {
  const refused = [
    '../../../etc/passwd.md',
    'docs/specs/../../../outside.md',
    '/etc/x.md',
    'docs/x.md',
    'docs/specs/a.txt',
  ];

  test('refused paths run nothing', () => {
    let ran = 0;
    const run = (() => { ran++; return ''; }) as any;
    for (const p of refused) {
      expect(resolveSpecPath('denbook', p, root)).toBeNull();
      expect(specGit('denbook', p, ['log'], { root, run })).toBeNull();
    }
    expect(ran).toBe(0);
  });

  test('git gets the canonical path, not the stored one', () => {
    const calls: any[] = [];
    const run = ((_f: string, args: string[]) => { calls.push(args); return ''; }) as any;
    specGit('denbook', 'docs/specs/sub/../a.md', ['log'], { root, run });
    expect(calls[0].at(-1)).toBe('docs/specs/a.md');
  });

  test('a glob in file_path matches nothing (literal pathspec)', async () => {
    const res = await app.request(`/api/specs/${plant('docs/specs/*.md')}/history`);
    expect((await res.json() as any).versions).toEqual([]);
  });

  test('history of a traversal path returns no versions', async () => {
    const res = await app.request(`/api/specs/${plant('docs/specs/../../../etc/passwd.md')}/history`);
    expect((await res.json() as any).versions).toEqual([]);
  });
});

describe('write check on POST /api/specs', () => {
  const post = (file_path: unknown) => app.request('/api/specs', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: 'denbook', file_path, title: 't', thread_id: 1 }),
  });

  test('refuses a path outside docs/specs, a traversal, a non-string and a control character', async () => {
    for (const fp of ['README.md', 'docs/specs/../../x.md', 42, 'docs/specs/a\n.md']) {
      expect((await post(fp)).status).toBe(400);
    }
  });

  test('accepts a normal spec path', async () => {
    expect((await post('docs/specs/new-spec.md')).status).toBeLessThan(300);
  });
});
