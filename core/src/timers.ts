/**
 * Host globals without a DOM/Node lib (INV-A4: core stays environment-free).
 * `lib: ["ES2022"]` does not declare timers or `structuredClone`.
 */
type HostGlobals = {
  setTimeout(handler: () => void, timeout?: number): unknown;
  clearTimeout(id: unknown): void;
  queueMicrotask(callback: () => void): void;
  structuredClone<T>(value: T): T;
};

const host = globalThis as unknown as HostGlobals;

export function setTimeout(handler: () => void, timeout?: number): unknown {
  return host.setTimeout(handler, timeout);
}

export function clearTimeout(id: unknown): void {
  host.clearTimeout(id);
}

export function queueMicrotask(callback: () => void): void {
  host.queueMicrotask(callback);
}

export function structuredClone<T>(value: T): T {
  return host.structuredClone(value);
}
