/**
 * Wire ingress (docs/aibar-architecture.md §9.2–§9.4).
 *
 * The in-process bridge every remote publisher goes through: validation,
 * per-publisher quotas (item count, message rate, spec size, stream count),
 * TTL stamping, scope bookkeeping, the streamable-field allowlist, and
 * mandatory provenance. A malformed or over-quota message yields an `error`
 * reply — it never breaks the surface (§13 failure model).
 */
import {
  AIBAR_ITEM_TYPES,
  DEFAULT_QUOTAS,
  DEFAULT_SUGGESTION_POLICY,
  DEFAULT_TTL_MS,
  PROTOCOL_VERSION,
  STREAMABLE_FIELDS,
  validatePublishBatch,
  type AIBarItemIdentifier,
  type AIBarItemSpec,
  type ItemPatch,
  type ItemScope,
  type Provenance,
  type PublisherQuotas,
  type StreamPatch,
  type WireMessage,
} from '@aibar/protocol';
import { itemFromSpec, type AIBarItem } from './items';
import type { AIBarKernel } from './kernel';
import { structuredClone } from './timers';

export interface PublisherSession {
  publisherId: string;
  provenance: Provenance;
  quotas: PublisherQuotas;
}

interface PublisherState {
  session: PublisherSession;
  /** sliding 1s window of message timestamps (rate quota) */
  recentMessages: number[];
  openStreams: Set<AIBarItemIdentifier>;
  scopes: Map<AIBarItemIdentifier, ItemScope | undefined>;
}

export type IngressReply =
  | { kind: 'ack'; ids: AIBarItemIdentifier[] }
  | { kind: 'welcome'; message: Extract<WireMessage, { kind: 'welcome' }> }
  | { kind: 'error'; code: 'quota' | 'validation' | 'unsupported' | 'forbidden' | 'unknown-item'; detail: string; id?: AIBarItemIdentifier };

export class WireIngress {
  private publishers = new Map<string, PublisherState>();

  constructor(
    private kernel: AIBarKernel,
    private now: () => number = () => Date.now(),
  ) {}

  register(session: Partial<PublisherSession> & { publisherId: string; provenance: Provenance }): void {
    if (!this.publishers.has(session.publisherId)) {
      this.publishers.set(session.publisherId, {
        session: { quotas: DEFAULT_QUOTAS, ...session },
        recentMessages: [],
        openStreams: new Set(),
        scopes: new Map(),
      });
    }
  }

  handle(message: WireMessage): IngressReply {
    const publisherId = 'publisherId' in message ? message.publisherId : undefined;
    if (!publisherId) return { kind: 'error', code: 'unsupported', detail: 'message lacks publisherId' };
    const state = this.publishers.get(publisherId);
    if (!state) return { kind: 'error', code: 'forbidden', detail: `unknown publisher '${publisherId}'` };

    const rateError = this.checkRate(state);
    if (rateError) return rateError;

    switch (message.kind) {
      case 'hello':
        return this.hello(state, message.version);
      case 'publish':
        return this.publish(state, message.items);
      case 'update':
        return this.update(state, message.id, message.patch);
      case 'stream.open':
        return this.streamOpen(state, message.id);
      case 'stream.delta':
        return this.streamDelta(state, message.id, message.patch);
      case 'stream.close':
        return this.streamClose(state, message.id);
      case 'revoke':
        return this.revoke(state, message.ids);
      case 'renew':
        return this.renew(state, message.ids);
      default:
        return { kind: 'error', code: 'unsupported', detail: `unsupported message '${message.kind}'` };
    }
  }

  /** Revoke every item a publisher attached to a given run/session scope. */
  revokeScope(scope: ItemScope): AIBarItemIdentifier[] {
    const removed: AIBarItemIdentifier[] = [];
    for (const state of this.publishers.values()) {
      for (const [id, itemScope] of state.scopes) {
        if (!itemScope) continue;
        const match =
          (scope.kind === 'run' && itemScope.kind === 'run' && itemScope.runId === scope.runId) ||
          (scope.kind === 'session' &&
            itemScope.kind === 'session' &&
            itemScope.sessionId === scope.sessionId);
        if (match) {
          this.kernel.removeItem(id, 'scope-revoked');
          state.scopes.delete(id);
          state.openStreams.delete(id);
          removed.push(id);
        }
      }
    }
    return removed;
  }

  /** Remove everything a publisher owns (disconnect / turn teardown). */
  revokeAll(publisherId: string): AIBarItemIdentifier[] {
    const state = this.publishers.get(publisherId);
    if (!state) return [];
    const ids = [...state.scopes.keys()];
    for (const id of ids) this.kernel.removeItem(id, 'publisher-revoked');
    state.scopes.clear();
    state.openStreams.clear();
    return ids;
  }

  /**
   * Capability negotiation (§9.2). The publisher's identity and trust tier
   * were already injected by the host via `register()`; `hello` only
   * negotiates the protocol version and returns the effective capabilities.
   */
  private hello(state: PublisherState, version: string): IngressReply {
    const [family] = PROTOCOL_VERSION.split('/');
    if (!version.startsWith(`${family}/`)) {
      return { kind: 'error', code: 'unsupported', detail: `unsupported protocol '${version}'` };
    }
    return {
      kind: 'welcome',
      message: {
        kind: 'welcome',
        version: PROTOCOL_VERSION,
        capabilities: {
          itemTypes: [...AIBAR_ITEM_TYPES],
          actions: [...(this.kernel.adapter.actionAllowlist?.() ?? [])],
        },
        grantedScopes: ['global', 'route', 'session', 'run'],
        quotas: state.session.quotas,
        suggestionPolicy: {
          ...DEFAULT_SUGGESTION_POLICY,
          ...this.kernel.definition.suggestionPolicy,
        },
      },
    };
  }

  private checkRate(state: PublisherState): IngressReply | null {
    const now = this.now();
    state.recentMessages = state.recentMessages.filter((t) => now - t < 1000);
    if (state.recentMessages.length >= state.session.quotas.maxMessagesPerSecond) {
      return { kind: 'error', code: 'quota', detail: 'message rate limit exceeded' };
    }
    state.recentMessages.push(now);
    return null;
  }

  private publish(state: PublisherState, items: AIBarItemSpec[]): IngressReply {
    const { quotas } = state.session;
    const existingCount = this.kernel.registry.countByOwner(state.session.publisherId);
    // Re-publishing an owned id replaces it, so only genuinely new ids count.
    const newCount = items.filter(
      (spec) => !state.scopes.has(spec?.id as AIBarItemIdentifier),
    ).length;
    const result = validatePublishBatch(items, {
      quotas,
      existingCount: existingCount - (items.length - newCount),
    });
    if (!result.ok) {
      return { kind: 'error', code: 'validation', detail: result.errors.join('; ') };
    }

    const ids: AIBarItemIdentifier[] = [];
    for (const spec of items) {
      const withTtl: AIBarItemSpec = { ...spec, ttlMs: spec.ttlMs ?? DEFAULT_TTL_MS };
      let item: AIBarItem;
      try {
        item = itemFromSpec(withTtl, state.session.provenance, this.now);
      } catch (e) {
        return {
          kind: 'error',
          code: 'validation',
          detail: e instanceof Error ? e.message : String(e),
        };
      }
      try {
        this.kernel.upsertWireItem(item, state.session.publisherId);
      } catch (e) {
        return {
          kind: 'error',
          code: 'forbidden',
          detail: e instanceof Error ? e.message : String(e),
          id: item.id,
        };
      }
      state.scopes.set(item.id, spec.scope);
      if (item.type === 'approval') this.kernel.noteApprovalRequested(item.id);
      ids.push(item.id);
    }
    return { kind: 'ack', ids };
  }

  private owned(state: PublisherState, id: AIBarItemIdentifier): IngressReply | null {
    if (this.kernel.registry.ownerOf(id) !== state.session.publisherId) {
      return { kind: 'error', code: 'unknown-item', detail: `item not owned: ${id}`, id };
    }
    return null;
  }

  private update(state: PublisherState, id: AIBarItemIdentifier, patch: ItemPatch): IngressReply {
    const notOwned = this.owned(state, id);
    if (notOwned) return notOwned;
    const current = this.kernel.registry.get(id)!;
    const spec: AIBarItemSpec = {
      id,
      type: current.type,
      labelKey: patch.labelKey ?? current.labelKey,
      parity: patch.parity ?? current.parity,
      ...structuredClone({ ...patch }),
    } as AIBarItemSpec;
    const result = validatePublishBatch([spec], { quotas: state.session.quotas, existingCount: 0 });
    if (!result.ok) {
      return { kind: 'error', code: 'validation', detail: result.errors.join('; '), id };
    }
    const next = itemFromSpec(spec, state.session.provenance, this.now);
    // preserve fields the patch didn't touch
    const merged: AIBarItem = { ...current };
    for (const key of Object.keys(patch) as (keyof ItemPatch)[]) {
      (merged as unknown as Record<string, unknown>)[key] =
        (next as unknown as Record<string, unknown>)[key];
    }
    this.kernel.upsertWireItem(merged, state.session.publisherId);
    return { kind: 'ack', ids: [id] };
  }

  private streamOpen(state: PublisherState, id: AIBarItemIdentifier): IngressReply {
    const notOwned = this.owned(state, id);
    if (notOwned) return notOwned;
    if (state.openStreams.size >= state.session.quotas.maxConcurrentStreams) {
      return { kind: 'error', code: 'quota', detail: 'too many concurrent streams', id };
    }
    state.openStreams.add(id);
    this.kernel.setStreaming(id, true);
    return { kind: 'ack', ids: [id] };
  }

  private streamDelta(state: PublisherState, id: AIBarItemIdentifier, patch: StreamPatch): IngressReply {
    const notOwned = this.owned(state, id);
    if (notOwned) return notOwned;
    if (!state.openStreams.has(id)) {
      return { kind: 'error', code: 'forbidden', detail: 'no open stream for item', id };
    }
    const illegal = Object.keys(patch).filter(
      (k) => !(STREAMABLE_FIELDS as readonly string[]).includes(k),
    );
    if (illegal.length > 0) {
      return {
        kind: 'error',
        code: 'forbidden',
        detail: `non-streamable fields: ${illegal.join(', ')}`,
        id,
      };
    }
    const current = this.kernel.registry.get(id)!;
    const merged: AIBarItem = { ...current };
    if (patch.labelKey !== undefined) merged.labelKey = patch.labelKey;
    if (patch.progress !== undefined) merged.progress = patch.progress;
    if (patch.confidence !== undefined) merged.confidence = patch.confidence;
    if (patch.reason !== undefined) merged.reason = patch.reason;
    this.kernel.upsertWireItem(merged, state.session.publisherId);
    return { kind: 'ack', ids: [id] };
  }

  private streamClose(state: PublisherState, id: AIBarItemIdentifier): IngressReply {
    state.openStreams.delete(id);
    if (this.kernel.registry.get(id)) this.kernel.setStreaming(id, false);
    return { kind: 'ack', ids: [id] };
  }

  private revoke(state: PublisherState, ids: AIBarItemIdentifier[]): IngressReply {
    for (const id of ids) {
      if (this.kernel.registry.ownerOf(id) === state.session.publisherId) {
        this.kernel.removeItem(id, 'revoked');
        state.scopes.delete(id);
        state.openStreams.delete(id);
      }
    }
    return { kind: 'ack', ids };
  }

  private renew(state: PublisherState, ids: AIBarItemIdentifier[]): IngressReply {
    for (const id of ids) {
      const item = this.kernel.registry.get(id);
      if (item && this.kernel.registry.ownerOf(id) === state.session.publisherId) {
        this.kernel.upsertWireItem(
          { ...item, expiresAt: this.now() + DEFAULT_TTL_MS },
          state.session.publisherId,
        );
      }
    }
    return { kind: 'ack', ids };
  }
}
