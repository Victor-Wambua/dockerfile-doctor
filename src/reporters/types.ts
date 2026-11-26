import type { FileKind, Finding } from '../core/types.js';

export interface FileReport {
  file: string;
  kind: FileKind;
  findings: Finding[];
  suppressed: number;
  /** Original source text (used for excerpts). */
  source: string;
}

export interface Summary {
  files: number;
  errors: number;
  warnings: number;
  infos: number;
  fixable: number;
  suppressed: number;
}

export function summarize(reports: FileReport[]): Summary {
  const s: Summary = {
    files: reports.length,
    errors: 0,
    warnings: 0,
    infos: 0,
    fixable: 0,
    suppressed: 0,
  };
  for (const r of reports) {
    s.suppressed += r.suppressed;
    for (const f of r.findings) {
      if (f.severity === 'error') s.errors++;
      else if (f.severity === 'warn') s.warnings++;
      else s.infos++;
      if (f.fix) s.fixable++;
    }
  }
  return s;
}
