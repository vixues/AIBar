/**
 * Kernel unit tests: escape/popover stack semantics, the destructive-effect
 * human gate (INV-A8), action outcome → item state, suggestion dismissal,
 * and the always-present overflow trigger.
 */
import { describe, expect, it, vi } from 'vitest';
import { asItemIdentifier } from '@aibar/protocol';
import {
  AIBarKernel,
  OVERFLOW_ID,
  type ActionInvocation,
  type ActionOutcome,
  type AIBarEvent,
  type AIBarHostAdapter,
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
  surfaceWidth(): number {
    return this.width;
  }
  onResize(): () => void {
    return () => {};
  }
  applyThemeTokens(): void {}
  destroy(): void {}
}

function makeAdapter(overrides: Partial<AIBarHostAdapter> = {}): AIBarHostAdapter & {
  dispatched: ActionInvocation[];
} {
  const dispatched: ActionInvocation[] = [];
  return {
    dispatched,
    contextProviders: [],
    dispatchAction: async (inv: ActionInvocation): Promise<ActionOutcome> => {
      dispatched.push(inv);
      return { ok: true };
    },
    resolveLabel: (key: string) => `L(${key})`,
    resolveIcon: () => ({ kind: 'text', text: '·' }),
    persistence: { load: async () => null, save: async () => {} },
    ...overrides,
  };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

function makeKernel(adapter = makeAdapter(), backend = new FakeBackend()) {
  const kernel = new AIBarKernel({
    adapter,
    definition: {
      customizationIdentifier: 'test.aibar.main',
      defaultItemIdentifiers: [],
      overflowAction: { name: 'host.openCommandPalette' },
    },
  });
  kernel.attach(backend, {});
  return { kernel, adapter, backend };
}

describe('AIBarKernel', () => {
  it('shows the overflow ellipsis only when packing spills items', async () => {
    const backend = new FakeBackend(120); // force spill
    const { kernel } = makeKernel(makeAdapter(), backend);
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) {
      kernel.register({
        id: asItemIdentifier(`t.aibar.mainbutton.${key}`),
        type: 'mainButton',
        labelKey: `item-${key}-long-label`,
        parity: `menu:${key}`,
        width: { min: 80, preferred: 120, max: 160 },
      });
    }
    await settle();
    expect(backend.present.has(OVERFLOW_ID)).toBe(true);
    const node = backend.present.get(OVERFLOW_ID)!;
    expect(node.disclosure).toBe('overflow');
    expect(node.icon).toEqual({ kind: 'text', text: '⋯' });
    expect(node.showsLabel).toBe(true);
  });

  it('hides the overflow trigger when everything fits', async () => {
    const { kernel, backend } = makeKernel();
    kernel.register({
      id: asItemIdentifier('t.aibar.button.a'),
      type: 'button',
      labelKey: 'a',
      parity: 'menu:a',
    });
    await settle();
    expect(backend.present.has('t.aibar.button.a')).toBe(true);
    expect(backend.present.has(OVERFLOW_ID)).toBe(false);
  });

  it('opens overflow into a sub-surface with a command-palette drain', async () => {
    const backend = new FakeBackend(100);
    const { kernel, adapter } = makeKernel(makeAdapter(), backend);
    kernel.register({
      id: asItemIdentifier('t.aibar.mainbutton.a'),
      type: 'mainButton',
      labelKey: 'alpha-item',
      parity: 'menu:a',
      width: { min: 90, preferred: 140, max: 160 },
    });
    kernel.register({
      id: asItemIdentifier('t.aibar.mainbutton.b'),
      type: 'mainButton',
      labelKey: 'beta-item',
      parity: 'menu:b',
      width: { min: 90, preferred: 140, max: 160 },
    });
    await settle();
    expect(backend.present.has(OVERFLOW_ID)).toBe(true);
    kernel.openPopover(OVERFLOW_ID);
    await settle();
    // Escape close is present while the overflow surface is open.
    expect(backend.frames.at(-1)?.escape?.id).toBeDefined();
    await kernel.invoke(asItemIdentifier('core.aibar.button.overflow-palette'));
    expect(adapter.dispatched.some((d) => d.name === 'host.openCommandPalette')).toBe(true);
  });

  it('omits the overflow palette drain when definition.overflowAction is unset', async () => {
    const backend = new FakeBackend(100);
    const adapter = makeAdapter();
    const kernel = new AIBarKernel({
      adapter,
      definition: {
        customizationIdentifier: 'test.aibar.main',
        defaultItemIdentifiers: [],
      },
    });
    kernel.attach(backend, {});
    kernel.register({
      id: asItemIdentifier('t.aibar.mainbutton.a'),
      type: 'mainButton',
      labelKey: 'alpha-item',
      parity: 'menu:a',
      width: { min: 90, preferred: 140, max: 160 },
    });
    kernel.register({
      id: asItemIdentifier('t.aibar.mainbutton.b'),
      type: 'mainButton',
      labelKey: 'beta-item',
      parity: 'menu:b',
      width: { min: 90, preferred: 140, max: 160 },
    });
    await settle();
    kernel.openPopover(OVERFLOW_ID);
    await settle();
    expect(backend.present.has('core.aibar.button.overflow-palette')).toBe(false);
    kernel.destroy();
  });

  it('invoke() dispatches through the adapter with interpolated params and records completion', async () => {
    const { kernel, adapter } = makeKernel();
    const events: AIBarEvent[] = [];
    kernel.onEvent((e) => events.push(e));
    kernel.register({
      id: asItemIdentifier('t.aibar.button.act'),
      type: 'button',
      labelKey: 'act',
      parity: 'menu:act',
      action: { name: 'navigate', params: { route: '/tasks' } },
    });
    await settle();
    await kernel.invoke(asItemIdentifier('t.aibar.button.act'));
    expect(adapter.dispatched).toHaveLength(1);
    expect(adapter.dispatched[0]!.name).toBe('navigate');
    expect(adapter.dispatched[0]!.params).toEqual({ route: '/tasks' });
    expect(events.some((e) => e.type === 'aibar.action.invoked')).toBe(true);
    expect(
      events.some((e) => e.type === 'aibar.action.completed' && e.outcome === 'ok'),
    ).toBe(true);
  });

  it('gates destructive effects through confirmEffect; deny blocks dispatch (INV-A8)', async () => {
    const confirmEffect = vi.fn<() => Promise<'allow' | 'deny'>>(async () => 'deny');
    const adapter = makeAdapter({ confirmEffect });
    const { kernel } = makeKernel(adapter);
    kernel.register({
      id: asItemIdentifier('t.aibar.button.rm'),
      type: 'button',
      labelKey: 'rm',
      parity: 'menu:rm',
      effect: 'destructive',
      action: { name: 'delete_thing' },
    });
    await settle();
    await kernel.invoke(asItemIdentifier('t.aibar.button.rm'));
    expect(confirmEffect).toHaveBeenCalledOnce();
    expect(adapter.dispatched).toHaveLength(0);

    confirmEffect.mockResolvedValueOnce('allow');
    await kernel.invoke(asItemIdentifier('t.aibar.button.rm'));
    expect(adapter.dispatched).toHaveLength(1);
  });

  it('failed dispatch marks the item error and reports outcome error', async () => {
    const adapter = makeAdapter({
      dispatchAction: async () => ({ ok: false, error: 'boom' }),
    });
    const { kernel, backend } = makeKernel(adapter);
    const events: AIBarEvent[] = [];
    kernel.onEvent((e) => events.push(e));
    kernel.register({
      id: asItemIdentifier('t.aibar.button.fail'),
      type: 'button',
      labelKey: 'fail',
      parity: 'menu:fail',
      action: { name: 'x' },
    });
    await settle();
    await kernel.invoke(asItemIdentifier('t.aibar.button.fail'));
    await settle();
    expect(backend.states.get('t.aibar.button.fail')).toBe('error');
    expect(
      events.some((e) => e.type === 'aibar.action.completed' && e.outcome === 'error'),
    ).toBe(true);
  });

  it('popover children replace the contextual region; escape pops back (§8.3)', async () => {
    const { kernel, backend } = makeKernel();
    const parent = asItemIdentifier('t.aibar.popover.tools');
    kernel.register({
      id: parent,
      type: 'popover',
      labelKey: 'tools',
      parity: 'menu:tools',
      children: [
        {
          id: asItemIdentifier('t.aibar.button.child'),
          type: 'button',
          labelKey: 'child',
          parity: 'menu:child',
          visibilityPriority: 0,
          provenance: { kind: 'host' },
          effect: 'read',
          zone: 'contextual',
        },
      ],
    });
    await settle();
    expect(backend.present.has('t.aibar.button.child')).toBe(false);

    kernel.openPopover(parent);
    await settle();
    expect(backend.present.has('t.aibar.button.child')).toBe(true);
    // escape slot now shows the close affordance
    expect(backend.frames.at(-1)!.escape).not.toBeNull();

    kernel.escape();
    await settle();
    expect(backend.present.has('t.aibar.button.child')).toBe(false);
    expect(backend.frames.at(-1)!.escape).toBeNull();
  });

  it('suggestion dismissal removes the item and emits the dismissed signal', async () => {
    const { kernel, backend } = makeKernel();
    const events: AIBarEvent[] = [];
    kernel.onEvent((e) => events.push(e));
    const sid = asItemIdentifier('t.aibar.suggestion.try');
    kernel.register({
      id: sid,
      type: 'suggestion',
      labelKey: 'try',
      parity: 'suggestion:optional',
      confidence: 0.9,
      reason: { code: 'test' },
      action: { name: 'x' },
    });
    await settle();
    expect(backend.present.has(sid)).toBe(true);
    expect(events.some((e) => e.type === 'aibar.suggestion.shown')).toBe(true);

    kernel.dismiss(sid);
    await settle();
    expect(backend.present.has(sid)).toBe(false);
    expect(events.some((e) => e.type === 'aibar.suggestion.dismissed')).toBe(true);
  });

  it('expired TTL items are swept on resolve', async () => {
    const { kernel, backend } = makeKernel();
    const id = asItemIdentifier('t.aibar.button.ttl');
    kernel.register({
      id,
      type: 'button',
      labelKey: 'ttl',
      parity: 'menu:ttl',
      expiresAt: Date.now() - 1,
    });
    await settle();
    expect(backend.present.has(id)).toBe(false);
  });
});
