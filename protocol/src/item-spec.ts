/**
 * Item Spec v2 — the declarative, data-only item protocol
 * (docs/aibar-architecture.md §3.2–§3.4, §9.1).
 *
 * Publishers submit data, never code (INV-A3). These types are shared by the
 * kernel (which also accepts richer in-process items with function predicates)
 * and every wire publisher.
 */
import type { AIBarItemIdentifier } from './identifiers';
import type { Predicate } from './predicate';

export const PROTOCOL_VERSION = 'aibar/2';

/** Mirrors NSTouchBarItem.Priority: numeric with three presets. */
export const VisibilityPriority = { LOW: -1000, NORMAL: 0, HIGH: 1000 } as const;

/** The only sizing language the layout engine understands. */
export interface WidthSpec {
  /** px; below this, prefer not showing at all */
  min: number;
  /** px; target when space allows */
  preferred: number;
  /** px; stretch ceiling (Infinity = flexible) */
  max?: number;
  /** stretch weight, default 0 */
  flex?: number;
}

/** Who put this item here — rendered as a visible badge tier (INV-A7). */
export type Provenance =
  | { kind: 'host' }
  | { kind: 'user' }
  | { kind: 'agent'; publisherId: string; runId?: string }
  | { kind: 'remote'; publisherId: string };

/** Side-effect class; drives the human-gate policy (INV-A8). */
export type EffectClass = 'read' | 'write' | 'destructive';

/**
 * Item catalog (arch §3.3) — the full 20-type set. `scrubber`,
 * `hostItemsProxy` and `custom` are in-process-only (their payloads are code:
 * data sources, item factories, host renderers — INV-A3 keeps them off the
 * wire); everything else is publishable as a declarative Item Spec.
 */
export type AIBarItemType =
  | 'button'
  | 'mainButton'
  | 'toggle'
  | 'segmented'
  | 'label'
  | 'group'
  | 'popover'
  | 'slider'
  | 'scrubber'
  | 'colorPicker'
  | 'candidateList'
  | 'characterPicker'
  | 'spacerSmall'
  | 'spacerLarge'
  | 'spacerFlexible'
  | 'hostItemsProxy'
  | 'custom'
  | 'liveStatus'
  | 'suggestion'
  | 'approval';

export const AIBAR_ITEM_TYPES: readonly AIBarItemType[] = [
  'button', 'mainButton', 'toggle', 'segmented', 'label', 'group', 'popover',
  'slider', 'scrubber', 'colorPicker', 'candidateList', 'characterPicker',
  'spacerSmall', 'spacerLarge', 'spacerFlexible', 'hostItemsProxy', 'custom',
  'liveStatus', 'suggestion', 'approval',
];

/** Types whose payloads are code, not data — never accepted from the wire (INV-A3). */
export const IN_PROCESS_ONLY_TYPES: readonly AIBarItemType[] = [
  'scrubber', 'hostItemsProxy', 'custom',
];

/** slider payload (NSSliderTouchBarItem equivalent). */
export interface SliderSpec {
  min: number;
  max: number;
  value: number;
  step?: number;
}

/** Named action + static params; semantics defined by the host allowlist (§12.3). */
export interface ActionRef {
  name: string;
  /** `$ctx.*` string values are interpolated at invoke time inside the kernel. */
  params?: Record<string, unknown>;
}

export type ItemScope =
  | { kind: 'global' }
  | { kind: 'route'; pattern: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'run'; runId: string };

export interface SegmentSpec {
  key: string;
  labelKey: string;
  /** Host icon name (optional). */
  icon?: string;
  /**
   * Painted emblem for icon-only tabs (e.g. iOS emoji category glyphs).
   * When set, the renderer shows `glyph` instead of the localized label text;
   * `labelKey` remains the accessible name.
   */
  glyph?: string;
}

/**
 * The declarative Item Spec (wire form). In-process host items extend this
 * with function predicates in @aibar/core.
 */
export interface AIBarItemSpec {
  version?: typeof PROTOCOL_VERSION;
  id: string;
  type: AIBarItemType;

  /** i18n key; REQUIRED even when not displayed (tooltip + accessibility). */
  labelKey: string;
  /** Named icon reference; the host `resolveIcon` maps it to svg or text. */
  icon?: string;
  /** Icon-first rule: with both icon and text, only the icon shows unless true. */
  showsLabel?: boolean;

  visibilityPriority?: number;
  customizationLabel?: string;
  width?: Partial<WidthSpec>;

  effect?: EffectClass;
  /** INV-A1: the non-AIBar path to this action (hotkey id / menu path / 'none:<reason>'). */
  parity: string;

  visible?: Predicate;
  enabled?: Predicate;

  action?: ActionRef;

  scope?: ItemScope;
  ttlMs?: number;

  // ——— type-specific payloads ———
  /** toggle: current pressed state */
  active?: boolean;
  /** segmented */
  segments?: SegmentSpec[];
  selectedSegment?: string;
  /** group / popover sub-surface children */
  children?: AIBarItemSpec[];
  /** popover: hold-to-enter, release-to-select mode */
  pressAndHold?: boolean;
  /**
   * popover expand style:
   * - `surface` (default): NSPopoverTouchBarItem whole-bar swap + Escape chrome
   * - `inline`: splice children into the ground strip at the trigger’s place,
   *   with a leading showsCloseButton collapse key (no Escape Zone swap)
   */
  expand?: 'surface' | 'inline';
  /** liveStatus: 0..1 (omit for indeterminate pulse) */
  progress?: number;
  /** suggestion: prediction confidence 0..1 (gates rendering) */
  confidence?: number;
  /** suggestion: machine-readable explainability */
  reason?: { code: string; args?: Record<string, unknown> };
  /** approval: labeled intent summary */
  intent?: { summaryKey: string; params?: Record<string, unknown> };
  /** slider: continuous value */
  slider?: SliderSpec;
  /** colorPicker: hex/CSS color swatches (≤ 16) + current selection */
  swatches?: string[];
  selectedColor?: string;
  /** candidateList: typing suggestions from the host input system (≤ 12) */
  candidates?: string[];
  /** characterPicker: emoji / symbol set (defaults host-side when omitted) */
  characters?: string[];
}

/** Fields a publisher may patch through an open stream (arch §8.3). */
export const STREAMABLE_FIELDS = ['labelKey', 'progress', 'confidence', 'reason'] as const;
export type StreamableField = (typeof STREAMABLE_FIELDS)[number];

/** Per-surface suggestion-lane policy (arch §3.4). */
export interface SuggestionPolicy {
  maxVisible: number;
  minConfidence: number;
  allowEffects: EffectClass[];
}

export const DEFAULT_SUGGESTION_POLICY: SuggestionPolicy = {
  maxVisible: 2,
  minConfidence: 0.35,
  allowEffects: ['read', 'write'],
};

/** Mirrors the NSTouchBar property set (arch §3.4). */
export interface AIBarDefinitionSpec {
  /** Immutable once shipped (INV-A5). */
  customizationIdentifier?: string;
  defaultItemIdentifiers: AIBarItemIdentifier[];
  customizationAllowedItemIdentifiers?: AIBarItemIdentifier[];
  customizationRequiredItemIdentifiers?: AIBarItemIdentifier[];
  principalItemIdentifier?: AIBarItemIdentifier;
  escapeKeyReplacementItemIdentifier?: AIBarItemIdentifier;
  suggestionPolicy?: Partial<SuggestionPolicy>;
  /**
   * Optional overflow-floor extra action (palette drain). When omitted the
   * overflow sub-surface lists overflowed items only.
   */
  overflowAction?: ActionRef;
}

/** Per-publisher quotas (arch §9.3). */
export interface PublisherQuotas {
  maxItems: number;
  maxMessagesPerSecond: number;
  maxSpecBytes: number;
  maxConcurrentStreams: number;
}

export const DEFAULT_QUOTAS: PublisherQuotas = {
  maxItems: 32,
  maxMessagesPerSecond: 10,
  maxSpecBytes: 8 * 1024,
  maxConcurrentStreams: 4,
};

export const DEFAULT_TTL_MS = 10 * 60 * 1000;
