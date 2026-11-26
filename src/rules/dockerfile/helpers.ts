import type { Instruction, ParsedDockerfile, Stage } from '../../core/parser.js';
import { stageUser } from '../../core/parser.js';
import type { Range } from '../../core/types.js';

export interface ArgToken {
  text: string;
  /** Offsets into instruction.args. */
  start: number;
  end: number;
}

/** Splits COPY/ADD/EXPOSE/VOLUME style arguments into tokens, understanding JSON form. */
export function argTokens(instr: Instruction): ArgToken[] {
  const out: ArgToken[] = [];
  if (instr.form === 'json') {
    const re = /"((?:[^"\\]|\\.)*)"/g;
    let m = re.exec(instr.args);
    while (m) {
      let text = m[1] as string;
      try {
        text = JSON.parse(m[0]) as string;
      } catch {
        // keep raw
      }
      out.push({ text, start: m.index, end: m.index + m[0].length });
      m = re.exec(instr.args);
    }
    return out;
  }
  const re = /\S+/g;
  let m = re.exec(instr.args);
  while (m) {
    out.push({
      text: m[0].replace(/^["']|["']$/g, ''),
      start: m.index,
      end: m.index + m[0].length,
    });
    m = re.exec(instr.args);
  }
  return out;
}

export function copyParts(instr: Instruction): { sources: ArgToken[]; dest?: ArgToken } {
  const toks = argTokens(instr);
  if (instr.heredocs.length > 0) return { sources: [] };
  if (toks.length < 2) return { sources: toks };
  return { sources: toks.slice(0, -1), dest: toks[toks.length - 1] };
}

export function isBroadCopy(instr: Instruction): boolean {
  if (instr.keyword !== 'COPY' && instr.keyword !== 'ADD') return false;
  if (instr.flags.some((f) => f.name === 'from')) return false;
  return copyParts(instr).sources.some((s) => ['.', './', '*', './*', '.*'].includes(s.text));
}

export function isRootUser(value: string): boolean {
  const user = value.split(':')[0]?.trim().toLowerCase() ?? '';
  return user === 'root' || user === '0';
}

/** USER in effect at the end of the stage, following `FROM <earlier-stage>` inheritance. */
export function effectiveUser(df: ParsedDockerfile, stage: Stage, depth = 0): string | undefined {
  const own = stageUser(stage);
  if (own) return own.value;
  if (depth > 20) return undefined;
  const parent = df.stages.slice(0, stage.index).find((s) => s.name && s.name === stage.image.name);
  return parent ? effectiveUser(df, parent, depth + 1) : undefined;
}

export function parentStage(df: ParsedDockerfile, stage: Stage): Stage | undefined {
  return df.stages.slice(0, stage.index).find((s) => s.name && s.name === stage.image.name);
}

/** The final stage plus the stages it is built on top of: the ones whose layers ship. */
export function shippedStages(df: ParsedDockerfile): Stage[] {
  const out: Stage[] = [];
  let cur: Stage | undefined = df.stages[df.stages.length - 1];
  while (cur && out.length < 20) {
    out.push(cur);
    cur = parentStage(df, cur);
  }
  return out;
}

export function isExternalImage(df: ParsedDockerfile, stage: Stage): boolean {
  if (stage.image.name === 'scratch') return false;
  return !parentStage(df, stage);
}

/** Range of the image reference token inside a FROM instruction. */
export function imageRange(stage: Stage): Range {
  const from = stage.from;
  const idx = from.args.indexOf(stage.image.raw);
  const s = Math.max(idx, 0);
  return { start: from.map[s] as number, end: from.map[s + stage.image.raw.length] as number };
}

export function pairsOf(instr: Instruction) {
  return instr.pairs ?? [];
}

/** Env keys set by ENV instructions in the stage (and global scope for convenience). */
export function stageEnv(stage: Stage, before?: Instruction): Map<string, string | undefined> {
  const env = new Map<string, string | undefined>();
  for (const ins of stage.instructions) {
    if (before && ins.index >= before.index) break;
    if (ins.keyword === 'ENV') for (const p of ins.pairs ?? []) env.set(p.key, p.value);
  }
  return env;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}
