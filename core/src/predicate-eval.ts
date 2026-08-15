/**
 * Predicate DSL evaluator + `$ctx.*` parameter interpolation
 * (docs/aibar-architecture.md §9.1). No user code executes; evaluation is
 * O(operators).
 */
import type { Predicate, PredicateOperand } from '@aibar/protocol';
import { resolveContextPath, type AIBarContext } from './context';

function operandValue(ctx: AIBarContext, operand: PredicateOperand): unknown {
  if (typeof operand === 'string' && operand.startsWith('ctx.')) {
    return resolveContextPath(ctx, operand);
  }
  return operand;
}

export function evaluatePredicate(ctx: AIBarContext, predicate: Predicate): boolean {
  if ('all' in predicate) return predicate.all.every((p) => evaluatePredicate(ctx, p));
  if ('any' in predicate) return predicate.any.some((p) => evaluatePredicate(ctx, p));
  if ('not' in predicate) return !evaluatePredicate(ctx, predicate.not);
  if ('exists' in predicate) return resolveContextPath(ctx, predicate.exists) !== undefined;
  if ('in' in predicate) {
    const [operand, list] = predicate.in;
    return list.includes(operandValue(ctx, operand) as never);
  }
  const [op, pair] = Object.entries(predicate)[0] as [string, [PredicateOperand, PredicateOperand]];
  const a = operandValue(ctx, pair[0]);
  const b = operandValue(ctx, pair[1]);
  switch (op) {
    case 'eq': return a === b;
    case 'ne': return a !== b;
    case 'gt': return typeof a === 'number' && typeof b === 'number' && a > b;
    case 'gte': return typeof a === 'number' && typeof b === 'number' && a >= b;
    case 'lt': return typeof a === 'number' && typeof b === 'number' && a < b;
    case 'lte': return typeof a === 'number' && typeof b === 'number' && a <= b;
    default: return false;
  }
}

/** Interpolate `$ctx.*` string values inside action params at invoke time. */
export function interpolateParams(
  ctx: AIBarContext,
  params: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!params) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' && value.startsWith('$ctx.')) {
      out[key] = resolveContextPath(ctx, value);
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      out[key] = interpolateParams(ctx, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}
