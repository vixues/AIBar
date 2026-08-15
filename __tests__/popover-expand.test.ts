/**
 * NSPopoverTouchBarItem expand/collapse contract:
 * showPopover / dismissPopover / Escape Zone ✕ / visible-layer escape /
 * auto-dismiss on child select / invoke loading recovery.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AIBarKernel,
  asItemIdentifier,
  defineItem,
  type AIBarHostAdapter,
  type AIBarItem,
  type RendererBackend,
  type RenderFrame,
} from '@aibar/core';

class FakeBackend implements RendererBackend {
  frames: RenderFrame[] = [];
  present = new Map<string, { type: string }>();
  constructor(private width = 720) {}
  mount() {}
  measure(rs: { text: string }[]) {
    return rs.map((r) => ({ width: Math.max(40, r.text.length * 7) }));
  }
  commit(frame: RenderFrame) {
    this.frames.push(frame);
    for (const op of frame.ops) {
      if (op.kind === 'create') this.present.set(op.id, op.node);
      if (op.kind === 'update') {
        this.present.set(op.id, { ...this.present.get(op.id), ...op.patch } as { type: string });
      }
      if (op.kind === 'remove') this.present.delete(op.id);
    }
  }
  scheduleFrame(cb: () => void) {
    cb();
  }
  surfaceWidth() {
    return this.width;
  }
  onResize() {
    return () => {};
  }
  applyThemeTokens() {}
  destroy() {}
}

function makeAdapter(overrides: Partial<AIBarHostAdapter> = {}): AIBarHostAdapter {
  return {
    contextProviders: [],
    dispatchAction: async () => ({ ok: true }),
    resolveLabel: (key) => key,
    resolveIcon: () => ({ kind: 'text', text: '·' }),
    persistence: { load: async () => null, save: async () => {} },
    ...overrides,
  };
}

function settle(ms = 20) {
  return new Promise((r) => setTimeout(r, ms));
}

function childButton(
  key: string,
  extras: Partial<AIBarItem> = {},
): AIBarItem {
  return defineItem({
    id: asItemIdentifier(`t.aibar.button.${key}`),
    type: 'button',
    labelKey: key,
    parity: `menu:${key}`,
    ...extras,
  });
}

function toolsPopover(children: AIBarItem[]): AIBarItem {
  return defineItem({
    id: asItemIdentifier('t.aibar.popover.tools'),
    type: 'popover',
    labelKey: 'tools',
    parity: 'menu:tools',
    children,
  });
}

describe('NSPopoverTouchBarItem expand/collapse', () => {
  function latestBoxes(backend: FakeBackend) {
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
  }

  it('ground presentation flushes left (Appendix B edgePad)', async () => {
    const backend = new FakeBackend(720);
    const kernel = new AIBarKernel({
      adapter: makeAdapter(),
      definition: { defaultItemIdentifiers: [] },
      density: 'compact',
    });
    kernel.attach(backend, {});
    const ground = childButton('folders');
    kernel.register({ ...ground, zone: 'contextual' });
    await settle();
    expect(kernel.presentation()).toBe('ground');
    // compact edgePad = 4
    expect(latestBoxes(backend).get(ground.id as string)).toBe(4);
    expect(backend.frames.at(-1)?.escape).toBeNull();
    kernel.destroy();
  });

  it('subsurface presentation owns Escape chrome; swap has no move ops', async () => {
    const backend = new FakeBackend(720);
    const kernel = new AIBarKernel({
      adapter: makeAdapter(),
      definition: { defaultItemIdentifiers: [] },
      density: 'compact',
    });
    kernel.attach(backend, {});
    const child = childButton('cut');
    const parent = toolsPopover([child]);
    kernel.register({ ...parent, zone: 'contextual' });
    await settle();

    kernel.openPopover(parent.id);
    await settle();
    const openFrame = backend.frames.at(-1)!;
    expect(kernel.presentation()).toBe('subsurface');
    expect(openFrame.presentation).toBe('subsurface');
    expect(openFrame.presentationChanged).toBe(true);
    expect(openFrame.escape?.id).toBe('core.aibar.button.escape-close');
    expect(openFrame.ops.some((op) => op.kind === 'move')).toBe(false);
    // compact escapeZoneWidth = 28; child starts at leadingChrome = 28 + gapGroup(8)
    expect(latestBoxes(backend).get(child.id as string)).toBeGreaterThanOrEqual(28);

    kernel.closeSubSurface();
    await settle();
    const closeFrame = backend.frames.at(-1)!;
    expect(kernel.presentation()).toBe('ground');
    expect(closeFrame.presentation).toBe('ground');
    expect(closeFrame.presentationChanged).toBe(true);
    expect(closeFrame.ops.some((op) => op.kind === 'move')).toBe(false);
    kernel.destroy();
  });

  it('popover open/close keeps ground-item x stable (no left/right jump)', async () => {
    const backend = new FakeBackend(720);
    const kernel = new AIBarKernel({
      adapter: makeAdapter(),
      definition: { defaultItemIdentifiers: [] },
      density: 'compact',
    });
    kernel.attach(backend, {});
    const ground = childButton('folders');
    const child = childButton('cut');
    const parent = toolsPopover([child]);
    // Parent is contextual (composer-style popover).
    kernel.register({ ...parent, zone: 'contextual' });
    kernel.register({ ...ground, zone: 'contextual' });
    await settle();

    const beforeBoxes = latestBoxes(backend);
    // Trigger is leftmost (flush-left); sibling keeps its relative x across swap.
    expect(beforeBoxes.get(parent.id as string)).toBe(4);
    const beforeGround = beforeBoxes.get(ground.id as string);
    expect(beforeGround).toBeTypeOf('number');

    kernel.openPopover(parent.id);
    await settle();
    kernel.closeSubSurface();
    await settle();

    const afterBoxes = latestBoxes(backend);
    expect(afterBoxes.get(parent.id as string)).toBe(4);
    expect(afterBoxes.get(ground.id as string)).toBe(beforeGround);
    kernel.destroy();
  });

  it('showPopover replaces contextual items; dismissPopover restores ground', async () => {
    const backend = new FakeBackend();
    const kernel = new AIBarKernel({
      adapter: makeAdapter(),
      definition: { defaultItemIdentifiers: [] },
    });
    kernel.attach(backend, {});
    const child = childButton('cut');
    const parent = toolsPopover([child]);
    kernel.register(parent);
    await settle();
    expect(backend.present.has(parent.id as string)).toBe(true);
    expect(backend.present.has(child.id as string)).toBe(false);

    kernel.openPopover(parent.id);
    await settle();
    expect(backend.present.has(child.id as string)).toBe(true);
    expect(backend.frames.at(-1)?.escape).not.toBeNull();
    expect(kernel.activeSubSurfaceTrigger()).toBe(parent.id);

    kernel.closeSubSurface();
    await settle();
    expect(backend.present.has(child.id as string)).toBe(false);
    expect(kernel.activeSubSurfaceTrigger()).toBeNull();
    expect(backend.frames.at(-1)?.escape).toBeNull();
    kernel.destroy();
  });

  it('escape() / closeSubSurface dismisses pet-style popover children', async () => {
    const backend = new FakeBackend();
    const kernel = new AIBarKernel({
      adapter: makeAdapter(),
      definition: { defaultItemIdentifiers: [] },
    });
    kernel.attach(backend, {});
    const yard = defineItem({
      id: asItemIdentifier('t.aibar.custom.yard'),
      type: 'custom',
      customKind: 'yard',
      labelKey: 'yard',
      parity: 'page:pet',
      width: { min: 160, preferred: 480, max: Number.POSITIVE_INFINITY, flex: 2 },
    });
    const open = childButton('open');
    const parent = defineItem({
      id: asItemIdentifier('t.aibar.popover.pet'),
      type: 'popover',
      labelKey: 'pet',
      parity: 'page:pet',
      zone: 'system',
      children: [yard, open],
    });
    kernel.register(parent);
    await settle();
    kernel.openPopover(parent.id);
    await settle();
    expect(backend.present.has(yard.id as string)).toBe(true);
    expect(backend.frames.at(-1)?.escape?.id).toBe('core.aibar.button.escape-close');
    // Trigger is omitted from the system strip while its popover is showing.
    expect(backend.present.has(parent.id as string)).toBe(false);

    kernel.escape();
    await settle();
    expect(backend.present.has(yard.id as string)).toBe(false);
    expect(backend.present.has(parent.id as string)).toBe(true);
    kernel.destroy();
  });

  it('system-zone popover hides liveStatus so agent chrome does not sit in the yard', async () => {
    const backend = new FakeBackend();
    const kernel = new AIBarKernel({
      adapter: makeAdapter(),
      definition: { defaultItemIdentifiers: [] },
    });
    kernel.attach(backend, {});
    const liveId = asItemIdentifier('t.aibar.livestatus.runs');
    const live = defineItem({
      id: liveId,
      type: 'liveStatus',
      labelKey: 'aibar.agentThinking',
      zone: 'system',
      parity: 'page:tasks',
    });
    const yard = defineItem({
      id: asItemIdentifier('t.aibar.custom.yard'),
      type: 'custom',
      customKind: 'yard',
      labelKey: 'yard',
      parity: 'page:pet',
      width: { min: 160, preferred: 480, max: Number.POSITIVE_INFINITY, flex: 2 },
    });
    const pet = defineItem({
      id: asItemIdentifier('t.aibar.popover.pet'),
      type: 'popover',
      labelKey: 'pet',
      parity: 'page:pet',
      zone: 'system',
      children: [yard],
    });
    kernel.register(live);
    kernel.register(pet);
    await settle();
    expect(backend.present.has(liveId as string)).toBe(true);

    kernel.openPopover(pet.id);
    await settle();
    expect(backend.present.has(yard.id as string)).toBe(true);
    expect(backend.present.has(liveId as string)).toBe(false);

    kernel.closeSubSurface();
    await settle();
    expect(backend.present.has(liveId as string)).toBe(true);
    kernel.destroy();
  });

  it('Escape Zone ✕ dismisses a visible popover; fnMode cannot latch underneath', async () => {
    const backend = new FakeBackend();
    const kernel = new AIBarKernel({
      adapter: makeAdapter({
        fnModeItems: () => [
          {
            id: asItemIdentifier('t.aibar.button.alt'),
            type: 'button',
            labelKey: 'alt',
            parity: 'menu:alt',
          },
        ],
      }),
      definition: { defaultItemIdentifiers: [] },
    });
    kernel.attach(backend, {});
    const parent = toolsPopover([childButton('cut')]);
    kernel.register(parent);
    await settle();

    kernel.setFnMode(true);
    expect(kernel.state).toBe('fnMode');
    kernel.openPopover(parent.id);
    await settle();
    expect(kernel.state).not.toBe('fnMode');
    expect(kernel.activeSubSurfaceTrigger()).toBe(parent.id);

    // Block invisible fnMode under an expanded popover.
    kernel.setFnMode(true);
    expect(kernel.state).not.toBe('fnMode');

    kernel.escape();
    await settle();
    expect(kernel.activeSubSurfaceTrigger()).toBeNull();
    kernel.destroy();
  });

  it('invoking a popover child dismisses the popover (dismissPopover)', async () => {
    const backend = new FakeBackend();
    const kernel = new AIBarKernel({
      adapter: makeAdapter(),
      definition: { defaultItemIdentifiers: [] },
    });
    kernel.attach(backend, {});
    const onInvoke = vi.fn();
    const child = childButton('cut', { onInvoke });
    const parent = toolsPopover([child]);
    kernel.register(parent);
    await settle();
    kernel.openPopover(parent.id);
    await settle();
    await kernel.invoke(child.id);
    await settle();
    expect(onInvoke).toHaveBeenCalledOnce();
    expect(kernel.activeSubSurfaceTrigger()).toBeNull();
    expect(backend.present.has(child.id as string)).toBe(false);
    kernel.destroy();
  });

  it('invoke clears loading state after a thrown host callback', async () => {
    const kernel = new AIBarKernel({
      adapter: makeAdapter(),
      definition: { defaultItemIdentifiers: [] },
    });
    kernel.attach(new FakeBackend(), {});
    const id = asItemIdentifier('t.aibar.button.boom');
    const first = vi.fn(async () => {
      throw new Error('boom');
    });
    kernel.register({
      id,
      type: 'button',
      labelKey: 'boom',
      parity: 'menu:boom',
      onInvoke: first,
    });
    await settle();
    await kernel.invoke(id);
    expect(first).toHaveBeenCalledOnce();

    const second = vi.fn();
    // Same owner as register() ('host') — wire upsert must not steal ids.
    kernel.upsertWireItem(
      defineItem({
        id,
        type: 'button',
        labelKey: 'boom',
        parity: 'menu:boom',
        onInvoke: second,
      }),
      'host',
    );
    await kernel.invoke(id);
    expect(second).toHaveBeenCalledOnce();
    kernel.destroy();
  });

  it('inline expand splices children into the ground strip (no Escape swap)', async () => {
    const backend = new FakeBackend(720);
    const kernel = new AIBarKernel({
      adapter: makeAdapter(),
      definition: { defaultItemIdentifiers: [] },
      density: 'compact',
    });
    kernel.attach(backend, {});
    const sibling = childButton('model');
    const optA = childButton('auto');
    const optB = childButton('high');
    const parent = defineItem({
      id: asItemIdentifier('t.aibar.popover.reasoning'),
      type: 'popover',
      expand: 'inline',
      labelKey: 'reasoning',
      parity: 'menu:reasoning',
      children: [optA, optB],
    });
    kernel.register({ ...sibling, zone: 'contextual' });
    kernel.register({ ...parent, zone: 'contextual' });
    await settle();

    const beforeSibling = latestBoxes(backend).get(sibling.id as string);
    expect(beforeSibling).toBeTypeOf('number');
    expect(backend.present.has(parent.id as string)).toBe(true);
    expect(backend.present.has(optA.id as string)).toBe(false);

    kernel.openPopover(parent.id);
    await settle();
    expect(kernel.presentation()).toBe('ground');
    // Inline keeps Escape Zone empty; showsCloseButton is spliced in-band.
    expect(backend.frames.at(-1)?.escape).toBeNull();
    expect(backend.present.has(parent.id as string)).toBe(false);
    expect(backend.present.has(optA.id as string)).toBe(true);
    expect(backend.present.has(optB.id as string)).toBe(true);
    expect(backend.present.has('core.aibar.button.inline-collapse')).toBe(true);
    // Sibling stays on the ground strip (not vacated by a surface swap).
    expect(backend.present.has(sibling.id as string)).toBe(true);
    expect(kernel.activeSubSurfaceTrigger()).toBe(parent.id);

    await kernel.invoke(optA.id);
    await settle();
    expect(kernel.activeSubSurfaceTrigger()).toBeNull();
    expect(backend.present.has(parent.id as string)).toBe(true);
    expect(backend.present.has(optA.id as string)).toBe(false);
    expect(backend.present.has('core.aibar.button.inline-collapse')).toBe(false);
    kernel.destroy();
  });

  it('inline expand collapse key dismisses like NSPopoverTouchBarItem.showsCloseButton', async () => {
    const backend = new FakeBackend(720);
    const kernel = new AIBarKernel({
      adapter: makeAdapter(),
      definition: { defaultItemIdentifiers: [] },
      density: 'compact',
    });
    kernel.attach(backend, {});
    const optA = childButton('auto');
    const parent = defineItem({
      id: asItemIdentifier('t.aibar.popover.reasoning'),
      type: 'popover',
      expand: 'inline',
      labelKey: 'reasoning',
      parity: 'menu:reasoning',
      children: [optA],
    });
    kernel.register({ ...parent, zone: 'contextual' });
    await settle();

    kernel.openPopover(parent.id);
    await settle();
    expect(kernel.activeSubSurfaceTrigger()).toBe(parent.id);
    expect(backend.present.has('core.aibar.button.inline-collapse')).toBe(true);

    await kernel.invoke(asItemIdentifier('core.aibar.button.inline-collapse'));
    await settle();
    expect(kernel.activeSubSurfaceTrigger()).toBeNull();
    expect(backend.present.has(parent.id as string)).toBe(true);
    expect(backend.present.has(optA.id as string)).toBe(false);
    expect(backend.present.has('core.aibar.button.inline-collapse')).toBe(false);
    kernel.destroy();
  });

  it('inline expand toggles closed on second openPopover of the same trigger', async () => {
    const backend = new FakeBackend(720);
    const kernel = new AIBarKernel({
      adapter: makeAdapter(),
      definition: { defaultItemIdentifiers: [] },
      density: 'compact',
    });
    kernel.attach(backend, {});
    const optA = childButton('auto');
    const parent = defineItem({
      id: asItemIdentifier('t.aibar.popover.reasoning'),
      type: 'popover',
      expand: 'inline',
      labelKey: 'reasoning',
      parity: 'menu:reasoning',
      children: [optA],
    });
    kernel.register({ ...parent, zone: 'contextual' });
    await settle();
    kernel.openPopover(parent.id);
    await settle();
    expect(kernel.activeSubSurfaceTrigger()).toBe(parent.id);
    kernel.openPopover(parent.id);
    await settle();
    expect(kernel.activeSubSurfaceTrigger()).toBeNull();
    expect(backend.present.has(optA.id as string)).toBe(false);
    kernel.destroy();
  });

  it('invoking a ground neighbor while inline-expanded collapses the expand first', async () => {
    const backend = new FakeBackend(720);
    const kernel = new AIBarKernel({
      adapter: makeAdapter(),
      definition: { defaultItemIdentifiers: [] },
      density: 'compact',
    });
    kernel.attach(backend, {});
    const onModel = vi.fn();
    const sibling = childButton('model', { onInvoke: onModel });
    const optA = childButton('auto');
    const parent = defineItem({
      id: asItemIdentifier('t.aibar.popover.reasoning'),
      type: 'popover',
      expand: 'inline',
      labelKey: 'reasoning',
      parity: 'menu:reasoning',
      children: [optA],
    });
    kernel.register({ ...sibling, zone: 'contextual' });
    kernel.register({ ...parent, zone: 'contextual' });
    await settle();
    kernel.openPopover(parent.id);
    await settle();
    expect(kernel.activeSubSurfaceTrigger()).toBe(parent.id);

    await kernel.invoke(sibling.id);
    await settle();
    expect(onModel).toHaveBeenCalledOnce();
    expect(kernel.activeSubSurfaceTrigger()).toBeNull();
    expect(backend.present.has(optA.id as string)).toBe(false);
    expect(backend.present.has(parent.id as string)).toBe(true);
    kernel.destroy();
  });

  it('opening a surface popover replaces an active inline expand', async () => {
    const backend = new FakeBackend(720);
    const kernel = new AIBarKernel({
      adapter: makeAdapter(),
      definition: { defaultItemIdentifiers: [] },
      density: 'compact',
    });
    kernel.attach(backend, {});
    const optA = childButton('auto');
    const inline = defineItem({
      id: asItemIdentifier('t.aibar.popover.reasoning'),
      type: 'popover',
      expand: 'inline',
      labelKey: 'reasoning',
      parity: 'menu:reasoning',
      children: [optA],
    });
    const yard = childButton('yard');
    const pet = defineItem({
      id: asItemIdentifier('com.leagent.aibar.popover.pet'),
      type: 'popover',
      labelKey: 'pet',
      parity: 'surface:pet',
      children: [yard],
    });
    kernel.register({ ...inline, zone: 'contextual' });
    kernel.register({ ...pet, zone: 'system' });
    await settle();
    kernel.openPopover(inline.id);
    await settle();
    expect(kernel.activeSubSurfaceTrigger()).toBe(inline.id);
    expect(kernel.presentation()).toBe('ground');

    kernel.openPopover(pet.id);
    await settle();
    expect(kernel.activeSubSurfaceTrigger()).toBe(pet.id);
    expect(kernel.presentation()).toBe('subsurface');
    expect(backend.present.has(optA.id as string)).toBe(false);
    expect(backend.present.has(yard.id as string)).toBe(true);
    kernel.destroy();
  });

  it('invoke timeout recovers the item from stuck loading', async () => {
    vi.useFakeTimers();
    try {
      const kernel = new AIBarKernel({
        adapter: makeAdapter(),
        definition: { defaultItemIdentifiers: [] },
      });
      kernel.attach(new FakeBackend(), {});
      const id = asItemIdentifier('t.aibar.button.hang');
      kernel.register({
        id,
        type: 'button',
        labelKey: 'hang',
        parity: 'menu:hang',
        // Never resolves — the 15s invoke race must win.
        onInvoke: () => new Promise(() => {}),
      });
      await vi.advanceTimersByTimeAsync(20);

      const pending = kernel.invoke(id);
      await vi.advanceTimersByTimeAsync(15_000);
      await pending;

      const second = vi.fn();
      kernel.upsertWireItem(
        defineItem({
          id,
          type: 'button',
          labelKey: 'hang',
          parity: 'menu:hang',
          onInvoke: second,
        }),
        'host',
      );
      // Error visual recovers after ERROR_RECOVERY_MS (2s).
      await vi.advanceTimersByTimeAsync(2_000);
      await kernel.invoke(id);
      expect(second).toHaveBeenCalledOnce();
      kernel.destroy();
    } finally {
      vi.useRealTimers();
    }
  }, 10_000);
});
