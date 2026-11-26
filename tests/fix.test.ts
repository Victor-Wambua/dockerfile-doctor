import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lint } from '../src/core/engine.js';
import { applyEdits, fixToFixpoint, planFixes } from '../src/core/fix.js';
import { ALL_RULES } from '../src/rules/index.js';

const fixDockerfile = (text: string) =>
  fixToFixpoint(text, (t) => lint(t, { kind: 'dockerfile' }).findings);
const fixCompose = (text: string) =>
  fixToFixpoint(text, (t) => lint(t, { kind: 'compose' }).findings);

describe('--fix: individual rewrites', () => {
  it('adds --no-install-recommends, -y and list cleanup to apt-get install', () => {
    const out = fixDockerfile('FROM debian:12-slim\nRUN apt-get install curl\n').text;
    expect(out).toBe(
      'FROM debian:12-slim\nRUN apt-get install --no-install-recommends -y curl && rm -rf /var/lib/apt/lists/*\n',
    );
  });

  it('edits a multi-line RUN in place without breaking continuations', () => {
    const src =
      'FROM debian:12-slim\nRUN apt-get update \\\n && apt-get install curl git \\\n && echo done\n';
    const out = fixDockerfile(src).text;
    expect(out).toContain('apt-get install --no-install-recommends -y curl git \\\n && echo done');
  });

  it('does not append the apt cleanup when install is not the last command', () => {
    const src =
      'FROM debian:12-slim\nRUN apt-get install -y --no-install-recommends curl && curl --version\n';
    const out = fixDockerfile(src).text;
    expect(out).toBe(src); // DD025 is reported but not auto-fixable here
    expect(lint(src).findings.some((f) => f.ruleId === 'DD025' && !f.fix)).toBe(true);
  });

  it('replaces ADD with COPY only when it is safe', () => {
    expect(fixDockerfile('FROM alpine:3.20\nADD ./cfg /etc/cfg\n').text).toContain(
      'COPY ./cfg /etc/cfg',
    );
    for (const keep of [
      'ADD rootfs.tar.gz /',
      'ADD https://example.com/x /x',
      'ADD --checksum=sha256:aa https://e.com/x /x',
    ]) {
      expect(fixDockerfile(`FROM alpine:3.20\n${keep}\n`).text).toContain(keep);
    }
  });

  it('adds --no-cache-dir for pip and --no-cache for apk', () => {
    expect(
      fixDockerfile('FROM python:3.12-slim\nRUN pip install -r requirements.txt\n').text,
    ).toContain('pip install --no-cache-dir -r requirements.txt');
    expect(fixDockerfile('FROM alpine:3.20\nRUN apk add curl\n').text).toContain(
      'apk add --no-cache curl',
    );
  });

  it('converts trivial shell-form CMD/ENTRYPOINT to exec form', () => {
    expect(fixDockerfile('FROM alpine:3.20\nCMD node server.js --port 80\n').text).toContain(
      'CMD ["node", "server.js", "--port", "80"]',
    );
    expect(fixDockerfile('FROM alpine:3.20\nENTRYPOINT /bin/run "hello world"\n').text).toContain(
      'ENTRYPOINT ["/bin/run", "hello world"]',
    );
  });

  it('leaves non-trivial shell-form commands alone (variables, pipes, globs, builtins)', () => {
    for (const cmd of [
      'echo $HOME',
      'a && b',
      'sleep 1 | cat',
      'ls *.txt',
      'cd /app',
      'FOO=1 node x',
      'exec node x',
      'node x > out.log',
    ]) {
      const src = `FROM alpine:3.20\nCMD ${cmd}\n`;
      expect(fixDockerfile(src).text, cmd).toBe(src);
      expect(
        lint(src).findings.some((f) => f.ruleId === 'DD034' && !f.fix),
        cmd,
      ).toBe(true);
    }
  });

  it('rewrites MAINTAINER and escapes quotes', () => {
    const out = fixDockerfile(
      'FROM alpine:3.20\nMAINTAINER Jane "JD" Doe <jane@example.com>\n',
    ).text;
    expect(out).toContain(
      'LABEL org.opencontainers.image.authors="Jane \\"JD\\" Doe <jane@example.com>"',
    );
  });

  it('replaces apt with apt-get and upper-cases keywords', () => {
    const out = fixDockerfile(
      'FROM debian:12-slim\nrun apt update && apt install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*\n',
    ).text;
    expect(out).toContain('RUN apt-get update && apt-get install -y --no-install-recommends curl');
  });

  it('removes the obsolete compose version line', () => {
    const out = fixCompose('version: "3.8"\nservices:\n  web:\n    image: nginx:1.27\n').text;
    expect(out).toBe('services:\n  web:\n    image: nginx:1.27\n');
  });
});

describe('--fix: planning', () => {
  it('defers overlapping fixes instead of corrupting text', () => {
    const findings = [
      { fix: { description: 'a', edits: [{ start: 0, end: 5, text: 'X' }] } },
      { fix: { description: 'b', edits: [{ start: 3, end: 8, text: 'Y' }] } },
    ].map((x) => ({
      ...x,
      ruleId: 'T',
      severity: 'warn',
      category: 'size',
      message: '',
      file: 'f',
      line: 1,
      column: 1,
      endLine: 1,
      endColumn: 1,
    })) as never;
    const plan = planFixes(findings);
    expect(plan.applied).toHaveLength(1);
    expect(plan.deferred).toHaveLength(1);
    expect(applyEdits('0123456789', plan.edits)).toBe('X56789');
  });

  it('applies insertions at the same offset in acceptance order', () => {
    expect(
      applyEdits('ab', [
        { start: 1, end: 1, text: 'X', order: 0 },
        { start: 1, end: 1, text: 'Y', order: 1 },
      ]),
    ).toBe('aXYb');
  });
});

const FIX_ROOT = new URL('./fixtures/rules/', import.meta.url).pathname;
const fixtureFiles = readdirSync(FIX_ROOT).flatMap((id) =>
  readdirSync(join(FIX_ROOT, id))
    .filter((f) => /\.(?:Dockerfile|yml)$/.test(f))
    .map((f) => ({ id, f, path: join(FIX_ROOT, id, f) })),
);

describe('--fix: idempotency over every fixture', () => {
  for (const { id, f, path } of fixtureFiles) {
    it(`${id}/${f}`, () => {
      const src = readFileSync(path, 'utf8');
      const kind = f.endsWith('.yml') ? 'compose' : 'dockerfile';
      const lintFn = (t: string) => lint(t, { kind, file: f }).findings;
      const first = fixToFixpoint(src, lintFn);
      const second = fixToFixpoint(first.text, lintFn);
      expect(second.text).toBe(first.text); // a second run changes nothing
      expect(second.applied).toHaveLength(0);
      const remaining = lintFn(first.text);
      const appliedRules = new Set(first.applied.map((a) => a.ruleId));
      // Every fix that was applied is gone, and nothing fixable is left behind.
      expect(remaining.filter((r) => r.fix)).toEqual([]);
      for (const r of appliedRules) {
        const before = lintFn(src).filter((x) => x.ruleId === r).length;
        const after = remaining.filter((x) => x.ruleId === r).length;
        expect(after).toBeLessThan(before);
      }
      // Fixing must not make the file syntactically worse.
      const syntax = (fs: { ruleId: string }[]) =>
        fs.filter((x) => ['DD038', 'DD039', 'DD040', 'DC000'].includes(x.ruleId)).length;
      expect(syntax(remaining)).toBeLessThanOrEqual(syntax(lintFn(src)));
    });
  }
});

describe('fixable metadata', () => {
  it('a rule is marked fixable exactly when some fixture produces a fix', () => {
    const producing = new Set<string>();
    for (const { f, path } of fixtureFiles) {
      const kind = f.endsWith('.yml') ? 'compose' : 'dockerfile';
      for (const finding of lint(readFileSync(path, 'utf8'), { kind, file: f }).findings) {
        if (finding.fix) producing.add(finding.ruleId);
      }
    }
    const declared = new Set(ALL_RULES.filter((r) => r.fixable).map((r) => r.id));
    expect([...producing].sort()).toEqual([...declared].sort());
  });
});
