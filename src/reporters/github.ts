import type { Severity } from '../core/types.js';
import type { FileReport } from './types.js';

const LEVEL: Record<Severity, string> = { error: 'error', warn: 'warning', info: 'notice' };

function escData(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escProp(s: string): string {
  return escData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/** GitHub Actions workflow commands: one `::error file=...::message` per finding. */
export function renderGithub(reports: FileReport[]): string {
  const lines: string[] = [];
  for (const r of reports) {
    for (const f of r.findings) {
      const props = [
        `file=${escProp(r.file)}`,
        `line=${f.line}`,
        `col=${f.column}`,
        `endLine=${f.endLine}`,
        `endColumn=${f.endColumn}`,
        `title=${escProp(`${f.ruleId} ${f.category}`)}`,
      ].join(',');
      lines.push(`::${LEVEL[f.severity]} ${props}::${escData(f.message)}`);
    }
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}
