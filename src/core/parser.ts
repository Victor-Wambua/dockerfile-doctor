import { LineIndex } from './text.js';

export const KNOWN_INSTRUCTIONS = [
  'ADD',
  'ARG',
  'CMD',
  'COPY',
  'ENTRYPOINT',
  'ENV',
  'EXPOSE',
  'FROM',
  'HEALTHCHECK',
  'LABEL',
  'MAINTAINER',
  'ONBUILD',
  'RUN',
  'SHELL',
  'STOPSIGNAL',
  'USER',
  'VOLUME',
  'WORKDIR',
] as const;

const JSON_FORM_KEYWORDS = new Set(['RUN', 'CMD', 'ENTRYPOINT', 'SHELL', 'VOLUME', 'COPY', 'ADD']);
const FLAG_KEYWORDS = new Set(['FROM', 'COPY', 'ADD', 'RUN', 'HEALTHCHECK']);
const HEREDOC_KEYWORDS = new Set(['RUN', 'COPY', 'ADD']);

export interface Flag {
  name: string;
  value?: string;
  /** Absolute offsets of the whole `--name=value` token. */
  start: number;
  end: number;
}

export interface Heredoc {
  name: string;
  /** Absolute offsets of the body (excluding the terminator line). */
  bodyStart: number;
  bodyEnd: number;
  body: string;
  stripTabs: boolean;
}

export interface KeyValue {
  key: string;
  /** Unquoted value; undefined when no `=` was given (ARG without default). */
  value: string | undefined;
  keyStart: number;
  keyEnd: number;
  valueStart: number;
  valueEnd: number;
  /** True when the value was written inside quotes. */
  quoted: boolean;
}

/** Text of a RUN that is shell code, with a logical-to-absolute offset map. */
export interface Script {
  text: string;
  /** map[i] = absolute offset of text[i]; length is text.length + 1. */
  map: number[];
  /** True when the text was reconstructed (exec-form RUN), so offsets are approximate. */
  synthetic: boolean;
}

export interface Instruction {
  index: number;
  keyword: string;
  rawKeyword: string;
  keywordStart: number;
  keywordEnd: number;
  /** Absolute range of the instruction from keyword to the end of its last line. */
  start: number;
  end: number;
  startLine: number;
  endLine: number;
  /** Logical argument text (continuations joined, comments removed, flags removed). */
  args: string;
  /** map[i] = absolute offset of args[i]; length is args.length + 1. */
  map: number[];
  flags: Flag[];
  form: 'json' | 'shell' | 'none';
  json?: string[];
  /** Looks like JSON form (`[ ... ]`) but is not valid JSON, so Docker runs it as shell form. */
  malformedJson: boolean;
  heredocs: Heredoc[];
  script?: Script;
  pairs?: KeyValue[];
}

export interface Comment {
  line: number;
  /** Comment text after `#`, trimmed. */
  text: string;
  start: number;
  end: number;
}

export interface Directive {
  name: string;
  value: string;
  line: number;
}

export interface ImageRef {
  raw: string;
  /** Repository part without tag or digest. */
  name: string;
  tag?: string;
  digest?: string;
  hasVars: boolean;
  /** Raw with global ARG defaults substituted where possible. */
  resolved: string;
  unresolvedVars: string[];
}

export interface Stage {
  index: number;
  name?: string;
  from: Instruction;
  image: ImageRef;
  platform?: string;
  /** The FROM instruction and everything up to the next FROM. */
  instructions: Instruction[];
}

export interface ParsedDockerfile {
  text: string;
  lines: LineIndex;
  escape: string;
  directives: Directive[];
  instructions: Instruction[];
  comments: Comment[];
  /** ARG instructions before the first FROM. */
  globalArgs: Map<string, string | undefined>;
  /** Instructions that appear before the first FROM and are not ARG. */
  orphans: Instruction[];
  stages: Stage[];
}

export function expandVars(
  input: string,
  lookup: (name: string) => string | undefined,
): { text: string; missing: string[] } {
  const missing: string[] = [];
  const text = input.replace(
    /\\\$|\$(?:\{([A-Za-z_][A-Za-z0-9_]*)(?:(:?[-+])([^}]*))?\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (m, braced: string | undefined, op: string | undefined, word: string | undefined, bare) => {
      if (m === '\\$') return '$';
      const name = braced ?? (bare as string);
      const val = lookup(name);
      if (op === '-' || op === ':-')
        return val !== undefined && !(op === ':-' && val === '') ? val : (word ?? '');
      if (op === '+' || op === ':+')
        return val !== undefined && !(op === ':+' && val === '') ? (word ?? '') : '';
      if (val === undefined) {
        missing.push(name);
        return m;
      }
      return val;
    },
  );
  return { text, missing };
}

export function parseImageRef(raw: string, globals: Map<string, string | undefined>): ImageRef {
  const hasVars = raw.includes('$');
  let resolved = raw;
  let unresolvedVars: string[] = [];
  if (hasVars) {
    const r = expandVars(raw, (n) => globals.get(n));
    resolved = r.text;
    unresolvedVars = r.missing;
  }
  let rest = resolved;
  let digest: string | undefined;
  const at = rest.indexOf('@');
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  let tag: string | undefined;
  const lastSlash = rest.lastIndexOf('/');
  const colon = rest.indexOf(':', lastSlash + 1);
  if (colon !== -1) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  return { raw, name: rest, tag, digest, hasVars, resolved, unresolvedVars };
}

function isBlank(s: string): boolean {
  return s.trim() === '';
}

function isComment(s: string): boolean {
  return s.trimStart().startsWith('#');
}

function scanKeyValues(args: string, map: number[], mode: 'env' | 'arg' | 'label'): KeyValue[] {
  const out: KeyValue[] = [];
  const n = args.length;
  let i = 0;
  const abs = (k: number) => map[k] as number;
  while (i < n) {
    while (i < n && /\s/.test(args[i] as string)) i++;
    if (i >= n) break;
    const keyStart = i;
    // Keys may be quoted in LABEL ("a b"="c"); keep it simple and read until = or whitespace.
    while (i < n && args[i] !== '=' && !/\s/.test(args[i] as string)) i++;
    const key = args.slice(keyStart, i).replace(/^["']|["']$/g, '');
    const keyEnd = i;
    if (args[i] !== '=') {
      if (mode === 'arg') {
        out.push({
          key,
          value: undefined,
          keyStart: abs(keyStart),
          keyEnd: abs(keyEnd),
          valueStart: abs(keyEnd),
          valueEnd: abs(keyEnd),
          quoted: false,
        });
        continue;
      }
      // Legacy `ENV key value with spaces` / `LABEL key value`.
      let j = i;
      while (j < n && /\s/.test(args[j] as string)) j++;
      const rawVal = args.slice(j).replace(/\s+$/, '');
      const q = /^(["'])(.*)\1$/s.exec(rawVal);
      out.push({
        key,
        value: q ? (q[2] as string) : rawVal,
        keyStart: abs(keyStart),
        keyEnd: abs(keyEnd),
        valueStart: abs(j),
        valueEnd: abs(j + rawVal.length),
        quoted: !!q,
      });
      break;
    }
    i++; // '='
    const vStart = i;
    let value = '';
    let quoted = false;
    while (i < n && !/\s/.test(args[i] as string)) {
      const c = args[i] as string;
      if (c === '"' || c === "'") {
        quoted = true;
        const q = c;
        i++;
        while (i < n && args[i] !== q) {
          if (q === '"' && args[i] === '\\' && i + 1 < n) i++;
          value += args[i];
          i++;
        }
        i++; // closing quote
      } else if (c === '\\' && i + 1 < n) {
        value += args[i + 1];
        i += 2;
      } else {
        value += c;
        i++;
      }
    }
    out.push({
      key,
      value,
      keyStart: abs(keyStart),
      keyEnd: abs(keyEnd),
      valueStart: abs(vStart),
      valueEnd: abs(Math.min(i, n)),
      quoted,
    });
  }
  return out;
}

export function parseDockerfile(text: string): ParsedDockerfile {
  const lines = new LineIndex(text);
  const total = lines.lineCount;
  const directives: Directive[] = [];
  const comments: Comment[] = [];
  const instructions: Instruction[] = [];
  let escapeChar = '\\';
  let directivesOpen = true;

  const lineContent = (n: number) => lines.lineText(n);
  let ln = 1;
  while (ln <= total) {
    const content = lineContent(ln);
    const lineStart = lines.lineStart(ln);
    if (isBlank(content)) {
      directivesOpen = false;
      ln++;
      continue;
    }
    if (isComment(content)) {
      const hash = content.indexOf('#');
      const body = content.slice(hash + 1).trim();
      comments.push({
        line: ln,
        text: body,
        start: lineStart + hash,
        end: lineStart + content.length,
      });
      if (directivesOpen) {
        const m = /^([a-zA-Z][a-zA-Z0-9]*)\s*=\s*(.+)$/.exec(body);
        if (m && ['syntax', 'escape', 'check'].includes((m[1] as string).toLowerCase())) {
          directives.push({
            name: (m[1] as string).toLowerCase(),
            value: m[2] as string,
            line: ln,
          });
          if ((m[1] as string).toLowerCase() === 'escape' && (m[2] === '`' || m[2] === '\\')) {
            escapeChar = m[2] as string;
          }
        } else {
          directivesOpen = false;
        }
      }
      ln++;
      continue;
    }
    directivesOpen = false;

    // Assemble one logical instruction.
    const startLine = ln;
    let buf = '';
    const map: number[] = [];
    let endAbs = lineStart;
    for (;;) {
      const c = lineContent(ln);
      const ls = lines.lineStart(ln);
      const trimmedEnd = c.replace(/\s+$/, '');
      const cont = trimmedEnd.endsWith(escapeChar) && trimmedEnd.length > 0;
      const piece = cont ? c.slice(0, trimmedEnd.length - 1) : c;
      for (let k = 0; k < piece.length; k++) map.push(ls + k);
      buf += piece;
      endAbs = ls + c.length;
      if (!cont) break;
      ln++;
      while (ln <= total && (isBlank(lineContent(ln)) || isComment(lineContent(ln)))) {
        const cc = lineContent(ln);
        if (isComment(cc)) {
          const hash = cc.indexOf('#');
          const s = lines.lineStart(ln);
          comments.push({
            line: ln,
            text: cc.slice(hash + 1).trim(),
            start: s + hash,
            end: s + cc.length,
          });
        }
        ln++;
      }
      if (ln > total) break;
    }
    map.push(endAbs);
    let endLine = Math.min(ln, total);
    ln++;

    const kw = /^(\s*)(\S+)/.exec(buf);
    const rawKeyword = kw ? (kw[2] as string) : '';
    const kwStartIdx = kw ? (kw[1] as string).length : 0;
    const kwEndIdx = kwStartIdx + rawKeyword.length;
    const keyword = rawKeyword.toUpperCase();

    let restText = buf.slice(kwEndIdx);
    let restMap = map.slice(kwEndIdx);

    // Flags.
    const flags: Flag[] = [];
    if (FLAG_KEYWORDS.has(keyword)) {
      const flagRe = /^\s*(--([A-Za-z][\w-]*)(?:=(\S*))?)/;
      for (;;) {
        const m = flagRe.exec(restText);
        if (!m) break;
        const tokStart = restText.indexOf(m[1] as string);
        const tokEnd = tokStart + (m[1] as string).length;
        flags.push({
          name: (m[2] as string).toLowerCase(),
          value: m[3],
          start: restMap[tokStart] as number,
          end: restMap[tokEnd] as number,
        });
        restText = restText.slice(tokEnd);
        restMap = restMap.slice(tokEnd);
      }
    }
    const lead = /^\s*/.exec(restText)?.[0].length ?? 0;
    restText = restText.slice(lead);
    restMap = restMap.slice(lead);
    // Trim trailing whitespace from args (keep map consistent).
    const trimmedLen = restText.replace(/\s+$/, '').length;
    const args = restText.slice(0, trimmedLen);
    const argMap = restMap.slice(0, trimmedLen + 1);

    // Heredocs.
    const heredocs: Heredoc[] = [];
    if (HEREDOC_KEYWORDS.has(keyword)) {
      const hre = /<<(-)?(["']?)([A-Za-z_]\w*)\2/g;
      let hm: RegExpExecArray | null = hre.exec(args);
      while (hm) {
        const name = hm[3] as string;
        const strip = hm[1] === '-';
        const bodyStartLine = ln;
        let k = ln;
        let found = false;
        while (k <= total) {
          const l = lineContent(k);
          if ((strip ? l.replace(/^\t+/, '') : l) === name) {
            found = true;
            break;
          }
          k++;
        }
        const bodyStart = lines.lineStart(bodyStartLine);
        const bodyEnd = found ? lines.lineStart(k) : text.length;
        heredocs.push({
          name,
          bodyStart,
          bodyEnd,
          body: text.slice(bodyStart, bodyEnd),
          stripTabs: strip,
        });
        if (found) {
          endLine = k;
          endAbs = lines.lineStart(k) + lineContent(k).length;
          ln = k + 1;
        } else {
          endLine = total;
          endAbs = text.length;
          ln = total + 1;
        }
        hm = hre.exec(args);
      }
    }

    // Form.
    let form: Instruction['form'] = 'none';
    let json: string[] | undefined;
    let malformedJson = false;
    if (JSON_FORM_KEYWORDS.has(keyword) && args.length > 0) {
      if (args.startsWith('[')) {
        try {
          const parsed: unknown = JSON.parse(args);
          if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) {
            form = 'json';
            json = parsed as string[];
          } else {
            form = 'shell';
            malformedJson = true;
          }
        } catch {
          form = 'shell';
          malformedJson = args.trimEnd().endsWith(']');
        }
      } else {
        form = 'shell';
      }
    } else if (args.length > 0) {
      form = 'shell';
    }
    if (keyword === 'HEALTHCHECK') {
      const m = /^CMD\s+/i.exec(args);
      if (m) {
        const inner = args.slice(m[0].length);
        if (inner.startsWith('[')) {
          try {
            const parsed: unknown = JSON.parse(inner);
            form = Array.isArray(parsed) ? 'json' : 'shell';
            if (Array.isArray(parsed)) json = parsed.map(String);
          } catch {
            form = 'shell';
          }
        } else form = 'shell';
      }
    }

    const instr: Instruction = {
      index: instructions.length,
      keyword,
      rawKeyword,
      keywordStart: map[kwStartIdx] as number,
      keywordEnd: map[kwEndIdx] as number,
      start: map[kwStartIdx] as number,
      end: endAbs,
      startLine,
      endLine,
      args,
      map: argMap,
      flags,
      form,
      json,
      malformedJson,
      heredocs,
    };

    if (keyword === 'ENV' || keyword === 'ARG' || keyword === 'LABEL') {
      instr.pairs = scanKeyValues(args, argMap, keyword.toLowerCase() as 'env' | 'arg' | 'label');
    }

    if (keyword === 'RUN') {
      const lone = /^<<-?["']?[A-Za-z_]\w*["']?$/.test(args);
      const shellHd = /^(?:\S*\/)?(?:ba|da|a)?sh\b[^<]*<<-?["']?[A-Za-z_]\w*["']?\s*$/.test(args);
      const hd = heredocs[0];
      if ((lone || shellHd) && hd) {
        const first = hd.body.split('\n', 1)[0] as string;
        const isOtherShebang = first.startsWith('#!') && !/\b(?:ba|da|a)?sh\b/.test(first);
        if (!isOtherShebang) {
          const bodyMap: number[] = [];
          for (let k = 0; k <= hd.body.length; k++) bodyMap.push(hd.bodyStart + k);
          instr.script = { text: hd.body, map: bodyMap, synthetic: false };
        }
      } else if (form === 'shell' && heredocs.length === 0) {
        instr.script = { text: args, map: argMap, synthetic: false };
      } else if (form === 'json' && json) {
        const text2 = json.join(' ');
        instr.script = {
          text: text2,
          map: new Array(text2.length + 1).fill(argMap[0] as number),
          synthetic: true,
        };
      }
    }

    instructions.push(instr);
  }

  // Stages.
  const globalArgs = new Map<string, string | undefined>();
  const orphans: Instruction[] = [];
  const stages: Stage[] = [];
  for (const ins of instructions) {
    if (ins.keyword === 'FROM') {
      const parts = ins.args.split(/\s+/).filter(Boolean);
      const imageRaw = parts[0] ?? '';
      let name: string | undefined;
      if (parts[1]?.toUpperCase() === 'AS' && parts[2]) name = parts[2];
      stages.push({
        index: stages.length,
        name,
        from: ins,
        image: parseImageRef(imageRaw, globalArgs),
        platform: ins.flags.find((f) => f.name === 'platform')?.value,
        instructions: [ins],
      });
      continue;
    }
    const current = stages[stages.length - 1];
    if (current) {
      current.instructions.push(ins);
    } else if (ins.keyword === 'ARG') {
      for (const p of ins.pairs ?? []) globalArgs.set(p.key, p.value);
    } else {
      orphans.push(ins);
    }
  }

  return {
    text,
    lines,
    escape: escapeChar,
    directives,
    instructions,
    comments,
    globalArgs,
    orphans,
    stages,
  };
}

/** The last USER instruction value in the stage, if any. */
export function stageUser(stage: Stage): { value: string; instr: Instruction } | undefined {
  let found: { value: string; instr: Instruction } | undefined;
  for (const ins of stage.instructions) {
    if (ins.keyword === 'USER') found = { value: ins.args.trim(), instr: ins };
  }
  return found;
}
