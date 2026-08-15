/**
 * The dual-lane resolver (docs/aibar-architecture.md §6).
 *
 * Deterministic lane: visibility filter → enablement → relevance scoring →
 * priority ranking → spatial budget packing (two-phase, compression ladder) →
 * stability pass (hysteresis, positional anchoring, dwell).
 *
 * Suggestion lane: confidence-gated `suggestion` items compete ONLY for their
 * own slots and never displace deterministic items (INV-A7). Correctness
 * invariants P1–P5 (§6.4) are property-tested.
 */
import { asItemIdentifier, type AIBarItemIdentifier, type SuggestionPolicy, type WidthSpec } from '@aibar/protocol';
import type { AIBarContext } from './context';
import { widthOf, type AIBarItem } from './items';

/** Compression ladder: a homogeneous set this large collapses to a scrubber. */
export const SCRUBBER_COLLAPSE_MIN = 8;

export type Density = 'compact' | 'regular';

export const DENSITY_METRICS: Record<Density, {
  surfaceHeight: number;
  itemHeight: number;
  gapItem: number;
  gapGroup: number;
  iconSize: number;
  textSize: number;
  escapeZoneWidth: number;
  /** Leading inset when the Escape Zone is empty (composer flush-left). */
  edgePad: number;
}> = {
  // Compact height must stay lockstep with styles.css + renderer FONT_SIZE.
  // Items stay 28px; vertical centering keeps equal insets under 1px chrome.
  compact: { surfaceHeight: 36, itemHeight: 28, gapItem: 3, gapGroup: 8, iconSize: 15, textSize: 11, escapeZoneWidth: 28, edgePad: 4 },
  regular: { surfaceHeight: 52, itemHeight: 38, gapItem: 6, gapGroup: 14, iconSize: 18, textSize: 13, escapeZoneWidth: 44, edgePad: 8 },
};

/** Scoring weights (arch §6.3); deterministic and explainable. */
export const SCORE_WEIGHTS = { wP: 0.4, wR: 0.3, wU: 0.2, wC: 0.1 } as const;

/** Hysteresis gap between the enter and leave thresholds (§6.5). */
export const HYSTERESIS_BONUS = 0.1;
/** A freshly shown item cannot be evicted by score decay for this long (§6.5). */
export const DWELL_MS = 800;

export interface StabilityState {
  /** ids displayed in the previous plan, in display order */
  previousOrder: readonly AIBarItemIdentifier[];
  /** id → timestamp the item entered the display set */
  shownAt: ReadonlyMap<AIBarItemIdentifier, number>;
}

export const EMPTY_STABILITY: StabilityState = { previousOrder: [], shownAt: new Map() };

export interface ScoreBreakdown {
  priority: number;
  relevance: number;
  frecency: number;
  pin: number;
  hysteresis: number;
  dwell: boolean;
  total: number;
}

export interface PlacedItem {
  id: AIBarItemIdentifier;
  item: AIBarItem;
  x: number;
  width: number;
  enabled: boolean;
  /** group collapsed by the compression ladder */
  collapsed: boolean;
  /** ladder rung the group collapsed to (default popover trigger) */
  collapsedTo?: 'popover' | 'scrubber';
  score: ScoreBreakdown;
}

export interface ResolvedPlan {
  contextual: PlacedItem[];
  system: PlacedItem[];
  suggestions: PlacedItem[];
  overflowed: AIBarItem[];
  /** stability bookkeeping to feed into the next resolve */
  nextStability: StabilityState;
  surfaceWidth: number;
  density: Density;
}

export interface ResolveInput {
  ctx: AIBarContext;
  items: readonly AIBarItem[];
  /** base declaration order: id → index (registration order fallback) */
  baseOrder: ReadonlyMap<AIBarItemIdentifier, number>;
  requiredIds: ReadonlySet<AIBarItemIdentifier>;
  pinnedIds: ReadonlySet<AIBarItemIdentifier>;
  principalId?: AIBarItemIdentifier;
  surfaceWidth: number;
  density: Density;
  /** preferred text width in px for a display string */
  measureText: (text: string) => number;
  resolveLabel: (key: string) => string;
  /** local usage statistics, normalized 0..1 (opt-out returns 0) */
  frecency: (id: AIBarItemIdentifier) => number;
  stability: StabilityState;
  now: number;
  suggestionPolicy: SuggestionPolicy;
  /** width reserved for the always-present overflow trigger */
  overflowTriggerWidth?: number;
  /**
   * Leading Escape Zone width for the *current presentation* (not global).
   * - ground (composer Appendix B): omit / 0 → edgePad flush-left
   * - subsurface (popover/overflow): escapeZoneWidth — Esc chrome of that bar
   * When omitted, defaults to density.escapeZoneWidth (full Touch Bar anatomy).
   */
  leadingInset?: number;
}

function normalizePriority(priority: number): number {
  // VisibilityPriority presets are -1000/0/1000 → 0/0.5/1
  return Math.min(1, Math.max(0, priority / 2000 + 0.5));
}

function isVisible(item: AIBarItem, ctx: AIBarContext): boolean {
  try {
    return item.visible ? item.visible(ctx) : true;
  } catch {
    return false; // a throwing predicate never breaks the surface (§12.6)
  }
}

function isEnabled(item: AIBarItem, ctx: AIBarContext): boolean {
  try {
    return item.enabled ? item.enabled(ctx) : true;
  } catch {
    return false;
  }
}

function scoreOf(
  item: AIBarItem,
  ctx: AIBarContext,
  input: ResolveInput,
): ScoreBreakdown {
  const { wP, wR, wU, wC } = SCORE_WEIGHTS;
  let relevance = 0.5;
  if (item.relevance) {
    try {
      relevance = Math.min(1, Math.max(0, item.relevance(ctx)));
    } catch {
      relevance = 0;
    }
  }
  const priority = normalizePriority(item.visibilityPriority);
  const frecency = Math.min(1, Math.max(0, input.frecency(item.id)));
  const pin = input.pinnedIds.has(item.id) ? 1 : 0;
  const wasDisplayed = input.stability.shownAt.has(item.id);
  const hysteresis = wasDisplayed ? HYSTERESIS_BONUS : 0;
  const shownAt = input.stability.shownAt.get(item.id);
  const dwell = wasDisplayed && shownAt !== undefined && input.now - shownAt < DWELL_MS;
  const total = wP * priority + wR * relevance + wU * frecency + wC * pin + hysteresis + (dwell ? 0.5 : 0);
  return { priority, relevance, frecency, pin, hysteresis, dwell, total };
}

interface Candidate {
  item: AIBarItem;
  width: WidthSpec;
  score: ScoreBreakdown;
  required: boolean;
  baseIndex: number;
  /** ladder state: group collapsed to popover trigger / scrubber */
  collapsed: boolean;
  collapsedTo?: 'popover' | 'scrubber';
}

/** Resolve the string that will actually paint (dynamic `text` wins over labelKey). */
function displayLabel(item: AIBarItem, input: ResolveInput): string {
  if (typeof item.text === 'function') {
    try {
      return item.text(input.ctx) ?? input.resolveLabel(item.labelKey);
    } catch {
      return input.resolveLabel(item.labelKey);
    }
  }
  if (typeof item.text === 'string') return item.text;
  return input.resolveLabel(item.labelKey);
}

/** Effective width including measured label text (design §11.2: measurement, not hardcoding). */
function effectiveWidth(item: AIBarItem, input: ResolveInput): WidthSpec {
  const base = widthOf(item);
  // Explicit icon-only wins — don't inflate width from the i18n label.
  if (item.showsLabel === false && item.type !== 'liveStatus') return base;
  const showsText =
    item.type === 'label' ||
    item.type === 'mainButton' ||
    item.type === 'suggestion' ||
    item.type === 'approval' ||
    item.type === 'liveStatus' ||
    item.showsLabel === true;
  if (!showsText) return base;
  const label = displayLabel(item, input);
  const metrics = DENSITY_METRICS[input.density];
  const padding = 20;
  const iconWidth = item.icon || item.type === 'liveStatus' ? metrics.iconSize + 6 : 0;
  // liveStatus with a determinate progress paints a stacked meter (label over bar).
  const extras =
    item.type === 'suggestion'
      ? 24
      : item.type === 'approval'
        ? 96
        : item.type === 'liveStatus'
          ? item.progress !== undefined
            ? 4
            : 22
          : 0;
  const text = Math.ceil(input.measureText(label));
  // Stacked usage meter: width is driven by the short percent label, not icon+meter row.
  const preferred =
    item.type === 'liveStatus' && item.progress !== undefined
      ? Math.min(
          base.max ?? Number.POSITIVE_INFINITY,
          Math.max(base.min, text + 16),
        )
      : Math.min(
          base.max ?? Number.POSITIVE_INFINITY,
          Math.max(base.min, text + padding + iconWidth + extras),
        );
  if (item.type === 'label') {
    // labels size to text: min = preferred = text width (never truncated)
    return { ...base, min: Math.min(preferred, base.max ?? preferred), preferred };
  }
  return { ...base, preferred };
}

function groupWidth(item: AIBarItem, input: ResolveInput, kind: 'min' | 'preferred'): number {
  const children = item.children ?? [];
  const gap = DENSITY_METRICS[input.density].gapItem;
  let total = children.length > 1 ? gap * (children.length - 1) : 0;
  for (const child of children) {
    const w = effectiveWidth(child, input);
    total += kind === 'min' ? w.min : w.preferred;
  }
  return total;
}

/**
 * Two-phase spatial budget packing (arch §6.4) over one zone's candidates.
 * Returns placed candidates (widths assigned, in stable order) + overflow.
 */
function pack(
  candidates: Candidate[],
  budget: number,
  gap: number,
): { placed: Candidate[]; widths: Map<AIBarItemIdentifier, number>; overflow: Candidate[] } {
  // ——— Phase 1: admission, greedy by descending effective score ———
  // Required/pinned items bypass elimination (§6.3) — admitted first.
  const byScore = [...candidates].sort((a, b) => {
    if (a.required !== b.required) return a.required ? -1 : 1;
    if (b.score.total !== a.score.total) return b.score.total - a.score.total;
    return a.baseIndex - b.baseIndex; // deterministic tie-break (P4)
  });

  const admitted = new Set<Candidate>();
  const overflow: Candidate[] = [];
  let used = 0;

  const gapCost = () => (admitted.size > 0 ? gap : 0);

  for (const cand of byScore) {
    let width = cand.width.min;
    let fits = used + gapCost() + width <= budget;

    if (!fits && cand.item.type === 'group' && !cand.collapsed) {
      // Compression ladder (§6.4): a homogeneous large set collapses into a
      // virtualized scrubber; anything else falls back to a popover trigger.
      const children = cand.item.children ?? [];
      const homogeneous =
        children.length >= SCRUBBER_COLLAPSE_MIN &&
        children.every((c) => c.type === children[0]!.type);
      const scrubberMin = 120;
      if (homogeneous && used + gapCost() + scrubberMin <= budget) {
        cand.collapsed = true;
        cand.collapsedTo = 'scrubber';
        cand.width = { min: scrubberMin, preferred: 240, max: 360, flex: 0 };
        width = scrubberMin;
        fits = true;
      } else {
        const triggerMin = 36;
        if (used + gapCost() + triggerMin <= budget) {
          cand.collapsed = true;
          cand.collapsedTo = 'popover';
          cand.width = { min: triggerMin, preferred: 44, max: 44, flex: 0 };
          width = triggerMin;
          fits = true;
        }
      }
    }

    if (fits) {
      used += gapCost() + width;
      admitted.add(cand);
    } else if (cand.item.type.startsWith('spacer')) {
      // spacers are decoration: dropped silently under pressure (design §10)
    } else {
      overflow.push(cand); // never silently dropped (P3)
    }
  }

  // ——— Phase 2: distribution ———
  const placed = [...admitted].sort((a, b) => {
    const aMain = a.item.type === 'mainButton' ? 0 : 1;
    const bMain = b.item.type === 'mainButton' ? 0 : 1;
    if (aMain !== bMain) return aMain - bMain;
    return a.baseIndex - b.baseIndex;
  });
  const widths = new Map<AIBarItemIdentifier, number>();
  const gaps = placed.length > 1 ? gap * (placed.length - 1) : 0;
  const inner = budget - gaps;

  let sumPreferred = 0;
  for (const c of placed) sumPreferred += Math.min(c.width.preferred, c.width.max ?? Number.POSITIVE_INFINITY);

  if (sumPreferred <= inner) {
    // Everyone gets preferred; slack distributed by flex weight up to max.
    const slack = inner - sumPreferred;
    const flexTotal = placed.reduce((acc, c) => acc + (c.width.flex ?? 0), 0);
    for (const c of placed) {
      let w = c.width.preferred;
      if (flexTotal > 0 && slack > 0 && (c.width.flex ?? 0) > 0) {
        const share = (slack * (c.width.flex ?? 0)) / flexTotal;
        const ceiling = c.width.max ?? Number.POSITIVE_INFINITY;
        w = Math.min(ceiling, w + share);
      }
      widths.set(c.item.id, w);
    }
  } else {
    // Compress toward min in ASCENDING score order until it fits.
    const current = new Map<AIBarItemIdentifier, number>();
    for (const c of placed) current.set(c.item.id, c.width.preferred);
    let excess = sumPreferred - inner;
    const ascending = [...placed].sort((a, b) => {
      if (a.score.total !== b.score.total) return a.score.total - b.score.total;
      return b.baseIndex - a.baseIndex;
    });
    for (const c of ascending) {
      if (excess <= 0) break;
      const cur = current.get(c.item.id) ?? c.width.preferred;
      const give = Math.min(excess, cur - c.width.min);
      if (give > 0) {
        current.set(c.item.id, cur - give);
        excess -= give;
      }
    }
    for (const c of placed) widths.set(c.item.id, current.get(c.item.id) ?? c.width.min);
  }

  return { placed, widths, overflow };
}

/**
 * Same-family merge (§6.4 ladder rung 2): under budget pressure, contextual
 * candidates sharing a `family` tag fold into one synthesized group (which the
 * later rungs may further collapse into a popover trigger or scrubber).
 * Required/pinned items never merge away.
 */
function mergeFamilies(candidates: Candidate[]): Candidate[] {
  const byFamily = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const fam = c.item.family;
    if (fam && !c.required && c.item.type !== 'group' && !c.item.type.startsWith('spacer')) {
      const list = byFamily.get(fam) ?? [];
      list.push(c);
      byFamily.set(fam, list);
    }
  }
  const groupOf = new Map<Candidate, Candidate>();
  const skip = new Set<Candidate>();
  for (const [fam, members] of byFamily) {
    if (members.length < 2) continue;
    const slug = fam.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
    const first = members[0]!;
    const groupItem: AIBarItem = {
      id: asItemIdentifier(`core.aibar.group.family-${slug}`),
      type: 'group',
      labelKey: first.item.labelKey,
      icon: first.item.icon,
      showsLabel: false,
      visibilityPriority: Math.max(...members.map((m) => m.item.visibilityPriority)),
      provenance: { kind: 'host' },
      effect: 'read',
      parity: 'none:aibar-family-merge',
      zone: 'contextual',
      // Strip the family tag so members never re-merge inside the sub-surface.
      children: members.map((m) => ({ ...m.item, family: undefined, zone: 'contextual' as const })),
    };
    const groupCand: Candidate = {
      item: groupItem,
      // Merged groups exist to be squeezed: admit at trigger size if needed.
      width: { min: 36, preferred: 44, max: 44, flex: 0 },
      score: members.reduce((a, b) => (b.score.total > a.score.total ? b : a)).score,
      required: false,
      baseIndex: Math.min(...members.map((m) => m.baseIndex)),
      collapsed: true,
      collapsedTo: 'popover',
    };
    groupOf.set(first, groupCand);
    for (const m of members.slice(1)) skip.add(m);
  }
  if (groupOf.size === 0) return candidates;
  return candidates
    .filter((c) => !skip.has(c))
    .map((c) => groupOf.get(c) ?? c);
}

/**
 * Positional anchoring (§6.5): survivors keep the previous display order (P5).
 * Newcomers fill the first vacated previous slot (inline-expand replacements
 * occupy the trigger hole). If nothing was vacated they append at the tail.
 */
function anchorOrder(placed: Candidate[], previous: readonly AIBarItemIdentifier[]): Candidate[] {
  const prevIndex = new Map<AIBarItemIdentifier, number>();
  previous.forEach((id, i) => prevIndex.set(id, i));
  const byId = new Map(placed.map((c) => [c.item.id, c] as const));
  const newcomers = placed.filter((c) => !prevIndex.has(c.item.id));
  newcomers.sort((a, b) => a.baseIndex - b.baseIndex);

  if (previous.length === 0 || newcomers.length === 0) {
    const survivors = placed.filter((c) => prevIndex.has(c.item.id));
    survivors.sort((a, b) => prevIndex.get(a.item.id)! - prevIndex.get(b.item.id)!);
    return [...survivors, ...newcomers];
  }

  const used = new Set<AIBarItemIdentifier>();
  const out: Candidate[] = [];
  let spliced = false;
  const spliceNewcomers = () => {
    if (spliced) return;
    spliced = true;
    for (const c of newcomers) {
      out.push(c);
      used.add(c.item.id);
    }
  };

  for (const id of previous) {
    const survivor = byId.get(id);
    if (survivor) {
      out.push(survivor);
      used.add(id);
    } else {
      spliceNewcomers();
    }
  }
  if (!spliced) spliceNewcomers();
  for (const c of placed) {
    if (!used.has(c.item.id)) out.push(c);
  }
  return out;
}

/** Composer Send / other mainButtons stay flush-left regardless of baseOrder. */
function pinMainButtonsLeading(placed: Candidate[]): Candidate[] {
  if (placed.length < 2) return placed;
  const leading: Candidate[] = [];
  const rest: Candidate[] = [];
  for (const c of placed) {
    if (c.item.type === 'mainButton') leading.push(c);
    else rest.push(c);
  }
  return leading.length === 0 ? placed : [...leading, ...rest];
}

export function resolve(input: ResolveInput): ResolvedPlan {
  const { ctx, density } = input;
  const metrics = DENSITY_METRICS[density];
  const ttlAlive = (item: AIBarItem) => item.expiresAt === undefined || item.expiresAt > input.now;

  // ① visibility filter (+ TTL)
  const visible = input.items.filter((item) => ttlAlive(item) && isVisible(item, ctx));

  const deterministic = visible.filter((i) => i.type !== 'suggestion');
  const suggestionItems = visible.filter((i) => i.type === 'suggestion');

  const toCandidate = (item: AIBarItem): Candidate => {
    const width = item.type === 'group'
      ? {
          min: groupWidth(item, input, 'min'),
          preferred: groupWidth(item, input, 'preferred'),
          max: Number.POSITIVE_INFINITY,
          flex: 0,
        }
      : effectiveWidth(item, input);
    return {
      item,
      width,
      score: scoreOf(item, ctx, input),
      required:
        input.requiredIds.has(item.id) ||
        input.pinnedIds.has(item.id) ||
        item.type === 'approval' ||
        // Principal + mainButtons must survive packing (composer Send / New Chat).
        item.id === input.principalId ||
        item.type === 'mainButton',
      baseIndex: input.baseOrder.get(item.id) ?? Number.MAX_SAFE_INTEGER,
      collapsed: false,
    };
  };

  // ——— System Strip: host-only, packs at preferred, right-anchored ———
  const systemCandidates = deterministic
    .filter((i) => i.zone === 'system' && i.provenance.kind === 'host')
    .map(toCandidate)
    .sort((a, b) => a.baseIndex - b.baseIndex);
  let systemWidth = 0;
  for (const c of systemCandidates) {
    systemWidth += (systemWidth > 0 ? metrics.gapItem : 0) + c.width.preferred;
  }

  // ——— Suggestion Lane candidates: confidence-gated (§6.2) ———
  const laneCandidates = suggestionItems
    .filter((i) => (i.confidence ?? 0) >= input.suggestionPolicy.minConfidence)
    .filter((i) => input.suggestionPolicy.allowEffects.includes(i.effect))
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, input.suggestionPolicy.maxVisible)
    .map(toCandidate);

  // ——— Contextual Region budget (arch §6.4) ———
  // Two-pass: don't reserve overflow chrome until packing actually spills —
  // a permanent 36px reserve was creating overflow (and a dead "⋯" button)
  // on the composer shelf even when everything fit.
  // The suggestion lane is deliberately NOT part of this budget: the
  // deterministic lane packs as if no suggestions existed (INV-A7 / P6), and
  // suggestions are admitted afterwards into whatever slack remains.
  // Presentation-scoped chrome: subsurface passes escapeZoneWidth; composer
  // ground passes 0 so leadingChrome collapses to edgePad (Appendix B).
  const leading = input.leadingInset ?? metrics.escapeZoneWidth;
  const leadingChrome = leading > 0 ? leading + metrics.gapGroup : metrics.edgePad;
  const trailingPad = metrics.edgePad;
  const chromeBase =
    leadingChrome +
    (systemWidth > 0 ? systemWidth + metrics.gapGroup : 0) +
    metrics.gapItem +
    trailingPad;

  const contextualCandidates = deterministic
    .filter((i) => i.zone === 'contextual')
    .map(toCandidate);

  const triggerW = input.overflowTriggerWidth ?? 36;
  let budget = Math.max(0, input.surfaceWidth - chromeBase);
  let { placed, widths, overflow } = pack(contextualCandidates, budget, metrics.gapItem);
  if (overflow.length > 0) {
    // Ladder rung 2 first: fold same-family candidates before spilling to the
    // overflow floor; then reserve trigger width and pack the merged set.
    const merged = mergeFamilies(contextualCandidates);
    budget = Math.max(0, input.surfaceWidth - chromeBase - triggerW - metrics.gapItem);
    ({ placed, widths, overflow } = pack(merged, budget, metrics.gapItem));
  }
  const anchored = pinMainButtonsLeading(anchorOrder(placed, input.stability.previousOrder));

  // ——— Suggestion Lane admission: leftover slack only (§6.2) ———
  // A suggestion that doesn't fit simply doesn't show — zero cost to ignore,
  // and it can never push a deterministic item into overflow.
  let usedContextual = 0;
  for (const c of anchored) {
    const w = widths.get(c.item.id) ?? c.width.preferred;
    usedContextual += (usedContextual > 0 ? metrics.gapItem : 0) + w;
  }
  const laneItems: Candidate[] = [];
  let suggestionWidth = 0;
  for (const c of laneCandidates) {
    const separator = laneItems.length === 0 ? metrics.gapGroup : metrics.gapItem;
    const cost = separator + c.width.preferred;
    if (usedContextual + suggestionWidth + cost <= budget) {
      suggestionWidth += (laneItems.length > 0 ? metrics.gapItem : 0) + c.width.preferred;
      laneItems.push(c);
    }
  }

  // ——— Geometry: x offsets, left → right ———
  const place = (
    cands: Candidate[],
    startX: number,
    widthsMap?: Map<AIBarItemIdentifier, number>,
  ): PlacedItem[] => {
    let x = startX;
    const out: PlacedItem[] = [];
    for (const c of cands) {
      const w = widthsMap?.get(c.item.id) ?? c.width.preferred;
      out.push({
        id: c.item.id,
        item: c.item,
        x,
        width: w,
        enabled: isEnabled(c.item, ctx),
        collapsed: c.collapsed,
        collapsedTo: c.collapsedTo,
        score: c.score,
      });
      x += w + metrics.gapItem;
    }
    return out;
  };

  const contextualStart = leadingChrome;
  const contextual = place(anchored, contextualStart, widths);

  const suggestionStart =
    input.surfaceWidth -
    systemWidth -
    (systemWidth > 0 ? metrics.gapGroup : 0) -
    suggestionWidth -
    trailingPad;
  const suggestions = place(laneItems, Math.max(contextualStart, suggestionStart));

  const systemStart = input.surfaceWidth - systemWidth - trailingPad;
  const system = place(systemCandidates, Math.max(contextualStart, systemStart));

  // ——— stability bookkeeping for the next epoch ———
  const shownAt = new Map<AIBarItemIdentifier, number>();
  for (const p of contextual) {
    shownAt.set(p.id, input.stability.shownAt.get(p.id) ?? input.now);
  }
  const nextStability: StabilityState = {
    previousOrder: contextual.map((p) => p.id),
    shownAt,
  };

  return {
    contextual,
    system,
    suggestions,
    overflowed: overflow.sort((a, b) => a.baseIndex - b.baseIndex).map((c) => c.item),
    nextStability,
    surfaceWidth: input.surfaceWidth,
    density,
  };
}
