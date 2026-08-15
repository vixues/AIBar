/**
 * Phase 4 catalog contract tests: the full item set (FR-1), the scrubber
 * data-source/virtualization contract (§4.3, §7.6), hostItemsProxy surface
 * composition (§4.4), delegate lookup (§4.1), the extended compression
 * ladder (family merge, large homogeneous set → scrubber, §6.4), and the
 * Live Cluster morph (§2.3).
 */
import { describe, expect, it, vi } from 'vitest';
import { asItemIdentifier, validateItemSpec } from '@aibar/protocol';
import {
  AIBarKernel,
  defineItem,
  type ActionInvocation,
  type ActionOutcome,
  type AIBarEvent,
  type AIBarHostAdapter,
  type AIBarItem,
  type ItemRenderModel,
  type ItemVisualState,
  type MeasureRequest,
  type RendererBackend,
  type RenderFrame,
  type ScrubberEntry,
} from '@aibar/core';

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

function makeKernel(
  adapter = makeAdapter(),
  backend = new FakeBackend(),
  extra: Partial<ConstructorParameters<typeof AIBarKernel>[0]> = {},
) {
  const kernel = new AIBarKernel({
    adapter,
    definition: {
      customizationIdentifier: 'test.aibar.main',
      defaultItemIdentifiers: [],
      ...extra.definition,
    },
    ...extra,
  });
  kernel.attach(backend, {});
  return { kernel, adapter, backend };
}

describe('wire validation for the extended catalog', () => {
  const base = { id: 'pub.aibar.slider.x', labelKey: 'k', parity: 'menu:x' };

  it('rejects in-process-only types from the wire (INV-A3)', () => {
    for (const type of ['scrubber', 'hostItemsProxy', 'custom'] as const) {
      const res = validateItemSpec({ ...base, id: `pub.aibar.${type.toLowerCase()}.x`, type });
      expect(res.ok).toBe(false);
      expect(res.errors.join()).toContain('in-process only');
    }
  });

  it('validates slider payload bounds', () => {
    expect(
      validateItemSpec({ ...base, type: 'slider', slider: { min: 0, max: 10, value: 5 } }).ok,
    ).toBe(true);
    expect(validateItemSpec({ ...base, type: 'slider' }).ok).toBe(false);
    expect(
      validateItemSpec({ ...base, type: 'slider', slider: { min: 10, max: 0, value: 5 } }).ok,
    ).toBe(false);
    expect(
      validateItemSpec({ ...base, type: 'slider', slider: { min: 0, max: 10, value: 99 } }).ok,
    ).toBe(false);
  });

  it('validates colorPicker swatches and candidateList candidates', () => {
    const cp = { ...base, id: 'pub.aibar.colorpicker.x', type: 'colorPicker' as const };
    expect(validateItemSpec({ ...cp, swatches: ['#fff', '#000'] }).ok).toBe(true);
    expect(validateItemSpec({ ...cp, swatches: [] }).ok).toBe(false);
    expect(validateItemSpec({ ...cp, swatches: Array(17).fill('#fff') }).ok).toBe(false);

    const cl = { ...base, id: 'pub.aibar.candidatelist.x', type: 'candidateList' as const };
    expect(validateItemSpec({ ...cl, candidates: ['a', 'b'] }).ok).toBe(true);
    expect(validateItemSpec({ ...cl, candidates: [] }).ok).toBe(false);
  });
});

describe('slider (§3.3)', () => {
  it('renders the slider payload and clamps changeValue through onSliderChange', async () => {
    const { kernel, backend } = makeKernel();
    const changes: number[] = [];
    const id = asItemIdentifier('t.aibar.slider.vol');
    kernel.register({
      id,
      type: 'slider',
      labelKey: 'vol',
      parity: 'menu:vol',
      slider: { min: 0, max: 100, value: 30, step: 5 },
      onSliderChange: (_ctx, v) => changes.push(v),
    });
    await settle();
    expect(backend.present.get(id)?.slider).toEqual({ min: 0, max: 100, value: 30, step: 5 });

    kernel.inputSink().changeValue!(id, 250);
    expect(changes).toEqual([100]); // clamped to max
  });
});

describe('scrubber data source + virtualization (§4.3, §7.6)', () => {
  function bigScrubber(count = 100) {
    const onSelect = vi.fn<(index: number, entry: ScrubberEntry) => void>();
    const item = defineItem({
      id: asItemIdentifier('t.aibar.scrubber.sessions'),
      type: 'scrubber',
      labelKey: 'sessions',
      parity: 'menu:sessions',
      scrubber: {
        dataSource: {
          count: () => count,
          itemAt: (i) => ({ label: `entry-${i}` }),
          keyOf: (_e, i) => `k${i}`,
        },
        delegate: { onSelect, selectionMode: 'leading', layout: { kind: 'fixed', itemWidth: 60 } },
      },
    });
    return { item, onSelect };
  }

  it('renders an O(viewport) slice, never the full set', async () => {
    const { kernel, backend } = makeKernel();
    const { item } = bigScrubber(5000);
    kernel.register(item);
    await settle();
    const model = backend.present.get(item.id)!;
    expect(model.scrubber?.count).toBe(5000);
    expect(model.scrubber?.slice.start).toBe(0);
    expect(model.scrubber!.slice.entries.length).toBeLessThanOrEqual(32); // 24 + 2×4 overscan
    expect(model.scrubber?.itemWidth).toBe(60);
  });

  it('scrubTo moves the slice; selectIndex reaches the delegate', async () => {
    const { kernel, backend } = makeKernel();
    // Above SCRUBBER_FULL_PAINT_MAX so windowing is active.
    const { item, onSelect } = bigScrubber(5000);
    kernel.register(item);
    await settle();

    kernel.inputSink().scrubTo!(item.id, 50);
    await settle();
    expect(backend.present.get(item.id)?.scrubber?.slice.start).toBe(46); // 50 − overscan(4)

    kernel.inputSink().selectIndex!(item.id, 51);
    expect(onSelect).toHaveBeenCalledWith(51, { label: 'entry-51' });
    await settle();
    expect(backend.present.get(item.id)?.scrubber?.selectedIndex).toBe(51);
    kernel.inputSink().selectIndex!(item.id, 10000); // out of range → ignored
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

describe('colorPicker / candidateList routing', () => {
  it('selectSegment routes to onSelectColor / onSelectCandidate', async () => {
    const { kernel } = makeKernel();
    const colors: string[] = [];
    const picks: string[] = [];
    kernel.register({
      id: asItemIdentifier('t.aibar.colorpicker.c'),
      type: 'colorPicker',
      labelKey: 'c',
      parity: 'menu:c',
      swatches: ['#f00', '#0f0'],
      onSelectColor: (_ctx, color) => colors.push(color),
    });
    kernel.register({
      id: asItemIdentifier('t.aibar.candidatelist.words'),
      type: 'candidateList',
      labelKey: 'w',
      parity: 'none:input-system',
      candidates: ['hello', 'world'],
      onSelectCandidate: (_ctx, v) => picks.push(v),
    });
    await settle();
    kernel.inputSink().selectSegment(asItemIdentifier('t.aibar.colorpicker.c'), '#0f0');
    kernel.inputSink().selectSegment(asItemIdentifier('t.aibar.candidatelist.words'), 'world');
    expect(colors).toEqual(['#0f0']);
    expect(picks).toEqual(['world']);
  });
});

describe('hostItemsProxy (§4.4)', () => {
  it('inlines proxied items into the flattened sequence', async () => {
    const { kernel, backend } = makeKernel();
    const inner: AIBarItem[] = [
      defineItem({
        id: asItemIdentifier('outer.aibar.button.one'),
        type: 'button',
        labelKey: 'one',
        parity: 'menu:one',
      }),
      defineItem({
        id: asItemIdentifier('outer.aibar.button.two'),
        type: 'button',
        labelKey: 'two',
        parity: 'menu:two',
      }),
    ];
    const proxyId = asItemIdentifier('t.aibar.hostitemsproxy.outer');
    kernel.register({
      id: proxyId,
      type: 'hostItemsProxy',
      labelKey: 'outer',
      parity: 'none:proxy',
      proxyItems: () => inner,
    });
    await settle();
    expect(backend.present.has('outer.aibar.button.one')).toBe(true);
    expect(backend.present.has('outer.aibar.button.two')).toBe(true);
    expect(backend.present.has(proxyId)).toBe(false);
  });

  it('truncates cycles instead of recursing (A proxies A)', async () => {
    const { kernel, backend } = makeKernel();
    const proxyId = asItemIdentifier('t.aibar.hostitemsproxy.self');
    const self: AIBarItem = defineItem({
      id: proxyId,
      type: 'hostItemsProxy',
      labelKey: 'self',
      parity: 'none:proxy',
    });
    self.proxyItems = () => [self];
    kernel.registry.upsert(self, 'host');
    await settle();
    expect(backend.present.has(proxyId)).toBe(false); // no infinite loop, no node
  });
});

describe('delegate lookup (§4.1)', () => {
  it('templateItems → makeItem → unresolved diagnostic, cached per id', async () => {
    const tplId = asItemIdentifier('t.aibar.button.tpl');
    const madeId = asItemIdentifier('t.aibar.button.made');
    const missingId = asItemIdentifier('t.aibar.button.missing');
    const makeItem = vi.fn((id: string) =>
      id === madeId
        ? defineItem({ id: madeId, type: 'button', labelKey: 'made', parity: 'menu:made' })
        : null,
    );
    const backend = new FakeBackend();
    const { kernel } = makeKernel(makeAdapter(), backend, {
      definition: {
        customizationIdentifier: 'test.aibar.main',
        defaultItemIdentifiers: [tplId, madeId, missingId],
      },
      templateItems: new Map([
        [tplId, defineItem({ id: tplId, type: 'button', labelKey: 'tpl', parity: 'menu:tpl' })],
      ]),
      delegate: { makeItem },
    });
    const events: AIBarEvent[] = [];
    kernel.onEvent((e) => events.push(e));
    kernel.scheduleResolve();
    await settle();

    expect(backend.present.has(tplId)).toBe(true);
    expect(backend.present.has(madeId)).toBe(true);
    expect(events.some((e) => e.type === 'aibar.item.unresolved' && e.id === missingId)).toBe(true);
    expect(makeItem).not.toHaveBeenCalledWith(tplId, expect.anything()); // template wins

    const calls = makeItem.mock.calls.length;
    kernel.scheduleResolve();
    await settle();
    expect(makeItem.mock.calls.length).toBe(calls); // cached — one attempt per id

    kernel.invalidateItem(madeId);
    await settle();
    expect(makeItem.mock.calls.length).toBeGreaterThan(calls); // invalidate reconstructs
  });
});

describe('Live Cluster morph (§2.3)', () => {
  it('keeps ≤3 liveStatus items direct and folds the rest into a count popover', async () => {
    const { kernel, backend } = makeKernel();
    for (let i = 0; i < 5; i++) {
      kernel.register({
        id: asItemIdentifier(`t.aibar.livestatus.run-${i}`),
        type: 'liveStatus',
        labelKey: `run-${i}`,
        parity: 'none:live',
        visibilityPriority: i, // run-4..run-2 win
      });
    }
    await settle();
    const liveShown = [...backend.present.values()].filter((m) => m.type === 'liveStatus');
    expect(liveShown.length).toBe(3);
    const cluster = backend.present.get('core.aibar.popover.live-cluster');
    expect(cluster).toBeDefined();
    expect(cluster?.hasChildren).toBe(true);

    // Cluster popover opens onto the folded runs.
    kernel.openPopover(asItemIdentifier('core.aibar.popover.live-cluster'));
    await settle();
    expect(backend.present.has('t.aibar.livestatus.run-0')).toBe(true);
  });

  it('pulses morphing on a significant run event, rate-limited to 10s per run', async () => {
    vi.useFakeTimers();
    try {
      const provider = {
        id: 'runs',
        collect: () => ({
          runs: [
            {
              runId: 'run-a',
              kind: 'task',
              status: 'running' as const,
            },
          ],
        }),
        subscribe: () => () => {},
      };
      const { kernel, backend } = makeKernel(
        makeAdapter({ contextProviders: [provider] }),
      );
      kernel.register({
        id: asItemIdentifier('t.aibar.livestatus.run-a'),
        type: 'liveStatus',
        labelKey: 'run-a',
        parity: 'none:live',
      });
      await vi.advanceTimersByTimeAsync(20);
      const model = backend.present.get('t.aibar.livestatus.run-a');
      expect(model?.morphing).toBe(true);

      // Second resolve within the 10s window must not re-arm morph after it ends.
      await vi.advanceTimersByTimeAsync(300);
      kernel.scheduleResolve();
      await vi.advanceTimersByTimeAsync(20);
      expect(backend.present.get('t.aibar.livestatus.run-a')?.morphing).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('compression ladder extensions (§6.4)', () => {
  it('folds same-family items into one group under budget pressure', async () => {
    const backend = new FakeBackend(220);
    const { kernel } = makeKernel(makeAdapter(), backend);
    for (const key of ['a', 'b', 'c', 'd', 'e', 'f']) {
      kernel.register({
        id: asItemIdentifier(`t.aibar.button.${key}`),
        type: 'button',
        labelKey: `nav-${key}`,
        parity: `menu:${key}`,
        family: 'nav',
        width: { min: 80, preferred: 110, max: 140 },
      });
    }
    await settle();
    expect(backend.present.has('core.aibar.group.family-nav')).toBe(true);
    // The merged group opens onto its members.
    kernel.openPopover(asItemIdentifier('core.aibar.group.family-nav'));
    await settle();
    expect(backend.present.has('t.aibar.button.a')).toBe(true);
  });

  it('collapses a large homogeneous group into a scrubber, not a popover', async () => {
    const backend = new FakeBackend(300);
    const { kernel } = makeKernel(makeAdapter(), backend);
    const gid = asItemIdentifier('t.aibar.group.pages');
    kernel.register({
      id: gid,
      type: 'group',
      labelKey: 'pages',
      parity: 'menu:pages',
      children: Array.from({ length: 10 }, (_, i) =>
        defineItem({
          id: asItemIdentifier(`t.aibar.button.page-${i}`),
          type: 'button',
          labelKey: `page-${i}`,
          parity: `menu:page-${i}`,
          width: { min: 60, preferred: 80, max: 100 },
        }),
      ),
    });
    await settle();
    const model = backend.present.get(gid)!;
    expect(model.type).toBe('scrubber');
    expect(model.scrubber?.count).toBe(10);

    // Ladder scrubber select = invoke the underlying child.
    const invoked: string[] = [];
    kernel.onEvent((e) => {
      if (e.type === 'aibar.action.invoked') invoked.push(e.id);
    });
    kernel.inputSink().selectIndex!(gid, 4);
    await settle();
    expect(invoked).toContain('t.aibar.button.page-4');
  });
});
