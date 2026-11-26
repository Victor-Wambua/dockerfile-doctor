import {
  isMap,
  isPair,
  isScalar,
  isSeq,
  type Node,
  type Pair,
  type Scalar,
  type YAMLMap,
} from 'yaml';
import type { ComposeContext } from '../../core/rule.js';
import type { Range } from '../../core/types.js';

export interface Service {
  name: string;
  keyNode: Scalar;
  map: YAMLMap;
  /** Plain JS value of the service definition. */
  value: Record<string, unknown>;
}

export function nodeRange(node: unknown): Range {
  const r = (node as { range?: [number, number, number] | null } | null | undefined)?.range;
  return r ? { start: r[0], end: r[1] } : { start: 0, end: 0 };
}

export function pairRange(pair: Pair): Range {
  const k = nodeRange(pair.key);
  const v = pair.value ? nodeRange(pair.value) : k;
  return { start: k.start, end: Math.max(k.end, v.end) };
}

export function findPair(map: YAMLMap | null | undefined, key: string): Pair | undefined {
  if (!map || !isMap(map)) return undefined;
  for (const item of map.items) {
    if (isPair(item) && isScalar(item.key) && String(item.key.value) === key) return item;
  }
  return undefined;
}

export function servicesOf(ctx: ComposeContext): Service[] {
  const out: Service[] = [];
  const services = findPair(ctx.doc.contents as YAMLMap | null, 'services')?.value;
  if (!isMap(services)) return out;
  for (const item of services.items) {
    if (!isPair(item) || !isScalar(item.key) || !isMap(item.value)) continue;
    const value = item.value.toJS(ctx.doc) as Record<string, unknown>;
    out.push({ name: String(item.key.value), keyNode: item.key as Scalar, map: item.value, value });
  }
  return out;
}

export function seqItems(node: unknown): Node[] {
  return isSeq(node) ? (node.items as Node[]) : [];
}

export function scalarString(node: unknown): string | undefined {
  return isScalar(node) && node.value !== null && node.value !== undefined
    ? String(node.value)
    : undefined;
}

export function hasKey(service: Service, key: string): boolean {
  return Object.hasOwn(service.value, key);
}
