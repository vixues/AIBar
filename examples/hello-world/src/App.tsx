import { useEffect, useMemo, useRef, useState } from 'react';
import { AIBarSurface, createAIBarKernel } from '@aibar/react';
import {
  asItemIdentifier,
  createDefaultHostAdapter,
  defineItem,
  type AIBarItem,
} from '@aibar/core';
import '@aibar/renderer-dom/styles.css';
import './demo.css';

const ids = {
  attach: asItemIdentifier('com.example.aibar.button.attach'),
  model: asItemIdentifier('com.example.aibar.segmented.model'),
  temp: asItemIdentifier('com.example.aibar.slider.temperature'),
  live: asItemIdentifier('com.example.aibar.livestatus.run'),
  send: asItemIdentifier('com.example.aibar.mainbutton.send'),
  clear: asItemIdentifier('com.example.aibar.button.clear'),
  help: asItemIdentifier('com.example.aibar.button.help'),
  copy: asItemIdentifier('com.example.aibar.button.copy'),
};

const TOKENS = {
  '--aibar-surface-bg': 'hsl(240 6% 10%)',
  '--aibar-surface-border': 'hsl(240 5% 22%)',
  '--aibar-item-bg': 'hsl(240 5% 16%)',
  '--aibar-item-fg': 'hsl(240 8% 92%)',
  '--aibar-accent': 'hsl(212 92% 60%)',
} as const;

type Phase = 'thinking' | 'answering';

type DemoSnap = {
  model: 'flash' | 'pro';
  temperature: number;
  busy: boolean;
  phase: Phase;
  progress: number;
};

type ChatMsg = { role: 'user' | 'assistant'; text: string };

export function App() {
  const [messages, setMessages] = useState<ChatMsg[]>([
    {
      role: 'assistant',
      text: 'Click Send, change Flash/Pro, drag temperature, or shrink the window until items overflow.',
    },
  ]);
  const [draft, setDraft] = useState('Hello from a third-party host');
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const snap = useRef<DemoSnap>({
    model: 'flash',
    temperature: 0.7,
    busy: false,
    phase: 'thinking',
    progress: 0,
  });
  const invalidators = useRef(new Set<() => void>());
  const bump = () => {
    for (const fn of invalidators.current) fn();
  };

  const kernel = useMemo(() => {
    let tempItem: AIBarItem;
    const adapter = createDefaultHostAdapter({
      dispatchAction: async (inv) => {
        if (inv.name === 'app.send') {
          const text = draftRef.current.trim() || '…';
          setDraft('');
          draftRef.current = '';
          setMessages((prev) => [...prev, { role: 'user', text }]);
          snap.current = { ...snap.current, busy: true, phase: 'thinking', progress: 0.2 };
          setBusy(true);
          bump();
          window.setTimeout(() => {
            snap.current = { ...snap.current, phase: 'answering', progress: 0.75 };
            bump();
          }, 500);
          window.setTimeout(() => {
            const { model, temperature } = snap.current;
            snap.current = { ...snap.current, busy: false, progress: 0 };
            setBusy(false);
            bump();
            setMessages((prev) => [
              ...prev,
              {
                role: 'assistant',
                text: `Reply (${model}, t=${temperature.toFixed(1)}): ${text}`,
              },
            ]);
          }, 1100);
          return { ok: true };
        }
        if (inv.name === 'app.clear') {
          setMessages([]);
          return { ok: true };
        }
        return { ok: true };
      },
      confirmEffect: async (req) =>
        window.confirm(`${req.summary}\n\nAllow this destructive action?`) ? 'allow' : 'deny',
      contextProviders: [
        {
          id: 'demo',
          collect: () => {
            const s = snap.current;
            return {
              route: '/',
              mode: s.busy ? 'live' : 'editing',
              runs: s.busy
                ? [
                    {
                      runId: 'demo',
                      kind: 'agent_turn',
                      label: s.phase === 'thinking' ? 'Thinking' : 'Answering',
                      phase: s.phase,
                      progress: s.progress,
                      status: 'running' as const,
                    },
                  ]
                : [],
            };
          },
          subscribe: (onInvalidate: () => void) => {
            invalidators.current.add(onInvalidate);
            return () => {
              invalidators.current.delete(onInvalidate);
            };
          },
        },
      ],
      theme: {
        tokens: () => TOKENS,
        subscribe: () => () => {},
      },
    });

    tempItem = defineItem({
      id: ids.temp,
      type: 'slider',
      labelKey: 'Temperature',
      icon: '✦',
      parity: 'none:demo-temp',
      slider: { min: 0, max: 1, value: 0.7, step: 0.1 },
      onSliderChange: (_ctx, value) => {
        snap.current.temperature = value;
        tempItem.slider = { min: 0, max: 1, value, step: 0.1 };
        bump();
      },
    });

    const k = createAIBarKernel({
      adapter,
      density: 'regular',
      definition: {
        customizationIdentifier: 'com.example.aibar.main',
        defaultItemIdentifiers: [
          ids.attach,
          ids.model,
          ids.temp,
          ids.live,
          ids.send,
          ids.clear,
          ids.help,
          ids.copy,
        ],
        principalItemIdentifier: ids.send,
        overflowAction: { name: 'host.openCommandPalette' },
      },
    });

    k.register(
      defineItem({
        id: ids.attach,
        type: 'button',
        labelKey: 'Attach',
        icon: 'attach',
        showsLabel: true,
        parity: 'none:demo-attach',
        action: { name: 'app.attach' },
      }),
    );
    k.register(
      defineItem({
        id: ids.model,
        type: 'segmented',
        labelKey: 'Model',
        parity: 'none:demo-model',
        segments: [
          { key: 'flash', labelKey: 'Flash' },
          { key: 'pro', labelKey: 'Pro' },
        ],
        selectedSegment: () => snap.current.model,
        onSelectSegment: (_ctx, key) => {
          snap.current.model = key === 'pro' ? 'pro' : 'flash';
          bump();
        },
      }),
    );
    k.register(tempItem);
    k.register(
      defineItem({
        id: ids.live,
        type: 'liveStatus',
        labelKey: 'Idle',
        icon: 'sparkles',
        parity: 'none:demo-live',
        zone: 'system',
        text: (ctx) => ctx.runs?.[0]?.label ?? 'Idle',
      }),
    );
    k.register(
      defineItem({
        id: ids.send,
        type: 'mainButton',
        labelKey: 'Send',
        icon: 'send',
        showsLabel: true,
        parity: 'shortcut:app.send',
        enabled: () => !snap.current.busy,
        action: { name: 'app.send' },
      }),
    );
    k.register(
      defineItem({
        id: ids.clear,
        type: 'button',
        labelKey: 'Clear',
        icon: 'trash',
        showsLabel: true,
        parity: 'none:demo-clear',
        effect: 'destructive',
        action: { name: 'app.clear' },
        visibilityPriority: -200,
      }),
    );
    k.register(
      defineItem({
        id: ids.help,
        type: 'button',
        labelKey: 'Help',
        icon: '?',
        showsLabel: true,
        parity: 'none:demo-help',
        action: { name: 'app.help' },
        visibilityPriority: -400,
      }),
    );
    k.register(
      defineItem({
        id: ids.copy,
        type: 'button',
        labelKey: 'Copy',
        icon: '⌘',
        showsLabel: true,
        parity: 'none:demo-copy',
        action: { name: 'app.copy' },
        visibilityPriority: -500,
      }),
    );
    return k;
  }, []);

  useEffect(() => {
    return kernel.onEvent((e) => {
      if (e.type === 'aibar.action.invoked') {
        setLog((prev) => [`${e.actionName}`, ...prev].slice(0, 8));
      }
    });
  }, [kernel]);

  return (
    <div className="demo">
      <header>
        <h1>AIBar hello world</h1>
        <p>
          Third-party host — no LeAgent. Click the strip, then narrow the window to
          force overflow.
        </p>
      </header>
      <div className="stage">
        <div className="transcript">
          {messages.map((m, i) => (
            <div key={`${m.role}-${i}`} className={`msg ${m.role}`}>
              <span className="meta">{m.role}</span>
              {m.text}
            </div>
          ))}
        </div>
        <div className="composer">
          <div className="aibar-host">
            <AIBarSurface kernel={kernel} ariaLabel="Actions" density="regular" />
          </div>
          <textarea
            value={draft}
            disabled={busy}
            rows={2}
            placeholder="Type a message, then press Send on the bar"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void kernel.invoke(ids.send);
              }
            }}
          />
        </div>
      </div>
      <p className="hint">Recent actions</p>
      <ul className="log">
        {log.length === 0 ? <li>Click Send on the bar…</li> : log.map((line, i) => (
          <li key={`${line}-${i}`}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
