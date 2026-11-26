import { stageUser } from '../../core/parser.js';
import {
  allRuns,
  argsRange,
  type DockerfileRule,
  dockerfileRule,
  fix,
  instrRange,
  keywordRange,
  replaceRange,
  wordRange,
} from '../../core/rule.js';
import {
  findSecretPatterns,
  isNonLiteral,
  isSecretName,
  looksHighEntropy,
} from '../../core/secrets.js';
import type { Word } from '../../core/shell.js';
import { copyParts, effectiveUser, isRootUser } from './helpers.js';

const NON_ROOT_BASES = /(?:nonroot|unprivileged|rootless)/i;
const NON_ROOT_REGISTRIES = /^(?:cgr\.dev\/chainguard\/|bitnami\/|docker\.io\/bitnami\/)/;

export const DD003 = dockerfileRule({
  id: 'DD003',
  name: 'run-as-root',
  severity: 'warn',
  category: 'security',
  summary: 'Container runs as root (no USER instruction)',
  explanation:
    'The final stage never sets USER, so the process runs as uid 0 inside the container. Base images that already default to a non-root user (distroless :nonroot, *-unprivileged, Chainguard, Bitnami) are not reported.',
  why: 'If the app has a remote-code-execution bug, the attacker starts as root inside the container, which makes breakouts, writes to mounted volumes and abuse of the container runtime far easier. A fixed non-root uid costs one line.',
  before: 'FROM node:22-alpine\nCOPY . /app\nCMD ["node", "/app/server.js"]',
  after:
    'FROM node:22-alpine\nCOPY --chown=node:node . /app\nUSER node\nCMD ["node", "/app/server.js"]',
  check(ctx) {
    const stage = ctx.finalStage;
    if (!stage) return;
    if (effectiveUser(ctx.df, stage) !== undefined) return;
    const img = stage.image;
    if (NON_ROOT_BASES.test(img.tag ?? '') || NON_ROOT_BASES.test(img.name)) return;
    if (NON_ROOT_REGISTRIES.test(img.name)) return;
    ctx.report({
      message: `The final stage never sets USER, so the container runs as root.`,
      at: keywordRange(stage.from),
    });
  },
});

export const DD004 = dockerfileRule({
  id: 'DD004',
  name: 'explicit-root-user',
  severity: 'warn',
  category: 'security',
  summary: 'The last USER in the final stage is root',
  explanation:
    'The final stage switches to root (USER root, USER 0) and never switches back to an unprivileged user.',
  why: 'Same risk as having no USER at all, but written down on purpose. Switching to root to install packages is fine as long as the stage ends with a non-root USER.',
  before: 'FROM python:3.12-slim\nUSER root\nCMD ["python", "app.py"]',
  after:
    'FROM python:3.12-slim\nRUN useradd --system --uid 10001 app\nUSER app\nCMD ["python", "app.py"]',
  check(ctx) {
    const stage = ctx.finalStage;
    if (!stage) return;
    const own = stageUser(stage);
    if (own && isRootUser(own.value)) {
      ctx.report({
        message: `The final stage ends with USER ${own.value}, so the container runs as root.`,
        at: instrRange(own.instr),
      });
    }
  },
});

const ARCHIVE = /\.(?:tar|tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz|tar\.zst|tzst)$/i;
const URL_RE = /^(?:https?|ftp):\/\//i;

export const DD005 = dockerfileRule({
  id: 'DD005',
  name: 'add-instead-of-copy',
  severity: 'warn',
  category: 'maintainability',
  summary: 'ADD used where COPY would do',
  explanation:
    'ADD has hidden behaviour: it fetches URLs and auto-extracts local tar archives. When you only want to copy files into the image, COPY says exactly that and nothing more.',
  why: 'A file that happens to be a tarball gets silently unpacked, and a URL gets downloaded without a checksum. COPY is predictable and easier to review.',
  before: 'ADD ./config /etc/app/',
  after: 'COPY ./config /etc/app/',
  fixable: true,
  check(ctx) {
    for (const stage of ctx.df.stages) {
      for (const ins of stage.instructions) {
        if (ins.keyword !== 'ADD') continue;
        if (ins.heredocs.length > 0) continue;
        if (ins.flags.some((f) => ['checksum', 'keep-git-dir'].includes(f.name))) continue;
        const { sources } = copyParts(ins);
        if (sources.length === 0) continue;
        if (sources.some((s) => URL_RE.test(s.text) || /^git@|\.git(?:#|$)/.test(s.text))) continue;
        if (sources.some((s) => ARCHIVE.test(s.text))) continue;
        ctx.report({
          message:
            "Use COPY instead of ADD: nothing here needs ADD's URL or tar-extraction behaviour.",
          at: keywordRange(ins),
          fix: fix('Replace ADD with COPY', replaceRange(keywordRange(ins), 'COPY')),
        });
      }
    }
  },
});

export const DD006 = dockerfileRule({
  id: 'DD006',
  name: 'add-remote-url',
  severity: 'warn',
  category: 'security',
  summary: 'ADD downloads a URL without a checksum',
  explanation:
    'ADD <url> downloads at build time and trusts whatever comes back. Without --checksum the content is not verified.',
  why: 'A compromised or changed download is baked into your image and into every layer cache after it. Verify what you download.',
  before: 'ADD https://example.com/tool-1.2.tar.gz /tmp/',
  after:
    'ADD --checksum=sha256:<digest> https://example.com/tool-1.2.tar.gz /tmp/\n# or: RUN curl -fsSLO <url> && echo "<digest>  file" | sha256sum -c -',
  check(ctx) {
    for (const stage of ctx.df.stages) {
      for (const ins of stage.instructions) {
        if (ins.keyword !== 'ADD') continue;
        if (ins.flags.some((f) => f.name === 'checksum')) continue;
        const { sources } = copyParts(ins);
        const url = sources.find((s) => URL_RE.test(s.text));
        if (url) {
          ctx.report({
            message: `ADD downloads ${url.text} without --checksum, so the content is not verified.`,
            at: argsRange(ins, url.start, url.end),
          });
        }
      }
    }
  },
});

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh']);
const INTERPRETERS = /^(?:python[0-9.]*|perl|ruby|node)$/;

export const DD007 = dockerfileRule({
  id: 'DD007',
  name: 'curl-pipe-shell',
  severity: 'error',
  category: 'security',
  summary: 'Remote script piped straight into a shell',
  explanation:
    'A RUN step downloads with curl or wget and pipes the result into sh, bash or an interpreter in one go.',
  why: 'You execute code you never read, as root, and a truncated download can run a half-written script. Download the file, check its checksum or signature, then run it.',
  before: 'RUN curl -sSL https://example.com/install.sh | sh',
  after:
    'RUN curl -fsSLo /tmp/install.sh https://example.com/install.sh \\\n && echo "<sha256>  /tmp/install.sh" | sha256sum -c - \\\n && sh /tmp/install.sh',
  check(ctx) {
    for (const { instr, script, commands } of allRuns(ctx)) {
      commands.forEach((cmd, i) => {
        const next = commands[i + 1];
        if (['curl', 'wget', 'fetch'].includes(cmd.name) && cmd.pipedInto && next) {
          if (SHELLS.has(next.name) || INTERPRETERS.test(next.name)) {
            ctx.report({
              message: `${cmd.name} output is piped into ${next.name}: the script runs without being checked.`,
              at: {
                start: wordRange(instr, script, cmd.words[0] as Word).start,
                end: wordRange(instr, script, next.words[next.words.length - 1] as Word).end,
              },
            });
          }
        }
        // sh -c "$(curl ...)" and bash <(curl ...)
        if (SHELLS.has(cmd.name)) {
          const w = cmd.args.find((a) => /(?:\$\(|<\(|`)\s*(?:curl|wget)\b/.test(a.text));
          if (w) {
            ctx.report({
              message: `${cmd.name} executes the output of curl/wget directly.`,
              at: wordRange(instr, script, w),
            });
          }
        }
      });
    }
  },
});

export const DD008 = dockerfileRule({
  id: 'DD008',
  name: 'secret-in-env-arg',
  severity: 'error',
  category: 'security',
  summary: 'Secret-looking ENV/ARG with a literal value',
  explanation:
    'An ENV or ARG whose name looks like a credential (PASSWORD, TOKEN, API_KEY, ...) is given a literal value. ARG without a default and ENV copied from an ARG are reported as warnings.',
  why: 'ENV values live in the image config and ARG values are recorded in `docker history`. Anyone who can pull the image can read them, and rotating the secret means rebuilding every image. Pass secrets at runtime, or use BuildKit secret mounts for build-time needs.',
  before: 'ENV DB_PASSWORD=hunter2\nARG NPM_TOKEN',
  after:
    'RUN --mount=type=secret,id=npm_token \\\n    NPM_TOKEN=$(cat /run/secrets/npm_token) npm ci',
  check(ctx) {
    for (const ins of ctx.df.instructions) {
      if (ins.keyword !== 'ENV' && ins.keyword !== 'ARG') continue;
      for (const p of ins.pairs ?? []) {
        if (!isSecretName(p.key)) continue;
        const at = { start: p.keyStart, end: Math.max(p.valueEnd, p.keyEnd) };
        if (ins.keyword === 'ARG') {
          if (p.value === undefined || p.value === '') {
            ctx.report({
              message: `ARG ${p.key} will be stored in the image history when it is used. Use a BuildKit secret mount instead.`,
              at,
              severity: 'warn',
            });
          } else if (!isNonLiteral(p.value)) {
            ctx.report({
              message: `ARG ${p.key} has a hard-coded default that is recorded in the image history.`,
              at,
            });
          }
        } else if (!isNonLiteral(p.value)) {
          ctx.report({
            message: `ENV ${p.key} bakes a literal secret into the image configuration.`,
            at,
          });
        } else if (p.value && /^\$\{?[A-Za-z_]/.test(p.value.trim())) {
          ctx.report({
            message: `ENV ${p.key} copies a build argument into the image, so the secret ends up in the image configuration.`,
            at,
            severity: 'warn',
          });
        }
      }
    }
  },
});

export const DD009 = dockerfileRule({
  id: 'DD009',
  name: 'secret-pattern',
  severity: 'error',
  category: 'security',
  summary: 'Value matches a known credential format or looks like a random token',
  explanation:
    'Text in the Dockerfile matches a well-known credential shape (AWS access key id, GitHub/Slack/Stripe token, private key block, JWT, user:password in a URL) or an ENV/ARG value is a long high-entropy string.',
  why: 'Credentials committed to a Dockerfile are in your git history and in every image built from it. Treat anything reported here as already leaked: rotate it, then remove it.',
  before:
    'ENV AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nRUN git clone https://ci:s3cr3tpass@git.example.com/app.git',
  after: 'RUN --mount=type=secret,id=git_creds \\\n    git clone https://git.example.com/app.git',
  check(ctx) {
    for (const ins of ctx.df.instructions) {
      const flaggedByName = new Set<string>();
      for (const p of ins.pairs ?? []) {
        if (
          (ins.keyword === 'ENV' || ins.keyword === 'ARG') &&
          isSecretName(p.key) &&
          !isNonLiteral(p.value)
        ) {
          flaggedByName.add(p.key);
        }
      }
      const texts: Array<{ text: string; toAbs: (i: number) => number }> = [
        { text: ins.args, toAbs: (i) => ins.map[i] as number },
      ];
      for (const hd of ins.heredocs) texts.push({ text: hd.body, toAbs: (i) => hd.bodyStart + i });
      for (const { text, toAbs } of texts) {
        for (const hit of findSecretPatterns(text)) {
          ctx.report({
            message: `Looks like ${/^[AEIOU]/.test(hit.kind) ? 'an' : 'a'} ${hit.kind}. Treat it as leaked and use a runtime secret instead.`,
            at: { start: toAbs(hit.index), end: toAbs(hit.index + hit.length) },
          });
        }
      }
      if (ins.keyword === 'ENV' || ins.keyword === 'ARG') {
        for (const p of ins.pairs ?? []) {
          if (flaggedByName.has(p.key) || !p.value) continue;
          if (looksHighEntropy(p.value)) {
            ctx.report({
              message: `${p.key} holds a long high-entropy value that looks like a generated secret.`,
              at: { start: p.keyStart, end: p.valueEnd },
              severity: 'warn',
            });
          }
        }
      }
    }
  },
});

export const DD010 = dockerfileRule({
  id: 'DD010',
  name: 'sudo-or-su',
  severity: 'warn',
  category: 'security',
  summary: 'sudo or su used inside a RUN step',
  explanation:
    'RUN steps already execute as the current USER (root by default). sudo and su add nothing during a build.',
  why: 'Installing sudo adds a setuid binary to the image, and `su`/`sudo` at runtime is a privilege-escalation path. Use USER to switch identities and run privileged build steps before the switch.',
  before: 'RUN sudo apt-get update && sudo apt-get install -y curl',
  after: 'RUN apt-get update && apt-get install -y curl',
  check(ctx) {
    for (const { instr, script, commands } of allRuns(ctx)) {
      for (const cmd of commands) {
        const sudo = cmd.name === 'su' || cmd.wrappers.includes('sudo');
        if (!sudo) continue;
        const w =
          cmd.words.find((x) => x.text === 'sudo' || x.text === 'su') ?? (cmd.words[0] as Word);
        ctx.report({
          message: `${cmd.name === 'su' ? 'su' : 'sudo'} is unnecessary in a RUN step and weakens the image. Use USER to change identity.`,
          at: wordRange(instr, script, w),
        });
      }
    }
  },
});

function modeIsWorldWritable(mode: string): boolean {
  if (/^[0-7]{3,4}$/.test(mode)) return '2367'.includes(mode[mode.length - 1] as string);
  return mode.split(',').some((clause) => {
    const m = /^([ugoa]*)([+=])([rwxXst]*)$/.exec(clause);
    if (!m) return false;
    const who = m[1] as string;
    return (who.includes('o') || who.includes('a')) && (m[3] as string).includes('w');
  });
}

export const DD011 = dockerfileRule({
  id: 'DD011',
  name: 'chmod-world-writable',
  severity: 'warn',
  category: 'security',
  summary: 'chmod makes files world-writable',
  explanation:
    'chmod 777 (or o+w, a+rwx, --chmod=777) lets every user in the container modify the files.',
  why: 'It is almost always a shortcut to silence a permissions error. Any compromised process in the container can then rewrite your code or config. Fix the owner (chown / USER) and grant only what is needed.',
  before: 'RUN chmod -R 777 /app',
  after: 'RUN chown -R app:app /app && chmod -R u=rwX,go=rX /app',
  check(ctx) {
    for (const { instr, script, commands } of allRuns(ctx)) {
      for (const cmd of commands) {
        if (cmd.name !== 'chmod') continue;
        const mode = cmd.args.find((a) => !a.text.startsWith('-'));
        if (mode && modeIsWorldWritable(mode.text)) {
          ctx.report({
            message: `chmod ${mode.text} makes files writable by every user in the container.`,
            at: wordRange(instr, script, mode),
          });
        }
      }
    }
    for (const ins of ctx.df.instructions) {
      for (const f of ins.flags) {
        if (f.name === 'chmod' && f.value && modeIsWorldWritable(f.value)) {
          ctx.report({
            message: `--chmod=${f.value} makes the copied files world-writable.`,
            at: { start: f.start, end: f.end },
          });
        }
      }
    }
  },
});

function exposedPorts(
  text: string,
): Array<{ lo: number; hi: number; token: string; start: number; end: number }> {
  const out: Array<{ lo: number; hi: number; token: string; start: number; end: number }> = [];
  const re = /\S+/g;
  let m = re.exec(text);
  while (m) {
    const t = /^(\d{1,5})(?:-(\d{1,5}))?(?:\/(?:tcp|udp|sctp))?$/i.exec(m[0]);
    if (t) {
      out.push({
        lo: Number(t[1]),
        hi: Number(t[2] ?? t[1]),
        token: m[0],
        start: m.index,
        end: m.index + m[0].length,
      });
    }
    m = re.exec(text);
  }
  return out;
}

export const DD012 = dockerfileRule({
  id: 'DD012',
  name: 'expose-ssh-port',
  severity: 'warn',
  category: 'security',
  summary: 'EXPOSE 22 (SSH) in an application image',
  explanation: 'The image declares port 22, which is SSH.',
  why: 'Running an SSH daemon inside a container is almost never needed (use `docker exec`, `kubectl exec` or a bastion) and it adds a login surface, host keys and credentials to manage.',
  before: 'EXPOSE 22 8080',
  after: 'EXPOSE 8080',
  check(ctx) {
    for (const ins of ctx.df.instructions) {
      if (ins.keyword !== 'EXPOSE') continue;
      for (const p of exposedPorts(ins.args)) {
        if (p.lo <= 22 && p.hi >= 22) {
          ctx.report({
            message: `EXPOSE ${p.token} publishes the SSH port. Containers should not run sshd.`,
            at: argsRange(ins, p.start, p.end),
          });
        }
      }
    }
  },
});

export const DD013 = dockerfileRule({
  id: 'DD013',
  name: 'expose-privileged-port',
  severity: 'info',
  category: 'correctness',
  summary: 'Privileged port (<1024) exposed by a non-root image',
  explanation:
    'The image runs as a non-root USER but exposes a port below 1024, which unprivileged processes usually cannot bind (Kubernetes and rootless runtimes do not relax this).',
  why: 'The app works on a laptop and then fails to start in the cluster with "permission denied". Listen on 8080/8443 and map it at the edge.',
  before: 'USER app\nEXPOSE 80',
  after: 'USER app\nEXPOSE 8080',
  check(ctx) {
    const stage = ctx.finalStage;
    if (!stage) return;
    const user = effectiveUser(ctx.df, stage);
    if (user === undefined || isRootUser(user)) return;
    for (const ins of stage.instructions) {
      if (ins.keyword !== 'EXPOSE') continue;
      for (const p of exposedPorts(ins.args)) {
        if (p.lo === 22 && p.hi === 22) continue; // DD012
        if (p.lo < 1024) {
          ctx.report({
            message: `Port ${p.token} is privileged, but the container runs as non-root user "${user}".`,
            at: argsRange(ins, p.start, p.end),
          });
        }
      }
    }
  },
});

const SENSITIVE = [
  {
    re: /(?:^|\/)\.env(?:\.(?!example$|sample$|template$|dist$|defaults?$)[\w.-]+)?$/i,
    what: 'an .env file',
  },
  { re: /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?$/i, what: 'an SSH key' },
  { re: /(?:^|\/)\.ssh(?:\/|$)/, what: 'an SSH directory' },
  { re: /(?:^|\/)\.aws(?:\/|$)/, what: 'AWS credentials' },
  { re: /(?:^|\/)\.(?:npmrc|pypirc|netrc|pgpass|htpasswd)$/, what: 'a credentials file' },
  { re: /(?:^|\/)\.docker\/config\.json$/, what: 'Docker registry credentials' },
  { re: /(?:^|\/)\.kube\/config$/, what: 'a kubeconfig' },
  { re: /\.(?:key|p12|pfx|jks|keystore)$/i, what: 'a private key or keystore' },
  { re: /(?:private|priv|secret)[\w.-]*\.pem$/i, what: 'a private key' },
  { re: /(?:^|\/)\.git(?:\/|$)/, what: 'the .git directory (full source history)' },
  { re: /(?:^|\/)terraform\.tfstate(?:\.backup)?$/, what: 'Terraform state' },
];

export const DD014 = dockerfileRule({
  id: 'DD014',
  name: 'sensitive-file-copied',
  severity: 'error',
  category: 'security',
  summary: 'COPY/ADD of a credentials or key file',
  explanation:
    'A COPY or ADD names a file that normally holds secrets: .env, SSH or TLS private keys, .npmrc/.pypirc, cloud credentials, kubeconfig, the .git directory, Terraform state.',
  why: 'Files copied into a layer stay there even if you delete them in a later step. Anyone with the image can extract them. Mount secrets at build time instead of copying them.',
  before: 'COPY .env /app/.env\nCOPY id_rsa /root/.ssh/',
  after:
    'RUN --mount=type=secret,id=ssh,target=/root/.ssh/id_rsa git clone git@example.com:org/repo.git',
  check(ctx) {
    for (const ins of ctx.df.instructions) {
      if (ins.keyword !== 'COPY' && ins.keyword !== 'ADD') continue;
      if (ins.flags.some((f) => f.name === 'from')) continue;
      const { sources } = copyParts(ins);
      for (const s of sources) {
        const hit = SENSITIVE.find((x) => x.re.test(s.text));
        if (hit) {
          ctx.report({
            message: `${ins.keyword} copies ${hit.what} (${s.text}) into the image. It stays in the layer even if deleted later.`,
            at: argsRange(ins, s.start, s.end),
          });
        }
      }
    }
  },
});

const INSECURE_ENV =
  /^(?:NODE_TLS_REJECT_UNAUTHORIZED=0|GIT_SSL_NO_VERIFY=(?:1|true)|PYTHONHTTPSVERIFY=0|CURL_CA_BUNDLE=)$/i;

export const DD015 = dockerfileRule({
  id: 'DD015',
  name: 'insecure-transport',
  severity: 'warn',
  category: 'security',
  summary: 'TLS or signature checking switched off',
  explanation:
    'A build step disables certificate or signature verification: curl -k, wget --no-check-certificate, pip --trusted-host, apt --allow-unauthenticated, git http.sslVerify=false, NODE_TLS_REJECT_UNAUTHORIZED=0, and similar.',
  why: 'It turns every download in the build into something a network attacker can swap. Fix the trust store (install the CA certificate) rather than turning verification off.',
  before: 'RUN curl -k https://internal.example.com/pkg.tgz -o pkg.tgz',
  after:
    'COPY corp-ca.crt /usr/local/share/ca-certificates/\nRUN update-ca-certificates \\\n && curl -fsSL https://internal.example.com/pkg.tgz -o pkg.tgz',
  check(ctx) {
    for (const { instr, script, commands } of allRuns(ctx)) {
      for (const cmd of commands) {
        const hit = (word: (typeof cmd.words)[number], what: string) =>
          ctx.report({
            message: `${what} disables verification.`,
            at: wordRange(instr, script, word),
          });
        for (const w of cmd.words) {
          if (INSECURE_ENV.test(w.text)) hit(w, w.text.split('=')[0] as string);
        }
        if (cmd.name === 'curl') {
          const w = cmd.args.find(
            (a) => a.text === '--insecure' || /^-[A-Za-z]*k[A-Za-z]*$/.test(a.text),
          );
          if (w) hit(w, `curl ${w.text}`);
        } else if (cmd.name === 'wget') {
          const w = cmd.args.find((a) => a.text === '--no-check-certificate');
          if (w) hit(w, 'wget --no-check-certificate');
        } else if (
          cmd.name === 'pip' ||
          cmd.name === 'pip3' ||
          cmd.name === 'python' ||
          cmd.name === 'python3'
        ) {
          const w = cmd.args.find((a) => a.text === '--trusted-host');
          if (w) hit(w, 'pip --trusted-host');
        } else if (cmd.name === 'apt-get' || cmd.name === 'apt') {
          const w = cmd.args.find(
            (a) =>
              /^--allow-(?:unauthenticated|insecure-repositories)$/.test(a.text) ||
              /Verify-Peer=false|AllowInsecureRepositories/.test(a.text),
          );
          if (w) hit(w, `apt ${w.text}`);
        } else if (cmd.name === 'apk') {
          const w = cmd.args.find((a) => a.text === '--allow-untrusted');
          if (w) hit(w, 'apk --allow-untrusted');
        } else if (cmd.name === 'yum' || cmd.name === 'dnf' || cmd.name === 'rpm') {
          const w = cmd.args.find((a) => a.text === '--nogpgcheck' || a.text === '--nosignature');
          if (w) hit(w, `${cmd.name} ${w.text}`);
        } else if (cmd.name === 'git') {
          const i = cmd.args.findIndex((a) => /^http\.sslverify$/i.test(a.text));
          const val = cmd.args[i + 1];
          if (i !== -1 && val?.text === 'false')
            hit(cmd.args[i] as Word, 'git http.sslVerify=false');
        } else if (cmd.name === 'npm' || cmd.name === 'yarn') {
          const i = cmd.args.findIndex((a) => a.text === 'strict-ssl');
          const val = cmd.args[i + 1];
          if (i !== -1 && val?.text === 'false')
            hit(cmd.args[i] as Word, `${cmd.name} strict-ssl=false`);
        }
      }
    }
    for (const ins of ctx.df.instructions) {
      if (ins.keyword !== 'ENV') continue;
      for (const p of ins.pairs ?? []) {
        if (INSECURE_ENV.test(`${p.key}=${p.value ?? ''}`)) {
          ctx.report({
            message: `ENV ${p.key}=${p.value ?? ''} disables certificate verification for the running app.`,
            at: { start: p.keyStart, end: p.valueEnd },
          });
        }
      }
    }
  },
});

export const DD036 = dockerfileRule({
  id: 'DD036',
  name: 'copy-missing-chown',
  severity: 'info',
  category: 'security',
  summary: 'COPY after USER without --chown (files stay owned by root)',
  explanation:
    'After a non-root USER, COPY/ADD still creates files owned by root unless you pass --chown. Only the first occurrence per stage is reported.',
  why: 'Read-only code owned by root is fine, and even preferable. But if the app needs to write next to the copied files (caches, uploads, SQLite, compiled templates) it fails at runtime with "permission denied". Decide on purpose: --chown for writable paths, root ownership for read-only ones.',
  before: 'USER app\nCOPY . /app',
  after: 'USER app\nCOPY --chown=app:app . /app',
  check(ctx) {
    for (const stage of ctx.df.stages) {
      let user: string | undefined;
      const affected: typeof stage.instructions = [];
      for (const ins of stage.instructions) {
        if (ins.keyword === 'USER') user = ins.args.trim();
        if ((ins.keyword === 'COPY' || ins.keyword === 'ADD') && user && !isRootUser(user)) {
          if (!ins.flags.some((f) => f.name === 'chown') && ins.heredocs.length === 0)
            affected.push(ins);
        }
      }
      const first = affected[0];
      if (first) {
        const more = affected.length > 1 ? ` (and ${affected.length - 1} more in this stage)` : '';
        ctx.report({
          message: `${first.keyword} runs after "USER ${user}" without --chown, so the files are owned by root${more}.`,
          at: keywordRange(first),
        });
      }
    }
  },
});

export const SECURITY_RULES: DockerfileRule[] = [
  DD003,
  DD004,
  DD005,
  DD006,
  DD007,
  DD008,
  DD009,
  DD010,
  DD011,
  DD012,
  DD013,
  DD014,
  DD015,
  DD036,
];
