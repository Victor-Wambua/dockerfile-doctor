import { type Instruction, KNOWN_INSTRUCTIONS } from '../../core/parser.js';
import {
  argsRange,
  commandRange,
  commandsOf,
  type DockerfileRule,
  dockerfileRule,
  fix,
  instrRange,
  keywordRange,
  replaceRange,
  runsOf,
} from '../../core/rule.js';
import { tokenize } from '../../core/shell.js';
import { levenshtein } from '../../core/text.js';
import { argTokens, copyParts, isBroadCopy, parentStage } from './helpers.js';

export const DD030 = dockerfileRule({
  id: 'DD030',
  name: 'missing-dockerignore',
  severity: 'warn',
  category: 'size',
  summary: 'COPY . with no .dockerignore next to the Dockerfile',
  explanation:
    'The Dockerfile copies the whole build context (COPY . ., ADD . ., COPY * ...) but no .dockerignore (or <Dockerfile>.dockerignore) exists. Only reported when the file is scanned from disk.',
  why: 'Without it, .git, node_modules, local .env files, test data and editor junk are sent to the daemon and copied into the image. That makes builds slow, images big, and can leak secrets.',
  before: '# repo has no .dockerignore\nCOPY . /app',
  after: '# .dockerignore\n.git\nnode_modules\n.env\n*.log',
  check(ctx) {
    if (!ctx.dockerignore || ctx.dockerignore.exists) return;
    const broad = ctx.df.instructions.find(isBroadCopy);
    if (broad) {
      ctx.report({
        message: `"${broad.keyword} ${broad.args}" sends the whole build context, and there is no .dockerignore to trim it.`,
        at: keywordRange(broad),
      });
    }
  },
});

export const DD031 = dockerfileRule({
  id: 'DD031',
  name: 'debian-frontend-env',
  severity: 'info',
  category: 'correctness',
  summary: 'ENV DEBIAN_FRONTEND leaks into the running container',
  explanation:
    'ENV DEBIAN_FRONTEND=noninteractive is set for the life of the image, not just the install step.',
  why: 'Anyone who later runs apt inside the container gets silently non-interactive behaviour. Scope it to the RUN, or use ARG (build-time only).',
  before: 'ENV DEBIAN_FRONTEND=noninteractive',
  after: 'ARG DEBIAN_FRONTEND=noninteractive',
  check(ctx) {
    for (const ins of ctx.df.instructions) {
      if (ins.keyword !== 'ENV') continue;
      for (const p of ins.pairs ?? []) {
        if (p.key === 'DEBIAN_FRONTEND') {
          ctx.report({
            message:
              'ENV DEBIAN_FRONTEND persists in the final image. Use ARG or set it inline on the RUN.',
            at: { start: p.keyStart, end: Math.max(p.valueEnd, p.keyEnd) },
          });
        }
      }
    }
  },
});

export const DD032 = dockerfileRule({
  id: 'DD032',
  name: 'no-healthcheck',
  severity: 'info',
  category: 'correctness',
  summary: 'Final image defines no HEALTHCHECK',
  explanation:
    'No HEALTHCHECK instruction is present in the final stage (or the stages it is built on).',
  why: 'Docker, Compose and Swarm can only restart or route around a hung process if the image says how to test health. Kubernetes ignores HEALTHCHECK and uses probes, so this is informational: batch jobs and k8s-only images can ignore it.',
  before: 'FROM nginx:1.27-alpine',
  after:
    'FROM nginx:1.27-alpine\nHEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/ || exit 1',
  check(ctx) {
    let stage = ctx.finalStage;
    let depth = 0;
    while (stage && depth++ < 20) {
      if (stage.instructions.some((i) => i.keyword === 'HEALTHCHECK')) return;
      stage = parentStage(ctx.df, stage);
    }
    if (ctx.finalStage) {
      ctx.report({
        message:
          'The final image has no HEALTHCHECK, so Docker cannot tell a hung container from a healthy one.',
        at: keywordRange(ctx.finalStage.from),
      });
    }
  },
});

export const DD033 = dockerfileRule({
  id: 'DD033',
  name: 'workdir-relative',
  severity: 'warn',
  category: 'correctness',
  summary: 'WORKDIR is a relative path',
  explanation:
    'WORKDIR is relative and there is no earlier absolute WORKDIR in the stage to anchor it.',
  why: 'A relative WORKDIR resolves against whatever directory the base image happens to start in. That differs between images and between versions of the same image.',
  before: 'WORKDIR app',
  after: 'WORKDIR /app',
  check(ctx) {
    for (const stage of ctx.df.stages) {
      let anchored = false;
      for (const ins of stage.instructions) {
        if (ins.keyword !== 'WORKDIR') continue;
        const v = ins.args.trim().replace(/^["']|["']$/g, '');
        const absolute = v.startsWith('/') || v.startsWith('$') || /^[A-Za-z]:[\\/]/.test(v);
        if (absolute) anchored = true;
        else if (!anchored && v !== '') {
          ctx.report({
            message: `WORKDIR "${v}" is relative. Use an absolute path such as /${v}.`,
            at: instrRange(ins),
          });
        }
      }
    }
  },
});

const TRIVIAL_EXEC_BLOCK = new Set([
  'cd',
  'export',
  'source',
  '.',
  'exec',
  'set',
  'unset',
  'alias',
  'umask',
  'ulimit',
  'eval',
  'trap',
  'wait',
]);

function toExecForm(ins: Instruction): string | undefined {
  const cmds = tokenize(ins.args);
  if (cmds.length !== 1) return undefined;
  const cmd = cmds[0];
  if (cmd?.nameIndex !== 0 || cmd.wrappers.length > 0) return undefined;
  if (TRIVIAL_EXEC_BLOCK.has(cmd.name)) return undefined;
  for (const w of cmd.words) {
    if (w.hasExpansion) return undefined;
    if (/^[0-9]*[<>]|^&/.test(w.text) && !w.quoted) return undefined;
    if (!w.quoted && /[*?[\]{}~!]/.test(w.text)) return undefined;
  }
  return `[${cmd.words.map((w) => JSON.stringify(w.text)).join(', ')}]`;
}

export const DD034 = dockerfileRule({
  id: 'DD034',
  name: 'shell-form-cmd',
  severity: 'warn',
  category: 'correctness',
  summary: 'CMD / ENTRYPOINT in shell form',
  explanation:
    'CMD and ENTRYPOINT written as plain text run through `/bin/sh -c`, so the shell, not your app, becomes PID 1. The JSON (exec) form starts your process directly. A trivial command is rewritten automatically by --fix.',
  why: 'Signals (SIGTERM from `docker stop` or Kubernetes) go to the shell and are not forwarded, so the app never shuts down gracefully and is killed after the timeout (10 s by default). Exec form fixes that and removes a process from the container.',
  before: 'CMD node server.js',
  after: 'CMD ["node", "server.js"]',
  fixable: true,
  check(ctx) {
    for (const ins of ctx.df.instructions) {
      if (ins.keyword !== 'CMD' && ins.keyword !== 'ENTRYPOINT') continue;
      if (ins.form !== 'shell' || ins.malformedJson || ins.args === '') continue;
      const exec = toExecForm(ins);
      ctx.report({
        message: `${ins.keyword} uses shell form, so /bin/sh is PID 1 and swallows stop signals. Use the exec form ["..."] instead.`,
        at: instrRange(ins),
        fix: exec
          ? fix(
              `Convert ${ins.keyword} to exec form`,
              replaceRange(argsRange(ins, 0, ins.args.length), exec),
            )
          : undefined,
      });
    }
  },
});

export const DD035 = dockerfileRule({
  id: 'DD035',
  name: 'multiple-cmd-entrypoint',
  severity: 'warn',
  category: 'correctness',
  summary: 'More than one CMD, ENTRYPOINT or HEALTHCHECK in a stage',
  explanation:
    'Only the last CMD, ENTRYPOINT and HEALTHCHECK in a stage take effect. Earlier ones are silently ignored.',
  why: 'It usually means a line was pasted twice or a base-stage instruction was forgotten, and the container starts something other than what the file reads like.',
  before: 'CMD ["npm", "start"]\nCMD ["node", "server.js"]',
  after: 'CMD ["node", "server.js"]',
  check(ctx) {
    for (const stage of ctx.df.stages) {
      for (const kw of ['CMD', 'ENTRYPOINT', 'HEALTHCHECK']) {
        const all = stage.instructions.filter((i) => i.keyword === kw);
        const last = all[all.length - 1];
        for (const ins of all.slice(0, -1)) {
          ctx.report({
            message: `This ${kw} is overridden by the ${kw} on line ${last?.startLine}. Only the last one takes effect.`,
            at: instrRange(ins),
          });
        }
      }
    }
  },
});

export const DD037 = dockerfileRule({
  id: 'DD037',
  name: 'maintainer-deprecated',
  severity: 'warn',
  category: 'maintainability',
  summary: 'MAINTAINER is deprecated',
  explanation:
    'The MAINTAINER instruction has been deprecated for years. Use a LABEL with the standard OCI key instead.',
  why: 'LABEL is machine-readable by registries and tooling, and can carry more than a name. --fix rewrites it for you.',
  before: 'MAINTAINER Jane Doe <jane@example.com>',
  after: 'LABEL org.opencontainers.image.authors="Jane Doe <jane@example.com>"',
  fixable: true,
  check(ctx) {
    for (const ins of ctx.df.instructions) {
      if (ins.keyword !== 'MAINTAINER') continue;
      const v = ins.args.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      ctx.report({
        message: 'MAINTAINER is deprecated. Use LABEL org.opencontainers.image.authors.',
        at: keywordRange(ins),
        fix: fix(
          'Rewrite as an OCI authors LABEL',
          replaceRange(instrRange(ins), `LABEL org.opencontainers.image.authors="${v}"`),
        ),
      });
    }
  },
});

export const DD038 = dockerfileRule({
  id: 'DD038',
  name: 'invalid-json-form',
  severity: 'error',
  category: 'correctness',
  summary: 'Exec form looks like JSON but is not valid JSON',
  explanation:
    'An instruction starts with [ and ends with ] but is not a valid JSON array of strings (single quotes, trailing comma, unquoted words). Docker then falls back to shell form.',
  why: "CMD ['npm', 'start'] is run as the shell command `[ npm, start ]`, which fails at runtime with \"[: not found\" or silently does nothing. The error appears only when the container starts.",
  before: "CMD ['node', 'server.js']",
  after: 'CMD ["node", "server.js"]',
  check(ctx) {
    for (const ins of ctx.df.instructions) {
      if (ins.malformedJson) {
        ctx.report({
          message: `${ins.keyword} looks like exec form but is not valid JSON (use double quotes, no trailing comma). Docker will run it through a shell instead.`,
          at: instrRange(ins),
        });
      }
    }
  },
});

export const DD039 = dockerfileRule({
  id: 'DD039',
  name: 'unknown-instruction',
  severity: 'error',
  category: 'correctness',
  summary: 'Unknown Dockerfile instruction',
  explanation:
    'A line begins with a word that is not a Dockerfile instruction. The usual causes are a typo (RNU) or a missing backslash at the end of the previous RUN line.',
  why: 'docker build fails with "unknown instruction". A missing line continuation is especially easy to miss in review because the next line looks like part of the command.',
  before: 'RUN apt-get update\n && apt-get install -y curl',
  after: 'RUN apt-get update \\\n && apt-get install -y curl',
  check(ctx) {
    const known = KNOWN_INSTRUCTIONS as readonly string[];
    ctx.df.instructions.forEach((ins, idx) => {
      if (known.includes(ins.keyword)) return;
      const prev = ctx.df.instructions[idx - 1];
      let hint = '';
      if (/^(?:&&|\|\||\||;|-)/.test(ins.rawKeyword) && prev) {
        hint = ` Did the ${prev.keyword} on line ${prev.startLine} lose its trailing backslash?`;
      } else {
        const near = known.find(
          (k) =>
            levenshtein(k, ins.keyword) <= 1 ||
            (ins.keyword.length > 3 && levenshtein(k, ins.keyword) <= 2),
        );
        if (near) hint = ` Did you mean ${near}?`;
      }
      ctx.report({
        message: `Unknown instruction "${ins.rawKeyword}".${hint}`,
        at: keywordRange(ins),
      });
    });
  },
});

export const DD041 = dockerfileRule({
  id: 'DD041',
  name: 'copy-multi-dest-slash',
  severity: 'error',
  category: 'correctness',
  summary: 'COPY/ADD with several sources needs a destination ending in /',
  explanation:
    'When COPY or ADD has more than one source, the destination must be a directory and end with a slash.',
  why: 'The build fails with "When using COPY with more than one source file, the destination must be a directory and end with a /".',
  before: 'COPY package.json package-lock.json /app',
  after: 'COPY package.json package-lock.json /app/',
  check(ctx) {
    for (const ins of ctx.df.instructions) {
      if (ins.keyword !== 'COPY' && ins.keyword !== 'ADD') continue;
      const { sources, dest } = copyParts(ins);
      if (!dest || sources.length < 2) continue;
      if (
        /\/$/.test(dest.text) ||
        dest.text === '.' ||
        dest.text === '..' ||
        dest.text.includes('$')
      )
        continue;
      ctx.report({
        message: `${ins.keyword} has ${sources.length} sources, so the destination "${dest.text}" must end with /.`,
        at: argsRange(ins, dest.start, dest.end),
      });
    }
  },
});

export const DD042 = dockerfileRule({
  id: 'DD042',
  name: 'invalid-expose',
  severity: 'error',
  category: 'correctness',
  summary: 'EXPOSE with an invalid port or protocol',
  explanation: 'EXPOSE takes port numbers 1-65535, optionally a range and /tcp, /udp or /sctp.',
  why: 'docker build rejects it, or the value is ignored by tooling that parses image metadata.',
  before: 'EXPOSE 80800\nEXPOSE http',
  after: 'EXPOSE 8080',
  check(ctx) {
    for (const ins of ctx.df.instructions) {
      if (ins.keyword !== 'EXPOSE') continue;
      for (const t of argTokens(ins)) {
        if (t.text.includes('$')) continue;
        const m = /^(\d{1,5})(?:-(\d{1,5}))?(?:\/(tcp|udp|sctp))?$/i.exec(t.text);
        const ok =
          m &&
          Number(m[1]) >= 1 &&
          Number(m[1]) <= 65535 &&
          (m[2] === undefined || (Number(m[2]) <= 65535 && Number(m[2]) >= Number(m[1])));
        if (!ok) {
          ctx.report({
            message: `"${t.text}" is not a valid port, range or port/protocol.`,
            at: argsRange(ins, t.start, t.end),
          });
        }
      }
    }
  },
});

export const DD043 = dockerfileRule({
  id: 'DD043',
  name: 'instruction-case',
  severity: 'info',
  category: 'maintainability',
  summary: 'Instruction keywords mix upper and lower case',
  explanation:
    'Some instructions are upper-case and others are not. Docker accepts both, but the convention is upper-case, and a mixed file is harder to scan. Reported only when the file is inconsistent.',
  why: 'Consistent keywords make instructions stand out from the commands inside them, which is most of what a Dockerfile reviewer looks at.',
  before: 'FROM alpine:3.20\nrun echo hello',
  after: 'FROM alpine:3.20\nRUN echo hello',
  fixable: true,
  check(ctx) {
    const known = KNOWN_INSTRUCTIONS as readonly string[];
    const real = ctx.df.instructions.filter((i) => known.includes(i.keyword));
    const hasUpper = real.some((i) => i.rawKeyword === i.keyword);
    if (!hasUpper) return;
    for (const ins of real) {
      if (ins.rawKeyword !== ins.keyword) {
        ctx.report({
          message: `Write "${ins.keyword}" in upper case to match the rest of the file.`,
          at: keywordRange(ins),
          fix: fix('Upper-case the keyword', replaceRange(keywordRange(ins), ins.keyword)),
        });
      }
    }
  },
});

export const DD044 = dockerfileRule({
  id: 'DD044',
  name: 'pipe-without-pipefail',
  severity: 'warn',
  category: 'correctness',
  summary: 'Pipeline in RUN without pipefail',
  explanation:
    'A RUN pipes one command into another, but the shell is not set to fail when the first command fails. Pipelines made only of echo/printf/cat are ignored.',
  why: 'By default a pipeline succeeds if the last command succeeds. `curl http://broken | tar xz` exits 0 when curl fails, and the build carries on with a half-empty image.',
  before: 'RUN curl -fsSL https://example.com/app.tgz | tar xz -C /opt',
  after:
    'SHELL ["/bin/bash", "-o", "pipefail", "-c"]\nRUN curl -fsSL https://example.com/app.tgz | tar xz -C /opt',
  check(ctx) {
    for (const stage of ctx.df.stages) {
      let seenShell = false;
      for (const ins of stage.instructions) {
        if (ins.keyword === 'SHELL') {
          seenShell = /pipefail/.test(ins.args);
          continue;
        }
        if (ins.keyword !== 'RUN' || !ins.script || ins.script.synthetic) continue;
        if (seenShell || /pipefail/.test(ins.script.text)) continue;
        const commands = commandsOf(ins.script);
        const idx = commands.findIndex(
          (c, i) =>
            c.pipedInto && commands[i + 1] && !['echo', 'printf', 'cat', 'true'].includes(c.name),
        );
        const left = commands[idx];
        const right = commands[idx + 1];
        if (idx !== -1 && left && right) {
          ctx.report({
            message:
              'This pipeline hides failures of the left-hand command. Add `SHELL ["/bin/bash", "-o", "pipefail", "-c"]` or `set -o pipefail`.',
            at: {
              start: commandRange(ins, ins.script, left).start,
              end: commandRange(ins, ins.script, right).end,
            },
          });
        }
      }
    }
  },
});

export const DD046 = dockerfileRule({
  id: 'DD046',
  name: 'cd-in-run',
  severity: 'info',
  category: 'maintainability',
  summary: 'RUN starts with cd instead of using WORKDIR',
  explanation: 'A RUN begins with `cd <dir> &&`.',
  why: 'The directory change only lasts for that RUN, and the next instruction starts back in the old directory. WORKDIR makes the location explicit and persistent.',
  before: 'RUN cd /app && npm ci',
  after: 'WORKDIR /app\nRUN npm ci',
  check(ctx) {
    for (const stage of ctx.df.stages) {
      for (const run of runsOf(stage)) {
        const [first, second] = run.commands;
        if (first?.name === 'cd' && second && second.op === '&&' && !run.script.synthetic) {
          ctx.report({
            message: 'Use WORKDIR instead of `cd` at the start of a RUN.',
            at: commandRange(run.instr, run.script, first),
          });
        }
      }
    }
  },
});

export const INSTRUCTION_RULES: DockerfileRule[] = [
  DD030,
  DD031,
  DD032,
  DD033,
  DD034,
  DD035,
  DD037,
  DD038,
  DD039,
  DD041,
  DD042,
  DD043,
  DD044,
  DD046,
];
