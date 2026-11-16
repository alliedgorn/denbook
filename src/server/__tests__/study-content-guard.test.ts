// Study content images (Gorn 11-16): only same-origin uploads may be shown. A lesson
// must never make the page fetch from elsewhere or reach another route.
import { expect, test } from 'bun:test';
import { checkBootFile } from '../../../frontend/src/study/contentGuard.ts';
const mod = (b: any[]) => ({ modules: [{ id: 'm', name: 'n', week: 'w', lede: 'l', concepts: [{ t: 't', b, say: 's' }], labs: [], quiz: [], drills: [] }], planned: [] });
const ok = (img: any) => typeof checkBootFile(mod([img])) !== 'string';
test('img guard', () => {
  expect(ok({ img: '/api/f/daf263ea-2861-4245-8933-ffb7d9b98647.png', alt: 'x' })).toBe(true);
  expect(ok({ img: '/api/f/abc.jpg', alt: 'x', caption: 'c' })).toBe(true);
  for (const bad of ['https://evil.example/a.png', '//evil.example/api/f/a.png', '/api/f/../auth/me.png', '/api/f/a.png?x=1', '/api/f/a.svg', '/api/files/1/download', ' /api/f/a.png', '/api/f/a.png\n', 'javascript:alert(1)'])
    expect(ok({ img: bad, alt: 'x' })).toBe(false);
  expect(ok({ img: '/api/f/a.png' })).toBe(false);          // alt required
  expect(ok({ img: '/api/f/a.png', alt: '' })).toBe(false); // alt non-empty
  expect(ok({ img: '/api/f/a.png', alt: 'x', caption: 3 })).toBe(false);
  expect(ok({ p: ['still fine'] })).toBe(true);
});
