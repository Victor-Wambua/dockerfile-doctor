import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lint } from '../src/core/engine.js';
import { fixToFixpoint } from '../src/core/fix.js';

const ROOT = new URL('./fixtures/rules/', import.meta.url).pathname;
const corpus = readdirSync(ROOT).flatMap((id) =>
  readdirSync(join(ROOT, id))
    .filter((f) => /\.(?:Dockerfile|yml)$/.test(f))
    .map((f) => ({
      name: `${id}/${f}`,
      text: readFileSync(join(ROOT, id, f), 'utf8'),
      kind: f.endsWith('.yml') ? ('compose' as const) : ('dockerfile' as const),
    })),
);

describe('robustness: the linter never throws and reported ranges stay inside the file', () => {
  it('handles every prefix of every fixture', () => {
    let runs = 0;
    for (const { text, kind } of corpus) {
      const step = Math.max(1, Math.floor(text.length / 25));
      for (let end = 0; end <= text.length; end += step) {
        const cut = text.slice(0, end);
        const res = lint(cut, { kind });
        const lines = cut.split('\n').length;
        for (const f of res.findings) {
          expect(f.line).toBeGreaterThanOrEqual(1);
          expect(f.line).toBeLessThanOrEqual(lines);
          expect(f.endLine).toBeGreaterThanOrEqual(f.line);
        }
        runs++;
      }
    }
    expect(runs).toBeGreaterThan(1000);
  });

  it('handles hostile and degenerate input', () => {
    const inputs = [
      '',
      '\n\n\n',
      '#',
      'FROM',
      'FROM ',
      'RUN',
      'RUN \\',
      'RUN \\\n',
      '\\\n\\\n\\',
      'FROM a\nRUN <<',
      'FROM a\nRUN <<EOF',
      'FROM a\nENV =\nENV ==x\nARG =',
      'FROM a\nCOPY\nADD\nEXPOSE\nWORKDIR\nUSER\nLABEL',
      'FROM a\nCMD [',
      'FROM a\nCMD ]',
      'FROM a\nRUN "unterminated',
      "FROM a\nRUN 'x",
      'FROM a\nRUN $(((',
      '\u0000\u0001\ufffe',
      `FROM a\nRUN ${'x '.repeat(5000)}`,
      `FROM ${'a'.repeat(10000)}`,
      '---\n',
      'services:',
      'services: []',
      'services:\n  a: 1\n  b:\n  c: [',
      '{{{{',
      'a: &x\n  <<: *x',
    ];
    for (const text of inputs) {
      expect(() => lint(text, { kind: 'dockerfile' })).not.toThrow();
      expect(() => lint(text, { kind: 'compose' })).not.toThrow();
      expect(() =>
        fixToFixpoint(text, (t) => lint(t, { kind: 'dockerfile' }).findings),
      ).not.toThrow();
    }
  });

  it('is fast on a large file', () => {
    const big = `FROM alpine:3.20\n${'RUN apk add --no-cache curl && echo done\n'.repeat(3000)}`;
    const t0 = performance.now();
    lint(big);
    expect(performance.now() - t0).toBeLessThan(3000);
  });
});
