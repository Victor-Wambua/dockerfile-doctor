import { parse } from 'yaml';
import { isRuleId } from '../rules/index.js';
import { matchesGlob } from './glob.js';
import type { Severity } from './types.js';

export type RuleSetting = Severity | 'off';

export interface PathIgnore {
  path: string;
  /** Rule ids, or ["all"]. */
  rules: string[];
}

export interface Config {
  /** Severity override or "off" per rule id. */
  rules: Record<string, RuleSetting>;
  /** Per-path ignores: findings for these rules are dropped in matching files. */
  ignore: PathIgnore[];
  /** Files skipped entirely when scanning. */
  exclude: string[];
  failOn?: Severity | 'never';
}

export const EMPTY_CONFIG: Config = { rules: {}, ignore: [], exclude: [] };

export interface ConfigResult {
  config: Config;
  errors: string[];
}

function normSeverity(v: unknown): RuleSetting | undefined {
  if (v === false) return 'off';
  if (typeof v !== 'string') return undefined;
  const s = v.toLowerCase();
  if (s === 'off' || s === 'none' || s === 'disable' || s === 'disabled') return 'off';
  if (s === 'error') return 'error';
  if (s === 'warn' || s === 'warning') return 'warn';
  if (s === 'info' || s === 'note') return 'info';
  return undefined;
}

function strList(v: unknown): string[] | undefined {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v as string[];
  return undefined;
}

/** Parses `.dockerdoctor.yml`. Never throws: problems are returned as `errors`. */
export function parseConfig(text: string): ConfigResult {
  const errors: string[] = [];
  const config: Config = { rules: {}, ignore: [], exclude: [] };
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    return { config, errors: [`invalid YAML: ${(e as Error).message.split('\n')[0]}`] };
  }
  if (raw === null || raw === undefined) return { config, errors };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { config, errors: ['the config must be a mapping at the top level'] };
  }
  const obj = raw as Record<string, unknown>;
  const known = ['rules', 'disable', 'ignore', 'exclude', 'failOn', 'fail-on'];
  for (const k of Object.keys(obj)) if (!known.includes(k)) errors.push(`unknown key "${k}"`);

  const checkId = (id: string, where: string): string | undefined => {
    const up = id.toUpperCase();
    if (up === 'ALL') return 'all';
    if (!isRuleId(up)) {
      errors.push(`${where}: unknown rule "${id}"`);
      return undefined;
    }
    return up;
  };

  if (obj.rules !== undefined) {
    if (typeof obj.rules !== 'object' || obj.rules === null || Array.isArray(obj.rules)) {
      errors.push('"rules" must be a mapping of rule id to off|error|warn|info');
    } else {
      for (const [id, val] of Object.entries(obj.rules)) {
        const key = checkId(id, 'rules');
        const sev = normSeverity(val);
        if (!key || key === 'all') {
          if (key === 'all') errors.push('rules: "all" is not allowed here; list rule ids');
          continue;
        }
        if (!sev) errors.push(`rules.${id}: expected off, error, warn or info`);
        else config.rules[key] = sev;
      }
    }
  }
  if (obj.disable !== undefined) {
    const list = strList(obj.disable);
    if (!list) errors.push('"disable" must be a list of rule ids');
    else
      for (const id of list) {
        const key = checkId(id, 'disable');
        if (key && key !== 'all') config.rules[key] = 'off';
      }
  }
  if (obj.exclude !== undefined) {
    const list = strList(obj.exclude);
    if (!list) errors.push('"exclude" must be a list of globs');
    else config.exclude = list;
  }
  if (obj.ignore !== undefined) {
    if (!Array.isArray(obj.ignore))
      errors.push('"ignore" must be a list of { path, rules } entries');
    else {
      obj.ignore.forEach((entry, i) => {
        const e = entry as Record<string, unknown> | null;
        if (!e || typeof e !== 'object' || typeof e.path !== 'string') {
          errors.push(`ignore[${i}]: each entry needs a "path" glob`);
          return;
        }
        const rules = e.rules === undefined ? ['all'] : strList(e.rules);
        if (!rules) {
          errors.push(`ignore[${i}]: "rules" must be a list of rule ids or ["all"]`);
          return;
        }
        const ids = rules.map((r) => checkId(r, `ignore[${i}]`)).filter((x): x is string => !!x);
        config.ignore.push({ path: e.path, rules: ids });
      });
    }
  }
  const fo = obj.failOn ?? obj['fail-on'];
  if (fo !== undefined) {
    const s = typeof fo === 'string' ? fo.toLowerCase() : '';
    if (s === 'never') config.failOn = 'never';
    else if (s === 'warning' || s === 'warn') config.failOn = 'warn';
    else if (s === 'error' || s === 'info') config.failOn = s;
    else errors.push('"failOn" must be error, warn, info or never');
  }
  return { config, errors };
}

/** Is this rule silenced for this file by a per-path ignore? */
export function isPathIgnored(config: Config, file: string, ruleId: string): boolean {
  return config.ignore.some(
    (ig) => matchesGlob(file, ig.path) && (ig.rules.includes('all') || ig.rules.includes(ruleId)),
  );
}

export function isExcluded(config: Config, file: string): boolean {
  return config.exclude.some((g) => matchesGlob(file, g));
}

/**
 * Combine settings; later layers win. The usual call is
 * `mergeSettings(config.rules, cliOverrides)` so command-line flags beat the config file,
 * which beats rule defaults.
 */
export function mergeSettings(
  ...layers: Array<Record<string, RuleSetting> | undefined>
): Record<string, RuleSetting> {
  const out: Record<string, RuleSetting> = {};
  for (const l of layers) if (l) Object.assign(out, l);
  return out;
}
