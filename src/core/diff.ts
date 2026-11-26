/** Small unified-diff generator (LCS based). Fine for Dockerfile-sized inputs. */
export function unifiedDiff(a: string, b: string, path: string, context = 3): string {
  if (a === b) return '';
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      (lcs[i] as number[])[j] =
        x[i] === y[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as number[])[j] as number, (lcs[i] as number[])[j + 1] as number);
    }
  }
  type Op = { t: ' ' | '-' | '+'; s: string };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      ops.push({ t: ' ', s: x[i] as string });
      i++;
      j++;
    } else if (((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number)) {
      ops.push({ t: '-', s: x[i++] as string });
    } else ops.push({ t: '+', s: y[j++] as string });
  }
  while (i < n) ops.push({ t: '-', s: x[i++] as string });
  while (j < m) ops.push({ t: '+', s: y[j++] as string });

  const out = [`--- a/${path}`, `+++ b/${path}`];
  const changed = ops.map((o, k) => (o.t === ' ' ? -1 : k)).filter((k) => k !== -1);
  let k = 0;
  while (k < changed.length) {
    let start = Math.max(0, (changed[k] as number) - context);
    let endIdx = k;
    let end = Math.min(ops.length, (changed[k] as number) + context + 1);
    while (endIdx + 1 < changed.length && (changed[endIdx + 1] as number) - context <= end) {
      endIdx++;
      end = Math.min(ops.length, (changed[endIdx] as number) + context + 1);
    }
    start = Math.max(0, start);
    let aStart = 1;
    let bStart = 1;
    for (let p = 0; p < start; p++) {
      if ((ops[p] as Op).t !== '+') aStart++;
      if ((ops[p] as Op).t !== '-') bStart++;
    }
    const slice = ops.slice(start, end);
    const aLen = slice.filter((o) => o.t !== '+').length;
    const bLen = slice.filter((o) => o.t !== '-').length;
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (const o of slice) out.push(o.t + o.s);
    k = endIdx + 1;
  }
  return `${out.join('\n')}\n`;
}
