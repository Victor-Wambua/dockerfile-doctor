import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type LintOptions, lint } from '../src/core/engine.js';
import { ALL_RULES } from '../src/rules/index.js';

const ROOT = new URL('./fixtures/rules/', import.meta.url).pathname;

function optionsFor(dir: string, name: string): LintOptions {
  const p = join(dir, 'options.json');
  if (!existsSync(p)) return {};
  const all = JSON.parse(readFileSync(p, 'utf8')) as Record<string, LintOptions>;
  return all[name] ?? {};
}

describe('rule catalogue integrity', () => {
  it('has unique ids and names', () => {
    expect(new Set(ALL_RULES.map((r) => r.id)).size).toBe(ALL_RULES.length);
    expect(new Set(ALL_RULES.map((r) => r.name)).size).toBe(ALL_RULES.length);
  });

  it('has at least 35 rules and ids follow DDnnn / DCnnn', () => {
    expect(ALL_RULES.length).toBeGreaterThanOrEqual(35);
    for (const r of ALL_RULES)
      expect(r.id).toMatch(r.kind === 'dockerfile' ? /^DD\d{3}$/ : /^DC\d{3}$/);
  });

  it('documents every rule (explanation, why, before, after)', () => {
    for (const r of ALL_RULES) {
      for (const k of ['summary', 'explanation', 'why', 'before', 'after'] as const) {
        expect(r[k].trim().length, `${r.id}.${k}`).toBeGreaterThan(5);
      }
    }
  });

  it('has a positive and a negative fixture for every rule', () => {
    for (const r of ALL_RULES) {
      const dir = join(ROOT, r.id);
      expect(existsSync(dir), `${r.id} fixtures`).toBe(true);
      const files = readdirSync(dir);
      expect(
        files.some((f) => f.startsWith('bad')),
        `${r.id} bad`,
      ).toBe(true);
      expect(
        files.some((f) => f.startsWith('good')),
        `${r.id} good`,
      ).toBe(true);
    }
  });
});

for (const rule of ALL_RULES) {
  describe(`${rule.id} ${rule.name}`, () => {
    const dir = join(ROOT, rule.id);
    const files = existsSync(dir)
      ? readdirSync(dir)
          .filter((f) => /^(?:bad|good)/.test(f))
          .sort()
      : [];
    for (const name of files) {
      const source = readFileSync(join(dir, name), 'utf8');
      const expectHit = name.startsWith('bad');
      it(`${expectHit ? 'reports' : 'stays quiet on'} ${name}`, () => {
        const res = lint(source, { file: name, ...optionsFor(dir, name) });
        const ids = res.findings.filter((f) => f.ruleId === rule.id);
        if (expectHit) {
          expect(
            ids.length,
            `expected ${rule.id} in ${name}; got ${res.findings.map((f) => f.ruleId).join(',')}`,
          ).toBeGreaterThan(0);
          for (const f of ids) {
            expect(f.line).toBeGreaterThanOrEqual(1);
            expect(f.column).toBeGreaterThanOrEqual(1);
            expect(f.message.length).toBeGreaterThan(10);
          }
        } else {
          expect(ids.map((f) => `${f.line}:${f.message}`)).toEqual([]);
        }
      });
    }
  });
}
