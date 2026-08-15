/**
 * @aibar/intent heuristic engine tests (arch §6.2, B.5) + kernel prediction
 * loop integration (background scheduling, stale discard, lane quotas).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeuristicIntentEngine, contextKeyOf } from '@aibar/intent';
import type { ObservedInvocation } from '@aibar/intent';

const CTX = contextKeyOf('/home', 'chat');

function makeEngine(nowRef: { t: number }) {
  return new HeuristicIntentEngine({ now: () => nowRef.t });
}

function inv(key: string, overrides: Partial<ObservedInvocation> = {}): ObservedInvocation {
  return {
    key,
    labelKey: `label-${key}`,
    action: { name: 'navigate', params: { route: `/x/${key}` } },
    effect: 'read',
    contextKey: CTX,
    ...overrides,
  };
}

describe('HeuristicIntentEngine', () => {
  it('repeated use in a context surfaces the action with growing confidence', async () => {
    const nowRef = { t: 0 };
    const engine = makeEngine(nowRef);
    for (let i = 0; i < 5; i++) {
      nowRef.t += 1000;
      engine.observe(inv('host.aibar.button.export'));
    }
    const out = await engine.predict({ contextRevision: 1, route: '/home', mode: 'chat', recentActions: [] });
    expect(out.length).toBe(1);
    expect(out[0]!.id).toBe('intent.aibar.suggestion.host-aibar-button-export');
    expect(out[0]!.confidence).toBeGreaterThan(0.35);
    expect(out[0]!.reason.code).toBe('repeat_in_context');
    expect(out[0]!.action).toEqual({ name: 'navigate', params: { route: '/x/host.aibar.button.export' } });
  });

  it('learns action sequences: after A, B is suggested via n-gram', async () => {
    const nowRef = { t: 0 };
    const engine = makeEngine(nowRef);
    // A → B three times, then A again: B should be the sequence follow-up.
    for (let i = 0; i < 3; i++) {
      nowRef.t += 1000;
      engine.observe(inv('a'));
      nowRef.t += 1000;
      engine.observe(inv('b'));
    }
    nowRef.t += 1000;
    engine.observe(inv('a'));
    const out = await engine.predict({ contextRevision: 1, route: '/home', mode: 'chat', recentActions: [] });
    const b = out.find((c) => c.id.endsWith('.b'));
    expect(b).toBeDefined();
    expect(b!.reason.code).toBe('follows_previous');
  });

  it('context isolation: usage in another context does not leak', async () => {
    const nowRef = { t: 1000 };
    const engine = makeEngine(nowRef);
    engine.observe(inv('x', { contextKey: contextKeyOf('/flows', 'editor') }));
    const out = await engine.predict({ contextRevision: 1, route: '/home', mode: 'chat', recentActions: [] });
    expect(out).toEqual([]);
  });

  it('dismissal halves confidence multiplicatively; acceptance recovers it', async () => {
    const nowRef = { t: 0 };
    const engine = makeEngine(nowRef);
    for (let i = 0; i < 6; i++) {
      nowRef.t += 1000;
      engine.observe(inv('k'));
    }
    const signal = { contextRevision: 1, route: '/home', mode: 'chat', recentActions: [] };
    const before = (await engine.predict(signal))[0]!.confidence;
    engine.noteCandidateDismissed('intent.aibar.suggestion.k');
    const after = (await engine.predict(signal))[0]?.confidence ?? 0;
    expect(after).toBeLessThanOrEqual(before * 0.5 + 1e-9);
    engine.noteCandidateAccepted('intent.aibar.suggestion.k');
    const recovered = (await engine.predict(signal))[0]?.confidence ?? 0;
    expect(recovered).toBeGreaterThan(after);
  });

  it('never suggests destructive actions (INV-A8) or muted action names', async () => {
    const nowRef = { t: 0 };
    const engine = makeEngine(nowRef);
    for (let i = 0; i < 5; i++) {
      nowRef.t += 1000;
      engine.observe(inv('boom', { effect: 'destructive' }));
      engine.observe(inv('quiet', { action: { name: 'send_message' } }));
      engine.observe(inv('ok', { action: { name: 'navigate' } }));
    }
    engine.setMutedActions(['send_message']);
    const out = await engine.predict({ contextRevision: 1, route: '/home', mode: 'chat', recentActions: [] });
    const ids = out.map((c) => c.id);
    expect(ids.some((id) => id.endsWith('.boom'))).toBe(false);
    expect(ids.some((id) => id.endsWith('.quiet'))).toBe(false);
    expect(ids.some((id) => id.endsWith('.ok'))).toBe(true);
  });

  it('export/import roundtrip preserves learned state', async () => {
    const nowRef = { t: 0 };
    const engine = makeEngine(nowRef);
    for (let i = 0; i < 4; i++) {
      nowRef.t += 1000;
      engine.observe(inv('persisted'));
    }
    const restored = makeEngine(nowRef);
    restored.import(JSON.parse(JSON.stringify(engine.export())));
    const out = await restored.predict({ contextRevision: 1, route: '/home', mode: 'chat', recentActions: [] });
    expect(out[0]?.id).toBe('intent.aibar.suggestion.persisted');
  });
});

// ---------------------------------------------------------------------------
// Kernel prediction loop
// ---------------------------------------------------------------------------

import { asItemIdentifier } from '@aibar/protocol';
import {
  AIBarKernel,
  type AIBarHostAdapter,
  type ItemRenderModel,
  type MeasureRequest,
  type RendererBackend,
  type RenderFrame,
  type SuggestionCandidate,
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

function candidate(key: string, confidence = 0.8): SuggestionCandidate {
  return {
    id: `intent.aibar.suggestion.${key}`,
    labelKey: `label-${key}`,
    action: { name: 'navigate', params: { route: `/s/${key}` } },
    confidence,
    reason: { code: 'repeat_in_context' },
    effect: 'read',
  };
}

describe('kernel intent loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function kernelWith(predict: (n: number) => SuggestionCandidate[]) {
    let calls = 0;
    const adapter: AIBarHostAdapter = {
      contextProviders: [],
      dispatchAction: async () => ({ ok: true }),
      resolveLabel: (key) => key,
      resolveIcon: () => ({ kind: 'text', text: '·' }),
      persistence: { load: async () => null, save: async () => {} },
      intent: { predict: async () => predict(++calls) },
    };
    const kernel = new AIBarKernel({ adapter, definition: { defaultItemIdentifiers: [] } });
    kernel.attach(new FakeBackend(), {});
    return kernel;
  }

  it('background prediction lands in the registry as intent-owned suggestions', async () => {
    const kernel = kernelWith(() => [candidate('next')]);
    kernel.setSuggestionPolicy({ maxVisible: 2 });
    await vi.advanceTimersByTimeAsync(6000);
    const id = asItemIdentifier('intent.aibar.suggestion.next');
    const item = kernel.registry.get(id);
    expect(item?.type).toBe('suggestion');
    expect(kernel.registry.ownerOf(id)).toBe('aibar.intent');
    kernel.destroy();
  });

  it('slots=0 disables prediction entirely and clears the lane', async () => {
    const kernel = kernelWith(() => [candidate('never')]);
    kernel.setSuggestionPolicy({ maxVisible: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(kernel.registry.get(asItemIdentifier('intent.aibar.suggestion.never'))).toBeUndefined();
    kernel.destroy();
  });

  it('below-threshold and destructive candidates are filtered at the gate', async () => {
    const kernel = kernelWith(() => [
      candidate('weak', 0.1),
      { ...candidate('danger'), effect: 'destructive' as const },
      candidate('good', 0.9),
    ]);
    kernel.setSuggestionPolicy({ maxVisible: 2 });
    await vi.advanceTimersByTimeAsync(6000);
    expect(kernel.registry.get(asItemIdentifier('intent.aibar.suggestion.weak'))).toBeUndefined();
    expect(kernel.registry.get(asItemIdentifier('intent.aibar.suggestion.danger'))).toBeUndefined();
    expect(kernel.registry.get(asItemIdentifier('intent.aibar.suggestion.good'))).toBeDefined();
    kernel.destroy();
  });

  it('suggestions duplicating a deterministic action are deduped (§6.1 ⑷)', async () => {
    const kernel = kernelWith(() => [candidate('dup')]);
    kernel.register({
      id: asItemIdentifier('host.aibar.button.same'),
      type: 'button',
      labelKey: 'same',
      parity: 'menu:same',
      action: { name: 'navigate', params: { route: '/s/dup' } },
    });
    kernel.setSuggestionPolicy({ maxVisible: 2 });
    await vi.advanceTimersByTimeAsync(6000);
    expect(kernel.registry.get(asItemIdentifier('intent.aibar.suggestion.dup'))).toBeUndefined();
    kernel.destroy();
  });
});
