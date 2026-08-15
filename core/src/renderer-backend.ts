/**
 * RendererBackend contract (docs/aibar-architecture.md §7).
 *
 * The kernel computes geometry; renderers apply it blindly. `measure` is the
 * only moment a renderer may read its environment; `commit` must satisfy the
 * zero-reflow rules (§7.4). Frame scheduling is renderer-owned (`scheduleFrame`)
 * so the kernel stays environment-free (INV-A4).
 */
import type { AIBarItemIdentifier, EffectClass, Provenance, SegmentSpec } from '@aibar/protocol';
import type { IconRenderable } from './host-adapter';

export interface Box {
  x: number;
  width: number;
}

export interface MeasureRequest {
  text: string;
  /** density token: 'compact' | 'regular' */
  density: string;
}

export interface MeasureResult {
  width: number;
}

export type ItemVisualState =
  | 'default'
  | 'active'
  | 'disabled'
  | 'loading'
  | 'streaming'
  | 'error';

export type ProvenanceBadge = 'none' | 'user' | 'agent' | 'remote';

/** Pure-data render model — publishers never touch this layer (INV-A3). */
export interface ItemRenderModel {
  type: string;
  /** Resolved, localized display label. */
  label: string;
  /** Whether the label text is shown (icon-first rule). */
  showsLabel: boolean;
  icon?: IconRenderable;
  tooltip: string;
  badge: ProvenanceBadge;
  principal: boolean;
  effect: EffectClass;
  provenance: Provenance;
  parity: string;

  // type-specific
  active?: boolean;
  segments?: (SegmentSpec & { label: string; iconResolved?: IconRenderable })[];
  selectedSegment?: string;
  progress?: number;
  confidenceTier?: 1 | 2 | 3;
  reasonText?: string;
  intentSummary?: string;
  /** liveStatus phase chrome (host-derived). */
  livePhase?: string;
  liveTone?: 'ok' | 'warn' | 'critical';
  hasChildren?: boolean;
  /** Overflow floor trigger (TouchBar ellipsis) — no popover chevron. */
  disclosure?: 'overflow';
  /** popover: hold-to-enter, release-to-select (design §5.8). */
  pressAndHold?: boolean;
  /** Live Cluster morph pulse (design §2.3, ≤240 ms). */
  morphing?: boolean;

  /** slider */
  slider?: { min: number; max: number; value: number; step?: number };
  /** colorPicker: swatch colors + current selection */
  swatches?: string[];
  selectedColor?: string;
  /** candidateList / characterPicker entries (small, host-bounded sets) */
  candidates?: string[];
  /**
   * scrubber: sliced data snapshot (virtualization §7.6). The renderer shows
   * `slice.entries` at logical offset `slice.start` out of `count` total, and
   * asks for a different slice via `SurfaceInputSink.scrubTo`.
   */
  scrubber?: {
    count: number;
    slice: {
      start: number;
      entries: { key: string; label: string; icon?: string; imageUrl?: string }[];
    };
    selectedIndex?: number;
    layout: 'flow' | 'fixed';
    itemWidth?: number;
  };
  /** custom: host renderer key (renderer exposes a slot; host fills it) */
  customKind?: string;
  /** suggestion dismiss control (localized by the kernel). */
  dismissLabel?: string;
  /** Accessible description (localized by the kernel). */
  ariaDescription?: string;
}

export type StreamDelta = Partial<Pick<ItemRenderModel, 'label' | 'progress' | 'reasonText'>> & {
  confidenceTier?: 1 | 2 | 3;
};

export type RenderOp =
  | { kind: 'create'; id: AIBarItemIdentifier; node: ItemRenderModel; box: Box }
  | { kind: 'update'; id: AIBarItemIdentifier; patch: Partial<ItemRenderModel>; box?: Box }
  | { kind: 'move'; id: AIBarItemIdentifier; box: Box }
  | { kind: 'state'; id: AIBarItemIdentifier; state: ItemVisualState }
  | { kind: 'stream'; id: AIBarItemIdentifier; delta: StreamDelta }
  | { kind: 'remove'; id: AIBarItemIdentifier };

/** Orthogonal to SurfaceState: which bar is presented (NSPopoverTouchBarItem). */
export type SurfacePresentation = 'ground' | 'subsurface';

export interface RenderFrame {
  /** LayoutPlan revision. */
  epoch: number;
  surfaceBox: { width: number; height: number };
  /** Display-ordered item ids (roving-tabindex traversal order). */
  order: AIBarItemIdentifier[];
  ops: readonly RenderOp[];
  /** Escape-zone slot content (null = empty host default). */
  escape: { id: AIBarItemIdentifier; node: ItemRenderModel } | null;
  /**
   * Ground vs popover/overflow bar (design §7.1 whole-surface switch).
   * Defaults to `ground` for older test frames that omit the field.
   */
  presentation?: SurfacePresentation;
  /** True when this frame crosses ground ↔ subsurface (no move interpolation). */
  presentationChanged?: boolean;
  /** Polite live-region announcement for this frame, if any (design §11.1). */
  announce?: string;
  /** §11.3 ladder level; ≥2 renderers drop non-essential motion. */
  degraded?: 0 | 1 | 2;
}

/** Callbacks the renderer uses to feed input back into the kernel. */
export interface SurfaceInputSink {
  invoke(id: AIBarItemIdentifier): void;
  selectSegment(id: AIBarItemIdentifier, segmentKey: string): void;
  openPopover(id: AIBarItemIdentifier): void;
  escape(): void;
  dismiss(id: AIBarItemIdentifier): void;
  approve(id: AIBarItemIdentifier, decision: 'allow' | 'deny'): void;
  /** Right-click / long-press: the host renders the menu (design §9.2). */
  contextMenu?(id: AIBarItemIdentifier, x: number, y: number): void;
  /** slider value commit. */
  changeValue?(id: AIBarItemIdentifier, value: number): void;
  /** scrubber: select the entry at a logical index. */
  selectIndex?(id: AIBarItemIdentifier, index: number): void;
  /** scrubber: preview the entry (right-click / long-press). */
  previewIndex?(id: AIBarItemIdentifier, index: number): void;
  /** scrubber virtualization: request a different data window (§7.6). */
  scrubTo?(id: AIBarItemIdentifier, startIndex: number): void;
}

export interface RendererBackend {
  mount(container: unknown, sink: SurfaceInputSink): void;

  /**
   * Text measurement. Batched and cacheable; called by the kernel BEFORE the
   * geometry pass — the only moment a renderer may read its environment.
   */
  measure(requests: readonly MeasureRequest[]): readonly MeasureResult[];

  /** At most once per animation frame; zero DOM reads inside (§7.4 D1). */
  commit(frame: RenderFrame): void;

  /** Environment-owned rAF-equivalent scheduling (latest-frame-wins upstream). */
  scheduleFrame(cb: () => void): void;

  /**
   * Environment-owned background scheduling (`scheduler.postTask` where
   * available). The kernel routes speculative work (intent prediction)
   * through this so it never competes with input handling (§11.2).
   */
  postTask?(cb: () => void, priority: 'user-visible' | 'background'): void;

  /** Current inner width available to the surface, in logical px. */
  surfaceWidth(): number;

  /** Subscribe to surface resize; returns unsubscribe. */
  onResize(cb: () => void): () => void;

  applyThemeTokens(tokens: Readonly<Record<string, string>>): void;

  destroy(): void;
}
