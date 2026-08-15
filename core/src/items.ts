/**
 * Runtime item model + ItemRegistry (docs/aibar-architecture.md §3–§4).
 *
 * In-process items (trust tier 1) may use real function predicates; wire
 * items arrive as declarative Item Specs and are adapted here. The registry
 * enforces global identifier uniqueness (INV-A6) and supports lazy
 * construction via delegate lookup (§4.1).
 */
import {
  asItemIdentifier,
  type AIBarItemIdentifier,
  type AIBarItemSpec,
  type AIBarItemType,
  type ActionRef,
  type EffectClass,
  type ItemScope,
  type Provenance,
  type SegmentSpec,
  type SliderSpec,
  type WidthSpec,
} from '@aibar/protocol';
import type { AIBarContext } from './context';
import { evaluatePredicate } from './predicate-eval';

export type AIBarZone = 'contextual' | 'system';

// ——— scrubber data source / delegate (arch §4.3; NSScrubber contract) ———

export interface ScrubberEntry {
  label: string;
  icon?: string;
  /** Optional thumbnail URL for image scrubbers (Touch Bar photo strip). */
  imageUrl?: string;
  data?: unknown;
}

/** Array-style children are rejected for scrubbers; access must be O(1). */
export interface ScrubberDataSource {
  count(ctx: AIBarContext): number;
  itemAt(index: number): ScrubberEntry;
  /** Stable key for node recycling. */
  keyOf(entry: ScrubberEntry, index: number): string;
}

export interface ScrubberDelegate {
  onSelect(index: number, entry: ScrubberEntry): void;
  onHighlight?(index: number): void;
  /** Right-click / long-press preview (e.g. session image strip). */
  onPreview?(index: number, entry: ScrubberEntry): void;
  selectionMode: 'leading' | 'center' | 'none';
  layout: { kind: 'flow' } | { kind: 'fixed'; itemWidth: number };
}

/** The kernel-internal item: spec payload + resolved function predicates. */
export interface AIBarItem {
  id: AIBarItemIdentifier;
  type: AIBarItemType;

  labelKey: string;
  /** Static Lucide/host ref, or in-process resolver (wire specs stay string-only). */
  icon?: string | ((ctx: AIBarContext) => string | undefined);
  showsLabel?: boolean;

  visibilityPriority: number;
  customizationLabel?: string;
  width?: Partial<WidthSpec>;

  provenance: Provenance;
  effect: EffectClass;
  parity: string;

  /** System Strip is in-process host contributions only (§12.1). */
  zone: AIBarZone;

  visible?: (ctx: AIBarContext) => boolean;
  enabled?: (ctx: AIBarContext) => boolean;
  relevance?: (ctx: AIBarContext) => number;

  action?: ActionRef;
  /** In-process alternative to a named action. */
  onInvoke?: (ctx: AIBarContext) => void | Promise<void>;
  /** In-process segmented-control selection handler. */
  onSelectSegment?: (ctx: AIBarContext, segmentKey: string) => void;
  /** In-process approval resolution handler (both decisions, unlike onInvoke). */
  onApprove?: (ctx: AIBarContext, decision: 'allow' | 'deny') => void | Promise<void>;

  scope?: ItemScope;
  expiresAt?: number;

  // type-specific
  active?: boolean | ((ctx: AIBarContext) => boolean);
  segments?: SegmentSpec[];
  selectedSegment?: string | ((ctx: AIBarContext) => string | undefined);
  children?: AIBarItem[];
  pressAndHold?: boolean;
  /** popover: `inline` expands children in the ground strip (no Escape swap). */
  expand?: 'surface' | 'inline';
  progress?: number;
  confidence?: number;
  reason?: { code: string; args?: Record<string, unknown> };
  intent?: { summaryKey: string; params?: Record<string, unknown> };

  /** slider payload + in-process change handler */
  slider?: SliderSpec;
  onSliderChange?: (ctx: AIBarContext, value: number) => void;

  /** scrubber: data-source/delegate model (§4.3; in-process only) */
  scrubber?: { dataSource: ScrubberDataSource; delegate: ScrubberDelegate };

  /** colorPicker */
  swatches?: string[];
  selectedColor?: string | ((ctx: AIBarContext) => string | undefined);
  onSelectColor?: (ctx: AIBarContext, color: string) => void;

  /** candidateList / characterPicker */
  candidates?: string[];
  characters?: string[];
  onSelectCandidate?: (ctx: AIBarContext, value: string) => void;

  /** hostItemsProxy: inlines another surface's items (§4.4; in-process only) */
  proxyItems?: () => AIBarItem[];

  /** custom: host-registered renderer key; still obeys the geometry contract */
  customKind?: string;

  /** Same-family merge hint for the compression ladder (§6.4). */
  family?: string;

  /** Dynamic display text override (labels, liveStatus). */
  text?: string | ((ctx: AIBarContext) => string | undefined);
}

/** In-process declaration form: predicates may be functions or omitted. */
export type AIBarItemInput =
  Omit<Partial<AIBarItem>, 'id' | 'type' | 'labelKey' | 'parity'> &
  Pick<AIBarItem, 'id' | 'type' | 'labelKey' | 'parity'>;

export class DuplicateIdentifierError extends Error {
  constructor(id: string) {
    super(`AIBar item identifier already registered: ${id}`);
    this.name = 'DuplicateIdentifierError';
  }
}

/** Normalize an in-process declaration into a runtime item. */
export function defineItem(input: AIBarItemInput): AIBarItem {
  return {
    visibilityPriority: 0,
    provenance: { kind: 'host' },
    effect: 'read',
    zone: 'contextual',
    ...input,
  };
}

/** Adapt a validated declarative Item Spec (wire) into a runtime item. */
export function itemFromSpec(
  spec: AIBarItemSpec,
  provenance: Provenance,
  now: () => number = () => Date.now(),
): AIBarItem {
  const visible = spec.visible;
  const enabled = spec.enabled;
  return {
    id: asItemIdentifier(spec.id),
    type: spec.type,
    labelKey: spec.labelKey,
    icon: spec.icon,
    showsLabel: spec.showsLabel,
    visibilityPriority: spec.visibilityPriority ?? 0,
    customizationLabel: spec.customizationLabel,
    width: spec.width,
    provenance,
    effect: spec.effect ?? 'read',
    parity: spec.parity,
    // Wire publishers can never contribute to the System Strip (§12.1).
    zone: 'contextual',
    visible: visible ? (ctx) => evaluatePredicate(ctx, visible) : undefined,
    enabled: enabled ? (ctx) => evaluatePredicate(ctx, enabled) : undefined,
    action: spec.action,
    scope: spec.scope,
    expiresAt: spec.ttlMs ? now() + spec.ttlMs : undefined,
    active: spec.active,
    segments: spec.segments,
    selectedSegment: spec.selectedSegment,
    children: spec.children?.map((c) => itemFromSpec(c, provenance, now)),
    pressAndHold: spec.pressAndHold,
    expand: spec.expand,
    progress: spec.progress,
    confidence: spec.confidence,
    reason: spec.reason,
    intent: spec.intent,
    slider: spec.slider,
    swatches: spec.swatches,
    selectedColor: spec.selectedColor,
    candidates: spec.candidates,
    characters: spec.characters,
  };
}

export interface ItemProvider {
  id: string;
  items(): AIBarItemInput[];
  dispose?(): void;
}

export interface AIBarDelegate {
  /** Returning null means "not constructible right now" (AppKit nil semantics). */
  makeItem(id: AIBarItemIdentifier, ctx: AIBarContext): AIBarItem | null;
}

export class ItemRegistry {
  private items = new Map<AIBarItemIdentifier, AIBarItem>();
  private owners = new Map<AIBarItemIdentifier, string>();
  private listeners = new Set<() => void>();

  register(item: AIBarItem, owner = 'host'): () => void {
    if (this.items.has(item.id)) throw new DuplicateIdentifierError(item.id);
    this.items.set(item.id, item);
    this.owners.set(item.id, owner);
    this.notify();
    return () => this.remove(item.id);
  }

  /** Idempotent upsert used by the wire ingress (publish realigns by id). */
  upsert(item: AIBarItem, owner: string): void {
    const existingOwner = this.owners.get(item.id);
    if (existingOwner !== undefined && existingOwner !== owner) {
      throw new DuplicateIdentifierError(item.id);
    }
    this.items.set(item.id, item);
    this.owners.set(item.id, owner);
    this.notify();
  }

  registerProvider(provider: ItemProvider): () => void {
    const disposers = provider.items().map((input) => this.register(defineItem(input), provider.id));
    return () => {
      for (const dispose of disposers) dispose();
      provider.dispose?.();
    };
  }

  get(id: AIBarItemIdentifier): AIBarItem | undefined {
    return this.items.get(id);
  }

  ownerOf(id: AIBarItemIdentifier): string | undefined {
    return this.owners.get(id);
  }

  remove(id: AIBarItemIdentifier): boolean {
    const removed = this.items.delete(id);
    this.owners.delete(id);
    if (removed) this.notify();
    return removed;
  }

  removeWhere(fn: (item: AIBarItem, owner: string) => boolean): AIBarItemIdentifier[] {
    const removed: AIBarItemIdentifier[] = [];
    for (const [id, item] of this.items) {
      if (fn(item, this.owners.get(id) ?? '')) {
        this.items.delete(id);
        this.owners.delete(id);
        removed.push(id);
      }
    }
    if (removed.length > 0) this.notify();
    return removed;
  }

  all(): AIBarItem[] {
    return [...this.items.values()];
  }

  countByOwner(owner: string): number {
    let n = 0;
    for (const o of this.owners.values()) if (o === owner) n++;
    return n;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of [...this.listeners]) l();
  }
}

/** Design-doc §3.2 width defaults (regular density, logical px). */
export const DEFAULT_WIDTHS: Record<AIBarItemType, WidthSpec> = {
  button: { min: 36, preferred: 44, max: 128 },
  mainButton: { min: 96, preferred: 144, max: 176 },
  toggle: { min: 36, preferred: 44, max: 128 },
  segmented: { min: 88, preferred: 112, max: 216 },
  label: { min: 24, preferred: 64, max: 200 },
  group: { min: 36, preferred: 96, max: 400 },
  popover: { min: 36, preferred: 44, max: 44 },
  slider: { min: 96, preferred: 160, max: 280, flex: 1 },
  scrubber: { min: 120, preferred: 240, max: Number.POSITIVE_INFINITY, flex: 2 },
  colorPicker: { min: 88, preferred: 148, max: 320 },
  candidateList: { min: 120, preferred: 240, max: 360, flex: 1 },
  characterPicker: { min: 120, preferred: 200, max: 360, flex: 1 },
  spacerSmall: { min: 8, preferred: 8, max: 8 },
  spacerLarge: { min: 24, preferred: 24, max: 24 },
  spacerFlexible: { min: 0, preferred: 0, max: Number.POSITIVE_INFINITY, flex: 1 },
  hostItemsProxy: { min: 0, preferred: 0, max: 0 },
  custom: { min: 36, preferred: 96, max: 320 },
  liveStatus: { min: 56, preferred: 108, max: 140 },
  suggestion: { min: 88, preferred: 132, max: 160 },
  approval: { min: 140, preferred: 180, max: 220 },
};

export function widthOf(item: AIBarItem): WidthSpec {
  const base = DEFAULT_WIDTHS[item.type];
  return {
    min: item.width?.min ?? base.min,
    preferred: item.width?.preferred ?? base.preferred,
    max: item.width?.max ?? base.max,
    flex: item.width?.flex ?? base.flex ?? 0,
  };
}
