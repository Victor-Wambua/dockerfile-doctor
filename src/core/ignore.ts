import type { ParsedDockerfile } from './parser.js';
import type { LineIndex } from './text.js';
import type { FileKind } from './types.js';

export interface IgnoreEntry {
  /** Upper-case rule ids, or "ALL". */
  ids: Set<string>;
  fromLine: number;
  toLine: number;
}

const DIRECTIVE = /(?:^|\s)#\s*dd-ignore(-file)?\b(.*)$/i;

function parseIds(rest: string): Set<string> {
  const ids = new Set<string>();
  for (const tok of rest.split(/[\s,]+/).filter(Boolean)) {
    if (/^(?:D[DC]\d{3}|all)$/i.test(tok)) ids.add(tok.toUpperCase());
    else break; // anything else starts the free-text reason
  }
  if (ids.size === 0) ids.add('ALL');
  return ids;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Finds `# dd-ignore DD001 DD002` comments.
 *  - Dockerfile: the comment applies to the next instruction (all of its lines).
 *  - YAML: on its own line it applies to the next line and everything nested under it;
 *    after code on the same line it applies to that line.
 *  - `# dd-ignore-file ...` applies to the whole file.
 */
export function collectIgnores(
  lines: LineIndex,
  kind: FileKind,
  df?: ParsedDockerfile,
): IgnoreEntry[] {
  const out: IgnoreEntry[] = [];
  const total = lines.lineCount;
  for (let ln = 1; ln <= total; ln++) {
    const text = lines.lineText(ln);
    if (!text.includes('dd-ignore')) continue;
    const m = DIRECTIVE.exec(text);
    if (!m) continue;
    const ids = parseIds(m[2] as string);
    if (m[1]) {
      out.push({ ids, fromLine: 1, toLine: total });
      continue;
    }
    const standalone = text.trimStart().startsWith('#');
    if (kind === 'dockerfile') {
      if (!standalone || !df) continue; // trailing comments are not Dockerfile comments
      const within = df.instructions.find((i) => i.startLine <= ln && ln <= i.endLine);
      const target = within ?? df.instructions.find((i) => i.startLine > ln);
      if (target) out.push({ ids, fromLine: target.startLine, toLine: target.endLine });
      continue;
    }
    if (!standalone) {
      out.push({ ids, fromLine: ln, toLine: ln });
      continue;
    }
    let n = ln + 1;
    while (
      n <= total &&
      (lines.lineText(n).trim() === '' || lines.lineText(n).trimStart().startsWith('#'))
    )
      n++;
    if (n > total) continue;
    const base = indentOf(lines.lineText(n));
    let end = n;
    for (let k = n + 1; k <= total; k++) {
      const t = lines.lineText(k);
      if (t.trim() === '' || t.trimStart().startsWith('#')) continue;
      if (indentOf(t) <= base) break;
      end = k;
    }
    out.push({ ids, fromLine: n, toLine: end });
  }
  return out;
}

export function isIgnored(entries: IgnoreEntry[], ruleId: string, line: number): boolean {
  return entries.some(
    (e) => line >= e.fromLine && line <= e.toLine && (e.ids.has('ALL') || e.ids.has(ruleId)),
  );
}
