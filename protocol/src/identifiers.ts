/**
 * AIBar item identity (docs/aibar-architecture.md §3.1).
 *
 * Reverse-URI identifiers: `<host-namespace>.aibar.<type>.<key>`.
 * The identifier is simultaneously the diff key, persistence key, telemetry
 * key, hotkey-binding key, and accessibility id. Array position is never
 * identity.
 */

export type AIBarItemIdentifier = string & { readonly __brand: 'AIBarItemIdentifier' };

const SEGMENT_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/i;

export class InvalidIdentifierError extends Error {
  constructor(detail: string) {
    super(`Invalid AIBar item identifier: ${detail}`);
    this.name = 'InvalidIdentifierError';
  }
}

/**
 * The only sanctioned constructor for identifiers.
 *
 * `makeItemIdentifier('com.example', 'button', 'new-chat')` →
 * `'com.example.aibar.button.new-chat'`.
 */
export function makeItemIdentifier(
  namespace: string,
  type: string,
  key: string,
): AIBarItemIdentifier {
  for (const [name, value] of [['namespace', namespace], ['type', type], ['key', key]] as const) {
    if (!value || !SEGMENT_RE.test(value)) {
      throw new InvalidIdentifierError(`${name} '${value}' must be dot-separated [a-z0-9-] segments`);
    }
  }
  return `${namespace}.aibar.${type}.${key}` as AIBarItemIdentifier;
}

/** Runtime brand check for values arriving over the wire. */
export function isItemIdentifier(value: unknown): value is AIBarItemIdentifier {
  return typeof value === 'string' && value.includes('.aibar.') && SEGMENT_RE.test(value);
}

export function asItemIdentifier(value: string): AIBarItemIdentifier {
  if (!isItemIdentifier(value)) throw new InvalidIdentifierError(value);
  return value;
}
