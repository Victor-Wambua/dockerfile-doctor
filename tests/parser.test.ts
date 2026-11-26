import { describe, expect, it } from 'vitest';
import { expandVars, parseDockerfile, parseImageRef, stageUser } from '../src/core/parser.js';

const parse = (s: string) => parseDockerfile(s);

describe('line continuations', () => {
  it('joins continued lines into one logical instruction', () => {
    const df = parse('FROM alpine:3.20\nRUN apk add --no-cache \\\n    curl \\\n    git\n');
    const run = df.instructions[1];
    expect(run?.keyword).toBe('RUN');
    expect(run?.startLine).toBe(2);
    expect(run?.endLine).toBe(4);
    expect(run?.args.replace(/\s+/g, ' ')).toBe('apk add --no-cache curl git');
  });

  it('tolerates trailing whitespace after the backslash', () => {
    const df = parse('FROM alpine:3.20\nRUN echo a \\   \n  && echo b\n');
    expect(df.instructions[1]?.endLine).toBe(3);
  });

  it('skips comment and blank lines inside a continued instruction', () => {
    const df = parse(
      'FROM alpine:3.20\nRUN apk add \\\n  # a comment in the middle\n\n  curl\nUSER app\n',
    );
    const run = df.instructions[1];
    expect(run?.args.replace(/\s+/g, ' ')).toBe('apk add curl');
    expect(run?.endLine).toBe(5);
    expect(df.instructions[2]?.keyword).toBe('USER');
    expect(df.comments.map((c) => c.text)).toContain('a comment in the middle');
  });

  it('maps logical offsets back to absolute source offsets across continuations', () => {
    const text = 'FROM alpine:3.20\nRUN apk add \\\n  curl\n';
    const run = parse(text).instructions[1];
    expect(run).toBeDefined();
    if (!run) return;
    const at = run.args.indexOf('curl');
    expect(text.slice(run.map[at], run.map[at] + 4)).toBe('curl');
    expect(run.start).toBe(text.indexOf('RUN'));
  });

  it('honours a backtick escape directive', () => {
    const df = parse(
      '# escape=`\nFROM mcr.microsoft.com/windows/servercore:ltsc2022\nRUN echo a `\n  && echo b\nWORKDIR C:\\app\n',
    );
    expect(df.escape).toBe('`');
    expect(df.instructions).toHaveLength(3);
    expect(df.instructions[1]?.endLine).toBe(4);
    expect(df.instructions[2]?.args).toBe('C:\\app');
  });

  it('handles CRLF line endings', () => {
    const df = parse('FROM alpine:3.20\r\nRUN echo a \\\r\n  && echo b\r\nUSER app\r\n');
    expect(df.instructions).toHaveLength(3);
    expect(df.instructions[1]?.args.replace(/\s+/g, ' ')).toBe('echo a && echo b');
  });
});

describe('comments and directives', () => {
  it('records parser directives only at the top of the file', () => {
    const df = parse(
      '# syntax=docker/dockerfile:1.7\n# check=skip=JSONArgsRecommended\nFROM alpine\n# syntax=ignored\n',
    );
    expect(df.directives.map((d) => d.name)).toEqual(['syntax', 'check']);
    expect(df.directives[0]?.value).toBe('docker/dockerfile:1.7');
  });

  it('ends directive processing at the first blank line', () => {
    const df = parse('# syntax=docker/dockerfile:1\n\n# escape=`\nFROM alpine\n');
    expect(df.directives).toHaveLength(1);
    expect(df.escape).toBe('\\');
  });

  it('does not treat # inside an instruction as a comment line', () => {
    const df = parse('FROM alpine\nRUN echo "a # b" # trailing\n');
    expect(df.instructions[1]?.args).toBe('echo "a # b" # trailing');
  });
});

describe('heredocs', () => {
  it('reads a RUN heredoc as the script', () => {
    const text = 'FROM alpine:3.20\nRUN <<EOF\napk add curl\necho done\nEOF\nUSER app\n';
    const df = parse(text);
    const run = df.instructions[1];
    expect(run?.heredocs).toHaveLength(1);
    expect(run?.endLine).toBe(5);
    expect(run?.script?.text).toBe('apk add curl\necho done\n');
    expect(df.instructions[2]?.keyword).toBe('USER');
  });

  it('supports <<- with tab stripping and quoted delimiters', () => {
    const df = parse("FROM alpine\nRUN <<-'END'\n\techo hi\n\tEND\nUSER app\n");
    expect(df.instructions[1]?.heredocs[0]?.stripTabs).toBe(true);
    expect(df.instructions).toHaveLength(3);
  });

  it('does not analyse non-shell heredocs as shell', () => {
    const df = parse('FROM alpine\nRUN python3 <<EOF\nprint("hi")\nEOF\n');
    expect(df.instructions[1]?.script).toBeUndefined();
    expect(df.instructions[1]?.heredocs).toHaveLength(1);
  });

  it('supports COPY heredocs and multiple heredocs in one instruction', () => {
    const df = parse('FROM alpine\nCOPY <<A /a\none\nA\nRUN <<X <<Y\nx\nX\ny\nY\nUSER u\n');
    expect(df.instructions[1]?.heredocs).toHaveLength(1);
    expect(df.instructions[2]?.heredocs).toHaveLength(2);
    expect(df.instructions[3]?.keyword).toBe('USER');
  });

  it('survives an unterminated heredoc without hanging', () => {
    const df = parse('FROM alpine\nRUN <<EOF\necho never closed\n');
    expect(df.instructions[1]?.heredocs).toHaveLength(1);
  });
});

describe('stages and ARG scoping', () => {
  it('splits multi-stage builds and reads names, platform and image parts', () => {
    const df = parse(
      'ARG NODE=22\nFROM --platform=$BUILDPLATFORM node:${NODE}-alpine AS build\nRUN true\nFROM localhost:5000/team/app:1.2@sha256:abc AS final\nCOPY --from=build /a /b\n',
    );
    expect(df.stages).toHaveLength(2);
    expect(df.stages[0]?.name).toBe('build');
    expect(df.stages[0]?.platform).toBe('$BUILDPLATFORM');
    expect(df.stages[0]?.image.resolved).toBe('node:22-alpine');
    expect(df.stages[0]?.image.tag).toBe('22-alpine');
    expect(df.stages[1]?.image).toMatchObject({
      name: 'localhost:5000/team/app',
      tag: '1.2',
      digest: 'sha256:abc',
    });
    expect(df.stages[1]?.instructions).toHaveLength(2);
  });

  it('collects global ARGs before the first FROM and reports other leading instructions as orphans', () => {
    const df = parse('ARG A=1\nARG B\nRUN echo hi\nFROM alpine\nARG C=3\n');
    expect([...df.globalArgs.entries()]).toEqual([
      ['A', '1'],
      ['B', undefined],
    ]);
    expect(df.orphans.map((i) => i.keyword)).toEqual(['RUN']);
    expect(df.globalArgs.has('C')).toBe(false);
  });

  it('leaves unresolved variables visible on the image ref', () => {
    const ref = parseImageRef('node:${V}', new Map());
    expect(ref.unresolvedVars).toEqual(['V']);
    expect(ref.hasVars).toBe(true);
  });

  it('finds the last USER of a stage', () => {
    const df = parse('FROM alpine\nUSER root\nRUN true\nUSER app\n');
    const stage = df.stages[0];
    expect(stage && stageUser(stage)?.value).toBe('app');
  });

  it('expands ${VAR:-default} and ${VAR:+alt}', () => {
    const lookup = (n: string) => (n === 'SET' ? 'x' : undefined);
    expect(expandVars('${SET:-d}-${UNSET:-d}-${SET:+alt}-${UNSET:+alt}', lookup).text).toBe(
      'x-d-alt-',
    );
    expect(expandVars('$MISSING', lookup).missing).toEqual(['MISSING']);
    expect(expandVars('\\$ESC', lookup).text).toBe('$ESC');
  });
});

describe('forms and flags', () => {
  it('distinguishes JSON and shell form', () => {
    const df = parse('FROM alpine\nCMD ["a", "b"]\nCMD a b\nENTRYPOINT [ "x" ]\n');
    expect(df.instructions.slice(1).map((i) => i.form)).toEqual(['json', 'shell', 'json']);
    expect(df.instructions[1]?.json).toEqual(['a', 'b']);
  });

  it('flags malformed JSON exec form', () => {
    const df = parse("FROM alpine\nCMD ['a', 'b']\nCMD [\"a\",]\nCMD [not json\n");
    expect(df.instructions.slice(1).map((i) => i.malformedJson)).toEqual([true, true, false]);
  });

  it('parses leading flags with offsets', () => {
    const text =
      'FROM alpine\nCOPY --from=build --chown=app:app /a /b\nRUN --mount=type=cache,target=/c echo hi\n';
    const df = parse(text);
    const copy = df.instructions[1];
    expect(copy?.flags.map((f) => [f.name, f.value])).toEqual([
      ['from', 'build'],
      ['chown', 'app:app'],
    ]);
    expect(text.slice(copy?.flags[0]?.start, copy?.flags[0]?.end)).toBe('--from=build');
    expect(copy?.args).toBe('/a /b');
    expect(df.instructions[2]?.flags[0]?.value).toBe('type=cache,target=/c');
  });

  it('parses ENV, ARG and LABEL pairs including quotes and the legacy form', () => {
    const df = parse(
      'FROM alpine\nENV A=1 B="two words" C=\'x y\'\nENV LEGACY some value here\nARG X=1 Y\nLABEL a="b c" d=e\n',
    );
    const pairs = (i: number) => df.instructions[i]?.pairs?.map((p) => [p.key, p.value]);
    expect(pairs(1)).toEqual([
      ['A', '1'],
      ['B', 'two words'],
      ['C', 'x y'],
    ]);
    expect(pairs(2)).toEqual([['LEGACY', 'some value here']]);
    expect(pairs(3)).toEqual([
      ['X', '1'],
      ['Y', undefined],
    ]);
    expect(pairs(4)).toEqual([
      ['a', 'b c'],
      ['d', 'e'],
    ]);
  });

  it('keeps unknown keywords so rules can report them', () => {
    const df = parse('FROM alpine\nRNU echo hi\n');
    expect(df.instructions[1]?.keyword).toBe('RNU');
  });

  it('is lenient with lowercase keywords', () => {
    const df = parse('from alpine\nrun echo hi\n');
    expect(df.instructions.map((i) => i.keyword)).toEqual(['FROM', 'RUN']);
    expect(df.instructions[1]?.rawKeyword).toBe('run');
  });

  it('builds a synthetic script for exec-form RUN', () => {
    const run = parse('FROM alpine\nRUN ["apk", "add", "curl"]\n').instructions[1];
    expect(run?.script).toMatchObject({ text: 'apk add curl', synthetic: true });
  });
});
