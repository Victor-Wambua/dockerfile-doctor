import { describe, expect, it } from 'vitest';
import { lint } from '../src/core/engine.js';
import { renderGithub } from '../src/reporters/github.js';
import { renderJson } from '../src/reporters/json.js';
import { renderPretty } from '../src/reporters/pretty.js';
import { type FileReport, summarize } from '../src/reporters/types.js';

const SRC = 'FROM node\nRUN apt-get install curl\nCMD node x.js\n';
function report(file = 'svc/Dockerfile'): FileReport {
  const r = lint(SRC, { file });
  return { file, kind: r.kind, findings: r.findings, suppressed: r.suppressed, source: SRC };
}

describe('pretty', () => {
  it('shows file, position, rule id, a source excerpt and a caret under the range', () => {
    const out = renderPretty([report()], { color: false });
    expect(out).toContain('svc/Dockerfile');
    expect(out).toMatch(/1:6\s+warn\s+Base image "node" has no tag/);
    expect(out).toContain('DD001 reproducibility');
    expect(out).toContain('1 | FROM node');
    expect(out).toMatch(/\|\s{6}\^\^\^\^/); // caret under `node`
    expect(out).toMatch(/fix: Add --no-install-recommends/);
    expect(out).toMatch(/\d+ problems? \(/);
  });

  it('emits ANSI colour only when asked', () => {
    expect(renderPretty([report()], { color: false })).not.toContain('\u001b[');
    expect(renderPretty([report()], { color: true })).toContain('\u001b[');
  });

  it('prints a clean message when nothing is found', () => {
    const out = renderPretty(
      [{ file: 'a', kind: 'dockerfile', findings: [], suppressed: 2, source: '' }],
      { color: false },
    );
    expect(out).toContain('No problems found in 1 file.');
    expect(out).toContain('2 findings suppressed');
  });
});

describe('json', () => {
  it('has a stable machine-readable shape', () => {
    const doc = JSON.parse(renderJson([report()], '9.9.9'));
    expect(doc.tool).toEqual({ name: 'dockerfile-doctor', version: '9.9.9' });
    expect(doc.summary).toMatchObject({
      files: 1,
      errors: expect.any(Number),
      warnings: expect.any(Number),
    });
    const f = doc.files[0].findings.find((x: { ruleId: string }) => x.ruleId === 'DD024');
    expect(f).toMatchObject({ severity: 'warn', category: 'size', line: 2, fixable: true });
    expect(Object.keys(f).sort()).toEqual([
      'category',
      'column',
      'endColumn',
      'endLine',
      'fix',
      'fixable',
      'line',
      'message',
      'ruleId',
      'severity',
    ]);
  });

  it('summarises counts consistently', () => {
    const s = summarize([report()]);
    expect(s.errors + s.warnings + s.infos).toBe(report().findings.length);
    expect(s.fixable).toBeGreaterThan(0);
  });
});

describe('github annotations', () => {
  it('maps severities to error/warning/notice with file, line and col', () => {
    const lines = renderGithub([report()]).trim().split('\n');
    expect(lines.length).toBe(report().findings.length);
    expect(
      lines.some((l) =>
        /^::error file=svc\/Dockerfile,line=2,col=\d+,endLine=2,endColumn=\d+,title=DD045 correctness::/.test(
          l,
        ),
      ),
    ).toBe(true);
    expect(lines.some((l) => l.startsWith('::warning '))).toBe(true);
    expect(lines.some((l) => l.startsWith('::notice '))).toBe(true);
  });

  it('escapes commas, colons, percent signs and newlines', () => {
    const out = renderGithub([
      {
        file: 'a,b:c/Dockerfile',
        kind: 'dockerfile',
        source: '',
        suppressed: 0,
        findings: [
          {
            ruleId: 'DD001',
            severity: 'error',
            category: 'size',
            message: '50%\nnext',
            file: 'x',
            line: 1,
            column: 1,
            endLine: 1,
            endColumn: 2,
          },
        ],
      },
    ]);
    expect(out).toContain('file=a%2Cb%3Ac/Dockerfile');
    expect(out).toContain('::50%25%0Anext');
  });

  it('prints nothing for a clean run', () => {
    expect(
      renderGithub([{ file: 'a', kind: 'dockerfile', findings: [], suppressed: 0, source: '' }]),
    ).toBe('');
  });
});
