import {
  AIBarKernel,
  asItemIdentifier,
  createDefaultHostAdapter,
  defineItem,
  type AIBarItem,
} from '@aibar/core';
import { DOMRendererBackend } from '@aibar/renderer-dom';
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

const snap = {
  model: 'flash' as 'flash' | 'pro',
  temperature: 0.7,
  busy: false,
  phase: 'thinking' as 'thinking' | 'answering',
  progress: 0,
};

const invalidators = new Set<() => void>();
const bump = () => {
  for (const fn of invalidators) fn();
};

const transcript = document.getElementById('transcript')!;
const draft = document.getElementById('draft') as HTMLTextAreaElement;
const logEl = document.getElementById('log')!;

function addMsg(role: 'user' | 'assistant', text: string) {
  const row = document.createElement('div');
  row.className = `msg ${role}`;
  row.innerHTML = `<span class="meta">${role}</span>`;
  row.append(document.createTextNode(text));
  transcript.append(row);
  transcript.scrollTop = transcript.scrollHeight;
}

function logAction(name: string) {
  const li = document.createElement('li');
  li.textContent = name;
  logEl.prepend(li);
  while (logEl.children.length > 8) logEl.lastElementChild?.remove();
}

let tempItem: AIBarItem;

const adapter = createDefaultHostAdapter({
  dispatchAction: async (inv) => {
    if (inv.name === 'app.send') {
      const text = draft.value.trim() || '…';
      draft.value = '';
      addMsg('user', text);
      snap.busy = true;
      snap.phase = 'thinking';
      snap.progress = 0.2;
      draft.disabled = true;
      bump();
      window.setTimeout(() => {
        snap.phase = 'answering';
        snap.progress = 0.75;
        bump();
      }, 500);
      window.setTimeout(() => {
        snap.busy = false;
        snap.progress = 0;
        draft.disabled = false;
        bump();
        addMsg('assistant', `Reply (${snap.model}, t=${snap.temperature.toFixed(1)}): ${text}`);
      }, 1100);
      return { ok: true };
    }
    if (inv.name === 'app.clear') {
      transcript.replaceChildren();
      return { ok: true };
    }
    return { ok: true };
  },
  confirmEffect: async (req) =>
    window.confirm(`${req.summary}\n\nAllow this destructive action?`) ? 'allow' : 'deny',
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
    snap.temperature = value;
    tempItem.slider = { min: 0, max: 1, value, step: 0.1 };
    bump();
  },
});

const kernel = new AIBarKernel({
  adapter,
  density: 'regular',
  definition: {
    customizationIdentifier: 'com.example.aibar.vanilla',
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

kernel.register(
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
kernel.register(
  defineItem({
    id: ids.model,
    type: 'segmented',
    labelKey: 'Model',
    parity: 'none:demo-model',
    segments: [
      { key: 'flash', labelKey: 'Flash' },
      { key: 'pro', labelKey: 'Pro' },
    ],
    selectedSegment: () => snap.model,
    onSelectSegment: (_ctx, key) => {
      snap.model = key === 'pro' ? 'pro' : 'flash';
      bump();
    },
  }),
);
kernel.register(tempItem);
kernel.register(
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
kernel.register(
  defineItem({
    id: ids.send,
    type: 'mainButton',
    labelKey: 'Send',
    icon: 'send',
    showsLabel: true,
    parity: 'shortcut:app.send',
    enabled: () => !snap.busy,
    action: { name: 'app.send' },
  }),
);
kernel.register(
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
kernel.register(
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
kernel.register(
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

kernel.onEvent((e) => {
  if (e.type === 'aibar.action.invoked') logAction(e.actionName);
});

const host = document.getElementById('bar')!;
const backend = new DOMRendererBackend({ ariaLabel: 'Actions', density: 'regular' });
kernel.attach(backend, host);

draft.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void kernel.invoke(ids.send);
  }
});
