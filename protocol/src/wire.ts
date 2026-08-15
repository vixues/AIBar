/**
 * Wire protocol message set (docs/aibar-architecture.md §9.2).
 *
 * One message set over WebSocket / SSE / postMessage / in-process bridges.
 * The host owns transport; the kernel owns `WireIngress`.
 */
import type { AIBarItemIdentifier } from './identifiers';
import type { AIBarItemSpec, PublisherQuotas, StreamableField, SuggestionPolicy } from './item-spec';

export type WireMessage =
  | { kind: 'hello'; version: string; publisherId: string; auth?: string }
  | {
      kind: 'welcome';
      version: string;
      capabilities: { itemTypes: string[]; actions: string[] };
      grantedScopes: string[];
      quotas: PublisherQuotas;
      suggestionPolicy: SuggestionPolicy;
    }
  | { kind: 'publish'; publisherId: string; items: AIBarItemSpec[] }
  | { kind: 'update'; publisherId: string; id: AIBarItemIdentifier; patch: ItemPatch }
  | { kind: 'stream.open'; publisherId: string; id: AIBarItemIdentifier }
  | { kind: 'stream.delta'; publisherId: string; id: AIBarItemIdentifier; patch: StreamPatch }
  | { kind: 'stream.close'; publisherId: string; id: AIBarItemIdentifier }
  | { kind: 'revoke'; publisherId: string; ids: AIBarItemIdentifier[] }
  | { kind: 'renew'; publisherId: string; ids: AIBarItemIdentifier[] }
  | { kind: 'ack'; ids: AIBarItemIdentifier[] }
  | { kind: 'error'; code: WireErrorCode; detail: string; id?: AIBarItemIdentifier };

export type WireErrorCode = 'quota' | 'validation' | 'unsupported' | 'forbidden' | 'unknown-item';

/** JSON Merge Patch on the full (non-geometry) spec via `update`. */
export type ItemPatch = Partial<Omit<AIBarItemSpec, 'id' | 'type'>>;

/** Stream deltas are restricted to the streamable-field allowlist (arch §8.3). */
export type StreamPatch = Partial<Pick<AIBarItemSpec, StreamableField>>;
