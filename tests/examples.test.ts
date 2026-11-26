import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lint } from '../src/core/engine.js';
import { discover, dockerignoreFor } from '../src/node/files.js';

const ROOT = new URL('../', import.meta.url).pathname;

describe('examples/good: zero errors and zero warnings', () => {
  const { files } = discover([join(ROOT, 'examples/good')], ROOT);

  it('finds the three example apps and the compose file', () => {
    const names = files.map((f) => relative(ROOT, f));
    expect(names).toEqual(
      expect.arrayContaining([
        'examples/good/fastapi/Dockerfile',
        'examples/good/laravel/Dockerfile',
        'examples/good/node/Dockerfile',
        'examples/good/laravel/compose.yaml',
      ]),
    );
  });

  for (const abs of files) {
    const rel = relative(ROOT, abs);
    it(rel, () => {
      const res = lint(readFileSync(abs, 'utf8'), {
        file: rel,
        dockerignore: abs.endsWith('.yaml') ? undefined : dockerignoreFor(abs),
      });
      const bad = res.findings.filter((f) => f.severity !== 'info');
      expect(bad.map((f) => `${f.line}:${f.ruleId} ${f.message}`)).toEqual([]);
    });
  }
});

describe('examples/bad: each file triggers exactly the rules it declares', () => {
  const dir = join(ROOT, 'examples/bad');
  const files = readdirSync(dir).filter((f) => /dockerfile|\.ya?ml$/i.test(f));

  it('has a gallery of at least five bad examples', () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  for (const f of files) {
    it(f, () => {
      const src = readFileSync(join(dir, f), 'utf8');
      const declared = /^# expect:\s*(.+)$/m.exec(src)?.[1]?.trim().split(/\s+/) ?? [];
      expect(declared.length, 'missing "# expect:" header').toBeGreaterThan(0);
      const found = [...new Set(lint(src, { file: f }).findings.map((x) => x.ruleId))].sort();
      expect(found).toEqual([...declared].sort());
    });
  }

  it('together they exercise most of the rule catalogue', () => {
    const all = new Set<string>();
    for (const f of files)
      for (const x of lint(readFileSync(join(dir, f), 'utf8'), { file: f }).findings)
        all.add(x.ruleId);
    expect(all.size).toBeGreaterThanOrEqual(40);
  });
});
