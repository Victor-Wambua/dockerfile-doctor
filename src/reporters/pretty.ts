import { LineIndex } from '../core/text.js';
import type { Severity } from '../core/types.js';
import { type FileReport, summarize } from './types.js';

export interface PrettyOptions {
  color: boolean;
}

const CODES = {
  reset: 0,
  bold: 1,
  dim: 2,
  red: 31,
  yellow: 33,
  blue: 34,
  green: 32,
  cyan: 36,
  gray: 90,
} as const;

function painter(enabled: boolean) {
  return (style: keyof typeof CODES, text: string): string =>
    enabled ? `\u001b[${CODES[style]}m${text}\u001b[0m` : text;
}

const SEV_STYLE: Record<Severity, keyof typeof CODES> = {
  error: 'red',
  warn: 'yellow',
  info: 'blue',
};
const SEV_LABEL: Record<Severity, string> = { error: 'error', warn: 'warn ', info: 'info ' };

export function renderPretty(reports: FileReport[], opts: PrettyOptions): string {
  const c = painter(opts.color);
  const out: string[] = [];
  for (const r of reports) {
    if (r.findings.length === 0) continue;
    out.push(c('bold', r.file));
    const idx = new LineIndex(r.source);
    const width = String(Math.max(...r.findings.map((f) => f.endLine))).length;
    for (const f of r.findings) {
      const pos = `${f.line}:${f.column}`.padEnd(7);
      out.push(
        `  ${c('gray', pos)} ${c(SEV_STYLE[f.severity], SEV_LABEL[f.severity])}  ${f.message}  ${c('gray', `${f.ruleId} ${f.category}`)}`,
      );
      const src = idx.lineText(f.line);
      const gutter = String(f.line).padStart(width);
      const startCol = Math.max(0, f.column - 1);
      const endCol = f.endLine === f.line ? Math.max(f.endColumn - 1, startCol + 1) : src.length;
      const caret = `${' '.repeat(startCol)}${'^'.repeat(Math.max(1, Math.min(endCol, src.length || endCol) - startCol))}`;
      out.push(
        `  ${c('gray', `${gutter} |`)} ${src.length > 140 ? `${src.slice(0, 137)}...` : src}`,
      );
      out.push(
        `  ${c('gray', `${' '.repeat(width)} |`)} ${c(SEV_STYLE[f.severity], caret.slice(0, 140))}`,
      );
      if (f.fix)
        out.push(
          `  ${c('gray', `${' '.repeat(width)} =`)} ${c('green', `fix: ${f.fix.description}`)}`,
        );
    }
    out.push('');
  }
  const s = summarize(reports);
  const total = s.errors + s.warnings + s.infos;
  if (total === 0) {
    out.push(c('green', `No problems found in ${s.files} file${s.files === 1 ? '' : 's'}.`));
    if (s.suppressed > 0)
      out.push(
        c('gray', `${s.suppressed} finding${s.suppressed === 1 ? '' : 's'} suppressed by ignores.`),
      );
  } else {
    const parts = [
      s.errors ? c('red', `${s.errors} error${s.errors === 1 ? '' : 's'}`) : '',
      s.warnings ? c('yellow', `${s.warnings} warning${s.warnings === 1 ? '' : 's'}`) : '',
      s.infos ? c('blue', `${s.infos} info`) : '',
    ].filter(Boolean);
    out.push(
      `${c('bold', `${total} problem${total === 1 ? '' : 's'}`)} (${parts.join(', ')}) in ${s.files} file${s.files === 1 ? '' : 's'}`,
    );
    if (s.fixable > 0)
      out.push(c('green', `${s.fixable} fixable with --fix (preview with --fix-dry-run)`));
    if (s.suppressed > 0) out.push(c('gray', `${s.suppressed} suppressed by ignores`));
  }
  return `${out.join('\n')}\n`;
}
