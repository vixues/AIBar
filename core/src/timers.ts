/**
 * Host timers without a DOM/Node lib (INV-A4: core stays environment-free).
 * `lib: ["ES2022"]` does not declare setTimeout/clearTimeout/queueMicrotask.
 */
type HostTimers = {
  setTimeout(handler: () => void, timeout?: number): unknown;
  clearTimeout(id: unknown): void;
  queueMicrotask(callback: () => void): void;
};

const host = globalThis as unknown as HostTimers;

export function setTimeout(handler: () => void, timeout?: number): unknown {
  return host.setTimeout(handler, timeout);
}

export function clearTimeout(id: unknown): void {
  host.clearTimeout(id);
}

export function queueMicrotask(callback: () => void): void {
  host.queueMicrotask(callback);
}
