/**
 * Shared playground host: send / stop / clear / insert, plus live-status context.
 * React and vanilla mounts differ only in how they paint the thread.
 */
import type {
  ActionInvocation,
  ActionOutcome,
  ContextProvider,
  EffectConfirmation,
} from '@aibar/core';
import type { DemoSnap } from './catalog';

export interface DemoHostUi {
  getDraft(): string;
  setDraft(value: string): void;
  setBusy(busy: boolean): void;
  addUser(text: string): void;
  addAssistant(text: string): void;
  clear(): void;
}

export function createDemoHost(opts: { snap: DemoSnap; ui: DemoHostUi }): {
  bump: () => void;
  dispatchAction: (inv: ActionInvocation) => Promise<ActionOutcome>;
  confirmEffect: (req: EffectConfirmation) => Promise<'allow' | 'deny'>;
  contextProviders: ContextProvider[];
} {
  const { snap, ui } = opts;
  const invalidators = new Set<() => void>();
  const bump = () => {
    for (const fn of invalidators) fn();
  };

  return {
    bump,
    dispatchAction: async (inv) => {
      if (inv.name === 'app.send') {
        if (snap.busy) {
          snap.busy = false;
          snap.progress = 0;
          ui.setBusy(false);
          bump();
          return { ok: true };
        }
        const text = ui.getDraft().trim();
        if (!text) return { ok: true };
        ui.setDraft('');
        ui.addUser(text);
        snap.busy = true;
        snap.phase = 'thinking';
        snap.progress = 0.2;
        ui.setBusy(true);
        bump();
        window.setTimeout(() => {
          snap.phase = 'answering';
          snap.progress = 0.75;
          bump();
        }, 450);
        window.setTimeout(() => {
          const { thinking } = snap;
          snap.busy = false;
          snap.progress = 0;
          ui.setBusy(false);
          bump();
          ui.addAssistant(`Echo (thinking ${thinking}): ${text}`);
        }, 1000);
        return { ok: true };
      }
      if (inv.name === 'app.clear') {
        ui.clear();
        return { ok: true };
      }
      if (inv.name === 'app.attach') {
        const current = ui.getDraft();
        ui.setDraft(current ? `${current} [file]` : '[file]');
        return { ok: true };
      }
      if (inv.name === 'app.insert') {
        ui.setDraft(`${ui.getDraft()}${String(inv.params.token ?? '')}`);
        return { ok: true };
      }
      return { ok: true };
    },
    confirmEffect: async (req) =>
      window.confirm(`${req.summary}\n\nAllow this destructive action?`)
        ? 'allow'
        : 'deny',
    contextProviders: [
      {
        id: 'demo',
        collect: () => ({
          route: '/',
          mode: snap.busy ? 'live' : 'editing',
          runs: snap.busy
            ? [
                {
                  runId: 'demo',
                  kind: 'agent_turn',
                  label: snap.phase === 'thinking' ? 'Thinking' : 'Answering',
                  phase: snap.phase,
                  progress: snap.progress,
                  status: 'running' as const,
                },
              ]
            : [],
        }),
        subscribe: (onInvalidate: () => void) => {
          invalidators.add(onInvalidate);
          return () => {
            invalidators.delete(onInvalidate);
          };
        },
      },
    ],
  };
}
