export type Severity = 'error' | 'warn' | 'info';
export type Category = 'security' | 'reproducibility' | 'size' | 'correctness' | 'maintainability';
export type FileKind = 'dockerfile' | 'compose';

export const SEVERITIES: readonly Severity[] = ['error', 'warn', 'info'];
export const CATEGORIES: readonly Category[] = [
  'security',
  'reproducibility',
  'size',
  'correctness',
  'maintainability',
];

/** Higher number = more severe. */
export const SEVERITY_RANK: Record<Severity, number> = { info: 1, warn: 2, error: 3 };

/** A replacement of the half-open character range [start, end) of the source text. */
export interface TextEdit {
  start: number;
  end: number;
  text: string;
}

export interface Fix {
  description: string;
  edits: TextEdit[];
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  category: Category;
  message: string;
  file: string;
  /** 1-based. */
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  fix?: Fix;
}

/** Absolute character offsets into the source text, [start, end). */
export interface Range {
  start: number;
  end: number;
}

export interface ReportInput {
  message: string;
  at: Range;
  fix?: Fix;
  /** Overrides the rule's default severity for this one finding. */
  severity?: Severity;
}

export interface RuleMeta {
  id: string;
  /** Kebab-case slug, stable alongside the id. */
  name: string;
  kind: FileKind;
  severity: Severity;
  category: Category;
  /** One-line title shown in lists. */
  summary: string;
  /** Plain-language description of what the rule looks for. */
  explanation: string;
  /** Why it matters in practice. */
  why: string;
  /** Example that triggers the rule. */
  before: string;
  /** The corrected version of that example. */
  after: string;
  /** True when `--fix` can rewrite this safely. */
  fixable?: boolean;
}
