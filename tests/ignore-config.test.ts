import { describe, expect, it } from 'vitest';
import { mergeSettings, parseConfig } from '../src/core/config.js';
import { lint } from '../src/core/engine.js';
import { matchesGlob } from '../src/core/glob.js';

const BAD = 'FROM node\nRUN npm install\nCMD node x.js\n';
const ids = (text: string, opts = {}) => lint(text, opts).findings.map((f) => f.ruleId);

describe('inline ignores (Dockerfile)', () => {
  it('suppresses the named rule on the next instruction only', () => {
    const text = '# dd-ignore DD001\nFROM node\nRUN npm install\n';
    const found = ids(text);
    expect(found).not.toContain('DD001');
    expect(found).toContain('DD019');
  });

  it('accepts several ids, commas and a free-text reason', () => {
    const text =
      '# dd-ignore DD001, DD003 -- base is pinned by the platform\nFROM node\nCMD ["node"]\n';
    expect(ids(text)).not.toContain('DD001');
    expect(ids(text)).not.toContain('DD003');
    expect(lint(text).suppressed).toBeGreaterThanOrEqual(2);
  });

  it('applies to every line of a continued instruction', () => {
    const text = 'FROM alpine:3.20\n# dd-ignore DD027\nRUN apk add \\\n    curl\n';
    expect(ids(text)).not.toContain('DD027');
  });

  it('does not leak onto the following instruction', () => {
    const text = 'FROM alpine:3.20\n# dd-ignore DD027\nRUN apk add curl\nRUN apk add git\n';
    expect(
      lint(text)
        .findings.filter((f) => f.ruleId === 'DD027')
        .map((f) => f.line),
    ).toEqual([4]);
  });

  it('a bare dd-ignore silences every rule on that instruction', () => {
    const text = '# dd-ignore\nFROM node\n';
    expect(lint(text).findings.filter((f) => f.line === 2)).toEqual([]);
  });

  it('dd-ignore-file silences a rule everywhere', () => {
    const text = '# dd-ignore-file DD019\nFROM node:22\nRUN npm install\nRUN npm install\n';
    expect(ids(text)).not.toContain('DD019');
  });

  it('is case-insensitive and ignores unknown ids safely', () => {
    expect(ids('# dd-ignore dd001\nFROM node\n')).not.toContain('DD001');
  });
});

describe('inline ignores (compose YAML)', () => {
  const yml = (comment: string) =>
    `services:\n  db:\n    image: postgres:16\n${comment}    ports:\n      - "5432:5432"\n    restart: always\n`;

  it('suppresses a finding on the line below, including nested items', () => {
    expect(ids(yml(''), { kind: 'compose' })).toContain('DC005');
    expect(ids(yml('    # dd-ignore DC005\n'), { kind: 'compose' })).not.toContain('DC005');
  });

  it('supports a trailing comment on the same line', () => {
    const text =
      'services:\n  web:\n    image: nginx:latest # dd-ignore DC001\n    restart: always\n';
    expect(ids(text, { kind: 'compose' })).not.toContain('DC001');
  });

  it('a comment above a service covers the whole service', () => {
    const text = 'services:\n  # dd-ignore DC007 DC008 DC009\n  web:\n    image: nginx:1.27\n';
    const found = ids(text, { kind: 'compose' });
    expect(found).not.toContain('DC007');
    expect(found).not.toContain('DC008');
  });
});

describe('config file', () => {
  it('parses rules, disable, ignore, exclude and failOn', () => {
    const { config, errors } = parseConfig(
      `rules:\n  DD002: off\n  DD032: warn\ndisable: [DD046]\nexclude:\n  - build/**\nignore:\n  - path: legacy/**\n    rules: [DD003]\nfailOn: error\n`,
    );
    expect(errors).toEqual([]);
    expect(config.rules).toEqual({ DD002: 'off', DD032: 'warn', DD046: 'off' });
    expect(config.ignore).toEqual([{ path: 'legacy/**', rules: ['DD003'] }]);
    expect(config.exclude).toEqual(['build/**']);
    expect(config.failOn).toBe('error');
  });

  it('reports mistakes instead of silently ignoring them', () => {
    const { errors } = parseConfig(
      'rules:\n  DD999: off\n  DD001: loud\nbogus: 1\nignore:\n  - rules: [DD001]\n',
    );
    expect(errors.join('\n')).toMatch(/unknown rule "DD999"/);
    expect(errors.join('\n')).toMatch(/DD001: expected off, error, warn or info/);
    expect(errors.join('\n')).toMatch(/unknown key "bogus"/);
    expect(errors.join('\n')).toMatch(/needs a "path"/);
  });

  it('accepts YAML booleans and warning as aliases', () => {
    const { config, errors } = parseConfig('rules:\n  DD001: false\n  DD003: warning\n');
    expect(errors).toEqual([]);
    expect(config.rules).toEqual({ DD001: 'off', DD003: 'warn' });
  });

  it('an empty file is a valid empty config', () => {
    expect(parseConfig('').errors).toEqual([]);
  });
});

describe('precedence', () => {
  const base = (cfg: string, overrides = {}, extra = {}) =>
    lint(BAD, { config: parseConfig(cfg).config, overrides, ...extra }).findings;

  it('defaults: DD001 is a warning', () => {
    expect(lint(BAD).findings.find((f) => f.ruleId === 'DD001')?.severity).toBe('warn');
  });

  it('config overrides the default severity', () => {
    expect(base('rules:\n  DD001: error').find((f) => f.ruleId === 'DD001')?.severity).toBe(
      'error',
    );
  });

  it('config can switch a rule off', () => {
    expect(base('rules:\n  DD001: off').some((f) => f.ruleId === 'DD001')).toBe(false);
  });

  it('command-line overrides beat the config file', () => {
    expect(
      base('rules:\n  DD001: off', { DD001: 'info' }).find((f) => f.ruleId === 'DD001')?.severity,
    ).toBe('info');
    expect(base('rules:\n  DD001: error', { DD001: 'off' }).some((f) => f.ruleId === 'DD001')).toBe(
      false,
    );
  });

  it('a config override also beats a finding-level severity', () => {
    const text = 'FROM alpine\nARG TOKEN\n'; // DD008 reports this as warn for ARG without default
    expect(lint(text).findings.find((f) => f.ruleId === 'DD008')?.severity).toBe('warn');
    const cfg = parseConfig('rules:\n  DD008: error').config;
    expect(lint(text, { config: cfg }).findings.find((f) => f.ruleId === 'DD008')?.severity).toBe(
      'error',
    );
  });

  it('per-path ignores drop findings only for matching files and rules', () => {
    const cfg = parseConfig('ignore:\n  - path: legacy/**\n    rules: [DD001]\n').config;
    const inLegacy = lint(BAD, { config: cfg, file: 'legacy/app/Dockerfile' }).findings.map(
      (f) => f.ruleId,
    );
    const elsewhere = lint(BAD, { config: cfg, file: 'svc/Dockerfile' }).findings.map(
      (f) => f.ruleId,
    );
    expect(inLegacy).not.toContain('DD001');
    expect(inLegacy).toContain('DD019');
    expect(elsewhere).toContain('DD001');
  });

  it('inline ignores work together with config', () => {
    const cfg = parseConfig('rules:\n  DD019: error').config;
    const text = 'FROM node:22\n# dd-ignore DD019\nRUN npm install\n';
    expect(lint(text, { config: cfg }).findings.some((f) => f.ruleId === 'DD019')).toBe(false);
  });

  it('mergeSettings lets later layers win', () => {
    expect(mergeSettings({ DD001: 'off', DD002: 'warn' }, { DD001: 'error' })).toEqual({
      DD001: 'error',
      DD002: 'warn',
    });
  });
});

describe('glob', () => {
  it.each([
    ['examples/bad/a.Dockerfile', 'examples/bad/**', true],
    ['examples/good/a.Dockerfile', 'examples/bad/**', false],
    ['a/b/Dockerfile', '**/Dockerfile', true],
    ['Dockerfile', '**/Dockerfile', true],
    ['a/Dockerfile.dev', 'a/Dockerfile.*', true],
    ['a/b/Dockerfile.dev', 'a/Dockerfile.*', false],
    ['legacy/x/y', 'legacy', true],
    ['legacy2/x', 'legacy', false],
    ['./svc/Dockerfile', 'svc/*', true],
  ])('%s vs %s -> %s', (path, glob, expected) => expect(matchesGlob(path, glob)).toBe(expected));
});
