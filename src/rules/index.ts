import type { Rule } from '../core/rule.js';
import { COMPOSE_RULES } from './compose/index.js';
import { DOCKERFILE_RULES } from './dockerfile/index.js';

export const ALL_RULES: Rule[] = [...DOCKERFILE_RULES, ...COMPOSE_RULES];

const byId = new Map(ALL_RULES.map((r) => [r.id, r]));

export function getRule(id: string): Rule | undefined {
  return byId.get(id.toUpperCase());
}

export function isRuleId(id: string): boolean {
  return byId.has(id.toUpperCase());
}
