import { AIBarKernel, createDefaultHostAdapter } from '@aibar/core';
import { DOMRendererBackend } from '@aibar/renderer-dom';
import '@aibar/renderer-dom/styles.css';
import {
  DEMO_IDS,
  SEED_MESSAGES,
  demoDefinition,
  registerDemoCatalog,
  type DemoSnap,
} from '../catalog';
import { createDemoHost } from '../session';
import { createThemeController } from '../theme';
import '../demo.css';

const theme = createThemeController();
document.getElementById('theme-toggle')!.addEventListener('click', () => theme.toggle());

const transcript = document.getElementById('transcript')!;
const empty = document.getElementById('empty')!;
const draft = document.getElementById('draft') as HTMLTextAreaElement;

const snap: DemoSnap = {
  thinking: 'Auto',
  emojiCategory: 'frequent',
  busy: false,
  phase: 'thinking',
  progress: 0,
  insertText: (token) => {
    draft.value += token;
  },
};

function renderEmpty() {
  empty.hidden = transcript.childElementCount > 0;
}

function addMsg(role: 'user' | 'assistant', text: string) {
  const row = document.createElement('div');
  row.className = `turn ${role}`;
  if (role === 'user') {
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.textContent = text;
    row.append(bubble);
  } else {
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.setAttribute('aria-hidden', 'true');
    avatar.textContent = 'A';
    const prose = document.createElement('div');
    prose.className = 'prose';
    prose.textContent = text;
    row.append(avatar, prose);
  }
  transcript.append(row);
  renderEmpty();
  row.scrollIntoView({ block: 'end' });
}

for (const msg of SEED_MESSAGES) addMsg(msg.role, msg.text);

const host = createDemoHost({
  snap,
  ui: {
    getDraft: () => draft.value,
    setDraft: (value) => {
      draft.value = value;
    },
    setBusy: (busy) => {
      draft.disabled = busy;
    },
    addUser: (text) => addMsg('user', text),
    addAssistant: (text) => addMsg('assistant', text),
    clear: () => {
      transcript.replaceChildren();
      renderEmpty();
    },
  },
});

const adapter = createDefaultHostAdapter({
  theme: theme.adapterTheme,
  dispatchAction: host.dispatchAction,
  confirmEffect: host.confirmEffect,
  contextProviders: host.contextProviders,
});

const kernel = new AIBarKernel({
  adapter,
  density: 'compact',
  definition: demoDefinition('com.example.aibar.vanilla'),
});

registerDemoCatalog(kernel, snap);

const bar = document.getElementById('bar')!;
const backend = new DOMRendererBackend({ ariaLabel: 'Actions', density: 'compact' });
kernel.attach(backend, bar);

draft.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    void kernel.invoke(DEMO_IDS.send);
  }
});
