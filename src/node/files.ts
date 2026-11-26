import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { type Config, EMPTY_CONFIG, parseConfig } from '../core/config.js';
import type { DockerignoreInfo } from '../core/rule.js';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '_site',
  'vendor',
  '.venv',
  '__pycache__',
  'coverage',
]);

export function isDockerfileName(base: string): boolean {
  if (/\.dockerignore$/i.test(base)) return false;
  return /^dockerfile(?:\..+)?$/i.test(base) || /\.dockerfile$/i.test(base);
}

export function isComposeName(base: string): boolean {
  return /^(?:docker-)?compose(?:\..+)?\.ya?ml$/i.test(base);
}

export function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

export function discover(paths: string[], cwd: string): { files: string[]; missing: string[] } {
  const files = new Set<string>();
  const missing: string[] = [];
  const walk = (dir: string) => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full);
      } else if (e.isFile() && (isDockerfileName(e.name) || isComposeName(e.name))) {
        files.add(full);
      }
    }
  };
  for (const p of paths) {
    const abs = resolve(cwd, p);
    if (!existsSync(abs)) {
      missing.push(p);
      continue;
    }
    if (statSync(abs).isDirectory()) walk(abs);
    else files.add(abs);
  }
  return { files: [...files], missing };
}

export function dockerignoreFor(file: string): DockerignoreInfo {
  const candidates = [`${file}.dockerignore`, join(dirname(file), '.dockerignore')];
  for (const c of candidates) {
    if (existsSync(c)) {
      const lines = readFileSync(c, 'utf8')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'));
      return { exists: true, lines };
    }
  }
  return { exists: false, lines: [] };
}

export interface LoadedConfig {
  config: Config;
  /** Directory the config's globs are relative to. */
  dir: string;
  path?: string;
  errors: string[];
}

const CONFIG_NAMES = ['.dockerdoctor.yml', '.dockerdoctor.yaml'];

export function findConfigFile(startDir: string): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    for (const n of CONFIG_NAMES) {
      const p = join(dir, n);
      if (existsSync(p)) return p;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function loadConfig(cwd: string, explicit?: string, disabled = false): LoadedConfig {
  if (disabled) return { config: EMPTY_CONFIG, dir: cwd, errors: [] };
  const path = explicit ? resolve(cwd, explicit) : findConfigFile(cwd);
  if (!path) return { config: EMPTY_CONFIG, dir: cwd, errors: [] };
  if (!existsSync(path))
    return { config: EMPTY_CONFIG, dir: cwd, path, errors: [`config file not found: ${explicit}`] };
  const { config, errors } = parseConfig(readFileSync(path, 'utf8'));
  return {
    config,
    dir: dirname(path),
    path,
    errors: errors.map((e) => `${relative(cwd, path) || path}: ${e}`),
  };
}
