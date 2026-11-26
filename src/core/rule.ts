import type { Document } from 'yaml';
import type { Instruction, ParsedDockerfile, Script, Stage } from './parser.js';
import { type Command, tokenize, type Word } from './shell.js';
import type { Fix, Range, ReportInput, RuleMeta, TextEdit } from './types.js';

export interface DockerignoreInfo {
  exists: boolean;
  lines: string[];
}

export interface DockerfileContext {
  df: ParsedDockerfile;
  file: string;
  dockerignore?: DockerignoreInfo;
  /** The stage that produces the image people run: the last FROM. */
  finalStage?: Stage;
  report(input: ReportInput): void;
}

export interface ComposeContext {
  text: string;
  file: string;
  doc: Document.Parsed;
  /** Parsed value of the whole document. */
  root: unknown;
  report(input: ReportInput): void;
}

export interface DockerfileRule extends RuleMeta {
  kind: 'dockerfile';
  check(ctx: DockerfileContext): void;
}

export interface ComposeRule extends RuleMeta {
  kind: 'compose';
  check(ctx: ComposeContext): void;
}

export type Rule = DockerfileRule | ComposeRule;

export function dockerfileRule(meta: Omit<DockerfileRule, 'kind'>): DockerfileRule {
  return { ...meta, kind: 'dockerfile' };
}

export function composeRule(meta: Omit<ComposeRule, 'kind'>): ComposeRule {
  return { ...meta, kind: 'compose' };
}

// ---------------------------------------------------------------------------------------------
// Dockerfile helpers
// ---------------------------------------------------------------------------------------------

/** Range of the whole instruction, from keyword to end of the last line. */
export function instrRange(i: Instruction): Range {
  return { start: i.start, end: i.end };
}

/** Range of the first line of the instruction only (keyword to end of that line). */
export function keywordRange(i: Instruction): Range {
  return { start: i.keywordStart, end: i.keywordEnd };
}

/** Range covering logical args [s, e) of an instruction. */
export function argsRange(i: Instruction, s: number, e: number): Range {
  return { start: i.map[s] as number, end: i.map[e] as number };
}

/** Range of a word inside a RUN script. Falls back to the whole instruction for synthetic scripts. */
export function wordRange(i: Instruction, script: Script, w: Word): Range {
  if (script.synthetic) return instrRange(i);
  return { start: script.map[w.start] as number, end: script.map[w.end] as number };
}

export function commandRange(i: Instruction, script: Script, c: Command): Range {
  if (script.synthetic) return instrRange(i);
  return { start: script.map[c.start] as number, end: script.map[c.end] as number };
}

export function insertAt(offset: number, text: string): TextEdit {
  return { start: offset, end: offset, text };
}

export function replaceRange(r: Range, text: string): TextEdit {
  return { start: r.start, end: r.end, text };
}

export function fix(description: string, ...edits: TextEdit[]): Fix {
  return { description, edits };
}

const commandCache = new WeakMap<Script, Command[]>();

export function commandsOf(script: Script): Command[] {
  let c = commandCache.get(script);
  if (!c) {
    c = tokenize(script.text);
    commandCache.set(script, c);
  }
  return c;
}

export interface RunInfo {
  instr: Instruction;
  script: Script;
  commands: Command[];
  stage: Stage;
}

/** All RUN instructions that have analysable shell text. */
export function runsOf(stage: Stage): RunInfo[] {
  const out: RunInfo[] = [];
  for (const instr of stage.instructions) {
    if (instr.keyword === 'RUN' && instr.script) {
      out.push({ instr, script: instr.script, commands: commandsOf(instr.script), stage });
    }
  }
  return out;
}

export function allRuns(ctx: DockerfileContext): RunInfo[] {
  return ctx.df.stages.flatMap(runsOf);
}

export function hasMountFlag(instr: Instruction, type: string): boolean {
  return instr.flags.some((f) => f.name === 'mount' && f.value?.includes(`type=${type}`));
}

/** Strip surrounding quotes and a trailing slash/colon from path-ish text for comparisons. */
export function normalizePath(p: string): string {
  return p.replace(/^["']|["']$/g, '').replace(/\/+$/, '');
}
