import { describe, expect, it } from 'vitest';
import { hasFlag, hasShortFlag, packageCommand, tokenize } from '../src/core/shell.js';

const names = (s: string) => tokenize(s).map((c) => c.name);

describe('shell tokenizer', () => {
  it('splits on && || ; | and newlines', () => {
    const cmds = tokenize('a && b || c; d | e\nf');
    expect(cmds.map((c) => [c.name, c.op])).toEqual([
      ['a', ''],
      ['b', '&&'],
      ['c', '||'],
      ['d', ';'],
      ['e', '|'],
      ['f', '\n'],
    ]);
    expect(cmds[3]?.pipedInto).toBe(true);
    expect(cmds[4]?.pipedFrom).toBe(true);
  });

  it('does not split inside quotes or $(...)', () => {
    expect(names('echo "a && b" && echo \'c | d\'')).toEqual(['echo', 'echo']);
    const [c] = tokenize('echo $(curl -s x | sh) done');
    expect(c?.words.map((w) => w.text)).toEqual(['echo', '$(curl -s x | sh)', 'done']);
    expect(c?.words[1]?.hasExpansion).toBe(true);
  });

  it('keeps redirections attached to words', () => {
    const cmds = tokenize('make >/dev/null 2>&1 && true');
    expect(cmds).toHaveLength(2);
    expect(cmds[0]?.words.map((w) => w.text)).toEqual(['make', '>/dev/null', '2>&1']);
  });

  it('ignores comments', () => {
    expect(names('echo hi # && rm -rf /\nls')).toEqual(['echo', 'ls']);
  });

  it('skips env assignments and wrappers to find the command name', () => {
    const [c] = tokenize('DEBIAN_FRONTEND=noninteractive sudo -E apt-get install -y curl');
    expect(c?.name).toBe('apt-get');
    expect(c?.wrappers).toEqual(['sudo']);
    expect(tokenize('/usr/bin/curl -s x')[0]?.name).toBe('curl');
  });

  it('skips shell reserved words', () => {
    expect(names('if true; then curl x; fi')).toEqual(['true', 'curl']);
  });

  it('records offsets that point at the original text', () => {
    const text = 'apk add curl && echo ok';
    const [a, b] = tokenize(text);
    expect(text.slice(a?.start, a?.end)).toBe('apk add curl');
    expect(text.slice(b?.args[0]?.start, b?.args[0]?.end)).toBe('ok');
  });

  it('never stalls on odd input', () => {
    for (const s of ['', '&&', '|', '"unterminated', "'x", '$(', '`', ')))', ';;;', '\\']) {
      expect(() => tokenize(s)).not.toThrow();
    }
  });
});

describe('packageCommand', () => {
  const pc = (s: string) => {
    const c = tokenize(s)[0];
    return c && packageCommand(c);
  };

  it('normalises pip invocations', () => {
    expect(pc('pip3 install flask')).toMatchObject({ tool: 'pip', sub: 'install' });
    expect(pc('python -m pip install flask')).toMatchObject({ tool: 'pip', sub: 'install' });
    expect(pc('uv pip install -r r.txt')).toMatchObject({ tool: 'uv-pip', sub: 'install' });
    expect(pc('uv sync --frozen')).toMatchObject({ tool: 'uv', sub: 'sync' });
  });

  it('finds the subcommand after flags', () => {
    expect(pc('apt-get -y install curl')).toMatchObject({ tool: 'apt-get', sub: 'install' });
  });

  it('ignores unknown tools', () => {
    expect(pc('make all')).toBeUndefined();
  });

  it('flag helpers', () => {
    const [c] = tokenize('apt-get install -qy --no-install-recommends curl');
    const words = c?.args ?? [];
    expect(hasShortFlag(words, 'y')).toBe(true);
    expect(hasShortFlag(words, 'z')).toBe(false);
    expect(hasFlag(words, '--no-install-recommends')).toBe(true);
  });
});
