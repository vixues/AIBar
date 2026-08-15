# AIBar host guide

Five steps to embed AIBar in a third-party application. The library is
host-agnostic: you implement `AIBarHostAdapter`, publish items, and feed
context. You do **not** fork the kernel or import LeAgent internals.

Full contract: [aibar-architecture.md](./aibar-architecture.md).
Runnable samples: `examples/hello-world` and `examples/vanilla-dom`.

---

## Peer / runtime requirements

| Package | Peers | Notes |
|---------|-------|--------|
| `@aibar/protocol` | none | Types + validators; usable from Node |
| `@aibar/core` | `@aibar/protocol` | No DOM, no React |
| `@aibar/renderer-dom` | `@aibar/core` | Browser DOM; import `./styles.css` |
| `@aibar/react` | `react` `^18 \|\| ^19`, `@aibar/core`, `@aibar/renderer-dom` | Mount only |
| `@aibar/intent` | `@aibar/core` | Optional suggestions |
| `@aibar/devtools` | `react` `^18 \|\| ^19`, `@aibar/core` | Optional overlay |

ESM only. Semantic versioning is independent of any host app. A protocol bump
(`aibar/2` → `aibar/3`) is a **major** of `@aibar/protocol` and every consumer.

---

## 1. Install

```bash
npm install @aibar/react
```

`@aibar/react` pulls in `@aibar/core` and `@aibar/renderer-dom`. Import the
functional CSS once (layout, tokens, a11y — not a visual theme):

```ts
import '@aibar/renderer-dom/styles.css';
```

Vanilla (no React): `npm install @aibar/core @aibar/renderer-dom`.

---

## 2. Mount

```tsx
import { useMemo } from 'react';
import {
  AIBarSurface,
  createAIBarKernel,
} from '@aibar/react';
import {
  createDefaultHostAdapter,
  defineItem,
} from '@aibar/core';
import { asItemIdentifier } from '@aibar/protocol';
import '@aibar/renderer-dom/styles.css';

const sendId = asItemIdentifier('com.example.aibar.mainbutton.send');

export function AppBar() {
  const kernel = useMemo(() => {
    const adapter = createDefaultHostAdapter({
      dispatchAction: async (inv) => {
        if (inv.name === 'app.send') {
          /* host work */
          return { ok: true };
        }
        return { ok: false, error: `unknown action ${inv.name}` };
      },
    });
    const k = createAIBarKernel({
      adapter,
      definition: {
        customizationIdentifier: 'com.example.aibar.main',
        defaultItemIdentifiers: [sendId],
        principalItemIdentifier: sendId,
      },
    });
    k.register(
      defineItem({
        id: sendId,
        type: 'mainButton',
        labelKey: 'Send',
        icon: 'send',
        parity: 'shortcut:app.send',
        action: { name: 'app.send' },
      }),
    );
    return k;
  }, []);

  return <AIBarSurface kernel={kernel} ariaLabel="Actions" />;
}
```

`createDefaultHostAdapter` fills in English chrome labels, text-glyph icons,
and in-memory persistence. Replace any field to integrate your i18n, icon set,
or storage.

`AIBarSurface` does **not** write `--aibar-height` unless you pass
`heightVariable="--aibar-height"` (or any name you pad against).

Kernel state survives `detach` (React unmount). Call `kernel.destroy()` when
the host tears the session down for good.

---

## 3. Register items

Three channels:

| Channel | API | Provenance |
|---------|-----|------------|
| Host catalog | `kernel.register(defineItem(…))` or `registerProvider` | `host` |
| Dynamic host projection | `upsertWireItem` / `removeItem` | typically `host` |
| Agent / remote | `WireIngress.handle({ kind: 'publish', … })` | `agent` / `remote` |

Identifiers: `makeItemIdentifier('com.example', 'button', 'new-file')` →
`com.example.aibar.button.new-file`.

Every item needs **parity** (INV-A1): a hotkey id, a menu path, or
`none:<reason>`. Wire items need a closed **predicate** for `visible` /
`enabled` — no functions (INV-A3).

`custom`, `scrubber`, and `hostItemsProxy` are in-process only. Listen for
`aibar.custom-slot.mount` and portal host UI into `[data-custom-kind]`.

Overflow: set `definition.overflowAction` (e.g.
`{ name: 'host.openCommandPalette' }`) if the overflow floor should offer a
palette drain. Omit it to show overflowed items only.

---

## 4. Feed context

Add `ContextProvider`s to the adapter (or `kernel.contextHub.register` later).
Slices must be **metadata** — kinds, counts, ids — not user content.

```ts
const routeProvider = {
  id: 'route',
  collect: () => ({ route: location.pathname, mode: 'editing' }),
  subscribe: (onInvalidate) => {
    const h = () => onInvalidate();
    window.addEventListener('popstate', h);
    return () => window.removeEventListener('popstate', h);
  },
};
```

Predicates on the wire reference `ctx.*` paths against the lifted snapshot
(`route`, `mode`, `focus`, `runs`, `agent`, plus `state.<ns>…`).

Optional: `adapter.intent.predict` for the suggestion lane. Suggestions never
displace deterministic items (INV-A7). Destructive work must be `approval`
items plus `confirmEffect` (INV-A8).

---

## 5. Persist customization

The kernel already writes:

```text
aibar.{customizationIdentifier}.stats     // frecency + pins
aibar.{customizationIdentifier}.custom    // order + hidden ids
```

Swap the default memory store:

```ts
createDefaultHostAdapter({
  dispatchAction,
  persistence: {
    async load(key) {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    },
    async save(key, value) {
      localStorage.setItem(key, JSON.stringify(value));
    },
  },
});
```

Host chrome for pin / hide / reorder: listen to `aibar.item.contextmenu` and
call `kernel.pin`, `setItemHidden`, `setCustomOrder`, `enterCustomizing` /
`exitCustomizing`. The library does not ship a customize sheet in 0.1.

Theme: implement `adapter.theme.tokens()` returning `--aibar-*` CSS variables,
or rely on the renderer’s reference dark/light fallbacks.

---

## Agent publish (optional)

The library does **not** include a session server. To let an agent publish:

1. Validate Item Spec v2 (`validatePublishBatch` or the JSON Schema).
2. Deliver `WireMessage`s over your transport (SSE, WS, `postMessage`).
3. Call `kernel.ingress.handle(message)` (or construct `WireIngress` and
   forward).
4. Advertise **your** action allowlist on `welcome`.

Do not take LeAgent’s `AIBarService`, chat SSE, or prompt digest — those are
host infrastructure.

---

## What stays in the host

- Item catalog and `customizationIdentifier`
- Action names and `dispatchAction`
- i18n catalogs beyond chrome fallbacks
- Icon set (`resolveIcon`)
- Confirm UI for `destructive`
- Customize sheet / context menu
- Dock placement relative to the rest of the app
- Agent transport, quotas policy, session ACL
