/**
 * Phase 3 kernel behavior: customization mode (FR-5), fnMode (§8.2),
 * System Strip collapse/expand (design §2.2), and the full escape
 * semantics stack (design §8.3).
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

const SYSTEM_TOGGLE = 'core.aibar.button.system-toggle';

class FakeBackend implements RendererBackend {
  frames: RenderFrame[] = [];
  present = new Map<string, ItemRenderModel>();
  states = new Map<string, ItemVisualState>();

  constructor(public width = 900) {}

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
  saved: Map<string, unknown>;
} {
  const dispatched: ActionInvocation[] = [];
  const saved = new Map<string, unknown>();
  return {
    dispatched,
    saved,
    contextProviders: [],
    dispatchAction: async (inv: ActionInvocation): Promise<ActionOutcome> => {
      dispatched.push(inv);
      return { ok: true };
    },
    resolveLabel: (key: string) => `L(${key})`,
    resolveIcon: () => ({ kind: 'text', text: '·' }),
    persistence: {
      load: async (key: string) => saved.get(key) ?? null,
      save: async (key: string, value: unknown) => {
        saved.set(key, value);
      },
    },
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

function registerButtons(kernel: AIBarKernel, keys: string[], zone?: 'system') {
  for (const key of keys) {
    kernel.register({
      id: asItemIdentifier(`t.aibar.button.${key}`),
      type: 'button',
      labelKey: key,
      parity: `menu:${key}`,
      ...(zone ? { zone } : {}),
      action: { name: 'x' },
    });
  }
}

describe('customization mode (FR-5)', () => {
  it('setItemHidden removes the item from the bar; unhide restores it', async () => {
    const { kernel, backend } = makeKernel();
    registerButtons(kernel, ['a', 'b']);
    await settle();
    expect(backend.present.has('t.aibar.button.a')).toBe(true);

    kernel.setItemHidden(asItemIdentifier('t.aibar.button.a'), true);
    await settle();
    expect(backend.present.has('t.aibar.button.a')).toBe(false);
    expect(backend.present.has('t.aibar.button.b')).toBe(true);

    kernel.setItemHidden(asItemIdentifier('t.aibar.button.a'), false);
    await settle();
    expect(backend.present.has('t.aibar.button.a')).toBe(true);
  });

  it('required items are never customizable', async () => {
    const adapter = makeAdapter();
    const backend = new FakeBackend();
    const kernel = new AIBarKernel({
      adapter,
      definition: {
        customizationIdentifier: 'test.aibar.main',
        defaultItemIdentifiers: [],
        customizationRequiredItemIdentifiers: [asItemIdentifier('t.aibar.button.req')],
      },
    });
    kernel.attach(backend, {});
    registerButtons(kernel, ['req']);
    await settle();
    expect(kernel.isCustomizable(asItemIdentifier('t.aibar.button.req'))).toBe(false);
    kernel.setItemHidden(asItemIdentifier('t.aibar.button.req'), true);
    await settle();
    expect(backend.present.has('t.aibar.button.req')).toBe(true);
  });

  it('setCustomOrder reorders the contextual sequence', async () => {
    const { kernel } = makeKernel();
    registerButtons(kernel, ['a', 'b', 'c']);
    await settle();
    expect(kernel.customSequence()).toEqual([
      't.aibar.button.a',
      't.aibar.button.b',
      't.aibar.button.c',
    ]);
    kernel.setCustomOrder([
      asItemIdentifier('t.aibar.button.c'),
      asItemIdentifier('t.aibar.button.a'),
    ]);
    await settle();
    // explicit order first, remaining items keep base order after it
    expect(kernel.customSequence()).toEqual([
      't.aibar.button.c',
      't.aibar.button.a',
      't.aibar.button.b',
    ]);
  });

  it('Done persists and emits aibar.customization.changed; Cancel restores the snapshot', async () => {
    const { kernel, adapter } = makeKernel();
    registerButtons(kernel, ['a', 'b']);
    await settle();
    const events: AIBarEvent[] = [];
    kernel.onEvent((e) => events.push(e));

    kernel.enterCustomizing();
    expect(kernel.state).toBe('customizing');
    kernel.setItemHidden(asItemIdentifier('t.aibar.button.a'), true);
    kernel.exitCustomizing(true);
    await settle();
    expect(kernel.state).not.toBe('customizing');
    expect(events.some((e) => e.type === 'aibar.customization.changed')).toBe(true);
    const persisted = adapter.saved.get('aibar.test.aibar.main.custom') as {
      hidden: string[];
    };
    expect(persisted.hidden).toContain('t.aibar.button.a');

    // Cancel path: mutations inside customizing roll back.
    kernel.enterCustomizing();
    kernel.setItemHidden(asItemIdentifier('t.aibar.button.b'), true);
    expect(kernel.isItemHidden(asItemIdentifier('t.aibar.button.b'))).toBe(true);
    kernel.exitCustomizing(false);
    expect(kernel.isItemHidden(asItemIdentifier('t.aibar.button.b'))).toBe(false);
    expect(kernel.isItemHidden(asItemIdentifier('t.aibar.button.a'))).toBe(true);
  });

  it('persisted customization is loaded on construction', async () => {
    const adapter = makeAdapter();
    adapter.saved.set('aibar.test.aibar.main.custom', {
      order: ['t.aibar.button.b', 't.aibar.button.a'],
      hidden: ['t.aibar.button.c'],
    });
    const backend = new FakeBackend();
    const { kernel } = makeKernel(adapter, backend);
    registerButtons(kernel, ['a', 'b', 'c']);
    await settle();
    expect(backend.present.has('t.aibar.button.c')).toBe(false);
    expect(kernel.customSequence()).toEqual(['t.aibar.button.b', 't.aibar.button.a']);
  });
});

describe('overflow + library APIs (FR-5 / design §9.2)', () => {
  it('openOverflow opens the overflow sub-surface when items spilled', async () => {
    const backend = new FakeBackend(100);
    const { kernel, adapter } = makeKernel(makeAdapter(), backend);
    for (const key of ['a', 'b']) {
      kernel.register({
        id: asItemIdentifier(`t.aibar.mainbutton.${key}`),
        type: 'mainButton',
        labelKey: `${key}-item-long`,
        parity: `menu:${key}`,
        width: { min: 90, preferred: 140, max: 160 },
      });
    }
    await settle();
    expect(backend.present.has(OVERFLOW_ID)).toBe(true);
    kernel.openOverflow();
    await settle();
    expect(backend.frames.at(-1)?.escape?.id).toBeDefined();
    await kernel.invoke(asItemIdentifier('core.aibar.button.overflow-palette'));
    expect(adapter.dispatched.some((d) => d.name === 'host.openCommandPalette')).toBe(true);
  });

  it('libraryCandidates lists hidden customizable items', async () => {
    const backend = new FakeBackend();
    const kernel = new AIBarKernel({
      adapter: makeAdapter(),
      definition: {
        customizationIdentifier: 'test.aibar.main',
        defaultItemIdentifiers: [],
        customizationAllowedItemIdentifiers: [
          asItemIdentifier('t.aibar.button.a'),
          asItemIdentifier('t.aibar.button.b'),
        ],
      },
    });
    kernel.attach(backend, {});
    registerButtons(kernel, ['a', 'b']);
    await settle();
    kernel.setItemHidden(asItemIdentifier('t.aibar.button.a'), true);
    expect(kernel.libraryCandidates()).toContain('t.aibar.button.a');
    expect(kernel.libraryCandidates()).not.toContain('t.aibar.button.b');
    kernel.destroy();
  });
});

describe('fnMode (§8.2)', () => {
  it('is a no-op when the adapter provides no fnModeItems', async () => {
    const { kernel } = makeKernel();
    kernel.setFnMode(true);
    expect(kernel.state).not.toBe('fnMode');
  });

  it('swaps the contextual region for the alternate set and restores on release', async () => {
    const adapter = makeAdapter({
      fnModeItems: () => [
        {
          id: asItemIdentifier('t.aibar.button.alt'),
          type: 'button',
          labelKey: 'alt',
          parity: 'menu:alt',
          action: { name: 'x' },
        },
      ],
    });
    const { kernel, backend } = makeKernel(adapter);
    registerButtons(kernel, ['a']);
    await settle();
    expect(backend.present.has('t.aibar.button.a')).toBe(true);

    kernel.setFnMode(true);
    await settle();
    expect(kernel.state).toBe('fnMode');
    expect(backend.present.has('t.aibar.button.alt')).toBe(true);
    expect(backend.present.has('t.aibar.button.a')).toBe(false);

    kernel.setFnMode(false);
    await settle();
    expect(backend.present.has('t.aibar.button.alt')).toBe(false);
    expect(backend.present.has('t.aibar.button.a')).toBe(true);
  });
});

describe('System Strip collapse/expand (design §2.2)', () => {
  it('collapses to the top items plus a toggle; expand shows everything', async () => {
    const { kernel, backend } = makeKernel();
    registerButtons(kernel, ['s1', 's2', 's3', 's4', 's5'], 'system');
    await settle();
    expect(backend.present.has(SYSTEM_TOGGLE)).toBe(true);
    expect(backend.present.has('t.aibar.button.s5')).toBe(false);
    expect(kernel.isSystemStripExpanded).toBe(false);

    kernel.toggleSystemStrip(true);
    await settle();
    expect(kernel.isSystemStripExpanded).toBe(true);
    expect(backend.present.has('t.aibar.button.s5')).toBe(true);

    kernel.toggleSystemStrip(false);
    await settle();
    expect(backend.present.has('t.aibar.button.s5')).toBe(false);
  });

  it('never shows the toggle when the strip fits the collapsed budget', async () => {
    const { kernel, backend } = makeKernel();
    registerButtons(kernel, ['s1', 's2'], 'system');
    await settle();
    expect(backend.present.has(SYSTEM_TOGGLE)).toBe(false);
  });

  it('ignores currently-hidden system items when deciding to show the toggle', async () => {
    const { kernel, backend } = makeKernel();
    // Four registered system ids, but only two are visible on this surface —
    // the toggle must not appear (and must not jump the right-anchored strip).
    for (const key of ['s1', 's2', 'ghost-a', 'ghost-b']) {
      kernel.register({
        id: asItemIdentifier(`t.aibar.button.${key}`),
        type: 'button',
        labelKey: key,
        parity: `menu:${key}`,
        zone: 'system',
        visible: () => !key.startsWith('ghost'),
        action: { name: 'x' },
      });
    }
    await settle();
    expect(backend.present.has(SYSTEM_TOGGLE)).toBe(false);
    expect(backend.present.has('t.aibar.button.s1')).toBe(true);
    expect(backend.present.has('t.aibar.button.ghost-a')).toBe(false);
  });

  it('keeps the system toggle at the trailing (far-right) edge', async () => {
    const { kernel, backend } = makeKernel();
    registerButtons(kernel, ['s1', 's2', 's3', 's4'], 'system');
    await settle();

    const latestBoxes = () => {
      const boxes = new Map<string, number>();
      for (const frame of backend.frames) {
        for (const op of frame.ops) {
          if (
            (op.kind === 'create' || op.kind === 'move' || op.kind === 'update') &&
            'box' in op &&
            op.box
          ) {
            boxes.set(op.id as string, op.box.x);
          }
          if (op.kind === 'remove') boxes.delete(op.id as string);
        }
      }
      return boxes;
    };

    const collapsed = latestBoxes();
    const toggleBoxX = collapsed.get(SYSTEM_TOGGLE);
    expect(toggleBoxX).toBeTypeOf('number');
    for (const [id, x] of collapsed) {
      if (id === SYSTEM_TOGGLE) continue;
      if (id.startsWith('t.aibar.button.s')) {
        expect(x).toBeLessThan(toggleBoxX!);
      }
    }

    kernel.toggleSystemStrip(true);
    await settle();
    const expanded = latestBoxes();
    // Right-anchored trailing toggle: x stays at surfaceWidth - toggleWidth.
    expect(expanded.get(SYSTEM_TOGGLE)).toBe(toggleBoxX);
    expect(expanded.get('t.aibar.button.s4')).toBeTypeOf('number');
    expect(expanded.get('t.aibar.button.s4')!).toBeLessThan(toggleBoxX!);
  });

  it('auto-collapses after the idle window', async () => {
    vi.useFakeTimers();
    try {
      const { kernel } = makeKernel();
      registerButtons(kernel, ['s1', 's2', 's3', 's4'], 'system');
      await vi.advanceTimersByTimeAsync(10);
      kernel.toggleSystemStrip(true);
      expect(kernel.isSystemStripExpanded).toBe(true);
      await vi.advanceTimersByTimeAsync(8000 + 50);
      expect(kernel.isSystemStripExpanded).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('escape stack (design §8.3)', () => {
  it('fnMode exit takes precedence, then popover close, then customizing Done', async () => {
    const adapter = makeAdapter({
      fnModeItems: () => [
        {
          id: asItemIdentifier('t.aibar.button.alt'),
          type: 'button',
          labelKey: 'alt',
          parity: 'menu:alt',
        },
      ],
    });
    const { kernel } = makeKernel(adapter);
    registerButtons(kernel, ['a']);
    await settle();

    kernel.setFnMode(true);
    kernel.escape();
    expect(kernel.state).not.toBe('fnMode');

    kernel.enterCustomizing();
    expect(kernel.state).toBe('customizing');
    kernel.escape();
    expect(kernel.state).not.toBe('customizing');
  });

  it('pending approval deny wins over popover close', async () => {
    const { kernel } = makeKernel();
    const events: AIBarEvent[] = [];
    kernel.onEvent((e) => events.push(e));
    const aid = asItemIdentifier('t.aibar.approval.gate');
    kernel.register({
      id: aid,
      type: 'approval',
      labelKey: 'gate',
      parity: 'none:approval',
    });
    kernel.noteApprovalRequested(aid);
    await settle();
    kernel.escape();
    await settle();
    expect(
      events.some((e) => e.type === 'aibar.approval.resolved' && e.decision === 'deny'),
    ).toBe(true);
  });
});
