import { type FileReport, summarize } from './types.js';

export function renderJson(reports: FileReport[], version: string): string {
  const doc = {
    tool: { name: 'dockerfile-doctor', version },
    summary: summarize(reports),
    files: reports.map((r) => ({
      file: r.file,
      kind: r.kind,
      suppressed: r.suppressed,
      findings: r.findings.map((f) => ({
        ruleId: f.ruleId,
        severity: f.severity,
        category: f.category,
        message: f.message,
        line: f.line,
        column: f.column,
        endLine: f.endLine,
        endColumn: f.endColumn,
        fixable: Boolean(f.fix),
        fix: f.fix?.description,
      })),
    })),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
