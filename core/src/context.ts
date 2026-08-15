/**
 * Context model (docs/aibar-architecture.md §5).
 *
 * Context is an immutable snapshot with a monotonically increasing revision.
 * Providers own slices; invalidations coalesce in a trailing window (default
 * 32 ms) and unchanged slices short-circuit downstream re-evaluation.
 */
import { setTimeout } from './timers';

export interface FocusDescriptor {
  kind: string; // 'input' | 'canvas' | 'list' | …
  meta?: Record<string, unknown>;
}

export interface SelectionDescriptor {
  kind: string; // 'text' | 'node' | 'file' | …
  count: number;
  meta?: Record<string, unknown>;
}

export type AgentPhase =
  | 'idle'
  | 'preparing'
  | 'thinking'
  | 'answering'
  | 'tooling'
  | 'awaiting_input'
  | 'error'
  /** @deprecated Prefer answering/tooling; kept for older host slices. */
  | 'acting';

export interface LiveRunDescriptor {
  runId: string;
  kind: 'agent_turn' | 'workflow' | 'task' | 'upload' | string;
  labelKey?: string;
  label?: string;
  /** Host icon name for liveStatus chrome. */
  icon?: string;
  /** Fine-grained agent/workflow phase for morph + tone. */
  phase?: AgentPhase;
  /** 0..1; omit for indeterminate */
  progress?: number;
  status: 'running' | 'awaiting_input' | 'failed' | 'succeeded';
  /** Direct-action target (R2: liveStatus always carries an action) */
  action?: { name: string; params?: Record<string, unknown> };
}

export interface AgentContext {
  sessionId?: string;
  phase?: AgentPhase;
  pendingApprovals?: number;
  /** Compact host-produced digest of recent intent — NEVER raw conversation. */
  intentDigest?: string;
}

export interface AIBarContext {
  revision: number;
  timestamp: number;

  route?: string;
  mode?: string;
  focus?: FocusDescriptor;
  selection?: SelectionDescriptor;

  capabilities: ReadonlySet<string>;

  runs?: readonly LiveRunDescriptor[];
  agent?: AgentContext;

  /** Namespaced host extension slot. */
  state: Readonly<Record<string, unknown>>;
}

export type ContextSlice = Readonly<Record<string, unknown>>;

export interface ContextProvider {
  /** Slice namespace: 'route', 'chat', 'layout', … */
  id: string;
  /** Synchronous, pure, cheap. */
  collect(): ContextSlice;
  /** Notify on potential change; returns an unsubscribe. */
  subscribe(onInvalidate: () => void): () => void;
}

export const EMPTY_CONTEXT: AIBarContext = {
  revision: 0,
  timestamp: 0,
  capabilities: new Set(),
  state: {},
};

/** Slice-level shallow equality — the §5.3 diff short-circuit. */
function sliceEqual(a: ContextSlice | undefined, b: ContextSlice): boolean {
  if (a === b) return true;
  if (!a) return false;
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.is(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Well-known slice keys that are lifted from a provider slice onto the
 * top-level snapshot (a provider whose slice carries `route`, `mode`, `focus`,
 * `selection`, `runs`, `agent`, or `capabilities` populates those fields; runs
 * arrays from multiple providers concatenate).
 */
const LIFTED_KEYS = ['route', 'mode', 'focus', 'selection', 'agent'] as const;

export interface ContextHubOptions {
  coalesceMs?: number;
  now?: () => number;
  /** Trailing-window scheduler; injectable for tests. */
  defer?: (cb: () => void, ms: number) => void;
}

export class ContextHub {
  private providers = new Map<string, ContextProvider>();
  private unsubscribes = new Map<string, () => void>();
  private slices = new Map<string, ContextSlice>();
  private dirty = new Set<string>();
  private flushScheduled = false;
  private revision = 0;
  private snapshot: AIBarContext = EMPTY_CONTEXT;
  private listeners = new Set<(ctx: AIBarContext, dirtySlices: ReadonlySet<string>) => void>();

  private readonly coalesceMs: number;
  private readonly now: () => number;
  private readonly defer: (cb: () => void, ms: number) => void;

  constructor(opts: ContextHubOptions = {}) {
    this.coalesceMs = opts.coalesceMs ?? 32;
    this.now = opts.now ?? (() => Date.now());
    this.defer = opts.defer ?? ((cb, ms) => setTimeout(cb, ms));
  }

  register(provider: ContextProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Duplicate context provider '${provider.id}'`);
    }
    this.providers.set(provider.id, provider);
    this.unsubscribes.set(provider.id, provider.subscribe(() => this.invalidate(provider.id)));
    this.invalidate(provider.id);
    return () => {
      this.unsubscribes.get(provider.id)?.();
      this.unsubscribes.delete(provider.id);
      this.providers.delete(provider.id);
      this.slices.delete(provider.id);
      this.invalidateAll();
    };
  }

  invalidate(providerId: string): void {
    this.dirty.add(providerId);
    this.scheduleFlush();
  }

  invalidateAll(): void {
    for (const id of this.providers.keys()) this.dirty.add(id);
    this.scheduleFlush();
  }

  current(): AIBarContext {
    return this.snapshot;
  }

  onChange(listener: (ctx: AIBarContext, dirtySlices: ReadonlySet<string>) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Force a synchronous flush (tests, teardown). */
  flushNow(): void {
    this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    this.defer(() => this.flush(), this.coalesceMs);
  }

  private flush(): void {
    this.flushScheduled = false;
    if (this.dirty.size === 0) return;
    const changed = new Set<string>();
    for (const id of this.dirty) {
      const provider = this.providers.get(id);
      if (!provider) continue;
      let slice: ContextSlice;
      try {
        slice = provider.collect();
      } catch {
        continue; // a throwing provider never breaks snapshot synthesis
      }
      if (!sliceEqual(this.slices.get(id), slice)) {
        this.slices.set(id, slice);
        changed.add(id);
      }
    }
    this.dirty.clear();
    if (changed.size === 0) return; // no material change → drop (§5.3)

    this.revision += 1;
    this.snapshot = this.synthesize();
    for (const l of [...this.listeners]) l(this.snapshot, changed);
  }

  private synthesize(): AIBarContext {
    const state: Record<string, unknown> = {};
    const runs: LiveRunDescriptor[] = [];
    const capabilities = new Set<string>();
    const lifted: Partial<Record<(typeof LIFTED_KEYS)[number], unknown>> = {};

    for (const [id, slice] of this.slices) {
      for (const key of LIFTED_KEYS) {
        if (slice[key] !== undefined) lifted[key] = slice[key];
      }
      if (Array.isArray(slice.runs)) runs.push(...(slice.runs as LiveRunDescriptor[]));
      if (slice.capabilities) {
        for (const cap of slice.capabilities as Iterable<string>) capabilities.add(cap);
      }
      state[id] = slice;
    }

    return Object.freeze({
      revision: this.revision,
      timestamp: this.now(),
      route: lifted.route as string | undefined,
      mode: lifted.mode as string | undefined,
      focus: lifted.focus as FocusDescriptor | undefined,
      selection: lifted.selection as SelectionDescriptor | undefined,
      capabilities,
      runs,
      agent: lifted.agent as AgentContext | undefined,
      state: Object.freeze(state),
    });
  }

  destroy(): void {
    for (const unsub of this.unsubscribes.values()) unsub();
    this.unsubscribes.clear();
    this.providers.clear();
    this.listeners.clear();
  }
}

/** Resolve a `ctx.*` path against a snapshot (predicate DSL + $ctx interpolation). */
export function resolveContextPath(ctx: AIBarContext, path: string): unknown {
  const parts = path.replace(/^\$?ctx\./, '').split('.');
  let cur: unknown = ctx;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (cur instanceof Set) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
