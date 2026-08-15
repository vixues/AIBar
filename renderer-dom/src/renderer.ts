/**
 * DOM RendererBackend (docs/aibar-architecture.md §7.4).
 *
 * Zero-reflow contract: items are absolutely positioned; geometry is written
 * only via `transform: translateX()` + width; no DOM reads inside `commit`;
 * text measurement uses an offscreen canvas with an LRU cache — never DOM
 * measurement. Accessibility follows the WAI-ARIA toolbar pattern with a
 * roving tabindex (design doc §11.1) and the §8.2 keyboard map.
 */
import type {
  Box,
  ItemRenderModel,
  ItemVisualState,
  MeasureRequest,
  MeasureResult,
  RendererBackend,
  RenderFrame,
  RenderOp,
  StreamDelta,
  SurfaceInputSink,
} from '@aibar/core';

const MEASURE_CACHE_MAX = 1024;
/** Lockstep with DENSITY_METRICS.textSize + styles.css font-size. */
const FONT_SIZE: Record<string, number> = { regular: 13, compact: 11 };
/** Hold duration before a pressAndHold popover opens (design §5.8). */
const PRESS_AND_HOLD_MS = 300;
/** Design §7.1 popover whole-surface crossfade window. */
const PRESENTATION_SWAP_MS = 160;
/** Design §7.1 context-switch leave: opacity + scale 0.96. */
const CONTEXT_LEAVE_MS = 120;
/** Design §7.1 survivor position interpolate. */
const SURVIVOR_MOVE_MS = 160;
/**
 * Free-scroll strip viewports (NSScrubber / NSCandidateList / emoji category rail).
 * Tap = select; drag past threshold = pan. Never preventDefault on arming —
 * that suppresses the subsequent click.
 */
const STRIP_SCROLL_SELECTOR =
  '.aibar-scrubber__scroll, .aibar-candidate__scroll, .aibar-segment__scroll';
const STRIP_PAN_THRESHOLD_PX = 4;

type ArmedTapAction =
  | { kind: 'invoke' }
  | { kind: 'openPopover' }
  | { kind: 'escape' }
  | { kind: 'selectIndex'; index: number }
  | { kind: 'selectSegment'; key: string }
  | { kind: 'dismiss' }
  | { kind: 'approve'; decision: 'allow' | 'deny' };

interface ItemNode {
  el: HTMLElement;
  model: ItemRenderModel;
  box: Box;
  state: ItemVisualState;
}

export interface DOMRendererOptions {
  ariaLabel: string;
  density?: 'compact' | 'regular';
  /** Host-remappable focus hotkey; default Alt+A (design §8.2). */
  focusHotkey?: { altKey?: boolean; ctrlKey?: boolean; key: string };
}

export class DOMRendererBackend implements RendererBackend {
  private root: HTMLElement | null = null;
  private escapeZone: HTMLElement | null = null;
  private itemsLayer: HTMLElement | null = null;
  private politeAnnouncer: HTMLElement | null = null;
  private assertiveAnnouncer: HTMLElement | null = null;
  private sink: SurfaceInputSink | null = null;

  private nodes = new Map<string, ItemNode>();
  private pool = new Map<string, HTMLElement[]>();
  private order: string[] = [];
  private focusIndex = -1;
  private lastHostFocus: Element | null = null;

  private measureCache = new Map<string, number>();
  private measureCtx: CanvasRenderingContext2D | null = null;
  private fontFamily = 'sans-serif';

  private cachedWidth = 0;
  private resizeListeners = new Set<() => void>();
  private resizeObserver: ResizeObserver | null = null;
  private docKeydown: ((e: KeyboardEvent) => void) | null = null;

  // press-and-hold state (design §5.8)
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private holdId: string | null = null;
  private suppressClickUntil = 0;

  /**
   * Primary activation path for pointer taps. Arm on pointerdown (while the
   * hit target is still connected) and fire on pointerup. Relying on the
   * compatibility `click` alone fails intermittently when a resolve/`update`
   * runs `buildContent` → `replaceChildren` between down and click — the
   * event target detaches and `closest('[data-aibar-id]')` returns null.
   */
  private armedTap: {
    pointerId: number;
    id: string;
    action: ArmedTapAction;
  } | null = null;

  /** Free-scroll strip pan: armed on pointerdown, captures only after threshold. */
  private stripPan: {
    scroll: HTMLElement;
    pointerId: number;
    startX: number;
    startLeft: number;
    moved: boolean;
    captured: boolean;
  } | null = null;

  /** Soft-leaving nodes during a presentation crossfade (overlap with enterers). */
  private leaving: ItemNode[] = [];
  private leaveTimers = new Set<ReturnType<typeof setTimeout>>();
  private escapeLeaveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Incoming presentation while a swap frame is applying ops. */
  private swapEnterPresentation: 'ground' | 'subsurface' | null = null;

  constructor(private options: DOMRendererOptions) {}

  // ——— mount / environment access (outside the commit path) ———

  mount(container: unknown, sink: SurfaceInputSink): void {
    const host = container as HTMLElement;
    this.sink = sink;
    const doc = host.ownerDocument;

    const root = doc.createElement('div');
    root.className = 'aibar-root';
    root.dataset.density = this.options.density ?? 'regular';
    root.setAttribute('role', 'toolbar');
    root.setAttribute('aria-label', this.options.ariaLabel);
    root.setAttribute('aria-orientation', 'horizontal');

    const escapeZone = doc.createElement('div');
    escapeZone.className = 'aibar-escape';

    const itemsLayer = doc.createElement('div');
    itemsLayer.className = 'aibar-items';

    const polite = doc.createElement('div');
    polite.className = 'aibar-announcer';
    polite.setAttribute('aria-live', 'polite');

    const assertive = doc.createElement('div');
    assertive.className = 'aibar-announcer';
    assertive.setAttribute('aria-live', 'assertive');

    root.append(escapeZone, itemsLayer, polite, assertive);
    host.appendChild(root);

    this.root = root;
    this.escapeZone = escapeZone;
    this.itemsLayer = itemsLayer;
    this.politeAnnouncer = polite;
    this.assertiveAnnouncer = assertive;

    const style = doc.defaultView?.getComputedStyle(root);
    if (style?.fontFamily) this.fontFamily = style.fontFamily;

    const canvas = doc.createElement('canvas');
    this.measureCtx = canvas.getContext('2d');

    this.cachedWidth = root.clientWidth;
    this.resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? root.clientWidth;
      if (width !== this.cachedWidth) {
        this.cachedWidth = width;
        for (const l of [...this.resizeListeners]) l();
      }
    });
    this.resizeObserver.observe(root);

    root.addEventListener('click', this.onClick);
    // Direct target: Escape Zone sits under the full-bleed items layer in DOM
    // order; keep an explicit path so showsCloseButton never depends on hit-through.
    escapeZone.addEventListener('click', this.onEscapeClick);
    root.addEventListener('contextmenu', this.onContextMenu);
    root.addEventListener('keydown', this.onKeydown);
    // Keep the roving index in sync with real focus (pointer or Tab entry).
    root.addEventListener('focusin', this.onFocusIn);
    // Composite-control inputs: slider commit, scrubber window scrolling,
    // press-and-hold popovers (design §5.8).
    root.addEventListener('input', this.onInput);
    root.addEventListener('scroll', this.onScroll, true);
    root.addEventListener('wheel', this.onWheel, { passive: false });
    root.addEventListener('pointerdown', this.onPointerDown);
    root.addEventListener('pointermove', this.onPointerMove);
    root.addEventListener('pointerup', this.onPointerUp);
    root.addEventListener('pointercancel', this.onPointerUp);

    const hotkey = this.options.focusHotkey ?? { altKey: true, key: 'a' };
    this.docKeydown = (e: KeyboardEvent) => {
      if (
        e.key.toLowerCase() === hotkey.key.toLowerCase() &&
        !!e.altKey === !!hotkey.altKey &&
        !!e.ctrlKey === !!hotkey.ctrlKey
      ) {
        e.preventDefault();
        this.toggleFocus();
      }
    };
    doc.addEventListener('keydown', this.docKeydown);
  }

  measure(requests: readonly MeasureRequest[]): readonly MeasureResult[] {
    return requests.map((req) => {
      const key = `${req.density}\u0000${req.text}`;
      const cached = this.measureCache.get(key);
      if (cached !== undefined) {
        // refresh LRU position
        this.measureCache.delete(key);
        this.measureCache.set(key, cached);
        return { width: cached };
      }
      let width = req.text.length * 8;
      if (this.measureCtx) {
        this.measureCtx.font = `500 ${FONT_SIZE[req.density] ?? 13}px ${this.fontFamily}`;
        width = this.measureCtx.measureText(req.text).width;
      }
      this.measureCache.set(key, width);
      if (this.measureCache.size > MEASURE_CACHE_MAX) {
        const oldest = this.measureCache.keys().next().value;
        if (oldest !== undefined) this.measureCache.delete(oldest);
      }
      return { width };
    });
  }

  scheduleFrame(cb: () => void): void {
    const raf = this.root?.ownerDocument.defaultView?.requestAnimationFrame;
    if (raf) raf(cb);
    else setTimeout(cb, 16);
  }

  /** §11.2: background work rides scheduler.postTask when the UA has it. */
  postTask(cb: () => void, priority: 'user-visible' | 'background'): void {
    const scheduler = (
      this.root?.ownerDocument.defaultView as
        | { scheduler?: { postTask?: (cb: () => void, opts: { priority: string }) => unknown } }
        | undefined
    )?.scheduler;
    if (scheduler?.postTask) {
      void scheduler.postTask(cb, { priority });
    } else {
      setTimeout(cb, 0);
    }
  }

  surfaceWidth(): number {
    return this.cachedWidth;
  }

  onResize(cb: () => void): () => void {
    this.resizeListeners.add(cb);
    return () => this.resizeListeners.delete(cb);
  }

  applyThemeTokens(tokens: Readonly<Record<string, string>>): void {
    if (!this.root) return;
    for (const [name, value] of Object.entries(tokens)) {
      this.root.style.setProperty(name.startsWith('--') ? name : `--${name}`, value);
    }
  }

  // ——— commit: writes only, no DOM reads (D1) ———

  commit(frame: RenderFrame): void {
    if (!this.itemsLayer || !this.escapeZone) return;

    const presentation = frame.presentation ?? 'ground';
    const swapping = Boolean(frame.presentationChanged);

    // §11.3: level 2 turns off non-essential motion via CSS hook.
    if (this.root) {
      if (frame.degraded) this.root.dataset.degraded = String(frame.degraded);
      else delete this.root.dataset.degraded;
      this.root.dataset.presentation = presentation;
      if (swapping) {
        // A new swap cancels any in-flight leave so layers never stack up.
        this.flushLeaving(true);
        this.root.dataset.presentationSwap = '1';
        this.root.dataset.swapTo = presentation;
        const t = setTimeout(() => {
          this.leaveTimers.delete(t);
          if (this.root?.dataset.presentationSwap === '1') {
            delete this.root.dataset.presentationSwap;
            delete this.root.dataset.swapTo;
          }
        }, PRESENTATION_SWAP_MS);
        this.leaveTimers.add(t);
      }
    }

    // Design §7.1: overlapping crossfade — soft-leave outgoing while enterers fade in.
    this.swapEnterPresentation = swapping ? presentation : null;
    for (const op of frame.ops) this.applyOp(op, swapping);
    this.swapEnterPresentation = null;

    this.order = frame.order.filter((id) => this.nodes.has(id));
    this.syncTabindex();
    this.renderEscape(frame.escape, swapping);

    if (frame.announce && this.politeAnnouncer) {
      this.politeAnnouncer.textContent = frame.announce;
    }
  }

  private applyOp(op: RenderOp, swapping = false): void {
    switch (op.kind) {
      case 'create': {
        const el = this.acquireNode(op.node.type);
        this.buildContent(el, op.node);
        this.applyGeometry(el, op.box);
        el.dataset.aibarId = op.id;
        delete el.dataset.leaving;
        if (swapping && this.swapEnterPresentation) {
          // Presentation enter: opacity (+ subsurface 8px) — not the context-switch bounce.
          el.dataset.swapEnter = this.swapEnterPresentation;
          const t = setTimeout(() => {
            this.leaveTimers.delete(t);
            delete el.dataset.swapEnter;
          }, PRESENTATION_SWAP_MS);
          this.leaveTimers.add(t);
        } else {
          el.dataset.entering = 'true';
          setTimeout(() => delete el.dataset.entering, 300);
        }
        this.itemsLayer!.appendChild(el);
        this.nodes.set(op.id, { el, model: op.node, box: op.box, state: 'default' });
        if (op.node.type === 'approval' && this.assertiveAnnouncer) {
          this.assertiveAnnouncer.textContent = op.node.intentSummary ?? op.node.label;
        }
        break;
      }
      case 'update': {
        const node = this.nodes.get(op.id);
        if (!node) return;
        node.model = { ...node.model, ...op.patch } as ItemRenderModel;
        this.buildContent(node.el, node.model);
        if (op.box) {
          const animate =
            !swapping &&
            (node.box.x !== op.box.x || node.box.width !== op.box.width);
          node.box = op.box;
          this.applyGeometry(node.el, op.box, animate);
        }
        this.applyState(node);
        break;
      }
      case 'move': {
        const node = this.nodes.get(op.id);
        if (!node) return;
        const animate =
          !swapping &&
          (node.box.x !== op.box.x || node.box.width !== op.box.width);
        node.box = op.box;
        this.applyGeometry(node.el, op.box, animate);
        break;
      }
      case 'state': {
        const node = this.nodes.get(op.id);
        if (!node) return;
        node.state = op.state;
        this.applyState(node);
        break;
      }
      case 'stream': {
        const node = this.nodes.get(op.id);
        if (!node) return;
        this.applyStream(node, op.delta);
        break;
      }
      case 'remove': {
        const node = this.nodes.get(op.id);
        if (!node) return;
        this.nodes.delete(op.id);
        if (swapping) {
          // Outgoing presentation is the opposite of the bar we're entering.
          const leaving =
            this.swapEnterPresentation === 'subsurface' ? 'ground' : 'subsurface';
          this.softRelease(node, leaving, PRESENTATION_SWAP_MS);
        } else if (this.motionAllowed()) {
          this.softRelease(node, 'context', CONTEXT_LEAVE_MS);
        } else {
          this.releaseNode(node);
        }
        break;
      }
    }
  }

  /**
   * Keep the outgoing node painted so enter/leave overlap. Nodes leave the
   * live `nodes` map immediately so the same id can be recreated.
   */
  private softRelease(
    node: ItemNode,
    leaving: 'ground' | 'subsurface' | 'context',
    durationMs: number,
  ): void {
    this.defocusInside(node.el);
    delete node.el.dataset.entering;
    delete node.el.dataset.swapEnter;
    delete node.el.dataset.moving;
    node.el.dataset.leaving = leaving;
    node.el.style.pointerEvents = 'none';
    node.el.tabIndex = -1;
    this.leaving.push(node);
    const t = setTimeout(() => {
      this.leaveTimers.delete(t);
      const idx = this.leaving.indexOf(node);
      if (idx >= 0) this.leaving.splice(idx, 1);
      this.releaseNode(node);
    }, durationMs);
    this.leaveTimers.add(t);
  }

  /** Drop in-flight leave animations; `immediate` also releases DOM now. */
  private flushLeaving(immediate: boolean): void {
    for (const t of this.leaveTimers) clearTimeout(t);
    this.leaveTimers.clear();
    if (this.escapeLeaveTimer) {
      clearTimeout(this.escapeLeaveTimer);
      this.escapeLeaveTimer = null;
    }
    if (!immediate) return;
    for (const node of this.leaving) this.releaseNode(node);
    this.leaving = [];
  }

  private motionAllowed(): boolean {
    if (this.root?.dataset.degraded === '2') return false;
    const mq = this.root?.ownerDocument.defaultView?.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    );
    return !mq?.matches;
  }

  private applyGeometry(el: HTMLElement, box: Box, animate = false): void {
    if (animate && this.motionAllowed()) {
      el.dataset.moving = 'true';
      const t = setTimeout(() => {
        this.leaveTimers.delete(t);
        delete el.dataset.moving;
      }, SURVIVOR_MOVE_MS);
      this.leaveTimers.add(t);
    } else {
      delete el.dataset.moving;
    }
    el.style.transform = `translateX(${box.x}px)`;
    el.style.width = `${box.width}px`;
  }

  private applyState(node: ItemNode): void {
    node.el.dataset.state = node.state;
    const busy = node.state === 'loading' || node.state === 'streaming';
    if (busy) node.el.setAttribute('aria-busy', 'true');
    else node.el.removeAttribute('aria-busy');
    if (node.state === 'disabled') node.el.setAttribute('aria-disabled', 'true');
    else node.el.removeAttribute('aria-disabled');
    if (node.model.type === 'toggle') {
      node.el.setAttribute('aria-pressed', node.state === 'active' ? 'true' : 'false');
    }
  }

  private applyStream(node: ItemNode, delta: StreamDelta): void {
    if (delta.label !== undefined) {
      node.model = { ...node.model, label: delta.label };
      const label = node.el.querySelector('.aibar-item__label');
      if (label) label.textContent = delta.label;
    }
    if (delta.progress !== undefined) {
      node.model = { ...node.model, progress: delta.progress };
      if (node.el.querySelector('.aibar-meter')) {
        this.updateMeter(node.el, delta.progress);
      } else {
        this.updateRing(node.el, delta.progress);
      }
    }
    if (delta.confidenceTier !== undefined) {
      node.el.dataset.tier = String(delta.confidenceTier);
    }
  }

  // ——— node construction (pooled, D3) ———

  private acquireNode(type: string): HTMLElement {
    const pooled = this.pool.get(type)?.pop();
    if (pooled) return pooled;
    const doc = this.itemsLayer!.ownerDocument;
    // Composite controls are containers with inner interactive elements.
    const interactive = ![
      'label', 'spacerSmall', 'spacerLarge', 'spacerFlexible', 'segmented',
      'suggestion', 'approval', 'slider', 'scrubber', 'colorPicker',
      'candidateList', 'characterPicker', 'custom',
    ].includes(type);
    const el = doc.createElement(interactive ? 'button' : 'div');
    el.className = 'aibar-item';
    if (interactive) (el as HTMLButtonElement).type = 'button';
    return el;
  }

  private releaseNode(node: ItemNode): void {
    this.defocusInside(node.el);
    node.el.remove();
    node.el.removeAttribute('style');
    node.el.removeAttribute('data-state');
    node.el.removeAttribute('aria-label');
    node.el.removeAttribute('aria-labelledby');
    node.el.removeAttribute('aria-haspopup');
    node.el.removeAttribute('aria-pressed');
    node.el.removeAttribute('aria-busy');
    node.el.removeAttribute('aria-disabled');
    node.el.removeAttribute('aria-hidden');
    node.el.removeAttribute('role');
    node.el.removeAttribute('title');
    delete node.el.dataset.aibarId;
    delete node.el.dataset.entering;
    delete node.el.dataset.leaving;
    delete node.el.dataset.swapEnter;
    delete node.el.dataset.moving;
    delete node.el.dataset.pressHold;
    delete node.el.dataset.dragging;
    delete node.el.dataset.type;
    delete node.el.dataset.badge;
    delete node.el.dataset.principal;
    delete node.el.dataset.effect;
    delete node.el.dataset.disclosure;
    delete node.el.dataset.picker;
    delete node.el.dataset.tabs;
    const list = this.pool.get(node.model.type) ?? [];
    if (list.length < 16) {
      node.el.replaceChildren();
      list.push(node.el);
      this.pool.set(node.model.type, list);
    }
  }

  /**
   * Blur focus before a node leaves the live tree. Removing a focused AIBar
   * button otherwise parks focus on the composer textarea and falsely enters
   * input mode (typing candidates).
   */
  private defocusInside(el: HTMLElement): void {
    const active = el.ownerDocument.activeElement;
    if (!(active instanceof HTMLElement)) return;
    if (active === el || el.contains(active)) active.blur();
  }

  private buildContent(el: HTMLElement, model: ItemRenderModel): void {
    const doc = el.ownerDocument;
    // Preserve scrubber / candidate strip scroll across model rebuilds so
    // horizontal swipe (NSScrubber / NSCandidateList free scroll) does not jump.
    const prevStripScroll =
      model.type === 'scrubber'
        ? el.querySelector<HTMLElement>('.aibar-scrubber__scroll')?.scrollLeft
        : model.type === 'candidateList' || model.type === 'characterPicker'
          ? el.querySelector<HTMLElement>('.aibar-candidate__scroll')?.scrollLeft
          : undefined;
    this.defocusInside(el);
    el.dataset.type = model.type;
    el.dataset.badge = model.badge;
    el.dataset.principal = String(model.principal);
    el.dataset.effect = model.effect;
    el.title = model.tooltip;
    // Pooled nodes may retain aria from a prior type/id — reset before rebuild.
    el.removeAttribute('aria-label');
    el.removeAttribute('aria-haspopup');
    el.removeAttribute('aria-pressed');
    el.removeAttribute('aria-busy');
    el.removeAttribute('aria-disabled');
    el.removeAttribute('aria-hidden');
    el.removeAttribute('role');
    delete el.dataset.disclosure;
    delete el.dataset.picker;
    delete el.dataset.tabs;
    el.replaceChildren();

    switch (model.type) {
      case 'label': {
        el.setAttribute('role', 'presentation');
        el.append(this.labelSpan(doc, model.label));
        return;
      }
      case 'spacerSmall':
      case 'spacerLarge':
      case 'spacerFlexible':
        el.setAttribute('aria-hidden', 'true');
        return;
      case 'segmented': {
        el.setAttribute('role', 'radiogroup');
        el.setAttribute('aria-label', model.tooltip);
        const glyphTabs = (model.segments ?? []).some((s) => Boolean(s.glyph || s.iconResolved));
        const host = glyphTabs ? doc.createElement('div') : el;
        if (glyphTabs) {
          host.className = 'aibar-segment__scroll';
          el.dataset.tabs = 'glyph';
          el.appendChild(host);
        }
        for (const seg of model.segments ?? []) {
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'aibar-segment';
          btn.setAttribute('role', 'radio');
          btn.setAttribute('aria-checked', String(seg.key === model.selectedSegment));
          btn.setAttribute('aria-label', seg.label);
          btn.title = seg.label;
          btn.dataset.segmentKey = seg.key;
          if (seg.glyph) {
            btn.dataset.glyph = 'true';
            const glyph = doc.createElement('span');
            glyph.className = 'aibar-segment__glyph';
            glyph.setAttribute('aria-hidden', 'true');
            glyph.textContent = seg.glyph;
            btn.appendChild(glyph);
          } else if (seg.iconResolved) {
            btn.dataset.icon = 'true';
            const icon = doc.createElement('span');
            icon.className = 'aibar-segment__icon';
            icon.setAttribute('aria-hidden', 'true');
            if (seg.iconResolved.kind === 'svg') icon.innerHTML = seg.iconResolved.svg;
            else icon.textContent = seg.iconResolved.text;
            btn.appendChild(icon);
          } else {
            btn.textContent = seg.label;
          }
          host.appendChild(btn);
        }
        return;
      }
      case 'liveStatus': {
        el.setAttribute('aria-label', model.tooltip ? `${model.label} · ${model.tooltip}` : model.label);
        if (model.livePhase) el.dataset.phase = model.livePhase;
        else delete el.dataset.phase;
        if (model.morphing) el.dataset.morphing = 'true';
        else delete el.dataset.morphing;
        const progress = model.progress;
        if (progress !== undefined) {
          // Stacked TouchBar chip: percent on top, full-width meter below.
          const tone =
            model.liveTone ??
            (progress >= 0.85 ? 'critical' : progress >= 0.6 ? 'warn' : 'ok');
          el.dataset.tone = tone;
          el.dataset.layout = 'stack';
          const stack = doc.createElement('span');
          stack.className = 'aibar-live-stack';
          stack.append(this.labelSpan(doc, model.label), this.buildMeter(doc, progress));
          el.appendChild(stack);
        } else {
          delete el.dataset.layout;
          if (model.liveTone) el.dataset.tone = model.liveTone;
          else delete el.dataset.tone;
          if (model.icon) {
            const icon = doc.createElement('span');
            icon.className = 'aibar-item__icon aibar-live-icon';
            icon.setAttribute('aria-hidden', 'true');
            if (model.icon.kind === 'svg') icon.innerHTML = model.icon.svg;
            else icon.textContent = model.icon.text;
            el.appendChild(icon);
          } else {
            el.appendChild(this.buildRing(doc, undefined));
          }
          el.append(this.labelSpan(doc, model.label));
        }
        return;
      }
      case 'suggestion': {
        el.setAttribute('role', 'group');
        if (model.confidenceTier) el.dataset.tier = String(model.confidenceTier);
        const body = doc.createElement('button');
        body.type = 'button';
        body.className = 'aibar-suggestion-body';
        body.dataset.suggestionAccept = 'true';
        body.setAttribute(
          'aria-description',
          model.ariaDescription ?? model.reasonText ?? model.label,
        );
        const glyph = doc.createElement('span');
        glyph.className = 'aibar-suggestion-glyph';
        glyph.textContent = '✦';
        glyph.setAttribute('aria-hidden', 'true');
        body.append(glyph, this.labelSpan(doc, model.label));
        const dismiss = doc.createElement('button');
        dismiss.type = 'button';
        dismiss.className = 'aibar-suggestion-dismiss';
        dismiss.dataset.dismiss = 'true';
        dismiss.textContent = '✕';
        dismiss.setAttribute('aria-label', model.dismissLabel ?? model.label);
        el.append(body, dismiss);
        return;
      }
      case 'slider': {
        el.setAttribute('role', 'group');
        el.setAttribute('aria-label', model.tooltip);
        if (model.showsLabel) el.append(this.labelSpan(doc, model.label));
        const wrap = doc.createElement('div');
        wrap.className = 'aibar-slider';
        const track = doc.createElement('div');
        track.className = 'aibar-slider__track';
        track.setAttribute('aria-hidden', 'true');
        const fill = doc.createElement('div');
        fill.className = 'aibar-slider__fill';
        track.appendChild(fill);
        const input = doc.createElement('input');
        input.type = 'range';
        input.className = 'aibar-slider__input';
        input.dataset.aibarSlider = 'true';
        const s = model.slider;
        if (s) {
          input.min = String(s.min);
          input.max = String(s.max);
          if (s.step !== undefined) input.step = String(s.step);
          input.value = String(s.value);
          this.syncSliderFill(fill, s.min, s.max, s.value);
        }
        input.setAttribute('aria-valuemin', input.min);
        input.setAttribute('aria-valuemax', input.max);
        input.setAttribute('aria-valuenow', input.value);
        input.setAttribute('aria-label', model.tooltip || model.label);
        const valueTip = doc.createElement('div');
        valueTip.className = 'aibar-slider__value';
        valueTip.hidden = true;
        valueTip.setAttribute('aria-hidden', 'true');
        if (s) valueTip.textContent = this.formatSliderValue(s.value);
        wrap.append(track, input, valueTip);
        el.appendChild(wrap);
        return;
      }
      case 'colorPicker': {
        el.setAttribute('role', 'radiogroup');
        el.setAttribute('aria-label', model.tooltip);
        for (const color of model.swatches ?? []) {
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'aibar-swatch';
          btn.setAttribute('role', 'radio');
          btn.setAttribute('aria-checked', String(color === model.selectedColor));
          btn.setAttribute('aria-label', color);
          btn.dataset.segmentKey = color;
          btn.style.background = color;
          if (color === model.selectedColor) btn.dataset.selected = 'true';
          el.appendChild(btn);
        }
        return;
      }
      case 'candidateList':
      case 'characterPicker': {
        // Horizontal free-scroll strip (NSCandidateList / characterPicker).
        // Inner scroller — not the packed item — owns overflow so drag-pan works
        // even when the root pointerdown path calls preventDefault.
        el.setAttribute('role', 'listbox');
        el.setAttribute('aria-label', model.tooltip);
        el.dataset.picker = model.type === 'characterPicker' ? 'character' : 'candidate';
        const scroll = doc.createElement('div');
        scroll.className = 'aibar-candidate__scroll';
        const track = doc.createElement('div');
        track.className = 'aibar-candidate__track';
        for (const value of model.candidates ?? []) {
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'aibar-candidate';
          btn.setAttribute('role', 'option');
          btn.dataset.segmentKey = value;
          btn.textContent = value;
          track.appendChild(btn);
        }
        scroll.appendChild(track);
        el.appendChild(scroll);
        if (typeof prevStripScroll === 'number' && prevStripScroll > 0) {
          scroll.scrollLeft = prevStripScroll;
        }
        return;
      }
      case 'scrubber': {
        // Virtualized horizontal selector (§7.6): only the kernel-provided
        // data slice exists in the DOM; a spacer keeps native scroll geometry.
        el.setAttribute('role', 'listbox');
        el.setAttribute('aria-label', model.tooltip);
        const sc = model.scrubber;
        if (!sc) return;
        const itemWidth = sc.itemWidth ?? 72;
        const scroll = doc.createElement('div');
        scroll.className = 'aibar-scrubber__scroll';
        scroll.dataset.itemWidth = String(itemWidth);
        const track = doc.createElement('div');
        track.className = 'aibar-scrubber__track';
        track.style.width = `${sc.count * itemWidth}px`;
        sc.slice.entries.forEach((entry, i) => {
          const index = sc.slice.start + i;
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'aibar-scrubber__item';
          btn.setAttribute('role', 'option');
          btn.setAttribute('aria-setsize', String(sc.count));
          btn.setAttribute('aria-posinset', String(index + 1));
          btn.dataset.scrubberIndex = String(index);
          btn.style.left = `${index * itemWidth}px`;
          btn.style.width = `${itemWidth}px`;
          if (index === sc.selectedIndex) btn.dataset.selected = 'true';
          btn.setAttribute('aria-selected', String(index === sc.selectedIndex));
          btn.title = entry.label;
          if (entry.imageUrl) {
            btn.classList.add('aibar-scrubber__item--image');
            const img = doc.createElement('img');
            img.className = 'aibar-scrubber__thumb';
            img.src = entry.imageUrl;
            img.alt = entry.label;
            img.draggable = false;
            img.loading = 'lazy';
            btn.appendChild(img);
          } else {
            // Compact Color-Emoji cells (iOS / Touch Bar scrubber).
            if ([...entry.label].length <= 4) btn.dataset.glyph = 'true';
            btn.textContent = entry.label;
          }
          track.appendChild(btn);
        });
        scroll.appendChild(track);
        el.appendChild(scroll);
        if (typeof prevStripScroll === 'number' && prevStripScroll > 0) {
          scroll.scrollLeft = prevStripScroll;
        } else if (sc.slice.start > 0) {
          scroll.scrollLeft = sc.slice.start * itemWidth;
        }
        return;
      }
      case 'custom': {
        // Controlled custom slot: the host locates it by data-custom-kind and
        // fills it (portal); geometry stays kernel-owned.
        el.setAttribute('role', 'group');
        el.setAttribute('aria-label', model.tooltip);
        if (model.customKind) el.dataset.customKind = model.customKind;
        const slot = doc.createElement('div');
        slot.className = 'aibar-custom__slot';
        slot.dataset.customSlot = model.customKind ?? '';
        slot.append(this.labelSpan(doc, model.label));
        el.appendChild(slot);
        return;
      }
      case 'approval': {
        el.setAttribute('role', 'group');
        el.setAttribute('aria-label', model.intentSummary ?? model.label);
        const flag = doc.createElement('span');
        flag.className = 'aibar-approval-flag';
        flag.textContent = '⚑';
        flag.setAttribute('aria-hidden', 'true');
        const summary = this.labelSpan(doc, model.intentSummary ?? model.label);
        // Deny is always nearest the Escape Zone (design §5.14)
        const deny = doc.createElement('button');
        deny.type = 'button';
        deny.className = 'aibar-approval-btn';
        deny.dataset.decision = 'deny';
        deny.textContent = model.segments?.find((s) => s.key === 'deny')?.label ?? '';
        const allow = doc.createElement('button');
        allow.type = 'button';
        allow.className = 'aibar-approval-btn';
        allow.dataset.decision = 'allow';
        allow.textContent = model.segments?.find((s) => s.key === 'allow')?.label ?? '';
        el.append(flag, summary, deny, allow);
        return;
      }
      default: {
        // button / mainButton / toggle / popover
        if (model.badge !== 'none') {
          const badge = doc.createElement('span');
          badge.className = 'aibar-item__badge';
          badge.textContent = model.badge === 'agent' ? '✦' : model.badge === 'remote' ? '◇' : '◆';
          badge.setAttribute('aria-hidden', 'true');
          el.appendChild(badge);
        }
        if (model.icon) {
          const icon = doc.createElement('span');
          icon.className = 'aibar-item__icon';
          icon.setAttribute('aria-hidden', 'true');
          if (model.icon.kind === 'svg') icon.innerHTML = model.icon.svg;
          else icon.textContent = model.icon.text;
          el.appendChild(icon);
        }
        if (model.showsLabel) el.append(this.labelSpan(doc, model.label));
        else el.setAttribute('aria-label', model.tooltip || model.label);
        // Overflow floor uses a TouchBar ellipsis — no popover chevron (design §9.1).
        // Icon-only popovers also skip the chevron to keep the strip dense.
        if (
          (model.type === 'popover' || model.hasChildren) &&
          model.disclosure !== 'overflow' &&
          model.showsLabel
        ) {
          el.setAttribute('aria-haspopup', 'true');
          const chev = doc.createElement('span');
          chev.className = 'aibar-popover-chevron';
          // Expand affordance (Touch Bar–style ›), not a downward menu caret.
          chev.textContent = '›';
          chev.setAttribute('aria-hidden', 'true');
          el.appendChild(chev);
        } else if (model.disclosure === 'overflow') {
          el.setAttribute('aria-haspopup', 'true');
          el.setAttribute('aria-label', model.tooltip || model.label);
          el.dataset.disclosure = 'overflow';
        } else if ((model.type === 'popover' || model.hasChildren) && !model.showsLabel) {
          el.setAttribute('aria-haspopup', 'true');
        }
        if (model.type === 'toggle') {
          el.setAttribute('aria-pressed', String(model.active ?? false));
        }
        if (model.pressAndHold) el.dataset.pressHold = 'true';
        else delete el.dataset.pressHold;
        if (model.morphing) el.dataset.morphing = 'true';
        else delete el.dataset.morphing;
      }
    }
  }

  private labelSpan(doc: Document, text: string): HTMLElement {
    const span = doc.createElement('span');
    span.className = 'aibar-item__label';
    span.textContent = text;
    return span;
  }

  private syncSliderFill(
    fill: HTMLElement,
    min: number,
    max: number,
    value: number,
  ): void {
    const span = Math.max(1e-6, max - min);
    const ratio = Math.min(1, Math.max(0, (value - min) / span));
    fill.style.transform = `scaleX(${ratio})`;
  }

  private formatSliderValue(value: number): string {
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(2).replace(/\.?0+$/, '');
  }

  private refreshSliderChrome(itemEl: HTMLElement, input: HTMLInputElement): void {
    const min = Number(input.min);
    const max = Number(input.max);
    const value = Number(input.value);
    const fill = itemEl.querySelector<HTMLElement>('.aibar-slider__fill');
    if (fill) this.syncSliderFill(fill, min, max, value);
    const tip = itemEl.querySelector<HTMLElement>('.aibar-slider__value');
    if (tip) {
      tip.textContent = this.formatSliderValue(value);
      tip.style.left = `${((value - min) / Math.max(1e-6, max - min)) * 100}%`;
    }
    input.setAttribute('aria-valuenow', input.value);
  }

  private buildMeter(doc: Document, progress: number): HTMLElement {
    const track = doc.createElement('span');
    track.className = 'aibar-meter';
    track.setAttribute('aria-hidden', 'true');
    const fill = doc.createElement('span');
    fill.className = 'aibar-meter__fill';
    const clamped = Math.min(1, Math.max(0, progress));
    fill.style.transform = `scaleX(${clamped})`;
    track.appendChild(fill);
    return track;
  }

  private updateMeter(el: HTMLElement, progress: number): void {
    const fill = el.querySelector<HTMLElement>('.aibar-meter__fill');
    if (!fill) return;
    const clamped = Math.min(1, Math.max(0, progress));
    fill.style.transform = `scaleX(${clamped})`;
    const tone = clamped >= 0.85 ? 'critical' : clamped >= 0.6 ? 'warn' : 'ok';
    el.dataset.tone = tone;
  }

  private buildRing(doc: Document, progress: number | undefined): SVGElement {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(svgNS, 'svg');
    svg.setAttribute('class', 'aibar-live-ring');
    svg.setAttribute('viewBox', '0 0 18 18');
    if (progress === undefined) svg.dataset.indeterminate = 'true';
    const mk = (cls: string) => {
      const c = doc.createElementNS(svgNS, 'circle');
      c.setAttribute('class', cls);
      c.setAttribute('cx', '9');
      c.setAttribute('cy', '9');
      c.setAttribute('r', '7');
      c.setAttribute('fill', 'none');
      c.setAttribute('stroke-width', '2');
      return c;
    };
    const track = mk('track');
    track.style.opacity = '0.3';
    const value = mk('value');
    const circumference = 2 * Math.PI * 7;
    value.setAttribute('stroke-dasharray', String(circumference));
    value.setAttribute('stroke-dashoffset', String(circumference * (1 - (progress ?? 0.25))));
    value.setAttribute('transform', 'rotate(-90 9 9)');
    svg.append(track, value);
    return svg;
  }

  private updateRing(el: HTMLElement, progress: number): void {
    const value = el.querySelector('.aibar-live-ring circle.value');
    const ring = el.querySelector('.aibar-live-ring');
    if (ring) (ring as SVGElement).removeAttribute('data-indeterminate');
    if (value) {
      const circumference = 2 * Math.PI * 7;
      value.setAttribute('stroke-dashoffset', String(circumference * (1 - progress)));
    }
  }

  // ——— escape zone ———

  private renderEscape(escape: RenderFrame['escape'], swapping = false): void {
    const zone = this.escapeZone!;
    if (!escape) {
      if (swapping && zone.dataset.aibarEscapeId) {
        // Fade Esc with the subsurface exit; clear after the swap window.
        zone.dataset.leaving = 'true';
        if (this.escapeLeaveTimer) clearTimeout(this.escapeLeaveTimer);
        this.escapeLeaveTimer = setTimeout(() => {
          this.escapeLeaveTimer = null;
          zone.replaceChildren();
          delete zone.dataset.aibarEscapeId;
          delete zone.dataset.leaving;
        }, PRESENTATION_SWAP_MS);
        return;
      }
      if (this.escapeLeaveTimer) {
        clearTimeout(this.escapeLeaveTimer);
        this.escapeLeaveTimer = null;
      }
      zone.replaceChildren();
      delete zone.dataset.aibarEscapeId;
      delete zone.dataset.leaving;
      return;
    }
    if (this.escapeLeaveTimer) {
      clearTimeout(this.escapeLeaveTimer);
      this.escapeLeaveTimer = null;
    }
    delete zone.dataset.leaving;
    if (zone.dataset.aibarEscapeId === escape.id && zone.firstChild) {
      // Refresh icon/label if the close affordance model changed.
      const el = zone.firstChild as HTMLElement;
      this.buildContent(el, escape.node);
      return;
    }
    zone.replaceChildren();
    zone.dataset.aibarEscapeId = escape.id;
    const el = this.acquireNode(escape.node.type);
    this.buildContent(el, escape.node);
    el.dataset.aibarId = escape.id;
    // Geometry is owned by `.aibar-escape` (left inset + width). Do not pin
    // absolute translateX packing onto the Esc chrome.
    el.style.position = 'static';
    el.style.width = '100%';
    el.style.transform = '';
    if (swapping) el.dataset.swapEnter = 'subsurface';
    zone.appendChild(el);
  }

  private onEscapeClick = (e: MouseEvent): void => {
    if (!this.sink || !this.escapeZone?.dataset.aibarEscapeId) return;
    if (this.escapeZone.dataset.leaving) return;
    e.stopPropagation();
    this.sink.escape();
  };

  // ——— input: pointer ———

  /**
   * Resolve a pointer/click target to an AIBar action while the hit node is
   * still connected (or still has its pre-detach parent chain).
   */
  private resolveTapAction(
    target: Element | null,
  ): { id: string; action: ArmedTapAction } | null {
    if (!target || !(target instanceof Element)) return null;
    const itemEl = target.closest<HTMLElement>('[data-aibar-id]');
    if (!itemEl || itemEl.dataset.leaving) return null;
    const id = itemEl.dataset.aibarId;
    if (!id) return null;

    const scrubberEntry = target.closest<HTMLElement>('[data-scrubber-index]');
    if (scrubberEntry) {
      return {
        id,
        action: { kind: 'selectIndex', index: Number(scrubberEntry.dataset.scrubberIndex) },
      };
    }
    const escapeId = this.escapeZone?.dataset.aibarEscapeId;
    if (id === escapeId && itemEl.closest('.aibar-escape')) {
      return { id, action: { kind: 'escape' } };
    }
    const node = this.nodes.get(id);
    const type = node?.model.type ?? itemEl.dataset.type;

    const segment = target.closest<HTMLElement>('[data-segment-key]');
    if (segment?.dataset.segmentKey) {
      return { id, action: { kind: 'selectSegment', key: segment.dataset.segmentKey } };
    }
    if (target.closest('[data-dismiss]')) {
      return { id, action: { kind: 'dismiss' } };
    }
    const decision = target.closest<HTMLElement>('[data-decision]');
    if (decision?.dataset.decision === 'allow' || decision?.dataset.decision === 'deny') {
      return {
        id,
        action: { kind: 'approve', decision: decision.dataset.decision },
      };
    }
    if (type === 'approval') return null;
    if (
      type &&
      ['slider', 'scrubber', 'colorPicker', 'candidateList', 'characterPicker', 'custom'].includes(
        type,
      )
    ) {
      return null;
    }
    if (node?.state === 'disabled' || node?.state === 'loading') return null;
    if (type === 'popover' || node?.model.hasChildren) {
      return { id, action: { kind: 'openPopover' } };
    }
    return { id, action: { kind: 'invoke' } };
  }

  private dispatchTapAction(id: string, action: ArmedTapAction): void {
    if (!this.sink) return;
    // Re-check live node state — arming may have raced a loading/disable transition.
    const node = this.nodes.get(id);
    if (action.kind === 'invoke' || action.kind === 'openPopover') {
      if (node?.state === 'disabled' || node?.state === 'loading') return;
    }
    switch (action.kind) {
      case 'selectIndex':
        this.sink.selectIndex?.(id as never, action.index);
        return;
      case 'escape':
        this.sink.escape();
        return;
      case 'selectSegment':
        this.sink.selectSegment(id as never, action.key);
        return;
      case 'dismiss':
        this.sink.dismiss(id as never);
        return;
      case 'approve':
        this.sink.approve(id as never, action.decision);
        return;
      case 'openPopover':
        this.sink.openPopover(id as never);
        return;
      case 'invoke':
        this.sink.invoke(id as never);
        return;
    }
  }

  private onClick = (e: MouseEvent): void => {
    if (!this.sink) return;
    if (Date.now() < this.suppressClickUntil) return; // press-and-hold / armed tap / scrub-drag
    const hit = this.resolveTapAction(e.target as Element | null);
    if (!hit) return;
    this.dispatchTapAction(hit.id, hit.action);
  };

  // ——— input: composite controls (slider / scrubber / press-and-hold) ———

  private onInput = (e: Event): void => {
    const target = e.target as HTMLElement;
    if (!(target instanceof HTMLInputElement) || !target.dataset.aibarSlider) return;
    const itemEl = target.closest<HTMLElement>('[data-aibar-id]');
    if (!itemEl) return;
    this.refreshSliderChrome(itemEl, target);
    this.sink?.changeValue?.(itemEl.dataset.aibarId! as never, Number(target.value));
  };

  /** Scrubber viewport scroll → ask the kernel for a different data window (§7.6). */
  private onScroll = (e: Event): void => {
    // Mid-pan rebuilds would destroy the captured scroll node — wait for pointerup.
    if (this.stripPan?.moved) return;
    const target = e.target as HTMLElement;
    if (!target.classList?.contains('aibar-scrubber__scroll')) return;
    const id = target.closest<HTMLElement>('[data-aibar-id]')?.dataset.aibarId;
    if (!id) return;
    const itemWidth = Number(target.dataset.itemWidth) || 72;
    this.sink?.scrubTo?.(id as never, Math.floor(target.scrollLeft / itemWidth));
  };

  /**
   * Map wheel / trackpad deltas onto free-scroll strips.
   * Vertical wheel over a horizontal strip pans left/right so suggestions stay
   * reachable without Shift+wheel.
   */
  private onWheel = (e: WheelEvent): void => {
    const target = e.target as HTMLElement | null;
    const scroll = target?.closest?.<HTMLElement>(STRIP_SCROLL_SELECTOR);
    if (!scroll) return;
    const max = scroll.scrollWidth - scroll.clientWidth;
    if (max <= 0) return;
    const dx =
      Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    if (dx === 0) return;
    const next = Math.max(0, Math.min(max, scroll.scrollLeft + dx));
    if (next === scroll.scrollLeft) return;
    e.preventDefault();
    scroll.scrollLeft = next;
    if (scroll.classList.contains('aibar-scrubber__scroll') && !this.stripPan?.moved) {
      const id = scroll.closest<HTMLElement>('[data-aibar-id]')?.dataset.aibarId;
      const itemWidth = Number(scroll.dataset.itemWidth) || 72;
      if (id) this.sink?.scrubTo?.(id as never, Math.floor(next / itemWidth));
    }
  };

  /**
   * Strip interaction contract:
   * - Tap on a candidate / scrubber cell / category tab → native click → select
   * - Drag past threshold → pan scrollLeft (Touch Bar free scrub)
   * - Never preventDefault while arming a strip pan (that kills click)
   * - Never preventDefault on real `button` / form controls / cell targets —
   *   Pointer Events: preventDefault on pointerdown suppresses the
   *   compatibility `click`, so pet / emoji / popover expands look dead
   * - Non-interactive chrome (label / spacer) may preventDefault to avoid
   *   focus theft into the strip
   * - Arm bar taps on pointerdown so a mid-gesture `update`/`replaceChildren`
   *   cannot drop the activation (detached click target).
   */
  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    this.armedTap = null;

    const stripScroll = target.closest<HTMLElement>(STRIP_SCROLL_SELECTOR);
    if (stripScroll) {
      this.stripPan = {
        scroll: stripScroll,
        pointerId: e.pointerId,
        startX: e.clientX,
        startLeft: stripScroll.scrollLeft,
        moved: false,
        captured: false,
      };
      // Still arm cell / segment taps so a rebuild between down and up cannot
      // drop selection (strip pan clears the arm if the gesture becomes a drag).
      const stripHit = this.resolveTapAction(target);
      if (stripHit) {
        this.armedTap = { pointerId: e.pointerId, id: stripHit.id, action: stripHit.action };
      }
      return;
    }

    const itemEl = target.closest?.<HTMLElement>('[data-aibar-id], .aibar-escape');
    const interactiveHit = target.closest?.(
      [
        'button',
        'a',
        'input',
        'textarea',
        'select',
        'label',
        '[data-aibar-host-interactive]',
        '[data-scrubber-index]',
        '[data-segment-key]',
        '[data-dismiss]',
        '[data-decision]',
      ].join(', '),
    );
    if (itemEl && !interactiveHit) e.preventDefault();

    const sliderInput = target.closest<HTMLInputElement>('.aibar-slider__input');
    if (sliderInput) {
      const sliderItem = sliderInput.closest<HTMLElement>('[data-aibar-id]');
      if (sliderItem) {
        sliderItem.dataset.dragging = 'true';
        const tip = sliderItem.querySelector<HTMLElement>('.aibar-slider__value');
        if (tip) tip.hidden = false;
        this.refreshSliderChrome(sliderItem, sliderInput);
      }
      return;
    }

    const hit = this.resolveTapAction(target);
    if (hit) {
      this.armedTap = { pointerId: e.pointerId, id: hit.id, action: hit.action };
    }

    const pressEl = target.closest<HTMLElement>('[data-aibar-id]');
    if (!pressEl?.dataset.pressHold) return;
    const id = pressEl.dataset.aibarId!;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      this.holdId = id;
      this.armedTap = null; // press-and-hold owns the gesture
      this.sink?.openPopover(id as never);
    }, PRESS_AND_HOLD_MS);
  };

  private onPointerMove = (e: PointerEvent): void => {
    const pan = this.stripPan;
    if (!pan || e.pointerId !== pan.pointerId) return;
    const dx = e.clientX - pan.startX;
    if (!pan.moved) {
      if (Math.abs(dx) < STRIP_PAN_THRESHOLD_PX) return;
      pan.moved = true;
      this.armedTap = null; // pan consumed the tap
      try {
        pan.scroll.setPointerCapture(e.pointerId);
        pan.captured = true;
      } catch {
        /* jsdom / already released */
      }
    }
    pan.scroll.scrollLeft = pan.startLeft - dx;
  };

  private onPointerUp = (e: PointerEvent): void => {
    // Cancelled gestures must not activate — clear arm and bail.
    if (e.type === 'pointercancel') {
      if (this.armedTap?.pointerId === e.pointerId) this.armedTap = null;
      if (this.stripPan?.pointerId === e.pointerId) {
        const pan = this.stripPan;
        this.stripPan = null;
        if (pan.captured) {
          try {
            pan.scroll.releasePointerCapture(e.pointerId);
          } catch {
            /* already released */
          }
        }
      }
      if (this.holdTimer) {
        clearTimeout(this.holdTimer);
        this.holdTimer = null;
      }
      this.holdId = null;
      return;
    }

    if (this.stripPan && e.pointerId === this.stripPan.pointerId) {
      const pan = this.stripPan;
      this.stripPan = null;
      if (pan.moved) {
        // Pan consumed the gesture — suppress the synthetic click.
        this.armedTap = null;
        this.suppressClickUntil = Date.now() + 120;
        if (pan.scroll.classList.contains('aibar-scrubber__scroll')) {
          const id = pan.scroll.closest<HTMLElement>('[data-aibar-id]')?.dataset.aibarId;
          const itemWidth = Number(pan.scroll.dataset.itemWidth) || 72;
          if (id) {
            this.sink?.scrubTo?.(id as never, Math.floor(pan.scroll.scrollLeft / itemWidth));
          }
        }
      }
      if (pan.captured) {
        try {
          pan.scroll.releasePointerCapture(e.pointerId);
        } catch {
          /* already released */
        }
      }
      // Tap path: fire armed action (survives mid-gesture rebuilds), then
      // suppress the compatibility click so we do not double-invoke.
      if (this.armedTap && this.armedTap.pointerId === e.pointerId) {
        const armed = this.armedTap;
        this.armedTap = null;
        this.dispatchTapAction(armed.id, armed.action);
        this.suppressClickUntil = Date.now() + 120;
      }
      return;
    }

    const dragging = this.root?.querySelectorAll<HTMLElement>('[data-dragging="true"]');
    dragging?.forEach((el) => {
      delete el.dataset.dragging;
      const tip = el.querySelector<HTMLElement>('.aibar-slider__value');
      if (tip) tip.hidden = true;
    });

    if (this.holdTimer) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
    if (this.holdId) {
      const heldId = this.holdId;
      this.holdId = null;
      this.armedTap = null;
      // Ignore the synthetic click that follows this release.
      this.suppressClickUntil = Date.now() + 120;
      const doc = this.root?.ownerDocument;
      const under =
        typeof doc?.elementFromPoint === 'function'
          ? doc.elementFromPoint(e.clientX, e.clientY)
          : null;
      const releasedOn = (under as HTMLElement | null)?.closest?.<HTMLElement>('[data-aibar-id]');
      const releasedId = releasedOn?.dataset.aibarId;
      // Apple pressAndHoldTouchBar: release-to-select, then always dismiss
      // (finger-up ends the transient popover even if selection is a no-op).
      if (releasedId && releasedId !== heldId) {
        this.sink?.invoke(releasedId as never);
      }
      this.sink?.escape();
      return;
    }

    if (this.armedTap && this.armedTap.pointerId === e.pointerId) {
      const armed = this.armedTap;
      this.armedTap = null;
      this.dispatchTapAction(armed.id, armed.action);
      this.suppressClickUntil = Date.now() + 120;
    }
  };

  /** Right-click → scrubber preview when available, else host context menu. */
  private onContextMenu = (e: MouseEvent): void => {
    const scrubberEntry = (e.target as HTMLElement).closest<HTMLElement>('[data-scrubber-index]');
    if (scrubberEntry) {
      const id = scrubberEntry.closest<HTMLElement>('[data-aibar-id]')?.dataset.aibarId;
      if (id && this.sink?.previewIndex) {
        e.preventDefault();
        this.sink.previewIndex(id as never, Number(scrubberEntry.dataset.scrubberIndex));
        return;
      }
    }
    const contextMenu = this.sink?.contextMenu;
    if (!contextMenu) return;
    const itemEl = (e.target as HTMLElement).closest<HTMLElement>('[data-aibar-id]');
    if (!itemEl) return;
    e.preventDefault();
    contextMenu.call(this.sink, itemEl.dataset.aibarId! as never, e.clientX, e.clientY);
  };

  // ——— input: keyboard (design §8.2; single tab stop, roving tabindex) ———

  private focusables(): HTMLElement[] {
    const out: HTMLElement[] = [];
    const escapeEl = this.escapeZone?.querySelector<HTMLElement>('[data-aibar-id]');
    if (escapeEl) out.push(escapeEl);
    for (const id of this.order) {
      const node = this.nodes.get(id);
      if (!node) continue;
      const { type } = node.model;
      if (['label', 'spacerSmall', 'spacerLarge', 'spacerFlexible'].includes(type)) continue;
      if (type === 'segmented') {
        out.push(...node.el.querySelectorAll<HTMLElement>('.aibar-segment'));
      } else if (type === 'slider') {
        out.push(...node.el.querySelectorAll<HTMLElement>('.aibar-slider__input'));
      } else if (type === 'colorPicker') {
        out.push(...node.el.querySelectorAll<HTMLElement>('.aibar-swatch'));
      } else if (type === 'candidateList' || type === 'characterPicker') {
        out.push(...node.el.querySelectorAll<HTMLElement>('.aibar-candidate'));
      } else if (type === 'scrubber') {
        out.push(...node.el.querySelectorAll<HTMLElement>('.aibar-scrubber__item'));
      } else if (type === 'suggestion') {
        const body = node.el.querySelector<HTMLElement>('[data-suggestion-accept]');
        const dismiss = node.el.querySelector<HTMLElement>('[data-dismiss]');
        if (body) out.push(body);
        if (dismiss) out.push(dismiss);
      } else if (type === 'approval') {
        out.push(...node.el.querySelectorAll<HTMLElement>('[data-decision]'));
      } else if (node.state !== 'disabled') {
        out.push(node.el);
      }
    }
    return out;
  }

  private syncTabindex(): void {
    const focusables = this.focusables();
    focusables.forEach((el, i) => {
      el.tabIndex = i === Math.max(0, this.focusIndex) ? 0 : -1;
    });
  }

  private moveFocus(index: number): void {
    const focusables = this.focusables();
    if (focusables.length === 0) return;
    const clamped = Math.max(0, Math.min(focusables.length - 1, index));
    this.focusIndex = clamped;
    focusables.forEach((el, i) => {
      el.tabIndex = i === clamped ? 0 : -1;
    });
    focusables[clamped]?.focus({ preventScroll: true });
  }

  private toggleFocus(): void {
    const doc = this.root?.ownerDocument;
    if (!doc) return;
    if (this.root!.contains(doc.activeElement)) {
      (this.lastHostFocus as HTMLElement | null)?.focus?.();
      this.lastHostFocus = null;
    } else {
      this.lastHostFocus = doc.activeElement;
      this.moveFocus(this.focusIndex >= 0 ? this.focusIndex : 0);
    }
  }

  private onFocusIn = (e: FocusEvent): void => {
    const index = this.focusables().indexOf(e.target as HTMLElement);
    if (index >= 0) this.focusIndex = index;
  };

  private onKeydown = (e: KeyboardEvent): void => {
    if (!this.sink) return;
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault();
        this.moveFocus(this.focusIndex + 1);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        this.moveFocus(this.focusIndex - 1);
        break;
      case 'Home':
        e.preventDefault();
        this.moveFocus(0);
        break;
      case 'End':
        e.preventDefault();
        this.moveFocus(this.focusables().length - 1);
        break;
      case 'Escape': {
        e.preventDefault();
        this.sink.escape();
        break;
      }
      case 'Delete':
      case 'Backspace': {
        const el = (e.target as HTMLElement).closest<HTMLElement>('[data-aibar-id]');
        if (el && this.nodes.get(el.dataset.aibarId!)?.model.type === 'suggestion') {
          e.preventDefault();
          this.sink.dismiss(el.dataset.aibarId! as never);
        }
        break;
      }
      // Enter/Space activate the focused native button → click delegation.
    }
  };

  destroy(): void {
    const doc = this.root?.ownerDocument;
    if (this.docKeydown && doc) doc.removeEventListener('keydown', this.docKeydown);
    this.resizeObserver?.disconnect();
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.armedTap = null;
    this.stripPan = null;
    this.flushLeaving(true);
    this.root?.removeEventListener('click', this.onClick);
    this.escapeZone?.removeEventListener('click', this.onEscapeClick);
    this.root?.removeEventListener('contextmenu', this.onContextMenu);
    this.root?.removeEventListener('keydown', this.onKeydown);
    this.root?.removeEventListener('focusin', this.onFocusIn);
    this.root?.removeEventListener('input', this.onInput);
    this.root?.removeEventListener('scroll', this.onScroll, true);
    this.root?.removeEventListener('wheel', this.onWheel);
    this.root?.removeEventListener('pointerdown', this.onPointerDown);
    this.root?.removeEventListener('pointermove', this.onPointerMove);
    this.root?.removeEventListener('pointerup', this.onPointerUp);
    this.root?.removeEventListener('pointercancel', this.onPointerUp);
    this.root?.remove();
    this.root = null;
    this.itemsLayer = null;
    this.escapeZone = null;
    this.nodes.clear();
    this.pool.clear();
    this.resizeListeners.clear();
    this.sink = null;
  }
}
