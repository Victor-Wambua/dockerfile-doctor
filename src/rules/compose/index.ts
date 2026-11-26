import { isMap, isPair, isScalar, isSeq, type Pair, type YAMLMap } from 'yaml';
import { expandVars, parseImageRef } from '../../core/parser.js';
import { type ComposeRule, composeRule, fix, replaceRange } from '../../core/rule.js';
import {
  findSecretPatterns,
  isNonLiteral,
  isSecretName,
  looksHighEntropy,
} from '../../core/secrets.js';
import {
  findPair,
  hasKey,
  nodeRange,
  pairRange,
  type Service,
  scalarString,
  servicesOf,
} from './helpers.js';

const DB_PORTS = new Set([
  1433, 3306, 3307, 5432, 5984, 6379, 7000, 8086, 9042, 9200, 9300, 11211, 26257, 27017,
]);
const DB_IMAGE =
  /(?:^|\/)(?:postgres|postgis|mysql|mariadb|mongo|redis|valkey|memcached|elasticsearch|opensearch|mssql|cassandra|couchdb|influxdb|clickhouse|cockroach)/i;
const LOOPBACK = /^(?:127\.\d+\.\d+\.\d+|::1|localhost|\[::1\])$/;

export const DC000 = composeRule({
  id: 'DC000',
  name: 'invalid-yaml',
  severity: 'error',
  category: 'correctness',
  summary: 'Compose file is not valid YAML',
  explanation:
    'The file could not be parsed as YAML, so none of the other compose rules could run.',
  why: 'docker compose refuses to start. Tabs for indentation and unquoted special characters are the usual culprits.',
  before: 'services:\n\tweb:\n\t\timage: nginx:1.27',
  after: 'services:\n  web:\n    image: nginx:1.27',
  check(ctx) {
    const err = ctx.doc.errors[0];
    if (err) {
      ctx.report({
        message: `YAML error: ${err.message.split('\n')[0]}`,
        at: { start: err.pos[0], end: Math.max(err.pos[1], err.pos[0] + 1) },
      });
    }
  },
});

export const DC001 = composeRule({
  id: 'DC001',
  name: 'compose-unpinned-image',
  severity: 'warn',
  category: 'reproducibility',
  summary: 'Service image has no tag or uses :latest',
  explanation:
    'A pulled service image is untagged or tagged :latest. Services that are built locally (build:) are ignored.',
  why: 'Next `docker compose pull` can bring a new major version of your database or proxy, and a restart on another machine can run something different from what you tested.',
  before: 'services:\n  db:\n    image: postgres:latest',
  after: 'services:\n  db:\n    image: postgres:16.4-alpine',
  check(ctx) {
    for (const svc of servicesOf(ctx)) {
      const pair = findPair(svc.map, 'image');
      const raw = scalarString(pair?.value);
      if (!pair || !raw || hasKey(svc, 'build')) continue;
      const r = expandVars(raw, () => undefined);
      if (r.missing.length > 0) continue;
      const img = parseImageRef(r.text, new Map());
      if (img.digest) continue;
      if (img.tag === undefined || img.tag === 'latest') {
        ctx.report({
          message: `Service "${svc.name}" uses ${img.tag === undefined ? 'an untagged image (implicit :latest)' : '":latest"'}: ${raw}.`,
          at: nodeRange(pair.value),
        });
      }
    }
  },
});

export const DC002 = composeRule({
  id: 'DC002',
  name: 'compose-privileged',
  severity: 'error',
  category: 'security',
  summary: 'privileged: true',
  explanation:
    'The service runs with full access to host devices and almost all kernel capabilities.',
  why: 'A privileged container can mount the host disk, load kernel modules and escape with trivial effort. Grant the single capability or device you need with cap_add or devices.',
  before: 'services:\n  app:\n    privileged: true',
  after: 'services:\n  app:\n    cap_add: [NET_ADMIN]',
  check(ctx) {
    for (const svc of servicesOf(ctx)) {
      const pair = findPair(svc.map, 'privileged');
      if (pair && svc.value.privileged === true) {
        ctx.report({
          message: `Service "${svc.name}" is privileged: it has near-root access to the host.`,
          at: pairRange(pair),
        });
      }
    }
  },
});

function volumeSources(svc: Service): Array<{ text: string; node: unknown }> {
  const pair = findPair(svc.map, 'volumes');
  if (!pair || !isSeq(pair.value)) return [];
  return pair.value.items.map((item) => {
    if (isScalar(item)) return { text: String(item.value), node: item };
    if (isMap(item)) {
      const src = findPair(item, 'source');
      return { text: scalarString(src?.value) ?? '', node: src?.value ?? item };
    }
    return { text: '', node: item };
  });
}

export const DC003 = composeRule({
  id: 'DC003',
  name: 'compose-docker-socket',
  severity: 'error',
  category: 'security',
  summary: 'Docker socket mounted into a container',
  explanation:
    'A volume mounts /var/run/docker.sock (or any docker.sock) into the service. Mounting it read-only does not help.',
  why: 'Whoever controls that socket controls the Docker daemon, which means root on the host: they can start a privileged container that mounts "/". If you need it (CI runner, reverse proxy), put a socket proxy with a restricted API in front.',
  before: 'services:\n  proxy:\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock:ro',
  after: 'services:\n  proxy:\n    environment:\n      DOCKER_HOST: tcp://socket-proxy:2375',
  check(ctx) {
    for (const svc of servicesOf(ctx)) {
      for (const v of volumeSources(svc)) {
        if (/docker\.sock/.test(v.text)) {
          ctx.report({
            message: `Service "${svc.name}" mounts the Docker socket, which is root access to the host.`,
            at: nodeRange(v.node),
          });
        }
      }
    }
  },
});

export const DC004 = composeRule({
  id: 'DC004',
  name: 'compose-host-network',
  severity: 'warn',
  category: 'security',
  summary: 'network_mode: host',
  explanation: 'The container shares the host network stack.',
  why: 'Network isolation is gone: the container can reach services bound to localhost on the host and can bind any host port. It also does not work on Docker Desktop for Mac and Windows. Publish the ports you need instead.',
  before: 'services:\n  app:\n    network_mode: host',
  after: 'services:\n  app:\n    ports: ["127.0.0.1:8080:8080"]',
  check(ctx) {
    for (const svc of servicesOf(ctx)) {
      const pair = findPair(svc.map, 'network_mode');
      if (pair && svc.value.network_mode === 'host') {
        ctx.report({
          message: `Service "${svc.name}" uses the host network.`,
          at: pairRange(pair),
        });
      }
    }
  },
});

function portParts(node: unknown): { host?: string; target?: number; ip?: string } {
  if (isScalar(node)) {
    const s = String(node.value);
    let rest = s.replace(/\/(?:tcp|udp|sctp)$/i, '');
    let ip: string | undefined;
    const v6 = /^(\[[^\]]+\]):/.exec(rest);
    if (v6) {
      ip = v6[1];
      rest = rest.slice((v6[0] as string).length);
    }
    const parts = rest.split(':');
    if (parts.length === 3 && !ip) ip = parts.shift();
    const target = parts.pop() as string;
    if (!/^\d+(?:-\d+)?$/.test(target)) return {};
    return { ip, host: parts[0], target: Number(target.split('-')[0]) };
  }
  if (isMap(node)) {
    const j = node.toJSON() as { target?: number; host_ip?: string; published?: string | number };
    return {
      ip: j.host_ip,
      host: j.published === undefined ? undefined : String(j.published),
      target: j.target,
    };
  }
  return {};
}

export const DC005 = composeRule({
  id: 'DC005',
  name: 'compose-db-port-public',
  severity: 'error',
  category: 'security',
  summary: 'Database port published on all interfaces',
  explanation:
    'A database or cache port (Postgres, MySQL, MongoDB, Redis, Elasticsearch, ...) is published without binding to 127.0.0.1.',
  why: 'Docker edits iptables itself, so `ports: "5432:5432"` bypasses ufw and most host firewalls and exposes the database to the whole network. Bind to loopback, or do not publish at all and let other services reach it over the compose network.',
  before: 'services:\n  db:\n    image: postgres:16\n    ports:\n      - "5432:5432"',
  after: 'services:\n  db:\n    image: postgres:16\n    ports:\n      - "127.0.0.1:5432:5432"',
  check(ctx) {
    for (const svc of servicesOf(ctx)) {
      const ports = findPair(svc.map, 'ports')?.value;
      if (!isSeq(ports)) continue;
      const image = String(svc.value.image ?? '');
      for (const item of ports.items) {
        const p = portParts(item);
        if (p.target === undefined || p.host === undefined) continue; // not published to a fixed host port
        const looksDb = DB_PORTS.has(p.target) || DB_IMAGE.test(image);
        if (!looksDb) continue;
        if (p.ip && LOOPBACK.test(p.ip)) continue;
        ctx.report({
          message: `Port ${p.target} of "${svc.name}" is published on every interface${p.ip ? ` (${p.ip})` : ''}. Bind it to 127.0.0.1.`,
          at: nodeRange(item),
        });
      }
    }
  },
});

function envEntries(
  svc: Service,
): Array<{ key: string; value: string | undefined; range: { start: number; end: number } }> {
  const pair = findPair(svc.map, 'environment');
  const out: Array<{
    key: string;
    value: string | undefined;
    range: { start: number; end: number };
  }> = [];
  if (!pair) return out;
  if (isMap(pair.value)) {
    for (const it of pair.value.items) {
      if (!isPair(it) || !isScalar(it.key)) continue;
      out.push({
        key: String(it.key.value),
        value: scalarString(it.value),
        range: pairRange(it as Pair),
      });
    }
  } else if (isSeq(pair.value)) {
    for (const it of pair.value.items) {
      const s = scalarString(it);
      if (s === undefined) continue;
      const eq = s.indexOf('=');
      out.push({
        key: eq === -1 ? s : s.slice(0, eq),
        value: eq === -1 ? undefined : s.slice(eq + 1),
        range: nodeRange(it),
      });
    }
  }
  return out;
}

export const DC006 = composeRule({
  id: 'DC006',
  name: 'compose-secret-in-environment',
  severity: 'error',
  category: 'security',
  summary: 'Secret written literally in environment:',
  explanation:
    'An environment entry has a secret-looking name with a literal value (warning), or a value that matches a known credential format or looks like a random token (error). Values taken from the shell or an env_file (${VAR}) are fine.',
  why: "The compose file is committed to git, so the secret is too. Use ${VAR} interpolation from an untracked .env, Docker secrets (secrets: + *_FILE variables), or your platform's secret store.",
  before: 'services:\n  db:\n    environment:\n      POSTGRES_PASSWORD: s3cr3t-prod-pass',
  after:
    'services:\n  db:\n    environment:\n      POSTGRES_PASSWORD_FILE: /run/secrets/db_password\n    secrets: [db_password]',
  check(ctx) {
    for (const svc of servicesOf(ctx)) {
      for (const e of envEntries(svc)) {
        const v = e.value;
        if (v === undefined || v === '') continue;
        const hit = findSecretPatterns(v)[0];
        if (hit) {
          ctx.report({
            message: `${e.key} looks like ${/^[AEIOU]/.test(hit.kind) ? 'an' : 'a'} ${hit.kind}.`,
            at: e.range,
            severity: 'error',
          });
        } else if (isSecretName(e.key) && !isNonLiteral(v)) {
          ctx.report({
            message: `${e.key} in "${svc.name}" is a literal secret committed with the compose file. Use \${VAR} interpolation or Docker secrets.`,
            at: e.range,
            severity: 'warn',
          });
        } else if (looksHighEntropy(v)) {
          ctx.report({
            message: `${e.key} holds a long high-entropy value that looks like a generated secret.`,
            at: e.range,
            severity: 'warn',
          });
        }
      }
    }
  },
});

export const DC007 = composeRule({
  id: 'DC007',
  name: 'compose-no-restart',
  severity: 'info',
  category: 'correctness',
  summary: 'Service has no restart policy',
  explanation:
    'No restart: (or deploy.restart_policy) is set. Services in a profile and services named like one-shot jobs (migrate, init, seed, setup) are skipped.',
  why: 'After a crash or a host reboot the service stays down until someone notices. `restart: unless-stopped` is the usual choice for long-running services.',
  before: 'services:\n  web:\n    image: nginx:1.27',
  after: 'services:\n  web:\n    image: nginx:1.27\n    restart: unless-stopped',
  check(ctx) {
    for (const svc of servicesOf(ctx)) {
      if (hasKey(svc, 'restart') || hasKey(svc, 'profiles')) continue;
      if (/migrat|init|seed|setup|once|job/i.test(svc.name)) continue;
      const dep = (svc.value.deploy ?? {}) as Record<string, unknown>;
      if (dep.restart_policy) continue;
      ctx.report({
        message: `Service "${svc.name}" has no restart policy.`,
        at: nodeRange(svc.keyNode),
      });
    }
  },
});

export const DC008 = composeRule({
  id: 'DC008',
  name: 'compose-no-healthcheck',
  severity: 'info',
  category: 'correctness',
  summary: 'Service has no healthcheck',
  explanation:
    'The service defines no healthcheck (and the image may not either). Services in a profile and one-shot jobs are skipped.',
  why: 'Without a healthcheck, `depends_on: condition: service_healthy` is unavailable and `docker ps` reports a hung process as "Up".',
  before: 'services:\n  api:\n    image: myorg/api:1.4.2',
  after:
    'services:\n  api:\n    image: myorg/api:1.4.2\n    healthcheck:\n      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/health"]\n      interval: 30s',
  check(ctx) {
    for (const svc of servicesOf(ctx)) {
      if (hasKey(svc, 'healthcheck') || hasKey(svc, 'profiles')) continue;
      if (/migrat|init|seed|setup|once|job/i.test(svc.name)) continue;
      ctx.report({
        message: `Service "${svc.name}" has no healthcheck.`,
        at: nodeRange(svc.keyNode),
      });
    }
  },
});

export const DC009 = composeRule({
  id: 'DC009',
  name: 'compose-no-resource-limits',
  severity: 'info',
  category: 'reproducibility',
  summary: 'No CPU or memory limits',
  explanation: 'The service sets no deploy.resources.limits, mem_limit or cpus.',
  why: 'One leaking container can take the whole host down, including its neighbours. Even a generous limit turns an outage into one restarted container.',
  before: 'services:\n  api:\n    image: myorg/api:1.4.2',
  after:
    'services:\n  api:\n    image: myorg/api:1.4.2\n    deploy:\n      resources:\n        limits: { cpus: "1.0", memory: 512M }',
  check(ctx) {
    for (const svc of servicesOf(ctx)) {
      if (hasKey(svc, 'mem_limit') || hasKey(svc, 'cpus') || hasKey(svc, 'profiles')) continue;
      const limits = (svc.value.deploy as { resources?: { limits?: unknown } } | undefined)
        ?.resources?.limits;
      if (limits) continue;
      ctx.report({
        message: `Service "${svc.name}" has no CPU or memory limit.`,
        at: nodeRange(svc.keyNode),
      });
    }
  },
});

export const DC010 = composeRule({
  id: 'DC010',
  name: 'compose-depends-on-no-condition',
  severity: 'info',
  category: 'correctness',
  summary: 'depends_on waits for start, not for health',
  explanation:
    'A service depends on another service that has a healthcheck, but depends_on does not use condition: service_healthy.',
  why: '"Started" is not "ready": the database container is up several seconds before it accepts connections, so the app crashes on boot and relies on restarts to recover. A healthcheck already exists; use it.',
  before:
    'services:\n  db:\n    healthcheck: { test: ["CMD", "pg_isready"] }\n  api:\n    depends_on: [db]',
  after: 'services:\n  api:\n    depends_on:\n      db:\n        condition: service_healthy',
  check(ctx) {
    const services = servicesOf(ctx);
    const withHealth = new Set(
      services
        .filter(
          (s) =>
            hasKey(s, 'healthcheck') &&
            (s.value.healthcheck as { disable?: boolean })?.disable !== true,
        )
        .map((s) => s.name),
    );
    for (const svc of services) {
      const pair = findPair(svc.map, 'depends_on');
      if (!pair) continue;
      if (isSeq(pair.value)) {
        for (const item of pair.value.items) {
          const name = scalarString(item);
          if (name && withHealth.has(name)) {
            ctx.report({
              message: `"${svc.name}" depends on "${name}", which has a healthcheck, but only waits for it to start. Use condition: service_healthy.`,
              at: nodeRange(item),
            });
          }
        }
      } else if (isMap(pair.value)) {
        for (const it of pair.value.items) {
          if (!isPair(it) || !isScalar(it.key)) continue;
          const name = String(it.key.value);
          const cond = isMap(it.value)
            ? scalarString(findPair(it.value, 'condition')?.value)
            : undefined;
          if (withHealth.has(name) && cond !== 'service_healthy') {
            ctx.report({
              message: `"${svc.name}" depends on "${name}", which has a healthcheck, but uses condition ${cond ?? '(none)'}. Use service_healthy.`,
              at: pairRange(it as Pair),
            });
          }
        }
      }
    }
  },
});

const DANGEROUS_CAPS = new Set([
  'ALL',
  'SYS_ADMIN',
  'SYS_MODULE',
  'SYS_PTRACE',
  'SYS_RAWIO',
  'DAC_READ_SEARCH',
]);

export const DC011 = composeRule({
  id: 'DC011',
  name: 'compose-dangerous-capabilities',
  severity: 'warn',
  category: 'security',
  summary: 'Dangerous capabilities or security profiles disabled',
  explanation:
    'cap_add contains ALL, SYS_ADMIN, SYS_MODULE, SYS_PTRACE, SYS_RAWIO or DAC_READ_SEARCH, or security_opt switches off seccomp/AppArmor/SELinux labelling.',
  why: 'These are the building blocks of container escapes. SYS_ADMIN alone is close to being privileged. Add only the narrow capability you can name a reason for.',
  before: 'services:\n  app:\n    cap_add: [SYS_ADMIN]\n    security_opt: ["seccomp=unconfined"]',
  after: 'services:\n  app:\n    cap_add: [NET_BIND_SERVICE]',
  check(ctx) {
    for (const svc of servicesOf(ctx)) {
      const caps = findPair(svc.map, 'cap_add')?.value;
      if (isSeq(caps)) {
        for (const item of caps.items) {
          const c = scalarString(item)?.toUpperCase().replace(/^CAP_/, '');
          if (c && DANGEROUS_CAPS.has(c))
            ctx.report({ message: `"${svc.name}" adds capability ${c}.`, at: nodeRange(item) });
        }
      }
      const opts = findPair(svc.map, 'security_opt')?.value;
      if (isSeq(opts)) {
        for (const item of opts.items) {
          const o = scalarString(item) ?? '';
          if (
            /(?:seccomp|apparmor)[=:]unconfined|label[=:]disable|no-new-privileges[=:]false/i.test(
              o,
            )
          ) {
            ctx.report({
              message: `"${svc.name}" sets security_opt ${o}, which turns off a container protection.`,
              at: nodeRange(item),
            });
          }
        }
      }
    }
  },
});

export const DC012 = composeRule({
  id: 'DC012',
  name: 'compose-host-namespaces',
  severity: 'warn',
  category: 'security',
  summary: 'Container shares a host namespace (pid / ipc / uts / userns)',
  explanation: 'pid: host, ipc: host, uts: host or userns_mode: host is set.',
  why: 'The container can see and signal every process on the host (pid), or read shared memory of other workloads (ipc). Isolation is the point of a container.',
  before: 'services:\n  agent:\n    pid: host',
  after: 'services:\n  agent:\n    # remove pid: host, or isolate the agent on a dedicated host',
  check(ctx) {
    for (const svc of servicesOf(ctx)) {
      for (const key of ['pid', 'ipc', 'uts', 'userns_mode']) {
        const pair = findPair(svc.map, key);
        if (pair && svc.value[key] === 'host') {
          ctx.report({
            message: `"${svc.name}" sets ${key}: host and shares that namespace with the host.`,
            at: pairRange(pair),
          });
        }
      }
    }
  },
});

export const DC013 = composeRule({
  id: 'DC013',
  name: 'compose-root-user',
  severity: 'warn',
  category: 'security',
  summary: 'Service forced to run as root',
  explanation: 'user: root, user: "0" or user: "0:0" overrides the image\'s own USER.',
  why: 'It undoes whatever non-root user the image went to the trouble of setting up. Prefer a numeric non-root uid and fix file ownership instead.',
  before: 'services:\n  app:\n    user: root',
  after: 'services:\n  app:\n    user: "10001:10001"',
  check(ctx) {
    for (const svc of servicesOf(ctx)) {
      const pair = findPair(svc.map, 'user');
      const u = String(svc.value.user ?? '').split(':')[0];
      if (pair && (u === 'root' || u === '0')) {
        ctx.report({
          message: `"${svc.name}" runs as root (user: ${String(svc.value.user)}).`,
          at: pairRange(pair),
        });
      }
    }
  },
});

export const DC014 = composeRule({
  id: 'DC014',
  name: 'compose-obsolete-version',
  severity: 'info',
  category: 'maintainability',
  summary: 'Top-level `version:` is obsolete',
  explanation:
    'The Compose Specification ignores the top-level version field, and Compose v2 prints a warning for it.',
  why: 'It suggests a schema version that no longer exists and can mislead readers about which features are available. --fix removes the line.',
  before: 'version: "3.8"\nservices: {}',
  after: 'services: {}',
  fixable: true,
  check(ctx) {
    const pair = findPair(ctx.doc.contents as YAMLMap | null, 'version');
    if (!pair) return;
    const r = pairRange(pair);
    // Remove the whole line when the pair is alone on it.
    const text = ctx.text;
    const lineStart = text.lastIndexOf('\n', r.start - 1) + 1;
    let lineEnd = text.indexOf('\n', r.end);
    if (lineEnd === -1) lineEnd = text.length;
    const before = text.slice(lineStart, r.start).trim();
    const after = text.slice(r.end, lineEnd).trim();
    const alone = before === '' && (after === '' || after.startsWith('#'));
    ctx.report({
      message: 'The top-level `version` key is obsolete and ignored by Compose.',
      at: r,
      fix: alone
        ? fix(
            'Remove the version line',
            replaceRange({ start: lineStart, end: Math.min(lineEnd + 1, text.length) }, ''),
          )
        : undefined,
    });
  },
});

export const DC015 = composeRule({
  id: 'DC015',
  name: 'compose-container-name',
  severity: 'info',
  category: 'maintainability',
  summary: 'Fixed container_name prevents scaling and clashes between projects',
  explanation: 'container_name pins a global name for the container.',
  why: 'Two projects (or two copies of the same project) cannot run side by side, and `docker compose up --scale` fails. Compose already gives containers stable, project-scoped names.',
  before: 'services:\n  web:\n    container_name: web',
  after: 'services:\n  web:\n    image: nginx:1.27',
  check(ctx) {
    for (const svc of servicesOf(ctx)) {
      const pair = findPair(svc.map, 'container_name');
      if (pair)
        ctx.report({
          message: `"${svc.name}" sets container_name, which blocks scaling and parallel projects.`,
          at: pairRange(pair),
        });
    }
  },
});

export const COMPOSE_RULES: ComposeRule[] = [
  DC000,
  DC001,
  DC002,
  DC003,
  DC004,
  DC005,
  DC006,
  DC007,
  DC008,
  DC009,
  DC010,
  DC011,
  DC012,
  DC013,
  DC014,
  DC015,
];
