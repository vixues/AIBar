/**
 * Phase-5 performance governance tests (arch §6.6, §11.2–§11.3):
 * slice-read tracking skips unrelated context waves, the degradation ladder
 * walks up under sustained overruns (and recovers with hysteresis), rung ≥1
 * suspends the suggestion lane, rung 2 reaches the renderer via the frame,
 * and intent prediction rides the backend's background task queue.
 */
import { describe, expect, it } from 'vitest';
import { asItemIdentifier } from '@aibar/protocol';
import {
  AIBarKernel,
  type ActionInvocation,
  type ActionOutcome,
  type AIBarEvent,
  type AIBarHostAdapter,
  type ContextProvider,
  type ItemRenderModel,
  type ItemVisualState,
  type MeasureRequest,
  type RendererBackend,
  type RenderFrame,
} from '@aibar/core';

class FakeBackend implements RendererBackend {
  frames: RenderFrame[] = [];
  present = new Map<string, ItemRenderModel>();
  states = new Map<string, ItemVisualState>();
  postCalls: string[] = [];
  width: number;

  constructor(width = 900) {
    this.width = width;
  }

  mount(): void {}
  measure(requests: readonly MeasureRequest[]) {
    return requests.map((r) => ({ width: r.text.length * 7 }));
  }
  commit(frame: RenderFrame): void {
    this.frames.push(frame);
    for (const op of frame.ops) {
      if (op.kind === 'create') this.present.set(op.id, op.node);
      if (op.kind === 'update') {
        this.present.set(op.id, { ...this.present.get(op.id), ...op.patch } as ItemRenderModel);
      }
      if (op.kind === 'remove') this.present.delete(op.id);
      if (op.kind === 'state') this.states.set(op.id, op.state);
    }
  }
  scheduleFrame(cb: () => void): void {
    cb();
  }
  postTask(cb: () => void, priority: 'user-visible' | 'background'): void {
    this.postCalls.push(priority);
    cb();
  }
  surfaceWidth(): number {
    return this.width;
  }
  onResize(): () => void {
    return () => {};
  }
  applyThemeTokens(): void {}
  destroy(): void {}
}

function makeAdapter(overrides: Partial<AIBarHostAdapter> = {}): AIBarHostAdapter {
  return {
    contextProviders: [],
    dispatchAction: async (_inv: ActionInvocation): Promise<ActionOutcome> => ({ ok: true }),
    resolveLabel: (key: string) => `L(${key})`,
    resolveIcon: () => ({ kind: 'text', text: '·' }),
    persistence: { load: async () => null, save: async () => {} },
    ...overrides,
  };
}

function makeKernel(adapter = makeAdapter(), backend = new FakeBackend()) {
  const kernel = new AIBarKernel({
    adapter,
    definition: {
      customizationIdentifier: 'test.aibar.main',
      defaultItemIdentifiers: [],
    },
  });
  kernel.attach(backend, {});
  return { kernel, backend };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mutable context provider whose invalidations we control from the test. */
function makeProvider(id: string) {
  let value = 0;
  let invalidate: () => void = () => {};
  const provider: ContextProvider = {
    id,
    collect: () => ({ value }),
    subscribe: (cb) => {
      invalidate = cb;
      return () => {};
    },
  };
  return {
    provider,
    bump: () => {
      value += 1;
      invalidate();
    },
  };
}

describe('slice-read tracking (§6.6)', () => {
  it('skips resolve waves whose dirty slices were never read', async () => {
    const a = makeProvider('a');
    const b = makeProvider('b');
    const { kernel } = makeKernel(
      makeAdapter({ contextProviders: [a.provider, b.provider] }),
    );
    // The only registered item reads slice `a` exclusively.
    kernel.register({
      id: asItemIdentifier('t.aibar.button.a'),
      type: 'button',
      labelKey: 'a',
      parity: 'menu:a',
      visible: (ctx) => ((ctx.state.a as { value?: number } | undefined)?.value ?? 0) < 100,
    });
    await wait(80); // initial flush (32 ms coalesce) + resolve

    const layouts: number[] = [];
    kernel.events.on((e: AIBarEvent) => {
      if (e.type === 'aibar.surface.layout') layouts.push(e.epoch);
    });

    b.bump();
    await wait(80);
    expect(layouts).toHaveLength(0); // wave dirtied only `b` → skipped

    a.bump();
    await wait(80);
    expect(layouts.length).toBeGreaterThan(0); // `a` was read → resolves
  });
});

describe('degradation ladder (§11.3)', () => {
  it('walks up under sustained overruns and emits the event', () => {
    const { kernel } = makeKernel();
    const events: AIBarEvent[] = [];
    kernel.events.on((e) => events.push(e));

    for (let i = 0; i < 5; i++) kernel.notePerfSample(20); // median 20 > 8
    expect(kernel.perfDegradeLevel).toBe(1);
    expect(events.some((e) => e.type === 'aibar.perf.degraded' && e.level === 1)).toBe(true);

    for (let i = 0; i < 6; i++) kernel.notePerfSample(30); // median 30 > 24
    expect(kernel.perfDegradeLevel).toBe(2);
  });

  it('recovers only with real headroom (hysteresis)', () => {
    const { kernel } = makeKernel();
    for (let i = 0; i < 5; i++) kernel.notePerfSample(20);
    expect(kernel.perfDegradeLevel).toBe(1);

    // Median 6 is under budget but above budget/2 → hold the level.
    for (let i = 0; i < 10; i++) kernel.notePerfSample(6);
    expect(kernel.perfDegradeLevel).toBe(1);

    // Median 3 < budget/2 → recover.
    for (let i = 0; i < 10; i++) kernel.notePerfSample(3);
    expect(kernel.perfDegradeLevel).toBe(0);
  });

  it('suspends the suggestion lane at rung 1', async () => {
    const { kernel, backend } = makeKernel();
    for (let i = 0; i < 5; i++) kernel.notePerfSample(20);
    expect(kernel.perfDegradeLevel).toBe(1);

    kernel.register({
      id: asItemIdentifier('t.aibar.suggestion.x'),
      type: 'suggestion',
      labelKey: 'sx',
      parity: 'none:test',
      confidence: 0.9,
      action: { name: 'x' },
    });
    kernel.register({
      id: asItemIdentifier('t.aibar.button.y'),
      type: 'button',
      labelKey: 'y',
      parity: 'menu:y',
    });
    await wait(20);

    expect(kernel.debugSnapshot().lanes.suggestions).toHaveLength(0);
    expect(backend.present.has('t.aibar.suggestion.x')).toBe(false);
    expect(backend.present.has('t.aibar.button.y')).toBe(true);
  });

  it('propagates the ladder level to the renderer frame', async () => {
    const { kernel, backend } = makeKernel();
    for (let i = 0; i < 6; i++) kernel.notePerfSample(30);
    expect(kernel.perfDegradeLevel).toBe(2);

    kernel.register({
      id: asItemIdentifier('t.aibar.button.z'),
      type: 'button',
      labelKey: 'z',
      parity: 'menu:z',
    });
    await wait(20);

    const last = backend.frames[backend.frames.length - 1]!;
    expect(last.degraded).toBe(2);
  });
});

describe('background scheduling (§11.2)', () => {
  it('routes intent prediction through backend.postTask(background)', async () => {
    const backend = new FakeBackend();
    const { kernel } = makeKernel(
      makeAdapter({ intent: { predict: async () => [] } }),
      backend,
    );
    kernel.setSuggestionPolicy({ maxVisible: 1 });
    await wait(400); // > 250 ms intent debounce
    expect(backend.postCalls).toContain('background');
  });

  it('routes resolve through backend.postTask(user-visible)', async () => {
    const backend = new FakeBackend();
    const { kernel } = makeKernel(makeAdapter(), backend);
    backend.postCalls = [];
    kernel.scheduleResolve();
    await wait(5);
    expect(backend.postCalls).toContain('user-visible');
  });
});
