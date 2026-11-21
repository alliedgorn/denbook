import type { Block, BootModule, Inline, PlannedModule } from './types';

// Shape check for runtime study content (Gorn 11-14). The file is written by Karo on
// the box, but the page still trusts nothing: anything that doesn't match the types
// is rejected whole and the page keeps its bundled copy. Strings are rendered as text
// by RichText, so this guards against a broken page, not against HTML injection.

const isStr = (x: unknown): x is string => typeof x === 'string';
// Images in study content come only from our own uploads (Gorn 11-16). No external
// URL, no protocol-relative "//host", no "..": a lesson must never make the page fetch
// from somewhere else (tracking, IP leak) or reach another route.
const IMG_SRC = /^\/api\/f\/[A-Za-z0-9-]+\.(png|jpe?g|webp|gif)$/;
const isArr = Array.isArray;
const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !isArr(x);

function inline(x: unknown): x is Inline {
  if (isStr(x)) return true;
  return obj(x) && (isStr(x.b) || isStr(x.term));
}
const inlines = (x: unknown) => isArr(x) && x.every(inline);

// A block has EXACTLY ONE kind key and nothing else it doesn't expect. The guard and
// RichText test kinds in different orders, so a block with two kinds (tip + img)
// could pass here as one kind and render as the other with its check skipped
// (Bertus, PR 166). One kind per block makes the order irrelevant in both files.
const BLOCK_KEYS: Record<string, readonly string[]> = {
  p: ['p'], ul: ['ul'], tip: ['tip'], code: ['code'], img: ['img', 'alt', 'caption'],
};
function oneKind(x: Record<string, unknown>): boolean {
  const keys = Object.keys(x);
  const kinds = keys.filter(k => k in BLOCK_KEYS);
  if (kinds.length !== 1) return false;
  const allowed = BLOCK_KEYS[kinds[0]];
  return keys.every(k => allowed.includes(k));
}

function block(x: unknown): x is Block {
  if (!obj(x) || !oneKind(x)) return false;
  if ('p' in x) return inlines(x.p);
  if ('tip' in x) return inlines(x.tip);
  if ('ul' in x) return isArr(x.ul) && x.ul.every(inlines);
  if ('code' in x) return isStr(x.code);
  if ('img' in x) return isStr(x.img) && IMG_SRC.test(x.img) && isStr(x.alt) && x.alt.length > 0
    && (x.caption === undefined || isStr(x.caption));
  return false;
}
const blocks = (x: unknown) => isArr(x) && x.every(block);

function concept(x: unknown) {
  return obj(x) && isStr(x.t) && blocks(x.b) && isStr(x.say);
}
function quiz(x: unknown) {
  return obj(x) && isStr(x.q) && isArr(x.o) && x.o.every(isStr) && Number.isInteger(x.a)
    && (x.a as number) >= 0 && (x.a as number) < x.o.length && isStr(x.w);
}
function drill(x: unknown) {
  return obj(x) && isStr(x.p) && blocks(x.m);
}
function lab(x: unknown) {
  if (!(obj(x) && isStr(x.t) && isStr(x.day) && isStr(x.goal) && blocks(x.steps) && isStr(x.done))) return false;
  if (x.tools !== undefined && !(isArr(x.tools) && x.tools.every(tl => obj(tl) && isStr(tl.name) && isStr(tl.use) && (tl.code === undefined || isStr(tl.code))))) return false;
  if (x.docs !== undefined && !(isArr(x.docs) && x.docs.every(d => obj(d) && isStr(d.label) && isStr(d.url)))) return false;
  return true;
}
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

function bootModule(x: unknown): x is BootModule {
  return obj(x) && isStr(x.id) && SLUG.test(x.id) && isStr(x.name) && isStr(x.week) && isStr(x.lede)
    && isArr(x.concepts) && x.concepts.every(concept)
    && isArr(x.labs) && x.labs.every(lab)
    && isArr(x.quiz) && x.quiz.every(quiz)
    && isArr(x.drills) && x.drills.every(drill);
}
function planned(x: unknown): x is PlannedModule {
  return obj(x) && isStr(x.id) && isStr(x.name) && isStr(x.week) && isStr(x.lede);
}

export interface BootFile { modules: BootModule[]; planned: PlannedModule[] }

// Returns the parsed content, or a reason it was rejected.
export function checkBootFile(x: unknown): BootFile | string {
  if (!obj(x)) return 'not an object';
  if (!isArr(x.modules) || x.modules.length === 0) return 'modules must be a non-empty list';
  const bad = x.modules.findIndex(m => !bootModule(m));
  if (bad >= 0) return `module ${bad} does not match the BootModule shape`;
  const ids = new Set(x.modules.map(m => (m as BootModule).id));
  if (ids.size !== x.modules.length) return 'duplicate module ids';
  const pl = x.planned ?? [];
  if (!isArr(pl) || !pl.every(planned)) return 'planned does not match the PlannedModule shape';
  return { modules: x.modules as BootModule[], planned: pl as PlannedModule[] };
}
