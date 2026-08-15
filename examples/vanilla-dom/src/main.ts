import {
  AIBarKernel,
  asItemIdentifier,
  createDefaultHostAdapter,
  defineItem,
} from '@aibar/core';
import { DOMRendererBackend } from '@aibar/renderer-dom';
import '@aibar/renderer-dom/styles.css';

const sendId = asItemIdentifier('com.example.aibar.mainbutton.send');

const adapter = createDefaultHostAdapter({
  dispatchAction: async (inv) => {
    console.log('action', inv.name);
    return { ok: true };
  },
  contextProviders: [
    {
      id: 'demo',
      collect: () => ({ route: '/', mode: 'editing' }),
    },
  ],
});

const kernel = new AIBarKernel({
  adapter,
  definition: {
    customizationIdentifier: 'com.example.aibar.vanilla',
    defaultItemIdentifiers: [sendId],
    principalItemIdentifier: sendId,
  },
});

kernel.register(
  defineItem({
    id: sendId,
    type: 'mainButton',
    labelKey: 'Send',
    icon: 'send',
    showsLabel: true,
    parity: 'none:demo',
    action: { name: 'app.send' },
  }),
);

const host = document.getElementById('bar')!;
const backend = new DOMRendererBackend({ ariaLabel: 'Actions' });
kernel.attach(backend, host);
