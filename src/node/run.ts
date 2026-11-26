import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { parseArgs } from 'node:util';
import { isExcluded, type RuleSetting } from '../core/config.js';
import { unifiedDiff } from '../core/diff.js';
import { detectKind, lint } from '../core/engine.js';
import { fixToFixpoint } from '../core/fix.js';
import { type FileKind, SEVERITY_RANK, type Severity } from '../core/types.js';
import { renderGithub } from '../reporters/github.js';
import { renderJson } from '../reporters/json.js';
import { renderPretty } from '../reporters/pretty.js';
import { renderSarif } from '../reporters/sarif.js';
import { type FileReport, summarize } from '../reporters/types.js';
import { ALL_RULES, getRule, isRuleId } from '../rules/index.js';
import { discover, dockerignoreFor, loadConfig, toPosix } from './files.js';
import { version } from './version.js';

export interface IO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  cwd: string;
  isTTY: boolean;
  env: Record<string, string | undefined>;
  readStdin: () => string;
}

const HELP = `dockerfile-doctor __VERSION__
Lint and fix Dockerfiles and docker-compose files for security, reproducibility and size.

Usage
  dockerfile-doctor [options] [paths...]      paths may be files or directories (default: .)
  dockerfile-doctor --stdin [--type dockerfile|compose] [--stdin-filename NAME]

Options
  -f, --format <fmt>       pretty (default), json, sarif, github
      --fail-on <level>    exit 1 when a finding is at or above: error, warn (default), info, never
  -c, --config <file>      use this config instead of the nearest .dockerdoctor.yml
      --no-config          ignore any .dockerdoctor.yml
      --disable <ids>      comma-separated rule ids to turn off, e.g. DD002,DD032
      --rule <ID=level>    set one rule to off|error|warn|info (repeatable)
      --fix                apply the safe automatic fixes in place
      --fix-dry-run        print a diff of what --fix would change; write nothing
  -o, --output <file>      write the report to a file instead of stdout
      --color / --no-color force colour on or off (default: auto)
      --list-rules         print every rule (use with -f json for machine output)
      --explain <id>       show the explanation, rationale and before/after for a rule
  -v, --version
  -h, --help

Exit codes: 0 = clean at the threshold, 1 = findings at or above it, 2 = usage or config error.
Inline: "# dd-ignore DD003 -- reason" above an instruction (Dockerfile) or key (YAML).
`;

const FORMATS = ['pretty', 'json', 'sarif', 'github'] as const;
type Format = (typeof FORMATS)[number];

function parseLevel(v: string | undefined): Severity | 'never' | undefined {
  if (v === undefined) return undefined;
  const s = v.toLowerCase();
  if (s === 'error' || s === 'info' || s === 'never') return s;
  if (s === 'warn' || s === 'warning') return 'warn';
  return undefined;
}

function explain(id: string): string | undefined {
  const r = getRule(id);
  if (!r) return undefined;
  return [
    `${r.id}  ${r.name}  [${r.severity}] [${r.category}]${r.fixable ? ' [auto-fixable]' : ''}`,
    '',
    r.summary,
    '',
    r.explanation,
    '',
    `Why it matters: ${r.why}`,
    '',
    'Before:',
    ...r.before.split('\n').map((l) => `    ${l}`),
    '',
    'After:',
    ...r.after.split('\n').map((l) => `    ${l}`),
    '',
  ].join('\n');
}

export async function runCli(argv: string[], io: IO): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        format: { type: 'string', short: 'f' },
        'fail-on': { type: 'string' },
        config: { type: 'string', short: 'c' },
        'no-config': { type: 'boolean' },
        disable: { type: 'string' },
        rule: { type: 'string', multiple: true },
        fix: { type: 'boolean' },
        'fix-dry-run': { type: 'boolean' },
        output: { type: 'string', short: 'o' },
        color: { type: 'boolean' },
        'no-color': { type: 'boolean' },
        stdin: { type: 'boolean' },
        'stdin-filename': { type: 'string' },
        type: { type: 'string' },
        'list-rules': { type: 'boolean' },
        explain: { type: 'string' },
        version: { type: 'boolean', short: 'v' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    io.stderr(`dockerfile-doctor: ${(e as Error).message}\nTry --help.\n`);
    return 2;
  }
  const v = parsed.values as Record<string, string | boolean | string[] | undefined>;
  if (v.help) {
    io.stdout(HELP.replace('__VERSION__', version()));
    return 0;
  }
  if (v.version) {
    io.stdout(`${version()}\n`);
    return 0;
  }
  const format = ((v.format as string | undefined) ?? 'pretty') as Format;
  if (!FORMATS.includes(format)) {
    io.stderr(
      `dockerfile-doctor: unknown format "${String(v.format)}". Use pretty, json, sarif or github.\n`,
    );
    return 2;
  }
  if (typeof v.explain === 'string') {
    const text = explain(v.explain);
    if (!text) {
      io.stderr(`dockerfile-doctor: unknown rule "${v.explain}".\n`);
      return 2;
    }
    io.stdout(text);
    return 0;
  }
  if (v['list-rules']) {
    if (format === 'json') {
      io.stdout(
        `${JSON.stringify(
          ALL_RULES.map(({ id, name, kind, severity, category, summary, fixable }) => ({
            id,
            name,
            kind,
            severity,
            category,
            summary,
            fixable: Boolean(fixable),
          })),
          null,
          2,
        )}\n`,
      );
    } else {
      io.stdout(
        `${ALL_RULES.map((r) => `${r.id}  ${r.severity.padEnd(5)}  ${r.category.padEnd(15)}  ${r.fixable ? 'fix' : '   '}  ${r.summary}`).join('\n')}\n`,
      );
    }
    return 0;
  }

  const failOn = parseLevel(v['fail-on'] as string | undefined);
  if (v['fail-on'] !== undefined && failOn === undefined) {
    io.stderr('dockerfile-doctor: --fail-on must be error, warn, info or never.\n');
    return 2;
  }

  // Rule overrides from the command line (these beat the config file).
  const overrides: Record<string, RuleSetting> = {};
  for (const id of String(v.disable ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (!isRuleId(id)) {
      io.stderr(`dockerfile-doctor: --disable: unknown rule "${id}".\n`);
      return 2;
    }
    overrides[id.toUpperCase()] = 'off';
  }
  for (const spec of (v.rule as string[] | undefined) ?? []) {
    const [id, lvl] = spec.split('=');
    const sev = lvl === 'off' ? 'off' : parseLevel(lvl);
    if (!id || !isRuleId(id) || !sev || sev === 'never') {
      io.stderr(`dockerfile-doctor: --rule expects ID=off|error|warn|info, got "${spec}".\n`);
      return 2;
    }
    overrides[id.toUpperCase()] = sev;
  }

  const loaded = loadConfig(io.cwd, v.config as string | undefined, Boolean(v['no-config']));
  if (loaded.errors.length > 0) {
    for (const e of loaded.errors) io.stderr(`dockerfile-doctor: config error: ${e}\n`);
    return 2;
  }
  const threshold: Severity | 'never' = failOn ?? loaded.config.failOn ?? 'warn';

  const reports: FileReport[] = [];
  const fixing = Boolean(v.fix) || Boolean(v['fix-dry-run']);
  const diffs: string[] = [];
  let fixedFiles = 0;
  let fixedCount = 0;

  if (v.stdin) {
    const source = io.readStdin();
    const name = (v['stdin-filename'] as string | undefined) ?? 'stdin';
    const kind =
      (v.type as FileKind | undefined) ?? detectKind(name === 'stdin' ? undefined : name, source);
    if (v.type !== undefined && v.type !== 'dockerfile' && v.type !== 'compose') {
      io.stderr('dockerfile-doctor: --type must be dockerfile or compose.\n');
      return 2;
    }
    if (fixing) {
      if (!v['fix-dry-run']) {
        io.stderr(
          'dockerfile-doctor: --fix needs files on disk; with --stdin use --fix-dry-run to see a diff.\n',
        );
        return 2;
      }
    }
    const res = lint(source, { file: name, kind, config: loaded.config, overrides });
    let text = source;
    if (v['fix-dry-run']) {
      const out = fixToFixpoint(
        source,
        (t) => lint(t, { file: name, kind, config: loaded.config, overrides }).findings,
      );
      text = out.text;
      if (text !== source) diffs.push(unifiedDiff(source, text, name));
      fixedCount += out.applied.length;
    }
    const after =
      text === source ? res : lint(text, { file: name, kind, config: loaded.config, overrides });
    reports.push({
      file: name,
      kind,
      findings: after.findings,
      suppressed: after.suppressed,
      source: text,
    });
  } else {
    const paths = parsed.positionals.length > 0 ? parsed.positionals : ['.'];
    const { files, missing } = discover(paths, io.cwd);
    if (missing.length > 0) {
      io.stderr(`dockerfile-doctor: no such file or directory: ${missing.join(', ')}\n`);
      return 2;
    }
    for (const abs of files) {
      const display = toPosix(relative(io.cwd, abs)) || abs;
      const forConfig = toPosix(relative(loaded.dir, abs));
      if (isExcluded(loaded.config, forConfig)) continue;
      let source = readFileSync(abs, 'utf8');
      const kind = detectKind(display, source);
      const base: Omit<Parameters<typeof lint>[1] & object, 'file'> = {
        kind,
        configPath: forConfig,
        config: loaded.config,
        overrides,
        dockerignore: kind === 'dockerfile' ? dockerignoreFor(abs) : undefined,
      };
      const lintFn = (t: string) => lint(t, { ...base, file: display }).findings;
      if (fixing) {
        const out = fixToFixpoint(source, lintFn);
        if (out.text !== source) {
          fixedFiles++;
          fixedCount += out.applied.length;
          if (v['fix-dry-run']) diffs.push(unifiedDiff(source, out.text, display));
          else writeFileSync(abs, out.text);
          source = out.text;
        }
      }
      const res = lint(source, { ...base, file: display });
      reports.push({
        file: display,
        kind,
        findings: res.findings,
        suppressed: res.suppressed,
        source,
      });
    }
  }

  let output: string;
  if (v['fix-dry-run']) {
    const paint =
      v.color === true ||
      (v['no-color'] !== true && !io.env.NO_COLOR && (io.isTTY || Boolean(io.env.FORCE_COLOR)));
    const colorDiff = (d: string) =>
      paint
        ? d
            .split('\n')
            .map((l) =>
              l.startsWith('+') && !l.startsWith('+++')
                ? `\u001b[32m${l}\u001b[0m`
                : l.startsWith('-') && !l.startsWith('---')
                  ? `\u001b[31m${l}\u001b[0m`
                  : l.startsWith('@@')
                    ? `\u001b[36m${l}\u001b[0m`
                    : l,
            )
            .join('\n')
        : d;
    output = diffs.length > 0 ? diffs.map(colorDiff).join('\n') : 'Nothing to fix automatically.\n';
    if (diffs.length > 0)
      output += `\n${fixedCount} fix${fixedCount === 1 ? '' : 'es'} would be applied. Remaining findings are not auto-fixable.\n`;
  } else {
    const useColor =
      v.color === true ||
      (v['no-color'] !== true && !io.env.NO_COLOR && (io.isTTY || Boolean(io.env.FORCE_COLOR)));
    switch (format) {
      case 'json':
        output = renderJson(reports, version());
        break;
      case 'sarif':
        output = renderSarif(reports, version());
        break;
      case 'github':
        output = renderGithub(reports);
        break;
      default:
        output = renderPretty(reports, { color: useColor });
        if (v.fix && fixedCount > 0) {
          output = `Applied ${fixedCount} fix${fixedCount === 1 ? '' : 'es'} in ${fixedFiles} file${fixedFiles === 1 ? '' : 's'}.\n\n${output}`;
        }
    }
  }
  if (typeof v.output === 'string') {
    writeFileSync(v.output, output);
    io.stderr(`Report written to ${v.output}\n`);
  } else io.stdout(output);

  const s = summarize(reports);
  if (threshold === 'never') return 0;
  const worst = s.errors > 0 ? 'error' : s.warnings > 0 ? 'warn' : s.infos > 0 ? 'info' : undefined;
  if (worst && SEVERITY_RANK[worst] >= SEVERITY_RANK[threshold]) return 1;
  return 0;
}
