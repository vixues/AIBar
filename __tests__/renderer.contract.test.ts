/**
 * DOM renderer contract tests (docs/aibar-architecture.md §7.4):
 * - commit applies geometry via transform/width only,
 * - commit performs zero DOM reads (probe on layout-read APIs),
 * - ARIA toolbar semantics + §8.2 keyboard map.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asItemIdentifier } from '@aibar/protocol';
import type { ItemRenderModel, RenderFrame, SurfaceInputSink } from '@aibar/core';
import { DOMRendererBackend } from '@aibar/renderer-dom';

function model(overrides: Partial<ItemRenderModel> = {}): ItemRenderModel {
  return {
    type: 'button',
    label: 'Run',
    showsLabel: true,
    tooltip: 'Run',
    badge: 'none',
    principal: false,
    effect: 'read',
    provenance: { kind: 'host' },
    parity: 'menu:run',
    ...overrides,
  };
}

function frame(
  ops: RenderFrame['ops'],
  order: string[] = [],
  escape: RenderFrame['escape'] = null,
): RenderFrame {
  return {
    epoch: 1,
    surfaceBox: { width: 800, height: 52 },
    order: order.map((id) => asItemIdentifier(id)),
    ops,
    escape,
  };
}

function makeSink(): SurfaceInputSink {
  return {
    invoke: vi.fn(),
    selectSegment: vi.fn(),
    selectIndex: vi.fn(),
    scrubTo: vi.fn(),
    openPopover: vi.fn(),
    escape: vi.fn(),
    dismiss: vi.fn(),
    approve: vi.fn(),
  };
}

const A = asItemIdentifier('t.aibar.button.a');
const B = asItemIdentifier('t.aibar.button.b');

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
  document.body.innerHTML = '';
});

function mounted(sink = makeSink()) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const backend = new DOMRendererBackend({ ariaLabel: 'AIBar' });
  backend.mount(host, sink);
  cleanup.push(() => backend.destroy());
  return { backend, host, sink };
}

describe('DOMRendererBackend contract', () => {
  it('applies geometry exclusively via transform + width', () => {
    const { backend, host } = mounted();
    backend.commit(
      frame(
        [{ kind: 'create', id: A, node: model(), box: { x: 120, width: 88 } }],
        [A],
      ),
    );
    const el = host.querySelector<HTMLElement>('[data-aibar-id]')!;
    expect(el.style.transform).toBe('translateX(120px)');
    expect(el.style.width).toBe('88px');
    expect(el.style.left).toBe('');
    expect(el.style.marginLeft).toBe('');

    backend.commit(frame([{ kind: 'move', id: A, box: { x: 40, width: 88 } }], [A]));
    expect(el.style.transform).toBe('translateX(40px)');
  });

  it('performs zero DOM reads inside commit (D1 probe)', () => {
    const { backend } = mounted();

    const rectSpy = vi
      .spyOn(Element.prototype, 'getBoundingClientRect')
      .mockImplementation(() => {
        throw new Error('layout read inside commit');
      });
    const offsetSpy = vi
      .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
      .mockImplementation(() => {
        throw new Error('layout read inside commit');
      });
    cleanup.push(() => {
      rectSpy.mockRestore();
      offsetSpy.mockRestore();
    });

    expect(() =>
      backend.commit(
        frame(
          [
            { kind: 'create', id: A, node: model(), box: { x: 0, width: 60 } },
            { kind: 'create', id: B, node: model({ type: 'toggle' }), box: { x: 70, width: 60 } },
            { kind: 'state', id: A, state: 'loading' },
            { kind: 'update', id: B, patch: { label: 'Other' }, box: { x: 80, width: 64 } },
            { kind: 'remove', id: A },
          ],
          [B],
        ),
      ),
    ).not.toThrow();
    expect(rectSpy).not.toHaveBeenCalled();
  });

  it('exposes ARIA toolbar semantics and state attributes', () => {
    const { backend, host } = mounted();
    backend.commit(
      frame(
        [
          { kind: 'create', id: A, node: model(), box: { x: 0, width: 60 } },
          { kind: 'state', id: A, state: 'loading' },
        ],
        [A],
      ),
    );
    const root = host.querySelector('.aibar-root')!;
    expect(root.getAttribute('role')).toBe('toolbar');
    expect(root.getAttribute('aria-label')).toBe('AIBar');
    const el = host.querySelector<HTMLElement>('[data-aibar-id]')!;
    expect(el.dataset.state).toBe('loading');
    expect(el.getAttribute('aria-busy')).toBe('true');
  });

  it('liveStatus paints phase icon instead of ring when icon is set', () => {
    const { backend, host } = mounted();
    backend.commit(
      frame(
        [
          {
            kind: 'create',
            id: A,
            node: model({
              type: 'liveStatus',
              label: 'Agent thinking',
              icon: { kind: 'text', text: '🧠' },
              livePhase: 'thinking',
              liveTone: 'ok',
              morphing: true,
            }),
            box: { x: 0, width: 120 },
          },
        ],
        [A],
      ),
    );
    const el = host.querySelector<HTMLElement>('[data-aibar-id]')!;
    expect(el.dataset.type).toBe('liveStatus');
    expect(el.dataset.phase).toBe('thinking');
    expect(el.dataset.tone).toBe('ok');
    expect(el.dataset.morphing).toBe('true');
    expect(el.querySelector('.aibar-live-icon')?.textContent).toBe('🧠');
    expect(el.querySelector('.aibar-live-ring')).toBeNull();
    expect(el.querySelector('.aibar-item__label')?.textContent).toBe('Agent thinking');
  });

  it('roving tabindex: arrows move focus, single tab stop, Escape reaches the sink', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
    backend.commit(
      frame(
        [
          { kind: 'create', id: A, node: model({ label: 'A' }), box: { x: 0, width: 60 } },
          { kind: 'create', id: B, node: model({ label: 'B' }), box: { x: 70, width: 60 } },
        ],
        [A, B],
      ),
    );
    const root = host.querySelector<HTMLElement>('.aibar-root')!;
    const buttons = [...host.querySelectorAll<HTMLElement>('[data-aibar-id]')];
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);

    buttons[0]!.focus(); // enter the toolbar at its single tab stop
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement?.getAttribute('data-aibar-id')).toBe(B);
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(document.activeElement?.getAttribute('data-aibar-id')).toBe(A);

    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(sink.escape).toHaveBeenCalledOnce();
  });

  it('click delegation routes to invoke / dismiss / approve', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
    const S = asItemIdentifier('t.aibar.suggestion.s');
    const P = asItemIdentifier('t.aibar.approval.p');
    backend.commit(
      frame(
        [
          { kind: 'create', id: A, node: model(), box: { x: 0, width: 60 } },
          {
            kind: 'create',
            id: S,
            node: model({ type: 'suggestion', label: 'Try', confidenceTier: 3, reasonText: 'why' }),
            box: { x: 70, width: 120 },
          },
          {
            kind: 'create',
            id: P,
            node: model({ type: 'approval', intentSummary: 'Delete 3 files' }),
            box: { x: 200, width: 180 },
          },
        ],
        [A, S, P],
      ),
    );
    host.querySelector<HTMLElement>(`[data-aibar-id="${A}"]`)!.click();
    expect(sink.invoke).toHaveBeenCalledWith(A);

    host
      .querySelector<HTMLElement>(`[data-aibar-id="${S}"] [data-dismiss]`)!
      .click();
    expect(sink.dismiss).toHaveBeenCalledWith(S);

    host
      .querySelector<HTMLElement>(`[data-aibar-id="${P}"] [data-decision="deny"]`)!
      .click();
    expect(sink.approve).toHaveBeenCalledWith(P, 'deny');
  });

  it('Escape Zone ✕ receives clicks above the full-bleed items layer', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
    const CLOSE = asItemIdentifier('core.aibar.button.escape-close');
    backend.commit(
      frame(
        // Item starts after the escape inset, but the items layer itself is full-bleed.
        [{ kind: 'create', id: A, node: model({ label: 'Yard' }), box: { x: 36, width: 400 } }],
        [A],
        {
          id: CLOSE,
          node: model({ label: 'Close', showsLabel: false, icon: { kind: 'text', text: '✕' } }),
        },
      ),
    );
    const escapeBtn = host.querySelector<HTMLElement>('.aibar-escape [data-aibar-id]')!;
    expect(escapeBtn).toBeTruthy();
    escapeBtn.click();
    expect(sink.escape).toHaveBeenCalledOnce();
    expect(sink.invoke).not.toHaveBeenCalled();
  });

  it('presentation swap crossfades: outgoing stays until enter overlaps', () => {
    vi.useFakeTimers();
    try {
      const { backend, host } = mounted();
      backend.commit({
        ...frame([{ kind: 'create', id: A, node: model(), box: { x: 2, width: 60 } }], [A]),
        presentation: 'ground',
        presentationChanged: false,
      });
      const root = host.querySelector<HTMLElement>('.aibar-root')!;
      expect(root.dataset.presentation).toBe('ground');

      const CLOSE = asItemIdentifier('core.aibar.button.escape-close');
      backend.commit({
        epoch: 2,
        surfaceBox: { width: 800, height: 52 },
        order: [B],
        ops: [
          { kind: 'remove', id: A },
          { kind: 'create', id: B, node: model({ label: 'Child' }), box: { x: 36, width: 80 } },
        ],
        escape: {
          id: CLOSE,
          node: model({ label: 'Close', showsLabel: false, icon: { kind: 'text', text: '✕' } }),
        },
        presentation: 'subsurface',
        presentationChanged: true,
      });
      expect(root.dataset.presentation).toBe('subsurface');
      expect(root.dataset.presentationSwap).toBe('1');
      expect(root.dataset.swapTo).toBe('subsurface');
      // Overlapping crossfade: leaver still in DOM with data-leaving.
      const leaving = host.querySelector<HTMLElement>(`[data-aibar-id="${A}"]`);
      expect(leaving?.dataset.leaving).toBe('ground');
      const entering = host.querySelector<HTMLElement>(`[data-aibar-id="${B}"]`);
      expect(entering?.dataset.swapEnter).toBe('subsurface');
      expect(host.querySelector('.aibar-escape')!.dataset.aibarEscapeId).toBe(CLOSE);

      vi.advanceTimersByTime(160);
      expect(host.querySelector(`[data-aibar-id="${A}"]`)).toBeNull();
      expect(entering?.dataset.swapEnter).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders approval with Deny nearest the escape zone and announces assertively', () => {
    const { backend, host } = mounted();
    const P = asItemIdentifier('t.aibar.approval.p');
    backend.commit(
      frame(
        [
          {
            kind: 'create',
            id: P,
            node: model({ type: 'approval', intentSummary: 'Send email to 3 people' }),
            box: { x: 0, width: 200 },
          },
        ],
        [P],
      ),
    );
    const decisions = [
      ...host.querySelectorAll<HTMLElement>(`[data-aibar-id="${P}"] [data-decision]`),
    ].map((el) => el.dataset.decision);
    expect(decisions).toEqual(['deny', 'allow']);
    const assertive = host.querySelector('[aria-live="assertive"]')!;
    expect(assertive.textContent).toBe('Send email to 3 people');
  });

  it('context remove soft-leaves with data-leaving=context', () => {
    vi.useFakeTimers();
    try {
      const { backend, host } = mounted();
      backend.commit(
        frame([{ kind: 'create', id: A, node: model(), box: { x: 0, width: 60 } }], [A]),
      );
      backend.commit(frame([{ kind: 'remove', id: A }], []));
      const leaving = host.querySelector<HTMLElement>(`[data-aibar-id="${A}"]`);
      expect(leaving?.dataset.leaving).toBe('context');
      vi.advanceTimersByTime(120);
      expect(host.querySelector(`[data-aibar-id="${A}"]`)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('survivor move sets data-moving while keeping translateX geometry', () => {
    vi.useFakeTimers();
    try {
      const { backend, host } = mounted();
      backend.commit(
        frame([{ kind: 'create', id: A, node: model(), box: { x: 0, width: 60 } }], [A]),
      );
      const el = host.querySelector<HTMLElement>('[data-aibar-id]')!;
      backend.commit(frame([{ kind: 'move', id: A, box: { x: 48, width: 60 } }], [A]));
      expect(el.style.transform).toBe('translateX(48px)');
      expect(el.dataset.moving).toBe('true');
      vi.advanceTimersByTime(160);
      expect(el.dataset.moving).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('slider builds accent fill track + value tip chrome', () => {
    const { backend, host } = mounted();
    const S = asItemIdentifier('t.aibar.slider.s');
    backend.commit(
      frame(
        [
          {
            kind: 'create',
            id: S,
            node: model({
              type: 'slider',
              label: 'Volume',
              slider: { min: 0, max: 100, value: 25, step: 1 },
            }),
            box: { x: 0, width: 160 },
          },
        ],
        [S],
      ),
    );
    const item = host.querySelector<HTMLElement>(`[data-aibar-id="${S}"]`)!;
    expect(item.querySelector('.aibar-slider__track')).toBeTruthy();
    const fill = item.querySelector<HTMLElement>('.aibar-slider__fill')!;
    expect(fill.style.transform).toBe('scaleX(0.25)');
    expect(item.querySelector('.aibar-slider__input')).toBeTruthy();
    expect(item.querySelector('.aibar-slider__value')).toBeTruthy();
    expect(item.querySelector('.aibar-suggestion-body')).toBeNull();
  });

  it('scrubber paints selectedIndex and suggestion body uses token class', () => {
    const { backend, host } = mounted();
    const SCR = asItemIdentifier('t.aibar.scrubber.s');
    const SUG = asItemIdentifier('t.aibar.suggestion.s');
    backend.commit(
      frame(
        [
          {
            kind: 'create',
            id: SCR,
            node: model({
              type: 'scrubber',
              scrubber: {
                count: 4,
                slice: {
                  start: 0,
                  entries: [
                    { key: 'a', label: 'A' },
                    { key: 'b', label: 'B', imageUrl: '/api/v1/files/x/preview' },
                    { key: 'c', label: 'C' },
                    { key: 'd', label: 'D' },
                  ],
                },
                layout: 'fixed',
                itemWidth: 48,
                selectedIndex: 2,
              },
            }),
            box: { x: 0, width: 180 },
          },
          {
            kind: 'create',
            id: SUG,
            node: model({ type: 'suggestion', label: 'Export', confidenceTier: 2 }),
            box: { x: 200, width: 120 },
          },
        ],
        [SCR, SUG],
      ),
    );
    const selected = host.querySelector<HTMLElement>(
      `[data-aibar-id="${SCR}"] .aibar-scrubber__item[data-selected="true"]`,
    )!;
    expect(selected?.dataset.scrubberIndex).toBe('2');
    expect(selected?.getAttribute('aria-selected')).toBe('true');
    const thumb = host.querySelector(
      `[data-aibar-id="${SCR}"] .aibar-scrubber__item[data-scrubber-index="1"] img.aibar-scrubber__thumb`,
    );
    expect(thumb).toBeTruthy();
    expect((thumb as HTMLImageElement).src).toContain('/api/v1/files/x/preview');
    const body = host.querySelector<HTMLElement>(
      `[data-aibar-id="${SUG}"] .aibar-suggestion-body`,
    )!;
    expect(body).toBeTruthy();
    expect(body.getAttribute('style') ?? '').toBe('');
  });

  it('candidateList paints an inner free-scroll strip', () => {
    const { backend, host } = mounted();
    const CL = asItemIdentifier('t.aibar.candidatelist.s');
    backend.commit(
      frame(
        [
          {
            kind: 'create',
            id: CL,
            node: model({
              type: 'candidateList',
              candidates: ['总结上文要点', 'Explain this code', 'Find and fix the bug'],
            }),
            box: { x: 0, width: 200 },
          },
        ],
        [CL],
      ),
    );
    const scroll = host.querySelector(`[data-aibar-id="${CL}"] .aibar-candidate__scroll`);
    const track = host.querySelector(`[data-aibar-id="${CL}"] .aibar-candidate__track`);
    const opts = host.querySelectorAll(`[data-aibar-id="${CL}"] .aibar-candidate`);
    expect(scroll).toBeTruthy();
    expect(track).toBeTruthy();
    expect(opts.length).toBe(3);
  });
});

describe('DOMRendererBackend free-scroll strips', () => {
  function pointer(
    type: 'pointerdown' | 'pointermove' | 'pointerup',
    target: EventTarget,
    clientX: number,
    pointerId = 1,
  ): PointerEvent {
    const ev = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
      clientX,
      clientY: 10,
      pointerId,
      pointerType: 'mouse',
    });
    target.dispatchEvent(ev);
    return ev;
  }

  it('candidate tap: pointerdown does not preventDefault; click selects', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
    const CL = asItemIdentifier('t.aibar.candidatelist.tap');
    backend.commit(
      frame(
        [
          {
            kind: 'create',
            id: CL,
            node: model({
              type: 'candidateList',
              candidates: ['总结上文要点', 'Explain this code'],
            }),
            box: { x: 0, width: 160 },
          },
        ],
        [CL],
      ),
    );
    const opt = host.querySelector<HTMLElement>(
      `[data-aibar-id="${CL}"] .aibar-candidate`,
    )!;
    const down = pointer('pointerdown', opt, 20);
    expect(down.defaultPrevented).toBe(false);
    pointer('pointerup', opt, 20);
    opt.click(); // suppressed — armed tap already selected on pointerup
    expect(sink.selectSegment).toHaveBeenCalledOnce();
    expect(sink.selectSegment).toHaveBeenCalledWith(CL, '总结上文要点');
  });

  it('popover / pet-style button: pointerdown does not preventDefault; click opens', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
    const PET = asItemIdentifier('com.leagent.aibar.popover.pet');
    const EMOJI = asItemIdentifier('com.leagent.aibar.popover.emoji');
    backend.commit(
      frame(
        [
          {
            kind: 'create',
            id: PET,
            node: model({
              type: 'popover',
              label: 'Pet',
              showsLabel: false,
              hasChildren: true,
            }),
            box: { x: 0, width: 36 },
          },
          {
            kind: 'create',
            id: EMOJI,
            node: model({
              type: 'popover',
              label: 'Emoji',
              showsLabel: false,
              hasChildren: true,
              icon: { kind: 'text', text: '☺' },
            }),
            box: { x: 40, width: 32 },
          },
        ],
        [PET, EMOJI],
      ),
    );

    const petBtn = host.querySelector<HTMLElement>(`[data-aibar-id="${PET}"]`)!;
    const emojiBtn = host.querySelector<HTMLElement>(`[data-aibar-id="${EMOJI}"]`)!;
    expect(petBtn.tagName).toBe('BUTTON');
    expect(emojiBtn.tagName).toBe('BUTTON');

    const petDown = pointer('pointerdown', petBtn, 10);
    expect(petDown.defaultPrevented).toBe(false);
    pointer('pointerup', petBtn, 10);
    petBtn.click();
    expect(sink.openPopover).toHaveBeenCalledWith(PET);

    const emojiDown = pointer('pointerdown', emojiBtn, 50);
    expect(emojiDown.defaultPrevented).toBe(false);
    pointer('pointerup', emojiBtn, 50);
    emojiBtn.click();
    expect(sink.openPopover).toHaveBeenCalledWith(EMOJI);
  });

  it('survives buildContent rebuild between pointerdown and pointerup', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
    backend.commit(
      frame(
        [
          {
            kind: 'create',
            id: A,
            node: model({ label: 'deepseek-v4-flash · 1M' }),
            box: { x: 0, width: 140 },
          },
        ],
        [A],
      ),
    );
    const btn = host.querySelector<HTMLElement>(`[data-aibar-id="${A}"]`)!;
    const label = btn.querySelector<HTMLElement>('.aibar-item__label')!;
    expect(label.textContent).toBe('deepseek-v4-flash · 1M');

    pointer('pointerdown', label, 20);
    // Mid-gesture resolve update replaces children — the original label detaches.
    // Compatibility click on a detached target would miss closest('[data-aibar-id]').
    backend.commit(
      frame(
        [
          {
            kind: 'update',
            id: A,
            patch: model({ label: 'deepseek-v4-flash · 1M' }),
            box: { x: 0, width: 140 },
          },
        ],
        [A],
      ),
    );
    expect(label.isConnected).toBe(false);

    pointer('pointerup', host.querySelector('.aibar-root')!, 20);
    label.click(); // would no-op if we still relied on click alone
    expect(sink.invoke).toHaveBeenCalledOnce();
    expect(sink.invoke).toHaveBeenCalledWith(A);
  });

  it('candidate drag pans scrollLeft and suppresses the following click', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
    const CL = asItemIdentifier('t.aibar.candidatelist.pan');
    backend.commit(
      frame(
        [
          {
            kind: 'create',
            id: CL,
            node: model({
              type: 'candidateList',
              candidates: ['A', 'B', 'C', 'D', 'E', 'F'],
            }),
            box: { x: 0, width: 120 },
          },
        ],
        [CL],
      ),
    );
    const scroll = host.querySelector<HTMLElement>(
      `[data-aibar-id="${CL}"] .aibar-candidate__scroll`,
    )!;
    const opt = host.querySelector<HTMLElement>(
      `[data-aibar-id="${CL}"] .aibar-candidate`,
    )!;
    Object.defineProperty(scroll, 'scrollWidth', { configurable: true, value: 600 });
    Object.defineProperty(scroll, 'clientWidth', { configurable: true, value: 120 });
    scroll.scrollLeft = 0;

    pointer('pointerdown', opt, 100);
    pointer('pointermove', host.querySelector('.aibar-root')!, 40); // dx = -60 → scroll +60
    expect(scroll.scrollLeft).toBe(60);
    pointer('pointerup', host.querySelector('.aibar-root')!, 40);
    opt.click();
    expect(sink.selectSegment).not.toHaveBeenCalled();
  });

  it('candidate vertical wheel pans the strip horizontally', () => {
    const { backend, host } = mounted();
    const CL = asItemIdentifier('t.aibar.candidatelist.wheel');
    backend.commit(
      frame(
        [
          {
            kind: 'create',
            id: CL,
            node: model({
              type: 'candidateList',
              candidates: ['总结上文要点', '解释这段代码', 'Explain this code'],
            }),
            box: { x: 0, width: 160 },
          },
        ],
        [CL],
      ),
    );
    const item = host.querySelector<HTMLElement>(`[data-aibar-id="${CL}"]`)!;
    const scroll = host.querySelector<HTMLElement>(
      `[data-aibar-id="${CL}"] .aibar-candidate__scroll`,
    )!;
    // Packed box is the display viewport — never grow with phrase track width.
    expect(item.style.width).toBe('160px');
    Object.defineProperty(scroll, 'scrollWidth', { configurable: true, value: 720 });
    Object.defineProperty(scroll, 'clientWidth', { configurable: true, value: 160 });
    scroll.scrollLeft = 0;

    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaX: 0,
      deltaY: 40,
    });
    scroll.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(scroll.scrollLeft).toBe(40);
  });

  it('scrubber tap selects index; glyph category tap selects segment', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
    const SCR = asItemIdentifier('t.aibar.scrubber.emoji');
    const SEG = asItemIdentifier('t.aibar.segmented.emoji');
    backend.commit(
      frame(
        [
          {
            kind: 'create',
            id: SEG,
            node: model({
              type: 'segmented',
              segments: [
                { key: 'frequent', labelKey: 'aibar.emojiCatFrequent', label: '常用', glyph: '🕒' },
                { key: 'smileys', labelKey: 'aibar.emojiCatSmileys', label: '笑脸', glyph: '😀' },
              ],
              selectedSegment: 'frequent',
            }),
            box: { x: 0, width: 80 },
          },
          {
            kind: 'create',
            id: SCR,
            node: model({
              type: 'scrubber',
              scrubber: {
                count: 3,
                slice: {
                  start: 0,
                  entries: [
                    { key: '0', label: '👍' },
                    { key: '1', label: '😀' },
                    { key: '2', label: '🔥' },
                  ],
                },
                layout: 'fixed',
                itemWidth: 34,
              },
            }),
            box: { x: 90, width: 200 },
          },
        ],
        [SEG, SCR],
      ),
    );

    const tab = host.querySelector<HTMLElement>(
      `[data-aibar-id="${SEG}"] .aibar-segment[data-segment-key="smileys"]`,
    )!;
    const downTab = pointer('pointerdown', tab, 50);
    expect(downTab.defaultPrevented).toBe(false);
    pointer('pointerup', tab, 50);
    tab.click();
    expect(sink.selectSegment).toHaveBeenCalledWith(SEG, 'smileys');

    const cell = host.querySelector<HTMLElement>(
      `[data-aibar-id="${SCR}"] .aibar-scrubber__item[data-scrubber-index="1"]`,
    )!;
    const downCell = pointer('pointerdown', cell, 120);
    expect(downCell.defaultPrevented).toBe(false);
    pointer('pointerup', cell, 120);
    cell.click();
    expect(sink.selectIndex).toHaveBeenCalledWith(SCR, 1);
  });

  it('glyph category rail mounts a dedicated scroll viewport', () => {
    const { backend, host } = mounted();
    const SEG = asItemIdentifier('t.aibar.segmented.glyph');
    backend.commit(
      frame(
        [
          {
            kind: 'create',
            id: SEG,
            node: model({
              type: 'segmented',
              segments: [
                { key: 'a', labelKey: 'a', label: 'A', glyph: '🕒' },
                { key: 'b', labelKey: 'b', label: 'B', glyph: '😀' },
              ],
              selectedSegment: 'a',
            }),
            box: { x: 0, width: 60 },
          },
        ],
        [SEG],
      ),
    );
    const rootSeg = host.querySelector<HTMLElement>(`[data-aibar-id="${SEG}"]`)!;
    expect(rootSeg.dataset.tabs).toBe('glyph');
    const scroll = host.querySelector<HTMLElement>(
      `[data-aibar-id="${SEG}"] .aibar-segment__scroll`,
    )!;
    expect(scroll).toBeTruthy();
    expect(scroll.querySelectorAll('.aibar-segment[data-glyph="true"]').length).toBe(2);
  });
});
