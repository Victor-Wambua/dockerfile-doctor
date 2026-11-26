import type { Instruction } from '../../core/parser.js';
import {
  commandRange,
  commandsOf,
  type DockerfileContext,
  type DockerfileRule,
  dockerfileRule,
  fix,
  hasMountFlag,
  insertAt,
  type RunInfo,
  replaceRange,
  runsOf,
  wordRange,
} from '../../core/rule.js';
import {
  hasFlag,
  hasShortFlag,
  type PackageCommand,
  packageCommand,
  type Word,
} from '../../core/shell.js';
import type { Fix } from '../../core/types.js';
import { isBroadCopy, shippedStages, stageEnv } from './helpers.js';

interface PkgHit {
  run: RunInfo;
  pc: PackageCommand;
}

function pkgHits(runs: RunInfo[], tool: string | string[], sub?: string | string[]): PkgHit[] {
  const tools = Array.isArray(tool) ? tool : [tool];
  const subs = sub === undefined ? undefined : Array.isArray(sub) ? sub : [sub];
  const out: PkgHit[] = [];
  for (const run of runs) {
    for (const cmd of run.commands) {
      const pc = packageCommand(cmd);
      if (!pc || !tools.includes(pc.tool)) continue;
      if (subs && (!pc.sub || !subs.includes(pc.sub))) continue;
      out.push({ run, pc });
    }
  }
  return out;
}

function shippedRuns(ctx: DockerfileContext): RunInfo[] {
  return shippedStages(ctx.df).flatMap(runsOf);
}

/** Fix that inserts ` text` right after the subcommand word. */
function insertAfterSub(hit: PkgHit, text: string): Fix | undefined {
  const { run, pc } = hit;
  if (run.script.synthetic || !pc.subWord) return undefined;
  const at = run.script.map[pc.subWord.end] as number;
  return fix(`Add ${text.trim()}`, insertAt(at, text));
}

function positional(words: Word[], valueFlags: Set<string>): Word[] {
  const out: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as Word;
    if (w.text.startsWith('-')) {
      if (valueFlags.has(w.text)) i++;
      continue;
    }
    out.push(w);
  }
  return out;
}

export const DD016 = dockerfileRule({
  id: 'DD016',
  name: 'apt-update-not-combined',
  severity: 'warn',
  category: 'reproducibility',
  summary: 'apt-get update runs in a different RUN than apt-get install',
  explanation: 'apt-get update is in its own RUN instruction, with no install in the same step.',
  why: 'Docker caches each RUN layer. The "update" layer is cached forever while later "install" layers change, so a new package is installed against a stale package index and fails with 404s, or installs old versions. Keep update and install in one RUN.',
  before: 'RUN apt-get update\nRUN apt-get install -y curl',
  after: 'RUN apt-get update && apt-get install -y curl',
  check(ctx) {
    for (const run of ctx.df.stages.flatMap(runsOf)) {
      const apt = run.commands.filter((c) => c.name === 'apt-get' || c.name === 'apt');
      const update = apt.find((c) => packageCommand(c)?.sub === 'update');
      if (!update) continue;
      const installs = apt.some((c) =>
        ['install', 'upgrade', 'dist-upgrade'].includes(packageCommand(c)?.sub ?? ''),
      );
      if (!installs) {
        ctx.report({
          message:
            'apt-get update is in its own RUN. Combine it with apt-get install so the cached layer cannot go stale.',
          at: commandRange(run.instr, run.script, update),
        });
      }
    }
  },
});

export const DD017 = dockerfileRule({
  id: 'DD017',
  name: 'apt-cli-unstable',
  severity: 'info',
  category: 'maintainability',
  summary: '`apt` used in a script instead of `apt-get`',
  explanation:
    '`apt` is the interactive front end. Its output and options are not guaranteed stable for scripts; apt-get is.',
  why: 'apt prints "WARNING: apt does not have a stable CLI interface" on every build and may change behaviour between releases.',
  before: 'RUN apt update && apt install -y curl',
  after: 'RUN apt-get update && apt-get install -y curl',
  fixable: true,
  check(ctx) {
    const SAFE = new Set([
      'install',
      'update',
      'upgrade',
      'remove',
      'purge',
      'autoremove',
      'clean',
    ]);
    for (const run of ctx.df.stages.flatMap(runsOf)) {
      for (const cmd of run.commands) {
        if (cmd.name !== 'apt') continue;
        const pc = packageCommand(cmd);
        const nameWord = cmd.words[cmd.nameIndex] as Word;
        const canFix =
          !!pc?.sub && SAFE.has(pc.sub) && !run.script.synthetic && nameWord.text === 'apt';
        ctx.report({
          message: 'Use apt-get in scripts: the apt CLI is not a stable interface.',
          at: wordRange(run.instr, run.script, nameWord),
          fix: canFix
            ? fix(
                'Replace apt with apt-get',
                replaceRange(wordRange(run.instr, run.script, nameWord), 'apt-get'),
              )
            : undefined,
        });
      }
    }
  },
});

const PIP_VALUE_FLAGS = new Set([
  '-r',
  '--requirement',
  '-c',
  '--constraint',
  '-i',
  '--index-url',
  '--extra-index-url',
  '-f',
  '--find-links',
  '-t',
  '--target',
  '--prefix',
  '--root',
  '--platform',
  '--python-version',
  '--implementation',
  '--abi',
  '--only-binary',
  '--no-binary',
  '--proxy',
  '--cert',
  '--src',
  '-e',
  '--editable',
  '--upgrade-strategy',
]);
const PIP_TOOLING = new Set(['pip', 'setuptools', 'wheel', 'pip-tools', 'uv']);

export const DD018 = dockerfileRule({
  id: 'DD018',
  name: 'unpinned-package-install',
  severity: 'info',
  category: 'reproducibility',
  summary: 'pip / npm -g / gem install without a version',
  explanation:
    'Packages named directly on the command line (pip install flask, npm install -g typescript, gem install rails) have no version pin.',
  why: 'The same Dockerfile installs different versions next month. Pin the version (flask==3.0.3) or install from a lock file.',
  before: 'RUN pip install flask gunicorn\nRUN npm install -g typescript',
  after: 'RUN pip install flask==3.0.3 gunicorn==22.0.0\nRUN npm install -g typescript@5.6.3',
  check(ctx) {
    const runs = ctx.df.stages.flatMap(runsOf);
    for (const { run, pc } of pkgHits(runs, 'pip', 'install')) {
      const pkgs = positional(pc.rest, PIP_VALUE_FLAGS).filter(
        (w) =>
          !w.hasExpansion &&
          !/[=<>~!@/]|^\.|\.(?:whl|tar\.gz|zip)$|^git\+/.test(w.text) &&
          !PIP_TOOLING.has(w.text.toLowerCase()),
      );
      const first = pkgs[0];
      if (first) {
        ctx.report({
          message: `pip installs "${first.text}" without a version${pkgs.length > 1 ? ` (and ${pkgs.length - 1} more)` : ''}. Pin it, e.g. ${first.text}==<version>.`,
          at: wordRange(run.instr, run.script, first),
        });
      }
    }
    for (const { run, pc } of pkgHits(runs, 'npm', ['install', 'i', 'add'])) {
      if (!hasFlag(pc.all, '-g', '--global')) continue;
      const first = positional(pc.rest, new Set(['--prefix'])).find(
        (w) => !w.hasExpansion && !/^@?[^@]+@.+/.test(w.text),
      );
      if (first) {
        ctx.report({
          message: `npm install -g ${first.text} has no version. Use ${first.text}@<version>.`,
          at: wordRange(run.instr, run.script, first),
        });
      }
    }
    for (const { run, pc } of pkgHits(runs, 'gem', 'install')) {
      if (hasFlag(pc.all, '-v', '--version')) continue;
      const first = positional(pc.rest, new Set(['-v', '--version', '-i', '--install-dir'])).find(
        (w) => !w.hasExpansion,
      );
      if (first) {
        ctx.report({
          message: `gem install ${first.text} has no version. Add -v <version>.`,
          at: wordRange(run.instr, run.script, first),
        });
      }
    }
  },
});

export const DD019 = dockerfileRule({
  id: 'DD019',
  name: 'npm-install-not-ci',
  severity: 'warn',
  category: 'reproducibility',
  summary: 'npm install / yarn / pnpm install without a frozen lock file',
  explanation:
    '`npm install` may rewrite package-lock.json and pick newer versions inside your ranges. `npm ci` installs exactly what the lock file says. The same applies to yarn without --frozen-lockfile (--immutable on Berry) and pnpm install without --frozen-lockfile.',
  why: 'Builds stop being repeatable: a transitive dependency released an hour ago ends up in production. `npm ci` is also faster and fails loudly when package.json and the lock file disagree.',
  before: 'RUN npm install',
  after: 'RUN npm ci',
  check(ctx) {
    const runs = ctx.df.stages.flatMap(runsOf);
    for (const { run, pc } of pkgHits(runs, 'npm', ['install', 'i'])) {
      if (hasFlag(pc.all, '-g', '--global')) continue;
      if (positional(pc.rest, new Set(['--prefix'])).length > 0) continue;
      ctx.report({
        message: 'Use `npm ci` so the build installs exactly what package-lock.json specifies.',
        at: wordRange(run.instr, run.script, pc.subWord as Word),
      });
    }
    for (const { run, pc } of pkgHits(runs, 'yarn')) {
      if (pc.sub && pc.sub !== 'install') continue;
      if (hasFlag(pc.all, '--frozen-lockfile', '--immutable', '--pure-lockfile')) continue;
      const w =
        pc.subWord ??
        (run.commands.find((c) => c === pc.command)?.words[pc.command.nameIndex] as Word);
      ctx.report({
        message:
          'Use `yarn install --frozen-lockfile` (or --immutable on Yarn Berry) so the lock file is respected.',
        at: wordRange(run.instr, run.script, w),
      });
    }
    for (const { run, pc } of pkgHits(runs, 'pnpm', ['install', 'i'])) {
      if (hasFlag(pc.all, '--frozen-lockfile')) continue;
      if (positional(pc.rest, new Set()).length > 0) continue;
      ctx.report({
        message: 'Use `pnpm install --frozen-lockfile` so the lock file is respected.',
        at: wordRange(run.instr, run.script, pc.subWord as Word),
      });
    }
  },
});

function isDependencyInstall(pc: PackageCommand): boolean {
  switch (pc.tool) {
    case 'npm':
      return (
        ['ci', 'install', 'i'].includes(pc.sub ?? '') &&
        !hasFlag(pc.all, '-g', '--global') &&
        positional(pc.rest, new Set()).length === 0
      );
    case 'yarn':
      return !pc.sub || pc.sub === 'install';
    case 'pnpm':
      return ['install', 'i'].includes(pc.sub ?? '');
    case 'pip':
      return pc.sub === 'install' && hasFlag(pc.all, '-r', '--requirement');
    case 'uv-pip':
      return pc.sub === 'install' && hasFlag(pc.all, '-r', '--requirement');
    case 'uv':
      return pc.sub === 'sync';
    case 'composer':
      return pc.sub === 'install';
    case 'bundle':
      return !pc.sub || pc.sub === 'install';
    case 'poetry':
      return pc.sub === 'install';
    case 'go':
      return pc.sub === 'mod' && pc.rest[0]?.text === 'download';
    case 'cargo':
      return pc.sub === 'fetch';
    default:
      return false;
  }
}

export const DD020 = dockerfileRule({
  id: 'DD020',
  name: 'copy-all-before-install',
  severity: 'warn',
  category: 'maintainability',
  summary: 'COPY . . comes before the dependency install (busts the layer cache)',
  explanation:
    'The whole source tree is copied before the step that installs dependencies. Any edit to any file invalidates the install layer.',
  why: 'Every build re-downloads all dependencies even when only one source line changed. Copy only the manifest and lock file first, install, then copy the rest. CI minutes and developer patience are both saved.',
  before: 'COPY . .\nRUN npm ci',
  after: 'COPY package.json package-lock.json ./\nRUN npm ci\nCOPY . .',
  check(ctx) {
    for (const stage of ctx.df.stages) {
      let broad: Instruction | undefined;
      let reported = false;
      for (const ins of stage.instructions) {
        if (!broad && isBroadCopy(ins)) {
          broad = ins;
          continue;
        }
        if (!broad || reported || ins.keyword !== 'RUN' || !ins.script) continue;
        const dep = commandsOf(ins.script)
          .map(packageCommand)
          .find((pc) => pc && isDependencyInstall(pc));
        if (dep) {
          reported = true;
          ctx.report({
            message: `"${broad.keyword} ${broad.args}" copies everything before "${`${dep.tool} ${dep.sub ?? ''}`.trim()}" runs, so every source edit re-installs all dependencies. Copy only the manifest and lock file first.`,
            at: { start: broad.start, end: broad.end },
          });
        }
      }
    }
  },
});

export const DD023 = dockerfileRule({
  id: 'DD023',
  name: 'package-upgrade-all',
  severity: 'warn',
  category: 'reproducibility',
  summary: 'apt-get upgrade / apk upgrade / yum update in an image build',
  explanation:
    'The build upgrades every installed package instead of installing the ones you need.',
  why: 'The result depends on the day you build, and it hides the real fix: choose a newer, patched base image. Rebuild on a schedule against a pinned base instead.',
  before: 'RUN apt-get update && apt-get -y upgrade',
  after: 'FROM debian:12.7-slim   # bump this when security updates land',
  check(ctx) {
    for (const run of ctx.df.stages.flatMap(runsOf)) {
      for (const cmd of run.commands) {
        const pc = packageCommand(cmd);
        if (!pc) continue;
        const bad =
          (['apt-get', 'apt'].includes(pc.tool) &&
            ['upgrade', 'dist-upgrade', 'full-upgrade'].includes(pc.sub ?? '')) ||
          (pc.tool === 'apk' && pc.sub === 'upgrade') ||
          (['yum', 'dnf', 'microdnf'].includes(pc.tool) &&
            ['upgrade', 'update'].includes(pc.sub ?? ''));
        if (bad) {
          ctx.report({
            message: `${pc.tool} ${pc.sub} upgrades everything on the day you build. Pin a newer base image instead.`,
            at: commandRange(run.instr, run.script, cmd),
          });
        }
      }
    }
  },
});

export const DD024 = dockerfileRule({
  id: 'DD024',
  name: 'apt-no-install-recommends',
  severity: 'warn',
  category: 'size',
  summary: 'apt-get install without --no-install-recommends',
  explanation:
    'apt installs "recommended" packages by default, which are often large and unrelated to what you asked for.',
  why: 'Images routinely shrink by tens or hundreds of megabytes, and the attack surface shrinks with them. Reported for stages that end up in the final image.',
  before: 'RUN apt-get install -y curl',
  after: 'RUN apt-get install -y --no-install-recommends curl',
  fixable: true,
  check(ctx) {
    const configured = ctx.df.instructions.some((i) =>
      /APT::Install-Recommends|install-recommends\s*["']?\s*(?:=|false)/i.test(i.args),
    );
    if (configured) return;
    for (const hit of pkgHits(shippedRuns(ctx), ['apt-get', 'apt'], 'install')) {
      if (hasFlag(hit.pc.all, '--no-install-recommends')) continue;
      if (hit.pc.all.some((w) => /Install-Recommends/i.test(w.text))) continue;
      if (hasFlag(hit.pc.all, '-s', '--simulate', '--dry-run')) continue;
      ctx.report({
        message: 'apt-get install pulls in recommended packages. Add --no-install-recommends.',
        at: wordRange(hit.run.instr, hit.run.script, hit.pc.subWord as Word),
        fix: insertAfterSub(hit, ' --no-install-recommends'),
      });
    }
  },
});

export const DD025 = dockerfileRule({
  id: 'DD025',
  name: 'apt-lists-not-cleaned',
  severity: 'warn',
  category: 'size',
  summary: 'apt package lists are left in the layer',
  explanation:
    'The RUN that runs apt-get install does not delete /var/lib/apt/lists/* in the same step.',
  why: 'The package index (tens of MB) is stored in the layer forever; deleting it in a later RUN does not shrink the image because layers only add. Clean in the same RUN.',
  before: 'RUN apt-get update && apt-get install -y curl',
  after: 'RUN apt-get update && apt-get install -y curl \\\n && rm -rf /var/lib/apt/lists/*',
  fixable: true,
  check(ctx) {
    const seen = new Set<Instruction>();
    for (const hit of pkgHits(shippedRuns(ctx), ['apt-get', 'apt'], 'install')) {
      const { run } = hit;
      if (seen.has(run.instr)) continue;
      if (hasMountFlag(run.instr, 'cache')) continue;
      if (run.script.text.includes('/var/lib/apt/lists')) continue;
      if (run.instr.heredocs.length > 0) continue;
      seen.add(run.instr);
      const last = run.commands[run.commands.length - 1];
      const canFix = last === hit.pc.command && !run.script.synthetic && !last.pipedInto;
      ctx.report({
        message:
          'apt-get install leaves /var/lib/apt/lists in this layer. Add `rm -rf /var/lib/apt/lists/*` to the same RUN.',
        at: commandRange(run.instr, run.script, hit.pc.command),
        fix: canFix
          ? fix(
              'Append rm -rf /var/lib/apt/lists/*',
              insertAt(run.script.map[last.end] as number, ' && rm -rf /var/lib/apt/lists/*'),
            )
          : undefined,
      });
    }
  },
});

export const DD026 = dockerfileRule({
  id: 'DD026',
  name: 'pip-no-cache-dir',
  severity: 'warn',
  category: 'size',
  summary: 'pip install without --no-cache-dir',
  explanation: 'pip keeps downloaded wheels in ~/.cache/pip, which ends up in the image layer.',
  why: 'The cache is never used again inside the image, but it can add 50-300 MB. Use --no-cache-dir (or set PIP_NO_CACHE_DIR=1, or use a BuildKit cache mount).',
  before: 'RUN pip install -r requirements.txt',
  after: 'RUN pip install --no-cache-dir -r requirements.txt',
  fixable: true,
  check(ctx) {
    for (const hit of pkgHits(shippedRuns(ctx), 'pip', 'install')) {
      const { run, pc } = hit;
      if (hasFlag(pc.all, '--no-cache-dir')) continue;
      if (hasMountFlag(run.instr, 'cache')) continue;
      if (pc.command.words.some((w) => /^PIP_NO_CACHE_DIR=(?!0|false|$)/i.test(w.text))) continue;
      const env = stageEnv(run.stage, run.instr);
      const v = env.get('PIP_NO_CACHE_DIR');
      if (v !== undefined && !['0', 'false', 'off', ''].includes(v.toLowerCase())) continue;
      ctx.report({
        message: 'pip install keeps its download cache in the image. Add --no-cache-dir.',
        at: wordRange(run.instr, run.script, pc.subWord as Word),
        fix: insertAfterSub(hit, ' --no-cache-dir'),
      });
    }
  },
});

export const DD027 = dockerfileRule({
  id: 'DD027',
  name: 'apk-no-cache',
  severity: 'warn',
  category: 'size',
  summary: 'apk add without --no-cache',
  explanation: 'apk add stores the package index under /var/cache/apk unless you pass --no-cache.',
  why: '--no-cache fetches the index on the fly and leaves nothing behind, so there is no separate `apk update` and no cleanup step to forget.',
  before: 'RUN apk update && apk add curl',
  after: 'RUN apk add --no-cache curl',
  fixable: true,
  check(ctx) {
    for (const hit of pkgHits(shippedRuns(ctx), 'apk', 'add')) {
      const { run, pc } = hit;
      if (hasFlag(pc.all, '--no-cache')) continue;
      if (run.script.text.includes('/var/cache/apk')) continue;
      if (hasMountFlag(run.instr, 'cache')) continue;
      ctx.report({
        message: 'apk add leaves its package index in the layer. Add --no-cache.',
        at: wordRange(run.instr, run.script, pc.subWord as Word),
        fix: insertAfterSub(hit, ' --no-cache'),
      });
    }
  },
});

const COMPILERS = new Set([
  'build-essential',
  'gcc',
  'g++',
  'make',
  'cmake',
  'clang',
  'autoconf',
  'automake',
  'libtool',
  'musl-dev',
  'libc-dev',
  'libc6-dev',
  'linux-headers',
  'rustc',
  'cargo',
  'golang',
  'build-base',
  'python3-dev',
  'python-dev',
  'pkg-config',
  '$PHPIZE_DEPS',
  '${PHPIZE_DEPS}',
]);

export const DD028 = dockerfileRule({
  id: 'DD028',
  name: 'build-tools-in-final-stage',
  severity: 'warn',
  category: 'size',
  summary: 'Compilers or build headers are installed in the image that ships',
  explanation:
    'The shipped stage installs gcc, make, build-essential, *-dev headers or similar and does not remove them in the same step. This is the single-stage-build smell.',
  why: 'Toolchains add hundreds of MB and give an attacker a compiler inside your container. Build in a separate stage and copy the result, or install the toolchain as a virtual package and delete it in the same RUN.',
  before:
    'FROM python:3.12\nRUN apt-get update && apt-get install -y build-essential libpq-dev\nRUN pip install -r requirements.txt',
  after:
    'FROM python:3.12 AS build\nRUN apt-get update && apt-get install -y build-essential libpq-dev\nRUN pip wheel -r requirements.txt -w /wheels\nFROM python:3.12-slim\nCOPY --from=build /wheels /wheels\nRUN pip install --no-cache-dir /wheels/*',
  check(ctx) {
    const multi = ctx.df.stages.length > 1;
    for (const hit of pkgHits(
      shippedRuns(ctx),
      ['apt-get', 'apt', 'apk', 'yum', 'dnf', 'microdnf'],
      ['install', 'add'],
    )) {
      const { run, pc } = hit;
      const t = run.script.text;
      if (
        /\b(?:apk\s+del|apt-get\s+(?:purge|remove|autoremove)|apt\s+(?:purge|remove|autoremove)|(?:yum|dnf)\s+(?:remove|erase))\b/.test(
          t,
        )
      )
        continue;
      const names = positional(pc.rest, new Set(['--virtual', '-t', '-o']));
      const virtualIdx = pc.rest.findIndex((w) => w.text === '--virtual' || w.text === '-t');
      const virtualName = virtualIdx === -1 ? undefined : pc.rest[virtualIdx + 1];
      const tools = names.filter(
        (w) =>
          w !== virtualName &&
          (COMPILERS.has(w.text) || COMPILERS.has(w.text.replace(/[=:].*$/, ''))),
      );
      const first = tools[0];
      if (first) {
        ctx.report({
          message: `${first.text} is installed in an image that ships${multi ? ' (not a throwaway build stage)' : ' (single-stage build)'}. Use a multi-stage build, or remove it in the same RUN.`,
          at: wordRange(run.instr, run.script, first),
        });
      }
    }
  },
});

const NPM_PROD_FLAGS = [
  '--omit=dev',
  '--only=production',
  '--only=prod',
  '--production',
  '--prod',
  '--omit',
  '--production=true',
];

export const DD029 = dockerfileRule({
  id: 'DD029',
  name: 'dev-deps-in-final-stage',
  severity: 'warn',
  category: 'size',
  summary: 'Development dependencies are installed into the image that ships',
  explanation:
    'npm/yarn/pnpm install without --omit=dev (or NODE_ENV=production), composer install without --no-dev, uv sync without --no-dev, poetry install without --only main, pip -r requirements-dev.txt: in a stage that ends up in the final image.',
  why: 'Test runners, linters, type checkers and bundlers inflate the image and widen the attack surface. Install dev dependencies only in the build stage.',
  before: 'FROM node:22-alpine\nCOPY package*.json ./\nRUN npm ci',
  after:
    'FROM node:22-alpine\nENV NODE_ENV=production\nCOPY package*.json ./\nRUN npm ci --omit=dev',
  check(ctx) {
    for (const stage of shippedStages(ctx.df)) {
      const runs = runsOf(stage);
      const nodeProd = (before: Instruction) => {
        const v = stageEnv(stage, before).get('NODE_ENV');
        return v === 'production';
      };
      const stageHasPrune = runs.some((r) =>
        /\bnpm\s+prune\b|\bpnpm\s+prune\b|\byarn\s+(?:workspaces\s+focus|install\s+--production)/.test(
          r.script.text,
        ),
      );
      for (const run of runs) {
        for (const cmd of run.commands) {
          const pc = packageCommand(cmd);
          if (!pc) continue;
          const inline = cmd.words.some((w) => w.text === 'NODE_ENV=production');
          let msg: string | undefined;
          if (
            pc.tool === 'npm' &&
            ['ci', 'install', 'i'].includes(pc.sub ?? '') &&
            !hasFlag(pc.all, '-g', '--global') &&
            positional(pc.rest, new Set()).length === 0
          ) {
            if (
              !NPM_PROD_FLAGS.some((f) => hasFlag(pc.all, f)) &&
              !nodeProd(run.instr) &&
              !inline &&
              !stageHasPrune
            ) {
              msg =
                'npm installs devDependencies here. Use `npm ci --omit=dev` (or build in a separate stage).';
            }
          } else if (pc.tool === 'yarn' && (!pc.sub || pc.sub === 'install')) {
            if (
              !hasFlag(pc.all, '--production', '--prod') &&
              !nodeProd(run.instr) &&
              !inline &&
              !stageHasPrune
            ) {
              msg =
                'yarn installs devDependencies here. Use `--production` or `NODE_ENV=production`.';
            }
          } else if (pc.tool === 'pnpm' && ['install', 'i'].includes(pc.sub ?? '')) {
            if (
              !hasFlag(pc.all, '--prod', '--production') &&
              !nodeProd(run.instr) &&
              !inline &&
              !stageHasPrune
            ) {
              msg = 'pnpm installs devDependencies here. Use `pnpm install --prod`.';
            }
          } else if (pc.tool === 'composer' && pc.sub === 'install') {
            if (!hasFlag(pc.all, '--no-dev'))
              msg = 'composer installs require-dev packages here. Use `composer install --no-dev`.';
          } else if (pc.tool === 'uv' && pc.sub === 'sync') {
            if (!hasFlag(pc.all, '--no-dev', '--only-group', '--no-group', '--no-default-groups'))
              msg = 'uv sync installs the dev dependency group by default. Use `uv sync --no-dev`.';
          } else if (pc.tool === 'poetry' && pc.sub === 'install') {
            if (
              !hasFlag(pc.all, '--only', '--without', '--no-dev', '--only-root') &&
              !pc.all.some((w) => w.text === 'main')
            )
              msg = 'poetry installs dev dependencies here. Use `poetry install --only main`.';
          } else if ((pc.tool === 'pip' || pc.tool === 'uv-pip') && pc.sub === 'install') {
            const req = pc.rest.find(
              (w) =>
                /(?:^|[/_-])(?:dev|test|tests)(?:[-_.]|\.txt|$)|requirements[-_.]?dev|dev[-_.]?requirements/i.test(
                  w.text,
                ) && /\.(?:txt|in)$/.test(w.text),
            );
            if (req) msg = `${req.text} looks like a development requirements file.`;
          }
          if (msg) ctx.report({ message: msg, at: commandRange(run.instr, run.script, cmd) });
        }
      }
    }
  },
});

export const DD045 = dockerfileRule({
  id: 'DD045',
  name: 'missing-yes',
  severity: 'error',
  category: 'correctness',
  summary: 'Package install without -y will hang or fail the build',
  explanation:
    'apt-get, yum and dnf ask "Do you want to continue? [Y/n]" unless you pass -y. There is no terminal during a build to answer.',
  why: 'The build aborts with "E: Abort." (or waits forever in some CI setups) the first time it runs on a clean cache.',
  before: 'RUN apt-get install curl',
  after: 'RUN apt-get install -y curl',
  fixable: true,
  check(ctx) {
    for (const hit of pkgHits(
      ctx.df.stages.flatMap(runsOf),
      ['apt-get', 'apt', 'yum', 'dnf', 'microdnf'],
      'install',
    )) {
      const { pc } = hit;
      if (
        hasShortFlag(pc.all, 'y') ||
        hasFlag(
          pc.all,
          '--yes',
          '--assume-yes',
          '-qq',
          '--quiet=2',
          '-s',
          '--simulate',
          '--dry-run',
        )
      )
        continue;
      if (pc.all.some((w) => /^--assume-yes$|^-q{2,}$/.test(w.text))) continue;
      if (pc.tool === 'microdnf' && hasFlag(pc.all, '--assumeyes')) continue;
      ctx.report({
        message: `${pc.tool} install needs -y: there is nobody to confirm the prompt during a build.`,
        at: wordRange(hit.run.instr, hit.run.script, pc.subWord as Word),
        fix: insertAfterSub(hit, ' -y'),
      });
    }
  },
});

export const PACKAGE_RULES: DockerfileRule[] = [
  DD016,
  DD017,
  DD018,
  DD019,
  DD020,
  DD023,
  DD024,
  DD025,
  DD026,
  DD027,
  DD028,
  DD029,
  DD045,
];
