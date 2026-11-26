import { parseDocument } from 'yaml';
import { ALL_RULES } from '../rules/index.js';
import { type Config, EMPTY_CONFIG, isPathIgnored, type RuleSetting } from './config.js';
import { collectIgnores, isIgnored } from './ignore.js';
import { parseDockerfile } from './parser.js';
import type { ComposeContext, DockerfileContext, DockerignoreInfo, Rule } from './rule.js';
import { LineIndex } from './text.js';
import type { FileKind, Finding, ReportInput } from './types.js';

export interface LintOptions {
  /** Path shown in findings. Forward slashes. */
  file?: string;
  /** Path matched against per-path ignore globs (defaults to `file`). Relative to the config file. */
  configPath?: string;
  /** Force the file kind; otherwise it is detected from the name and content. */
  kind?: FileKind;
  config?: Config;
  /** Extra per-rule settings that beat the config file (for example from CLI flags). */
  overrides?: Record<string, RuleSetting>;
  /** Information about .dockerignore, when the file was read from disk. */
  dockerignore?: DockerignoreInfo;
}

export interface LintResult {
  file: string;
  kind: FileKind;
  findings: Finding[];
  /** Findings dropped by inline `dd-ignore` comments or per-path ignores. */
  suppressed: number;
}

export function detectKind(file: string | undefined, text: string): FileKind {
  const base = (file ?? '').split('/').pop() ?? '';
  if (/\.ya?ml$/i.test(base)) return 'compose';
  if (/^dockerfile/i.test(base) || /\.dockerfile$/i.test(base)) return 'dockerfile';
  if (/^\s*(?:services|version|name)\s*:/m.test(text) && !/^\s*FROM\s/im.test(text))
    return 'compose';
  return 'dockerfile';
}

export function lint(text: string, options: LintOptions = {}): LintResult {
  const file = options.file ?? (options.kind === 'compose' ? 'compose.yaml' : 'Dockerfile');
  const kind = options.kind ?? detectKind(options.file, text);
  const config = options.config ?? EMPTY_CONFIG;
  const settings: Record<string, RuleSetting> = { ...config.rules, ...options.overrides };
  const lines = new LineIndex(text);
  const raw: Finding[] = [];

  const makeReport = (rule: Rule) => (input: ReportInput) => {
    const sev = settings[rule.id];
    if (sev === 'off') return;
    const severity = sev ?? input.severity ?? rule.severity;
    const rawStart = Number.isFinite(input.at.start) ? input.at.start : 0;
    const start = Math.max(0, Math.min(rawStart, text.length));
    let end = Math.max(
      start,
      Math.min(Number.isFinite(input.at.end) ? input.at.end : start, text.length),
    );
    if (end === start) end = Math.min(start + 1, text.length);
    const a = lines.position(start);
    const b = lines.position(end);
    raw.push({
      ruleId: rule.id,
      severity,
      category: rule.category,
      message: input.message,
      file,
      line: a.line,
      column: a.column,
      endLine: b.line,
      endColumn: b.column,
      fix: input.fix,
    });
  };

  let ignores = collectIgnores(lines, kind);
  if (kind === 'dockerfile') {
    const df = parseDockerfile(text);
    ignores = collectIgnores(lines, kind, df);
    const finalStage = df.stages[df.stages.length - 1];
    for (const rule of ALL_RULES) {
      if (rule.kind !== 'dockerfile' || settings[rule.id] === 'off') continue;
      const ctx: DockerfileContext = {
        df,
        file,
        dockerignore: options.dockerignore,
        finalStage,
        report: makeReport(rule),
      };
      rule.check(ctx);
    }
  } else {
    const doc = parseDocument(text, { prettyErrors: false });
    const root = doc.errors.length === 0 ? doc.toJS() : undefined;
    const looksLikeCompose =
      doc.errors.length > 0 ||
      (typeof root === 'object' && root !== null && 'services' in (root as object));
    if (looksLikeCompose) {
      for (const rule of ALL_RULES) {
        if (rule.kind !== 'compose' || settings[rule.id] === 'off') continue;
        // Everything except DC000 needs a parsed document.
        if (doc.errors.length > 0 && rule.id !== 'DC000') continue;
        const ctx: ComposeContext = { text, file, doc, root, report: makeReport(rule) };
        rule.check(ctx);
      }
    }
  }

  let suppressed = 0;
  const kept: Finding[] = [];
  const seen = new Set<string>();
  for (const f of raw) {
    if (
      isPathIgnored(config, options.configPath ?? file, f.ruleId) ||
      isIgnored(ignores, f.ruleId, f.line)
    ) {
      suppressed++;
      continue;
    }
    const key = `${f.ruleId}:${f.line}:${f.column}:${f.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(f);
  }
  kept.sort((x, y) => x.line - y.line || x.column - y.column || x.ruleId.localeCompare(y.ruleId));
  return { file, kind, findings: kept, suppressed };
}
