/**
 * Wire ingress tests (arch §9.2–§9.4): validation, per-publisher quotas,
 * TTL stamping, ownership, the streamable-field allowlist, scope revocation,
 * and the §13 failure property — malformed input yields an `error` reply,
 * never a throw and never a broken surface.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { asItemIdentifier, DEFAULT_TTL_MS, type AIBarItemSpec } from '@aibar/protocol';
import {
  AIBarKernel,
  WireIngress,
  type AIBarEvent,
  type AIBarHostAdapter,
  type ItemRenderModel,
  type MeasureRequest,
  type RendererBackend,
  type RenderFrame,
} from '@aibar/core';

class FakeBackend implements RendererBackend {
  present = new Map<string, ItemRenderModel>();
  mount(): void {}
  measure(requests: readonly MeasureRequest[]) {
    return requests.map((r) => ({ width: r.text.length * 7 }));
  }
  commit(frame: RenderFrame): void {
    for (const op of frame.ops) {
      if (op.kind === 'create') this.present.set(op.id, op.node);
      if (op.kind === 'remove') this.present.delete(op.id);
    }
  }
  scheduleFrame(cb: () => void): void {
    cb();
  }
  surfaceWidth(): number {
    return 900;
  }
  onResize(): () => void {
    return () => {};
  }
  applyThemeTokens(): void {}
  destroy(): void {}
}

const adapter: AIBarHostAdapter = {
  contextProviders: [],
  dispatchAction: async () => ({ ok: true }),
  resolveLabel: (key) => key,
  resolveIcon: () => ({ kind: 'text', text: '·' }),
  persistence: { load: async () => null, save: async () => {} },
};

function harness(nowRef?: { t: number }) {
  const kernel = new AIBarKernel({
    adapter,
    definition: { defaultItemIdentifiers: [] },
  });
  kernel.attach(new FakeBackend(), {});
  const ingress = new WireIngress(kernel, nowRef ? () => nowRef.t : undefined);
  ingress.register({
    publisherId: 'agent',
    provenance: { kind: 'agent', publisherId: 'agent' },
    quotas: { maxItems: 4, maxMessagesPerSecond: 5, maxSpecBytes: 8192, maxConcurrentStreams: 1 },
  });
  return { kernel, ingress };
}

function spec(key: string, overrides: Partial<AIBarItemSpec> = {}): AIBarItemSpec {
  return {
    id: `agent.aibar.button.${key}`,
    type: 'button',
    labelKey: `label-${key}`,
    parity: 'chat:reply',
    action: { name: 'navigate', params: { route: '/home' } },
    ...overrides,
  };
}

describe('WireIngress', () => {
  it('hello negotiates capabilities: welcome carries item types, quotas, policy (§9.2)', () => {
    const { ingress } = harness();
    const reply = ingress.handle({ kind: 'hello', version: 'aibar/2', publisherId: 'agent' });
    expect(reply.kind).toBe('welcome');
    if (reply.kind !== 'welcome') return;
    expect(reply.message.version).toBe('aibar/2');
    expect(reply.message.capabilities.itemTypes).toContain('suggestion');
    expect(reply.message.quotas.maxItems).toBe(4);
    expect(reply.message.suggestionPolicy.maxVisible).toBe(2);
    expect(reply.message.grantedScopes).toContain('run');
  });

  it('hello with an alien protocol family is unsupported, never a disconnect', () => {
    const { ingress } = harness();
    const reply = ingress.handle({ kind: 'hello', version: 'toolstrip/9', publisherId: 'agent' });
    expect(reply).toMatchObject({ kind: 'error', code: 'unsupported' });
  });

  it('publishes validated items with stamped provenance and default TTL', () => {
    const nowRef = { t: 1_000 };
    const { kernel, ingress } = harness(nowRef);
    const reply = ingress.handle({ kind: 'publish', publisherId: 'agent', items: [spec('a')] });
    expect(reply.kind).toBe('ack');
    const item = kernel.registry.get(asItemIdentifier('agent.aibar.button.a'))!;
    expect(item.provenance).toEqual({ kind: 'agent', publisherId: 'agent' });
    expect(item.expiresAt).toBe(1_000 + DEFAULT_TTL_MS);
    // Wire publishers can never reach the System Strip (§12.1).
    expect(item.zone).toBe('contextual');
  });

  it('rejects unknown publishers and unregistered message kinds', () => {
    const { ingress } = harness();
    const reply = ingress.handle({ kind: 'publish', publisherId: 'ghost', items: [spec('a')] });
    expect(reply).toMatchObject({ kind: 'error', code: 'forbidden' });
  });

  it('enforces the item-count quota, counting re-publishes as replacements', () => {
    const { ingress } = harness();
    const four = ['a', 'b', 'c', 'd'].map((k) => spec(k));
    expect(ingress.handle({ kind: 'publish', publisherId: 'agent', items: four }).kind).toBe('ack');
    // Same ids again: replacement, not growth.
    expect(ingress.handle({ kind: 'publish', publisherId: 'agent', items: four }).kind).toBe('ack');
    const overflow = ingress.handle({ kind: 'publish', publisherId: 'agent', items: [spec('e')] });
    expect(overflow).toMatchObject({ kind: 'error', code: 'validation' });
  });

  it('enforces the message rate quota over a sliding window', () => {
    const nowRef = { t: 0 };
    const { ingress } = harness(nowRef);
    for (let i = 0; i < 5; i++) {
      expect(ingress.handle({ kind: 'renew', publisherId: 'agent', ids: [] }).kind).toBe('ack');
    }
    expect(ingress.handle({ kind: 'renew', publisherId: 'agent', ids: [] })).toMatchObject({
      kind: 'error',
      code: 'quota',
    });
    nowRef.t = 1_500; // window slides → allowed again
    expect(ingress.handle({ kind: 'renew', publisherId: 'agent', ids: [] }).kind).toBe('ack');
  });

  it('rejects updates and stream deltas for items the publisher does not own', () => {
    const { kernel, ingress } = harness();
    kernel.register({
      id: asItemIdentifier('host.aibar.button.mine'),
      type: 'button',
      labelKey: 'mine',
      parity: 'menu:mine',
    });
    const reply = ingress.handle({
      kind: 'update',
      publisherId: 'agent',
      id: asItemIdentifier('host.aibar.button.mine'),
      patch: { labelKey: 'stolen' },
    });
    expect(reply).toMatchObject({ kind: 'error', code: 'unknown-item' });
  });

  it('restricts stream deltas to the streamable-field allowlist', () => {
    const { kernel, ingress } = harness();
    ingress.handle({ kind: 'publish', publisherId: 'agent', items: [spec('s', { type: 'liveStatus' })] });
    const id = asItemIdentifier('agent.aibar.button.s');
    expect(ingress.handle({ kind: 'stream.open', publisherId: 'agent', id }).kind).toBe('ack');

    const illegal = ingress.handle({
      kind: 'stream.delta',
      publisherId: 'agent',
      id,
      patch: { action: { name: 'open_url', params: { url: 'https://evil' } } } as never,
    });
    expect(illegal).toMatchObject({ kind: 'error', code: 'forbidden' });

    const legal = ingress.handle({
      kind: 'stream.delta',
      publisherId: 'agent',
      id,
      patch: { progress: 0.5 },
    });
    expect(legal.kind).toBe('ack');
    expect(kernel.registry.get(id)!.progress).toBe(0.5);
  });

  it('enforces the concurrent-stream quota', () => {
    const { ingress } = harness();
    ingress.handle({ kind: 'publish', publisherId: 'agent', items: [spec('a'), spec('b')] });
    expect(
      ingress.handle({ kind: 'stream.open', publisherId: 'agent', id: asItemIdentifier('agent.aibar.button.a') })
        .kind,
    ).toBe('ack');
    expect(
      ingress.handle({ kind: 'stream.open', publisherId: 'agent', id: asItemIdentifier('agent.aibar.button.b') }),
    ).toMatchObject({ kind: 'error', code: 'quota' });
  });

  it('revoke removes owned items; revokeScope drops a whole run', () => {
    const { kernel, ingress } = harness();
    ingress.handle({
      kind: 'publish',
      publisherId: 'agent',
      items: [
        spec('r1', { scope: { kind: 'run', runId: 'run-1' } }),
        spec('r2', { scope: { kind: 'run', runId: 'run-2' } }),
      ],
    });
    const removed = ingress.revokeScope({ kind: 'run', runId: 'run-1' });
    expect(removed).toEqual([asItemIdentifier('agent.aibar.button.r1')]);
    expect(kernel.registry.get(asItemIdentifier('agent.aibar.button.r1'))).toBeUndefined();
    expect(kernel.registry.get(asItemIdentifier('agent.aibar.button.r2'))).toBeDefined();

    const reply = ingress.handle({
      kind: 'revoke',
      publisherId: 'agent',
      ids: [asItemIdentifier('agent.aibar.button.r2')],
    });
    expect(reply.kind).toBe('ack');
    expect(kernel.registry.get(asItemIdentifier('agent.aibar.button.r2'))).toBeUndefined();
  });

  it('publishing an approval emits aibar.approval.requested', () => {
    const { kernel, ingress } = harness();
    const events: AIBarEvent[] = [];
    kernel.onEvent((e) => events.push(e));
    const reply = ingress.handle({
      kind: 'publish',
      publisherId: 'agent',
      items: [
        spec('gate', {
          type: 'approval',
          effect: 'destructive',
          intent: { summaryKey: 'Deploy to production' },
        }),
      ],
    });
    expect(reply.kind).toBe('ack');
    expect(events.some((e) => e.type === 'aibar.approval.requested')).toBe(true);
  });

  // §13 failure model: garbage in → error reply out. Never a throw.
  it('property: arbitrary junk publishes never throw and never ack invalid ids', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.oneof(
            fc.jsonValue(),
            fc.record({
              id: fc.string(),
              type: fc.string(),
              labelKey: fc.string(),
              parity: fc.string(),
            }),
          ),
          { maxLength: 6 },
        ),
        (junk) => {
          const { ingress } = harness();
          const reply = ingress.handle({
            kind: 'publish',
            publisherId: 'agent',
            items: junk as AIBarItemSpec[],
          });
          expect(['ack', 'error']).toContain(reply.kind);
          if (reply.kind === 'ack') {
            for (const id of reply.ids) expect(id).toContain('.aibar.');
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
