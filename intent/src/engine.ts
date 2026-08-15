/**
 * Heuristic suggestion-lane engine (docs/aibar-architecture.md §6.2, B.5).
 *
 * The built-in, fully-local prediction strategy: frecency × context n-gram
 * ("after action A in context C, action B follows p% of the time"), learned
 * from observed invocations only. Deterministic, explainable, and privacy
 * preserving: it stores action identities and context keys, never content.
 *
 * Trust properties the engine upholds by construction:
 * - Dismissals apply a multiplicative confidence penalty that decays over
 *   days; acceptances relax it (§6.2 self-tuning threshold).
 * - `destructive` actions are never emitted as suggestions (INV-A8): a
 *   destructive prediction must arrive as an `approval` item instead.
 * - Muted action names ("never suggest sharing actions") are honored before
 *   scoring — user ownership over the intelligence itself (design §9.3).
 */
import type { IntentSignal, SuggestionCandidate } from '@aibar/core';
import type { EffectClass } from '@aibar/protocol';

/** One observed action invocation the engine may later re-surface. */
export interface ObservedInvocation {
  /** Stable identity of the source action (typically the AIBar item id). */
  key: string;
  labelKey: string;
  icon?: string;
  action?: { name: string; params?: Record<string, unknown> };
  effect?: EffectClass;
  /** Host-defined context bucket; use `contextKeyOf(route, mode)`. */
  contextKey: string;
  at?: number;
}

export interface IntentEngineOptions {
  /** Ring-buffer capacity for observed events (§11.4). */
  capacity?: number;
  now?: () => number;
  /** Max candidates per prediction (lane slots are capped anyway). */
  maxCandidates?: number;
}

interface PenaltyEntry {
  factor: number;
  updatedAt: number;
}

interface EventEntry {
  key: string;
  contextKey: string;
  at: number;
}

const DEFAULT_CAPACITY = 2000;
const PENALTY_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;
const FRECENCY_HALF_LIFE_MS = 24 * 60 * 60 * 1000;
/** Weight blend: repetition in context vs sequence following. */
const W_FRECENCY = 0.45;
const W_NGRAM = 0.55;

/** The context bucket both `observe` and `predict` must agree on. */
export function contextKeyOf(route?: string, mode?: string): string {
  return `${route ?? ''}|${mode ?? ''}`;
}

function slug(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

export class HeuristicIntentEngine {
  private capacity: number;
  private now: () => number;
  private maxCandidates: number;

  private events: EventEntry[] = [];
  private catalog = new Map<string, Omit<ObservedInvocation, 'contextKey' | 'at'>>();
  private lastKeyByContext = new Map<string, string>();
  /** `${contextKey}::${prev}→${next}` → count */
  private transitions = new Map<string, number>();
  /** `${contextKey}::${prev}` → outgoing total */
  private fromTotals = new Map<string, number>();
  private penalties = new Map<string, PenaltyEntry>();
  private muted = new Set<string>();

  constructor(opts: IntentEngineOptions = {}) {
    this.capacity = opts.capacity ?? DEFAULT_CAPACITY;
    this.now = opts.now ?? (() => Date.now());
    this.maxCandidates = opts.maxCandidates ?? 3;
  }

  /** Record one real invocation (kernel `aibar.action.invoked` fan-in). */
  observe(inv: ObservedInvocation): void {
    const at = inv.at ?? this.now();
    this.events.push({ key: inv.key, contextKey: inv.contextKey, at });
    if (this.events.length > this.capacity) this.events.shift();
    this.catalog.set(inv.key, {
      key: inv.key,
      labelKey: inv.labelKey,
      icon: inv.icon,
      action: inv.action,
      effect: inv.effect,
    });
    const prev = this.lastKeyByContext.get(inv.contextKey);
    if (prev && prev !== inv.key) {
      const tKey = `${inv.contextKey}::${prev}→${inv.key}`;
      const fKey = `${inv.contextKey}::${prev}`;
      this.transitions.set(tKey, (this.transitions.get(tKey) ?? 0) + 1);
      this.fromTotals.set(fKey, (this.fromTotals.get(fKey) ?? 0) + 1);
    }
    this.lastKeyByContext.set(inv.contextKey, inv.key);
  }

  /** §6.2: each dismissal raises the effective bar for that action. */
  noteDismissed(key: string): void {
    const current = this.penaltyFactor(key);
    this.penalties.set(key, { factor: Math.max(0.05, current * 0.5), updatedAt: this.now() });
  }

  /** Each acceptance lowers the bar again. */
  noteAccepted(key: string): void {
    const current = this.penaltyFactor(key);
    this.penalties.set(key, { factor: Math.min(1, current * 1.25), updatedAt: this.now() });
  }

  setMutedActions(actionNames: readonly string[]): void {
    this.muted = new Set(actionNames);
  }

  /** `AIBarHostAdapter.intent.predict` conformant strategy entrypoint. */
  async predict(signal: IntentSignal): Promise<SuggestionCandidate[]> {
    const contextKey = contextKeyOf(signal.route, signal.mode);
    const now = this.now();
    const prev = this.lastKeyByContext.get(contextKey);

    // Recency-weighted per-key support within this context.
    const support = new Map<string, number>();
    for (const e of this.events) {
      if (e.contextKey !== contextKey) continue;
      const weight = Math.pow(0.5, (now - e.at) / FRECENCY_HALF_LIFE_MS);
      support.set(e.key, (support.get(e.key) ?? 0) + weight);
    }

    const fromTotal = prev ? (this.fromTotals.get(`${contextKey}::${prev}`) ?? 0) : 0;
    const scored: SuggestionCandidate[] = [];
    for (const [key, s] of support) {
      const meta = this.catalog.get(key);
      if (!meta || !meta.action) continue;
      if (meta.effect === 'destructive') continue; // INV-A8
      if (this.muted.has(meta.action.name)) continue;

      const frecency = Math.min(1, s / 5);
      let ngram = 0;
      if (prev && prev !== key && fromTotal > 0) {
        const count = this.transitions.get(`${contextKey}::${prev}→${key}`) ?? 0;
        // Require support ≥ 2 before a transition reads as a pattern.
        ngram = (count / fromTotal) * Math.min(1, count / 2);
      }
      const confidence =
        Math.min(0.95, W_FRECENCY * frecency + W_NGRAM * ngram) * this.penaltyFactor(key);
      if (confidence <= 0) continue;

      const repeatCount = Math.round(s);
      scored.push({
        id: `intent.aibar.suggestion.${slug(key)}`,
        labelKey: meta.labelKey,
        icon: meta.icon,
        action: meta.action,
        confidence,
        reason:
          ngram > frecency
            ? { code: 'follows_previous', args: { source: key } }
            : { code: 'repeat_in_context', args: { source: key, count: repeatCount } },
        effect: meta.effect ?? 'read',
      });
    }

    scored.sort((a, b) => b.confidence - a.confidence);
    return scored.slice(0, this.maxCandidates);
  }

  /** Feedback fan-in keyed by candidate id (maps back to the source action). */
  noteCandidateDismissed(candidateId: string): void {
    const key = this.sourceOf(candidateId);
    if (key) this.noteDismissed(key);
  }

  noteCandidateAccepted(candidateId: string): void {
    const key = this.sourceOf(candidateId);
    if (key) this.noteAccepted(key);
  }

  private sourceOf(candidateId: string): string | null {
    const suffix = candidateId.replace(/^intent\.aibar\.suggestion\./, '');
    for (const key of this.catalog.keys()) {
      if (slug(key) === suffix) return key;
    }
    return null;
  }

  private penaltyFactor(key: string): number {
    const entry = this.penalties.get(key);
    if (!entry) return 1;
    // Penalties decay back toward 1 with a multi-day half-life.
    const age = this.now() - entry.updatedAt;
    const recovery = 1 - Math.pow(0.5, age / PENALTY_HALF_LIFE_MS);
    return entry.factor + (1 - entry.factor) * recovery;
  }

  // ——— persistence (host persistence SPI; local-only, user-clearable §12.4) ———

  export(): unknown {
    return {
      v: 1,
      events: this.events.slice(-this.capacity),
      catalog: [...this.catalog.values()],
      transitions: [...this.transitions],
      fromTotals: [...this.fromTotals],
      penalties: [...this.penalties].map(([key, p]) => ({ key, ...p })),
      lastKeyByContext: [...this.lastKeyByContext],
    };
  }

  import(raw: unknown): void {
    const data = raw as {
      v?: number;
      events?: EventEntry[];
      catalog?: (Omit<ObservedInvocation, 'contextKey' | 'at'> & { key: string })[];
      transitions?: [string, number][];
      fromTotals?: [string, number][];
      penalties?: ({ key: string } & PenaltyEntry)[];
      lastKeyByContext?: [string, string][];
    } | null;
    if (!data || data.v !== 1) return;
    this.events = (data.events ?? []).slice(-this.capacity);
    this.catalog = new Map((data.catalog ?? []).map((c) => [c.key, c]));
    this.transitions = new Map(data.transitions ?? []);
    this.fromTotals = new Map(data.fromTotals ?? []);
    this.penalties = new Map((data.penalties ?? []).map((p) => [p.key, { factor: p.factor, updatedAt: p.updatedAt }]));
    this.lastKeyByContext = new Map(data.lastKeyByContext ?? []);
  }
}
