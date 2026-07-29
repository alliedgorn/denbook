/**
 * truncateForTmux — T#893 doorbell preview truncation.
 *
 * Regression cover for the three defects the old private `sanitizeForTmux`
 * copies carried. Each test names the failure it locks out.
 */

import { describe, it, expect } from 'bun:test';
import { truncateForTmux } from './notify.ts';

describe('truncateForTmux', () => {
  describe('surrogate pairs — the defect that could emit invalid UTF-8', () => {
    it('never splits an emoji at the boundary', () => {
      // 199 ASCII then an astral char: under the OLD unit-based slice(0,200)
      // this kept only the HIGH surrogate and produced a string that did not
      // round-trip as UTF-8.
      const input = 'x'.repeat(199) + '\u{1F99D}' + ' tail';
      const out = truncateForTmux(input, 200);
      expect([...out].every((ch) => {
        const c = ch.codePointAt(0)!;
        return c < 0xd800 || c > 0xdfff; // no lone surrogate survived
      })).toBe(true);
      expect(Buffer.from(out, 'utf8').toString('utf8')).toBe(out);
    });

    it('counts codepoints, not UTF-16 units', () => {
      // 250 raccoons = 250 codepoints = 500 UTF-16 units.
      const out = truncateForTmux('\u{1F99D}'.repeat(250), 200);
      expect([...out].length).toBe(201); // 200 + the marker
    });
  });

  describe('the cap is not "199" — that was our own signing convention', () => {
    it('cuts pure ASCII at exactly maxLen', () => {
      const out = truncateForTmux('a'.repeat(500), 200);
      expect([...out].length).toBe(201); // 200 + marker
    });

    it('cuts emoji-led text at maxLen codepoints too, not 199', () => {
      // The old slice gave 199 here because one emoji spent 2 units.
      const input = '\u{1F99D} ' + 'b'.repeat(500);
      const out = truncateForTmux(input, 200);
      expect([...out].length).toBe(201);
      expect([...out].slice(0, 1)[0]).toBe('\u{1F99D}');
    });
  });

  describe('quotes and backslashes pass through — they buy nothing on this transport', () => {
    it('preserves a curl payload verbatim', () => {
      // The scheduler byte-compare rails carry these. The old `"`->`'` and
      // `\`->`\\` substitutions corrupted them for no security gain: the
      // transport is base64 end to end and terminates at `send-keys -l`.
      const payload = `curl -H "Authorization: Bearer den_x" -d '{"a":1}' \\path\\to`;
      expect(truncateForTmux(payload, 200)).toBe(payload);
    });

    it('does not inflate a backslash-dense preview out of its own budget', () => {
      // Old behaviour: 150 backslashes doubled to 300 units and consumed the
      // whole cap, so text UNDER the limit lost all its real content.
      const input = '\\'.repeat(150) + 'REAL CONTENT';
      const out = truncateForTmux(input, 200);
      expect(out).toContain('REAL CONTENT');
      expect(out).toBe(input); // 162 codepoints — under the cap, untouched
    });

    it('leaves no trailing lone backslash at the cut', () => {
      const out = truncateForTmux('\\'.repeat(400), 200);
      const body = out.slice(0, -1); // drop marker
      expect([...body].length).toBe(200); // exactly maxLen, no half-escape
    });
  });

  describe('newlines', () => {
    it('flattens CRLF, CR and LF to spaces', () => {
      expect(truncateForTmux('a\r\nb\rc\nd', 200)).toBe('a b c d');
    });
  });

  describe('the marker — the old cut was silent', () => {
    it('appends an ellipsis only when it actually truncated', () => {
      expect(truncateForTmux('short', 200)).toBe('short');
      expect(truncateForTmux('short', 200).endsWith('…')).toBe(false);
      expect(truncateForTmux('a'.repeat(201), 200).endsWith('…')).toBe(true);
    });

    it('does not truncate text exactly at the cap', () => {
      const exact = 'a'.repeat(200);
      expect(truncateForTmux(exact, 200)).toBe(exact);
    });
  });
});
