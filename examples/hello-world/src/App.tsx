import { useMemo, useState } from 'react';
import { AIBarSurface, createAIBarKernel } from '@aibar/react';
import {
  asItemIdentifier,
  createDefaultHostAdapter,
  defineItem,
} from '@aibar/core';
import '@aibar/renderer-dom/styles.css';

const sendId = asItemIdentifier('com.example.aibar.mainbutton.send');
const greetId = asItemIdentifier('com.example.aibar.button.greet');

export function App() {
  const [log, setLog] = useState<string[]>([]);
  const kernel = useMemo(() => {
    const adapter = createDefaultHostAdapter({
      dispatchAction: async (inv) => {
        setLog((prev) => [`${inv.name}`, ...prev].slice(0, 8));
        return { ok: true };
      },
      contextProviders: [
        {
          id: 'demo',
          collect: () => ({ route: '/', mode: 'editing' }),
        },
      ],
    });
    const k = createAIBarKernel({
      adapter,
      definition: {
        customizationIdentifier: 'com.example.aibar.main',
        defaultItemIdentifiers: [greetId, sendId],
        principalItemIdentifier: sendId,
      },
    });
    k.register(
      defineItem({
        id: greetId,
        type: 'button',
        labelKey: 'Greet',
        icon: '👋',
        showsLabel: true,
        parity: 'none:demo',
        action: { name: 'app.greet' },
      }),
    );
    k.register(
      defineItem({
        id: sendId,
        type: 'mainButton',
        labelKey: 'Send',
        icon: 'send',
        showsLabel: true,
        parity: 'shortcut:app.send',
        action: { name: 'app.send' },
      }),
    );
    return k;
  }, []);

  return (
    <div style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>AIBar hello world</h1>
      <p>Install → mount → register items → dispatch. No LeAgent imports.</p>
      <AIBarSurface kernel={kernel} ariaLabel="Actions" />
      <ul>
        {log.map((line, i) => (
          <li key={`${line}-${i}`}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
