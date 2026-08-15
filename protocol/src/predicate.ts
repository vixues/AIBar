/**
 * Closed predicate DSL for declarative Item Specs
 * (docs/aibar-architecture.md §9.1).
 *
 * Operator closure: eq/ne/gt/gte/lt/lte/in/exists/all/any/not. Operands are
 * literals or `ctx.*` paths. No functions, no evaluation escape — evaluation
 * is O(operators) and lives in @aibar/core.
 */

export type PredicateLiteral = string | number | boolean | null;

/** A `ctx.*` path (resolved against the AIBarContext snapshot) or a literal. */
export type PredicateOperand = PredicateLiteral;

export type ComparisonPredicate =
  | { eq: [PredicateOperand, PredicateOperand] }
  | { ne: [PredicateOperand, PredicateOperand] }
  | { gt: [PredicateOperand, PredicateOperand] }
  | { gte: [PredicateOperand, PredicateOperand] }
  | { lt: [PredicateOperand, PredicateOperand] }
  | { lte: [PredicateOperand, PredicateOperand] }
  | { in: [PredicateOperand, readonly PredicateLiteral[]] }
  | { exists: string };

export type Predicate =
  | ComparisonPredicate
  | { all: readonly Predicate[] }
  | { any: readonly Predicate[] }
  | { not: Predicate };

const COMPARISON_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const;

/** Structural validation of a predicate value; returns an error string or null. */
export function validatePredicate(value: unknown, depth = 0): string | null {
  if (depth > 8) return 'predicate nesting exceeds depth 8';
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'predicate must be an object';
  }
  const keys = Object.keys(value);
  const op = keys[0];
  if (keys.length !== 1 || op === undefined) {
    return `predicate must have exactly one operator, got [${keys.join(', ')}]`;
  }
  const operand = (value as Record<string, unknown>)[op];

  if (op === 'all' || op === 'any') {
    if (!Array.isArray(operand) || operand.length === 0) return `'${op}' requires a non-empty array`;
    for (const child of operand) {
      const err = validatePredicate(child, depth + 1);
      if (err) return err;
    }
    return null;
  }
  if (op === 'not') return validatePredicate(operand, depth + 1);
  if (op === 'exists') {
    return typeof operand === 'string' && operand.startsWith('ctx.')
      ? null
      : `'exists' requires a ctx.* path string`;
  }
  if (op === 'in') {
    if (!Array.isArray(operand) || operand.length !== 2) return `'in' requires [operand, array]`;
    if (!isLiteral(operand[0])) return `'in' left operand must be a literal or ctx.* path`;
    if (!Array.isArray(operand[1])) return `'in' right operand must be an array`;
    return null;
  }
  if ((COMPARISON_OPS as readonly string[]).includes(op)) {
    if (!Array.isArray(operand) || operand.length !== 2) return `'${op}' requires a 2-tuple`;
    if (!isLiteral(operand[0]) || !isLiteral(operand[1])) return `'${op}' operands must be literals or ctx.* paths`;
    return null;
  }
  return `unknown predicate operator '${op}'`;
}

function isLiteral(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}
