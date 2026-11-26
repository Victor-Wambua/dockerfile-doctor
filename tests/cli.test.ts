import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type IO, runCli } from '../src/node/run.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dd-cli-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(rel: string, content: string): string {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
  return p;
}

async function cli(
  args: string[],
  stdin = '',
): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const io: IO = {
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
    cwd: dir,
    isTTY: false,
    env: {},
    readStdin: () => stdin,
  };
  const code = await runCli(args, io);
  return { code, out, err };
}

const CLEAN = 'FROM alpine:3.20\nUSER 10001\nHEALTHCHECK CMD true\nCMD ["true"]\n';
const WARN = 'FROM alpine:3.20\nRUN apk add curl\nUSER 10001\nHEALTHCHECK CMD true\n'; // DD027 warn
const ERR = 'FROM alpine:3.20\nRUN curl -s https://x.sh | sh\nUSER 10001\nHEALTHCHECK CMD true\n'; // DD007 error

describe('exit codes', () => {
  it('0 when clean', async () => {
    write('Dockerfile', CLEAN);
    write('.dockerignore', '.git\n');
    expect((await cli(['.'])).code).toBe(0);
  });

  it('default threshold is warn: warnings fail, info does not', async () => {
    write('Dockerfile', WARN);
    expect((await cli(['.'])).code).toBe(1);
    write('Dockerfile', 'FROM alpine:3.20@sha256:aa\nUSER 1\nHEALTHCHECK CMD true\n');
    expect((await cli(['.'])).code).toBe(0);
    write('Dockerfile', 'FROM alpine:3.20\nUSER 1\nHEALTHCHECK CMD true\n'); // DD002 info only
    expect((await cli(['.'])).code).toBe(0);
  });

  it('--fail-on error ignores warnings but not errors', async () => {
    write('Dockerfile', WARN);
    expect((await cli(['--fail-on', 'error', '.'])).code).toBe(0);
    write('Dockerfile', ERR);
    expect((await cli(['--fail-on', 'error', '.'])).code).toBe(1);
  });

  it('--fail-on info fails on info and --fail-on never never fails', async () => {
    write('Dockerfile', 'FROM alpine:3.20\nUSER 1\nHEALTHCHECK CMD true\n');
    expect((await cli(['--fail-on', 'info', '.'])).code).toBe(1);
    write('Dockerfile', ERR);
    expect((await cli(['--fail-on', 'never', '.'])).code).toBe(0);
  });

  it('2 for usage and configuration problems', async () => {
    write('Dockerfile', CLEAN);
    expect((await cli(['--bogus'])).code).toBe(2);
    expect((await cli(['--format', 'xml', '.'])).code).toBe(2);
    expect((await cli(['--fail-on', 'loud', '.'])).code).toBe(2);
    expect((await cli(['--disable', 'DD999', '.'])).code).toBe(2);
    expect((await cli(['missing/'])).code).toBe(2);
    write('.dockerdoctor.yml', 'rules:\n  DD999: off\n');
    const r = await cli(['.']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/unknown rule "DD999"/);
  });

  it('failOn in the config file is the default threshold, and the flag beats it', async () => {
    write('Dockerfile', WARN);
    write('.dockerdoctor.yml', 'failOn: error\n');
    expect((await cli(['.'])).code).toBe(0);
    expect((await cli(['--fail-on', 'warn', '.'])).code).toBe(1);
  });
});

describe('discovery and config', () => {
  it('finds Dockerfiles and compose files recursively, skipping node_modules and .git', async () => {
    write('a/Dockerfile', ERR);
    write('b/api.Dockerfile', ERR);
    write('c/Dockerfile.dev', ERR);
    write('compose.yaml', 'services:\n  w:\n    image: nginx:latest\n');
    write('node_modules/x/Dockerfile', ERR);
    write('.git/Dockerfile', ERR);
    write('README.md', 'FROM nope');
    const r = await cli(['-f', 'json', '--fail-on', 'never', '.']);
    const files = JSON.parse(r.out)
      .files.map((f: { file: string }) => f.file)
      .sort();
    expect(files).toEqual(['a/Dockerfile', 'b/api.Dockerfile', 'c/Dockerfile.dev', 'compose.yaml']);
  });

  it('uses the nearest .dockerdoctor.yml: disable, severity, per-path ignore, exclude', async () => {
    write('app/Dockerfile', ERR);
    write('legacy/Dockerfile', ERR);
    write('skip/Dockerfile', ERR);
    write(
      '.dockerdoctor.yml',
      'rules:\n  DD007: warn\n  DD002: off\nexclude:\n  - skip/**\nignore:\n  - path: legacy/**\n    rules: [DD007]\n',
    );
    const r = JSON.parse((await cli(['-f', 'json', '--fail-on', 'never', '.'])).out);
    expect(r.files.map((f: { file: string }) => f.file)).toEqual([
      'app/Dockerfile',
      'legacy/Dockerfile',
    ]);
    const app = r.files[0].findings.find((f: { ruleId: string }) => f.ruleId === 'DD007');
    expect(app.severity).toBe('warn');
    expect(r.files[1].findings.some((f: { ruleId: string }) => f.ruleId === 'DD007')).toBe(false);
    expect(r.files[1].suppressed).toBeGreaterThan(0);
  });

  it('--no-config ignores the file and --disable / --rule override it', async () => {
    write('Dockerfile', ERR);
    write('.dockerdoctor.yml', 'rules:\n  DD007: off\n');
    const has = async (args: string[]) =>
      JSON.parse(
        (await cli(['-f', 'json', '--fail-on', 'never', ...args, '.'])).out,
      ).files[0].findings.some((f: { ruleId: string }) => f.ruleId === 'DD007');
    expect(await has([])).toBe(false);
    expect(await has(['--no-config'])).toBe(true);
    expect(await has(['--rule', 'DD007=error'])).toBe(true);
    write('.dockerdoctor.yml', 'rules:\n  DD007: error\n');
    expect(await has(['--disable', 'DD007'])).toBe(false);
  });

  it('reports a missing .dockerignore only when the Dockerfile copies the whole context', async () => {
    write('a/Dockerfile', 'FROM alpine:3.20\nCOPY . /app\nUSER 1\nHEALTHCHECK CMD true\n');
    write('b/Dockerfile', 'FROM alpine:3.20\nCOPY . /app\nUSER 1\nHEALTHCHECK CMD true\n');
    write('b/.dockerignore', '.git\n');
    write('c/Dockerfile', 'FROM alpine:3.20\nCOPY app.js /app/\nUSER 1\nHEALTHCHECK CMD true\n');
    const r = JSON.parse((await cli(['-f', 'json', '--fail-on', 'never', '.'])).out);
    const hit = (file: string) =>
      r.files
        .find((f: { file: string }) => f.file === file)
        .findings.some((x: { ruleId: string }) => x.ruleId === 'DD030');
    expect(hit('a/Dockerfile')).toBe(true);
    expect(hit('b/Dockerfile')).toBe(false);
    expect(hit('c/Dockerfile')).toBe(false);
  });

  it('honours <Dockerfile>.dockerignore', async () => {
    write('Dockerfile.prod', 'FROM alpine:3.20\nCOPY . /app\nUSER 1\nHEALTHCHECK CMD true\n');
    write('Dockerfile.prod.dockerignore', '.git\n');
    const r = JSON.parse((await cli(['-f', 'json', '--fail-on', 'never', '.'])).out);
    expect(r.files[0].findings.some((x: { ruleId: string }) => x.ruleId === 'DD030')).toBe(false);
  });
});

describe('formats', () => {
  it('sarif and github formats are produced from the CLI', async () => {
    write('Dockerfile', ERR);
    const sarif = JSON.parse((await cli(['-f', 'sarif', '--fail-on', 'never', '.'])).out);
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].results.some((r: { ruleId: string }) => r.ruleId === 'DD007')).toBe(true);
    const gh = (await cli(['-f', 'github', '--fail-on', 'never', '.'])).out;
    expect(gh).toMatch(/^::error file=Dockerfile,line=2,/m);
  });

  it('--output writes the report to a file', async () => {
    write('Dockerfile', ERR);
    const out = join(dir, 'report.sarif');
    const r = await cli(['-f', 'sarif', '-o', out, '--fail-on', 'never', '.']);
    expect(r.out).toBe('');
    expect(JSON.parse(readFileSync(out, 'utf8')).version).toBe('2.1.0');
  });

  it('--list-rules and --explain', async () => {
    const list = await cli(['--list-rules']);
    expect(list.out.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(35);
    expect(list.out).toMatch(/DD007\s+error\s+security/);
    const ex = await cli(['--explain', 'dd007']);
    expect(ex.out).toContain('Why it matters');
    expect(ex.out).toContain('Before:');
    expect((await cli(['--explain', 'DD999'])).code).toBe(2);
  });

  it('--version and --help', async () => {
    expect((await cli(['--version'])).out).toMatch(/^\d+\.\d+\.\d+\n$/);
    expect((await cli(['--help'])).out).toContain('Exit codes');
  });
});

describe('--fix', () => {
  const BEFORE =
    'FROM debian:12-slim\nRUN apt-get install curl\nCMD node x.js\nUSER 1\nHEALTHCHECK CMD true\n';

  it('--fix-dry-run prints a diff and writes nothing', async () => {
    const p = write('Dockerfile', BEFORE);
    const r = await cli(['--fix-dry-run', '.']);
    expect(r.out).toContain('--- a/Dockerfile');
    expect(r.out).toContain(
      '+RUN apt-get install --no-install-recommends -y curl && rm -rf /var/lib/apt/lists/*',
    );
    expect(r.out).toContain('+CMD ["node", "x.js"]');
    expect(readFileSync(p, 'utf8')).toBe(BEFORE);
  });

  it('--fix rewrites the file, and a second run is a no-op', async () => {
    const p = write('Dockerfile', BEFORE);
    const first = await cli(['--fix', '.']);
    expect(first.out).toMatch(/Applied \d+ fixes? in 1 file/);
    const fixed = readFileSync(p, 'utf8');
    expect(fixed).not.toBe(BEFORE);
    const second = await cli(['--fix-dry-run', '.']);
    expect(second.out).toContain('Nothing to fix automatically.');
    expect(readFileSync(p, 'utf8')).toBe(fixed);
    // The exit code reflects what is left after fixing: only info-level findings remain, so 0.
    expect(first.code).toBe(0);
  });

  it('--fix leaves a clean file byte-for-byte untouched', async () => {
    const p = write('Dockerfile', CLEAN);
    write('.dockerignore', '.git\n');
    await cli(['--fix', '.']);
    expect(readFileSync(p, 'utf8')).toBe(CLEAN);
  });

  it('--fix with --stdin is refused, --fix-dry-run works', async () => {
    expect((await cli(['--stdin', '--fix'], BEFORE)).code).toBe(2);
    const r = await cli(['--stdin', '--fix-dry-run', '--stdin-filename', 'Dockerfile'], BEFORE);
    expect(r.out).toContain('+CMD ["node", "x.js"]');
  });
});

describe('stdin', () => {
  it('lints stdin as a Dockerfile or compose file', async () => {
    const d = JSON.parse((await cli(['--stdin', '-f', 'json', '--fail-on', 'never'], ERR)).out);
    expect(d.files[0].file).toBe('stdin');
    expect(d.files[0].kind).toBe('dockerfile');
    const c = JSON.parse(
      (
        await cli(
          ['--stdin', '--type', 'compose', '-f', 'json', '--fail-on', 'never'],
          'services:\n  w:\n    image: nginx:latest\n',
        )
      ).out,
    );
    expect(c.files[0].kind).toBe('compose');
    expect(c.files[0].findings.some((f: { ruleId: string }) => f.ruleId === 'DC001')).toBe(true);
  });
});

describe('sanity', () => {
  it('the temp dir helper is isolated', () => {
    expect(existsSync(dir)).toBe(true);
  });
});
