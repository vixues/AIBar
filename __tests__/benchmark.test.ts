/**
 * Resolver benchmark harness (arch §13.2, NFR-1).
 *
 * Measures `resolve()` — the pure deterministic core — across 50 / 500 / 5000
 * registered items plus a churn pass (context revision + stability feedback).
 * CI gate strategy: generous hard thresholds fail the build; the tighter
 * NFR-1 budget (8 ms mid-size) prints a warning so regressions surface in
 * logs before we ratchet the gate down.
 */
import { describe, expect, it } from 'vitest';
import { asItemIdentifier, DEFAULT_SUGGESTION_POLICY } from '@aibar/protocol';
import {
  defineItem,
  EMPTY_CONTEXT,
  EMPTY_STABILITY,
  resolve,
  type AIBarItem,
  type ResolveInput,
  type StabilityState,
} from '@aibar/core';

function makeItems(count: number): AIBarItem[] {
  const items: AIBarItem[] = [];
  for (let i = 0; i < count; i++) {
    items.push(
      defineItem({
        id: asItemIdentifier(`bench.aibar.button.i${i}`),
        type: 'button',
        labelKey: `bench-item-${i}`,
        parity: `menu:bench-${i}`,
        visibilityPriority: (i % 7) - 3,
        visible: (ctx) => ((ctx.state.bench as { hide?: number } | undefined)?.hide ?? -1) !== i % 13,
        action: { name: 'bench' },
      }),
    );
  }
  return items;
}

function makeInput(items: AIBarItem[], revision = 1, stability: StabilityState = EMPTY_STABILITY): ResolveInput {
  return {
    ctx: {
      ...EMPTY_CONTEXT,
      revision,
      timestamp: revision,
      state: { bench: { hide: revision % 13 } },
    },
    items,
    baseOrder: new Map(items.map((item, i) => [item.id, i])),
    requiredIds: new Set(),
    pinnedIds: new Set(),
    surfaceWidth: 1200,
    density: 'compact',
    measureText: (text) => text.length * 7,
    resolveLabel: (key) => key,
    frecency: () => 0,
    stability,
    now: 1_000_000 + revision,
    suggestionPolicy: DEFAULT_SUGGESTION_POLICY,
  };
}

/** Median wall time over `runs` resolves (fresh input each run). */
function medianResolveMs(items: AIBarItem[], runs = 5): number {
  const samples: number[] = [];
  let stability: StabilityState = EMPTY_STABILITY;
  for (let r = 0; r < runs; r++) {
    const input = makeInput(items, r + 1, stability);
    const start = performance.now();
    const plan = resolve(input);
    samples.push(performance.now() - start);
    stability = plan.nextStability; // churn: feed stability forward
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)]!;
}

/** [hard fail ms, soft warn ms] per scale — CI machines are slow and shared. */
const BUDGETS: [count: number, hard: number, warn: number][] = [
  [50, 25, 8],
  [500, 100, 30],
  [5000, 1000, 300],
];

describe('resolver benchmark (NFR-1)', () => {
  for (const [count, hard, warn] of BUDGETS) {
    it(`resolves ${count} items within ${hard}ms (median of 5, with churn)`, () => {
      const items = makeItems(count);
      medianResolveMs(items, 2); // warm-up (JIT)
      const median = medianResolveMs(items);
      if (median > warn) {
        console.warn(
          `[aibar-bench] resolve(${count}) median ${median.toFixed(2)}ms exceeds soft budget ${warn}ms`,
        );
      }
      expect(median).toBeLessThan(hard);
    });
  }

  it('churn keeps hysteresis bookkeeping bounded', () => {
    const items = makeItems(500);
    let stability: StabilityState = EMPTY_STABILITY;
    for (let r = 0; r < 50; r++) {
      const plan = resolve(makeInput(items, r + 1, stability));
      stability = plan.nextStability;
    }
    // shownAt only tracks currently-shown ids — it must not grow with churn.
    expect(stability.shownAt.size).toBeLessThanOrEqual(items.length);
    expect(stability.previousOrder.length).toBeLessThanOrEqual(items.length);
  });
});
