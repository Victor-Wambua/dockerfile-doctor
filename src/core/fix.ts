import type { Finding, TextEdit } from './types.js';

function overlaps(a: TextEdit, b: TextEdit): boolean {
  return a.start < b.end && b.start < a.end;
}

export interface FixPlan {
  edits: Array<TextEdit & { order: number }>;
  applied: Finding[];
  /** Fixable findings skipped because they collide with another fix. They are retried on the next pass. */
  deferred: Finding[];
}

/** Choose a non-conflicting set of fixes. */
export function planFixes(findings: Finding[]): FixPlan {
  const edits: FixPlan['edits'] = [];
  const applied: Finding[] = [];
  const deferred: Finding[] = [];
  let order = 0;
  for (const f of findings) {
    if (!f.fix || f.fix.edits.length === 0) continue;
    const conflict = f.fix.edits.some((e) => edits.some((x) => overlaps(e, x)));
    if (conflict) {
      deferred.push(f);
      continue;
    }
    for (const e of f.fix.edits) edits.push({ ...e, order: order++ });
    applied.push(f);
  }
  return { edits, applied, deferred };
}

export function applyEdits(text: string, edits: Array<TextEdit & { order?: number }>): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || (b.order ?? 0) - (a.order ?? 0));
  let out = text;
  for (const e of sorted) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}

export interface FixOutcome {
  text: string;
  applied: Finding[];
  passes: number;
}

/**
 * Applies safe fixes repeatedly until nothing more can be fixed (fixes can enable each other,
 * and overlapping fixes are deferred to the next pass).
 */
export function fixToFixpoint(
  text: string,
  lintFn: (text: string) => Finding[],
  maxPasses = 10,
): FixOutcome {
  let current = text;
  const applied: Finding[] = [];
  let passes = 0;
  for (; passes < maxPasses; passes++) {
    const plan = planFixes(lintFn(current));
    if (plan.edits.length === 0) break;
    const next = applyEdits(current, plan.edits);
    if (next === current) break;
    applied.push(...plan.applied);
    current = next;
  }
  return { text: current, applied, passes };
}
