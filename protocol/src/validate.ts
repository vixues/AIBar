/**
 * Item Spec v2 validation (docs/aibar-architecture.md §9.1).
 *
 * Hand-rolled, dependency-free validators. Validation failure rejects the
 * whole spec with an error message — never partial acceptance.
 */
import { isItemIdentifier } from './identifiers';
import {
  AIBAR_ITEM_TYPES,
  DEFAULT_QUOTAS,
  IN_PROCESS_ONLY_TYPES,
  type AIBarItemSpec,
  type AIBarItemType,
  type PublisherQuotas,
} from './item-spec';
import { validatePredicate } from './predicate';

export interface SpecValidationResult {
  ok: boolean;
  errors: string[];
}

const EFFECTS = ['read', 'write', 'destructive'] as const;
const SCOPE_KINDS = ['global', 'route', 'session', 'run'] as const;
const CONTAINER_TYPES: readonly AIBarItemType[] = ['group', 'popover'];

function err(errors: string[], path: string, message: string): void {
  errors.push(`${path}: ${message}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate one declarative Item Spec. `path` prefixes error messages so
 * nested children report a usable location.
 */
export function validateItemSpec(
  value: unknown,
  opts: { quotas?: PublisherQuotas; path?: string; depth?: number } = {},
): SpecValidationResult {
  const errors: string[] = [];
  const quotas = opts.quotas ?? DEFAULT_QUOTAS;
  const path = opts.path ?? 'spec';
  const depth = opts.depth ?? 0;

  if (!isRecord(value)) {
    return { ok: false, errors: [`${path}: spec must be an object`] };
  }

  const spec = value as Partial<AIBarItemSpec>;

  if (depth === 0) {
    const bytes = JSON.stringify(value).length;
    if (bytes > quotas.maxSpecBytes) {
      err(errors, path, `spec size ${bytes}B exceeds quota ${quotas.maxSpecBytes}B`);
    }
    if (spec.version !== undefined && spec.version !== 'aibar/2') {
      err(errors, path, `unsupported version '${spec.version}' (expected 'aibar/2')`);
    }
  }

  if (typeof spec.id !== 'string' || !isItemIdentifier(spec.id)) {
    err(errors, path, `id '${String(spec.id)}' is not a valid reverse-URI aibar identifier`);
  }
  if (!spec.type || !AIBAR_ITEM_TYPES.includes(spec.type)) {
    err(errors, path, `unknown item type '${String(spec.type)}'`);
  } else if (IN_PROCESS_ONLY_TYPES.includes(spec.type)) {
    err(
      errors,
      path,
      `type '${spec.type}' is in-process only — its payload is code, not data (INV-A3)`,
    );
  }
  if (typeof spec.labelKey !== 'string' || spec.labelKey.length === 0) {
    err(errors, path, 'labelKey is required (INV: accessibility/tooltip)');
  }
  if (typeof spec.parity !== 'string' || spec.parity.length === 0) {
    err(errors, path, 'parity is required (INV-A1: no exclusive functionality)');
  }
  if (spec.effect !== undefined && !EFFECTS.includes(spec.effect)) {
    err(errors, path, `invalid effect '${String(spec.effect)}'`);
  }
  if (spec.width !== undefined) {
    if (!isRecord(spec.width)) err(errors, path, 'width must be an object');
    else {
      for (const k of ['min', 'preferred', 'max', 'flex'] as const) {
        const v = spec.width[k];
        if (v !== undefined && (typeof v !== 'number' || v < 0)) {
          err(errors, path, `width.${k} must be a non-negative number`);
        }
      }
    }
  }
  for (const key of ['visible', 'enabled'] as const) {
    if (spec[key] !== undefined) {
      const perr = validatePredicate(spec[key]);
      if (perr) err(errors, path, `${key} predicate invalid: ${perr}`);
    }
  }
  if (spec.action !== undefined) {
    if (!isRecord(spec.action) || typeof spec.action.name !== 'string' || !spec.action.name) {
      err(errors, path, 'action must be { name, params? }');
    } else if (spec.action.params !== undefined && !isRecord(spec.action.params)) {
      err(errors, path, 'action.params must be an object');
    }
  }
  if (spec.scope !== undefined) {
    if (!isRecord(spec.scope) || !SCOPE_KINDS.includes(spec.scope.kind as never)) {
      err(errors, path, 'scope.kind must be global|route|session|run');
    }
  }
  if (spec.ttlMs !== undefined && (typeof spec.ttlMs !== 'number' || spec.ttlMs <= 0)) {
    err(errors, path, 'ttlMs must be a positive number');
  }

  // ——— type-specific rules ———
  if (spec.type === 'segmented') {
    if (!Array.isArray(spec.segments) || spec.segments.length < 2 || spec.segments.length > 6) {
      err(errors, path, 'segmented requires 2–6 segments');
    } else {
      for (const seg of spec.segments) {
        if (!isRecord(seg) || typeof seg.key !== 'string' || typeof seg.labelKey !== 'string') {
          err(errors, path, 'each segment requires key + labelKey');
        }
      }
    }
  }
  if (spec.type === 'suggestion') {
    if (typeof spec.confidence !== 'number' || spec.confidence < 0 || spec.confidence > 1) {
      err(errors, path, 'suggestion requires confidence in [0, 1]');
    }
    if (!isRecord(spec.reason) || typeof spec.reason.code !== 'string') {
      err(errors, path, 'suggestion requires reason.code (explainability, §6.2)');
    }
    if (!spec.action) err(errors, path, 'suggestion requires an action');
  }
  if (spec.type === 'approval') {
    if (!isRecord(spec.intent) || typeof spec.intent.summaryKey !== 'string') {
      err(errors, path, 'approval requires intent.summaryKey');
    }
    if (spec.effect === undefined) {
      err(errors, path, 'approval requires an explicit effect (INV-A8)');
    }
  }
  if (spec.progress !== undefined && (typeof spec.progress !== 'number' || spec.progress < 0 || spec.progress > 1)) {
    err(errors, path, 'progress must be in [0, 1]');
  }
  if (spec.type === 'slider') {
    const s = spec.slider;
    if (
      !isRecord(s) ||
      typeof s.min !== 'number' ||
      typeof s.max !== 'number' ||
      typeof s.value !== 'number'
    ) {
      err(errors, path, 'slider requires slider: { min, max, value, step? }');
    } else if (s.min >= s.max) {
      err(errors, path, 'slider.min must be < slider.max');
    } else if (s.value < s.min || s.value > s.max) {
      err(errors, path, 'slider.value must lie within [min, max]');
    }
  }
  if (spec.type === 'colorPicker') {
    if (!Array.isArray(spec.swatches) || spec.swatches.length === 0 || spec.swatches.length > 16) {
      err(errors, path, 'colorPicker requires 1–16 swatches');
    } else if (spec.swatches.some((c) => typeof c !== 'string' || c.length > 32)) {
      err(errors, path, 'each swatch must be a short color string');
    }
  }
  if (spec.type === 'candidateList') {
    if (!Array.isArray(spec.candidates) || spec.candidates.length === 0 || spec.candidates.length > 12) {
      err(errors, path, 'candidateList requires 1–12 candidates');
    } else if (spec.candidates.some((c) => typeof c !== 'string')) {
      err(errors, path, 'each candidate must be a string');
    }
  }
  if (spec.type === 'characterPicker' && spec.characters !== undefined) {
    if (!Array.isArray(spec.characters) || spec.characters.some((c) => typeof c !== 'string')) {
      err(errors, path, 'characters must be an array of strings');
    }
  }

  // ——— children (group / popover sub-surfaces) ———
  if (spec.children !== undefined) {
    if (!spec.type || !CONTAINER_TYPES.includes(spec.type)) {
      err(errors, path, `type '${String(spec.type)}' does not accept children`);
    }
    if (depth >= 2) {
      err(errors, path, 'children nesting exceeds depth 2 (popovers never nest popovers)');
    } else if (!Array.isArray(spec.children) || spec.children.length === 0) {
      err(errors, path, 'children must be a non-empty array');
    } else {
      spec.children.forEach((child, i) => {
        if (isRecord(child) && child.type === 'popover' && spec.type === 'popover') {
          err(errors, `${path}.children[${i}]`, 'popovers never nest popovers');
        }
        const res = validateItemSpec(child, { quotas, path: `${path}.children[${i}]`, depth: depth + 1 });
        errors.push(...res.errors);
      });
    }
  } else if (spec.type && CONTAINER_TYPES.includes(spec.type) && spec.type === 'group') {
    err(errors, path, 'group requires children');
  }

  return { ok: errors.length === 0, errors };
}

/** Validate a publish batch against per-publisher quotas. */
export function validatePublishBatch(
  items: unknown,
  opts: { quotas?: PublisherQuotas; existingCount?: number } = {},
): SpecValidationResult {
  const quotas = opts.quotas ?? DEFAULT_QUOTAS;
  if (!Array.isArray(items)) return { ok: false, errors: ['publish.items must be an array'] };
  const errors: string[] = [];
  if ((opts.existingCount ?? 0) + items.length > quotas.maxItems) {
    errors.push(`publisher item quota exceeded (max ${quotas.maxItems})`);
  }
  items.forEach((item, i) => {
    errors.push(...validateItemSpec(item, { quotas, path: `items[${i}]` }).errors);
  });
  return { ok: errors.length === 0, errors };
}
