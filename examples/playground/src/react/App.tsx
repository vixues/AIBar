import { useEffect, useMemo, useRef, useState } from 'react';
import { createDefaultHostAdapter } from '@aibar/core';
import { AIBarSurface, createAIBarKernel } from '@aibar/react';
import '@aibar/renderer-dom/styles.css';
import {
  DEMO_IDS,
  SEED_MESSAGES,
  demoDefinition,
  registerDemoCatalog,
  type DemoMessage,
  type DemoSnap,
} from '../catalog';
import { DOCS, GITHUB } from '../links';
import { createDemoHost } from '../session';
import { createThemeController } from '../theme';
import '../demo.css';

function ThemeToggle({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="theme-toggle" aria-label="Toggle color scheme" onClick={onClick}>
      <svg className="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2" />
        <path d="M12 20v2" />
        <path d="m4.93 4.93 1.41 1.41" />
        <path d="m17.66 17.66 1.41 1.41" />
        <path d="M2 12h2" />
        <path d="M20 12h2" />
        <path d="m6.34 17.66-1.41 1.41" />
        <path d="m19.07 4.93-1.41 1.41" />
      </svg>
      <svg className="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
      </svg>
    </button>
  );
}

function Turn({ message }: { message: DemoMessage }) {
  if (message.role === 'user') {
    return (
      <div className="turn user">
        <div className="bubble">{message.text}</div>
      </div>
    );
  }
  return (
    <div className="turn assistant">
      <div className="avatar" aria-hidden="true">A</div>
      <div className="prose">{message.text}</div>
    </div>
  );
}

export function App() {
  const [messages, setMessages] = useState<DemoMessage[]>(SEED_MESSAGES);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const theme = useMemo(() => createThemeController(), []);
  const [, setScheme] = useState(theme.get());

  const snap = useRef<DemoSnap>({
    thinking: 'Auto',
    emojiCategory: 'frequent',
    busy: false,
    phase: 'thinking',
    progress: 0,
    insertText: (token) => {
      const next = `${draftRef.current}${token}`;
      draftRef.current = next;
      setDraft(next);
    },
  });

  useEffect(() => theme.subscribe(() => setScheme(theme.get())), [theme]);

  const kernel = useMemo(() => {
    const host = createDemoHost({
      snap: snap.current,
      ui: {
        getDraft: () => draftRef.current,
        setDraft: (value) => {
          draftRef.current = value;
          setDraft(value);
        },
        setBusy,
        addUser: (text) => setMessages((prev) => [...prev, { role: 'user', text }]),
        addAssistant: (text) =>
          setMessages((prev) => [...prev, { role: 'assistant', text }]),
        clear: () => setMessages([]),
      },
    });

    const adapter = createDefaultHostAdapter({
      theme: theme.adapterTheme,
      dispatchAction: host.dispatchAction,
      confirmEffect: host.confirmEffect,
      contextProviders: host.contextProviders,
    });

    const k = createAIBarKernel({
      adapter,
      density: 'compact',
      definition: demoDefinition('com.example.aibar.main'),
    });
    registerDemoCatalog(k, snap.current);
    return k;
  }, [theme]);

  return (
    <div className="app">
      <header className="nav">
        <div className="nav-inner">
          <a className="brand" href="/">AIBar</a>
          <span className="nav-pill">Playground</span>
          <div className="nav-spacer" />
          <nav className="nav-hosts" aria-label="Example host">
            <a className="nav-link is-active" href="/" aria-current="page">React</a>
            <a className="nav-link" href="/vanilla.html">Vanilla</a>
          </nav>
          <a className="nav-link" href={DOCS}>Docs</a>
          <a className="nav-link" href={GITHUB}>GitHub</a>
          <ThemeToggle onClick={() => theme.toggle()} />
        </div>
      </header>
      <main className="stage">
        <h1 className="lede">Context-aware action surface</h1>
        <p className="sub">
          Hosts mount a strip of declarative items. Membership and geometry
          resolve from live context. Agents publish data, never code.
        </p>
        <section className="preview" aria-label="AIBar playground">
          <div className="preview-thread">
            {messages.length === 0 ? (
              <div className="preview-empty">
                <h2>Try the strip</h2>
                <p>Send a message, expand Thinking, open Emoji, or narrow the window until items overflow.</p>
              </div>
            ) : (
              messages.map((m, i) => <Turn key={`${m.role}-${i}`} message={m} />)
            )}
          </div>
          <div className="preview-dock">
            <div className="aibar-host">
              <AIBarSurface kernel={kernel} ariaLabel="Actions" density="compact" />
            </div>
            <div className="composer">
              <textarea
                value={draft}
                disabled={busy}
                rows={1}
                placeholder="Message"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void kernel.invoke(DEMO_IDS.send);
                  }
                }}
              />
            </div>
          </div>
        </section>
        <p className="caption">React · @aibar/react · compact density · light / dark tokens</p>
      </main>
    </div>
  );
}
