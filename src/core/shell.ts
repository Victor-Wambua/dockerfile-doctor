/**
 * A small, forgiving shell tokenizer. It is not a shell: it splits a RUN script into simple
 * commands and words (honouring quotes, escapes, `$(...)`, comments) so rules can reason about
 * `apt-get install ...` or `curl ... | sh` without regexes over raw text.
 */

export interface Word {
  /** Unquoted text. */
  text: string;
  /** Offsets into the analysed string, [start, end). */
  start: number;
  end: number;
  /** True when any part was quoted or contained an expansion. */
  quoted: boolean;
  hasExpansion: boolean;
}

export type Operator = '' | '&&' | '||' | ';' | '|' | '&' | '\n';

export interface Command {
  words: Word[];
  /** Operator that preceded this command ('' for the first). */
  op: Operator;
  pipedInto: boolean;
  pipedFrom: boolean;
  /** Offsets of the command (first word start to last word end). */
  start: number;
  end: number;
  /** Command name after env assignments and wrappers (`sudo`, `exec`, `env`, ...). */
  name: string;
  nameIndex: number;
  /** Words after the command name. */
  args: Word[];
  /** Wrapper command names that preceded the name (e.g. `sudo`). */
  wrappers: string[];
}

const RESERVED = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'while',
  'until',
  'for',
  'in',
  'case',
  'esac',
  '!',
  '{',
  '}',
  'time',
]);
const WRAPPERS = new Set(['sudo', 'exec', 'command', 'nohup', 'env', 'nice']);

export function tokenize(text: string): Command[] {
  const commands: Command[] = [];
  let words: Word[] = [];
  let pendingOp: Operator = '';
  const n = text.length;
  let i = 0;

  const flush = (nextOp: Operator) => {
    if (words.length > 0) {
      const cmd = buildCommand(words, pendingOp, nextOp === '|');
      // Lines made only of reserved words (`fi`, `done`) or assignments carry no command.
      if (cmd.name !== '') commands.push(cmd);
      words = [];
    }
    pendingOp = nextOp;
  };

  while (i < n) {
    const c = text[i] as string;
    if (c === '\n') {
      flush('\n');
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    if (c === '&' && text[i + 1] === '&') {
      flush('&&');
      i += 2;
      continue;
    }
    if (c === '|' && text[i + 1] === '|') {
      flush('||');
      i += 2;
      continue;
    }
    if (c === '|') {
      flush('|');
      i += text[i + 1] === '&' ? 2 : 1;
      continue;
    }
    if (c === ';') {
      flush(';');
      i++;
      continue;
    }
    if (c === '&' && text[i + 1] !== '>') {
      flush('&');
      i++;
      continue;
    }
    if (c === '(' || c === ')') {
      flush(';');
      i++;
      continue;
    }
    // Read a word.
    const start = i;
    let value = '';
    let quoted = false;
    let hasExpansion = false;
    while (i < n) {
      const d = text[i] as string;
      if (/\s/.test(d) || d === ';' || d === '|' || d === '(' || d === ')') break;
      if (d === '&') {
        const redirect = text[i - 1] === '>' || text[i - 1] === '<' || text[i + 1] === '>';
        if (!redirect || text[i + 1] === '&') break;
      }
      if (d === '\\' && i + 1 < n) {
        value += text[i + 1];
        i += 2;
        continue;
      }
      if (d === "'") {
        quoted = true;
        i++;
        while (i < n && text[i] !== "'") {
          value += text[i];
          i++;
        }
        i++;
        continue;
      }
      if (d === '"') {
        quoted = true;
        i++;
        while (i < n && text[i] !== '"') {
          if (text[i] === '\\' && i + 1 < n) {
            value += text[i + 1];
            i += 2;
            continue;
          }
          if (text[i] === '$') hasExpansion = true;
          value += text[i];
          i++;
        }
        i++;
        continue;
      }
      if (d === '$' && text[i + 1] === '(') {
        hasExpansion = true;
        let depth = 0;
        while (i < n) {
          if (text[i] === '(') depth++;
          else if (text[i] === ')') {
            depth--;
            if (depth === 0) {
              value += text[i];
              i++;
              break;
            }
          }
          value += text[i];
          i++;
        }
        continue;
      }
      if (d === '`') {
        hasExpansion = true;
        value += d;
        i++;
        while (i < n && text[i] !== '`') {
          value += text[i];
          i++;
        }
        value += '`';
        i++;
        continue;
      }
      if (d === '$') hasExpansion = true;
      value += d;
      i++;
    }
    if (i === start) {
      i++; // safety: never stall
      continue;
    }
    words.push({ text: value, start, end: i, quoted, hasExpansion });
  }
  flush('');
  // Mark pipedFrom.
  for (let k = 1; k < commands.length; k++) {
    if ((commands[k] as Command).op === '|') (commands[k] as Command).pipedFrom = true;
  }
  return commands;
}

function buildCommand(all: Word[], op: Operator, pipedInto: boolean): Command {
  let idx = 0;
  const wrappers: string[] = [];
  for (;;) {
    const w = all[idx];
    if (!w) break;
    if (RESERVED.has(w.text) && !w.quoted) {
      idx++;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(w.text) && !w.quoted) {
      idx++;
      continue;
    }
    if (WRAPPERS.has(w.text) && !w.quoted) {
      wrappers.push(w.text);
      idx++;
      // skip the wrapper's own flags and (for env) assignments
      while (all[idx] && (all[idx] as Word).text.startsWith('-') && !(all[idx] as Word).quoted)
        idx++;
      continue;
    }
    break;
  }
  const nameWord = all[idx];
  const name = nameWord ? baseName(nameWord.text) : '';
  const first = all[0] as Word;
  const last = all[all.length - 1] as Word;
  return {
    words: all,
    op,
    pipedInto,
    pipedFrom: false,
    start: first.start,
    end: last.end,
    name,
    nameIndex: idx,
    args: all.slice(idx + 1),
    wrappers,
  };
}

function baseName(p: string): string {
  const slash = p.lastIndexOf('/');
  return slash === -1 ? p : p.slice(slash + 1);
}

export interface PackageCommand {
  tool: string;
  sub?: string;
  subWord?: Word;
  /** Words after the subcommand. */
  rest: Word[];
  /** Every word after the tool name (flags included). */
  all: Word[];
  command: Command;
}

/** Normalises `apt-get`, `pip`/`pip3`/`python -m pip`/`uv pip`, `npm`, ... into a tool + subcommand. */
export function packageCommand(cmd: Command): PackageCommand | undefined {
  let tool = cmd.name;
  let rest = cmd.args;
  if (/^pip[0-9.]*$/.test(tool)) tool = 'pip';
  else if (
    /^python[0-9.]*$/.test(tool) &&
    rest[0]?.text === '-m' &&
    /^pip[0-9.]*$/.test(rest[1]?.text ?? '')
  ) {
    tool = 'pip';
    rest = rest.slice(2);
  } else if (tool === 'uv' && rest[0]?.text === 'pip') {
    tool = 'uv-pip';
    rest = rest.slice(1);
  } else if (tool === 'uv') tool = 'uv';
  const known = [
    'apt-get',
    'apt',
    'apk',
    'pip',
    'uv-pip',
    'uv',
    'npm',
    'yarn',
    'pnpm',
    'composer',
    'yum',
    'dnf',
    'microdnf',
    'gem',
    'bundle',
    'poetry',
    'go',
    'cargo',
  ];
  if (!known.includes(tool)) return undefined;
  // First non-flag word is the subcommand (good enough for the tools above).
  let k = 0;
  while (k < rest.length && (rest[k] as Word).text.startsWith('-')) {
    // flags that take a value in front of the subcommand are rare; ignore.
    k++;
  }
  const subWord = rest[k];
  return {
    tool,
    sub: subWord?.text,
    subWord,
    rest: rest.slice(k + 1),
    all: rest,
    command: cmd,
  };
}

export function hasFlag(words: Word[], ...names: string[]): boolean {
  return words.some(
    (w) =>
      names.includes(w.text) || names.some((nm) => nm.length > 2 && w.text.startsWith(`${nm}=`)),
  );
}

/** True if any short-flag cluster such as `-qy` contains the letter. */
export function hasShortFlag(words: Word[], letter: string): boolean {
  return words.some((w) => /^-[A-Za-z]+$/.test(w.text) && w.text.includes(letter));
}
