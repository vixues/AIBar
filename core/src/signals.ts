/**
 * Minimal signal graph (docs/aibar-architecture.md §2.3).
 *
 * Zero-dependency, API-aligned with the TC39 Signals proposal shape so it can
 * be swapped for the standard when it lands. Fine-grained invalidation: the
 * resolver's per-item dependency tracking (§6.6) falls out of signal reads.
 */

type Subscriber = { notify(): void };

let currentSubscriber: Subscriber | null = null;
let batchDepth = 0;
const batchQueue = new Set<Subscriber>();

function schedule(sub: Subscriber): void {
  if (batchDepth > 0) batchQueue.add(sub);
  else sub.notify();
}

export interface ReadonlySignal<T> {
  get(): T;
  /** Read without registering a dependency. */
  peek(): T;
  subscribe(listener: (value: T) => void): () => void;
}

export interface Signal<T> extends ReadonlySignal<T> {
  set(value: T): void;
}

class SignalImpl<T> implements Signal<T> {
  private subs = new Set<Subscriber>();
  private listeners = new Set<(value: T) => void>();

  constructor(private value: T, private equals: (a: T, b: T) => boolean) {}

  get(): T {
    if (currentSubscriber) this.subs.add(currentSubscriber);
    return this.value;
  }

  peek(): T {
    return this.value;
  }

  set(next: T): void {
    if (this.equals(this.value, next)) return;
    this.value = next;
    for (const sub of [...this.subs]) schedule(sub);
    for (const l of [...this.listeners]) l(next);
  }

  subscribe(listener: (value: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** internal */
  _unsubscribe(sub: Subscriber): void {
    this.subs.delete(sub);
  }
}

export function signal<T>(
  initial: T,
  equals: (a: T, b: T) => boolean = Object.is,
): Signal<T> {
  return new SignalImpl(initial, equals);
}

class ComputedImpl<T> implements ReadonlySignal<T>, Subscriber {
  private cached!: T;
  private stale = true;
  private subs = new Set<Subscriber>();
  private listeners = new Set<(value: T) => void>();

  constructor(private compute: () => T, private equals: (a: T, b: T) => boolean) {}

  notify(): void {
    if (!this.stale) {
      this.stale = true;
      for (const sub of [...this.subs]) schedule(sub);
      if (this.listeners.size > 0) {
        const next = this.get();
        for (const l of [...this.listeners]) l(next);
      }
    }
  }

  get(): T {
    if (currentSubscriber) this.subs.add(currentSubscriber);
    if (this.stale) {
      const prev = currentSubscriber;
      currentSubscriber = this;
      try {
        const next = this.compute();
        if (this.stale || !this.equals(next, this.cached)) this.cached = next;
      } finally {
        currentSubscriber = prev;
        this.stale = false;
      }
    }
    return this.cached;
  }

  peek(): T {
    return this.get();
  }

  subscribe(listener: (value: T) => void): () => void {
    this.get(); // establish dependencies
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export function computed<T>(
  compute: () => T,
  equals: (a: T, b: T) => boolean = Object.is,
): ReadonlySignal<T> {
  return new ComputedImpl(compute, equals);
}

/** Run `fn` immediately and re-run whenever a signal it read changes. */
export function effect(fn: () => void): () => void {
  let disposed = false;
  const runner: Subscriber = {
    notify() {
      if (disposed) return;
      run();
    },
  };
  function run(): void {
    const prev = currentSubscriber;
    currentSubscriber = runner;
    try {
      fn();
    } finally {
      currentSubscriber = prev;
    }
  }
  run();
  return () => {
    disposed = true;
  };
}

/** Coalesce multiple sets into a single downstream notification wave. */
export function batch(fn: () => void): void {
  batchDepth++;
  try {
    fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) {
      const queue = [...batchQueue];
      batchQueue.clear();
      for (const sub of queue) sub.notify();
    }
  }
}

/**
 * Track which named slices a function reads. Used by the resolver to know
 * which items must re-evaluate when a context slice changes (§6.6).
 */
export function trackReads<T>(fn: () => T, onRead: (name: string) => void): T {
  const tracker: Subscriber & { onRead?: (name: string) => void } = {
    notify() {},
    onRead,
  };
  const prev = currentSubscriber;
  currentSubscriber = tracker as Subscriber;
  try {
    return fn();
  } finally {
    currentSubscriber = prev;
  }
}
