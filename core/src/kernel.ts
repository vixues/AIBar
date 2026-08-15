/**
 * AIBar kernel — orchestration (docs/aibar-architecture.md §3–§8).
 *
 * Owns the context hub, item registry, dual-lane resolver, layout epochs,
 * item logical states, the escape/popover stack, the overflow popover, action
 * dispatch (with the human gate), frecency statistics, and frame diffing.
 * Never touches the DOM (INV-A4): all environment access flows through the
 * RendererBackend and the HostAdapter.
 */
import {
  DEFAULT_SUGGESTION_POLICY,
  asItemIdentifier,
  type AIBarDefinitionSpec,
  type AIBarItemIdentifier,
  type SuggestionPolicy,
} from '@aibar/protocol';
import { resolveChromeLabel } from './labels';
import { ContextHub, type AIBarContext } from './context';
import { EventBus, type AIBarEvent, type SurfaceState } from './events';
import type {
  ActionOutcome,
  AIBarHostAdapter,
  SuggestionCandidate,
} from './host-adapter';
import {
  defineItem,
  ItemRegistry,
  type AIBarDelegate,
  type AIBarItem,
  type AIBarItemInput,
  type ItemProvider,
} from './items';
import { interpolateParams } from './predicate-eval';
import {
  DENSITY_METRICS,
  EMPTY_STABILITY,
  resolve,
  type Density,
  type PlacedItem,
  type ResolvedPlan,
  type StabilityState,
} from './resolver';
import type {
  Box,
  ItemRenderModel,
  ItemVisualState,
  ProvenanceBadge,
  RenderFrame,
  RendererBackend,
  RenderOp,
  SurfaceInputSink,
  SurfacePresentation,
} from './renderer-backend';

const OVERFLOW_ID = asItemIdentifier('core.aibar.popover.overflow');
const OVERFLOW_PALETTE_ID = asItemIdentifier('core.aibar.button.overflow-palette');
const ESCAPE_CLOSE_ID = asItemIdentifier('core.aibar.button.escape-close');
/** Inline expand showsCloseButton — leading collapse key next to spliced children. */
const INLINE_COLLAPSE_ID = asItemIdentifier('core.aibar.button.inline-collapse');
const SYSTEM_TOGGLE_ID = asItemIdentifier('core.aibar.button.system-toggle');
const LIVE_CLUSTER_ID = asItemIdentifier('core.aibar.popover.live-cluster');

/** Live Cluster morph (arch §2.3): ≥ this many live items collapse the rest. */
const LIVE_CLUSTER_MAX = 3;
/** Live Cluster morph expand duration + rate limit (design §2.3). */
const LIVE_MORPH_MS = 240;
const LIVE_MORPH_INTERVAL_MS = 10_000;
/** hostItemsProxy expansion depth ceiling (§4.4). */
const PROXY_MAX_DEPTH = 2;
/** Scrubber virtualization: viewport slice + overscan (§7.6). */
const SCRUBBER_WINDOW = 24;
const SCRUBBER_OVERSCAN = 4;
/**
 * At or below this count, paint the full scrubber track and skip windowing.
 * Emoji / session strips stay swipeable without mid-drag DOM rebuilds that
 * would drop pointer capture.
 */
const SCRUBBER_FULL_PAINT_MAX = 320;

/** NFR-1 resolve budget (§11.2); sustained overruns walk the §11.3 ladder. */
const RESOLVE_BUDGET_MS = 8;
/** Rolling perf-sample window feeding the degradation ladder. */
const PERF_WINDOW = 10;

/** characterPicker default set when the host supplies none. */
const DEFAULT_CHARACTERS = [
  '😀', '😂', '😊', '😍', '🤔', '👍', '👎', '🎉', '🔥', '❤️', '✨', '🙏',
  '👏', '💡', '⚡', '✅', '❌', '⭐', '🚀', '🌈',
];

/** Collapsed System Strip shows at most this many items (design §2.2). */
const SYSTEM_COLLAPSED_MAX = 3;
/** Expanded System Strip auto-collapses after this idle window (design §2.2). */
const SYSTEM_EXPAND_IDLE_MS = 8000;

const ERROR_RECOVERY_MS = 2000;
const ANNOUNCE_THROTTLE_MS = 2000;
const FRECENCY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/** Registry owner id for kernel-managed intent-lane suggestions. */
const INTENT_PUBLISHER = 'aibar.intent';
/** Debounce between a signal and the background prediction call. */
const INTENT_DEBOUNCE_MS = 250;
/** §12.6: a strategy that hangs past this is skipped for the cycle. */
const INTENT_TIMEOUT_MS = 2000;
/** §6.5: at most one suggestion replacement per 5 s. */
const SUGGESTION_REPLACE_INTERVAL_MS = 5000;
/** §6.2: a suggestion neither accepted nor dismissed expires silently. */
const SUGGESTION_TTL_MS = 30_000;

interface FrecencyEntry {
  count: number;
  last: number;
}

interface SubSurface {
  kind: 'popover' | 'overflow';
  triggerId: AIBarItemIdentifier;
  items: AIBarItem[];
}

export interface SurfaceReadback {
  revision: number;
  visible: AIBarItemIdentifier[];
  overflowed: AIBarItemIdentifier[];
  suggestions: { id: AIBarItemIdentifier; confidence: number; state: 'shown' }[];
  pendingApprovals: AIBarItemIdentifier[];
}

export interface AIBarKernelOptions {
  adapter: AIBarHostAdapter;
  definition: AIBarDefinitionSpec;
  density?: Density;
  now?: () => number;
  /** Pre-built items that skip the delegate (NSTouchBar templateItems, §4.1). */
  templateItems?: ReadonlyMap<AIBarItemIdentifier, AIBarItem>;
  /** Lazy item construction (touchBar(_:makeItemForIdentifier:), §4.1). */
  delegate?: AIBarDelegate;
}

export class AIBarKernel {
  readonly adapter: AIBarHostAdapter;
  readonly definition: AIBarDefinitionSpec;
  readonly registry = new ItemRegistry();
  readonly events = new EventBus();
  readonly contextHub: ContextHub;
  density: Density;

  private backend: RendererBackend | null = null;
  private readonly now: () => number;
  private suggestionPolicy: SuggestionPolicy;

  private stability: StabilityState = EMPTY_STABILITY;
  private epoch = 0;
  private plan: ResolvedPlan | null = null;
  private subStack: SubSurface[] = [];
  /**
   * Inline popover expand: trigger id whose children are spliced into the
   * ground strip (presentation stays `ground`; no Escape Zone swap).
   */
  private inlineExpandedId: AIBarItemIdentifier | null = null;
  /** Ground LayoutPlan frozen at showPopover (design §2.2 / NS dismiss restore). */
  private cachedGroundPlan: ResolvedPlan | null = null;
  private cachedGroundStability: StabilityState | null = null;
  private groundCacheContextRevision: number | null = null;
  /** Last committed presentation — drives cross-layer frame diffs. */
  private lastPresentation: SurfacePresentation = 'ground';

  private states = new Map<AIBarItemIdentifier, ItemVisualState>();
  private errorTimers = new Map<AIBarItemIdentifier, ReturnType<typeof setTimeout>>();
  private streaming = new Set<AIBarItemIdentifier>();

  private prevModels = new Map<AIBarItemIdentifier, { model: ItemRenderModel; box: Box; state: ItemVisualState }>();
  private resolveScheduled = false;
  private frameScheduled = false;
  private pendingStateOps: RenderOp[] = [];

  private frecency = new Map<AIBarItemIdentifier, FrecencyEntry>();
  private pinned = new Set<AIBarItemIdentifier>();
  private frecencySaveScheduled = false;

  private intentTimer: ReturnType<typeof setTimeout> | null = null;
  private intentPredicting = false;
  private recentActionKeys: string[] = [];
  private lastSuggestionApplyAt = 0;
  private lastIntentContextKey = '';

  // customization (FR-5): user-owned order + hidden set, persisted
  private customOrder: AIBarItemIdentifier[] | null = null;
  private hiddenIds = new Set<AIBarItemIdentifier>();
  private customizingSnapshot: {
    order: AIBarItemIdentifier[] | null;
    hidden: AIBarItemIdentifier[];
  } | null = null;

  // System Strip collapse/expand (design §2.2)
  private systemExpanded = false;
  private systemIdleTimer: ReturnType<typeof setTimeout> | null = null;

  // fnMode (§8.2): alternate item set while the host holds its fn modifier
  private fnActive = false;

  // Live Cluster morph (design §2.3): once / 10s / run, ≤240 ms expand
  private lastLiveMorphByRun = new Map<string, number>();
  private prevRunStatuses = new Map<string, string>();
  private morphingLiveIds = new Set<AIBarItemIdentifier>();
  private morphTimers = new Map<AIBarItemIdentifier, ReturnType<typeof setTimeout>>();

  // delegate lookup (§4.1): templateItems → makeItem → unresolved, cached
  private readonly templateItems: ReadonlyMap<AIBarItemIdentifier, AIBarItem>;
  private readonly delegate: AIBarDelegate | null;
  private delegateAttempted = new Set<AIBarItemIdentifier>();

  // scrubber virtualization: id → current data-slice start index
  private scrubberWindows = new Map<AIBarItemIdentifier, number>();
  /** Scrubber selection paint (design §5.6); independent of the virtual window. */
  private scrubberSelected = new Map<AIBarItemIdentifier, number>();

  // §6.6 sliced invalidation: context slices the last resolve actually read
  private lastReadSlices: Set<string> | null = null;
  // §11.3 degradation ladder
  private resolveDurations: number[] = [];
  private degradeLevel: 0 | 1 | 2 = 0;
  private lastResolveMs = 0;

  private surfaceState: SurfaceState = 'idle';
  private lastAnnounceAt = 0;
  private pendingAnnounce: string | undefined;
  private baseOrderCounter = 0;
  private baseOrder = new Map<AIBarItemIdentifier, number>();
  private disposers: (() => void)[] = [];
  private hotkeyDisposers = new Map<AIBarItemIdentifier, () => void>();
  private destroyed = false;

  constructor(opts: AIBarKernelOptions) {
    this.adapter = opts.adapter;
    this.definition = opts.definition;
    this.templateItems = opts.templateItems ?? new Map();
    this.delegate = opts.delegate ?? null;
    this.density = opts.density ?? 'regular';
    this.now = opts.now ?? (() => Date.now());
    this.suggestionPolicy = {
      ...DEFAULT_SUGGESTION_POLICY,
      ...opts.definition.suggestionPolicy,
    };

    this.contextHub = new ContextHub({ now: this.now });
    for (const provider of this.adapter.contextProviders) {
      this.disposers.push(this.contextHub.register(provider));
    }
    this.disposers.push(this.contextHub.onChange((_ctx, dirtySlices) => {
      // §6.6: skip the wave entirely when no read slice was invalidated.
      if (this.shouldSkipResolve(dirtySlices)) return;
      this.scheduleResolve();
      this.onContextChangedForIntent();
    }));
    this.disposers.push(this.registry.onChange(() => {
      this.syncHotkeys();
      this.scheduleResolve();
    }));
    this.disposers.push(this.events.on((e) => {
      if (e.type === 'aibar.action.invoked') {
        this.recentActionKeys.push(e.id);
        if (this.recentActionKeys.length > 16) this.recentActionKeys.shift();
        this.schedulePredict();
      }
    }));

    // Definition default order seeds base ordering (P5 anchoring baseline).
    for (const id of this.definition.defaultItemIdentifiers) this.noteBaseOrder(id);

    void this.loadPersisted();
  }

  // ——— item contribution (in-process, trust tier 1) ———

  register(input: AIBarItemInput): () => void {
    const item = defineItem(input);
    this.noteBaseOrder(item.id);
    return this.registry.register(item);
  }

  registerProvider(provider: ItemProvider): () => void {
    for (const input of provider.items()) this.noteBaseOrder(input.id);
    return this.registry.registerProvider(provider);
  }

  /** Wire-side upsert used by the ingress (provenance already stamped). */
  upsertWireItem(item: AIBarItem, publisherId: string): void {
    this.noteBaseOrder(item.id);
    this.registry.upsert(item, publisherId);
    this.events.emit({ type: 'aibar.item.publish', id: item.id, publisherId });
  }

  removeItem(id: AIBarItemIdentifier, reason = 'revoked'): void {
    if (this.registry.remove(id)) {
      this.events.emit({ type: 'aibar.item.dismiss', id, reason });
    }
  }

  removeWhere(fn: (item: AIBarItem, owner: string) => boolean): AIBarItemIdentifier[] {
    return this.registry.removeWhere(fn);
  }

  private noteBaseOrder(id: AIBarItemIdentifier): void {
    if (!this.baseOrder.has(id)) this.baseOrder.set(id, this.baseOrderCounter++);
  }

  // ——— renderer attachment ———

  attach(backend: RendererBackend, container: unknown): void {
    this.backend = backend;
    backend.mount(container, this.inputSink());
    this.disposers.push(backend.onResize(() => this.scheduleResolve()));
    this.applyTheme();
    if (this.adapter.theme) {
      this.disposers.push(this.adapter.theme.subscribe(() => this.applyTheme()));
    }
    this.contextHub.flushNow();
    this.scheduleResolve();
  }

  /** Detach the renderer without destroying kernel state (remount-safe). */
  detach(): void {
    this.backend?.destroy();
    this.backend = null;
    this.prevModels = new Map();
    this.pendingStateOps = [];
    this.frameScheduled = false;
    // Popover / loading must not survive a remount — otherwise clicks look dead
    // (stuck loading) or the bar reopens into a stale sub-surface.
    this.subStack = [];
    this.inlineExpandedId = null;
    this.clearGroundCache();
    this.lastPresentation = 'ground';
    this.states.clear();
  }

  /** Sync layout density with the mounted surface (composer = compact). */
  setDensity(density: Density): void {
    if (this.density === density) return;
    this.density = density;
    this.scheduleResolve();
  }

  private applyTheme(): void {
    if (this.backend && this.adapter.theme) {
      this.backend.applyThemeTokens(this.adapter.theme.tokens());
    }
  }

  // ——— surface input (SurfaceInputSink) ———

  inputSink(): SurfaceInputSink {
    return {
      contextMenu: (id, x, y) =>
        this.events.emit({ type: 'aibar.item.contextmenu', id, x, y }),
      invoke: (id) => void this.invoke(id),
      selectSegment: (id, key) => {
        const item = this.findItem(id);
        const ctx = this.contextHub.current();
        if (item?.type === 'colorPicker' && item.onSelectColor) {
          item.onSelectColor(ctx, key);
        } else if (
          (item?.type === 'candidateList' || item?.type === 'characterPicker') &&
          item.onSelectCandidate
        ) {
          item.onSelectCandidate(ctx, key);
        } else if (item?.onSelectSegment) {
          item.onSelectSegment(ctx, key);
        } else {
          void this.invoke(id, { segment: key });
          return;
        }
        this.recordFrecency(id);
        this.scheduleResolve();
      },
      changeValue: (id, value) => this.changeSliderValue(id, value),
      selectIndex: (id, index) => this.selectScrubberIndex(id, index),
      previewIndex: (id, index) => this.previewScrubberIndex(id, index),
      scrubTo: (id, start) => this.scrubTo(id, start),
      openPopover: (id) => this.openPopover(id),
      escape: () => this.escape(),
      dismiss: (id) => this.dismiss(id),
      approve: (id, decision) => void this.approve(id, decision),
    };
  }

  // ——— slider / scrubber input (§4.3) ———

  private changeSliderValue(id: AIBarItemIdentifier, value: number): void {
    const item = this.findItem(id);
    if (!item || item.type !== 'slider' || !item.slider) return;
    const clamped = Math.min(item.slider.max, Math.max(item.slider.min, value));
    item.slider = { ...item.slider, value: clamped };
    const ctx = this.contextHub.current();
    if (item.onSliderChange) {
      item.onSliderChange(ctx, clamped);
    } else if (item.action) {
      void this.adapter.dispatchAction({
        itemId: id,
        name: item.action.name,
        params: { ...interpolateParams(ctx, item.action.params), value: clamped },
        effect: item.effect,
        provenance: item.provenance,
        contextRevision: ctx.revision,
      });
    }
    this.recordFrecency(id);
    this.scheduleFrame();
  }

  private selectScrubberIndex(id: AIBarItemIdentifier, index: number): void {
    const item = this.findItem(id);
    if (!item) return;
    // Apple NSScrubberDelegate.didFinishInteracting → dismissPopover.
    const dismissAfter =
      this.isActiveSubSurfaceChild(id) || this.activeSubSurfaceTrigger() === id;
    if (item.scrubber) {
      const ctx = this.contextHub.current();
      const count = item.scrubber.dataSource.count(ctx);
      if (index < 0 || index >= count) return;
      this.scrubberSelected.set(id, index);
      item.scrubber.delegate.onSelect(index, item.scrubber.dataSource.itemAt(index));
      this.recordFrecency(id);
      if (dismissAfter) this.closeSubSurface();
      else this.scheduleResolve();
      return;
    }
    // Compression-ladder scrubber (collapsed homogeneous group): select = invoke child.
    // invoke() auto-dismisses popover children.
    this.scrubberSelected.set(id, index);
    const child = item.children?.[index];
    if (child) void this.invoke(child.id);
    else this.scheduleFrame();
  }

  private previewScrubberIndex(id: AIBarItemIdentifier, index: number): void {
    const item = this.findItem(id);
    if (!item?.scrubber?.delegate.onPreview) return;
    const ctx = this.contextHub.current();
    const count = item.scrubber.dataSource.count(ctx);
    if (index < 0 || index >= count) return;
    item.scrubber.delegate.onPreview(index, item.scrubber.dataSource.itemAt(index));
  }

  private scrubTo(id: AIBarItemIdentifier, start: number): void {
    const item = this.findItem(id);
    if (item?.scrubber) {
      const count = item.scrubber.dataSource.count(this.contextHub.current());
      // Full-paint strips: native overflow scroll is enough; avoid rebuilds.
      if (count <= SCRUBBER_FULL_PAINT_MAX) return;
    }
    const next = Math.max(0, start - SCRUBBER_OVERSCAN);
    if (this.scrubberWindows.get(id) === next) return;
    this.scrubberWindows.set(id, next);
    this.scheduleResolve();
  }

  async invoke(id: AIBarItemIdentifier, extraParams?: Record<string, unknown>): Promise<void> {
    if (this.systemExpanded) this.resetSystemIdle(); // interaction defers auto-collapse
    const item = this.findItem(id);
    if (!item) return;
    const state = this.states.get(id);
    if (state === 'loading' || state === 'disabled') return;

    if (item.type === 'popover' || (item.type === 'group' && this.isCollapsed(id))) {
      this.openPopover(id);
      return;
    }
    if (item.type === 'approval') return; // approvals resolve via approve()

    const ctx = this.contextHub.current();
    // Apple scrubber/popover pattern: selecting a child dismisses the popover
    // (dismissPopover). Capture before onInvoke may close it itself.
    const dismissPopoverAfter = this.isActiveSubSurfaceChild(id);
    // Ground-strip interaction collapses an inline expand (click elsewhere).
    if (this.inlineExpandedId && !dismissPopoverAfter) {
      this.inlineExpandedId = null;
      this.scheduleResolve();
    }

    if (item.type === 'suggestion') {
      this.events.emit({
        type: 'aibar.suggestion.accepted',
        id,
        confidence: item.confidence ?? 0,
      });
    }

    // Human gate (INV-A8): destructive effects route through confirmEffect
    // unless invoked from a user-pinned item with an explicit host waiver.
    if (item.effect === 'destructive' && this.adapter.confirmEffect) {
      const isPinnedUserItem = item.provenance.kind === 'user' && this.pinned.has(id);
      if (!isPinnedUserItem) {
        const decision = await this.adapter.confirmEffect({
          itemId: id,
          actionName: item.action?.name ?? 'onInvoke',
          effect: item.effect,
          summary: this.label(item.labelKey),
          provenance: item.provenance,
        });
        if (decision === 'deny') return;
      }
    }

    this.events.emit({
      type: 'aibar.action.invoked',
      id,
      actionName: item.action?.name ?? 'onInvoke',
      provenance: item.provenance,
      contextRevision: ctx.revision,
    });

    const started = this.now();
    this.setState(id, 'loading');
    let outcome: ActionOutcome = { ok: true };
    try {
      const run = async (): Promise<void> => {
        if (item.onInvoke) {
          await item.onInvoke(ctx);
        } else if (item.action) {
          const params = { ...interpolateParams(ctx, item.action.params), ...extraParams };
          outcome = await this.adapter.dispatchAction({
            itemId: id,
            name: item.action.name,
            params,
            effect: item.effect,
            provenance: item.provenance,
            contextRevision: ctx.revision,
          });
        }
      };
      // Bound hang so a stuck host callback cannot leave the item unusable.
      await Promise.race([
        run(),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error('aibar invoke timed out')), 15_000);
        }),
      ]);
    } catch (e) {
      outcome = { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      this.recordFrecency(id);
      this.setState(id, outcome.ok ? 'default' : 'error');
    }
    if (!outcome.ok) {
      this.scheduleErrorRecovery(id);
    }
    this.events.emit({
      type: 'aibar.action.completed',
      id,
      outcome: outcome.ok ? 'ok' : 'error',
      durationMs: this.now() - started,
    });

    if (outcome.ok && dismissPopoverAfter) {
      this.closeSubSurface();
    }

    if (item.type === 'suggestion') this.removeItem(id, 'accepted');
  }

  /** Open the overflow floor (design §9.1) — host menus / Customize call this. */
  openOverflow(): void {
    this.openPopover(OVERFLOW_ID);
  }

  /** Ground vs popover/overflow presentation (orthogonal to SurfaceState). */
  presentation(): SurfacePresentation {
    return this.subStack.length > 0 ? 'subsurface' : 'ground';
  }

  private clearGroundCache(): void {
    this.cachedGroundPlan = null;
    this.cachedGroundStability = null;
    this.groundCacheContextRevision = null;
  }

  /** Freeze the ground LayoutPlan before the first showPopover (Appendix B). */
  private cacheGroundIfNeeded(): void {
    if (this.subStack.length > 0 || !this.plan) return;
    this.cachedGroundPlan = this.plan;
    this.cachedGroundStability = this.stability;
    this.groundCacheContextRevision = this.contextHub.current().revision;
  }

  /**
   * NSPopoverTouchBarItem.showPopover — replace the main bar with the item's
   * popover bar (`expand: 'surface'`, default). With `expand: 'inline'`, splice
   * children into the ground strip at the trigger’s place with a leading
   * showsCloseButton collapse key (no Escape Zone swap). Clears fnMode so the
   * Escape Zone ✕ matches the visible layer when surface.
   */
  openPopover(id: AIBarItemIdentifier): void {
    const item = this.findItem(id);
    if (id === OVERFLOW_ID) {
      const overflowed = this.plan?.overflowed ?? [];
      if (overflowed.length === 0) return;
      // Floor disclosure (design §9.1): overflowed items + palette drain (§8.4).
      const overflowAction = this.definition.overflowAction;
      const overflowedItems = overflowed.map((i) => ({ ...i, zone: 'contextual' as const }));
      const palette = overflowAction
        ? defineItem({
            id: OVERFLOW_PALETTE_ID,
            type: 'button',
            labelKey: 'aibar.overflowOpenPalette',
            icon: 'command',
            showsLabel: true,
            parity: overflowAction.name.startsWith('host.')
              ? `shortcut:${overflowAction.name}`
              : `none:overflow-action:${overflowAction.name}`,
            visibilityPriority: -1000,
            width: { min: 96, preferred: 160, max: 220 },
            action: overflowAction,
          })
        : null;
      const items = palette
        ? [...overflowedItems, { ...palette, zone: 'contextual' as const }]
        : overflowedItems;
      if (this.fnActive) this.setFnMode(false);
      this.inlineExpandedId = null;
      this.cacheGroundIfNeeded();
      this.subStack = [{ kind: 'overflow', triggerId: OVERFLOW_ID, items }];
      this.scheduleResolve();
      return;
    }
    if (!item || !item.children) return;

    if (item.expand === 'inline') {
      // Toggle: second tap on the same trigger collapses.
      if (this.inlineExpandedId === id) {
        this.inlineExpandedId = null;
        this.scheduleResolve();
        return;
      }
      if (this.fnActive) this.setFnMode(false);
      // Inline and surface expand are mutually exclusive.
      if (this.subStack.length > 0) {
        this.subStack = [];
        this.clearGroundCache();
      }
      this.inlineExpandedId = id;
      this.scheduleResolve();
      return;
    }

    // Popovers never nest: entering from a sub-surface replaces the top frame.
    const children = item.children.map((c) => ({ ...c, zone: 'contextual' as const }));
    const frame: SubSurface = { kind: 'popover', triggerId: id, items: children };
    if (this.fnActive) this.setFnMode(false);
    this.inlineExpandedId = null;
    this.cacheGroundIfNeeded();
    if (this.subStack.length > 0) {
      this.subStack[this.subStack.length - 1] = frame;
    } else {
      this.subStack.push(frame);
    }
    this.scheduleResolve();
  }

  /**
   * NSPopoverTouchBarItem.dismissPopover — restore the previously visible bar
   * (same effect as tapping the close button / Escape Zone ✕). Also collapses
   * an inline-expanded popover.
   */
  closeSubSurface(): void {
    if (this.inlineExpandedId) {
      this.inlineExpandedId = null;
      if (this.subStack.length === 0) {
        this.scheduleResolve();
        return;
      }
    }
    if (this.subStack.length === 0) return;
    this.subStack.pop();
    if (this.subStack.length > 0) {
      this.scheduleResolve();
      return;
    }
    // Back to ground: restore cached epoch when context is unchanged
    // (design §2.2 System Strip restore pattern + Apple dismissPopover).
    const ctx = this.contextHub.current();
    if (
      this.cachedGroundPlan &&
      this.groundCacheContextRevision === ctx.revision
    ) {
      this.plan = this.cachedGroundPlan;
      if (this.cachedGroundStability) this.stability = this.cachedGroundStability;
      this.clearGroundCache();
      this.epoch += 1;
      this.events.emit({
        type: 'aibar.surface.layout',
        epoch: this.epoch,
        shown: [
          ...this.plan.contextual,
          ...this.plan.system,
          ...this.plan.suggestions,
        ].map((p) => p.id),
        overflowed: this.plan.overflowed.map((i) => i.id),
      });
      this.scheduleFrame();
      return;
    }
    this.clearGroundCache();
    this.scheduleResolve();
  }

  /** True when `id` is a child of the currently expanded popover/overflow. */
  isActiveSubSurfaceChild(id: AIBarItemIdentifier): boolean {
    if (this.inlineExpandedId) {
      if (id === INLINE_COLLAPSE_ID) return true;
      const parent = this.registry.get(this.inlineExpandedId);
      if (parent?.children?.some((c) => c.id === id)) return true;
    }
    const sub = this.subStack[this.subStack.length - 1];
    return Boolean(sub?.items.some((i) => i.id === id));
  }

  /** Active popover/overflow trigger id, or null when at ground level. */
  activeSubSurfaceTrigger(): AIBarItemIdentifier | null {
    return (
      this.inlineExpandedId ??
      this.subStack[this.subStack.length - 1]?.triggerId ??
      null
    );
  }

  /**
   * Escape semantics (design §8.3 + visible Escape Zone meaning):
   * When a popover is showing, the Escape Zone renders ✕ — that meaning wins
   * (NSPopoverTouchBarItem.showsCloseButton / dismissPopover). Otherwise:
   * fnMode exit → approval Deny → customizing Done → host escape replacement.
   * From any depth, repeated Esc reaches ground.
   */
  escape(): void {
    if (this.inlineExpandedId || this.subStack.length > 0) {
      this.closeSubSurface();
      if (this.fnActive) this.setFnMode(false);
      return;
    }
    if (this.fnActive) {
      this.setFnMode(false);
      return;
    }
    const pendingApproval = this.currentApproval();
    if (pendingApproval) {
      void this.approve(pendingApproval.id, 'deny');
      return;
    }
    if (this.surfaceState === 'customizing') {
      this.exitCustomizing(true);
      return;
    }
    const replacement = this.definition.escapeKeyReplacementItemIdentifier;
    if (replacement) void this.invoke(replacement);
  }

  dismiss(id: AIBarItemIdentifier): void {
    const item = this.findItem(id);
    if (!item) return;
    if (item.type === 'suggestion') {
      this.events.emit({
        type: 'aibar.suggestion.dismissed',
        id,
        confidence: item.confidence ?? 0,
      });
    }
    this.removeItem(id, 'dismissed');
  }

  async approve(id: AIBarItemIdentifier, decision: 'allow' | 'deny'): Promise<void> {
    const item = this.findItem(id);
    if (!item || item.type !== 'approval') return;
    const requestedAt = this.approvalRequestedAt.get(id) ?? this.now();
    this.events.emit({
      type: 'aibar.approval.resolved',
      id,
      decision,
      latencyMs: this.now() - requestedAt,
    });
    this.approvalRequestedAt.delete(id);
    const ctx = this.contextHub.current();
    if (item.onApprove) {
      this.setState(id, 'loading');
      try {
        await item.onApprove(ctx, decision);
      } finally {
        this.setState(id, 'default');
      }
    } else if (item.action) {
      const params = { ...interpolateParams(ctx, item.action.params), decision };
      this.setState(id, 'loading');
      try {
        await this.adapter.dispatchAction({
          itemId: id,
          name: item.action.name,
          params,
          effect: item.effect,
          provenance: item.provenance,
          contextRevision: ctx.revision,
        });
      } finally {
        this.setState(id, 'default');
      }
    } else if (item.onInvoke && decision === 'allow') {
      await item.onInvoke(ctx);
    }
    this.removeItem(id, `approval:${decision}`);
  }

  private approvalRequestedAt = new Map<AIBarItemIdentifier, number>();

  noteApprovalRequested(id: AIBarItemIdentifier): void {
    this.approvalRequestedAt.set(id, this.now());
    const item = this.findItem(id);
    this.events.emit({
      type: 'aibar.approval.requested',
      id,
      effect: item?.effect ?? 'write',
    });
  }

  private currentApproval(): AIBarItem | null {
    const items = this.plan?.contextual ?? [];
    for (const placed of items) {
      if (placed.item.type === 'approval') return placed.item;
    }
    return null;
  }

  // ——— item logical state (fast path: state ops bypass the resolver) ———

  setState(id: AIBarItemIdentifier, state: ItemVisualState): void {
    const prev = this.states.get(id) ?? 'default';
    if (prev === state) return;
    if (state === 'default') this.states.delete(id);
    else this.states.set(id, state);
    this.pendingStateOps.push({ kind: 'state', id, state });
    this.scheduleFrame();
  }

  setStreaming(id: AIBarItemIdentifier, streaming: boolean): void {
    if (streaming) this.streaming.add(id);
    else this.streaming.delete(id);
    this.setState(id, streaming ? 'streaming' : 'default');
  }

  // ——— suggestion lane: background prediction (§6.2, NFR-8) ———

  /** Runtime suggestion-policy override (Settings: lane slots / mute). */
  setSuggestionPolicy(patch: Partial<SuggestionPolicy>): void {
    this.suggestionPolicy = { ...this.suggestionPolicy, ...patch };
    if (this.suggestionPolicy.maxVisible <= 0) {
      this.registry.removeWhere((_item, owner) => owner === INTENT_PUBLISHER);
    }
    this.scheduleResolve();
    this.schedulePredict();
  }

  private onContextChangedForIntent(): void {
    const ctx = this.contextHub.current();
    const contextKey = `${ctx.route ?? ''}|${ctx.mode ?? ''}`;
    if (contextKey !== this.lastIntentContextKey) {
      // §6.2: suggestions expire on context switch, whichever comes first.
      if (this.lastIntentContextKey) {
        this.registry.removeWhere((_item, owner) => owner === INTENT_PUBLISHER);
      }
      this.lastIntentContextKey = contextKey;
    }
    this.schedulePredict();
  }

  private schedulePredict(): void {
    if (!this.adapter.intent || this.destroyed) return;
    if (this.suggestionPolicy.maxVisible <= 0) return;
    // Deterministic-only postures never speculate; load-shedding (§11.3)
    // suspends speculation entirely.
    if (this.surfaceState === 'customizing' || this.fnActive) return;
    if (this.degradeLevel >= 1) return;
    if (this.intentTimer) clearTimeout(this.intentTimer);
    // §6.5 replacement rhythm: never swap the lane more than once per 5 s.
    const wait = Math.max(
      INTENT_DEBOUNCE_MS,
      SUGGESTION_REPLACE_INTERVAL_MS - (this.now() - this.lastSuggestionApplyAt),
    );
    this.intentTimer = setTimeout(() => {
      this.intentTimer = null;
      // Prediction is speculative — hand it to the environment's background
      // queue (scheduler.postTask) so it never contends with input (§11.2).
      const run = () => void this.runPredict();
      if (this.backend?.postTask) this.backend.postTask(run, 'background');
      else run();
    }, wait);
  }

  private async runPredict(): Promise<void> {
    if (!this.adapter.intent || this.destroyed || this.intentPredicting) return;
    const ctx = this.contextHub.current();
    const revision = ctx.revision;
    this.intentPredicting = true;
    let candidates: SuggestionCandidate[];
    try {
      // The strategy runs in the background and never blocks deterministic
      // resolve (NFR-8); a hung or throwing strategy skips the cycle (§12.6).
      candidates = await Promise.race([
        this.adapter.intent.predict({
          contextRevision: revision,
          route: ctx.route,
          mode: ctx.mode,
          recentActions: [...this.recentActionKeys],
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('intent strategy timeout')), INTENT_TIMEOUT_MS),
        ),
      ]);
    } catch {
      return;
    } finally {
      this.intentPredicting = false;
    }
    if (this.destroyed) return;
    // Stale-by-arrival: results for an older context revision are discarded.
    if (this.contextHub.current().revision !== revision) return;
    this.applyIntentCandidates(Array.isArray(candidates) ? candidates : []);
  }

  /**
   * Host / LLM strategies may push candidates outside the predict cycle
   * (M4 async fast-task). Same filters as the internal predict path.
   */
  injectSuggestions(candidates: SuggestionCandidate[]): void {
    this.applyIntentCandidates(candidates);
  }

  private applyIntentCandidates(candidates: SuggestionCandidate[]): void {
    const keep = new Set<AIBarItemIdentifier>();
    const items: AIBarItem[] = [];
    const deterministic = this.registry
      .all()
      .filter((i) => i.type !== 'suggestion' && i.action);

    for (const c of candidates) {
      if (!c || typeof c.confidence !== 'number' || !c.action || !c.reason) continue;
      if (c.confidence < this.suggestionPolicy.minConfidence) continue;
      const effect = c.effect ?? 'read';
      // Destructive predictions must arrive as approvals, never suggestions.
      if (!this.suggestionPolicy.allowEffects.includes(effect)) continue;
      let id: AIBarItemIdentifier;
      try {
        id = asItemIdentifier(c.id);
      } catch {
        continue;
      }
      const owner = this.registry.ownerOf(id);
      if (owner !== undefined && owner !== INTENT_PUBLISHER) continue;
      // Dedup against the deterministic lane (§6.1 ⑷): if the same action is
      // already reachable on the bar, the suggestion adds nothing.
      const duplicate = deterministic.some(
        (i) =>
          i.action!.name === c.action.name &&
          JSON.stringify(i.action!.params ?? {}) === JSON.stringify(c.action.params ?? {}),
      );
      if (duplicate) continue;

      keep.add(id);
      items.push(
        defineItem({
          id,
          type: 'suggestion',
          labelKey: c.labelKey,
          icon: c.icon,
          parity: 'none:agent-prediction',
          provenance: { kind: 'agent', publisherId: INTENT_PUBLISHER },
          effect,
          action: c.action,
          confidence: c.confidence,
          reason: c.reason,
          expiresAt: this.now() + SUGGESTION_TTL_MS,
        }),
      );
      if (items.length >= this.suggestionPolicy.maxVisible) break;
    }

    const removed = this.registry.removeWhere(
      (item, owner) => owner === INTENT_PUBLISHER && !keep.has(item.id),
    );
    for (const item of items) this.registry.upsert(item, INTENT_PUBLISHER);
    if (removed.length > 0 || items.length > 0) {
      this.lastSuggestionApplyAt = this.now();
    }
  }

  private scheduleErrorRecovery(id: AIBarItemIdentifier): void {
    const existing = this.errorTimers.get(id);
    if (existing) clearTimeout(existing);
    this.errorTimers.set(
      id,
      setTimeout(() => {
        this.errorTimers.delete(id);
        this.setState(id, 'default');
      }, ERROR_RECOVERY_MS),
    );
  }

  // ——— resolve → frame pipeline (§7.3) ———

  scheduleResolve(): void {
    if (this.resolveScheduled || this.destroyed) return;
    this.resolveScheduled = true;
    // §11.2: user-visible resolve rides scheduler.postTask when available.
    const run = () => {
      this.resolveScheduled = false;
      if (!this.destroyed) this.runResolve();
    };
    if (this.backend?.postTask) {
      this.backend.postTask(run, 'user-visible');
    } else {
      queueMicrotask(run);
    }
  }

  private runResolve(): void {
    if (!this.backend) return;
    const started = this.now();
    const rawCtx = this.contextHub.current();
    // §6.6: record which context slices this resolve actually reads, so the
    // next context wave can be skipped when it touches none of them.
    const reads = new Set<string>();
    const ctx = this.trackContext(rawCtx, reads);
    const sub = this.subStack[this.subStack.length - 1] ?? null;

    this.materializeDelegateItems(ctx);

    const registryItems = this.registry.all();
    // Collapse budget must use *visible* system items only — counting route-
    // hidden chrome (tasks/settings on chat) made a useless toggle that
    // reflowed the right-anchored strip (left/right jump under the cursor).
    // While a popover is open, omit its trigger (Touch Bar replaces that slot).
    // A system-zone popover (Creature Ranch) owns the whole bar: drop the
    // rest of the Control Strip so liveStatus ("思考中") cannot sit beside
    // the yard.
    const activeTrigger = this.inlineExpandedId ?? sub?.triggerId ?? null;
    const systemPopoverOwnsBar = Boolean(
      sub && registryItems.find((i) => i.id === sub.triggerId)?.zone === 'system',
    );
    const systemItems = this.systemStripItems(
      registryItems.filter((i) => {
        if (i.zone !== 'system') return false;
        if (activeTrigger && i.id === activeTrigger) return false;
        if (systemPopoverOwnsBar) return false;
        if (i.expiresAt !== undefined && i.expiresAt <= this.now()) return false;
        if (i.visible && !i.visible(ctx)) return false;
        return true;
      }),
    );
    let contextualItems: AIBarItem[];
    if (sub) {
      contextualItems = sub.items;
    } else if (this.fnActive && this.adapter.fnModeItems) {
      contextualItems = this.fnModeRuntimeItems();
    } else {
      contextualItems = registryItems.filter(
        (i) => i.zone !== 'system' && !this.hiddenIds.has(i.id),
      );
      contextualItems = this.expandProxies(contextualItems);
      contextualItems = this.collapseLiveCluster(contextualItems);
      contextualItems = this.expandInlinePopover(contextualItems);
    }
    const items = [...contextualItems, ...systemItems];

    // TTL sweep side effect: expired suggestion emit
    const now = this.now();
    for (const item of registryItems) {
      if (item.expiresAt !== undefined && item.expiresAt <= now) {
        if (item.type === 'suggestion') {
          this.events.emit({ type: 'aibar.suggestion.expired', id: item.id });
        }
        this.registry.remove(item.id);
      }
    }

    const requiredIds = new Set<AIBarItemIdentifier>(
      this.definition.customizationRequiredItemIdentifiers ?? [],
    );

    const metrics = DENSITY_METRICS[this.density];

    // Suggestions are suppressed inside sub-surfaces, while customizing, in
    // fnMode, and under load-shedding (§11.3 ladder rung 1) — the
    // deterministic lane always wins the budget.
    const suppressSuggestions =
      sub !== null ||
      this.surfaceState === 'customizing' ||
      this.fnActive ||
      this.degradeLevel >= 1;

    // Presentation-scoped Escape chrome (Appendix B + NSPopoverTouchBarItem):
    // ground → edgePad flush-left; subsurface → fixed Esc slot on that bar.
    const presentation = sub ? 'subsurface' : 'ground';
    const plan = resolve({
      ctx,
      items,
      baseOrder: this.effectiveBaseOrder(),
      requiredIds,
      pinnedIds: this.pinned,
      principalId: this.definition.principalItemIdentifier,
      surfaceWidth: this.backend.surfaceWidth(),
      density: this.density,
      leadingInset: presentation === 'subsurface' ? metrics.escapeZoneWidth : 0,
      measureText: (text) => this.backend!.measure([{ text, density: this.density }])[0]?.width ?? text.length * 8,
      resolveLabel: (key) => this.label(key),
      frecency: (id) => this.frecencyScore(id),
      stability: this.stability,
      now,
      suggestionPolicy: suppressSuggestions
        ? { ...this.suggestionPolicy, maxVisible: 0 }
        : this.suggestionPolicy,
    });

    if (!sub) {
      this.stability = plan.nextStability;
      // A fresh ground resolve invalidates any stale showPopover snapshot.
      this.clearGroundCache();
    }
    this.plan = plan;
    this.epoch += 1;

    // Surface-state transitions read runs/agent unconditionally — keep them
    // off the read-tracking so they don't defeat slice skipping.
    this.transitionSurfaceState(rawCtx);
    this.prepareAnnouncement(plan);

    this.events.emit({
      type: 'aibar.surface.layout',
      epoch: this.epoch,
      shown: [...plan.contextual, ...plan.system, ...plan.suggestions].map((p) => p.id),
      overflowed: plan.overflowed.map((i) => i.id),
    });

    for (const placed of plan.suggestions) {
      this.events.emit({
        type: 'aibar.suggestion.shown',
        id: placed.id,
        confidence: placed.item.confidence ?? 0,
      });
    }

    this.lastReadSlices = reads;
    this.lastResolveMs = this.now() - started;
    this.notePerfSample(this.lastResolveMs);

    this.scheduleFrame();
  }

  // ——— §6.6 slice-read tracking + §11.3 degradation ladder ———

  /**
   * Wrap a context snapshot so reads are recorded: `ctx.state.<slice>` records
   * the slice id; any other field (`route`, `runs`, …) records the
   * conservative `~top` marker (lifted fields can come from any provider).
   */
  private trackContext(ctx: AIBarContext, reads: Set<string>): AIBarContext {
    const state = new Proxy({} as Record<string, unknown>, {
      get: (_t, key) => {
        if (typeof key === 'string') reads.add(key);
        return ctx.state[key as string];
      },
      has: (_t, key) => {
        if (typeof key === 'string') reads.add(key);
        return key in ctx.state;
      },
      ownKeys: () => {
        reads.add('~top');
        return Reflect.ownKeys(ctx.state);
      },
      getOwnPropertyDescriptor: (_t, key) => ({
        enumerable: true,
        configurable: true,
        value: ctx.state[key as string],
      }),
    });
    return new Proxy({} as AIBarContext, {
      get: (_t, key) => {
        if (key === 'state') return state;
        if (typeof key === 'string' && key !== 'revision' && key !== 'timestamp') {
          reads.add('~top');
        }
        return ctx[key as keyof AIBarContext];
      },
      has: (_t, key) => key in ctx,
    });
  }

  private shouldSkipResolve(dirtySlices: ReadonlySet<string>): boolean {
    if (!this.lastReadSlices || this.lastReadSlices.has('~top')) return false;
    for (const slice of dirtySlices) {
      if (this.lastReadSlices.has(slice)) return false;
    }
    return true;
  }

  /**
   * §11.3 load-shedding: sustained resolve overruns walk the ladder —
   * level 1 pauses the suggestion lane + intent prediction; level 2 also asks
   * the renderer to drop non-essential motion. Recovery needs headroom
   * (half budget) so the ladder doesn't oscillate.
   */
  notePerfSample(ms: number): void {
    this.resolveDurations.push(ms);
    if (this.resolveDurations.length > PERF_WINDOW) this.resolveDurations.shift();
    if (this.resolveDurations.length < 3) return;
    const sorted = [...this.resolveDurations].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    let next: 0 | 1 | 2 =
      median > RESOLVE_BUDGET_MS * 3 ? 2 : median > RESOLVE_BUDGET_MS ? 1 : 0;
    if (next < this.degradeLevel && median > RESOLVE_BUDGET_MS / 2) {
      next = this.degradeLevel; // hysteresis: recover only with real headroom
    }
    if (next !== this.degradeLevel) {
      this.degradeLevel = next;
      this.events.emit({ type: 'aibar.perf.degraded', level: next });
    }
  }

  get perfDegradeLevel(): 0 | 1 | 2 {
    return this.degradeLevel;
  }

  /** Devtools snapshot: lanes with score breakdowns + perf counters. */
  debugSnapshot(): {
    epoch: number;
    surfaceState: SurfaceState;
    degradeLevel: number;
    lastResolveMs: number;
    context: AIBarContext;
    readSlices: string[];
    lanes: Record<'contextual' | 'system' | 'suggestions', {
      id: string;
      width: number;
      collapsed: boolean;
      score: PlacedItem['score'];
    }[]>;
    overflowed: string[];
  } {
    const lane = (items: readonly PlacedItem[] | undefined) =>
      (items ?? []).map((p) => ({
        id: p.id as string,
        width: Math.round(p.width),
        collapsed: p.collapsed,
        score: p.score,
      }));
    return {
      epoch: this.epoch,
      surfaceState: this.surfaceState,
      degradeLevel: this.degradeLevel,
      lastResolveMs: this.lastResolveMs,
      context: this.contextHub.current(),
      readSlices: [...(this.lastReadSlices ?? [])],
      lanes: {
        contextual: lane(this.plan?.contextual),
        system: lane(this.plan?.system),
        suggestions: lane(this.plan?.suggestions),
      },
      overflowed: (this.plan?.overflowed ?? []).map((i) => i.id as string),
    };
  }

  /**
   * Delegate lookup (§4.1, AppKit-identical order): for every declared default
   * identifier not yet in the registry, try `templateItems` then
   * `delegate.makeItem`; a miss emits `aibar.item.unresolved`. Results are
   * cached (one attempt per id) until `invalidateItem`.
   */
  private materializeDelegateItems(ctx: AIBarContext): void {
    if (this.templateItems.size === 0 && !this.delegate) return;
    for (const id of this.definition.defaultItemIdentifiers) {
      if (this.registry.get(id) || this.delegateAttempted.has(id)) continue;
      this.delegateAttempted.add(id);
      const template = this.templateItems.get(id);
      if (template) {
        this.registry.upsert(template, 'delegate');
        this.noteBaseOrder(id);
        continue;
      }
      let made: AIBarItem | null = null;
      try {
        made = this.delegate?.makeItem(id, ctx) ?? null;
      } catch {
        made = null; // a throwing delegate never breaks the surface (§12.6)
      }
      if (made) {
        this.registry.upsert(made, 'delegate');
        this.noteBaseOrder(id);
      } else {
        this.events.emit({ type: 'aibar.item.unresolved', id });
      }
    }
  }

  /** Force reconstruction of a delegate-built item (ItemRegistry.invalidate). */
  invalidateItem(id: AIBarItemIdentifier): void {
    this.delegateAttempted.delete(id);
    if (this.registry.ownerOf(id) === 'delegate') this.registry.remove(id);
    this.scheduleResolve();
  }

  /**
   * hostItemsProxy expansion (§4.4): inline the proxied surface's items at the
   * proxy's position. Depth ≤ 2; a cycle (A proxies B proxies A) truncates.
   * Packing runs on the flattened sequence — proxy boundaries are not layout
   * barriers.
   */
  private expandProxies(
    items: AIBarItem[],
    depth = 0,
    seen: Set<AIBarItemIdentifier> = new Set(),
  ): AIBarItem[] {
    if (!items.some((i) => i.type === 'hostItemsProxy')) return items;
    const out: AIBarItem[] = [];
    for (const item of items) {
      if (item.type !== 'hostItemsProxy') {
        out.push(item);
        continue;
      }
      if (depth >= PROXY_MAX_DEPTH || seen.has(item.id) || !item.proxyItems) continue;
      seen.add(item.id);
      let inner: AIBarItem[] = [];
      try {
        inner = item.proxyItems();
      } catch {
        inner = [];
      }
      for (const child of inner) this.noteBaseOrder(child.id);
      out.push(...this.expandProxies(inner, depth + 1, seen));
    }
    return out;
  }

  /**
   * Inline popover expand: replace the trigger with its children in-order so
   * neighbors stay put (composer reasoning / short choice sets). Prepends an
   * NSPopoverTouchBarItem.showsCloseButton-style collapse key so the strip
   * can fold without a whole-bar Escape swap. Invalidates itself if the
   * trigger disappeared or is no longer an inline popover.
   */
  private expandInlinePopover(items: AIBarItem[]): AIBarItem[] {
    const triggerId = this.inlineExpandedId;
    if (!triggerId) return items;
    const trigger = items.find((i) => i.id === triggerId);
    if (!trigger || trigger.type !== 'popover' || trigger.expand !== 'inline' || !trigger.children?.length) {
      this.inlineExpandedId = null;
      return items;
    }
    const collapse = defineItem({
      id: INLINE_COLLAPSE_ID,
      type: 'button',
      labelKey: 'aibar.collapse',
      icon: 'chevron-right',
      showsLabel: false,
      parity: 'key:Escape',
      visibilityPriority: 10_000,
      width: { min: 28, preferred: 28, max: 32 },
      onInvoke: () => {
        this.closeSubSurface();
      },
    });
    this.noteBaseOrder(collapse.id);
    const out: AIBarItem[] = [];
    for (const item of items) {
      if (item.id !== triggerId) {
        out.push(item);
        continue;
      }
      out.push(collapse);
      for (const child of trigger.children) {
        this.noteBaseOrder(child.id);
        out.push({ ...child, zone: 'contextual' });
      }
    }
    return out;
  }

  /**
   * Live Cluster morph (arch §2.3 / design §2.3):
   * - at most LIVE_CLUSTER_MAX liveStatus items render directly; the rest
   *   collapse into a count popover
   * - on significant run events the leading live item briefly expands
   *   (≤240 ms), rate-limited to once per 10 s per run
   */
  private collapseLiveCluster(items: AIBarItem[]): AIBarItem[] {
    this.maybeStartLiveMorph();
    const live = items.filter((i) => i.type === 'liveStatus');
    if (live.length <= LIVE_CLUSTER_MAX) return items;
    const ranked = [...live].sort((a, b) => b.visibilityPriority - a.visibilityPriority);
    const direct = new Set(ranked.slice(0, LIVE_CLUSTER_MAX).map((i) => i.id));
    const rest = live.filter((i) => !direct.has(i.id));
    const cluster = defineItem({
      id: LIVE_CLUSTER_ID,
      type: 'popover',
      labelKey: 'aibar.runningMany',
      icon: 'activity',
      showsLabel: true,
      text: () => this.label('aibar.runningMany', { count: rest.length }),
      parity: 'none:aibar-internal',
      visibilityPriority: ranked[LIVE_CLUSTER_MAX]?.visibilityPriority ?? 0,
      width: { min: 48, preferred: 64, max: 96 },
      children: rest.map((i) => ({ ...i, zone: 'contextual' as const })),
    });
    this.noteBaseOrder(cluster.id);
    let clusterPlacedAfterLast = false;
    const out: AIBarItem[] = [];
    for (const item of items) {
      if (item.type === 'liveStatus' && !direct.has(item.id)) {
        if (!clusterPlacedAfterLast) {
          out.push(cluster);
          clusterPlacedAfterLast = true;
        }
        continue;
      }
      out.push(item);
    }
    return out;
  }

  /** Detect significant run status transitions and pulse the live cluster. */
  private maybeStartLiveMorph(): void {
    const runs = this.contextHub.current().runs ?? [];
    const now = this.now();
    const nextStatuses = new Map<string, string>();
    let morphTarget: string | null = null;
    for (const run of runs) {
      // Include phase so thinking→tooling morphs without a status flip.
      const key = `${run.status}:${run.phase ?? ''}:${run.icon ?? ''}`;
      nextStatuses.set(run.runId, key);
      const prev = this.prevRunStatuses.get(run.runId);
      const significant =
        prev === undefined ||
        (prev !== key &&
          (run.status === 'running' ||
            run.status === 'failed' ||
            run.status === 'awaiting_input' ||
            run.status === 'succeeded'));
      if (!significant) continue;
      const last = this.lastLiveMorphByRun.get(run.runId) ?? 0;
      if (now - last < LIVE_MORPH_INTERVAL_MS) continue;
      morphTarget = run.runId;
      break;
    }
    this.prevRunStatuses = nextStatuses;
    if (!morphTarget) return;

    this.lastLiveMorphByRun.set(morphTarget, now);
    // Prefer the host liveStatus item; fall back to the count popover.
    const liveIds = this.registry
      .all()
      .filter((i) => i.type === 'liveStatus')
      .map((i) => i.id);
    const targetId = liveIds[0] ?? LIVE_CLUSTER_ID;
    this.morphingLiveIds.add(targetId);
    const existing = this.morphTimers.get(targetId);
    if (existing) clearTimeout(existing);
    this.morphTimers.set(
      targetId,
      setTimeout(() => {
        this.morphTimers.delete(targetId);
        this.morphingLiveIds.delete(targetId);
        this.scheduleResolve();
      }, LIVE_MORPH_MS),
    );
  }

  private transitionSurfaceState(ctx: AIBarContext): void {
    // Modal postures (§8.1) are only left through their own exits.
    if (this.surfaceState === 'customizing' || this.surfaceState === 'fnMode') return;
    const next: SurfaceState =
      (ctx.runs?.length ?? 0) > 0 ? 'live' : ctx.revision > 0 ? 'contextual' : 'idle';
    if (next !== this.surfaceState) {
      this.events.emit({
        type: 'aibar.surface.transition',
        from: this.surfaceState,
        to: next,
        trigger: next === 'live' ? 'runs' : 'context',
      });
      this.surfaceState = next;
    }
  }

  private setSurfaceState(next: SurfaceState, trigger: string): void {
    if (next === this.surfaceState) return;
    this.events.emit({
      type: 'aibar.surface.transition',
      from: this.surfaceState,
      to: next,
      trigger,
    });
    this.surfaceState = next;
  }

  private prepareAnnouncement(plan: ResolvedPlan): void {
    const now = this.now();
    if (now - this.lastAnnounceAt < ANNOUNCE_THROTTLE_MS) return;
    const prevIds = new Set(this.prevModels.keys());
    const entering = plan.contextual.filter((p) => !prevIds.has(p.id));
    if (entering.length === 0) return;
    const labels = entering.slice(0, 4).map((p) => this.label(p.item.labelKey));
    this.pendingAnnounce = labels.join(', ');
    this.lastAnnounceAt = now;
  }

  private scheduleFrame(): void {
    if (this.frameScheduled || !this.backend || this.destroyed) return;
    this.frameScheduled = true;
    this.backend.scheduleFrame(() => {
      this.frameScheduled = false;
      if (!this.destroyed) this.commitFrame();
    });
  }

  private commitFrame(): void {
    if (!this.backend || !this.plan) return;
    const plan = this.plan;
    const metrics = DENSITY_METRICS[this.density];
    const presentation = this.presentation();
    const presentationChanged = presentation !== this.lastPresentation;
    // Whole-surface switch (design §7.1): never interpolate geometry across
    // ground ↔ subsurface — only remove + create (crossfade in the renderer).
    const geometryPrev = presentationChanged
      ? new Map<AIBarItemIdentifier, { model: ItemRenderModel; box: Box; state: ItemVisualState }>()
      : this.prevModels;

    const placedAll: PlacedItem[] = [...plan.contextual, ...plan.system, ...plan.suggestions];

    // The always-present overflow trigger sits at the contextual trailing edge.
    const lastContextual = plan.contextual[plan.contextual.length - 1];
    const overflowX = lastContextual
      ? lastContextual.x + lastContextual.width + metrics.gapItem
      : metrics.edgePad;

    const ops: RenderOp[] = [];
    const nextModels = new Map<AIBarItemIdentifier, { model: ItemRenderModel; box: Box; state: ItemVisualState }>();
    const order: AIBarItemIdentifier[] = [];

    const emitItem = (id: AIBarItemIdentifier, model: ItemRenderModel, box: Box, state: ItemVisualState) => {
      order.push(id);
      nextModels.set(id, { model, box, state });
      const prev = geometryPrev.get(id);
      if (!prev) {
        ops.push({ kind: 'create', id, node: model, box });
        if (state !== 'default') ops.push({ kind: 'state', id, state });
        return;
      }
      if (JSON.stringify(prev.model) !== JSON.stringify(model)) {
        ops.push({ kind: 'update', id, patch: model, box });
      } else if (prev.box.x !== box.x || prev.box.width !== box.width) {
        ops.push({ kind: 'move', id, box });
      }
      if (prev.state !== state) ops.push({ kind: 'state', id, state });
    };

    // On a presentation swap, drop every previous node first so the renderer
    // never issues a cross-layer move (Apple replaces the bar, not neighbors).
    if (presentationChanged) {
      for (const [id] of this.prevModels) {
        ops.push({ kind: 'remove', id });
      }
    }

    for (const placed of placedAll) {
      const morphing = this.morphingLiveIds.has(placed.id);
      // Design §2.3: morph expands by one width step (≤240 ms), borrowing
      // from the flexible spacer — never shifts other contextual items.
      const width = morphing ? placed.width + 16 : placed.width;
      emitItem(
        placed.id,
        this.renderModel(placed),
        { x: placed.x, width },
        this.visualState(placed),
      );
    }

    // Overflow floor trigger — only when the packer actually spilled items.
    // TouchBar affordance: midline ellipsis ⋯ (not a mystery ·› popover).
    const overflowCount = plan.overflowed.length;
    const inOverflowSurface = this.subStack[this.subStack.length - 1]?.kind === 'overflow';
    if (overflowCount > 0 && !inOverflowSurface) {
      const overflowWidth = overflowCount > 9 ? 48 : 40;
      emitItem(
        OVERFLOW_ID,
        {
          type: 'popover',
          label: String(overflowCount),
          showsLabel: true,
          icon: { kind: 'text', text: '⋯' },
          tooltip: this.label('aibar.overflowCount', { count: overflowCount }),
          badge: 'none',
          principal: false,
          effect: 'read',
          provenance: { kind: 'host' },
          parity: 'none:overflow-is-aibar-internal',
          hasChildren: true,
          disclosure: 'overflow',
        },
        { x: overflowX, width: overflowWidth },
        'default',
      );
    }

    if (!presentationChanged) {
      for (const [id] of this.prevModels) {
        if (!nextModels.has(id)) ops.push({ kind: 'remove', id });
      }
    }

    ops.push(...this.pendingStateOps.filter((op) => op.kind === 'state' && nextModels.has(op.id)));
    this.pendingStateOps = [];

    const frame: RenderFrame = {
      epoch: this.epoch,
      surfaceBox: { width: plan.surfaceWidth, height: metrics.surfaceHeight },
      order,
      ops,
      escape: this.escapeSlot(),
      presentation,
      presentationChanged,
      announce: this.pendingAnnounce,
      degraded: this.degradeLevel,
    };
    this.pendingAnnounce = undefined;
    this.lastPresentation = presentation;
    this.prevModels = nextModels;
    this.backend.commit(frame);

    const customKinds = new Set<string>();
    for (const { model } of nextModels.values()) {
      if (model.type === 'custom' && model.customKind) customKinds.add(model.customKind);
    }
    if (customKinds.size > 0) {
      this.events.emit({
        type: 'aibar.custom-slot.mount',
        kinds: [...customKinds],
        epoch: this.epoch,
      });
    }
  }

  private escapeSlot(): RenderFrame['escape'] {
    if (this.subStack.length > 0) {
      return {
        id: ESCAPE_CLOSE_ID,
        node: {
          type: 'button',
          label: this.label('aibar.collapse'),
          showsLabel: false,
          // Collapse subsurface → ground (rightward chevron, not ✕).
          icon: this.adapter.resolveIcon('chevron-right'),
          tooltip: this.label('aibar.collapse'),
          badge: 'none',
          principal: false,
          effect: 'read',
          provenance: { kind: 'host' },
          parity: 'key:Escape',
        },
      };
    }
    const id = this.definition.escapeKeyReplacementItemIdentifier;
    if (!id) return null;
    const item = this.registry.get(id);
    if (!item) return null;
    return {
      id,
      node: this.renderModel({
        id,
        item,
        x: 0,
        width: DENSITY_METRICS[this.density].escapeZoneWidth,
        enabled: true,
        collapsed: false,
        score: { priority: 0, relevance: 0, frecency: 0, pin: 0, hysteresis: 0, dwell: false, total: 0 },
      }),
    };
  }

  /** Sliced scrubber snapshot (§7.6): data source → O(viewport) entries. */
  private scrubberModel(item: AIBarItem, ctx: AIBarContext): ItemRenderModel['scrubber'] {
    if (item.scrubber) {
      const count = item.scrubber.dataSource.count(ctx);
      const fullPaint = count <= SCRUBBER_FULL_PAINT_MAX;
      const start = fullPaint
        ? 0
        : Math.min(
            Math.max(0, this.scrubberWindows.get(item.id) ?? 0),
            Math.max(0, count - 1),
          );
      const end = fullPaint
        ? count
        : Math.min(count, start + SCRUBBER_WINDOW + SCRUBBER_OVERSCAN * 2);
      const entries: { key: string; label: string; icon?: string; imageUrl?: string }[] = [];
      for (let i = start; i < end; i++) {
        const entry = item.scrubber.dataSource.itemAt(i);
        entries.push({
          key: item.scrubber.dataSource.keyOf(entry, i),
          label: entry.label,
          icon: entry.icon,
          imageUrl: entry.imageUrl,
        });
      }
      const layout = item.scrubber.delegate.layout;
      const selectedIndex = this.scrubberSelected.get(item.id);
      return {
        count,
        slice: { start, entries },
        layout: layout.kind,
        itemWidth: layout.kind === 'fixed' ? layout.itemWidth : undefined,
        selectedIndex,
      };
    }
    // Compression-ladder scrubber: collapsed homogeneous group children.
    const children = item.children ?? [];
    return {
      count: children.length,
      slice: {
        start: 0,
        entries: children.map((c) => {
          const iconRef = typeof c.icon === 'function' ? c.icon(ctx) : c.icon;
          return {
            key: c.id,
            label: this.label(c.labelKey),
            icon: iconRef,
          };
        }),
      },
      layout: 'flow',
      selectedIndex: this.scrubberSelected.get(item.id),
    };
  }

  private renderModel(placed: PlacedItem): ItemRenderModel {
    const { item } = placed;
    const ctx = this.contextHub.current();
    const label =
      typeof item.text === 'function'
        ? item.text(ctx) ?? this.label(item.labelKey)
        : item.text ?? this.label(item.labelKey);
    const active = typeof item.active === 'function' ? item.active(ctx) : item.active;
    const selectedSegment =
      typeof item.selectedSegment === 'function' ? item.selectedSegment(ctx) : item.selectedSegment;
    const confidence = item.confidence ?? 0;
    const confidenceTier: 1 | 2 | 3 | undefined =
      item.type === 'suggestion' ? (confidence >= 0.75 ? 3 : confidence >= 0.55 ? 2 : 1) : undefined;
    const renderedType = placed.collapsed
      ? placed.collapsedTo === 'scrubber'
        ? 'scrubber'
        : 'popover'
      : item.type;
    const selectedColor =
      typeof item.selectedColor === 'function' ? item.selectedColor(ctx) : item.selectedColor;
    const iconRef = typeof item.icon === 'function' ? item.icon(ctx) : item.icon;
    const leadRun = item.type === 'liveStatus' ? (ctx.runs ?? [])[0] : undefined;
    const livePhase = leadRun?.phase;
    const liveTone =
      leadRun?.status === 'failed' || livePhase === 'error'
        ? 'critical'
        : leadRun?.status === 'awaiting_input' || livePhase === 'awaiting_input'
          ? 'warn'
          : leadRun
            ? 'ok'
            : undefined;
    const reasonText = item.reason
      ? this.label(`aibar.reason.${item.reason.code}`)
      : undefined;
    const approvalSegments =
      item.segments ??
      (item.type === 'approval'
        ? [
            { key: 'deny', labelKey: 'aibar.deny' },
            { key: 'allow', labelKey: 'aibar.allow' },
          ]
        : undefined);

    return {
      type: renderedType,
      label,
      showsLabel:
        // Explicit false wins — composer density prefers icon-only chrome.
        item.showsLabel === false
          ? false
          : item.showsLabel === true ||
            !iconRef ||
            ['label', 'liveStatus', 'suggestion', 'approval'].includes(item.type),
      // mainButton stays principal-styled without forcing a text label.
      icon: iconRef ? this.adapter.resolveIcon(iconRef) : undefined,
      tooltip: this.label(item.labelKey),
      badge: this.badgeOf(placed),
      principal: this.definition.principalItemIdentifier === item.id || item.type === 'mainButton',
      effect: item.effect,
      provenance: item.provenance,
      parity: item.parity,
      active,
      segments: approvalSegments?.map((s) => ({
        ...s,
        label: this.label(s.labelKey),
        iconResolved: s.icon ? this.adapter.resolveIcon(s.icon) : undefined,
      })),
      selectedSegment,
      progress: item.progress,
      livePhase,
      liveTone,
      confidenceTier,
      reasonText,
      dismissLabel:
        item.type === 'suggestion' ? this.label('aibar.dismiss', { label }) : undefined,
      ariaDescription:
        item.type === 'suggestion'
          ? reasonText
            ? this.label('aibar.suggestionAriaWithReason', { reason: reasonText })
            : this.label('aibar.suggestionAria')
          : undefined,
      intentSummary: item.intent
        ? this.label(item.intent.summaryKey)
        : undefined,
      hasChildren: (item.children?.length ?? 0) > 0 || placed.collapsed,
      pressAndHold: item.pressAndHold,
      morphing: this.morphingLiveIds.has(item.id),
      slider: item.type === 'slider' ? item.slider : undefined,
      swatches: item.type === 'colorPicker' ? item.swatches : undefined,
      selectedColor: item.type === 'colorPicker' ? selectedColor : undefined,
      candidates:
        item.type === 'candidateList'
          ? item.candidates
          : item.type === 'characterPicker'
            ? item.characters ?? DEFAULT_CHARACTERS
            : undefined,
      scrubber:
        renderedType === 'scrubber' ? this.scrubberModel(item, ctx) : undefined,
      customKind: item.type === 'custom' ? item.customKind : undefined,
    };
  }

  private badgeOf(placed: PlacedItem): ProvenanceBadge {
    const kind = placed.item.provenance?.kind;
    if (kind === 'agent') return 'agent';
    if (kind === 'remote') return 'remote';
    if (kind === 'user' || this.pinned.has(placed.id)) return 'user';
    return 'none';
  }

  private visualState(placed: PlacedItem): ItemVisualState {
    const logical = this.states.get(placed.id);
    if (logical && logical !== 'default') return logical;
    if (this.streaming.has(placed.id)) return 'streaming';
    if (!placed.enabled) return 'disabled';
    const ctx = this.contextHub.current();
    const active =
      typeof placed.item.active === 'function' ? placed.item.active(ctx) : placed.item.active;
    if (active) return 'active';
    return 'default';
  }

  private isCollapsed(id: AIBarItemIdentifier): boolean {
    return this.plan?.contextual.some((p) => p.id === id && p.collapsed) ?? false;
  }

  private findItem(id: AIBarItemIdentifier): AIBarItem | null {
    const sub = this.subStack[this.subStack.length - 1];
    if (sub) {
      const found = sub.items.find((i) => i.id === id);
      if (found) return found;
    }
    if (this.inlineExpandedId) {
      const parent = this.registry.get(this.inlineExpandedId);
      const child = parent?.children?.find((c) => c.id === id);
      if (child) return child;
    }
    const registered = this.registry.get(id);
    if (registered) return registered;
    // Synthesized / inlined items (live cluster, proxy expansion, family
    // merges) live only in the current plan — including their children
    // (ladder-scrubber select targets).
    for (const lane of [this.plan?.contextual, this.plan?.system, this.plan?.suggestions]) {
      for (const placed of lane ?? []) {
        if (placed.id === id) return placed.item;
        const child = placed.item.children?.find((c) => c.id === id);
        if (child) return child;
      }
    }
    return null;
  }

  // ——— customization mode (FR-5, §8.1, design §9.2) ———

  get state(): SurfaceState {
    return this.surfaceState;
  }

  /** Ids the user may hide/reorder (definition allowlist ∖ required). */
  isCustomizable(id: AIBarItemIdentifier): boolean {
    const required = this.definition.customizationRequiredItemIdentifiers ?? [];
    if (required.includes(id)) return false;
    const allowed = this.definition.customizationAllowedItemIdentifiers;
    return allowed ? allowed.includes(id) : true;
  }

  enterCustomizing(): void {
    if (this.surfaceState === 'customizing') return;
    if (this.fnActive) this.setFnMode(false);
    // Customizing freezes the ground bar — fold any open popover first.
    if (this.subStack.length > 0 || this.inlineExpandedId) {
      this.subStack = [];
      this.inlineExpandedId = null;
      this.clearGroundCache();
    }
    this.customizingSnapshot = {
      order: this.customOrder ? [...this.customOrder] : null,
      hidden: [...this.hiddenIds],
    };
    this.setSurfaceState('customizing', 'user');
    this.scheduleResolve();
  }

  /** Done: persist + announce. Cancel (`save = false`): restore the snapshot. */
  exitCustomizing(save = true): void {
    if (this.surfaceState !== 'customizing') return;
    if (!save && this.customizingSnapshot) {
      this.customOrder = this.customizingSnapshot.order;
      this.hiddenIds = new Set(this.customizingSnapshot.hidden);
    }
    this.customizingSnapshot = null;
    this.setSurfaceState('contextual', 'user');
    if (save) {
      void this.adapter.persistence.save(this.persistenceKey('custom'), {
        order: this.customOrder,
        hidden: [...this.hiddenIds],
      });
      this.events.emit({
        type: 'aibar.customization.changed',
        sequence: this.customSequence(),
      });
    }
    this.scheduleResolve();
  }

  /** Replace the user-defined ordering (host UI hands back the full sequence). */
  setCustomOrder(sequence: readonly AIBarItemIdentifier[] | null): void {
    this.customOrder = sequence ? [...sequence] : null;
    this.scheduleResolve();
  }

  setItemHidden(id: AIBarItemIdentifier, hidden: boolean): void {
    if (hidden && !this.isCustomizable(id)) return;
    if (hidden) this.hiddenIds.add(id);
    else this.hiddenIds.delete(id);
    this.scheduleResolve();
  }

  isItemHidden(id: AIBarItemIdentifier): boolean {
    return this.hiddenIds.has(id);
  }

  resetCustomization(): void {
    this.customOrder = null;
    this.hiddenIds.clear();
    this.scheduleResolve();
  }

  /** The effective contextual sequence after customization (for persistence/UI). */
  customSequence(): AIBarItemIdentifier[] {
    const order = this.effectiveBaseOrder();
    return this.registry
      .all()
      .filter((i) => i.zone !== 'system' && !this.hiddenIds.has(i.id))
      .sort(
        (a, b) =>
          (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
          (order.get(b.id) ?? Number.MAX_SAFE_INTEGER),
      )
      .map((i) => i.id);
  }

  /**
   * Item-library candidates (design §9.2): customizable ids that are currently
   * hidden, plus allowed identifiers that are not yet on the bar.
   */
  libraryCandidates(): AIBarItemIdentifier[] {
    const allowed = this.definition.customizationAllowedItemIdentifiers;
    const visible = new Set(this.customSequence());
    const out: AIBarItemIdentifier[] = [];
    const seen = new Set<AIBarItemIdentifier>();
    for (const item of this.registry.all()) {
      if (item.zone === 'system') continue;
      if (!this.isCustomizable(item.id)) continue;
      if (!this.hiddenIds.has(item.id) && visible.has(item.id)) continue;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item.id);
    }
    if (allowed) {
      for (const id of allowed) {
        if (seen.has(id) || visible.has(id) || !this.isCustomizable(id)) continue;
        seen.add(id);
        out.push(id);
      }
    }
    return out;
  }

  private effectiveBaseOrder(): ReadonlyMap<AIBarItemIdentifier, number> {
    if (!this.customOrder) return this.baseOrder;
    const map = new Map<AIBarItemIdentifier, number>();
    this.customOrder.forEach((id, i) => map.set(id, i));
    let next = this.customOrder.length;
    const rest = [...this.baseOrder.entries()]
      .filter(([id]) => !map.has(id))
      .sort((a, b) => a[1] - b[1]);
    for (const [id] of rest) map.set(id, next++);
    return map;
  }

  // ——— fnMode (§8.2): alternate item set while the fn modifier is held ———

  setFnMode(active: boolean): void {
    if (this.fnActive === active) return;
    // Popover owns the surface (and Escape Zone ✕) — do not latch an invisible
    // fnMode under an expanded NSPopoverTouchBarItem-equivalent.
    if (
      active &&
      (this.surfaceState === 'customizing' ||
        this.subStack.length > 0 ||
        this.inlineExpandedId !== null ||
        !this.adapter.fnModeItems)
    ) {
      return;
    }
    this.fnActive = active;
    this.setSurfaceState(active ? 'fnMode' : 'contextual', 'fn');
    this.scheduleResolve();
  }

  private fnModeRuntimeItems(): AIBarItem[] {
    const inputs = this.adapter.fnModeItems?.() ?? [];
    const items: AIBarItem[] = [];
    for (const input of inputs) {
      try {
        const item = defineItem(input);
        this.noteBaseOrder(item.id);
        items.push(item);
      } catch {
        // one bad declaration never breaks the alternate set
      }
    }
    return items;
  }

  // ——— System Strip collapse/expand (design §2.2) ———

  toggleSystemStrip(expand?: boolean): void {
    const next = expand ?? !this.systemExpanded;
    if (next === this.systemExpanded) return;
    this.systemExpanded = next;
    this.resetSystemIdle();
    this.scheduleResolve();
  }

  get isSystemStripExpanded(): boolean {
    return this.systemExpanded;
  }

  private resetSystemIdle(): void {
    if (this.systemIdleTimer) clearTimeout(this.systemIdleTimer);
    this.systemIdleTimer = null;
    if (this.systemExpanded) {
      this.systemIdleTimer = setTimeout(() => {
        this.systemIdleTimer = null;
        this.systemExpanded = false;
        this.scheduleResolve();
      }, SYSTEM_EXPAND_IDLE_MS);
    }
  }

  /**
   * Collapsed: top-3 by priority + trailing toggle; expanded: everything + ✕.
   * Toggle is always far-right (design §2.2 Control Strip) so expand/collapse
   * grows the strip leftward without moving the control under the cursor.
   */
  private systemStripItems(systemAll: AIBarItem[]): AIBarItem[] {
    if (systemAll.length <= SYSTEM_COLLAPSED_MAX) return systemAll;
    const toggle = defineItem({
      id: SYSTEM_TOGGLE_ID,
      type: 'button',
      labelKey: this.systemExpanded ? 'aibar.systemCollapse' : 'aibar.systemExpand',
      // Design §2.2: ◂ expand, ✕ collapse (stable trailing control).
      icon: this.systemExpanded ? 'x' : 'chevron-left',
      showsLabel: false,
      parity: 'none:aibar-internal',
      zone: 'system',
      visibilityPriority: 1000,
      width: { min: 24, preferred: 28, max: 28 },
      onInvoke: () => this.toggleSystemStrip(),
    });
    // Trailing sentinel — must sort after every host system item.
    this.baseOrder.set(SYSTEM_TOGGLE_ID, Number.MAX_SAFE_INTEGER - 1);
    if (this.systemExpanded) return [...systemAll, toggle];
    const kept = [...systemAll]
      .sort((a, b) => {
        if (b.visibilityPriority !== a.visibilityPriority) {
          return b.visibilityPriority - a.visibilityPriority;
        }
        return (
          (this.baseOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
          (this.baseOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER)
        );
      })
      .slice(0, SYSTEM_COLLAPSED_MAX);
    const keptIds = new Set(kept.map((i) => i.id));
    return [...systemAll.filter((i) => keptIds.has(i.id)), toggle];
  }

  // ——— frecency + pinning (local-only statistics, §12.4) ———

  private frecencyScore(id: AIBarItemIdentifier): number {
    const entry = this.frecency.get(id);
    if (!entry) return 0;
    const age = this.now() - entry.last;
    const decay = Math.pow(0.5, age / FRECENCY_HALF_LIFE_MS);
    return Math.min(1, (entry.count / 20) * decay);
  }

  private recordFrecency(id: AIBarItemIdentifier): void {
    const entry = this.frecency.get(id) ?? { count: 0, last: 0 };
    this.frecency.set(id, { count: entry.count + 1, last: this.now() });
    this.persistSoon();
  }

  pin(id: AIBarItemIdentifier): void {
    this.pinned.add(id);
    this.persistSoon();
    this.scheduleResolve();
  }

  isPinned(id: AIBarItemIdentifier): boolean {
    return this.pinned.has(id);
  }

  unpin(id: AIBarItemIdentifier): void {
    this.pinned.delete(id);
    this.persistSoon();
    this.scheduleResolve();
  }

  private label(key: string, opts?: Record<string, unknown>): string {
    return resolveChromeLabel(
      (k, o) => this.adapter.resolveLabel(k, o),
      key,
      opts,
    );
  }

  private persistenceKey(suffix: string): string {
    return `aibar.${this.definition.customizationIdentifier ?? 'default'}.${suffix}`;
  }

  private async loadPersisted(): Promise<void> {
    try {
      const raw = (await this.adapter.persistence.load(this.persistenceKey('stats'))) as {
        frecency?: Record<string, FrecencyEntry>;
        pinned?: string[];
      } | null;
      if (raw?.frecency) {
        for (const [id, entry] of Object.entries(raw.frecency)) {
          this.frecency.set(id as AIBarItemIdentifier, entry);
        }
      }
      if (raw?.pinned) {
        for (const id of raw.pinned) this.pinned.add(id as AIBarItemIdentifier);
      }
      const custom = (await this.adapter.persistence.load(this.persistenceKey('custom'))) as {
        order?: string[] | null;
        hidden?: string[];
      } | null;
      if (custom) {
        this.customOrder = custom.order
          ? custom.order.map((id) => id as AIBarItemIdentifier)
          : null;
        this.hiddenIds = new Set((custom.hidden ?? []).map((id) => id as AIBarItemIdentifier));
      }
      this.scheduleResolve();
    } catch {
      // persistence is best-effort
    }
  }

  private persistSoon(): void {
    if (this.frecencySaveScheduled) return;
    this.frecencySaveScheduled = true;
    setTimeout(() => {
      this.frecencySaveScheduled = false;
      void this.adapter.persistence.save(this.persistenceKey('stats'), {
        frecency: Object.fromEntries(this.frecency),
        pinned: [...this.pinned],
      });
    }, 1000);
  }

  // ——— hotkeys (INV-A1 parity bridge) ———

  private syncHotkeys(): void {
    if (!this.adapter.hotkeys) return;
    for (const item of this.registry.all()) {
      if (this.hotkeyDisposers.has(item.id)) continue;
      if (!item.parity.startsWith('shortcut:')) continue;
      this.hotkeyDisposers.set(
        item.id,
        this.adapter.hotkeys.register({
          itemId: item.id,
          parity: item.parity,
          onTrigger: () => void this.invoke(item.id),
        }),
      );
    }
    for (const [id, dispose] of this.hotkeyDisposers) {
      if (!this.registry.get(id)) {
        dispose();
        this.hotkeyDisposers.delete(id);
      }
    }
  }

  // ——— readback (surface-as-tool, §9.6: identifiers and states only) ———

  readSurface(): SurfaceReadback {
    const plan = this.plan;
    return {
      revision: this.contextHub.current().revision,
      visible: plan ? [...plan.contextual, ...plan.system].map((p) => p.id) : [],
      overflowed: plan ? plan.overflowed.map((i) => i.id) : [],
      suggestions: plan
        ? plan.suggestions.map((p) => ({
            id: p.id,
            confidence: p.item.confidence ?? 0,
            state: 'shown' as const,
          }))
        : [],
      pendingApprovals: plan
        ? plan.contextual.filter((p) => p.item.type === 'approval').map((p) => p.id)
        : [],
    };
  }

  onEvent(listener: (event: AIBarEvent) => void): () => void {
    return this.events.on(listener);
  }

  get surfaceHeight(): number {
    return DENSITY_METRICS[this.density].surfaceHeight;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.intentTimer) clearTimeout(this.intentTimer);
    if (this.systemIdleTimer) clearTimeout(this.systemIdleTimer);
    for (const t of this.errorTimers.values()) clearTimeout(t);
    for (const t of this.morphTimers.values()) clearTimeout(t);
    this.morphTimers.clear();
    this.morphingLiveIds.clear();
    for (const dispose of this.hotkeyDisposers.values()) dispose();
    for (const dispose of this.disposers) dispose();
    this.contextHub.destroy();
    this.backend?.destroy();
    this.backend = null;
  }
}

export { OVERFLOW_ID, ESCAPE_CLOSE_ID, INLINE_COLLAPSE_ID };
