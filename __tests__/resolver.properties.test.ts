/**
 * Resolver correctness invariants P1–P5 (docs/aibar-architecture.md §6.4),
 * property-tested with fast-check.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { asItemIdentifier } from '@aibar/protocol';
import {
  EMPTY_CONTEXT,
  EMPTY_STABILITY,
  defineItem,
  resolve,
  widthOf,
  type AIBarItem,
  type ResolveInput,
  type ResolvedPlan,
} from '@aibar/core';

const itemArb = fc
  .record({
    key: fc.integer({ min: 0, max: 200 }),
    type: fc.constantFrom('button', 'toggle', 'label', 'mainButton' as const),
    priority: fc.constantFrom(-1000, 0, 1000),
    visible: fc.boolean(),
    showsLabel: fc.boolean(),
    labelLen: fc.integer({ min: 2, max: 30 }),
    zone: fc.constantFrom('contextual', 'system' as const),
  })
  .map(({ key, type, priority, visible, showsLabel, labelLen, zone }) =>
    defineItem({
      id: asItemIdentifier(`test.aibar.${type.toLowerCase()}.k${key}`),
      type,
      labelKey: 'x'.repeat(labelLen),
      icon: 'play',
      showsLabel,
      visibilityPriority: priority,
      parity: 'menu:test',
      zone,
      visible: () => visible,
    }),
  );

const inputArb = fc
  .record({
    rawItems: fc.array(itemArb, { minLength: 0, maxLength: 40 }),
    surfaceWidth: fc.integer({ min: 120, max: 2000 }),
    requiredPick: fc.array(fc.nat(), { maxLength: 4 }),
  })
  .map(({ rawItems, surfaceWidth, requiredPick }) => {
    // de-dupe ids (identity is unique in the registry by construction)
    const seen = new Set<string>();
    const items: AIBarItem[] = [];
    for (const item of rawItems) {
      if (!seen.has(item.id)) {
        seen.add(item.id);
        items.push(item);
      }
    }
    const contextual = items.filter((i) => i.zone === 'contextual');
    const requiredIds = new Set(
      contextual.length === 0
        ? []
        : requiredPick.map((n) => contextual[n % contextual.length]!.id),
    );
    const baseOrder = new Map(items.map((i, idx) => [i.id, idx]));
    const input: ResolveInput = {
      ctx: EMPTY_CONTEXT,
      items,
      baseOrder,
      requiredIds,
      pinnedIds: new Set(),
      surfaceWidth,
      density: 'regular',
      measureText: (text) => text.length * 7,
      resolveLabel: (key) => key,
      frecency: () => 0,
      stability: EMPTY_STABILITY,
      now: 10_000,
      suggestionPolicy: { minConfidence: 0.5, maxVisible: 2, allowEffects: ['read'] },
    };
    return input;
  });

function visibleSet(input: ResolveInput): Set<string> {
  return new Set(
    input.items.filter((i) => (i.visible ? i.visible(input.ctx) : true)).map((i) => i.id),
  );
}

describe('resolver P1–P5 invariants', () => {
  it('P1: a displayed item always satisfies its visibility predicate', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const plan = resolve(input);
        const visible = visibleSet(input);
        for (const placed of [...plan.contextual, ...plan.system]) {
          expect(visible.has(placed.id)).toBe(true);
        }
      }),
    );
  });

  it('P2: contextual items never overlap, stay in-bounds, and respect min/max widths', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const plan = resolve(input);
        let prevRight = -Infinity;
        for (const placed of plan.contextual) {
          expect(placed.x).toBeGreaterThanOrEqual(prevRight);
          prevRight = placed.x + placed.width;
          expect(prevRight).toBeLessThanOrEqual(input.surfaceWidth + 0.5);
          if (!placed.collapsed) {
            const spec = widthOf(placed.item);
            expect(placed.width).toBeGreaterThanOrEqual(spec.min - 0.5);
            if (Number.isFinite(spec.max)) {
              expect(placed.width).toBeLessThanOrEqual((spec.max ?? Infinity) + 0.5);
            }
          }
        }
      }),
    );
  });

  it('P3: required visible items are displayed or overflowed — never dropped', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const plan = resolve(input);
        const visible = visibleSet(input);
        const shown = new Set(plan.contextual.map((p) => p.id));
        const overflowed = new Set(plan.overflowed.map((i) => i.id));
        for (const id of input.requiredIds) {
          if (!visible.has(id)) continue;
          expect(shown.has(id) || overflowed.has(id)).toBe(true);
        }
      }),
    );
  });

  it('P4: resolution is deterministic for identical inputs', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const strip = (plan: ResolvedPlan) => ({
          contextual: plan.contextual.map((p) => ({ id: p.id, x: p.x, w: p.width })),
          system: plan.system.map((p) => ({ id: p.id, x: p.x, w: p.width })),
          overflowed: plan.overflowed.map((i) => i.id),
        });
        expect(strip(resolve(input))).toEqual(strip(resolve(input)));
      }),
    );
  });

  it('P6 (§13.1 lane isolation): suggestion items never perturb deterministic packing', () => {
    const suggestionArb = fc
      .record({
        key: fc.integer({ min: 500, max: 700 }),
        confidence: fc.double({ min: 0, max: 1, noNaN: true }),
        labelLen: fc.integer({ min: 2, max: 30 }),
      })
      .map(({ key, confidence, labelLen }) =>
        defineItem({
          id: asItemIdentifier(`intent.aibar.suggestion.k${key}`),
          type: 'suggestion',
          labelKey: 's'.repeat(labelLen),
          parity: 'none:prediction',
          provenance: { kind: 'agent', publisherId: 'aibar.intent' },
          action: { name: 'navigate', params: {} },
          confidence,
          reason: { code: 'repeat_in_context' },
        }),
      );

    fc.assert(
      fc.property(inputArb, fc.array(suggestionArb, { maxLength: 6 }), (input, rawSuggestions) => {
        const ids = new Set(input.items.map((i) => i.id));
        const suggestions = rawSuggestions.filter((s) => !ids.has(s.id));
        const withSuggestions: ResolveInput = {
          ...input,
          items: [...input.items, ...suggestions],
          baseOrder: new Map([...input.items, ...suggestions].map((i, idx) => [i.id, idx])),
        };
        const strip = (plan: ResolvedPlan) => ({
          contextual: plan.contextual.map((p) => ({ id: p.id, x: p.x, w: p.width })),
          system: plan.system.map((p) => ({ id: p.id, x: p.x, w: p.width })),
          overflowed: plan.overflowed.map((i) => i.id),
        });
        // Byte-identical deterministic lanes whether or not the intent
        // engine contributed anything (NFR-8 / arch §6.1).
        expect(JSON.stringify(strip(resolve(withSuggestions)))).toBe(
          JSON.stringify(strip(resolve(input))),
        );
      }),
    );
  });

  it('P5: surviving items never invert their relative order across context shifts', () => {
    fc.assert(
      fc.property(inputArb, fc.array(itemArb, { maxLength: 10 }), (input, extraRaw) => {
        const first = resolve(input);

        const ids = new Set(input.items.map((i) => i.id));
        const extras = extraRaw.filter((i) => !ids.has(i.id));
        const nextItems = [...input.items, ...extras];
        const baseOrder = new Map(nextItems.map((i, idx) => [i.id, idx]));
        const second = resolve({
          ...input,
          items: nextItems,
          baseOrder,
          stability: first.nextStability,
          now: input.now + 5000, // beyond dwell
        });

        const firstOrder = first.contextual.map((p) => p.id);
        const secondOrder = second.contextual.map((p) => p.id);
        const survivors = secondOrder.filter((id) => firstOrder.includes(id));
        const expected = firstOrder.filter((id) => survivors.includes(id));
        expect(survivors).toEqual(expected);
      }),
    );
  });

  it('pins mainButton flush-left even when baseOrder is late', () => {
    const model = defineItem({
      id: asItemIdentifier('com.leagent.aibar.button.composer-model'),
      type: 'button',
      labelKey: 'Model',
      icon: 'cpu',
      showsLabel: true,
      parity: 'menu:model',
      zone: 'contextual',
      visibilityPriority: 500,
    });
    const send = defineItem({
      id: asItemIdentifier('com.leagent.aibar.mainbutton.composer-send'),
      type: 'mainButton',
      labelKey: 'Send',
      showsLabel: true,
      parity: 'menu:chat.send',
      zone: 'contextual',
      visibilityPriority: 1100,
      width: { min: 40, preferred: 52, max: 72 },
    });
    const plan = resolve({
      ctx: EMPTY_CONTEXT,
      items: [model, send],
      baseOrder: new Map([
        [model.id, 0],
        [send.id, 99],
      ]),
      requiredIds: new Set(),
      pinnedIds: new Set(),
      surfaceWidth: 720,
      density: 'compact',
      measureText: (text) => text.length * 7,
      resolveLabel: (key) => key,
      frecency: () => 0,
      stability: {
        ...EMPTY_STABILITY,
        // Stability would otherwise keep model leftmost from a prior epoch.
        previousOrder: [model.id, send.id],
      },
      now: 10_000,
      suggestionPolicy: { minConfidence: 0.5, maxVisible: 2, allowEffects: ['read'] },
      leadingInset: 0,
    });
    expect(plan.contextual[0]?.id).toBe(send.id);
    expect(plan.contextual[0]?.x).toBeLessThan(plan.contextual[1]!.x);
  });
});
