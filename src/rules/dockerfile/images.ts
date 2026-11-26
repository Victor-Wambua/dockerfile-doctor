import { expandVars, KNOWN_INSTRUCTIONS } from '../../core/parser.js';
import { type DockerfileRule, dockerfileRule, instrRange, keywordRange } from '../../core/rule.js';
import { levenshtein } from '../../core/text.js';
import { imageRange, isExternalImage } from './helpers.js';

export const DD001 = dockerfileRule({
  id: 'DD001',
  name: 'unpinned-base-image',
  severity: 'warn',
  category: 'reproducibility',
  summary: 'Base image has no tag or uses :latest',
  explanation:
    'A FROM line without a tag, or with :latest, points at whatever the registry calls "newest" on the day you build.',
  why: 'Two builds of the same commit can produce different images. A rebuild at 2 a.m. can pull a new major version of your runtime and break production with no change in your repo. Pin a specific version, then update it on purpose.',
  before: 'FROM node\nFROM python:latest',
  after: 'FROM node:22.11-alpine3.20\nFROM python:3.12-slim-bookworm',
  check(ctx) {
    for (const stage of ctx.df.stages) {
      const { image } = stage;
      if (!isExternalImage(ctx.df, stage)) continue;
      if (image.digest || image.unresolvedVars.length > 0) continue;
      if (image.tag === undefined) {
        ctx.report({
          message: `Base image "${image.name}" has no tag, so it resolves to :latest.`,
          at: imageRange(stage),
        });
      } else if (image.tag === 'latest') {
        ctx.report({
          message: `Base image "${image.name}:latest" is a moving target.`,
          at: imageRange(stage),
        });
      }
    }
  },
});

export const DD002 = dockerfileRule({
  id: 'DD002',
  name: 'base-image-no-digest',
  severity: 'info',
  category: 'reproducibility',
  summary: 'Base image is tagged but not pinned by digest',
  explanation:
    'A version tag such as node:22.11-alpine can still be re-pushed by the publisher. A digest (@sha256:...) cannot.',
  why: 'Tags are mutable. If you need bit-for-bit repeatable builds or want to prove which base you shipped, pin the digest and let a bot (Dependabot, Renovate) bump it. This is informational because digests make Dockerfiles harder to read.',
  before: 'FROM node:22.11-alpine3.20',
  after: 'FROM node:22.11-alpine3.20@sha256:<digest>',
  check(ctx) {
    for (const stage of ctx.df.stages) {
      const { image } = stage;
      if (!isExternalImage(ctx.df, stage)) continue;
      if (image.digest || image.unresolvedVars.length > 0) continue;
      if (image.tag === undefined || image.tag === 'latest') continue; // DD001 covers these
      ctx.report({
        message: `"${image.name}:${image.tag}" is not pinned by digest.`,
        at: imageRange(stage),
      });
    }
  },
});

const BUILTIN_BUILD_ARGS = new Set([
  'BUILDPLATFORM',
  'BUILDOS',
  'BUILDARCH',
  'BUILDVARIANT',
  'TARGETPLATFORM',
  'TARGETOS',
  'TARGETARCH',
  'TARGETVARIANT',
]);
const PROXY_ARGS = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'FTP_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'ftp_proxy',
  'no_proxy',
  'all_proxy',
]);
const EXPANDING = new Set([
  'ENV',
  'ADD',
  'COPY',
  'EXPOSE',
  'LABEL',
  'STOPSIGNAL',
  'USER',
  'VOLUME',
  'WORKDIR',
  'ARG',
]);

export const DD021 = dockerfileRule({
  id: 'DD021',
  name: 'arg-scope',
  severity: 'warn',
  category: 'correctness',
  summary: 'ARG used outside the scope where it is defined',
  explanation:
    'An ARG declared before the first FROM is only visible to FROM lines. Inside a stage it is empty unless you repeat `ARG NAME` after FROM. Build-platform ARGs such as TARGETARCH behave the same way.',
  why: 'The build does not fail: the variable silently expands to an empty string, so you get a wrong path, a missing version or a broken download URL that only shows up at runtime.',
  before: 'ARG APP_VERSION=1.4.0\nFROM alpine:3.20\nLABEL version=$APP_VERSION',
  after: 'ARG APP_VERSION=1.4.0\nFROM alpine:3.20\nARG APP_VERSION\nLABEL version=$APP_VERSION',
  check(ctx) {
    const globals = ctx.df.globalArgs;
    for (const stage of ctx.df.stages) {
      // FROM lines may only use global ARGs (and the built-in platform args).
      const fromTexts = [stage.from.args, ...stage.from.flags.map((f) => f.value ?? '')];
      for (const text of fromTexts) {
        const r = expandVars(text, (n) =>
          globals.has(n) || BUILTIN_BUILD_ARGS.has(n) ? '' : undefined,
        );
        for (const name of new Set(r.missing)) {
          ctx.report({
            message: `FROM uses $${name}, but no ARG ${name} is declared before the first FROM, so it expands to nothing.`,
            at: instrRange(stage.from),
            severity: 'error',
          });
        }
      }
      // Inside the stage, global ARGs must be re-declared.
      const declared = new Set<string>();
      for (const ins of stage.instructions) {
        if (ins.keyword === 'FROM') continue;
        if (EXPANDING.has(ins.keyword)) {
          const re = /(?<!\\)\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
          let m = re.exec(ins.args);
          while (m) {
            const name = m[1] as string;
            const inGlobal = globals.has(name) || BUILTIN_BUILD_ARGS.has(name);
            if (inGlobal && !declared.has(name) && !PROXY_ARGS.has(name)) {
              ctx.report({
                message: `$${name} is declared before FROM, so it is not visible inside this stage. Add "ARG ${name}" after the FROM line.`,
                at: {
                  start: ins.map[m.index] as number,
                  end: ins.map[m.index + m[0].length] as number,
                },
              });
              declared.add(name); // report once per stage
            }
            m = re.exec(ins.args);
          }
        }
        if (ins.keyword === 'ARG') for (const p of ins.pairs ?? []) declared.add(p.key);
        if (ins.keyword === 'ENV') for (const p of ins.pairs ?? []) declared.add(p.key);
      }
    }
  },
});

export const DD022 = dockerfileRule({
  id: 'DD022',
  name: 'stage-reference',
  severity: 'error',
  category: 'correctness',
  summary: 'Duplicate stage name or COPY --from pointing at a stage that does not exist yet',
  explanation:
    'Stage names must be unique, and COPY --from=<stage> can only refer to an earlier stage. A name that is one typo away from a real stage is reported too.',
  why: 'A wrong --from either fails the build late (after the slow compile steps) or, worse, quietly pulls an unrelated public image with that name from Docker Hub.',
  before: 'FROM golang:1.23 AS build\nFROM alpine:3.20\nCOPY --from=biuld /out/app /app',
  after: 'FROM golang:1.23 AS build\nFROM alpine:3.20\nCOPY --from=build /out/app /app',
  check(ctx) {
    const seen = new Map<string, number>();
    for (const stage of ctx.df.stages) {
      if (stage.name) {
        const key = stage.name.toLowerCase();
        if (seen.has(key)) {
          ctx.report({
            message: `Stage name "${stage.name}" is already used by stage ${seen.get(key)}.`,
            at: instrRange(stage.from),
          });
        } else seen.set(key, stage.index);
      }
      for (const ins of stage.instructions) {
        if (ins.keyword !== 'COPY') continue;
        const from = ins.flags.find((f) => f.name === 'from');
        if (!from?.value) continue;
        const ref = from.value;
        const earlier = ctx.df.stages.slice(0, stage.index);
        const later = ctx.df.stages.slice(stage.index);
        const range = { start: from.start, end: from.end };
        if (/^\d+$/.test(ref)) {
          if (Number(ref) >= stage.index) {
            ctx.report({
              message: `--from=${ref} refers to stage ${ref}, which is not defined before this stage (stages are numbered from 0).`,
              at: range,
            });
          }
          continue;
        }
        if (earlier.some((s) => s.name?.toLowerCase() === ref.toLowerCase())) continue;
        const forward = later.find((s) => s.name?.toLowerCase() === ref.toLowerCase());
        if (forward) {
          ctx.report({
            message: `--from=${ref} refers to a stage defined at or after this one (line ${forward.from.startLine}). Stages can only copy from earlier stages.`,
            at: range,
          });
          continue;
        }
        if (/[/:.@]/.test(ref)) continue; // clearly an external image
        const near = earlier
          .filter((s) => s.name && levenshtein(s.name.toLowerCase(), ref.toLowerCase()) <= 2)
          .map((s) => s.name as string);
        if (near.length > 0) {
          ctx.report({
            message: `--from=${ref} does not match any stage. Did you mean "${near[0]}"? Docker would treat "${ref}" as an image to pull.`,
            at: range,
          });
        }
      }
    }
  },
});

export const DD040 = dockerfileRule({
  id: 'DD040',
  name: 'from-not-first',
  severity: 'error',
  category: 'correctness',
  summary: 'Instruction before the first FROM, or no FROM at all',
  explanation:
    'Only ARG (and parser directives or comments) may come before the first FROM. A Dockerfile with no FROM is not a buildable Dockerfile.',
  why: 'docker build rejects the file. In a linter pipeline this usually means the wrong file was picked up, or a stray line was pasted at the top.',
  before: 'RUN echo hi\nFROM alpine:3.20',
  after: 'FROM alpine:3.20\nRUN echo hi',
  check(ctx) {
    for (const ins of ctx.df.orphans) {
      if (!(KNOWN_INSTRUCTIONS as readonly string[]).includes(ins.keyword)) continue; // DD039 reports typos
      ctx.report({
        message: `${ins.keyword} appears before the first FROM. Only ARG may come before FROM.`,
        at: keywordRange(ins),
      });
    }
    if (
      ctx.df.stages.length === 0 &&
      ctx.df.instructions.length > 0 &&
      ctx.df.orphans.length === 0
    ) {
      const first = ctx.df.instructions[0];
      if (first)
        ctx.report({
          message: 'This Dockerfile has no FROM instruction.',
          at: keywordRange(first),
        });
    }
  },
});

export const IMAGE_RULES: DockerfileRule[] = [DD001, DD002, DD021, DD022, DD040];
