/**
 * Pointer arming / tap reliability (composer AIBar intermittent-dead-click fix).
 *
 * Contract:
 * - Arm on pointerdown while the hit target is still connected
 * - Fire on pointerup (survives mid-gesture buildContent → replaceChildren)
 * - Suppress the compatibility click to avoid double-invoke
 * - Keyboard / programmatic .click() still works via onClick
 * - Pan / press-and-hold / loading / leaving nodes cancel or ignore taps
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

function pointer(
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  target: EventTarget,
  clientX = 20,
  pointerId = 1,
): PointerEvent {
  const ev = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
    clientX,
    clientY: 10,
    pointerId,
    pointerType: 'mouse',
  });
  target.dispatchEvent(ev);
  return ev;
}

const SEND = asItemIdentifier('com.leagent.aibar.mainbutton.composer-send');
const MODEL = asItemIdentifier('com.leagent.aibar.button.composer-model');
const REASONING = asItemIdentifier('com.leagent.aibar.popover.composer-reasoning');
const USAGE = asItemIdentifier('com.leagent.aibar.livestatus.context-usage');
const PET = asItemIdentifier('com.leagent.aibar.popover.pet');
const AUTO = asItemIdentifier('com.leagent.aibar.button.reasoning.auto');
const HIGH = asItemIdentifier('com.leagent.aibar.button.reasoning.high');

let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
  document.body.innerHTML = '';
});

function mounted(sink = makeSink()) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const backend = new DOMRendererBackend({ ariaLabel: 'AIBar', density: 'compact' });
  backend.mount(host, sink);
  cleanup.push(() => backend.destroy());
  return { backend, host, sink };
}

/** Compact composer chrome strip matching the live chat dock. */
function commitChromeStrip(backend: DOMRendererBackend) {
  backend.commit(
    frame(
      [
        {
          kind: 'create',
          id: SEND,
          node: model({ type: 'mainButton', label: '发送', principal: true }),
          box: { x: 4, width: 52 },
        },
        {
          kind: 'create',
          id: MODEL,
          node: model({
            label: 'deepseek-v4-flash · 1M',
            icon: { kind: 'text', text: '✦' },
          }),
          box: { x: 60, width: 140 },
        },
        {
          kind: 'create',
          id: USAGE,
          node: model({
            type: 'liveStatus',
            label: '8%',
            progress: 0.08,
          }),
          box: { x: 204, width: 48 },
        },
        {
          kind: 'create',
          id: REASONING,
          node: model({
            type: 'popover',
            label: '自动',
            hasChildren: true,
          }),
          box: { x: 256, width: 56 },
        },
        {
          kind: 'create',
          id: PET,
          node: model({
            type: 'popover',
            label: '牧场',
            showsLabel: false,
            hasChildren: true,
            icon: { kind: 'text', text: '🐾' },
          }),
          box: { x: 316, width: 36 },
        },
      ],
      [SEND, MODEL, USAGE, REASONING, PET],
    ),
  );
}

describe('AIBar pointer arming — composer chrome strip', () => {
  it('taps every chrome chip via pointerdown→up (send / model / usage / reasoning / pet)', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
    commitChromeStrip(backend);

    const tap = (id: string) => {
      const el = host.querySelector<HTMLElement>(`[data-aibar-id="${id}"]`)!;
      pointer('pointerdown', el, 10);
      pointer('pointerup', el, 10);
    };

    tap(SEND);
    expect(sink.invoke).toHaveBeenCalledWith(SEND);

    tap(MODEL);
    expect(sink.invoke).toHaveBeenCalledWith(MODEL);

    tap(USAGE);
    expect(sink.invoke).toHaveBeenCalledWith(USAGE);

    tap(REASONING);
    expect(sink.openPopover).toHaveBeenCalledWith(REASONING);

    tap(PET);
    expect(sink.openPopover).toHaveBeenCalledWith(PET);
  });

  it('does not double-fire when compatibility click follows armed pointerup', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
    commitChromeStrip(backend);
    const btn = host.querySelector<HTMLElement>(`[data-aibar-id="${MODEL}"]`)!;
    pointer('pointerdown', btn);
    pointer('pointerup', btn);
    btn.click();
    expect(sink.invoke).toHaveBeenCalledOnce();
  });

  it('programmatic click still works without a prior pointer gesture (keyboard path)', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
    commitChromeStrip(backend);
    host.querySelector<HTMLElement>(`[data-aibar-id="${SEND}"]`)!.click();
    expect(sink.invoke).toHaveBeenCalledWith(SEND);
  });

  it('tapping the label span still invokes after a mid-gesture label rebuild', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
    commitChromeStrip(backend);
    const btn = host.querySelector<HTMLElement>(`[data-aibar-id="${MODEL}"]`)!;
    const label = btn.querySelector<HTMLElement>('.aibar-item__label')!;
    pointer('pointerdown', label);
    backend.commit(
      frame(
        [
          {
            kind: 'update',
            id: MODEL,
            patch: model({
              label: 'deepseek-v4-pro · 1M',
              icon: { kind: 'text', text: '✦' },
            }),
            box: { x: 60, width: 140 },
          },
        ],
        [SEND, MODEL, USAGE, REASONING, PET],
      ),
    );
    expect(label.isConnected).toBe(false);
    pointer('pointerup', host.querySelector('.aibar-root')!);
    expect(sink.invoke).toHaveBeenCalledOnce();
    expect(sink.invoke).toHaveBeenCalledWith(MODEL);
  });

  it('tapping the icon child of an icon+label chip arms invoke', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
    commitChromeStrip(backend);
    const icon = host.querySelector<HTMLElement>(
      `[data-aibar-id="${MODEL}"] .aibar-item__icon`,
    )!;
    pointer('pointerdown', icon);
    pointer('pointerup', icon);
    expect(sink.invoke).toHaveBeenCalledWith(MODEL);
  });

  it('ignores taps on items marked leaving (crossfade outgoing)', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
    commitChromeStrip(backend);
    const btn = host.querySelector<HTMLElement>(`[data-aibar-id="${MODEL}"]`)!;
    btn.dataset.leaving = 'context';
    pointer('pointerdown', btn);
    pointer('pointerup', btn);
    btn.click();
    expect(sink.invoke).not.toHaveBeenCalled();
  });

  it('ignores taps while the item is in loading state', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
    commitChromeStrip(backend);
    backend.commit(
      frame([{ kind: 'state', id: MODEL, state: 'loading' }], [
        SEND,
        MODEL,
        USAGE,
        REASONING,
        PET,
      ]),
    );
    const btn = host.querySelector<HTMLElement>(`[data-aibar-id="${MODEL}"]`)!;
    expect(btn.dataset.state).toBe('loading');
    pointer('pointerdown', btn);
    pointer('pointerup', btn);
    btn.click();
    expect(sink.invoke).not.toHaveBeenCalled();
  });

  it('ignores taps while the item is disabled', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
    commitChromeStrip(backend);
    backend.commit(
      frame([{ kind: 'state', id: SEND, state: 'disabled' }], [
        SEND,
        MODEL,
        USAGE,
        REASONING,
        PET,
      ]),
    );
    const btn = host.querySelector<HTMLElement>(`[data-aibar-id="${SEND}"]`)!;
    pointer('pointerdown', btn);
    pointer('pointerup', btn);
    expect(sink.invoke).not.toHaveBeenCalled();
  });

  it('pointercancel clears an armed tap without invoking', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
    commitChromeStrip(backend);
    const btn = host.querySelector<HTMLElement>(`[data-aibar-id="${MODEL}"]`)!;
    pointer('pointerdown', btn);
    pointer('pointercancel', btn);
    expect(sink.invoke).not.toHaveBeenCalled();
    expect(sink.openPopover).not.toHaveBeenCalled();
    // A later programmatic click still works (no suppress window from cancel).
    btn.click();
    expect(sink.invoke).toHaveBeenCalledOnce();
    expect(sink.invoke).toHaveBeenCalledWith(MODEL);
  });

  it('mismatched pointerId does not steal another finger’s armed tap', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
    commitChromeStrip(backend);
    const modelBtn = host.querySelector<HTMLElement>(`[data-aibar-id="${MODEL}"]`)!;
    const sendBtn = host.querySelector<HTMLElement>(`[data-aibar-id="${SEND}"]`)!;
    pointer('pointerdown', modelBtn, 10, 1);
    // Second finger up should not fire the first arm.
    pointer('pointerup', sendBtn, 10, 2);
    expect(sink.invoke).not.toHaveBeenCalled();
    pointer('pointerup', modelBtn, 10, 1);
    expect(sink.invoke).toHaveBeenCalledOnce();
    expect(sink.invoke).toHaveBeenCalledWith(MODEL);
  });
});

describe('AIBar pointer arming — inline reasoning options', () => {
  function commitReasoningExpanded(backend: DOMRendererBackend) {
    backend.commit(
      frame(
        [
          {
            kind: 'create',
            id: SEND,
            node: model({ type: 'mainButton', label: '发送', principal: true }),
            box: { x: 4, width: 52 },
          },
          {
            kind: 'create',
            id: MODEL,
            node: model({ label: 'deepseek-v4-flash · 1M' }),
            box: { x: 60, width: 140 },
          },
          {
            kind: 'create',
            id: AUTO,
            node: model({ label: '自动', active: true }),
            box: { x: 204, width: 56 },
          },
          {
            kind: 'create',
            id: HIGH,
            node: model({ label: '高' }),
            box: { x: 264, width: 48 },
          },
          {
            kind: 'create',
            id: PET,
            node: model({
              type: 'popover',
              label: '牧场',
              showsLabel: false,
              hasChildren: true,
            }),
            box: { x: 320, width: 36 },
          },
        ],
        [SEND, MODEL, AUTO, HIGH, PET],
      ),
    );
  }

  it('selects a reasoning intensity chip via armed pointerup', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
    commitReasoningExpanded(backend);
    const high = host.querySelector<HTMLElement>(`[data-aibar-id="${HIGH}"]`)!;
    pointer('pointerdown', high);
    pointer('pointerup', high);
    expect(sink.invoke).toHaveBeenCalledWith(HIGH);
  });

  it('survives option-button rebuild while choosing intensity', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
    commitReasoningExpanded(backend);
    const high = host.querySelector<HTMLElement>(`[data-aibar-id="${HIGH}"]`)!;
    const label = high.querySelector<HTMLElement>('.aibar-item__label')!;
    pointer('pointerdown', label);
    backend.commit(
      frame(
        [
          {
            kind: 'update',
            id: HIGH,
            patch: model({ label: '高', active: true }),
            box: { x: 264, width: 48 },
          },
        ],
        [SEND, MODEL, AUTO, HIGH, PET],
      ),
    );
    expect(label.isConnected).toBe(false);
    pointer('pointerup', host.querySelector('.aibar-root')!);
    expect(sink.invoke).toHaveBeenCalledWith(HIGH);
  });

  it('ground neighbor taps still work while reasoning options are visible', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
    commitReasoningExpanded(backend);
    const modelBtn = host.querySelector<HTMLElement>(`[data-aibar-id="${MODEL}"]`)!;
    pointer('pointerdown', modelBtn);
    pointer('pointerup', modelBtn);
    expect(sink.invoke).toHaveBeenCalledWith(MODEL);

    const petBtn = host.querySelector<HTMLElement>(`[data-aibar-id="${PET}"]`)!;
    pointer('pointerdown', petBtn);
    pointer('pointerup', petBtn);
    expect(sink.openPopover).toHaveBeenCalledWith(PET);
  });
});

describe('AIBar pointer arming — approval / escape / composites', () => {
  it('arms approve / dismiss from nested decision buttons', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
    const APPROVAL = asItemIdentifier('t.aibar.approval.p');
    const SUGGESTION = asItemIdentifier('t.aibar.suggestion.s');
    backend.commit(
      frame(
        [
          {
            kind: 'create',
            id: APPROVAL,
            node: model({ type: 'approval', intentSummary: 'Delete 3 files' }),
            box: { x: 0, width: 200 },
          },
          {
            kind: 'create',
            id: SUGGESTION,
            node: model({
              type: 'suggestion',
              label: 'Summarize',
              confidenceTier: 3,
            }),
            box: { x: 210, width: 120 },
          },
        ],
        [APPROVAL, SUGGESTION],
      ),
    );

    const deny = host.querySelector<HTMLElement>(
      `[data-aibar-id="${APPROVAL}"] [data-decision="deny"]`,
    )!;
    pointer('pointerdown', deny);
    pointer('pointerup', deny);
    expect(sink.approve).toHaveBeenCalledWith(APPROVAL, 'deny');

    const dismiss = host.querySelector<HTMLElement>(
      `[data-aibar-id="${SUGGESTION}"] [data-dismiss]`,
    )!;
    pointer('pointerdown', dismiss);
    pointer('pointerup', dismiss);
    expect(sink.dismiss).toHaveBeenCalledWith(SUGGESTION);
  });

  it('Escape Zone ✕ arms escape even when items layer is full-bleed', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
    const CLOSE = asItemIdentifier('core.aibar.button.escape-close');
    backend.commit(
      frame(
        [
          {
            kind: 'create',
            id: MODEL,
            node: model({ label: 'Yard child' }),
            box: { x: 36, width: 400 },
          },
        ],
        [MODEL],
        {
          id: CLOSE,
          node: model({ label: 'Close', showsLabel: false, icon: { kind: 'text', text: '✕' } }),
        },
      ),
    );
    const escapeBtn = host.querySelector<HTMLElement>('.aibar-escape [data-aibar-id]')!;
    pointer('pointerdown', escapeBtn);
    pointer('pointerup', escapeBtn);
    expect(sink.escape).toHaveBeenCalledOnce();
    expect(sink.invoke).not.toHaveBeenCalled();
  });

  it('does not arm invoke on custom / scrubber chrome (only inner cells)', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
    const CUSTOM = asItemIdentifier('com.leagent.aibar.custom.pet-yard');
    const SCR = asItemIdentifier('t.aibar.scrubber.emoji');
    backend.commit(
      frame(
        [
          {
            kind: 'create',
            id: CUSTOM,
            node: model({
              type: 'custom',
              customKind: 'aibar-ranch-yard',
              label: '牧场活动区',
            }),
            box: { x: 0, width: 400 },
          },
          {
            kind: 'create',
            id: SCR,
            node: model({
              type: 'scrubber',
              scrubber: {
                count: 2,
                slice: {
                  start: 0,
                  entries: [
                    { key: '0', label: '👍' },
                    { key: '1', label: '😀' },
                  ],
                },
                layout: 'fixed',
                itemWidth: 34,
              },
            }),
            box: { x: 410, width: 120 },
          },
        ],
        [CUSTOM, SCR],
      ),
    );

    const custom = host.querySelector<HTMLElement>(`[data-aibar-id="${CUSTOM}"]`)!;
    pointer('pointerdown', custom);
    pointer('pointerup', custom);
    expect(sink.invoke).not.toHaveBeenCalled();

    const cell = host.querySelector<HTMLElement>(
      `[data-aibar-id="${SCR}"] [data-scrubber-index="1"]`,
    )!;
    pointer('pointerdown', cell);
    pointer('pointerup', cell);
    expect(sink.selectIndex).toHaveBeenCalledWith(SCR, 1);
  });

  it('segmented glyph tab tap selects via armed pointerup', () => {
    const sink = makeSink();
    const { backend, host } = mounted(sink);
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
                { key: 'frequent', labelKey: 'a', label: '常用', glyph: '🕒' },
                { key: 'smileys', labelKey: 'b', label: '笑脸', glyph: '😀' },
              ],
              selectedSegment: 'frequent',
            }),
            box: { x: 0, width: 80 },
          },
        ],
        [SEG],
      ),
    );
    const tab = host.querySelector<HTMLElement>(
      `[data-aibar-id="${SEG}"] [data-segment-key="smileys"]`,
    )!;
    pointer('pointerdown', tab);
    pointer('pointerup', tab);
    expect(sink.selectSegment).toHaveBeenCalledWith(SEG, 'smileys');
  });
});

describe('AIBar pointer arming — press-and-hold', () => {
  it('long-press opens popover and suppresses the armed tap invoke', () => {
    vi.useFakeTimers();
    try {
      const sink = makeSink();
      const { backend, host } = mounted(sink);
      const HOLD = asItemIdentifier('t.aibar.popover.hold');
      backend.commit(
        frame(
          [
            {
              kind: 'create',
              id: HOLD,
              node: model({
                type: 'popover',
                label: 'Hold me',
                hasChildren: true,
                pressAndHold: true,
              }),
              box: { x: 0, width: 72 },
            },
          ],
          [HOLD],
        ),
      );
      const btn = host.querySelector<HTMLElement>(`[data-aibar-id="${HOLD}"]`)!;
      pointer('pointerdown', btn);
      vi.advanceTimersByTime(300);
      expect(sink.openPopover).toHaveBeenCalledWith(HOLD);
      pointer('pointerup', btn);
      // press-and-hold release dismisses via escape; must not also invoke
      expect(sink.escape).toHaveBeenCalled();
      expect(sink.invoke).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('short press on pressAndHold item still opens via armed openPopover', () => {
    vi.useFakeTimers();
    try {
      const sink = makeSink();
      const { backend, host } = mounted(sink);
      const HOLD = asItemIdentifier('t.aibar.popover.hold-short');
      backend.commit(
        frame(
          [
            {
              kind: 'create',
              id: HOLD,
              node: model({
                type: 'popover',
                label: 'Hold me',
                hasChildren: true,
                pressAndHold: true,
              }),
              box: { x: 0, width: 72 },
            },
          ],
          [HOLD],
        ),
      );
      const btn = host.querySelector<HTMLElement>(`[data-aibar-id="${HOLD}"]`)!;
      pointer('pointerdown', btn);
      vi.advanceTimersByTime(50); // below PRESS_AND_HOLD_MS
      pointer('pointerup', btn);
      expect(sink.openPopover).toHaveBeenCalledOnce();
      expect(sink.escape).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
